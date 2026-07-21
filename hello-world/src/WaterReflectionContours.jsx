import React, { useState, useMemo, useRef, useEffect } from "react";
import * as d3 from "d3";
import { labelRegions, buildAdjacency, denoiseGrid, planCollapse } from "./paperStack";
import { useUrlSync } from "./urlSettings";
import { extractPhotoStrip } from "./photoPalette";

/* ------------------------------------------------------------------ *
 *  Water-reflection contour studio
 *  φ(x,y) = elevation angle of the reflected view ray.
 *  Color blobs = isobands of φ. Contour the scalar field, fill between
 *  thresholds, project to a grazing camera. No raster, no ray tracer.
 * ------------------------------------------------------------------ */

const PALETTES = {
  "Sunset Lake": ["#1b1640", "#4a2273", "#8e2f72", "#d04e5d", "#f0913f", "#f7d774", "#fbf0cf"],
  "Tunic Glass": ["#0a2b30", "#0f5454", "#1c8a80", "#56bda3", "#bfe2bd", "#eccd83", "#f6ead0"],
  "Treeline":    ["#0a130d", "#10301d", "#2c5736", "#6a8a64", "#b6b08e", "#e3a974", "#b9d6ed"],
  "Obra Dinn":   ["#0b0b0b", "#262626", "#565656", "#8f8f8f", "#c7c7c7", "#f2f2f2"],
};

// Banded palettes: piecewise-constant elevation strips [color, weight] from
// horizon (first) to zenith (last), instead of a smooth ramp. The thin dark
// strips are the key: the reflected-elevation field is continuous, so every
// boundary between the bands on either side must pass THROUGH the strip —
// it draws itself as a closed hairline outline around each color region,
// the "ink line" look of real harbor-water reflections.
const BANDED_PALETTES = {
  // each ink strip gets a visually identical but UNIQUE hex: a repeated color
  // fuses into one multi-strip region in the 2D segmentation, whose union
  // layer grows hairline protrusions that the sliver blur then eats. Unique
  // strips keep every union a clean upper set of elevation.
  "Harbor Ink": [
    ["#eef7fb", 0.15], ["#06090d", 0.022], ["#9fd2e2", 0.15], ["#070a0e", 0.022],
    ["#4b93bd", 0.16], ["#05080c", 0.022], ["#20608a", 0.15], ["#060a0e", 0.022],
    ["#143b58", 0.14], ["#07090d", 0.026], ["#0d2334", 0.126],
  ],
  "Sunset Buoy": [
    ["#f6edc9", 0.13], ["#e5a94b", 0.05], ["#cd5a28", 0.028], ["#f2d98a", 0.07],
    ["#8c9cc8", 0.12], ["#c8551f", 0.024], ["#46689e", 0.14], ["#2b1710", 0.024],
    ["#31518a", 0.13], ["#15101e", 0.05], ["#101c38", 0.12], ["#7e2d12", 0.022],
    ["#060a14", 0.09],
  ],
  "Black Water": [
    ["#d9f0f4", 0.12], ["#f6fbfb", 0.02], ["#a7c4ef", 0.13], ["#8e959d", 0.024],
    ["#7e97dd", 0.14], ["#494f58", 0.024], ["#0b0e13", 0.22], ["#b9c8ee", 0.028],
    ["#05070b", 0.294],
  ],
};

// cumulative stops of a banded palette: [{c, f0, f1}] with f = fraction of the
// elevation range, horizon (0) -> zenith (1). null for smooth palettes.
function paletteStops(name) {
  const b = BANDED_PALETTES[name];
  if (!b) return null;
  const total = b.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  return b.map(([c, w]) => { const f0 = acc / total; acc += w; return { c, f0, f1: acc / total }; });
}

function paletteColorAt(name, f) {
  const stops = paletteStops(name);
  if (!stops) return d3.interpolateRgbBasis(PALETTES[name])(f);
  for (const s of stops) if (f < s.f1) return s.c;
  return stops[stops.length - 1].c;
}

const VB_W = 760;
const VB_H = 500;

const DEFAULT_EMITTERS = [
  { id: 1, on: true, type: "swell",    x: 0, y: 20, dir: 65,  size: 3.2, amp: 1.85, spread: 25, roughness: 0.4,  detail: 14 },
  { id: 2, on: true, type: "spectrum", x: 0, y: 20, dir: 125, size: 1.5, amp: 1.1,  spread: 59, roughness: 0.1,  detail: 15 },
  { id: 3, on: true, type: "spectrum", x: 0, y: 20, dir: 90,  size: 1.7, amp: 1.9,  spread: 17, roughness: 0.15, detail: 19 },
];

// quick-pick colors for the environment painter: treeline/earth → sunset → sky
const SWATCHES = [
  "#080d09", "#0f1f13", "#1d3b22", "#2f5734", "#4a4030", "#6b4a2e",
  "#9a4a26", "#c8632f", "#e98b3a", "#f3c14e", "#fbe6a0", "#fdf4d6",
  "#cfe1ef", "#9cc3e8", "#6a96c8", "#3f5f93", "#27406b", "#141d33",
];

// ---- surface slope & elevation field -------------------------------
// Real water is a superposition of straight-crested waves over many
// wavelengths. We work with the surface *slope* (which sets the normal,
// which sets the reflected angle), computed analytically per emitter.
//   point    = concentric ripple from a spot (a raindrop / a fish)
//   swell    = one long straight-crested wave train
//   spectrum = a wind field: many straight waves around a heading,
//              weighted toward long wavelengths, + a roughness control
function rand1(i) {
  const x = Math.sin(i * 12.9898 + 7.13) * 43758.5453;
  return x - Math.floor(x);
}

// Distance filter: short waves narrower than what the sample grid (and the
// eye) can resolve at range gy fade out smoothly instead of aliasing into
// far-field speckle. Returns the coefficient a such that the attenuation at
// range gy is 1 / (1 + (a·gy)²). Perspective only — in plan view every part
// of the plane is equally close.
function aaCoef(k, S) {
  return S.perspective ? (0.22 * k) / S.ny : 0;
}

// Pre-bake an emitter into per-frame constants so the per-sample loop is cheap.
function prepEmitter(em, S) {
  const baseLambda = (2 * Math.PI / S.k) * em.size; // global λ × size
  const A = S.amp * em.amp;
  const wt = S.omega * S.t;
  const q = S.sharp || 0;   // Stokes-style crest sharpening, 2nd harmonic weight

  if (em.type === "point") {
    // em.decay overrides the global reach for sources whose disturbance
    // should stay local
    const decay = (em.decay ?? S.decay) / Math.max(0.6, em.size);
    return { type: "point", x: em.x, y: em.y, k0: 2 * Math.PI / baseLambda, A, decay, wt };
  }
  if (em.type === "swell") {
    const a = (em.dir * Math.PI) / 180;
    const k0 = 2 * Math.PI / baseLambda;
    return { type: "swell", k0, Dx: Math.cos(a), Dy: Math.sin(a), A, ph0: -wt,
      q, aa: aaCoef(k0, S) };
  }
  if (em.type === "rings") {
    // a scattered field of radial ripple sources -> concentric color rings
    const M = Math.max(1, Math.min(20, em.detail | 0));
    const rough = em.roughness;
    const dec = S.decay * 0.7;
    const CX = [], CY = [], K = [], AMP = [], PH = [];
    for (let i = 0; i < M; i++) {
      CX.push(S.xMin + (S.xMax - S.xMin) * rand1(i * 3 + 1));
      CY.push(S.yMin + (S.yMax - S.yMin) * rand1(i * 3 + 2));
      const lam = baseLambda * (1 + (rand1(i * 3 + 5) - 0.5) * 1.2 * rough);
      K.push(2 * Math.PI / Math.max(0.2, lam));
      AMP.push(A * (0.6 + 0.7 * rand1(i * 7 + 3)));
      PH.push(rand1(i * 11 + 4) * Math.PI * 2 - wt);
    }
    return { type: "rings", M, CX, CY, K, AMP, PH, dec };
  }
  // spectrum: a ladder of components from baseLambda down through several
  // octaves — 1.5 octaves when glassy up to ~6 when rough — with jittered
  // wavelengths so the ladder rungs don't beat against each other, and a
  // directional spread that widens for the short waves (as in real seas)
  const N = Math.max(2, em.detail | 0);
  const wind = (em.dir * Math.PI) / 180;
  const spread = (em.spread * Math.PI) / 180;
  const rough = em.roughness;
  const K = [], DX = [], DY = [], AMP = [], PH = [], AA = [];
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const lam = baseLambda * Math.pow(0.5, f * (1.5 + 4.5 * rough))
      * (1 + (rand1(i * 5 + 9) - 0.5) * 0.35);
    const ki = 2 * Math.PI / lam;
    const th = wind + (rand1(i * 2 + 1) - 0.5) * 2 * spread * (0.7 + 0.6 * f);
    const om = Math.sqrt(ki) * S.omega;
    K.push(ki);
    DX.push(Math.cos(th));
    DY.push(Math.sin(th));
    AMP.push(A * (lam / baseLambda) / N * 1.5);       // longer waves carry more energy
    PH.push(rand1(i * 2 + 2) * Math.PI * 2 - om * S.t);
    AA.push(aaCoef(ki, S));
  }
  return { type: "spectrum", K, DX, DY, AMP, PH, AA, N, q };
}

// actual surface height (the wave displacement) — mirrors slopeAt but returns
// the height itself, used to lift pen-plot lines into 3D
function heightAt(gx, gy, S) {
  let z = 0;
  for (const e of S._ems) {
    if (e.type === "point") {
      const dx = gx - e.x, dy = gy - e.y;
      const r = Math.hypot(dx, dy) + 1e-6;
      z += e.A * Math.exp(-e.decay * r) * Math.sin(e.k0 * r - e.wt);
    } else if (e.type === "swell") {
      const s1 = Math.sin(e.k0 * (e.Dx * gx + e.Dy * gy) + e.ph0);
      // Stokes-ish profile: 2nd harmonic peaks the crests, flattens troughs
      const prof = e.q ? s1 - e.q * 0.5 + e.q * s1 * s1 : s1;
      const x = e.aa * gy;
      z += e.A * prof / (1 + x * x);
    } else if (e.type === "rings") {
      for (let i = 0; i < e.M; i++) {
        const dx = gx - e.CX[i], dy = gy - e.CY[i];
        const r = Math.hypot(dx, dy) + 1e-6;
        z += e.AMP[i] * Math.exp(-e.dec * r) * Math.sin(e.K[i] * r + e.PH[i]);
      }
    } else {
      for (let i = 0; i < e.N; i++) {
        const s1 = Math.sin(e.K[i] * (e.DX[i] * gx + e.DY[i] * gy) + e.PH[i]);
        const prof = e.q ? s1 - e.q * 0.5 + e.q * s1 * s1 : s1;
        const x = e.AA[i] * gy;
        z += e.AMP[i] * prof / (1 + x * x);
      }
    }
  }
  return z;
}

// keep the 3D lift well below the camera: an exaggerated crest that rose to
// (or past) the camera height would cross the projection plane and explode
// into spikes at the frame edges. Soft clamp — gentle settings pass through
// almost linearly, extreme ones saturate at 3/4 of the camera height. In
// rectangular output the frame-fill stretches vertical screen distances by
// scaleY/scale, so the lift is pre-shrunk by that ratio to subtend the same
// apparent relief instead of smearing into streaks.
function clampLift(z, S, fit) {
  const aniso = fit && fit.scaleY ? Math.min(1, fit.scale / fit.scaleY) : 1;
  const m = 0.75 * S.H;
  return m * Math.tanh((z * aniso) / m);
}

function slopeAt(gx, gy, S) {
  let hx = 0, hy = 0;
  for (const e of S._ems) {
    if (e.type === "point") {
      const dx = gx - e.x, dy = gy - e.y;
      const r = Math.hypot(dx, dy) + 1e-6;
      const env = Math.exp(-e.decay * r);
      const f = e.A * env * (e.k0 * Math.cos(e.k0 * r - e.wt) - e.decay * Math.sin(e.k0 * r - e.wt));
      hx += f * dx / r; hy += f * dy / r;
    } else if (e.type === "swell") {
      const th = e.k0 * (e.Dx * gx + e.Dy * gy) + e.ph0;
      // d/dθ of the sharpened profile: cosθ·(1 + 2q·sinθ)
      let c = e.A * e.k0 * Math.cos(th);
      if (e.q) c *= 1 + 2 * e.q * Math.sin(th);
      const x = e.aa * gy;
      c /= 1 + x * x;
      hx += c * e.Dx; hy += c * e.Dy;
    } else if (e.type === "rings") {
      for (let i = 0; i < e.M; i++) {
        const dx = gx - e.CX[i], dy = gy - e.CY[i];
        const r = Math.hypot(dx, dy) + 1e-6;
        const env = Math.exp(-e.dec * r);
        const arg = e.K[i] * r + e.PH[i];
        const f = e.AMP[i] * env * (e.K[i] * Math.cos(arg) - e.dec * Math.sin(arg));
        hx += f * dx / r; hy += f * dy / r;
      }
    } else {
      for (let i = 0; i < e.N; i++) {
        const th = e.K[i] * (e.DX[i] * gx + e.DY[i] * gy) + e.PH[i];
        let c = e.AMP[i] * e.K[i] * Math.cos(th);
        if (e.q) c *= 1 + 2 * e.q * Math.sin(th);
        const x = e.AA[i] * gy;
        c /= 1 + x * x;
        hx += c * e.DX[i]; hy += c * e.DY[i];
      }
    }
  }
  return [hx, hy];
}

// full reflected direction (unit) — gives both elevation and azimuth.
// 4th component = cos of the incidence angle (view ray vs surface normal),
// which sets the Fresnel reflectance at this point.
function reflectAt(gx, gy, S) {
  const [hx, hy] = slopeAt(gx, gy, S);
  let nx = -hx, ny = -hy, nz = 1;
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
  let vx = gx, vy = gy, vz = -S.H;
  const vl = Math.hypot(vx, vy, vz); vx /= vl; vy /= vl; vz /= vl;
  const d = vx * nx + vy * ny + vz * nz;
  return [vx - 2 * d * nx, vy - 2 * d * ny, vz - 2 * d * nz, -d];
}

// Schlick Fresnel for water (R0 ≈ 0.02): the fraction of light NOT reflected
// at this incidence — i.e. the weight of the transmitted deep-water color.
// Grazing view -> ~0 (perfect mirror); looking straight down -> ~0.98.
function fresnelDeepW(cosI) {
  const c = cosI < 0 ? 0 : cosI > 1 ? 1 : cosI;
  const m = 1 - c;
  return 1 - (0.02 + 0.98 * m * m * m * m * m);
}

// Reflection detail ("angular zoom"): stretch the reflected-direction
// mapping about the middle of the environment window. At mag = 1 the window
// [eLo, eHi] spans the environment exactly as painted; at mag > 1 the same
// environment is compressed into a 1/mag-narrower cone about the window
// center, so a small ripple tilt sweeps a larger fraction of the colors —
// the telephoto close-up look where every wavelet carries the whole gradient.
function magFrac(f, mag) {
  return mag === 1 ? f : 0.5 + (f - 0.5) * mag;
}

// quantized Lab mix toward the deep-water color: band b of K, b = 0 pure
// reflection, b = K-1 fully "deep". Cached — called per region per band.
function makeDeepMixer(deep, strength, K) {
  const cache = new Map();
  return (color, b) => {
    if (!b) return color;
    const key = color + "|" + b;
    let v = cache.get(key);
    if (v === undefined) {
      v = d3.color(d3.interpolateLab(color, deep)(strength * b / (K - 1))).formatHex();
      cache.set(key, v);
    }
    return v;
  };
}

// ---- geometry helpers ---------------------------------------------
function cell2ground(ix, iy, S) {
  if (S.rectOutput && S.perspective) {
    // map the grid to the trapezoid that projects to a full screen rectangle:
    // rows evenly spaced in projected-y, each row spanning the near edge's width
    const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const ryOf = (g) => -(g * sp - S.H * cp) / (g * cp + S.H * sp);
    const rNear = ryOf(S.yMin), rFar = ryOf(S.yMax);
    const r = rNear + (iy / S.ny) * (rFar - rNear);
    const gy = S.H * (cp - r * sp) / (r * cp + sp);          // invert ry(gy)
    const Zc = gy * cp + S.H * sp;
    const Znear = S.yMin * cp + S.H * sp;
    const A = ((S.xMax - S.xMin) / 2) / Znear;               // near-edge half width in rx
    const rx = -A + (ix / S.nx) * (2 * A);
    return [rx * Zc, gy];                                    // gx = rx * Zc
  }
  const gx = S.xMin + (ix / S.nx) * (S.xMax - S.xMin);
  const gy = S.yMin + (iy / S.ny) * (S.yMax - S.yMin);
  return [gx, gy];
}

function rawProject(gx, gy, S) {
  if (!S.perspective) {
    const u = (gx - S.xMin) / (S.xMax - S.xMin);
    const v = (gy - S.yMin) / (S.yMax - S.yMin);
    return [u, 1 - v]; // far edge at top
  }
  const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  const Xc = gx;
  const Yc = gy * sp - S.H * cp;
  const Zc = gy * cp + S.H * sp;
  return [Xc / Zc, -Yc / Zc];
}

function computeFit(S) {
  const corners = [
    [S.xMin, S.yMin], [S.xMax, S.yMin],
    [S.xMin, S.yMax], [S.xMax, S.yMax],
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [gx, gy] of corners) {
    const [rx, ry] = rawProject(gx, gy, S);
    minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
  }
  const m = 14;
  const baseScale = Math.min((VB_W - 2 * m) / (maxX - minX), (VB_H - 2 * m) / (maxY - minY));
  let scale = baseScale * (S.zoom || 1), scaleY = scale;
  if (S.rectOutput && S.perspective) {   // fill the frame as a rectangle
    scale = ((VB_W - 2 * m) / (maxX - minX)) * (S.zoom || 1);
    scaleY = ((VB_H - 2 * m) / (maxY - minY)) * (S.zoom || 1);
  }
  const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
  const ox = VB_W / 2 - scale * bcx + (S.panX || 0) * (VB_W / 2);
  const oy = VB_H / 2 - scaleY * bcy + (S.panY || 0) * (VB_H / 2);
  return { scale, scaleY, ox, oy };
}

// camera roll: rotate the finished picture about the viewport center, scaled
// up just enough that the rotated frame still covers the viewport (cover-fit,
// like rotating a photo). Applied as one SVG group transform so every mode —
// regions, pen lines, clips — rolls consistently.
function rollTransform(rollDeg) {
  if (!rollDeg) return null;
  const r = (rollDeg * Math.PI) / 180;
  const ca = Math.abs(Math.cos(r)), sa = Math.abs(Math.sin(r));
  const s = Math.max((VB_W * ca + VB_H * sa) / VB_W, (VB_W * sa + VB_H * ca) / VB_H);
  const cx = VB_W / 2, cy = VB_H / 2;
  return `rotate(${rollDeg} ${cx} ${cy}) translate(${(cx * (1 - s)).toFixed(2)} ${(cy * (1 - s)).toFixed(2)}) scale(${s.toFixed(4)})`;
}

// Chaikin corner-cutting on a closed ring — rounds the marching-squares
// staircase. Done in grid space, before projection.
function chaikin(ring, iters) {
  let p = ring;
  if (p.length > 1) {
    const a = p[0], b = p[p.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) p = p.slice(0, -1);
  }
  for (let it = 0; it < iters; it++) {
    if (p.length < 3) break;
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      q.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = q;
  }
  return p;
}

// drop near-duplicate screen points (keeps the bezier fit stable and the
// files small); also un-closes the ring if last == first
function simplifyRing(pts, eps) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= eps) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < eps) out.pop();
  }
  return out;
}

// closed Catmull-Rom spline through the points, emitted as cubic beziers —
// the exported edge is a genuinely smooth curve (an elliptical region becomes
// an actual smooth closed curve, not a polygonal approximation)
function ringToBezier(p) {
  const n = p.length;
  let d = "M" + p[0][0].toFixed(1) + " " + p[0][1].toFixed(1) + " ";
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += "C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + " "
       + c2x.toFixed(1) + " " + c2y.toFixed(1) + " "
       + p2[0].toFixed(1) + " " + p2[1].toFixed(1) + " ";
  }
  return d + "Z ";
}

// `off` shifts contour coordinates from a padded grid back to grid space;
// `ex` (screen-space expansion about the water's centroid) pushes pad-zone
// points clear of the clip outline even where perspective squashes a grid
// cell to a fraction of a pixel (the far edge), so clipped layers always
// overshoot the frame instead of tracing it.
function multiToPath(multi, S, fit, off = 0, ex = null) {
  const iters = S.smooth || 0;
  const syScale = fit.scaleY || fit.scale;
  // 3D surface: lift every contour vertex to the wave height and re-project
  // through the same camera the pen-plot relief uses, so the flat color blobs
  // ride the real crests and troughs instead of sitting on a flat plane.
  const lift = S.surface3d && S.perspective;
  let d = "";
  for (const poly of multi.coordinates) {
    for (const ring0 of poly) {
      const ring = iters ? chaikin(ring0, iters) : ring0;
      const pts = [];
      for (let idx = 0; idx < ring.length; idx++) {
        let gi = ring[idx][0] + off, gj = ring[idx][1] + off;
        // Pad-zone vertices exist to overshoot the flat watertrap clip — but
        // 3D mode skips that clip so crests can rise above the trapezoid,
        // which would leave the overshoot visible: every layer's rim would
        // drape one cell (plus the `ex` expansion) outside the plane, stacked
        // colored walls that read as the sides of a container. Pin them onto
        // the water boundary instead, so each layer's rim lands exactly on
        // the lifted edge silhouette. (The `ex` branch below then never fires
        // in 3D: clamped points are no longer in the pad zone.)
        if (lift) {
          gi = gi < 0 ? 0 : gi > S.nx ? S.nx : gi;
          gj = gj < 0 ? 0 : gj > S.ny ? S.ny : gj;
        }
        const [gx, gy] = cell2ground(gi, gj, S);
        let X, Y;
        if (lift) {
          const gz = clampLift(heightAt(gx, gy, S) * S.waveScale, S, fit);
          const p = penProject(gx, gy, gz, S, fit);
          X = p[0]; Y = p[1];
        } else {
          const [rx, ry] = rawProject(gx, gy, S);
          X = fit.ox + fit.scale * rx; Y = fit.oy + syScale * ry;
        }
        if (ex && (gi < -0.02 || gi > S.nx + 0.02 || gj < -0.02 || gj > S.ny + 0.02)) {
          X = ex.cx + (X - ex.cx) * ex.s;
          Y = ex.cy + (Y - ex.cy) * ex.s;
        }
        pts.push([X, Y]);
      }
      if (iters) {
        const simp = simplifyRing(pts, 1.1);
        if (simp.length >= 3) { d += ringToBezier(simp); continue; }
      }
      // sharp mode (smoothing = 0) or degenerate ring: straight segments
      for (let idx = 0; idx < pts.length; idx++) {
        d += (idx === 0 ? "M" : "L") + pts[idx][0].toFixed(1) + " " + pts[idx][1].toFixed(1) + " ";
      }
      d += "Z ";
    }
  }
  return d;
}

// ---- pen-plot mode ------------------------------------------------
// project a ground point at height gz through the same camera; also returns a
// depth (nearer = smaller) for z-buffered occlusion. height only bends the
// line in perspective (a real 3D ridgeline)
function penProject(gx, gy, gz, S, fit) {
  let rx, ry, depth;
  if (!S.perspective) {
    rx = (gx - S.xMin) / (S.xMax - S.xMin);
    ry = 1 - (gy - S.yMin) / (S.yMax - S.yMin);
    depth = gy;
  } else {
    const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const Zc = gy * cp - (gz - S.H) * sp;
    const Yc = gy * sp + (gz - S.H) * cp;
    rx = gx / Zc; ry = -Yc / Zc; depth = Zc;
  }
  return [fit.ox + fit.scale * rx, fit.oy + (fit.scaleY || fit.scale) * ry, depth];
}

// constant-width strokes carrying the color the surface has beneath them, so
// it plots like a set of same-width pen strokes. Returns one path per color.
// With hidden-line removal, a nearer row's silhouette (a per-column "floating
// horizon") clips any farther row that falls behind it.
function buildPenLines(S, fit, colorAt, opts) {
  const { nLines, samples, relief, threeD, hidden, evenScreen } = opts;
  const W = Math.max(2, Math.round(VB_W));
  const horizon = hidden ? new Float64Array(W + 1).fill(Infinity) : null;
  const clampB = (x) => (x < 0 ? 0 : x > W ? W : x);
  const byColor = new Map();
  const add = (color, sub) => { const a = byColor.get(color) || []; a.push(sub); byColor.set(color, a); };

  // pick each line's depth: either equal in the ground plane, or (in
  // perspective) equal in projected screen-y so they don't bunch at the horizon
  const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  const ryOf = (g) => -(g * sp - S.H * cp) / (g * cp + S.H * sp);
  const useScreen = evenScreen && S.perspective;
  const rect = S.rectOutput && S.perspective;
  const rNear = ryOf(S.yMin), rFar = ryOf(S.yMax);
  const depthForLine = (li) => {
    const f = (li + 0.5) / nLines;
    if (!useScreen) return S.yMin + f * (S.yMax - S.yMin);
    const r = rNear + f * (rFar - rNear);
    return S.H * (cp - r * sp) / (r * cp + sp);   // invert ry(gy) = r
  };

  for (let li = 0; li < nLines; li++) {          // li = 0 is nearest the camera
    const rowIy = ((li + 0.5) / nLines) * S.ny;
    const gyLin = depthForLine(li);
    const PX = new Float64Array(samples + 1), PY = new Float64Array(samples + 1);
    const COL = new Array(samples + 1), VIS = new Uint8Array(samples + 1);
    for (let s = 0; s <= samples; s++) {
      let gx, gy;
      if (rect) { const g = cell2ground((s / samples) * S.nx, rowIy, S); gx = g[0]; gy = g[1]; }
      else { gx = S.xMin + (s / samples) * (S.xMax - S.xMin); gy = gyLin; }
      const gz = threeD ? clampLift(heightAt(gx, gy, S) * relief, S, fit) : 0;
      const [sx, sy] = penProject(gx, gy, gz, S, fit);
      PX[s] = sx; PY[s] = sy; COL[s] = colorAt(gx, gy);
      // visible if it rises to / above the silhouette of everything nearer
      VIS[s] = hidden ? (sy <= horizon[clampB(Math.round(sx))] + 0.75 ? 1 : 0) : 1;
    }
    if (hidden) {                                 // fold this row into the horizon
      for (let s = 0; s < samples; s++) {
        let a = PX[s], b = PX[s + 1], ya = PY[s], yb = PY[s + 1];
        if (a > b) { const t = a; a = b; b = t; const u = ya; ya = yb; yb = u; }
        const bi = clampB(Math.round(a)), be = clampB(Math.round(b)), dx = (b - a) || 1e-6;
        for (let x = bi; x <= be; x++) { const y = ya + (yb - ya) * ((x - a) / dx); if (y < horizon[x]) horizon[x] = y; }
      }
    }
    let curColor = null, cur = "";
    const flush = () => { if (cur && curColor !== null) add(curColor, cur); cur = ""; curColor = null; };
    for (let s = 0; s <= samples; s++) {
      if (!VIS[s]) { flush(); continue; }
      const pt = PX[s].toFixed(1) + " " + PY[s].toFixed(1) + " ";
      if (curColor === null) { curColor = COL[s]; cur = "M" + pt; }
      else if (COL[s] !== curColor) { cur += "L" + pt; add(curColor, cur); curColor = COL[s]; cur = "M" + pt; }
      else { cur += "L" + pt; }
    }
    flush();
  }
  return [...byColor.entries()].map(([color, subs]) => ({ color, d: subs.join("") }));
}

// ---- concentric / "wood-knot" pen style ---------------------------
// chamfer distance transform: 0 outside the region, growing inward
function distTransform(mask, nx, ny) {
  const INF = 1e9, D = new Float64Array(nx * ny), s2 = Math.SQRT2;
  for (let p = 0; p < nx * ny; p++) D[p] = mask[p] ? INF : 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = j * nx + i; if (D[p] === 0) continue; let m = D[p];
    if (i > 0) m = Math.min(m, D[p - 1] + 1);
    if (j > 0) m = Math.min(m, D[p - nx] + 1);
    if (i > 0 && j > 0) m = Math.min(m, D[p - nx - 1] + s2);
    if (i < nx - 1 && j > 0) m = Math.min(m, D[p - nx + 1] + s2);
    D[p] = m;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const p = j * nx + i; if (D[p] === 0) continue; let m = D[p];
    if (i < nx - 1) m = Math.min(m, D[p + 1] + 1);
    if (j < ny - 1) m = Math.min(m, D[p + nx] + 1);
    if (i < nx - 1 && j < ny - 1) m = Math.min(m, D[p + nx + 1] + s2);
    if (i > 0 && j < ny - 1) m = Math.min(m, D[p + nx - 1] + s2);
    D[p] = m;
  }
  return D;
}

// scan-convert a triangle into a min-depth buffer
function rasterTri(buf, BW, BH, x0, y0, z0, x1, y1, z1, x2, y2, z2) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(BW - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(BH - 1, Math.ceil(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) return;
  const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(den) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / den;
    const w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / den;
    const w2 = 1 - w0 - w1;
    if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
    const z = w0 * z0 + w1 * z1 + w2 * z2, p = y * BW + x;
    if (z < buf[p]) buf[p] = z;
  }
}

// depth image of the wave surface, used to occlude rings behind nearer waves
function buildDepthBuffer(S, fit, relief, threeD, BW, BH) {
  const buf = new Float64Array(BW * BH).fill(Infinity);
  const gN = 100, stride = gN + 1;
  const SX = new Float64Array(stride * stride), SY = new Float64Array(stride * stride), DP = new Float64Array(stride * stride);
  for (let j = 0; j <= gN; j++) for (let i = 0; i <= gN; i++) {
    const [gx, gy] = cell2ground((i / gN) * S.nx, (j / gN) * S.ny, S);
    const gz = threeD ? clampLift(heightAt(gx, gy, S) * relief, S, fit) : 0;
    const [sx, sy, dp] = penProject(gx, gy, gz, S, fit);
    const q = j * stride + i; SX[q] = sx / VB_W * BW; SY[q] = sy / VB_H * BH; DP[q] = dp;
  }
  for (let j = 0; j < gN; j++) for (let i = 0; i < gN; i++) {
    const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1;
    rasterTri(buf, BW, BH, SX[a], SY[a], DP[a], SX[b], SY[b], DP[b], SX[c], SY[c], DP[c]);
    rasterTri(buf, BW, BH, SX[b], SY[b], DP[b], SX[e], SY[e], DP[e], SX[c], SY[c], DP[c]);
  }
  return buf;
}

// each color region is filled with nested rings that follow its edge shape
// (distance-transform iso-lines): ellipse -> concentric ellipses, band -> band-
// following lines. Rings ride the wave surface and are z-buffer occluded.
function buildPenConcentric(S, fit, colorAt, opts) {
  const { spacing, relief, threeD, hidden } = opts;
  const nx = S.nx, ny = S.ny;
  const cmap = new Map(), palette = [], idxField = new Int32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [gx, gy] = cell2ground(i + 0.5, j + 0.5, S);
    const c = colorAt(gx, gy);
    let id = cmap.get(c); if (id === undefined) { id = palette.length; cmap.set(c, id); palette.push(c); }
    idxField[j * nx + i] = id;
  }
  const BW = 340, BH = Math.max(2, Math.round(BW * VB_H / VB_W));
  const zbuf = hidden ? buildDepthBuffer(S, fit, relief, threeD, BW, BH) : null;
  let bias = 0;
  if (zbuf) { let mn = Infinity, mx = -Infinity; for (const v of zbuf) if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } bias = ((mx - mn) || 1) * 0.02; }
  const visAt = (sx, sy, depth) => {
    if (!zbuf) return true;
    const bx = Math.round(sx / VB_W * BW), by = Math.round(sy / VB_H * BH);
    if (bx < 0 || bx >= BW || by < 0 || by >= BH) return true;
    return depth - bias <= zbuf[by * BW + bx];
  };
  const byColor = new Map();
  const add = (color, sub) => { const a = byColor.get(color) || []; a.push(sub); byColor.set(color, a); };
  const emitRing = (ring, color) => {
    const n = ring.length; let cur = "", started = false, hasL = false;
    for (let k = 0; k <= n; k++) {
      const v = ring[k % n];
      const [gx, gy] = cell2ground(v[0], v[1], S);
      const gz = threeD ? clampLift(heightAt(gx, gy, S) * relief, S, fit) : 0;
      const [sx, sy, depth] = penProject(gx, gy, gz, S, fit);
      if (visAt(sx, sy, depth)) {
        const pt = sx.toFixed(1) + " " + sy.toFixed(1) + " ";
        if (!started) { cur = "M" + pt; started = true; hasL = false; }
        else { cur += "L" + pt; hasL = true; }
      } else {
        if (started && hasL) add(color, cur);
        started = false; cur = ""; hasL = false;
      }
    }
    if (started && hasL) add(color, cur);
  };
  const mask = new Float64Array(nx * ny);
  for (let c = 0; c < palette.length; c++) {
    let any = false;
    for (let p = 0; p < nx * ny; p++) { mask[p] = idxField[p] === c ? 1 : 0; if (mask[p]) any = true; }
    if (!any) continue;
    const D = distTransform(mask, nx, ny);
    let maxD = 0; for (let p = 0; p < D.length; p++) if (D[p] > maxD) maxD = D[p];
    const ts = []; for (let t = 0.6; t < maxD && ts.length < 240; t += spacing) ts.push(t);
    if (!ts.length) continue;
    const conts = d3.contours().size([nx, ny]).thresholds(ts)(D);
    for (const cont of conts) for (const poly of cont.coordinates) for (const ring0 of poly) {
      emitRing((S.smooth || 0) ? chaikin(ring0, S.smooth) : ring0, palette[c]);
    }
  }
  return [...byColor.entries()].map(([color, subs]) => ({ color, d: subs.join("") }));
}

// ---- color environment --------------------------------------------
// 2D environment panorama: width = azimuth (looking across the lake),
// height = elevation (waterline at the bottom, sky at the top).
const ENV2D_W = 84, ENV2D_H = 52;
// taller row count for panoramas derived from presets / the 1D strip when
// reflected objects force the 2D path — keeps hairline bands ≥ 2 rows
const DERIVED_ENV_H = 96;

// 1D environment strip: color by elevation only (horizon -> zenith)
const ENV_N = 64;
function seedEnv(name, n) {
  return d3.range(n).map((i) => d3.color(paletteColorAt(name, i / (n - 1))).formatHex());
}

// collapse the painted 1D strip into runs of equal color: one band per run,
// with boundaries exactly at the run edges. Unlike sampling N evenly-spaced
// bands, this keeps a 1-row painted hairline as its own (thin) band.
function envRuns(envColors) {
  const colors = [], fracs = [];
  const n = envColors.length;
  for (let i = 0; i < n; i++) {
    if (i === 0 || envColors[i] !== envColors[i - 1]) {
      colors.push(envColors[i]);
      if (i > 0) fracs.push(i / n);
    }
  }
  return { colors, fracs };
}
function smoothEnv(arr) {
  return arr.map((c, i) => {
    const a = d3.rgb(arr[Math.max(0, i - 1)]);
    const b = d3.rgb(c);
    const e = d3.rgb(arr[Math.min(arr.length - 1, i + 1)]);
    return d3.rgb((a.r + b.r + e.r) / 3, (a.g + b.g + e.g) / 3, (a.b + b.b + e.b) / 3).formatHex();
  });
}
// separable box blur on a continuous field (used to de-jitter the reflected
// direction fields before quantizing them into panorama cells)
function blurField(src, nx, ny, tmp, passes) {
  for (let it = 0; it < passes; it++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = src[j * nx + (i > 0 ? i - 1 : i)], b = src[j * nx + i], c = src[j * nx + (i < nx - 1 ? i + 1 : i)];
      tmp[j * nx + i] = (a + b + c) / 3;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = tmp[(j > 0 ? j - 1 : j) * nx + i], b = tmp[j * nx + i], c = tmp[(j < ny - 1 ? j + 1 : j) * nx + i];
      src[j * nx + i] = (a + b + c) / 3;
    }
  }
}

// horizontal-stripe panorama from any elevation->color function
function envFromRows(colorAtF, w, h) {
  const cells = new Array(w * h);
  for (let r = 0; r < h; r++) {                 // r = 0 is the waterline
    const c = d3.color(colorAtF(r / (h - 1))).formatHex();
    for (let col = 0; col < w; col++) cells[r * w + col] = c;
  }
  return { w, h, cells };
}

function seedEnv2D(name, w, h) {
  return envFromRows((f) => paletteColorAt(name, f), w, h);
}

// ---- reflected scene objects ---------------------------------------
// Objects (a sailboat, a dock, a buoy...) are environment features: shapes
// stamped into the reflected panorama at an azimuth. The water then reflects
// them exactly like the sky — the reflection stretches toward the viewer,
// shreds on the ripples, and rims itself with an ink outline, through the
// same contour machinery as everything else. Like the boats in the reference
// paintings, the object itself sits across the water, outside the frame;
// only its reflection appears.
//
// Each shape is evaluated in a local box: u ∈ [-1, 1] across its width,
// v ∈ [0, 1] from the waterline to its top. Returns 0 = empty, 1 = primary
// color (structure), 2 = accent color (the color that "pops").
const OBJECT_SHAPES = {
  sailboat: { aspect: 1.7, label: ["hull", "sails"], fn: (u, v) => {
    if (v < 0.16 && Math.abs(u) < 0.95 - 1.8 * Math.max(0, 0.09 - v)) return 1; // hull, tapered bow/stern
    if (v >= 0.14 && v < 0.99) {
      const fm = (0.99 - v) / 0.85;                       // mainsail: tall triangle aft of the mast
      if (u >= 0.03 && u < 0.03 + 0.9 * fm) return 2;
      if (v < 0.8) {                                      // jib: shorter triangle forward
        const fj = (0.8 - v) / 0.66;
        if (u <= -0.03 && u > -0.03 - 0.7 * fj) return 2;
      }
    }
    return 0;
  } },
  dock: { aspect: 4.0, label: ["pilings", "deck"], fn: (u, v) => {
    if (v >= 0.5 && v < 0.85) return v >= 0.72 ? 2 : 1;   // deck slab, lit top edge
    if (v < 0.5) {
      for (const k of [-0.7, -0.235, 0.235, 0.7]) if (Math.abs(u - k) < 0.06) return 1;
    }
    return 0;
  } },
  buoy: { aspect: 0.8, label: ["base", "ball"], fn: (u, v) => {
    const dv = (v - 0.52) / 0.46;
    if (u * u + dv * dv <= 1) return 2;                   // the ball
    if (v < 0.1 && Math.abs(u) < 0.3) return 1;           // dark waterline nub
    return 0;
  } },
  post: { aspect: 0.3, label: ["post", "cap"], fn: (u, v) =>
    (Math.abs(u) < 0.55 ? (v > 0.82 ? 2 : 1) : 0) },
};

// nudge a color's low blue bits so every object instance gets unique hexes —
// repeated colors would fuse into one region in the segmentation
function tweakHex(hex, salt) {
  const c = d3.rgb(hex);
  return d3.rgb(c.r, c.g, Math.max(0, Math.min(255, (c.b & ~7) + (salt % 8)))).formatHex();
}

// stamp the live objects into a copy of the panorama. Sizes are in degrees of
// reflected elevation (so they read at the same scale as the eLo..eHi range);
// each silhouette gets a 1-cell ink rim so its reflection carries the
// paintings' dark contour line.
function stampObjects(env, objects, azSpan, eLo, eHi) {
  const live = objects.filter((o) => o.on);
  if (!env || !live.length) return env;
  const { w, h } = env;
  const cells = env.cells.slice();
  const span = (eHi - eLo) || 1;
  const colsPerDeg = w / (2 * azSpan);
  const rowsPerDeg = h / span;
  live.forEach((o, oi) => {
    const shape = OBJECT_SHAPES[o.type];
    const hRows = Math.max(2, o.size * rowsPerDeg);
    const halfCols = Math.max(1, (o.size * shape.aspect / 2) * colsPerDeg);
    const rowBase = (0 - eLo) * rowsPerDeg;               // objects sit on the waterline
    const colC = ((o.az + azSpan) / (2 * azSpan)) * w;
    const primary = tweakHex(o.color, oi * 2 + 1);
    const accent = tweakHex(o.color2, oi * 2 + 1);
    const ink = tweakHex("#070a0e", oi * 2 + 1);
    const mask = new Uint8Array(w * h);
    const r0 = Math.max(0, Math.floor(rowBase)), r1 = Math.min(h - 1, Math.ceil(rowBase + hRows));
    const c0 = Math.max(0, Math.floor(colC - halfCols)), c1 = Math.min(w - 1, Math.ceil(colC + halfCols));
    for (let r = r0; r <= r1; r++) {
      const v = (r + 0.5 - rowBase) / hRows;
      if (v < 0 || v > 1) continue;
      for (let c = c0; c <= c1; c++) {
        const u = (c + 0.5 - colC) / halfCols;
        if (u < -1 || u > 1) continue;
        const t = shape.fn(u, v);
        if (t) { cells[r * w + c] = t === 2 ? accent : primary; mask[r * w + c] = 1; }
      }
    }
    for (let r = Math.max(0, r0 - 1); r <= Math.min(h - 1, r1 + 1); r++) {
      for (let c = Math.max(0, c0 - 1); c <= Math.min(w - 1, c1 + 1); c++) {
        if (mask[r * w + c]) continue;
        let near = false;
        for (let dr = -1; dr <= 1 && !near; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < h && cc >= 0 && cc < w && mask[rr * w + cc]) { near = true; break; }
          }
        }
        if (near) cells[r * w + c] = ink;
      }
    }
  });
  return { w, h, cells };
}

// soften the painted panorama: 3x3 RGB box blur of the cells, so neighbouring
// colors melt into each other instead of meeting at hard seams
function smoothEnv2D(env) {
  const { w, h, cells } = env;
  const out = new Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const col = d3.rgb(cells[rr * w + cc]); R += col.r; G += col.g; B += col.b; n++;
      }
      out[r * w + c] = d3.rgb(R / n, G / n, B / n).formatHex();
    }
  }
  return { w, h, cells: out };
}

// preset palette as ordered elevation bands (for the non-custom path)
function bandColors(NB, palette) {
  const interp = d3.interpolateRgbBasis(PALETTES[palette]);
  return d3.range(NB).map((k) => interp(NB === 1 ? 0 : k / (NB - 1)));
}

// ---- geometry build, preset path (elevation isobands) -------------
function buildGeometry(S) {
  const { nx, ny } = S;
  S._ems = S.emitters.filter((e) => e.on).map((e) => prepEmitter(e, S));
  const values = new Float64Array(nx * ny);
  const wVals = S.fresOn ? new Float64Array(nx * ny) : null;
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [gx, gy] = cell2ground(i + 0.5, j + 0.5, S);
      const R = reflectAt(gx, gy, S);
      const v = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
      values[j * nx + i] = v;
      if (wVals) wVals[j * nx + i] = fresnelDeepW(R[3]);
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
  }
  // banded palettes carry their own (non-uniform) band fractions — this is
  // what lets a 2%-thick ink strip survive regardless of the band count.
  // Reflection detail narrows the window the boundaries sit in (values stay
  // raw φ, so the reported lo/hi — and auto-fit — are unaffected by mag).
  const NB = S.bands;
  const mag = S.reflMag || 1;
  const mid = (S.eLo + S.eHi) / 2, magSpan = (S.eHi - S.eLo) / mag;
  const bnd = (f) => mid + (f - 0.5) * magSpan;
  const boundaries = S.bandFractions
    ? S.bandFractions.map(bnd)
    : d3.range(1, NB).map((k) => bnd(k / NB));
  const fit = computeFit(S);
  const contours = d3.contours().size([nx, ny]).thresholds(boundaries)(values);
  let fres = null;
  if (wVals) {
    const K = S.fresBands;
    const fc = d3.contours().size([nx, ny])
      .thresholds(d3.range(1, K).map((k) => k / K))(wVals);
    fres = fc.map((c) => multiToPath(c, S, fit));
  }
  return { ds: contours.map((c) => multiToPath(c, S, fit)), fres, lo, hi };
}

// ---- geometry build, custom 2D path ------------------------------
// The failure mode to avoid: any compositing that follows the panorama's
// *cell grid* (elevation rows × azimuth columns) turns a painted region's
// smooth outline into a per-cell staircase — each cell step contributes its
// own row sliver and column swath, and a flat-colored region ends up with
// shredded, jagged edges. What makes the 1D path smooth is that every
// visible boundary is a single contour of one continuous scalar field.
//
// So we build exactly that, per color: a signed distance field of the
// color's painted region in panorama space (positive inside, negative
// outside), sampled through the continuous reflected-direction fields onto
// the water grid. The zero level set of that composed field IS the region's
// reflection boundary — one smooth, ripple-distorted contour, regardless of
// how blocky the painted pixels are.
//
// A hand-smoothed ("melted") panorama can have thousands of distinct colors;
// past a sanity cap we fall back to row/column compositing, where the
// per-cell structure is invisible because neighbouring colors are near-equal.
const SEG_MAX_COLORS = 160;

function buildSegmentation(S, env2d, azSpan) {
  const { nx, ny } = S;
  S._ems = S.emitters.filter((e) => e.on).map((e) => prepEmitter(e, S));
  const { w: EW, h: EH, cells } = env2d;
  const eLo = S.eLo, eHi = S.eHi, az = azSpan;
  const span = (eHi - eLo) || 1;

  // continuous reflected-direction fields, in panorama-cell units
  const fF = new Float64Array(nx * ny); // elevation, 0..EH (row units)
  const fG = new Float64Array(nx * ny); // azimuth,   0..EW (col units)
  const fW = S.fresOn ? new Float64Array(nx * ny) : null; // deep-water weight 0..1
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [gx, gy] = cell2ground(i + 0.5, j + 0.5, S);
      const R = reflectAt(gx, gy, S);
      const phi = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
      let psi = Math.atan2(R[0], R[1]) * 180 / Math.PI;
      psi = psi < -az ? -az : psi > az ? az : psi;
      fF[j * nx + i] = phi;
      fG[j * nx + i] = psi;
      if (fW) fW[j * nx + i] = fresnelDeepW(R[3]);
      if (phi < lo) lo = phi; if (phi > hi) hi = phi;
    }
  }
  // optional smoothing (the "edge ripple" slider): each pass box-blurs the
  // reflected-direction fields in water space — calmer, broader regions at
  // the cost of per-ripple detail. At 0 every wavelet keeps its full
  // excursion, matching the 1D path.
  const passes = Math.max(0, S.coherence | 0);
  if (passes) {
    const tmp = new Float64Array(nx * ny);
    blurField(fF, nx, ny, tmp, passes);
    blurField(fG, nx, ny, tmp, passes);
    if (fW) blurField(fW, nx, ny, tmp, passes);
  }
  // convert to cell units (through the reflection-detail magnification)
  const mag = S.reflMag || 1;
  for (let p = 0; p < nx * ny; p++) {
    let v = magFrac((fF[p] - eLo) / span, mag); v = v < 0 ? 0 : v > 1 ? 1 : v; fF[p] = v * EH;
    let u = magFrac((fG[p] + az) / (2 * az), mag); u = u < 0 ? 0 : u > 1 ? 1 : u; fG[p] = u * EW;
  }

  const fit = computeFit(S);

  // Fresnel depth bands: upper-set contours of the deep-water weight, used as
  // nested clips — inside band k every color is re-mixed toward the deep color
  let fres = null;
  if (fW) {
    const K = S.fresBands;
    fres = d3.contours().size([nx, ny])
      .thresholds(d3.range(1, K).map((k) => k / K))(fW)
      .map((c) => multiToPath(c, S, fit));
  }

  // distinct panorama colors, with cell counts for stacking order
  const colorId = new Map(), colorOf = [], areas = [];
  const labels = new Int32Array(EW * EH);
  for (let p = 0; p < EW * EH; p++) {
    const c = cells[p];
    let id = colorId.get(c);
    if (id === undefined) { id = colorOf.length; colorId.set(c, id); colorOf.push(c); areas.push(0); }
    labels[p] = id; areas[id]++;
  }

  if (colorOf.length <= SEG_MAX_COLORS) {
    const K = colorOf.length;
    // stack colors bottom-up by the mean elevation of their painted cells —
    // the 2D generalization of the 1D band order. Layer k is drawn as the
    // UNION of color k and every color above it, so like the 1D upper sets
    // each layer solidly contains the next: smoothing can shift a shared
    // edge but can never open a background seam between neighbours.
    const rowSum = new Float64Array(K);
    for (let p = 0; p < EW * EH; p++) rowSum[labels[p]] += (p / EW) | 0;
    const order = d3.range(K).sort((a, b) => rowSum[a] / areas[a] - rowSum[b] / areas[b]);
    const union = new Float64Array(EW * EH), inv = new Float64Array(EW * EH);
    const D0 = new Float64Array(EW * EH), tmpP = new Float64Array(EW * EH);
    const F = new Float64Array(nx * ny);
    // fields are contoured on a one-cell-padded grid (edge values replicated)
    // so every region overshoots the water's edge instead of tracing it; the
    // whole stack is then clipped to the exact trapezoid. Otherwise each
    // layer would re-trace the frame with its own smoothing wobble, and the
    // layer below would peek through in dotted slivers along the border.
    const px = nx + 2, py = ny + 2;
    const FP = new Float64Array(px * py);
    // exact projected outline of the water plane, used to clip the stack
    const corner = (ix, iy) => {
      const [gx, gy] = cell2ground(ix, iy, S);
      const [rx, ry] = rawProject(gx, gy, S);
      return [fit.ox + fit.scale * rx, fit.oy + (fit.scaleY || fit.scale) * ry];
    };
    const cs = [corner(0, 0), corner(nx, 0), corner(nx, ny), corner(0, ny)];
    const clip = "M" + cs.map((c) => c[0].toFixed(1) + " " + c[1].toFixed(1)).join(" L") + " Z";
    const ex = { cx: (cs[0][0] + cs[1][0] + cs[2][0] + cs[3][0]) / 4,
                 cy: (cs[0][1] + cs[1][1] + cs[2][1] + cs[3][1]) / 4, s: 1.05 };
    const layers = new Array(K);
    for (let k = K - 1; k >= 0; k--) {   // top of the stack down, growing the union
      for (let p = 0; p < EW * EH; p++) {
        if (labels[p] === order[k]) union[p] = 1;
        inv[p] = 1 - union[p];
      }
      // signed distance in panorama cells: >0 inside the union, <0 outside,
      // zero crossing on the painted boundary
      const D = distTransform(union, EW, EH), Dout = distTransform(inv, EW, EH);
      let thick = 0;
      for (let p = 0; p < EW * EH; p++) { D[p] -= Dout[p]; if (D[p] > thick) thick = D[p]; }
      // a light blur rounds the pixel-corner bevels of the painted boundary —
      // in PANORAMA space, where the corners live. (Blurring the composed
      // field in water space instead flattens every small ripple's φ
      // excursion, erasing the fine reflection rings the 1D path keeps.)
      // For a stripe boundary the SDF is linear across it, so the blur is a
      // no-op there and stripes stay in exact 1D parity. Skip thin unions
      // (the topmost gradient rows): nothing to round, and the blur would
      // erase them. The sign clamp keeps solidly-inside/outside cells on
      // their own side, so 1-cell features (object ink rims) survive.
      if (thick >= 2) {
        for (let p = 0; p < EW * EH; p++) D0[p] = D[p];
        blurField(D, EW, EH, tmpP, 1);
        for (let p = 0; p < EW * EH; p++) {
          if (D0[p] >= 1 && D[p] < 0.25) D[p] = 0.25;
          else if (D0[p] <= -1 && D[p] > -0.25) D[p] = -0.25;
        }
      }
      // compose through the reflection: bilinear sample at each water
      // sample's continuous (azimuth, elevation) panorama coordinate
      for (let p = 0; p < nx * ny; p++) {
        const x = Math.min(EW - 1, Math.max(0, fG[p] - 0.5));
        const y = Math.min(EH - 1, Math.max(0, fF[p] - 0.5));
        const i0 = Math.min(EW - 2, Math.floor(x)), j0 = Math.min(EH - 2, Math.floor(y));
        const fx = x - i0, fy = y - j0, q = j0 * EW + i0;
        F[p] = (D[q] * (1 - fx) + D[q + 1] * fx) * (1 - fy)
             + (D[q + EW] * (1 - fx) + D[q + EW + 1] * fx) * fy;
      }
      for (let j = 0; j < py; j++) {
        const jj = Math.min(ny - 1, Math.max(0, j - 1));
        for (let i = 0; i < px; i++) {
          const ii = Math.min(nx - 1, Math.max(0, i - 1));
          FP[j * px + i] = F[jj * nx + ii];
        }
      }
      const cont = d3.contours().size([px, py]).thresholds([0])(FP)[0];
      layers[k] = { d: multiToPath(cont, S, fit, -1, ex), color: colorOf[order[k]] };
    }
    const drawn = layers.filter((l) => l.d);
    return { bg: cells[0], layers: drawn, clip, fres, lo, hi, count: drawn.length, twoD: true };
  }

  // upper-set contours of each field (smooth, sub-cell boundaries)
  const elevC = d3.contours().size([nx, ny]).thresholds(d3.range(1, EH))(fF);
  const azC = d3.contours().size([nx, ny]).thresholds(d3.range(1, EW))(fG);
  const elevPath = elevC.map((c) => multiToPath(c, S, fit)); // index k => {fF >= k+1}
  const azPath = azC.map((c) => multiToPath(c, S, fit));     // index k => {fG >= k+1}

  // azimuth layering for a given panorama row: base = col 0, then a swath
  // wherever the color actually changes left-to-right
  const rowAz = (r) => {
    const out = [];
    for (let c = 1; c < EW; c++) {
      const here = cells[r * EW + c], prev = cells[r * EW + c - 1];
      if (here !== prev && azPath[c - 1]) out.push({ d: azPath[c - 1], color: here });
    }
    return out;
  };
  const sameRow = (r1, r2) => {
    for (let c = 0; c < EW; c++) if (cells[r1 * EW + c] !== cells[r2 * EW + c]) return false;
    return true;
  };

  const rows = [];
  rows.push({ clip: null, base: null, az: rowAz(0) }); // row 0 sits on the bg
  let last = 0;
  for (let r = 1; r < EH; r++) {
    const clip = elevPath[r - 1];
    if (!clip) break;                        // {fF >= r} empty -> nothing higher
    if (sameRow(r, last)) continue;          // merge identical bands
    rows.push({ clip, base: cells[r * EW], az: rowAz(r) });
    last = r;
  }
  const count = rows.reduce((n, row) => n + 1 + row.az.length, 0);
  return { bg: cells[0], rows, fres, lo, hi, count, twoD: true };
}

// exported for tests: the two render paths plus the helpers needed to feed
// them, so 1D/2D fidelity parity can be checked without mounting the UI
export {
  buildGeometry, buildSegmentation, envFromRows, stampObjects,
  paletteStops, paletteColorAt, DERIVED_ENV_H, ENV2D_W, DEFAULT_EMITTERS,
  computeFit, cell2ground, heightAt, clampLift, penProject,
};

// ---- layered-paper stack export -----------------------------------
// Decompose the scene into a stack of physical paper sheets. Each sheet is
// ONE contiguous piece of paper (so it can be cut from a single sheet) with
// holes punched in it; stacked in order, each hole reveals the sheet below and
// the stack reproduces the image. The construction:
//
//   * label 4-connected components of equal color on the sample grid — these
//     are the "regions" (nodes). Two regions are adjacent when their cells
//     touch (edges).
//   * seed a growing blob from an outer FRAME region (a unique registration
//     color). Repeatedly absorb the whole same-color frontier that has the
//     largest area; each absorption emits one sheet whose color is that color
//     and whose shape is the cumulative union absorbed so far.
//
// Two invariants make this correct *and* physical, for free:
//   - Contiguity: we only ever absorb regions ADJACENT to the blob, growing
//     from one connected seed, so every sheet's mask stays one 4-connected
//     piece — no floating islands, ever.
//   - Nesting: sheet_{i+1} ⊇ sheet_i, so the first sheet (from the top) that
//     covers a point is the one that absorbed that point's region, and its
//     color is that region's own color. The image is reproduced exactly for
//     ANY choice of which color to peel next — the choice only affects how
//     many sheets result. Same-color regions merge onto one sheet exactly when
//     a single region separates them from the blob (the smilie's eyes+mouth,
//     one region — the face — away from the frontier).
//
// A sheet's outline is contoured with the same d3.contours + multiToPath
// pipeline as the union layers, so edges stay smooth and correctly projected.
// The graph algorithms (region labeling, denoise, and the peel-order
// planner — greedy + budgeted exact search) live in paperStack.js.

const PAPER_FRAME_COLOR = "#ff2d78"; // fallback registration color if no background

// full pipeline: color grid (+ palette id->hex) -> ordered sheets with paths.
// bgColor is the scene's background fill: the mount/frame sheet takes this color
// and absorbs any background-colored regions, so the water edge is cut once.
function buildPaperStack(S, grid, palette, bgColor, minCells = 5) {
  const { nx, ny } = S;
  const fit = computeFit(S);

  // collapse duplicate hexes up front: two grid values with the same paper
  // color must label as ONE color, so its regions can gather onto one sheet
  // (and so no two adjacent regions ever share a color, which the planner's
  // one-color-per-step transitions and lower bound rely on)
  const hexId = new Map();
  const uniq = [];
  for (let p = 0; p < nx * ny; p++) {
    const hx = palette[grid[p]];
    let id = hexId.get(hx);
    if (id === undefined) { id = uniq.length; hexId.set(hx, id); uniq.push(hx); }
    grid[p] = id;
  }

  denoiseGrid(grid, nx, ny, minCells);
  const { label, regions } = labelRegions(grid, nx, ny);
  for (const r of regions) r.color = uniq[r.value];
  const adj = buildAdjacency(label, regions.length, nx, ny);

  // frame: a virtual node adjacent to every region touching the grid border
  const frameId = regions.length;
  regions.push({ value: -1, cells: [], size: 0, color: bgColor || PAPER_FRAME_COLOR, frame: true });
  adj.push(new Set());
  const touch = new Set();
  for (let x = 0; x < nx; x++) { touch.add(label[x]); touch.add(label[(ny - 1) * nx + x]); }
  for (let y = 0; y < ny; y++) { touch.add(label[y * nx]); touch.add(label[y * nx + nx - 1]); }
  for (const r of touch) { adj[frameId].add(r); adj[r].add(frameId); }

  const { sheets, method } = planCollapse(regions, adj, frameId);

  // exact projected water outline (clip) + overshoot expansion, as in the
  // union-layer path, so each sheet's cut edge overshoots the frame instead of
  // tracing it and the whole stack registers to one trapezoid.
  const cornerPt = (ix, iy) => {
    const [gx, gy] = cell2ground(ix, iy, S);
    const [rx, ry] = rawProject(gx, gy, S);
    return [fit.ox + fit.scale * rx, fit.oy + (fit.scaleY || fit.scale) * ry];
  };
  const cs = [cornerPt(0, 0), cornerPt(nx, 0), cornerPt(nx, ny), cornerPt(0, ny)];
  const clip = "M" + cs.map((c) => c[0].toFixed(1) + " " + c[1].toFixed(1)).join(" L") + " Z";
  const ex = { cx: (cs[0][0] + cs[1][0] + cs[2][0] + cs[3][0]) / 4,
               cy: (cs[0][1] + cs[1][1] + cs[2][1] + cs[3][1]) / 4, s: 1.05 };

  // per sheet, contour the HOLE = everything not yet absorbed (the inverse of
  // the cumulative union). The cut line is then the boundary between this
  // sheet's paper and the sheets below; it only touches the grid rim (the
  // water<->background edge) on the top sheet, never re-cutting it afterwards.
  //
  // A raw 0/1 mask contour is a per-cell staircase (marching squares puts
  // every vertex at a cell-edge midpoint), so — same trick as the union
  // layers — contour the zero level set of a lightly blurred SIGNED DISTANCE
  // field of the mask instead: the crossing interpolates to sub-cell
  // positions and the cut edge comes out as smooth as the normal export.
  const px = nx + 2, py = ny + 2;
  const cum = new Uint8Array(nx * ny);
  const inv = new Uint8Array(nx * ny);
  const F = new Float64Array(nx * ny);
  const tmp = new Float64Array(nx * ny);
  const FP = new Float64Array(px * py);
  // physical guard: the sheet is one piece only because every paper component
  // reaches the grid border (= the mount margin). True for the planner's mask
  // by construction; the blur must not pinch a thin bridge and break it.
  const paperHoldsTogether = () => {
    const seen = new Uint8Array(nx * ny);
    const st = [];
    for (let s = 0; s < nx * ny; s++) {
      if (F[s] >= 0 || seen[s]) continue;
      let touchesBorder = false;
      seen[s] = 1; st.push(s);
      while (st.length) {
        const p = st.pop(), x = p % nx, y = (p / nx) | 0;
        if (x === 0 || x === nx - 1 || y === 0 || y === ny - 1) touchesBorder = true;
        if (x > 0 && F[p - 1] < 0 && !seen[p - 1]) { seen[p - 1] = 1; st.push(p - 1); }
        if (x < nx - 1 && F[p + 1] < 0 && !seen[p + 1]) { seen[p + 1] = 1; st.push(p + 1); }
        if (y > 0 && F[p - nx] < 0 && !seen[p - nx]) { seen[p - nx] = 1; st.push(p - nx); }
        if (y < ny - 1 && F[p + nx] < 0 && !seen[p + nx]) { seen[p + nx] = 1; st.push(p + nx); }
      }
      if (!touchesBorder) return false;
    }
    return true;
  };
  let cumCount = 0;
  const out = [];
  for (let si = 0; si < sheets.length; si++) {
    const sh = sheets[si];
    for (const id of sh.members) {
      const r = regions[id];
      for (const p of r.cells) if (!cum[p]) { cum[p] = 1; cumCount++; }
    }
    let d = "";
    const solid = cumCount >= nx * ny;
    if (!solid) {                          // an open hole remains to cut
      for (let p = 0; p < nx * ny; p++) inv[p] = 1 - cum[p];
      const Din = distTransform(inv, nx, ny);   // depth into the hole
      const Dout = distTransform(cum, nx, ny);  // depth into the paper
      let thick = 0;
      for (let p = 0; p < nx * ny; p++) {
        F[p] = Din[p] - Dout[p];                // >0 hole, <0 paper
        if (F[p] > thick) thick = F[p];
      }
      // skip the blur on hairline holes (it would erase them), and undo it if
      // it disconnected the paper — sub-cell interpolation still smooths
      if (thick >= 2) {
        blurField(F, nx, ny, tmp, 1);
        if (!paperHoldsTogether()) {
          for (let p = 0; p < nx * ny; p++) F[p] = Din[p] - Dout[p];
        }
      }
      for (let j = 0; j < py; j++) {
        const jj = Math.min(ny - 1, Math.max(0, j - 1));
        for (let i = 0; i < px; i++) {
          const ii = Math.min(nx - 1, Math.max(0, i - 1));
          FP[j * px + i] = F[jj * nx + ii];
        }
      }
      const cont = d3.contours().size([px, py]).thresholds([0])(FP)[0];
      if (cont) d = multiToPath(cont, S, fit, -1, ex);
    }
    out.push({ color: sh.color, d, frame: !!sh.frame, solid });
  }
  return { sheets: out, clip, nSheets: out.length, method };
}

// tile the sheets into one printable SVG: each is the full viewport in its
// paper color with the holes shown as a hatched "cut" fill and a dashed cut
// line. Listed top -> bottom (assemble the stack bottom -> top).
function buildPaperStackSvg(stack, rollTf) {
  const sheets = stack.sheets, N = sheets.length;
  const cols = Math.min(4, Math.max(1, N));
  const rows = Math.ceil(N / cols);
  const tileW = 240, tileH = Math.round(tileW * VB_H / VB_W);
  const labelH = 26, gap = 18, pad = 20, top = 46;
  const W = pad * 2 + cols * tileW + (cols - 1) * gap;
  const H = top + pad + rows * (tileH + labelH) + (rows - 1) * gap;
  const sx = tileW / VB_W;
  const ord = stack.method === "optimal" ? "provably fewest" : "greedy order";
  let body = `<text x="${pad}" y="26" font-family="ui-monospace,monospace" font-size="15" fill="#e6eef5">`
    + `Layered paper stack · ${N} sheets (${ord}) · top → bottom (assemble bottom → top)</text>`;
  sheets.forEach((sh, i) => {
    const cx = pad + (i % cols) * (tileW + gap);
    const cy = top + Math.floor(i / cols) * (tileH + labelH + gap);
    const tf = `translate(${cx} ${cy}) scale(${sx.toFixed(4)})` + (rollTf ? " " + rollTf : "");
    // clip the tile to its viewport so a zoomed-in scene crops instead of
    // spilling into neighbours; the hole is further clipped to the water plane
    // (so its 5% overshoot never bleeds into the mount margin).
    body += `<clipPath id="ptile${i}"><rect x="${cx}" y="${cy}" width="${tileW}" height="${tileH}"/></clipPath>`;
    body += `<clipPath id="ptrap${i}"><path transform="${tf}" d="${stack.clip}"/></clipPath>`;
    body += `<g clip-path="url(#ptile${i})">`;
    // full-sheet paper — this is the whole physical sheet, mount margin and all,
    // in one color; the water<->background edge is NOT drawn here
    body += `<rect x="${cx}" y="${cy}" width="${tileW}" height="${tileH}" fill="${sh.color}"/>`;
    // holes: paper removed to reveal the sheets below (hatched + dashed cut line)
    if (sh.d) body += `<g clip-path="url(#ptrap${i})">`
      + `<path transform="${tf}" d="${sh.d}" fill="url(#cuthatch)" fill-rule="evenodd"/>`
      + `<path transform="${tf}" d="${sh.d}" fill="none" fill-rule="evenodd" stroke="#0b0f14"`
      + ` stroke-width="1" stroke-dasharray="4 2"/></g>`;
    body += `</g>`;
    body += `<rect x="${cx}" y="${cy}" width="${tileW}" height="${tileH}" fill="none"`
      + ` stroke="#000" stroke-opacity="0.35" stroke-width="1"/>`;
    const role = sh.frame ? "BACKGROUND · mount" : (sh.solid ? "BACKING · solid" : `sheet ${i}`);
    body += `<text x="${cx}" y="${cy + tileH + 17}" font-family="ui-monospace,monospace"`
      + ` font-size="11" fill="#c9d4da">${i + 1}. ${role} · ${sh.color}</text>`;
  });
  const defs = `<defs><pattern id="cuthatch" width="7" height="7" patternUnits="userSpaceOnUse"`
    + ` patternTransform="rotate(45)"><rect width="7" height="7" fill="#0d1116"/>`
    + `<line x1="0" y1="0" x2="0" y2="7" stroke="#39454f" stroke-width="1.6"/></pattern></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="#0b0f14"/>${defs}${body}</svg>`;
}

// ---- UI bits -------------------------------------------------------
function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5,
        letterSpacing: 0.3, color: "#9fb0c0", marginBottom: 4, fontFamily: "ui-monospace, monospace" }}>
        <span>{label}</span>
        <span style={{ color: "#e6eef5" }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 24, cursor: "pointer" }} />
    </label>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <button onClick={() => onChange(!value)}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
        background: "none", border: "none", padding: "9px 0", cursor: "pointer", minHeight: 42,
        color: "#cdd9e3", fontSize: 13.5, fontFamily: "ui-monospace, monospace" }}>
      <span style={{ width: 36, height: 21, borderRadius: 11, padding: 2,
        background: value ? "#3f8597" : "#2a3640", transition: "background .15s", flexShrink: 0,
        display: "inline-flex", justifyContent: value ? "flex-end" : "flex-start" }}>
        <span style={{ width: 17, height: 17, borderRadius: "50%", background: "#eaf2f7" }} />
      </span>
      {label}
    </button>
  );
}

function PaintStrip({ envColors, setEnvColors, activeColor, height, brushSize }) {
  const ref = useRef(null);
  const painting = useRef(false);
  const lastIdx = useRef(-1);
  const paintAt = (clientY) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const f = 1 - (clientY - r.top) / r.height; // 0 = waterline, 1 = zenith
    let idx = Math.round(f * (ENV_N - 1));
    idx = Math.max(0, Math.min(ENV_N - 1, idx));
    const t = [0, 1, 3, 6][brushSize] ?? 1;       // strip thickness for this level
    setEnvColors((prev) => {
      const next = prev.slice();
      const from = lastIdx.current < 0 ? idx : lastIdx.current;
      const lo = Math.max(0, Math.min(from, idx) - t);
      const hi = Math.min(ENV_N - 1, Math.max(from, idx) + t);
      for (let i = lo; i <= hi; i++) next[i] = activeColor;
      return next;
    });
    lastIdx.current = idx;
  };
  return (
    <div ref={ref}
      onPointerDown={(e) => { e.preventDefault(); painting.current = true; lastIdx.current = -1;
        e.currentTarget.setPointerCapture(e.pointerId); paintAt(e.clientY); }}
      onPointerMove={(e) => { if (painting.current) paintAt(e.clientY); }}
      onPointerUp={() => { painting.current = false; lastIdx.current = -1; }}
      onPointerCancel={() => { painting.current = false; lastIdx.current = -1; }}
      style={{ display: "flex", flexDirection: "column", height, width: "100%",
        borderRadius: 8, overflow: "hidden", border: "1px solid #26313c",
        cursor: "crosshair", touchAction: "none" }}>
      {envColors.slice().reverse().map((c, i) => (
        <div key={i} style={{ flex: 1, background: c }} />
      ))}
    </div>
  );
}

function PaintGrid2D({ env2d, setEnv2d, activeColor, onStrokeEnd, brushSize, brushShape }) {
  const cvRef = useRef(null);
  const wrapRef = useRef(null);
  const painting = useRef(false);
  const { w, h } = env2d;
  const R = [1, 4, 8, 14][brushSize] ?? 4; // brush radius in cells

  // paint the cells onto the backing canvas (1 px per cell, CSS scales it up)
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let r = 0; r < h; r++) {
      const drow = h - 1 - r;                 // canvas top = sky (row h-1)
      for (let c = 0; c < w; c++) {
        const col = d3.rgb(env2d.cells[r * w + c]);
        const p = (drow * w + c) * 4;
        img.data[p] = col.r; img.data[p + 1] = col.g; img.data[p + 2] = col.b; img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [env2d, w, h]);

  const paintAt = (cx, cy) => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const col = Math.floor(((cx - r.left) / r.width) * w);
    const row = Math.floor((1 - (cy - r.top) / r.height) * h); // 0 = waterline
    if (col < -R - 1 || col > w + R || row < -R - 1 || row > h + R) return;
    const rr2 = (R + 0.5) * (R + 0.5);
    setEnv2d((prev) => {
      const nc = prev.cells.slice();
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (brushShape === "round" && dx * dx + dy * dy > rr2) continue;
        if (brushShape === "diamond" && Math.abs(dx) + Math.abs(dy) > R) continue;
        const c = col + dx, rw = row + dy;
        if (c >= 0 && c < w && rw >= 0 && rw < h) nc[rw * w + c] = activeColor;
      }
      return { ...prev, cells: nc };
    });
  };

  return (
    <div ref={wrapRef}
      onPointerDown={(e) => { e.preventDefault(); painting.current = true;
        e.currentTarget.setPointerCapture(e.pointerId); paintAt(e.clientX, e.clientY); }}
      onPointerMove={(e) => { if (painting.current) paintAt(e.clientX, e.clientY); }}
      onPointerUp={() => { if (painting.current) { painting.current = false; onStrokeEnd && onStrokeEnd(); } }}
      onPointerCancel={() => { painting.current = false; }}
      style={{ width: "100%", aspectRatio: `${w} / ${h}`, borderRadius: 8, overflow: "hidden",
        border: "1px solid #26313c", cursor: "crosshair", touchAction: "none", lineHeight: 0 }}>
      <canvas ref={cvRef}
        style={{ width: "100%", height: "100%", display: "block", imageRendering: "auto" }} />
    </div>
  );
}

function EmitterCard({ em, idx, halfW, yFar, onChange, onRemove }) {
  const types = [["point", "Point"], ["rings", "Rings"], ["swell", "Swell"], ["spectrum", "Spectrum"]];
  return (
    <div style={{ border: "1px solid #26313c", borderRadius: 9, padding: 11,
      marginBottom: 10, background: "#121922" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 10.5, letterSpacing: 1, color: "#6f8294", flex: 1,
          fontFamily: "ui-monospace, monospace" }}>EMITTER {idx + 1}</span>
        <button onClick={() => onChange({ on: !em.on })}
          style={{ fontSize: 10.5, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
            fontFamily: "ui-monospace, monospace",
            background: em.on ? "#27424b" : "#1a232c", color: em.on ? "#dff1f6" : "#7f93a4",
            border: "1px solid " + (em.on ? "#3f7e8f" : "#26313c") }}>
          {em.on ? "on" : "off"}
        </button>
        <button onClick={onRemove}
          style={{ fontSize: 12, width: 26, height: 26, borderRadius: 6, cursor: "pointer",
            background: "#1a232c", color: "#9a6a6a", border: "1px solid #3a2a2a" }}>✕</button>
      </div>
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {types.map(([tp, label]) => (
          <button key={tp} onClick={() => onChange({ type: tp })}
            style={{ flex: 1, padding: "6px 4px", fontSize: 11, borderRadius: 6, cursor: "pointer",
              fontFamily: "ui-monospace, monospace",
              background: em.type === tp ? "#27424b" : "#1a232c",
              color: em.type === tp ? "#dff1f6" : "#9fb0c0",
              border: "1px solid " + (em.type === tp ? "#3f7e8f" : "#26313c") }}>{label}</button>
        ))}
      </div>

      {em.type === "point" && <>
        <Slider label="x" value={em.x} min={-halfW} max={halfW} step={0.5} onChange={(v) => onChange({ x: v })} />
        <Slider label="y (distance)" value={em.y} min={3} max={yFar} step={0.5} onChange={(v) => onChange({ y: v })} />
      </>}

      {(em.type === "swell" || em.type === "spectrum") &&
        <Slider label={em.type === "spectrum" ? "wind heading" : "heading"} value={em.dir}
          min={0} max={360} step={5} onChange={(v) => onChange({ dir: v })} fmt={(v) => v + "°"} />}

      {em.type === "spectrum" && <>
        <Slider label="direction spread" value={em.spread} min={0} max={80} step={1}
          onChange={(v) => onChange({ spread: v })} fmt={(v) => v + "°"} />
        <Slider label="roughness (chop)" value={em.roughness} min={0} max={1} step={0.02}
          onChange={(v) => onChange({ roughness: v })}
          fmt={(v) => (v < 0.25 ? "glassy" : v < 0.55 ? "rippled" : v < 0.8 ? "choppy" : "rough")} />
        <Slider label="detail (waves)" value={em.detail} min={4} max={40} step={1}
          onChange={(v) => onChange({ detail: v })} />
      </>}

      {em.type === "rings" && <>
        <Slider label="count (ripple sources)" value={em.detail} min={2} max={18} step={1}
          onChange={(v) => onChange({ detail: v })} />
        <Slider label="wavelength variation" value={em.roughness} min={0} max={1} step={0.02}
          onChange={(v) => onChange({ roughness: v })}
          fmt={(v) => (v < 0.2 ? "uniform" : v < 0.6 ? "varied" : "random")} />
      </>}

      <Slider label={em.type === "spectrum" ? "dominant wavelength" : "wavelength"} value={em.size}
        min={0.3} max={5} step={0.1} onChange={(v) => onChange({ size: v })} fmt={(v) => v.toFixed(1) + "×"} />
      <Slider label="strength" value={em.amp} min={0} max={2} step={0.05}
        onChange={(v) => onChange({ amp: v })} fmt={(v) => v.toFixed(2)} />
    </div>
  );
}

// read-only mini render of a panorama (used to show what the water reflects)
function EnvPreview({ env }) {
  const cvRef = useRef(null);
  useEffect(() => {
    const cv = cvRef.current; if (!cv || !env) return;
    const { w, h, cells } = env;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext("2d");
    if (!ctx) return;                         // jsdom (tests) has no 2D canvas
    const img = ctx.createImageData(w, h);
    for (let r = 0; r < h; r++) {
      const drow = h - 1 - r;                 // canvas top = sky
      for (let c = 0; c < w; c++) {
        const col = d3.rgb(cells[r * w + c]);
        const p = (drow * w + c) * 4;
        img.data[p] = col.r; img.data[p + 1] = col.g; img.data[p + 2] = col.b; img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [env]);
  if (!env) return null;
  return (
    <canvas ref={cvRef} style={{ width: "100%", aspectRatio: `${env.w} / ${env.h * 0.6}`,
      borderRadius: 8, border: "1px solid #26313c", display: "block" }} />
  );
}

function ObjectCard({ obj, idx, azSpan, eLo, eHi, onChange, onRemove }) {
  const types = [["sailboat", "Sailboat"], ["dock", "Dock"], ["buoy", "Buoy"], ["post", "Post"]];
  const labels = OBJECT_SHAPES[obj.type].label;
  return (
    <div style={{ border: "1px solid #26313c", borderRadius: 9, padding: 11,
      marginBottom: 10, background: "#121922" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 10.5, letterSpacing: 1, color: "#6f8294", flex: 1,
          fontFamily: "ui-monospace, monospace" }}>OBJECT {idx + 1}</span>
        <button onClick={() => onChange({ on: !obj.on })}
          style={{ fontSize: 10.5, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
            fontFamily: "ui-monospace, monospace",
            background: obj.on ? "#27424b" : "#1a232c", color: obj.on ? "#dff1f6" : "#7f93a4",
            border: "1px solid " + (obj.on ? "#3f7e8f" : "#26313c") }}>
          {obj.on ? "on" : "off"}
        </button>
        <button onClick={onRemove}
          style={{ fontSize: 12, width: 26, height: 26, borderRadius: 6, cursor: "pointer",
            background: "#1a232c", color: "#9a6a6a", border: "1px solid #3a2a2a" }}>✕</button>
      </div>
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {types.map(([tp, label]) => (
          <button key={tp} onClick={() => onChange({ type: tp })}
            style={{ flex: 1, padding: "6px 4px", fontSize: 11, borderRadius: 6, cursor: "pointer",
              fontFamily: "ui-monospace, monospace",
              background: obj.type === tp ? "#27424b" : "#1a232c",
              color: obj.type === tp ? "#dff1f6" : "#9fb0c0",
              border: "1px solid " + (obj.type === tp ? "#3f7e8f" : "#26313c") }}>{label}</button>
        ))}
      </div>
      <Slider label="position ← → (azimuth)" value={obj.az} min={-azSpan + 2} max={azSpan - 2}
        step={1} onChange={(v) => onChange({ az: v })}
        fmt={(v) => (v === 0 ? "center" : v + "°")} />
      <Slider label="apparent height" value={obj.size} min={1.5}
        max={Math.max(4, (eHi - eLo) * 0.8)} step={0.5}
        onChange={(v) => onChange({ size: v })} fmt={(v) => v.toFixed(1) + "°"} />
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 2 }}>
        {[["color", labels[0]], ["color2", labels[1]]].map(([k, lbl]) => (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5,
            color: "#9fb0c0", fontFamily: "ui-monospace, monospace", cursor: "pointer" }}>
            <span style={{ width: 24, height: 24, borderRadius: 5, background: obj[k],
              border: "1px solid #44525e", position: "relative", overflow: "hidden",
              display: "inline-block" }}>
              <input type="color" value={obj[k]} onChange={(e) => onChange({ [k]: e.target.value })}
                style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
            </span>
            {lbl}
          </label>
        ))}
      </div>
    </div>
  );
}

function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export default function App() {
  const width = useWidth();
  const isNarrow = width < 820;

  const [steep, setSteep] = useState(1); // shows as a 72° view angle at the near edge
  const [pitchDeg, setPitchDeg] = useState(12.6); // 0.22 rad, the old fixed value
  const [rollDeg, setRollDeg] = useState(0);
  const [fresOn, setFresOn] = useState(false);
  const [fresBands, setFresBands] = useState(3);
  const [fresStrength, setFresStrength] = useState(0.75);
  const [deepColor, setDeepColor] = useState("#08131d");
  const [wavelength, setWavelength] = useState(2.8);
  const [strength, setStrength] = useState(0.78);
  const [sharp, setSharp] = useState(0.3);   // crest sharpening (2nd harmonic)
  const [spread, setSpread] = useState(0.5);
  const [bands, setBands] = useState(9);
  const [palette, setPalette] = useState("Sunset Lake");
  const [perspective, setPerspective] = useState(true);
  const [rectOutput, setRectOutput] = useState(false);
  const [surface3d, setSurface3d] = useState(true); // lift color regions onto the waves
  const [waveScale, setWaveScale] = useState(8);     // 3D wave-height exaggeration
  const [edges, setEdges] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [manualTime, setManualTime] = useState(0); // scrub the wave phase when not animating
  const [lowPower, setLowPower] = useState(false);  // cap resolution + throttle animation
  const [quality, setQuality] = useState(() =>
    (typeof window !== "undefined" && window.innerWidth < 820) ? 100 : 140);
  const [advanced, setAdvanced] = useState(false);

  const [emitters, setEmitters] = useState(DEFAULT_EMITTERS);
  const updateEmitter = (id, patch) =>
    setEmitters((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const addEmitter = () =>
    setEmitters((es) => es.length >= 5 ? es :
      [...es, { id: es.reduce((m, e) => Math.max(m, e.id), 0) + 1, on: true, type: "rings",
        x: 0, y: 20, dir: 90, size: 1.0, amp: 0.8, spread: 25, roughness: 0.45, detail: 10 }]);
  const removeEmitter = (id) => setEmitters((es) => es.filter((e) => e.id !== id));
  const [halfW, setHalfW] = useState(22); // 44 units across
  const [yNear, setYNear] = useState(3);
  const [yFar, setYFar] = useState(78);
  const [reflMag, setReflMag] = useState(1); // reflection detail (angular zoom)

  // reflected objects: stamped into the environment panorama across the
  // water, so only their reflection appears in the frame
  const [objects, setObjects] = useState([
    { id: 1, on: true, type: "sailboat", az: 14, size: 8, color: "#c2521f", color2: "#efe9d9" },
  ]);
  const updateObject = (id, patch) =>
    setObjects((os) => os.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const addObject = () =>
    setObjects((os) => os.length >= 4 ? os :
      [...os, { id: os.reduce((m, o) => Math.max(m, o.id), 0) + 1, on: true, type: "buoy",
        az: -12, size: 4, color: "#241a12", color2: "#d64127" }]);
  const removeObject = (id) => setObjects((os) => os.filter((o) => o.id !== id));

  const [eLo, setELo] = useState(-5), [eHi, setEHi] = useState(33);
  const [autoFit, setAutoFit] = useState(false);
  const [penMode, setPenMode] = useState(false);
  const [penCount, setPenCount] = useState(48);   // number of scan lines
  const [penRelief, setPenRelief] = useState(45);  // 3D height exaggeration
  const [penWidth, setPenWidth] = useState(1.4);   // stroke width (all equal)
  const [penHidden, setPenHidden] = useState(true); // hidden-line removal
  const [penStyle, setPenStyle] = useState("lines"); // "lines" | "rings"
  const [penSpacing, setPenSpacing] = useState(7);   // ring spacing (cells)
  const [penEven, setPenEven] = useState(false);     // even spacing on screen
  const [bgColor, setBgColor] = useState("");       // "" = auto

  const [zoom, setZoom] = useState(5);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [smooth, setSmooth] = useState(3);
  const [mode, setMode] = useState("preset"); // "preset" | "paint1d" | "paint2d"
  const [envColors, setEnvColors] = useState(() => seedEnv("Sunset Lake", ENV_N));
  // photo -> palette: downscaled pixels kept in a ref so changing the color
  // count re-extracts without re-reading the file
  const photoRef = useRef(null);
  const photoFileRef = useRef(null);
  const [photoK, setPhotoK] = useState(5);
  const [photoInfo, setPhotoInfo] = useState(null); // { name, swatches } | { error }
  const [env2d, setEnv2d] = useState(() => seedEnv2D("Sunset Lake", ENV2D_W, ENV2D_H));
  const [segEnv, setSegEnv] = useState(env2d);          // committed copy that drives the water
  const env2dRef = useRef(env2d); env2dRef.current = env2d;
  const [azSpan, setAzSpan] = useState(45);
  // 0 = no de-jitter blur of the reflected-direction fields, so the 2D path
  // keeps the same per-ripple detail as the 1D path out of the box
  const [coherence, setCoherence] = useState(0);
  const [activeColor, setActiveColor] = useState("#11324a");
  const [brushSize, setBrushSize] = useState(1);       // radius in cells
  const [brushShape, setBrushShape] = useState("round"); // round | square | diamond
  const [svgOut, setSvgOut] = useState(null);
  const [svgName, setSvgName] = useState("reflection-regions.svg");
  const [stackInfo, setStackInfo] = useState(null); // { nSheets } when a paper stack is exported
  const [copied, setCopied] = useState(false);

  // Serialize every studio setting into the URL hash (the painted 1D/2D
  // environment buffers are excluded — they are freehand pixel data, not
  // controls, and would blow the URL length budget). Structured config
  // like the emitter and object lists round-trips as-is.
  useUrlSync("reflection", {
    steep: [steep, setSteep], pitchDeg: [pitchDeg, setPitchDeg], rollDeg: [rollDeg, setRollDeg],
    fresOn: [fresOn, setFresOn], fresBands: [fresBands, setFresBands],
    fresStrength: [fresStrength, setFresStrength], deepColor: [deepColor, setDeepColor],
    wavelength: [wavelength, setWavelength], strength: [strength, setStrength],
    sharp: [sharp, setSharp], spread: [spread, setSpread], bands: [bands, setBands],
    palette: [palette, setPalette], perspective: [perspective, setPerspective],
    rectOutput: [rectOutput, setRectOutput], surface3d: [surface3d, setSurface3d],
    waveScale: [waveScale, setWaveScale], edges: [edges, setEdges],
    animate: [animate, setAnimate], speed: [speed, setSpeed], quality: [quality, setQuality],
    manualTime: [manualTime, setManualTime], lowPower: [lowPower, setLowPower],
    advanced: [advanced, setAdvanced], emitters: [emitters, setEmitters],
    halfW: [halfW, setHalfW], yNear: [yNear, setYNear], yFar: [yFar, setYFar],
    reflMag: [reflMag, setReflMag], objects: [objects, setObjects],
    eLo: [eLo, setELo], eHi: [eHi, setEHi], autoFit: [autoFit, setAutoFit],
    penMode: [penMode, setPenMode], penCount: [penCount, setPenCount],
    penRelief: [penRelief, setPenRelief], penWidth: [penWidth, setPenWidth],
    penHidden: [penHidden, setPenHidden], penStyle: [penStyle, setPenStyle],
    penSpacing: [penSpacing, setPenSpacing], penEven: [penEven, setPenEven],
    bgColor: [bgColor, setBgColor], zoom: [zoom, setZoom], panX: [panX, setPanX],
    panY: [panY, setPanY], smooth: [smooth, setSmooth], mode: [mode, setMode],
    envColors: [envColors, setEnvColors],
    azSpan: [azSpan, setAzSpan], coherence: [coherence, setCoherence],
    activeColor: [activeColor, setActiveColor], brushSize: [brushSize, setBrushSize],
    brushShape: [brushShape, setBrushShape],
  });

  const enter1d = () => { setEnvColors(seedEnv(palette, ENV_N)); setMode("paint1d"); };

  // photo -> palette: quantize the photo to a few dominant colors and lift
  // its top-to-bottom color profile into the paint-1D strip (top of the
  // photo = far water = horizon). Runs fully client-side on a downscaled copy.
  const applyPhoto = (img, k, name) => {
    const res = extractPhotoStrip(img, k, ENV_N);
    if (!res) { setPhotoInfo({ error: "Couldn't read that image." }); return; }
    setEnvColors(res.strip);
    setDeepColor(res.deep);
    setMode("paint1d");
    setPhotoInfo({ name, swatches: res.swatches });
  };
  const loadPhotoFile = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 128 / Math.max(im.width, im.height));
      const w = Math.max(1, Math.round(im.width * scale));
      const h = Math.max(1, Math.round(im.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      photoRef.current = { img, name: file.name };
      applyPhoto(img, photoK, file.name);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      setPhotoInfo({ error: "Couldn't decode that image — HEIC photos may need converting to JPEG first." });
    };
    im.src = url;
  };
  const enter2d = () => {
    const seeded = seedEnv2D(palette, ENV2D_W, ENV2D_H);
    setEnv2d(seeded); setSegEnv(seeded); setMode("paint2d");
  };

  // camera interaction: drag the preview to pan, scroll to zoom (anchored at
  // the cursor). Toggleable so touch users can still scroll past the preview.
  const previewRef = useRef(null);
  const dragRef = useRef(null);
  const [camDrag, setCamDrag] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 820);
  const camRef = useRef({ panX: 0, panY: 0, zoom: 1 });
  camRef.current = { panX, panY, zoom };
  // pan is in half-viewport units, so the shift needed to reach the scene's
  // edge grows with zoom — a fixed clamp would silently recenter an anchored
  // zoom toward the scene center. Scale the clamp with the zoom level.
  const clampPan = (v, z = camRef.current.zoom) => {
    const m = Math.max(2.5, 1.2 * z + 0.5);
    return Math.max(-m, Math.min(m, v));
  };
  const resetCamera = () => { setZoom(1); setPanX(0); setPanY(0); };

  useEffect(() => {
    const el = previewRef.current;
    if (!el || !camDrag) return;
    // native listener: React registers wheel as passive, so preventDefault
    // (needed to stop the page scrolling) only works this way
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const { panX: px, panY: py, zoom: z } = camRef.current;
      const z2 = Math.max(1, Math.min(30, z * Math.exp(-e.deltaY * 0.0016)));
      const k = z2 / z;
      if (k === 1) return;
      const ocx = ((e.clientX - r.left) / r.width - 0.5) * 2;  // -1..1 across
      const ocy = ((e.clientY - r.top) / r.height - 0.5) * 2;
      setZoom(z2);
      setPanX(clampPan(px + (1 - k) * (ocx - px), z2));
      setPanY(clampPan(py + (1 - k) * (ocy - py), z2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [camDrag]);

  const camPointer = camDrag ? {
    onPointerDown: (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY,
        panX: camRef.current.panX, panY: camRef.current.panY };
    },
    onPointerMove: (e) => {
      const d = dragRef.current;
      if (!d) return;
      const r = e.currentTarget.getBoundingClientRect();
      setPanX(clampPan(d.panX + (2 * (e.clientX - d.x)) / r.width));
      setPanY(clampPan(d.panY + (2 * (e.clientY - d.y)) / r.height));
    },
    onPointerUp: () => { dragRef.current = null; },
    onPointerCancel: () => { dragRef.current = null; },
    onDoubleClick: resetCamera,
  } : {};

  const tRef = useRef(0);
  const [, force] = useState(0);
  useEffect(() => {
    if (!animate) return;
    let raf, last = 0;
    // Low power caps the loop to ~15fps: fewer full recomputes of the water
    // field per second is the single biggest battery saving while animating.
    const minDelta = lowPower ? 66 : 0;
    const loop = (ts) => {
      raf = requestAnimationFrame(loop);
      if (ts - last < minDelta) return;
      last = ts;
      tRef.current += 0.12 * speed;
      force((n) => n + 1);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate, speed, lowPower]);

  // banded palette stops / painted-strip runs -> non-uniform band boundaries
  const stops = useMemo(() => paletteStops(palette), [palette]);
  const runs1d = useMemo(() => (mode === "paint1d" ? envRuns(envColors) : null),
    [mode, envColors]);
  const bandFractions = useMemo(() => {
    if (mode === "preset" && stops) return stops.slice(1).map((s) => s.f0);
    if (runs1d) return runs1d.fracs;
    return null;
  }, [mode, stops, runs1d]);

  // Low power renders on a coarser grid, so every redraw (each pan, zoom, or
  // animation frame) does far less contour work.
  const effQuality = lowPower ? Math.min(quality, 70) : quality;

  const S = useMemo(() => ({
    nx: effQuality, ny: effQuality,
    xMin: -halfW, xMax: halfW, yMin: Math.min(yNear, yFar - 2), yMax: yFar,
    H: 0.4 * Math.pow(22.5, steep),
    pitch: (pitchDeg * Math.PI) / 180,
    k: (2 * Math.PI) / wavelength,
    amp: strength * 0.06,
    sharp,
    decay: 0.18 - spread * 0.16,
    omega: 1.0,
    t: animate ? tRef.current : manualTime,
    bands, perspective, eLo, eHi, zoom, panX, panY, smooth, coherence, rectOutput,
    surface3d, waveScale, bandFractions, fresOn, fresBands, reflMag,
    emitters,
  }), [effQuality, steep, pitchDeg, wavelength, strength, sharp, spread, bands, perspective,
       halfW, yNear, yFar, eLo, eHi, zoom, panX, panY, smooth, coherence, rectOutput, surface3d, waveScale,
       bandFractions, fresOn, fresBands, reflMag,
       emitters, animate, speed, tRef.current, manualTime]);

  const is2d = mode === "paint2d";
  const presetColors = useMemo(
    () => (stops ? stops.map((s) => s.c) : bandColors(bands, palette)),
    [stops, bands, palette]);
  const colors1d = runs1d ? runs1d.colors : null;

  // any live reflected object forces the 2D (panorama) path in every mode:
  // the segmentation sees the painted panorama, or stripe rows derived from
  // the preset / 1D strip, with the objects stamped on top
  const objectsOn = objects.some((o) => o.on);
  const use2d = is2d || objectsOn;
  const baseEnv2d = useMemo(() => {
    if (is2d) return segEnv;
    if (!objectsOn) return null;
    if (mode === "paint1d")
      return envFromRows((f) => envColors[Math.min(ENV_N - 1, Math.floor(f * ENV_N))],
        ENV2D_W, DERIVED_ENV_H);
    if (stops) return envFromRows((f) => paletteColorAt(palette, f), ENV2D_W, DERIVED_ENV_H);
    const NB = presetColors.length;
    return envFromRows((f) => presetColors[Math.min(NB - 1, Math.floor(f * NB))],
      ENV2D_W, DERIVED_ENV_H);
  }, [is2d, segEnv, objectsOn, mode, envColors, stops, palette, presetColors]);
  const envEffective = useMemo(
    () => (use2d ? stampObjects(baseEnv2d, objects, azSpan, eLo, eHi) : null),
    [use2d, baseEnv2d, objects, azSpan, eLo, eHi]);

  const geom = useMemo(() => (use2d ? null : buildGeometry(S)), [use2d, S]);
  const seg = useMemo(() => (use2d ? buildSegmentation(S, envEffective, azSpan) : null),
    [use2d, S, envEffective, azSpan]);

  const isobandColors = mode === "paint1d" ? colors1d : presetColors;
  const bg = use2d ? seg.bg : isobandColors[0];
  const autoBg = penMode ? "#0a0d12" : bg;
  const bgFill = bgColor || autoBg;
  const layers = use2d ? (seg.layers || null)
    : geom.ds.map((d, k) => ({ d, color: isobandColors[k + 1] }));
  const rng = use2d ? seg : geom;

  // Fresnel depth bands: clip paths + the color mixer for each band
  const mixDeep = useMemo(
    () => (fresOn ? makeDeepMixer(deepColor, fresStrength, fresBands) : (c) => c),
    [fresOn, deepColor, fresStrength, fresBands]);
  const fresPaths = fresOn ? (use2d ? seg.fres : geom.fres) : null;
  const fresIdx = useMemo(
    () => (fresOn && fresPaths ? d3.range(fresBands) : [0]),
    [fresOn, fresPaths, fresBands]);
  const rollTf = rollTransform(rollDeg);

  const regionCount = (use2d ? seg.count : layers.length + 1) * fresIdx.length;

  // pen-plot lines: equally spaced scan lines colored by the reflection beneath
  const penLines = useMemo(() => {
    if (!penMode) return null;
    const fit = computeFit(S);
    const mag = S.reflMag || 1;
    S._ems = S.emitters.filter((e) => e.on).map((e) => prepEmitter(e, S));
    const deepMix = (c, cosI) => {
      if (!fresOn) return c;
      const b = Math.min(fresBands - 1, Math.floor(fresnelDeepW(cosI) * fresBands));
      return mixDeep(c, b);
    };
    let colorAt;
    if (use2d) {
      const { w: EW, h: EH, cells } = envEffective;
      const az = azSpan;
      colorAt = (gx, gy) => {
        const R = reflectAt(gx, gy, S);
        const phi = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
        let psi = Math.atan2(R[0], R[1]) * 180 / Math.PI; psi = psi < -az ? -az : psi > az ? az : psi;
        let v = magFrac((phi - S.eLo) / ((S.eHi - S.eLo) || 1), mag); v = v < 0 ? 0 : v > 1 ? 1 : v;
        let u = magFrac((psi + az) / (2 * az), mag); u = u < 0 ? 0 : u > 1 ? 1 : u;
        const c = cells[Math.min(EH - 1, Math.floor(v * EH)) * EW + Math.min(EW - 1, Math.floor(u * EW))];
        return deepMix(c, R[3]);
      };
    } else {
      const cols = mode === "paint1d" ? colors1d : presetColors;
      const NB = cols.length;
      const fr = S.bandFractions;
      colorAt = (gx, gy) => {
        const R = reflectAt(gx, gy, S);
        const phi = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
        let v = magFrac((phi - S.eLo) / ((S.eHi - S.eLo) || 1), mag); v = v < 0 ? 0 : v >= 1 ? 0.999999 : v;
        let c;
        if (fr) {
          let idx = 0;
          for (const f of fr) { if (v >= f) idx++; else break; }
          c = cols[idx] || cols[0];
        } else c = cols[Math.floor(v * NB)] || cols[0];
        return deepMix(c, R[3]);
      };
    }
    const threeD = S.perspective && penRelief > 0;
    if (penStyle === "rings") {
      return buildPenConcentric(S, fit, colorAt, {
        spacing: penSpacing, relief: penRelief, threeD, hidden: penHidden,
      });
    }
    return buildPenLines(S, fit, colorAt, {
      nLines: penCount, samples: penHidden ? 360 : 260, relief: penRelief,
      threeD, hidden: penHidden, evenScreen: penEven,
    });
  }, [penMode, penStyle, penCount, penSpacing, penRelief, penHidden, penEven, S, use2d, mode,
      envEffective, azSpan, colors1d, presetColors, fresOn, fresBands, mixDeep]);


  // auto-fit the elevation range to the actual reflected φ, so steep/near water
  // never silently clamps to one band. φ min/max don't depend on eLo/eHi, so
  // this settles in a single step (no feedback loop).
  useEffect(() => {
    if (!autoFit) return;
    const lo = Math.floor(rng.lo);
    const hi = Math.max(Math.ceil(rng.hi), lo + 1);
    if (lo !== eLo) setELo(lo);
    if (hi !== eHi) setEHi(hi);
  }, [autoFit, rng.lo, rng.hi, eLo, eHi]);

  const buildSvg = () => {
    const rollOpen = rollTf ? `<g transform="${rollTf}">` : `<g>`;
    if (penMode) {
      let body = `<rect width="${VB_W}" height="${VB_H}" fill="${bgFill}"/>` + rollOpen;
      penLines.forEach((l) => {
        body += `<path d="${l.d}" fill="none" stroke="${l.color}" stroke-width="${penWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
      });
      body += `</g>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${body}</svg>`;
    }
    let body = `<rect width="${VB_W}" height="${VB_H}" fill="${bgFill}"/>` + rollOpen;
    const stroke = edges ? ` stroke="#000" stroke-opacity="0.25" stroke-width="0.6"` : "";
    let defs = "";
    if (fresOn && fresPaths) fresPaths.forEach((d, i) => {
      if (d) defs += `<clipPath id="fres${i + 1}"><path d="${d}"/></clipPath>`;
    });
    const bandOpen = (b) => (b > 0 ? `<g clip-path="url(#fres${b})">` : `<g>`);
    if (use2d && !seg.layers) {
      seg.rows.forEach((row, ri) => {
        if (row.clip) defs += `<clipPath id="el${ri}"><path d="${row.clip}"/></clipPath>`;
      });
      fresIdx.forEach((b) => {
        if (b > 0 && !fresPaths[b - 1]) return;
        body += bandOpen(b);
        seg.rows.forEach((row, ri) => {
          let g = row.clip ? `<g clip-path="url(#el${ri})">` : `<g>`;
          if (row.base) g += `<rect width="${VB_W}" height="${VB_H}" fill="${mixDeep(row.base, b)}"/>`;
          row.az.forEach((a) => { g += `<path d="${a.d}" fill="${mixDeep(a.color, b)}" fill-rule="evenodd"${stroke}/>`; });
          if (edges && row.clip) g += `<path d="${row.clip}" fill="none"${stroke}/>`;
          g += `</g>`;
          body += g;
        });
        body += `</g>`;
      });
      body += `</g>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}"><defs>${defs}</defs>${body}</svg>`;
    }
    // layered paths, preset & 2D alike. With Fresnel on, the geometry is
    // shared via <use> so each depth band re-colors the same paths.
    if (use2d) defs += `<clipPath id="watertrap"><path d="${seg.clip}"/></clipPath>`;
    if (fresOn) layers.forEach((l, i) => { defs += `<path id="lyr${i}" d="${l.d}"/>`; });
    // in 3D the waves rise above the flat water trapezoid, so skip the clip
    // (the padded regions already overshoot the frame) — otherwise crests
    // near the edges would be sheared off flat
    body += use2d && !surface3d
      ? `<g clip-path="url(#watertrap)" opacity="0.999">` : `<g opacity="0.999">`;
    fresIdx.forEach((b) => {
      if (b > 0 && !fresPaths[b - 1]) return;
      body += bandOpen(b);
      if (b > 0) body += `<rect width="${VB_W}" height="${VB_H}" fill="${mixDeep(bg, b)}"/>`;
      layers.forEach((l, i) => {
        body += fresOn
          ? `<use href="#lyr${i}" fill="${mixDeep(l.color, b)}" fill-rule="evenodd"${stroke}/>`
          : `<path d="${l.d}" fill="${l.color}" fill-rule="evenodd"${stroke}/>`;
      });
      body += `</g>`;
    });
    body += `</g></g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
  };
  const saveSvg = (svg, name) => {
    try {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { /* sandbox may block downloads */ }
  };
  const downloadSVG = () => {
    const svg = buildSvg();
    saveSvg(svg, "reflection-regions.svg");
    setSvgName("reflection-regions.svg");
    setStackInfo(null);
    setSvgOut(svg); // always show a reliable copy fallback
  };

  // build the sample-grid color used by the layered-paper decomposition — the
  // same field the renderer bands/segments, one value per cell.
  const paperColorGrid = () => {
    S._ems = S.emitters.filter((e) => e.on).map((e) => prepEmitter(e, S));
    const { nx, ny } = S;
    const mag = S.reflMag || 1;
    const grid = new Int32Array(nx * ny);
    const deepMix = (c, cosI) => {
      if (!fresOn) return c;
      const b = Math.min(fresBands - 1, Math.floor(fresnelDeepW(cosI) * fresBands));
      return mixDeep(c, b);
    };
    const idOf = new Map(), palette = [];
    const idFor = (c) => {
      let id = idOf.get(c);
      if (id === undefined) { id = palette.length; idOf.set(c, id); palette.push(c); }
      return id;
    };
    if (use2d) {
      const { w: EW, h: EH, cells } = envEffective, az = azSpan;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const [gx, gy] = cell2ground(i + 0.5, j + 0.5, S);
          const R = reflectAt(gx, gy, S);
          const phi = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
          let psi = Math.atan2(R[0], R[1]) * 180 / Math.PI; psi = psi < -az ? -az : psi > az ? az : psi;
          let v = magFrac((phi - S.eLo) / ((S.eHi - S.eLo) || 1), mag); v = v < 0 ? 0 : v > 1 ? 1 : v;
          let u = magFrac((psi + az) / (2 * az), mag); u = u < 0 ? 0 : u > 1 ? 1 : u;
          const c = cells[Math.min(EH - 1, Math.floor(v * EH)) * EW + Math.min(EW - 1, Math.floor(u * EW))];
          grid[j * nx + i] = idFor(deepMix(c, R[3]));
        }
      }
      return { grid, palette };
    }
    const cols = mode === "paint1d" ? colors1d : presetColors, NB = cols.length;
    const fr = S.bandFractions;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const [gx, gy] = cell2ground(i + 0.5, j + 0.5, S);
        const R = reflectAt(gx, gy, S);
        const phi = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
        let v = magFrac((phi - S.eLo) / ((S.eHi - S.eLo) || 1), mag); v = v < 0 ? 0 : v >= 1 ? 0.999999 : v;
        let c;
        if (fr) {
          let idx = 0;
          for (const f of fr) { if (v >= f) idx++; else break; }
          c = cols[idx] || cols[0];
        } else c = cols[Math.floor(v * NB)] || cols[0];
        grid[j * nx + i] = idFor(deepMix(c, R[3]));
      }
    }
    return { grid, palette };
  };

  const exportPaperStack = () => {
    const { grid, palette } = paperColorGrid();
    const stack = buildPaperStack(S, grid, palette, bgFill);
    const svg = buildPaperStackSvg(stack, rollTf);
    saveSvg(svg, "reflection-paper-stack.svg");
    setSvgName("reflection-paper-stack.svg");
    setStackInfo({ nSheets: stack.nSheets, method: stack.method });
    setSvgOut(svg);
  };
  const copySvg = () => {
    if (svgOut && navigator.clipboard) {
      navigator.clipboard.writeText(svgOut).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
    }
  };

  const panel = {
    background: "#151c24", border: "1px solid #232d38", borderRadius: 12,
    padding: 16, marginBottom: 14,
  };
  const heading = {
    fontSize: 10.5, letterSpacing: 1.6, textTransform: "uppercase",
    color: "#6f8294", marginBottom: 12, fontFamily: "ui-monospace, monospace",
  };
  const miniBtn = {
    flex: 1, padding: "8px 4px", fontSize: 11, borderRadius: 6, cursor: "pointer",
    background: "#1a232c", color: "#9fb0c0", border: "1px solid #26313c",
    fontFamily: "ui-monospace, monospace",
  };
  const brushBtn = (on) => ({
    width: 30, height: 30, padding: 0, borderRadius: 6, cursor: "pointer", fontSize: 13,
    fontFamily: "ui-monospace, monospace", lineHeight: 1,
    background: on ? "#27424b" : "#1a232c", color: on ? "#dff1f6" : "#9fb0c0",
    border: "1px solid " + (on ? "#3f7e8f" : "#26313c"),
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0b0f14", color: "#e6eef5",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      padding: isNarrow ? "16px 12px 50px" : "22px 16px 60px" }}>
      <style>{`
        input[type=range]{ -webkit-appearance:none; appearance:none; background:transparent; touch-action:pan-y; }
        input[type=range]::-webkit-slider-runnable-track{ height:5px; border-radius:3px; background:#2a3640; }
        input[type=range]::-moz-range-track{ height:5px; border-radius:3px; background:#2a3640; }
        input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:24px; height:24px; border-radius:50%; background:#5fb6c9; margin-top:-10px; box-shadow:0 1px 4px rgba(0,0,0,.6); }
        input[type=range]::-moz-range-thumb{ width:24px; height:24px; border:none; border-radius:50%; background:#5fb6c9; box-shadow:0 1px 4px rgba(0,0,0,.6); }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ marginBottom: isNarrow ? 12 : 18 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "#5f7384",
            fontFamily: "ui-monospace, monospace" }}>SCALAR FIELD · φ = REFLECTED ELEVATION</div>
          <h1 style={{ fontSize: isNarrow ? 21 : 27, margin: "4px 0 4px", fontWeight: 600,
            fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: -0.2 }}>
            Reflection Region Studio
          </h1>
          {!isNarrow && (
            <p style={{ fontSize: 13.5, color: "#8a9bab", maxWidth: 620, lineHeight: 1.5, margin: 0 }}>
              The color blobs on rippled water are level sets of one field — the elevation
              angle each reflected ray ends up pointing at. Contour that field and you get
              the blobs as real vector regions, not pixels.
            </p>
          )}
        </header>

        <div style={{ display: isNarrow ? "block" : "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16, alignItems: "start" }}>

          {/* PREVIEW */}
          <div ref={previewRef} {...camPointer}
            style={{ background: "#05080b", borderRadius: 14, border: "1px solid #1b2530",
            overflow: "hidden", position: "sticky",
            top: isNarrow ? 8 : 22, zIndex: 5,
            marginBottom: isNarrow ? 14 : 0,
            touchAction: camDrag ? "none" : undefined,
            cursor: camDrag ? "grab" : undefined,
            boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }}>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ width: "100%", display: "block" }}>
              <rect width={VB_W} height={VB_H} fill={bgFill} />
              <g transform={rollTf || undefined}>
              {penMode ? (
                penLines.map((l, i) => (
                  <path key={i} d={l.d} fill="none" stroke={l.color}
                    strokeWidth={penWidth} strokeLinecap="round" strokeLinejoin="round" />
                ))
              ) : use2d && !layers ? (
                <>
                  <defs>
                    {seg.rows.map((row, ri) => row.clip ? (
                      <clipPath key={ri} id={`el${ri}`}><path d={row.clip} /></clipPath>
                    ) : null)}
                    {fresOn && fresPaths.map((d, i) => d ? (
                      <clipPath key={`f${i}`} id={`fres${i + 1}`}><path d={d} /></clipPath>
                    ) : null)}
                  </defs>
                  {fresIdx.map((b) => (b > 0 && !fresPaths[b - 1]) ? null : (
                    <g key={`fb${b}`} clipPath={b > 0 ? `url(#fres${b})` : undefined}>
                      {seg.rows.map((row, ri) => (
                        <g key={ri} clipPath={row.clip ? `url(#el${ri})` : undefined}>
                          {row.base && <rect width={VB_W} height={VB_H} fill={mixDeep(row.base, b)} />}
                          {row.az.map((a, ai) => (
                            <path key={ai} d={a.d} fill={mixDeep(a.color, b)} fillRule="evenodd" />
                          ))}
                          {edges && row.clip && (
                            <path d={row.clip} fill="none" stroke="#000" strokeOpacity={0.28} strokeWidth={0.6} />
                          )}
                        </g>
                      ))}
                    </g>
                  ))}
                </>
              ) : (
                <>
                  <defs>
                    {use2d && <clipPath id="watertrap"><path d={seg.clip} /></clipPath>}
                    {fresOn && fresPaths.map((d, i) => d ? (
                      <clipPath key={`f${i}`} id={`fres${i + 1}`}><path d={d} /></clipPath>
                    ) : null)}
                    {fresOn && layers.map((l, i) => (
                      <path key={i} id={`lyr${i}`} d={l.d} />
                    ))}
                  </defs>
                  {/* opacity forces the group into an isolated buffer, so the
                      clip is antialiased once against the composite instead of
                      per layer (per-layer clip AA leaks the colors beneath) */}
                  <g clipPath={use2d && !surface3d ? "url(#watertrap)" : undefined} opacity={0.999}>
                    {fresIdx.map((b) => (b > 0 && !fresPaths[b - 1]) ? null : (
                      <g key={`fb${b}`} clipPath={b > 0 ? `url(#fres${b})` : undefined}>
                        {b > 0 && <rect width={VB_W} height={VB_H} fill={mixDeep(bg, b)} />}
                        {layers.map((l, i) => fresOn ? (
                          <use key={i} href={`#lyr${i}`} fill={mixDeep(l.color, b)} fillRule="evenodd"
                            stroke={edges ? "#000" : "none"} strokeOpacity={edges ? 0.28 : 0}
                            strokeWidth={edges ? 0.6 : 0} />
                        ) : (
                          <path key={i} d={l.d} fill={l.color} fillRule="evenodd"
                            stroke={edges ? "#000" : "none"} strokeOpacity={edges ? 0.28 : 0}
                            strokeWidth={edges ? 0.6 : 0} />
                        ))}
                      </g>
                    ))}
                  </g>
                </>
              )}
              </g>
            </svg>
            <div style={{ position: "absolute", left: 12, bottom: 10, fontSize: 10.5,
              color: "#6d808f", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5 }}>
              {penMode ? `${penStyle === "rings" ? "rings" : penCount + " lines"} · ${penLines.length} pens${S.perspective && penRelief > 0 ? " · 3D" : ""}${penHidden ? " · hidden-line" : ""}`
                : `${regionCount} regions · ${S.nx}×${S.ny} sample grid${surface3d && perspective ? " · 3D" : ""}`}
            </div>
            <button onClick={() => setCamDrag((v) => !v)}
              onPointerDown={(e) => e.stopPropagation()}
              title={camDrag ? "camera drag ON: drag to pan, scroll to zoom, double-click to reset"
                : "camera drag OFF"}
              style={{ position: "absolute", right: 10, top: 10, width: 34, height: 34,
                borderRadius: 8, cursor: "pointer", fontSize: 15, lineHeight: 1,
                background: camDrag ? "#27424b" : "#141b23e0",
                color: camDrag ? "#dff1f6" : "#7f93a4",
                border: "1px solid " + (camDrag ? "#3f7e8f" : "#26313c") }}>✥</button>
          </div>

          {/* CONTROLS */}
          <div>
            <div style={panel}>
              <div style={heading}>Camera</div>
              <Slider label="Height (view angle at near edge)" value={steep} min={0} max={1} step={0.01}
                onChange={setSteep}
                fmt={(v) => Math.round(Math.atan((0.4 * Math.pow(22.5, v)) / Math.min(yNear, yFar - 2)) * 180 / Math.PI) + "°"} />
              {perspective && (
                <Slider label="Pitch (perspective squash)" value={pitchDeg} min={4} max={80} step={0.5}
                  onChange={setPitchDeg} fmt={(v) => v.toFixed(1) + "°"} />
              )}
              <Slider label="Roll" value={rollDeg} min={-30} max={30} step={0.5}
                onChange={setRollDeg} fmt={(v) => (v === 0 ? "level" : v.toFixed(1) + "°")} />
              <Slider label="Zoom (focal length)" value={zoom} min={1} max={30} step={0.05}
                onChange={setZoom} fmt={(v) => v.toFixed(2) + "×"} />
              <Slider label="Pan ← →" value={panX} min={-Math.max(2, Math.ceil(zoom))} max={Math.max(2, Math.ceil(zoom))} step={0.02}
                onChange={setPanX} fmt={(v) => (v === 0 ? "center" : v.toFixed(2))} />
              <Slider label="Pan ↑ ↓" value={panY} min={-Math.max(2, Math.ceil(zoom))} max={Math.max(2, Math.ceil(zoom))} step={0.02}
                onChange={setPanY} fmt={(v) => (v === 0 ? "center" : v.toFixed(2))} />
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button style={miniBtn} onClick={resetCamera}>Full scene</button>
                <button style={miniBtn}
                  onClick={() => { setZoom(3.2); setPanX(0); setPanY(0.5); }}>Mid-field</button>
                <button style={miniBtn}
                  onClick={() => { setZoom(5.5); setPanX(0); setPanY(0.75); }}>Far band</button>
                <button style={miniBtn} title="steep-down telephoto shot of a close patch of water"
                  onClick={() => {
                    setSteep(0.95); setPitchDeg(62); setZoom(1); setPanX(0); setPanY(0);
                    setYNear(1.5); setYFar(10); setHalfW(4); setWavelength(1.4);
                    setReflMag(4); setAutoFit(true); setRectOutput(true);
                  }}>Close-up</button>
              </div>
              <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                fontFamily: "ui-monospace, monospace" }}>
                Or grab the picture: drag to pan, scroll / pinch-zoom at the cursor,
                double-click to reset. The ✥ button on the preview toggles this
                (turn it off to scroll the page on touch screens).
              </div>
            </div>

            <div style={panel}>
              <div style={heading}>Water surface</div>
              <Slider label="Ripple scale (λ)" value={wavelength} min={0.6} max={7} step={0.1}
                onChange={setWavelength} fmt={(v) => v.toFixed(1)} />
              <Slider label="Ripple strength" value={strength} min={0.05} max={1} step={0.01}
                onChange={setStrength} fmt={(v) => v.toFixed(2)} />
              <Slider label="Crest sharpness" value={sharp} min={0} max={0.8} step={0.05}
                onChange={setSharp}
                fmt={(v) => (v === 0 ? "sine (soft)" : v < 0.35 ? "gentle" : v < 0.6 ? "peaked" : "steep")} />
              <Slider label="Spread / reach" value={spread} min={0} max={1} step={0.01}
                onChange={setSpread} fmt={(v) => (v < 0.4 ? "tight" : v < 0.75 ? "medium" : "wide")} />
              <Slider label="Plane width" value={halfW} min={2} max={40} step={1}
                onChange={setHalfW} fmt={(v) => v * 2 + " units"} />
            </div>

            <div style={panel}>
              <div style={heading}>Environment</div>
              {mode === "preset" && !stops &&
                <Slider label="Color regions" value={bands} min={3} max={16} step={1} onChange={setBands} />}
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {[...Object.keys(PALETTES), ...Object.keys(BANDED_PALETTES)].map((p) => {
                  const on = mode === "preset" && palette === p;
                  const inked = !!BANDED_PALETTES[p];
                  return (
                    <button key={p} onClick={() => { setMode("preset"); setPalette(p); }}
                      style={{ flex: "1 0 30%", padding: "8px 6px", fontSize: 11, borderRadius: 7,
                        cursor: "pointer", fontFamily: "ui-monospace, monospace",
                        background: on ? "#27424b" : "#1a232c",
                        color: on ? "#dff1f6" : "#9fb0c0",
                        border: "1px solid " + (on ? "#3f7e8f" : "#26313c") }}>
                      {p}{inked ? " ✒" : ""}
                    </button>
                  );
                })}
              </div>
              {mode === "preset" && stops && (
                <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 10, lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace" }}>
                  Banded palette: the hairline dark strips draw themselves as ink-line outlines
                  around every color region — every boundary between the bands on either side
                  must pass through the strip.
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <button onClick={enter1d} style={{ flex: 1, padding: "8px 6px", fontSize: 11, borderRadius: 7,
                  cursor: "pointer", fontFamily: "ui-monospace, monospace",
                  background: mode === "paint1d" ? "#4a3a1f" : "#1a232c",
                  color: mode === "paint1d" ? "#f6e2b0" : "#9fb0c0",
                  border: "1px solid " + (mode === "paint1d" ? "#9a7a3a" : "#26313c") }}>
                  Paint 1D ✎ (smooth)
                </button>
                <button onClick={enter2d} style={{ flex: 1, padding: "8px 6px", fontSize: 11, borderRadius: 7,
                  cursor: "pointer", fontFamily: "ui-monospace, monospace",
                  background: mode === "paint2d" ? "#4a3a1f" : "#1a232c",
                  color: mode === "paint2d" ? "#f6e2b0" : "#9fb0c0",
                  border: "1px solid " + (mode === "paint2d" ? "#9a7a3a" : "#26313c") }}>
                  Paint 2D ✎ (panorama)
                </button>
              </div>

              <div style={{ marginBottom: 12 }}>
                <input ref={photoFileRef} type="file" accept="image/*" style={{ display: "none" }}
                  onChange={(e) => { loadPhotoFile(e.target.files && e.target.files[0]); e.target.value = ""; }} />
                <button style={{ ...miniBtn, width: "100%" }}
                  onClick={() => photoFileRef.current && photoFileRef.current.click()}>
                  From photo… 📷
                </button>
                {photoInfo && photoInfo.error && (
                  <div style={{ fontSize: 9.5, color: "#c96f5f", marginTop: 6, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    {photoInfo.error}
                  </div>
                )}
                {photoInfo && !photoInfo.error && (
                  <div style={{ marginTop: 10 }}>
                    <Slider label="Photo colors" value={photoK} min={3} max={7} step={1}
                      onChange={(v) => { setPhotoK(v);
                        const p = photoRef.current; if (p) applyPhoto(p.img, v, p.name); }} />
                    <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                      {photoInfo.swatches.map((c, i) => (
                        <button key={i} title={c + " — set as paint color"}
                          onClick={() => setActiveColor(c)}
                          style={{ flex: 1, height: 22, borderRadius: 5, cursor: "pointer",
                            background: c, border: "1px solid #26313c" }} />
                      ))}
                    </div>
                    <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                      fontFamily: "ui-monospace, monospace" }}>
                      {photoInfo.name} → paint-1D strip: top of the photo lands at the horizon,
                      bottom at the zenith end, band widths follow the photo. Click a swatch to
                      make it the paint color for touch-ups.
                    </div>
                  </div>
                )}
              </div>

              <Slider label="Reflection detail (angular zoom)" value={reflMag} min={0.5} max={10}
                step={0.1} onChange={setReflMag}
                fmt={(v) => (v === 1 ? "1.0× (off)" : v.toFixed(1) + "×")} />
              <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 10, lineHeight: 1.5,
                fontFamily: "ui-monospace, monospace" }}>
                Compresses the environment into a narrower reflected cone, so a small ripple
                tilt sweeps more of the colors — the telephoto close-up look where every
                wavelet carries the whole gradient. Pair with auto-fit for steep-down shots.
              </div>

              {mode === "paint1d" && (
                <div>
                  <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 7, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    Paint by elevation only — sky at the top, waterline at the bottom. Smooth, banded
                    reflection (same shape as the presets).
                  </div>
                  <PaintStrip envColors={envColors} setEnvColors={setEnvColors}
                    activeColor={activeColor} height={140} brushSize={brushSize} />
                </div>
              )}

              {mode === "paint2d" && (
                <div>
                  <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 7, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    Paint the shoreline panorama. Left–right = looking across the lake; up = sky,
                    down = waterline. The water updates when you lift your finger.
                  </div>
                  <PaintGrid2D env2d={env2d} setEnv2d={setEnv2d} activeColor={activeColor}
                    onStrokeEnd={() => setSegEnv(env2dRef.current)}
                    brushSize={brushSize} brushShape={brushShape} />
                </div>
              )}

              {mode !== "preset" && (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {SWATCHES.map((c) => (
                      <button key={c} onClick={() => setActiveColor(c)}
                        style={{ width: 24, height: 24, borderRadius: 5, background: c, cursor: "pointer",
                          padding: 0, border: activeColor === c ? "2px solid #fff" : "1px solid #00000055" }} />
                    ))}
                    <label style={{ width: 24, height: 24, borderRadius: 5, cursor: "pointer",
                      border: "1px solid #44525e", position: "relative", overflow: "hidden",
                      background: activeColor, display: "inline-block" }}>
                      <input type="color" value={activeColor}
                        onChange={(e) => setActiveColor(e.target.value)}
                        style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
                    </label>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10.5, color: "#6d808f", fontFamily: "ui-monospace, monospace",
                      width: 38 }}>Brush</span>
                    {[[0, "·"], [1, "S"], [2, "M"], [3, "L"]].map(([s, lbl]) => (
                      <button key={s} onClick={() => setBrushSize(s)} style={brushBtn(brushSize === s)}>{lbl}</button>
                    ))}
                    {mode === "paint2d" && (
                      <span style={{ display: "inline-flex", gap: 6, marginLeft: 4 }}>
                        {[["round", "●"], ["square", "■"], ["diamond", "◆"]].map(([sh, ic]) => (
                          <button key={sh} onClick={() => setBrushShape(sh)} style={brushBtn(brushShape === sh)}>{ic}</button>
                        ))}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    {mode === "paint1d" && <>
                      <button style={miniBtn} onClick={() => setEnvColors((p) => smoothEnv(p))}>Smooth</button>
                      <button style={miniBtn} onClick={() => setEnvColors(seedEnv(palette, ENV_N))}>Reset to {palette}</button>
                    </>}
                    {mode === "paint2d" && <>
                      <button style={miniBtn}
                        onClick={() => { const s = smoothEnv2D(env2dRef.current); setEnv2d(s); setSegEnv(s); }}>
                        Smooth colors
                      </button>
                      <button style={miniBtn}
                        onClick={() => { const s = seedEnv2D(palette, ENV2D_W, ENV2D_H); setEnv2d(s); setSegEnv(s); }}>
                        Reset to {palette}
                      </button>
                    </>}
                  </div>
                  {mode === "paint2d" && (
                    <div style={{ marginTop: 10 }}>
                      <Slider label="azimuth span (panorama width)" value={azSpan} min={15} max={80} step={1}
                        onChange={setAzSpan} fmt={(v) => "±" + v + "°"} />
                      <Slider label="edge ripple" value={coherence} min={0} max={8} step={1}
                        onChange={setCoherence}
                        fmt={(v) => (v === 0 ? "sharp" : v <= 2 ? "rippled" : v <= 5 ? "smooth" : "broad")} />
                      <div style={{ fontSize: 9.5, color: "#6d808f", marginTop: 2, lineHeight: 1.5,
                        fontFamily: "ui-monospace, monospace" }}>
                        Lower = edges follow every wave; higher = calmer, broader regions.
                      </div>
                    </div>
                  )}
                </>
              )}

              {mode === "preset" && (
                <>
                  <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden",
                    border: "1px solid #26313c" }}>
                    {stops
                      ? stops.map((s, i) => (<div key={i} style={{ flex: s.f1 - s.f0, background: s.c }} />))
                      : presetColors.map((c, i) => (<div key={i} style={{ flex: 1, background: c }} />))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5,
                    color: "#6d808f", marginTop: 3, fontFamily: "ui-monospace, monospace" }}>
                    <span>{eLo}° horizon</span><span>zenith {eHi}°</span>
                  </div>
                </>
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Water depth (Fresnel)</div>
              <Toggle label="Fresnel depth mix" value={fresOn} onChange={setFresOn} />
              {fresOn && (
                <div style={{ marginTop: 6 }}>
                  <Slider label="depth bands" value={fresBands} min={2} max={6} step={1}
                    onChange={setFresBands} />
                  <Slider label="depth strength" value={fresStrength} min={0} max={1} step={0.05}
                    onChange={setFresStrength} fmt={(v) => v.toFixed(2)} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <label style={{ width: 30, height: 30, borderRadius: 6, cursor: "pointer",
                      border: "1px solid #44525e", position: "relative", overflow: "hidden",
                      background: deepColor, display: "inline-block", flex: "none" }}>
                      <input type="color" value={deepColor}
                        onChange={(e) => setDeepColor(e.target.value)}
                        style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
                    </label>
                    <span style={{ fontSize: 12, color: "#9fb0c0",
                      fontFamily: "ui-monospace, monospace" }}>deep water · {deepColor}</span>
                  </div>
                  <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    Steep view angles see through the surface (Fresnel reflectance ~2%), grazing
                    angles mirror it — so the near water shifts toward the deep-water color, in
                    flat contoured bands. The far field stays pure reflection.
                  </div>
                </div>
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Objects across the water</div>
              <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 10, lineHeight: 1.5,
                fontFamily: "ui-monospace, monospace" }}>
                Stamped into the reflected panorama, not drawn in the frame — like the boats
                in the paintings, only each object's reflection appears in the water, torn up
                by the ripples and rimmed with an ink line.
              </div>
              {objects.map((o, i) => (
                <ObjectCard key={o.id} obj={o} idx={i} azSpan={azSpan} eLo={eLo} eHi={eHi}
                  onChange={(patch) => updateObject(o.id, patch)}
                  onRemove={() => removeObject(o.id)} />
              ))}
              {objects.length < 4 && (
                <button onClick={addObject}
                  style={{ width: "100%", padding: "9px", borderRadius: 8, cursor: "pointer",
                    background: "#1a232c", color: "#9fb0c0", border: "1px dashed #3a4a57",
                    fontFamily: "ui-monospace, monospace", fontSize: 12, marginBottom: 12 }}>
                  + add object
                </button>
              )}
              {objectsOn && (
                <>
                  {!is2d && (
                    <>
                      <Slider label="azimuth span (reflection width)" value={azSpan} min={15} max={80}
                        step={1} onChange={setAzSpan} fmt={(v) => "±" + v + "°"} />
                      <Slider label="edge ripple" value={coherence} min={0} max={8} step={1}
                        onChange={setCoherence}
                        fmt={(v) => (v === 0 ? "sharp" : v <= 2 ? "rippled" : v <= 5 ? "smooth" : "broad")} />
                    </>
                  )}
                  <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 6,
                    fontFamily: "ui-monospace, monospace" }}>
                    reflected panorama (what the water sees):
                  </div>
                  <EnvPreview env={envEffective} />
                </>
              )}
            </div>


            <div style={panel}>
              <div style={heading}>Display</div>
              <Slider label="Edge smoothing" value={smooth} min={0} max={4} step={1}
                onChange={setSmooth} fmt={(v) => (v === 0 ? "off (crisp)" : v + "×")} />
              <Toggle label="Grazing perspective" value={perspective} onChange={setPerspective} />
              {perspective && (
                <Toggle label="Rectangular output (fill frame)" value={rectOutput} onChange={setRectOutput} />
              )}
              {!penMode && (
                <Toggle
                  label={perspective ? "3D wave surface" : "3D wave surface (needs perspective)"}
                  value={surface3d && perspective}
                  onChange={(v) => { if (!perspective) setPerspective(true); setSurface3d(v); }} />
              )}
              {!penMode && perspective && surface3d && (
                <>
                  <Slider label="Wave height (3D)" value={waveScale} min={0} max={10} step={0.05}
                    onChange={setWaveScale} fmt={(v) => (v === 0 ? "flat" : v.toFixed(2))} />
                  <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 8, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    Lifts the color regions onto the actual wave crests to preview the surface
                    in relief. Tune the wave <em>scale</em> with Ripple scale (λ) &amp; strength above,
                    and the vertical exaggeration here.
                  </div>
                </>
              )}
              <Toggle label="Show region edges" value={edges} onChange={setEdges} />
              <Toggle label="Animate ripples" value={animate} onChange={setAnimate} />
              {animate ? (
                <div style={{ marginTop: 8 }}>
                  <Slider label="Speed" value={speed} min={0.1} max={1.5} step={0.05}
                    onChange={setSpeed} fmt={(v) => v.toFixed(2)} />
                </div>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <Slider label="Time (wave phase)" value={manualTime} min={0} max={20} step={0.05}
                    onChange={setManualTime} fmt={(v) => v.toFixed(2)} />
                  <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5, marginTop: -4,
                    fontFamily: "ui-monospace, monospace" }}>
                    Scrub to a specific frozen moment to view or export.
                  </div>
                </div>
              )}
            </div>

            <button onClick={() => setAdvanced((a) => !a)}
              style={{ width: "100%", background: "none", border: "1px dashed #2a3640",
                color: "#7f93a4", padding: "8px", borderRadius: 9, cursor: "pointer",
                fontSize: 11.5, fontFamily: "ui-monospace, monospace", marginBottom: 14 }}>
              {advanced ? "− hide advanced" : "+ advanced (sources, range, quality)"}
            </button>

            {advanced && (
              <div style={panel}>
                <div style={heading}>Ripple emitters</div>
                <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 10, lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace" }}>
                  Swell = one long straight-crested wave train. Spectrum = a wind field of many
                  straight waves (raise roughness for chop). Rings = a scattered field of radial
                  ripples — the source of the concentric color rings you see on a real lake.
                  Point = a single spreading ripple.
                </div>
                {emitters.map((em, i) => (
                  <EmitterCard key={em.id} em={em} idx={i} halfW={halfW} yFar={yFar}
                    onChange={(patch) => updateEmitter(em.id, patch)}
                    onRemove={() => removeEmitter(em.id)} />
                ))}
                {emitters.length < 4 && (
                  <button onClick={addEmitter}
                    style={{ width: "100%", padding: "9px", borderRadius: 8, cursor: "pointer",
                      background: "#1a232c", color: "#9fb0c0", border: "1px dashed #3a4a57",
                      fontFamily: "ui-monospace, monospace", fontSize: 12, marginBottom: 12 }}>
                    + add emitter
                  </button>
                )}
                <div style={{ ...heading, marginTop: 10 }}>Range & quality</div>
                <Toggle label="Auto-fit elevation range" value={autoFit} onChange={setAutoFit} />
                {autoFit ? (
                  <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11,
                    color: "#7f93a3", margin: "2px 0 12px", lineHeight: 1.5 }}>
                    tracking the view &amp; waves · {eLo}° – {eHi}°
                  </div>
                ) : (
                  <>
                    <button onClick={() => { setELo(Math.floor(rng.lo)); setEHi(Math.ceil(rng.hi)); }}
                      style={{ width: "100%", padding: "8px", borderRadius: 7, cursor: "pointer",
                        background: "#1a232c", color: "#9fd0d9", border: "1px solid #2f6b78",
                        fontFamily: "ui-monospace, monospace", fontSize: 11, marginBottom: 12 }}>
                      ⤢ fit elevation range to water ({rng.lo.toFixed(0)}° – {rng.hi.toFixed(0)}°)
                    </button>
                    <Slider label="elevation low" value={eLo} min={-5} max={60} step={1} onChange={setELo} fmt={(v) => v + "°"} />
                    <Slider label="elevation high" value={eHi} min={8} max={90} step={1} onChange={setEHi} fmt={(v) => v + "°"} />
                  </>
                )}
                <Slider label="plane near edge" value={yNear} min={1} max={15} step={0.5}
                  onChange={setYNear} fmt={(v) => v.toFixed(1)} />
                <Slider label="plane depth (far edge)" value={yFar} min={10} max={90} step={2} onChange={setYFar} />
                <Slider label="sample grid" value={quality} min={60} max={220} step={10} onChange={setQuality} />
              </div>
            )}

            <div style={panel}>
              <div style={heading}>Background</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label style={{ width: 30, height: 30, borderRadius: 6, cursor: "pointer",
                  border: "1px solid #44525e", position: "relative", overflow: "hidden",
                  background: bgFill, display: "inline-block", flex: "none" }}>
                  <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(bgFill) ? bgFill : "#0a0d12"}
                    onChange={(e) => setBgColor(e.target.value)}
                    style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
                </label>
                <span style={{ fontSize: 12, color: "#9fb0c0", fontFamily: "ui-monospace, monospace", flex: 1 }}>
                  {bgColor ? bgColor : "auto (" + autoBg + ")"}
                </span>
                <button onClick={() => setBgColor("")}
                  style={{ ...miniBtn, flex: "none", padding: "6px 12px",
                    opacity: bgColor ? 1 : 0.5 }}>Auto</button>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {["#ffffff", "#f4ecd8", "#111418", "#000000"].map((c) => (
                  <button key={c} onClick={() => setBgColor(c)} title={c}
                    style={{ flex: 1, height: 22, borderRadius: 5, cursor: "pointer",
                      background: c, border: "1px solid #3a4650" }} />
                ))}
              </div>
            </div>

            <div style={panel}>
              <div style={heading}>Pen plotter</div>
              <Toggle label="Pen-plot mode" value={penMode} onChange={setPenMode} />
              {penMode && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    {[["lines", "Parallel"], ["rings", "Concentric"]].map(([v, lbl]) => (
                      <button key={v} onClick={() => setPenStyle(v)}
                        style={{ flex: 1, padding: "7px 4px", fontSize: 11.5, borderRadius: 6, cursor: "pointer",
                          fontFamily: "ui-monospace, monospace",
                          background: penStyle === v ? "#27424b" : "#1a232c",
                          color: penStyle === v ? "#dff1f6" : "#9fb0c0",
                          border: "1px solid " + (penStyle === v ? "#3f7e8f" : "#26313c") }}>{lbl}</button>
                    ))}
                  </div>
                  {penStyle === "rings"
                    ? <Slider label="ring spacing" value={penSpacing} min={0.5} max={20} step={0.5}
                        onChange={setPenSpacing} fmt={(v) => v.toFixed(1)} />
                    : <Slider label="lines" value={penCount} min={8} max={140} step={2} onChange={setPenCount} />}
                  {penStyle === "lines" && perspective &&
                    <Toggle label="Even spacing on screen" value={penEven} onChange={setPenEven} />}
                  <Slider label="line width" value={penWidth} min={0.4} max={4} step={0.1}
                    onChange={setPenWidth} fmt={(v) => v.toFixed(1)} />
                  <Slider label="3D relief" value={penRelief} min={0} max={120} step={2}
                    onChange={setPenRelief}
                    fmt={(v) => (v === 0 || !perspective ? "flat" : String(v))} />
                  <Toggle label="Hide obscured lines" value={penHidden} onChange={setPenHidden} />
                  <div style={{ fontSize: 10, color: "#6d808f", marginTop: 2, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    {penStyle === "rings"
                      ? "Each color region filled with nested rings that follow its shape — like woodgrain."
                      : "Equally-spaced scan lines across the surface."}
                    {perspective ? " Lifted to the wave height (3D); nearer crests hide what's behind." : " Turn on Perspective for 3D."}
                  </div>
                </div>
              )}
            </div>

            <button onClick={downloadSVG}
              style={{ width: "100%", background: "#2f6b78", border: "none", color: "#f1fbff",
                padding: "12px", borderRadius: 10, cursor: "pointer", fontSize: 13.5,
                fontWeight: 600, letterSpacing: 0.3 }}>
              Export SVG
            </button>

            <button onClick={exportPaperStack} disabled={penMode}
              title={penMode ? "Turn off pen-plot mode — the paper stack needs filled color regions"
                : "Decompose the scene into cuttable paper sheets"}
              style={{ width: "100%", marginTop: 8, background: penMode ? "#1a232c" : "#274b3f",
                border: "1px solid " + (penMode ? "#26313c" : "#3f7e63"),
                color: penMode ? "#5f7384" : "#e6fbf1",
                padding: "12px", borderRadius: 10, cursor: penMode ? "not-allowed" : "pointer",
                fontSize: 13.5, fontWeight: 600, letterSpacing: 0.3 }}>
              Export layered paper ↓
            </button>
            <div style={{ fontSize: 10, color: "#6d808f", marginTop: 5, lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace" }}>
              A stack of same-size sheets, each one contiguous piece with holes cut, that
              rebuilds the scene when stacked in order.
            </div>

            {svgOut && (
              <div style={{ ...panel, marginTop: 12, marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ ...heading, margin: 0, flex: 1 }}>
                    {stackInfo ? "Layered paper stack" : "Export"}</span>
                  <button onClick={() => { setSvgOut(null); setStackInfo(null); }}
                    style={{ ...miniBtn, flex: "none", padding: "4px 10px" }}>close</button>
                </div>
                {stackInfo && (
                  <>
                    <div style={{ background: "#0b0f14", borderRadius: 8, border: "1px solid #26313c",
                      padding: 6, marginBottom: 10, maxHeight: 320, overflow: "auto" }}
                      dangerouslySetInnerHTML={{ __html: svgOut }} />
                    <div style={{ fontSize: 10.5, color: "#8a9bab", marginBottom: 10, lineHeight: 1.5 }}>
                      {stackInfo.nSheets} sheets
                      {stackInfo.method === "optimal"
                        ? " — provably the fewest for this scene"
                        : " — greedy order (scene too complex for exact search)"}
                      · top → bottom. Hatched = holes to cut.
                      Cut each sheet from paper of its labeled color, then assemble bottom → top.
                    </div>
                  </>
                )}
                <div style={{ fontSize: 10.5, color: "#8a9bab", marginBottom: 10, lineHeight: 1.5 }}>
                  A download may have started. If not (some sandboxes block it), use a button below.
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <button onClick={copySvg}
                    style={{ flex: 1, background: "#2f6b78", border: "none", color: "#f1fbff",
                      padding: "11px", borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                    {copied ? "Copied ✓" : "Copy SVG code"}
                  </button>
                  <a href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgOut)}`}
                    download={svgName} target="_blank" rel="noopener noreferrer"
                    style={{ flex: 1, background: "#1a232c", color: "#cfe6ec", textAlign: "center",
                      padding: "11px", borderRadius: 9, fontSize: 13, fontWeight: 600,
                      textDecoration: "none", border: "1px solid #2f6b78" }}>
                    Open / save
                  </a>
                </div>
                <textarea readOnly value={svgOut} onFocus={(e) => e.target.select()}
                  style={{ width: "100%", height: 90, resize: "vertical", boxSizing: "border-box",
                    background: "#0b1118", color: "#9fb0c0", border: "1px solid #26313c",
                    borderRadius: 8, padding: 8, fontSize: 10.5, fontFamily: "ui-monospace, monospace" }} />
                <div style={{ fontSize: 10, color: "#5f7384", marginTop: 6, fontFamily: "ui-monospace, monospace" }}>
                  Or select all in the box above and copy. {(svgOut.length / 1024).toFixed(0)} KB
                  {stackInfo ? ` · ${stackInfo.nSheets} sheets` : ` · ${regionCount} regions`}.
                </div>
              </div>
            )}

            <p style={{ fontSize: 10.5, color: "#5f7384", marginTop: 8, lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace" }}>
              Exports as {regionCount} vector regions. Edges stay straight under
              the perspective map, so the vector stays clean at any zoom.
            </p>
          </div>
        </div>

        {/* Low power mode — battery saver, pinned at the foot of the page */}
        <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid #1b2530",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 480 }}>
            <div style={{ fontSize: 12.5, color: "#cdd9e3", letterSpacing: 0.3,
              fontFamily: "ui-monospace, monospace" }}>Low power mode</div>
            <div style={{ fontSize: 10.5, color: "#6d808f", lineHeight: 1.5, marginTop: 3,
              fontFamily: "ui-monospace, monospace" }}>
              Caps the render grid to a coarser resolution and throttles the ripple
              animation to ~15fps. Trades some fidelity for much lower battery use
              on phones{lowPower ? " — currently on." : "."}
            </div>
          </div>
          <div style={{ flexShrink: 0, minWidth: 132 }}>
            <Toggle label={lowPower ? "On" : "Off"} value={lowPower} onChange={setLowPower} />
          </div>
        </div>
      </div>
    </div>
  );
}
