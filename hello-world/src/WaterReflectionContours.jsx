import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import { labelRegions, buildAdjacency, denoiseGrid, planCollapse } from "./paperStack";
import { useUrlSync } from "./urlSettings";
import { extractPhotoStrip } from "./photoPalette";
import {
  VIDEO_FPS, VIDEO_MIN_SEC, VIDEO_MAX_SEC, VIDEO_DEFAULT_SEC,
  VIDEO_SCALES, VIDEO_DEFAULT_SCALE, videoSize, framePlan,
  videoSupported, encodeMp4, formatDuration, etaSeconds,
} from "./videoExport";

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

// normalize a css color to a canonical lowercase hex for dedup/comparison
function normHex(c) {
  const col = d3.color(c);
  return col ? col.formatHex().toLowerCase() : null;
}
const SWATCH_SET = new Set(SWATCHES.map(normHex));

// append one or more colors to the running list of custom chits, dropping
// anything unparseable, already a built-in swatch, or already pinned.
function mergeChits(existing, colors) {
  const seen = new Set(existing.map(normHex));
  const out = existing.slice();
  for (const c of Array.isArray(colors) ? colors : [colors]) {
    const h = normHex(c);
    if (!h || SWATCH_SET.has(h) || seen.has(h)) continue;
    seen.add(h); out.push(h);
  }
  return out;
}

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

// ---- boat & board wakes ---------------------------------------------
// The V a hull drags behind it — a Kelvin wake. Two wave systems live inside
// a wedge of half-angle atan(1/(2√2)) = 19.47° about the track: transverse
// crests running square across it, and divergent crests feathering off each
// arm. Both are stationary in the vessel's frame, so unlike the emitters
// above the pattern is a function of position alone — it does not travel.
//
// Write u for distance astern and v for offset from the track. Stationary
// phase over the wave heading θ gives 2v·tan²θ + u·tanθ + v = 0, real only
// where u² ≥ 8v² — that inequality *is* the wedge. Parametrized by
// β = √(u² − 8v²)/u (0 on the wedge edge, 1 on the track) both roots and the
// phase come out in closed form, with ρ = √((1−β)/(1+β)) and σ = sign v:
//
//     tanθ_transverse = −σ·ρ/√2       tanθ_divergent = −σ/(√2·ρ)
//     Φ = k₀ · secθ · (u + v·tanθ)
//
// On the track that leaves Φ = k₀u — transverse crests every λ₀ astern. And
// because θ is stationary the phase gradient needs no derivative of θ at all:
// ∂Φ/∂u = k₀secθ and ∂Φ/∂v = k₀secθ·tanθ, which is what slopeAt uses.
//
// Everything is keyed off one length λ₀ — the wake's own wavelength, taken as
// the vessel's waterline length, since a hull at hull speed throws a wave
// about as long as it is. Nothing here reads S.k or S.amp, so a wake scales
// as one object and holds still while the open water is retuned around it.
const WAKE_MU = 1 / (2 * Math.SQRT2);                        // tan of the Kelvin half-angle
const WAKE_ANGLE_DEG = (Math.atan(WAKE_MU) * 180) / Math.PI; // 19.47°
// perpendicular distance in from the wedge edge is (μu − |v|)/√(1+μ²), which
// with μ = 1/(2√2) is exactly u/3 − (2√2/3)|v|
const WAKE_EDGE_V = (2 * Math.SQRT2) / 3;
const WAKE_CUSP = 0.5;      // extra amplitude in the bright band along that edge
const WAKE_RHO_MIN = 0.08;  // below this the divergent arm is shorter than anything draws
const WAKE_DIV_L = 2 / 3;   // the divergent arm's wavelength at the wedge edge, in λ₀
const WAKE_DETAIL_DEFAULT = 0.3;  // finest divergent wave kept, in λ₀
// amp 1 = a wake as steep as the open water at strength 1: that path is
// A = 0.06·strength at a wavelength of 1.8, and what reads is steepness A/λ
const WAKE_STEEP = 0.06 / 1.8;

// Evaluate one prepped wake at a ground point, filling WAKE_OUT with the
// height and — when `slope` is set — its two ground-space derivatives. One
// function serves both so heightAt and slopeAt cannot drift apart. Returns
// false when the point is out of reach and nothing was written.
const WAKE_OUT = [0, 0, 0];
function wakeAt(e, gx, gy, slope) {
  const px = gx - e.x, py = gy - e.y;
  const u = -(px * e.ex + py * e.ey);           // astern of the vessel
  if (u <= 0) return false;                     // flat water ahead of the bow
  const v = px * e.lx + py * e.ly;              // across the track, squeezed to the wedge
  const sg = v < 0 ? -1 : 1;
  // |v|, rounded off over a fraction of a wavelength. A true |v| would leave
  // a crease straight down the middle of the wake: the envelope below is
  // built on distance from the track, whose derivative flips sign there.
  const av = Math.sqrt(v * v + e.e2);

  // signed distance in from the wedge edge. The pattern is cut just outside
  // it rather than at it, which is what gives a wake its hard outer line
  // without putting a step in the field.
  const d = u / 3 - WAKE_EDGE_V * av;
  if (d < -3 * e.w) return false;
  const r = Math.hypot(u, v);
  if (r > 6 * e.L) return false;

  // envelope: reach astern (geometric spreading × the chosen length), the
  // bright band and feather at the wedge edge, and a bow ramp that opens the
  // wake out of the hull instead of starting it from a point
  const E = Math.exp(-r / e.L) / Math.sqrt(1 + r / e.lam);
  const bow = (u * u) / (u * u + e.wb * e.wb);
  const cut = d >= 0 ? 1 : Math.exp(-(d * d) / (e.w * e.w));
  const gl = Math.exp(-(d * d) / (e.w1 * e.w1));
  const bri = 1 + WAKE_CUSP * gl;
  const env = e.A * E * bow * cut * bri;

  // ∂env/∂u and ∂env/∂v. d is linear in u and v, so the sharp factors — the
  // ones that vary within a wavelength — cost two constants to differentiate.
  let du = 0, dv = 0;
  if (slope) {
    const P = bow * cut * bri;
    const dEdr = -E * (1 / e.L + 0.5 / (e.lam + r));
    const qb = u * u + e.wb * e.wb;
    const dPdd = bow * ((d >= 0 ? 0 : (-2 * d / (e.w * e.w)) * cut) * bri
      + cut * WAKE_CUSP * (-2 * d / (e.w1 * e.w1)) * gl);
    const Pu = ((2 * u * e.wb * e.wb) / (qb * qb)) * cut * bri + dPdd / 3;
    const Pv = dPdd * (-(v / av) * WAKE_EDGE_V);        // ∂d/∂v
    du = e.A * (dEdr * (u / r) * P + E * Pu);
    dv = e.A * (dEdr * (v / r) * P + E * Pv);
  }

  // Outside the wedge β is held at 0, where the two branches merge, so the
  // pattern runs on unbroken into the feather instead of ending on a step.
  const D = u * u - 8 * v * v;
  const beta = D > 0 ? Math.sqrt(D) / u : 0;
  const rho = Math.sqrt((1 - beta) / (1 + beta));

  // How short a wave is worth drawing here: what the sample grid can hold,
  // and in perspective what the range can. Same shape as the swell and
  // spectrum range filters, and like them the depth term varies over the
  // whole scene, so it weights the derivative without contributing one.
  const flr0 = e.lamAA2
    + (e.aaC ? (e.aaC * 2 * Math.PI * gy) * (e.aaC * 2 * Math.PI * gy) : 0);
  // Each branch's own wavelength is λ₀cos²θ, taken below as a straight line
  // in m = 1 − β² — exact at the track and at the wedge edge, loose between,
  // which is plenty for a fade threshold. What it buys is that m = 8(v/u)²
  // carries no square root, so unlike β it has a finite gradient at the edge.
  const mr = (8 * v * v) / (u * u);
  const m = mr < 1 ? mr : 1;                      // 0 on the track, 1 at the edge
  const mu = mr < 1 ? (-2 * m) / u : 0;
  const mv = mr < 1 ? (16 * v) / (u * u) : 0;

  let z = 0, zu = 0, zv = 0;
  for (let b = 0; b < 2; b++) {
    if (b && rho <= WAKE_RHO_MIN) break;          // arm too short for anything to draw
    const T = b ? -sg / (Math.SQRT2 * rho) : -sg * rho * Math.SQRT1_2;
    const sec = Math.sqrt(1 + T * T);
    // the divergent arm shortens without bound toward the track, so it is the
    // one that fades out there; both meet at 2λ₀/3 on the edge and so merge
    const lamL = b ? WAKE_DIV_L * e.lam * m : e.lam * (1 - m / 3);
    const dl = b ? WAKE_DIV_L * e.lam : -e.lam / 3;
    // the coarsest of the two floors wins; summing them would let the grid's
    // floor, which is the grid's property and not the wake's, break the wake's
    // scaling — the same wake at twice the size would carry different arms
    const flr = b && e.lamDet2 > e.lamAA2 ? flr0 - e.lamAA2 + e.lamDet2 : flr0;
    const q = lamL * lamL + flr;
    const g = (lamL * lamL) / q;
    const ph = e.k0 * sec * (u + v * T);
    z += env * g * Math.sin(ph);
    if (slope) {
      const gm = ((2 * lamL * flr) / (q * q)) * dl;             // dg/dm
      const sn = Math.sin(ph), c = env * g * Math.cos(ph) * e.k0 * sec;
      zu += (du * g + env * gm * mu) * sn + c;
      zv += (dv * g + env * gm * mv) * sn + c * T;
    }
  }

  WAKE_OUT[0] = z;
  if (slope) {
    WAKE_OUT[1] = -e.ex * zu + e.lx * zv;
    WAKE_OUT[2] = -e.ey * zu + e.ly * zv;
  }
  return true;
}

// Wakes ride into the field as emitters, so the height, the 3D lift, the pen
// lines and the reflection all pick them up through the one path. Both the
// studio and the saved-scene fixture assemble S through here — a wake that
// only one of them added would render in only one of them.
function withWakes(emitters, wakes) {
  if (!wakes || !wakes.length) return emitters;
  const live = wakes.filter((w) => w.on && w.amp > 0)
    .map((w) => ({ ...w, id: "wake" + w.id, on: true, type: "wake" }));
  return live.length ? [...emitters, ...live] : emitters;
}

// A fresh wake, sized to the scene it is being dropped into. Strength is
// absolute once set — that is the whole point of it — but a wake dropped onto
// a calm scene at the strength a rough one wants lands on top of the picture,
// so the *seed* tracks the open water's own strength. It reproduces both
// settings that read well by hand: about 0.4 over the saved scene's ripples,
// and the floor over glass, where a wake is the only thing cutting the bands.
function newWake(id, halfW, yFar, strength) {
  return { id, on: true, x: 0, y: Math.round(yFar * 0.35),
    dir: 15, scale: Math.max(1.5, Math.round(halfW * 0.14 * 2) / 2),
    amp: Math.max(0.1, Math.min(1.5, Math.round((strength || 0) * 20) / 20)),
    len: 8, detail: WAKE_DETAIL_DEFAULT,
    angle: Math.round(WAKE_ANGLE_DEG * 10) / 10 };
}

// Pre-bake an emitter into per-frame constants so the per-sample loop is cheap.
function prepEmitter(em, S) {
  const baseLambda = (2 * Math.PI / S.k) * em.size; // global λ × size
  const A = S.amp * em.amp;
  const wt = S.omega * S.t;
  const q = S.sharp || 0;   // Stokes-style crest sharpening, 2nd harmonic weight

  if (em.type === "point") {
    // em.decay overrides the global reach — used by the buoy's scattered
    // ripples, which should stay local to the hull
    const decay = (em.decay ?? S.decay) / Math.max(0.6, em.size);
    return { type: "point", x: em.x, y: em.y, k0: 2 * Math.PI / baseLambda, A, decay, wt };
  }
  if (em.type === "swell") {
    const a = (em.dir * Math.PI) / 180;
    const k0 = 2 * Math.PI / baseLambda;
    return { type: "swell", k0, Dx: Math.cos(a), Dy: Math.sin(a), A, ph0: -wt,
      q, aa: aaCoef(k0, S) };
  }
  if (em.type === "wake") {
    // λ₀ is the vessel's length, read straight off the control in scene units
    // instead of through S.k — that is what keeps the wake's scale its own
    const lam = Math.max(0.25, em.scale);
    const a = ((em.dir || 0) * Math.PI) / 180;
    const ex = Math.cos(a), ey = Math.sin(a);          // heading (way on)
    const half = Math.max(6, Math.min(45, em.angle == null ? WAKE_ANGLE_DEG : em.angle));
    const lat = WAKE_MU / Math.tan((half * Math.PI) / 180);  // squeeze v to widen/narrow the V
    // Two floors on how short a wave the wake may carry, and they are not the
    // same thing. lamAA is the coarsest the sample grid can hold — never
    // negotiable, or the arms alias into speckle. lamDet is the chosen one:
    // how much of the divergent feathering to keep at all. It is the divergent
    // arms that run down to nothing toward the track, so the choice only binds
    // them; the transverse crests and the V's own edge are never cut by it.
    const cell = Math.max((S.xMax - S.xMin) / S.nx, (S.yMax - S.yMin) / S.ny);
    const det = em.detail == null ? WAKE_DETAIL_DEFAULT : em.detail;
    return { type: "wake", x: em.x, y: em.y, ex, ey, lx: -ey * lat, ly: ex * lat,
      lam, k0: (2 * Math.PI) / lam, A: WAKE_STEEP * lam * em.amp,
      L: Math.max(1, em.len) * lam,
      w: 0.45 * lam, w1: 0.9 * lam, wb: 0.45 * lam, e2: 0.04 * lam * lam,
      lamAA2: Math.pow(2.2 * cell, 2), lamDet2: Math.pow(det * lam, 2),
      aaC: S.perspective ? 0.22 / S.ny : 0 };
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

// Bake every live emitter for this frame. The one place S._ems is filled, so
// the preview, the 3D solid, the pen lines and the exports all sample the
// same field — and a test can stand a field up without building geometry.
function prepField(S) {
  S._ems = S.emitters.filter((e) => e.on).map((e) => prepEmitter(e, S));
  return S;
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
    } else if (e.type === "wake") {
      if (wakeAt(e, gx, gy, false)) z += WAKE_OUT[0];
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
    } else if (e.type === "wake") {
      if (wakeAt(e, gx, gy, true)) { hx += WAKE_OUT[1]; hy += WAKE_OUT[2]; }
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
// regions, pen lines, buoy, clips — rolls consistently.
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
// files small); also un-closes the ring if last == first.
//
// Each surviving point is the CENTROID of the run it absorbed, not the run's
// first point. The bezier fit downstream interpolates every point handed to
// it, so any per-vertex tracing noise — the raster beating against the field
// at sub-pixel amplitude — would otherwise come back as a scallop per kept
// vertex, at exactly this eps as its wavelength. Averaging the run removes
// that noise at the only scale it exists at; a run is shorter than eps by
// construction, so nothing the output could have resolved is lost.
function simplifyRing(pts, eps) {
  const out = [];
  let ax = 0, ay = 0, sx = 0, sy = 0, n = 0;   // cluster anchor and running sum
  for (const p of pts) {
    if (n && Math.hypot(p[0] - ax, p[1] - ay) >= eps) {
      out.push([sx / n, sy / n]);
      sx = 0; sy = 0; n = 0;
    }
    if (!n) { ax = p[0]; ay = p[1]; }
    sx += p[0]; sy += p[1]; n++;
  }
  if (n) out.push([sx / n, sy / n]);
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < eps) out.pop();
  }
  return out;
}

// closed Catmull-Rom spline through the points, emitted as cubic beziers —
// the exported edge is a genuinely smooth curve (an elliptical region becomes
// an actual smooth closed curve, not a polygonal approximation)
// Two decimals, not one: a tenth of a viewBox unit is half a raster pixel at
// export width, so rounding there would re-quantize the sub-pixel crossings
// the whole pipeline works to keep, as visible steps under zoom.
function ringToBezier(p) {
  const n = p.length;
  let d = "M" + p[0][0].toFixed(2) + " " + p[0][1].toFixed(2) + " ";
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += "C" + c1x.toFixed(2) + " " + c1y.toFixed(2) + " "
       + c2x.toFixed(2) + " " + c2y.toFixed(2) + " "
       + p2[0].toFixed(2) + " " + p2[1].toFixed(2) + " ";
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

// ---- floating object (buoy) ----------------------------------------
// A sphere floating at the surface, drawn through the same camera as the
// water. Visible shape = the spherical cap above the waterline; the hull
// below z = 0 is clipped away by the projected sphere ∩ water-plane circle.
// The reflection is the cap mirrored across the plane, wobbled by a
// screen-space ripple and clipped to below the waterline.
function buildBuoy(S, fit, obj) {
  const r = obj.size;
  let zc = r * (1 - 2 * obj.sub);              // center height from submersion
  // ride the local wave (exaggerated, like pen-mode relief)
  const bob = heightAt(obj.x, obj.y, S) * 10;
  zc += Math.max(-0.3 * r, Math.min(0.3 * r, bob));
  if (zc < -r * 0.98) return null;             // fully under -> nothing to draw
  const syS = fit.scaleY || fit.scale;
  const [cx, cy, Zc] = penProject(obj.x, obj.y, zc, S, fit);
  let rx, ry;
  if (S.perspective) {
    rx = fit.scale * r / Zc; ry = syS * r / Zc;
  } else {
    rx = fit.scale * r / (S.xMax - S.xMin);
    ry = syS * r / (S.yMax - S.yMin);
  }
  if (rx < 0.5) return null;

  // waterline: the circle where the sphere crosses z = 0, projected
  const rw = Math.sqrt(Math.max(0, r * r - zc * zc));
  let ringD = "", nearD = "", clipAbove = null, clipBelow = null;
  if (rw > 0.02) {
    const NP = 40, ring = [];
    for (let i = 0; i <= NP; i++) {
      const th = (i / NP) * Math.PI * 2;
      const [sx, sy] = penProject(obj.x + rw * Math.cos(th), obj.y + rw * Math.sin(th), 0, S, fit);
      ring.push([sx, sy]);
    }
    ringD = "M" + ring.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") + " Z";
    if (S.perspective) {
      // θ ∈ [π, 2π]: the near (camera-side) half of the waterline, left → right
      const near = ring.slice(NP / 2);
      nearD = "M" + near.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L");
      const a = near[0], b = near[near.length - 1], L = 4000;
      const arc = near.map((p) => "L" + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
      const lead = `M${(a[0] - L).toFixed(1)} ${a[1].toFixed(1)} ${arc} L${(b[0] + L).toFixed(1)} ${b[1].toFixed(1)}`;
      clipAbove = `${lead} L${(b[0] + L).toFixed(1)} ${-L} L${(a[0] - L).toFixed(1)} ${-L} Z`;
      clipBelow = `${lead} L${(b[0] + L).toFixed(1)} ${L} L${(a[0] - L).toFixed(1)} ${L} Z`;
    }
  }

  // reflection: mirror the sphere across z = 0 (virtual image is farther from
  // the camera, so it projects slightly smaller — correct for a plane mirror)
  let reflD = null;
  if (S.perspective) {
    const [mx, my, mZc] = penProject(obj.x, obj.y, -zc, S, fit);
    const mrx = fit.scale * r / mZc, mry = syS * r / mZc;
    const strength = S.amp / 0.06;               // global ripple strength 0..1
    const wAmp = Math.min(8, mrx * 0.25 * strength);
    const wLen = Math.max(3, mry * 0.8);
    const N = 60;
    let d = "";
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const py = my + mry * Math.sin(a);
      const px = mx + mrx * Math.cos(a)
        + wAmp * Math.sin(((py - my) / wLen) * Math.PI * 2 + S.t * 1.7 + 1.3);
      d += (i === 0 ? "M" : "L") + px.toFixed(1) + " " + py.toFixed(1) + " ";
    }
    reflD = d + "Z";
  }
  return { cx, cy, rx, ry, ringD, nearD, clipAbove, clipBelow, reflD, ortho: !S.perspective };
}

// cel-shade bands: flat tones only, like the water's isobands. Each band is
// the same ellipse shrunk and pushed toward the light, clipped to the ball
// silhouette — the overlaps read as thick crescent color bands.
// n = number of tones, lightDeg = where the light sits around the ball
// (0° = above, 90° = right, 180° = below, 270° = left).
const BUOY_RAMP = ["#7e150e", "#c02c1f", "#e8503c", "#ff8a66", "#ffd9b8"];
function makeBuoyBands(n, lightDeg) {
  const interp = d3.interpolateRgbBasis(BUOY_RAMP);
  const a = (lightDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  return d3.range(n).map((k) => {
    const t = k / (n - 1);            // 0 = shadow base, 1 = glint
    return {
      f: 1 - 0.82 * Math.pow(t, 1.6), // radius factor
      ox: 0.72 * t * dx,              // center offset, in units of rx/ry
      oy: 0.72 * t * dy,
      color: d3.color(interp(t)).formatHex(),
    };
  });
}

function buoyBandGeo(b, bands) {
  return bands.map((band) => ({
    cx: b.cx + band.ox * b.rx, cy: b.cy + band.oy * b.ry,
    rx: b.rx * band.f, ry: b.ry * band.f, color: band.color,
  }));
}

function buoySvg(b, bands) {
  let s = `<defs>`;
  if (b.clipAbove) s += `<clipPath id="buoyAbove"><path d="${b.clipAbove}"/></clipPath>`;
  if (b.clipBelow) s += `<clipPath id="buoyBelow"><path d="${b.clipBelow}"/></clipPath>`;
  s += `<clipPath id="buoyBall"><ellipse cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" rx="${b.rx.toFixed(1)}" ry="${b.ry.toFixed(1)}"/></clipPath></defs>`;
  if (b.reflD) s += `<g${b.clipBelow ? ' clip-path="url(#buoyBelow)"' : ""}>`
    + `<path d="${b.reflD}" fill="#b03328" opacity="0.45"/></g>`;
  s += `<g${b.clipAbove ? ' clip-path="url(#buoyAbove)"' : ""}><g clip-path="url(#buoyBall)">`
    + buoyBandGeo(b, bands).map((e) =>
        `<ellipse cx="${e.cx.toFixed(1)}" cy="${e.cy.toFixed(1)}" rx="${e.rx.toFixed(1)}" ry="${e.ry.toFixed(1)}" fill="${e.color}"/>`
      ).join("")
    + `</g></g>`;
  if (b.nearD) s += `<path d="${b.nearD}" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="1.1"/>`;
  if (b.ortho && b.ringD) s += `<path d="${b.ringD}" fill="none" stroke="#000" stroke-opacity="0.3" stroke-width="1"/>`;
  return s;
}

// equally-spaced scan lines across the surface. Each line is split into
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

// ---- 3D solid surface: hidden-surface removal, THEN smooth contours ---
// Lifting the flat color layers onto tall waves and painting them in the old
// backdrop-elevation order let a wave's far side show through the crest in
// front of it (the taller the wave, the more "backside" you saw). Doing the
// hidden-surface removal geometrically on the vector layers is the hard part;
// doing it on a raster is easy. So we rasterize the lifted surface into a
// screen-space z-buffer and contour what it sees with the very same
// marching-squares + Chaikin + bezier pipeline the flat modes use: the region
// silhouettes become the real wave crests, so nothing behind a crest leaks
// through.
//
// Two things decide whether the result still looks like the flat modes —
// smooth color regions — rather than a faceted polygon soup:
//
//  * WHAT the raster carries. Keeping the scalar of the front-most point and
//    interpolating it across each projected grid triangle sounds free, but the
//    sample grid is uniform in GROUND space: under a grazing camera one
//    near-field cell covers a tenth of the frame. A linearly interpolated
//    scalar makes each such cell contribute one straight facet, and the Chaikin
//    pass — which in raster space works at pixel scale, not cell scale — can't
//    round a facet that big. So the raster keeps the perspective-correct GRID
//    COORDINATE of the front-most point instead, and scalars are reconstructed
//    from the grid with a Catmull-Rom kernel: a C1 field, curved inside a cell.
//
//  * WHICH scalar. For preset/1D palettes it's the reflected elevation,
//    continuous by construction. A painted panorama has no such scalar: any
//    per-cell quantity (a color index, a color rank) is a step function of the
//    panorama grid, and contouring it snaps every boundary back onto that grid
//    — precisely the staircase buildSegmentation goes to such lengths to avoid.
//    So the panorama path reuses buildSegmentation's own construction: the
//    per-color signed distance fields, composed through the reflection and
//    contoured at zero (buildSurface3DPanorama).

// depth ratio at which a second fragment counts as "behind" rather than the
// same sheet seen twice (adjacent triangles share edges and land on the same
// pixel at almost equal depth)
const CREST_MARGIN = 0.98, CREST_MARGIN_INV = 1 / CREST_MARGIN;

// what two 3-tap box passes make of |k| at its crease (see crestGapField)
const BLUR_CREASE = 8 / 9;
// how far a crest gap starts INSIDE its crest, in raster pixels (see
// crestGapField): counted off the saved scenes, slivers stop showing up at
// about three quarters of a pixel, and this is the round number above that
const CREST_OVERLAP = 1;

// smooth a raster-space contour multipolygon into a bezier path in viewBox
// coordinates (the raster is BW×BH, the viewBox VB_W×VB_H). `off` shifts
// contour coordinates back from a padded raster (a one-pixel replicated border
// lets a region's edge cross the frame instead of stopping half a pixel inside).
function contourToScreenPath(multi, BW, BH, iters, off = 0) {
  const kx = VB_W / BW, ky = VB_H / BH;
  let d = "";
  for (const poly of multi.coordinates) {
    for (const ring0 of poly) {
      let ring = ring0.map((p) => [(p[0] + off) * kx, (p[1] + off) * ky]);
      ring = iters ? chaikin(ring, iters) : ring;
      const simp = simplifyRing(ring, 0.6);
      if (simp.length >= 3) { d += ringToBezier(simp); continue; }
      for (let idx = 0; idx < ring.length; idx++)
        d += (idx === 0 ? "M" : "L") + ring[idx][0].toFixed(1) + " " + ring[idx][1].toFixed(1) + " ";
      d += "Z ";
    }
  }
  return d;
}

// Catmull-Rom through four consecutive samples (t in [0,1] between b and c)
function cr4(a, b, c, d, t) {
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

// Z-buffer the lifted surface into a BW×BH raster. Every pixel keeps the
// perspective-correct SURFACE-GRID COORDINATE of the front-most point, so any
// quantity sampled on that grid can be reconstructed at the visible surface,
// already occluded. `cov` marks the pixels the water reaches; `sil` is its
// signed distance field in raster pixels, which lets a region end half a pixel
// out from the last covered pixel instead of tracing that pixel's square edge.
//
// `lift` off leaves the surface on the water plane: same raster, same
// occlusion test (which then finds nothing to occlude), so the flat modes can
// share this path purely for what the raster gives them for free — a picture
// sampled on the FRAME rather than on the ground plane, with everything
// outside the viewport absent instead of merely clipped later.
// `gapVB` > 0 also traces the crest gaps (see crestGapField), as a width in
// viewBox units.
function rasterizeSurface(S, fit, gN, BW, lift = true, gapVB = 0) {
  const BH = Math.max(2, Math.round(BW * VB_H / VB_W));
  const stride = gN + 1, NV = stride * stride, NP = BW * BH;
  const GX = new Float64Array(NV), GY = new Float64Array(NV);
  const SX = new Float64Array(NV), SY = new Float64Array(NV), QW = new Float64Array(NV);
  for (let j = 0; j <= gN; j++) for (let i = 0; i <= gN; i++) {
    const [gx, gy] = cell2ground((i / gN) * S.nx, (j / gN) * S.ny, S);
    const gz = lift ? clampLift(heightAt(gx, gy, S) * S.waveScale, S, fit) : 0;
    const [sx, sy, dp] = penProject(gx, gy, gz, S, fit);
    const q = j * stride + i;
    GX[q] = gx; GY[q] = gy;
    SX[q] = (sx / VB_W) * BW; SY[q] = (sy / VB_H) * BH;
    QW[q] = dp > 1e-6 ? 1 / dp : 0;      // 1/depth: the perspective divide
  }
  const zb = new Float64Array(NP).fill(Infinity);
  const GI = new Float32Array(NP), GJ = new Float32Array(NP);
  const cov = new Uint8Array(NP), occ = new Uint8Array(NP);
  const tri = (a, b, c) => {
    const q0 = QW[a], q1 = QW[b], q2 = QW[c];
    if (!q0 || !q1 || !q2) return;                 // vertex at/behind the eye
    const x0 = SX[a], y0 = SY[a], x1 = SX[b], y1 = SY[b], x2 = SX[c], y2 = SY[c];
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(BW - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(BH - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-9) return;
    const ia = a % stride, ja = (a - ia) / stride;
    const ib = b % stride, jb = (b - ib) / stride;
    const ic = c % stride, jc = (c - ic) / stride;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / den;
      const w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
      // interpolate grid coordinates in 1/depth, the only way they stay put
      // across a near-field cell the camera stretches over half the frame
      const iw = w0 * q0 + w1 * q1 + w2 * q2;
      if (iw <= 0) continue;
      const z = 1 / iw, p = y * BW + x;
      const prev = zb[p];
      if (z < prev) {
        // this fragment buries whatever was here: the pixel is in front of
        // other water, which is what makes it part of an occluding sheet
        if (prev < Infinity && z < prev * CREST_MARGIN) occ[p] = 1;
        zb[p] = z;
        GI[p] = (w0 * q0 * ia + w1 * q1 * ib + w2 * q2 * ic) / iw;
        GJ[p] = (w0 * q0 * ja + w1 * q1 * jb + w2 * q2 * jc) / iw;
        cov[p] = 1;
      } else if (z > prev * CREST_MARGIN_INV) {
        occ[p] = 1;                            // …or it lands behind one
      }
    }
  };
  for (let j = 0; j < gN; j++) for (let i = 0; i < gN; i++) {
    const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1;
    tri(a, b, c); tri(b, e, c);
  }
  const inn = new Uint8Array(NP), out = new Uint8Array(NP);
  for (let p = 0; p < NP; p++) { inn[p] = cov[p]; out[p] = 1 - cov[p]; }
  const Din = distTransform(inn, BW, BH), Dout = distTransform(out, BW, BH);
  const sil = new Float64Array(NP);
  let occluding = false;
  for (let p = 0; p < NP; p++) {
    sil[p] = cov[p] ? Din[p] - 0.5 : -(Dout[p] - 0.5);
    if (occ[p]) occluding = true;
  }
  // coverage is point-sampled, so that distance field steps in whole pixels and
  // its zero set is the staircase of pixel edges the mask happens to have. A
  // couple of box passes turn the steps into a ramp, and the crossing then
  // slides sub-pixel along the edge — the silhouette reads as the smooth curve
  // the crest actually is instead of a flight of stairs.
  const tmp = new Float64Array(NP);            // one scratch buffer for every blur
  blurField(sil, BW, BH, tmp, 2);
  // flat water occludes nothing, so skip the seam and gap passes entirely
  const crest = occluding ? crestField(occ, cov, BW, BH, NP, tmp) : null;
  // The gap width is asked for in viewBox units and used in raster pixels, so
  // the same setting draws the same gap whatever raster the picture is traced
  // on — the export retrace stays the picture the preview showed.
  const gap = occluding && gapVB > 0
    ? crestGapField(SX, SY, QW, gN, stride, zb, BW, BH, (gapVB * BW) / VB_W, tmp)
    : null;
  return { BW, BH, NP, stride, GX, GY, GI, GJ, cov, sil, crest, gap };
}

// ---- crest seams ---------------------------------------------------
// The outer water edge is not the only silhouette in the frame: wherever a
// near crest cuts across the water behind it, the two sides of that edge are
// different sheets of the same surface and the scalar jumps from one pixel to
// the next. Marching squares interpolates the jump anyway, and since the two
// values are unrelated the crossing lands at an arbitrary point in the pixel
// gap — the edge comes out as a staircase of whole pixels, and picks up a
// hairline sliver of a band that exists on neither sheet.
//
// The jump itself can't be interpolated, but we do know where the silhouette
// runs: the same trick the outer edge uses works here. Mark which side of the
// seam each pixel sits on (+1 near sheet, −1 occluded, 0 away from any seam)
// and blur it; the zero crossing of that ramp is a sub-pixel, along-the-seam
// smooth estimate of the crest. contourRegion then re-expresses the field
// inside the seam band as distance to that curve, keeping each pixel's side of
// the region boundary but moving the boundary itself onto the crest.
//
// Finding the seams costs nothing extra, because the z-buffer already knows:
// `occ` marks every pixel where the rasterizer saw a second, much deeper
// fragment. That set is exactly the part of the surface standing in front of
// other water, so its outline IS the crest silhouette. Reading it off the
// depth test beats hunting for a threshold on depth gradients, which cannot
// tell a genuine tear from the far field, where one pixel legitimately spans
// many grid rows and every neighbour step is large.
function crestField(occ, cov, BW, BH, NP, scratch) {
  // ±1 either side of the silhouette, blurred into a ramp whose zero crossing
  // is a sub-pixel, along-the-edge smooth estimate of where the crest runs
  const side = new Float64Array(NP);
  for (let p = 0; p < NP; p++) side[p] = occ[p] ? 1 : -1;
  // …but only near that crossing: elsewhere the ramp is a plateau with no
  // boundary to place, and snapping the field to it would drag unrelated color
  // edges around. The band is where a 3×3 neighbourhood straddles the outline.
  const band = new Uint8Array(NP);
  let any = false;
  for (let y = 1; y < BH - 1; y++) for (let x = 1; x < BW - 1; x++) {
    const p = y * BW + x;
    if (!cov[p]) continue;
    let on = 0, off = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (occ[p + dy * BW + dx]) on++; else off++;
    }
    if (on && off) { band[p] = 1; any = true; }
  }
  if (!any) return null;                       // nothing occludes anything
  blurField(side, BW, BH, scratch || new Float64Array(NP), 2);
  for (let p = 0; p < NP; p++) if (!band[p]) side[p] = 0;
  return side;
}

// ---- crest gaps -----------------------------------------------------
// An outline that says which wave is in front of which. Where a near crest
// cuts across the water behind it the two sheets usually carry the same color
// — the crest dissolves into the band it overlaps and the relief goes flat.
// The remedy is the one the eye already expects from a paper cut-out: let the
// surface occlude a little PAST its own silhouette, so a thin strip of
// background opens along the far side of every crest and the near sheet reads
// as standing in front.
//
// Where the crests are is a question about the MESH, not about the raster. A
// fold is where the surface's projection turns back on itself: the two
// triangles either side of a mesh edge wind opposite ways on screen, and that
// edge is exactly the curve where the visible sheet ends and whatever is
// behind it takes over. (`occ` cannot answer this. It marks every pixel with
// water behind it, which under a grazing camera is one solid mass — its
// outline is the outermost crest only, and says nothing about the dozens of
// folds inside it. That is enough to snap a seam onto, not to draw along.)
//
// From those edges the gap is a distance field. Rasterize the fold edges
// carrying their depth, drop the ones a nearer wave hides, then take the
// chamfer distance to the nearest surviving crest pixel and carry that
// pixel's depth along with it: comparing that depth with the depth actually
// visible at a pixel says which side of the crest the pixel is on — nearer
// than the crest is the sheet in front, farther is the water behind. Signed
// that way, the gap is the band 0 < s < w, whose own signed distance is
// min(s, w − s), and every threshold of it is a smooth curve the usual
// marching-squares + Chaikin pass can trace like any other region.
//
// Taking the NEAREST crest is also what keeps the far field from turning to
// mush. Toward the horizon the strip of water visible between two crests
// becomes thinner than the gap itself; each pixel of that strip belongs to
// whichever crest is closer, so the band can never eat more than half of a
// strip however narrow it gets. The effect thins out with distance instead of
// flooding the top of the frame.
function crestGapField(SX, SY, QW, gN, stride, zb, BW, BH, wPx, scratch) {
  const NP = BW * BH;
  // which way each projected triangle winds; 0 = degenerate, or a vertex at
  // or behind the eye, where the projection says nothing about facing
  const facing = (a, b, c) => {
    if (!QW[a] || !QW[b] || !QW[c]) return 0;
    const d = (SY[b] - SY[c]) * (SX[a] - SX[c]) + (SX[c] - SX[b]) * (SY[a] - SY[c]);
    return d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0;
  };
  const F = new Int8Array(2 * gN * gN);
  for (let j = 0; j < gN; j++) for (let i = 0; i < gN; i++) {
    const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1, t = 2 * (j * gN + i);
    F[t] = facing(a, b, c); F[t + 1] = facing(b, e, c);
  }
  const cmask = new Uint8Array(NP);
  const zc = new Float32Array(NP).fill(Infinity);
  let any = false;
  // a fold edge, walked pixel by pixel. Screen position interpolates linearly
  // along a projected segment; depth does not, but 1/depth does — the same
  // perspective divide the surface raster interpolates in.
  const edge = (v0, v1) => {
    const q0 = QW[v0], q1 = QW[v1];
    if (!q0 || !q1) return;
    const x0 = SX[v0], y0 = SY[v0], dx = SX[v1] - x0, dy = SY[v1] - y0;
    const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    if (n > BW + BH) return;             // a cell smeared across the whole frame
    for (let s = 0; s <= n; s++) {
      const t = n ? s / n : 0;
      const x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
      if (x < 0 || y < 0 || x >= BW || y >= BH) continue;
      const iw = q0 + (q1 - q0) * t;
      if (iw <= 0) continue;
      const z = 1 / iw, p = y * BW + x;
      if (z < zc[p]) zc[p] = z;
      cmask[p] = 1; any = true;
    }
  };
  // Each interior mesh edge belongs to exactly one quad this way: the diagonal
  // between the quad's own two triangles, and the two edges its second
  // triangle shares with the quad to its right and the quad below.
  for (let j = 0; j < gN; j++) for (let i = 0; i < gN; i++) {
    const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1;
    const t = 2 * (j * gN + i), f0 = F[t], f1 = F[t + 1];
    if (f0 && f1 && f0 !== f1) edge(b, c);
    if (i + 1 < gN) { const g = F[2 * (j * gN + i + 1)]; if (f1 && g && f1 !== g) edge(b, e); }
    if (j + 1 < gN) { const g = F[2 * ((j + 1) * gN + i)]; if (f1 && g && f1 !== g) edge(c, e); }
  }
  if (!any) return null;
  // Two ways a fold is not a crest to draw along, both settled by the depths
  // the raster already holds: a fold with nearer water standing in front of it
  // is not visible at all, and a fold with nothing behind it any deeper than
  // itself has not started hiding anything yet — the surface has only just
  // turned away and the sliver it hides is thinner than a pixel. The second
  // matters as much as the first: at an incipient fold both sides sit at the
  // same depth, so which side a neighbouring pixel falls on comes out of the
  // rounding, and the gap breaks up into a dotted line of coin flips.
  any = false;
  for (let p = 0; p < NP; p++) {
    if (!cmask[p]) continue;
    const z = zc[p], x = p % BW, y = (p - x) / BW;
    let deepest = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue;
      const d = zb[ny * BW + nx];
      if (d > deepest) deepest = d;
    }
    if (zb[p] < z * CREST_MARGIN || deepest < z * CREST_MARGIN_INV) cmask[p] = 0;
    else any = true;
  }
  if (!any) return null;
  // chamfer distance to the nearest visible crest pixel, carrying that pixel's
  // depth along the same relaxations
  const INF = 1e9, s2 = Math.SQRT2;
  const D = new Float32Array(NP), Z = new Float32Array(NP);
  for (let p = 0; p < NP; p++) { D[p] = cmask[p] ? 0 : INF; Z[p] = cmask[p] ? zc[p] : 0; }
  for (let j = 0; j < BH; j++) for (let i = 0; i < BW; i++) {
    const p = j * BW + i; if (!D[p]) continue;
    let d = D[p], z = Z[p], q;
    if (i > 0 && D[q = p - 1] + 1 < d) { d = D[q] + 1; z = Z[q]; }
    if (j > 0 && D[q = p - BW] + 1 < d) { d = D[q] + 1; z = Z[q]; }
    if (i > 0 && j > 0 && D[q = p - BW - 1] + s2 < d) { d = D[q] + s2; z = Z[q]; }
    if (i < BW - 1 && j > 0 && D[q = p - BW + 1] + s2 < d) { d = D[q] + s2; z = Z[q]; }
    D[p] = d; Z[p] = z;
  }
  for (let j = BH - 1; j >= 0; j--) for (let i = BW - 1; i >= 0; i--) {
    const p = j * BW + i; if (!D[p]) continue;
    let d = D[p], z = Z[p], q;
    if (i < BW - 1 && D[q = p + 1] + 1 < d) { d = D[q] + 1; z = Z[q]; }
    if (j < BH - 1 && D[q = p + BW] + 1 < d) { d = D[q] + 1; z = Z[q]; }
    if (i < BW - 1 && j < BH - 1 && D[q = p + BW + 1] + s2 < d) { d = D[q] + s2; z = Z[q]; }
    if (i > 0 && j < BH - 1 && D[q = p + BW - 1] + s2 < d) { d = D[q] + s2; z = Z[q]; }
    D[p] = d; Z[p] = z;
  }
  // Sign the distance by side. The far side of a crest is where the visible
  // surface is deeper than the crest itself — no tolerance needed: at a fold
  // the near sheet is tangent to the view ray, so it comes up to the crest's
  // own depth from in front and the water behind starts beyond it.
  //
  // Both halves of the band are carried separately, and it matters which does
  // what. The inner edge is the crest, and it comes from the SIGN: crest
  // pixels are whole pixels, so the sign flips in whole steps and its zero set
  // is a staircase, which the same couple of box passes the outer silhouette
  // gets turns into a ramp that crosses sub-pixel along the crest. The outer
  // edge is a distance, and it has to come from the DISTANCE — because the
  // side test only means anything near a crest. Far out in the middle of a
  // sheet the nearest crest is dozens of pixels away and whether the surface
  // happens to be deeper than that crest flips along whole contours of the
  // depth; reading the band off the signed field alone paints a hairline along
  // every one of them. Clamped past the band's own reach, the distance says
  // "outside" there and the flip has nothing to open.
  // Float32 throughout: at export size each of these is tens of megabytes,
  // and a distance in pixels needs nothing like double precision.
  const cap = wPx + 4;
  const band = new Float32Array(NP), dist = new Float32Array(NP);
  for (let p = 0; p < NP; p++) {
    const d = D[p] > cap ? cap : D[p];
    dist[p] = d;
    band[p] = zb[p] > Z[p] ? d : -d;
  }
  const tmp = scratch || new Float64Array(NP);
  blurField(band, BW, BH, tmp, 2);
  blurField(dist, BW, BH, tmp, 2);
  // …and the outer edge has to be told where the blur put the crease. A box
  // blur is exact on a ramp, which is why the signed field keeps its crossing
  // where it was; run over |distance| it lifts the fold instead — the two
  // 3-tap passes weight the pixels 1,2,3,2,1 either side of the crest, so a
  // distance that reads 0,1,2,… comes back 8/9 at the crest itself. The lift
  // is the same the whole way along, so taking it back out re-anchors the
  // outer edge to the crest, and a gap of a pixel or two still comes out a
  // band instead of a dashed line.
  // The band starts a pixel INSIDE the crest, not on it. The crest the fold
  // test finds and the silhouette the color regions are cut along are two
  // different sub-pixel estimates of the same curve — one from the mesh, one
  // from the raster's own coverage and seam fields — and they agree only to a
  // fraction of a pixel. Ending the band exactly on the first leaves a sliver
  // of the region below it uncovered wherever the second sits a hair further
  // out: a hairline of surface color inside the gap, which is the one thing
  // here that reads as dirt rather than as drawing. Overlapping the near
  // sheet covers it, and a pixel off a crest is under what the raster
  // resolves in the first place.
  for (let p = 0; p < NP; p++) {
    const inner = band[p] + CREST_OVERLAP, outer = wPx + BLUR_CREASE - dist[p];
    band[p] = inner < outer ? inner : outer;
  }
  return band;
}


// sample a ground-space function at every surface-grid vertex
function gridSamples(R, fn) {
  const n = R.GX.length, out = new Float64Array(n);
  for (let q = 0; q < n; q++) out[q] = fn(R.GX[q], R.GY[q]);
  return out;
}

// reconstruct a grid-sampled scalar at every covered pixel, Catmull-Rom in
// both axes — the smoothness that keeps a boundary curved inside one projected
// cell instead of collapsing to that cell's straight facet
function rasterField(R, vals) {
  const { NP, stride, GI, GJ, cov } = R;
  const dst = new Float32Array(NP);
  const cl = (v) => (v < 0 ? 0 : v > stride - 1 ? stride - 1 : v);
  for (let p = 0; p < NP; p++) {
    if (!cov[p]) continue;
    const fi = GI[p], fj = GJ[p];
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const tx = fi - i0, ty = fj - j0;
    const ia = cl(i0 - 1), ib = cl(i0), ic = cl(i0 + 1), id = cl(i0 + 2);
    const ra = cl(j0 - 1) * stride, rb = cl(j0) * stride, rc = cl(j0 + 1) * stride, rd = cl(j0 + 2) * stride;
    dst[p] = cr4(
      cr4(vals[ra + ia], vals[ra + ib], vals[ra + ic], vals[ra + id], tx),
      cr4(vals[rb + ia], vals[rb + ib], vals[rb + ic], vals[rb + id], tx),
      cr4(vals[rc + ia], vals[rc + ib], vals[rc + ic], vals[rc + id], tx),
      cr4(vals[rd + ia], vals[rd + ib], vals[rd + ic], vals[rd + id], tx),
      ty);
  }
  return dst;
}

// "Edge ripple" (coherence) blurs the reflected field in water space before
// the regions are cut. The flat builders do that on their own nx×ny grid; the
// 3D builders only ever see the field at mesh vertices, so without this the
// slider silently did nothing once the surface was lifted — the same scene
// lost every pass of blur the moment 3D went on, and any contour running close
// to a band boundary came back as a staircase or a run of scallops.
//
// The mesh is a different resolution from the sample grid, and a box blur's
// reach goes with the cell size, so the pass count is scaled to cover the same
// ground distance. That is also what keeps the slider meaning one thing in the
// preview and the same thing in an export traced at a finer mesh. A mesh too
// coarse to hold the blur rounds to no passes, which is right — at that point
// the mesh is already doing the smoothing.
function coherencePasses(S, gN) {
  const c = Math.max(0, S.coherence | 0);
  if (!c) return 0;
  const r = gN / Math.max(1, S.nx);
  return Math.min(60, Math.round(c * r * r));
}

// blur one mesh-vertex field in place, in water space
function meshBlur(R, vals, passes, tmp) {
  if (passes) blurField(vals, R.stride, R.stride, tmp, passes);
  return vals;
}

// ---- edge polish ---------------------------------------------------
// Smooth a reconstructed raster field before it is contoured.
//
// What is left on a distant edge once the raster is as wide as it can go is
// the field's own detail beating against the pixel grid: out there the
// reflection varies on a scale finer than a pixel, so the traced boundary
// zigzags at pixel scale. Chaikin cannot help — it converges to the spline of
// that same polyline — and neither can smoothing the path afterwards: a filter
// narrow enough to keep features cannot see wobble this wide, and a wide one is
// deleting geometry. Acting on the FIELD instead gets at it before the topology
// is decided, so a pinched-off island disappears cleanly instead of leaving a
// degenerate ring, and every threshold of the same field moves together — the
// bands stay parallel rather than drifting apart one by one.
//
// The blur has to be normalized. Running it through the uncovered pixels would
// drag every value near the water's edge toward whatever those pixels hold and
// bend the boundary there, so the coverage mask goes through the same kernel
// and divides back out.
//
// It is still a smoothing operator: at a few passes it takes the aliasing and
// little else, and by ~8 it starts fattening thin ribbons and pinching them
// into dotted chains. That is why it is an export step with a light default,
// and why the passes are counted in raster pixels — at a wider export raster
// the same feature spans more of them, so the same count erodes less.
function smoothField(field, cov, BW, BH, passes, scratch) {
  if (!passes) return;
  const NP = BW * BH;
  const num = scratch ? scratch.num : new Float32Array(NP);
  const den = scratch ? scratch.den : new Float32Array(NP);
  const tmp = scratch ? scratch.tmp : new Float32Array(NP);
  for (let p = 0; p < NP; p++) {
    const on = cov[p];
    num[p] = on ? field[p] : 0;
    den[p] = on ? 1 : 0;
  }
  blurField(num, BW, BH, tmp, passes);
  blurField(den, BW, BH, tmp, passes);
  for (let p = 0; p < NP; p++) if (cov[p] && den[p] > 1e-6) field[p] = num[p] / den[p];
}

// scratch for smoothField, allocated once per build and reused by every layer —
// at export size these are tens of megabytes apiece
function polishScratch(NP, passes) {
  return passes
    ? { num: new Float32Array(NP), den: new Float32Array(NP), tmp: new Float32Array(NP) }
    : null;
}

// {field >= t} intersected with the wave silhouette, as one smooth screen
// path. Both operands are signed distances to their own boundary, so the min
// is the intersection and the zero crossing lands on whichever edge is nearer.
//
// Inside a crest seam the field is replaced by distance to the crest, carrying
// the pixel's own sign: which side of the boundary a pixel is on is untouched
// (so no region gains or loses a pixel, and no new boundary appears where the
// two sides agree), but a boundary that does run through the seam is now
// interpolated along the smooth crest curve instead of the pixel staircase.
function contourRegion(R, field, t, iters, buf) {
  const { NP, BW, BH, cov, sil, crest } = R;
  for (let p = 0; p < NP; p++) {
    const s = sil[p];
    if (!cov[p]) { buf[p] = s; continue; }
    const v = field[p] - t;
    let b = v < s ? v : s;
    if (crest) {
      const c = crest[p];
      if (c) b = b < 0 ? -Math.abs(c) : Math.abs(c);
    }
    buf[p] = b;
  }
  const multi = d3.contours().size([BW, BH]).thresholds([0])(buf)[0];
  return contourToScreenPath(multi, BW, BH, iters);
}

// The crest gaps as one path: the band on the far side of every visible crest,
// clipped to the water by the same silhouette field the color regions use.
// Painted over the layers in the background color it is precisely the hole
// they would leave if the surface occluded that little bit further, and it
// costs one path rather than a re-cut of every layer.
function gapRegion(R, iters, buf) {
  if (!R.gap) return null;
  const { NP, BW, BH, sil, gap } = R;
  for (let p = 0; p < NP; p++) { const s = sil[p], g = gap[p]; buf[p] = g < s ? g : s; }
  const multi = d3.contours().size([BW, BH]).thresholds([0])(buf)[0];
  return contourToScreenPath(multi, BW, BH, iters);
}

// Preset / 1D path: one continuous scalar (the reflected elevation), contoured
// at the palette's band boundaries into nested upper sets, plus the occluded
// Fresnel bands. `scalarAt`/`fresAt` are sampled at ground points.
function buildSurface3D(S, fit, opts) {
  const { scalarAt, thresholds, fresAt, fresThresholds,
          gN = 140, BW = 420, polish = 0, gap = 0 } = opts;
  const R = rasterizeSurface(S, fit, gN, BW, true, gap);
  const iters = S.smooth || 0;
  const buf = new Float64Array(R.NP);
  const scratch = polishScratch(R.NP, polish);
  const coh = coherencePasses(S, gN);
  const cbuf = coh ? new Float64Array(R.stride * R.stride) : null;
  const fs = rasterField(R, meshBlur(R, gridSamples(R, scalarAt), coh, cbuf));
  // one scalar carries every band here, so polishing it once moves all of them
  // together and the bands stay parallel
  smoothField(fs, R.cov, R.BW, R.BH, polish, scratch);
  const layers = thresholds.map((t) => contourRegion(R, fs, t, iters, buf));
  let fres = null;
  if (fresAt) {
    const ff = rasterField(R, meshBlur(R, gridSamples(R, fresAt), coh, cbuf));
    smoothField(ff, R.cov, R.BW, R.BH, polish, scratch);
    fres = fresThresholds.map((t) => contourRegion(R, ff, t, iters, buf));
  }
  return { layers, fres, gap: gapRegion(R, iters, buf) };
}

// 2D panorama path: no single scalar exists, so take the flat path's stack of
// per-color signed distance fields (panoramaStack / eachPanoramaLayer) and
// compose each one through the reflection at the visible surface point — the
// same construction buildSegmentation uses, evaluated on the occluded raster
// instead of the flat water grid. `uvAt` returns the reflected panorama
// coordinate in cells, matching buildSegmentation's fG/fF.
function buildSurface3DPanorama(S, fit, opts) {
  const { uvAt, env2d, fresAt, fresThresholds,
          gN = 140, BW = 420, polish = 0, gap = 0 } = opts;
  const R = rasterizeSurface(S, fit, gN, BW, true, gap);
  const { NP, BH, cov, sil, crest } = R;
  const iters = S.smooth || 0;
  const stack = panoramaStack(env2d);
  const { EW, EH, colorOf, order, K } = stack;

  const nv = R.GX.length;
  const su = new Float64Array(nv), sv = new Float64Array(nv);
  for (let q = 0; q < nv; q++) {
    const uv = uvAt(R.GX[q], R.GY[q]); su[q] = uv[0]; sv[q] = uv[1];
  }
  const coh = coherencePasses(S, gN);
  const cbuf = coh ? new Float64Array(R.stride * R.stride) : null;
  meshBlur(R, su, coh, cbuf); meshBlur(R, sv, coh, cbuf);
  const fu = rasterField(R, su), fv = rasterField(R, sv);

  // bilinear taps into panorama space, shared by every layer
  const tap = new Int32Array(NP), tx = new Float32Array(NP), ty = new Float32Array(NP);
  for (let p = 0; p < NP; p++) {
    if (!cov[p]) continue;
    let x = fu[p] - 0.5; x = x < 0 ? 0 : x > EW - 1 ? EW - 1 : x;
    let y = fv[p] - 0.5; y = y < 0 ? 0 : y > EH - 1 ? EH - 1 : y;
    const i0 = Math.min(EW - 2, Math.floor(x)), j0 = Math.min(EH - 2, Math.floor(y));
    tap[p] = j0 * EW + i0; tx[p] = x - i0; ty[p] = y - j0;
  }

  const buf = new Float64Array(NP);
  const layers = new Array(K);
  // Polishing here works per layer, because a painted panorama has no single
  // scalar to polish — each color carries its own distance field. Adjacent
  // bands still hold together: where two of them share a boundary their fields
  // are each other's negation across it, and the blur is linear, so the two
  // smoothed fields keep crossing zero in the same place.
  const scratch = polishScratch(NP, polish);
  const fld = polish ? new Float32Array(NP) : null;
  eachPanoramaLayer(stack, (k, D) => {
    if (polish) {
      for (let p = 0; p < NP; p++) {
        if (!cov[p]) { fld[p] = 0; continue; }
        const q = tap[p], fx = tx[p], fy = ty[p];
        fld[p] = (D[q] * (1 - fx) + D[q + 1] * fx) * (1 - fy)
               + (D[q + EW] * (1 - fx) + D[q + EW + 1] * fx) * fy;
      }
      smoothField(fld, cov, BW, BH, polish, scratch);
    }
    for (let p = 0; p < NP; p++) {
      const s = sil[p];
      if (!cov[p]) { buf[p] = s; continue; }
      let d;
      if (polish) d = fld[p];
      else {
        const q = tap[p], fx = tx[p], fy = ty[p];
        d = (D[q] * (1 - fx) + D[q + 1] * fx) * (1 - fy)
          + (D[q + EW] * (1 - fx) + D[q + EW + 1] * fx) * fy;
      }
      let b = d < s ? d : s;
      if (crest) {                            // snap seam crossings to the crest
        const c = crest[p];
        if (c) b = b < 0 ? -Math.abs(c) : Math.abs(c);
      }
      buf[p] = b;
    }
    const multi = d3.contours().size([BW, BH]).thresholds([0])(buf)[0];
    layers[k] = { d: contourToScreenPath(multi, BW, BH, iters), color: colorOf[order[k]] };
  });

  let fres = null;
  if (fresAt) {
    const ff = rasterField(R, meshBlur(R, gridSamples(R, fresAt), coh, cbuf));
    smoothField(ff, cov, BW, BH, polish, scratch);
    fres = fresThresholds.map((t) => contourRegion(R, ff, t, iters, buf));
  }
  return { bg: colorOf[order[0]], layers: layers.filter((l) => l.d), fres,
           gap: gapRegion(R, iters, buf) };
}

// One 3D-solid pass at a given raster: hidden-surface removal, then the usual
// smooth contouring on top. Whichever field the mode carries picks the builder,
// and the result — { bg, layers, fres } — slots straight into the same render
// path the flat layers use. The live preview and the SVG export both come
// through here, so an export traced at a wider raster is the same picture, only
// resolved finer.
// `raster` is { gN, BW } plus an optional `polish` pass count and `gap` width,
// and rides through to whichever builder the mode picks.
function buildSolid3D(S, fieldSpec, raster) {
  const fit = computeFit(S);
  prepField(S);
  const { uvAt, env2d, scalarAt, thresholds, cols, fresAt, fresThresholds } = fieldSpec;
  // painted panorama: same outlines as the flat 2D render, now stopping at
  // the wave crests in front of them
  if (uvAt) return buildSurface3DPanorama(S, fit, { uvAt, env2d, fresAt, fresThresholds, ...raster });
  // preset / paint1d: the wave silhouette does the occlusion. Lowest band
  // shows the background, exactly like the flat render, so no base layer.
  const { layers, fres, gap } = buildSurface3D(S, fit, { scalarAt, thresholds, fresAt, fresThresholds, ...raster });
  return { bg: cols[0], layers: layers.map((d, k) => ({ d, color: cols[k + 1] })), fres, gap };
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

// ---- slanted-hatch pen style --------------------------------------
// The engraver's convention: cut the picture into regions and fill each one
// with straight parallel strokes at its OWN angle. Nothing draws the boundary
// between two regions — the change of slant is what the eye reads as an edge,
// the way a wood engraving or a hatched plotter print does. So the edges cost
// no ink, and the plot stays one stroke width throughout.
//
// Unlike the other two pen styles this one works in SCREEN space, on the same
// z-buffered surface raster the filled 3D mode is contoured from. Three things
// fall out of that, and none of them come free the other way round:
//
//  * Strokes are evenly spaced across the whole frame. A spacing measured in
//    ground cells (what the ring style uses) bunches to nothing at the horizon
//    and sprawls in the near field; hatching wants an even weave, because its
//    density is what reads as tone.
//  * Hidden-line removal is already done. A raster pixel only ever holds the
//    front-most sheet, so a region simply stops where a nearer crest starts —
//    there is no separate occlusion pass and no `hidden` option.
//  * A region is a connected patch of the PICTURE, not of the ground plane.
//    That is what an engraver's region is: the far side of a crest and the
//    near sheet in front of it are two regions even when they carry one color.
//
// The strokes themselves stay straight in the picture plane — they are not
// bent onto the wave. The form is carried by the region shapes and by the
// slant changing across them, which is the whole point of the technique; a
// hatch that also followed the surface would be doing the ring style's job.
const HATCH_MIN_AREA = 5;      // px: below this a patch is speckle, not a region
const HATCH_STEP = 0.55;       // px along a stroke, walking a region's mask
const HATCH_MAX_LINES = 4000;  // per region, a guard against a tiny spacing

// principal direction of a 2×2 symmetric tensor, in degrees, and how strongly
// it is one direction rather than none: (λ₁−λ₂)/(λ₁+λ₂), which is 0 for a
// round blob and 1 for a line. An isotropic region has no axis worth using,
// and this is what fades its angle back to the base one instead of letting
// numerical noise pick a slant for it.
function tensorAxis(Jxx, Jxy, Jyy) {
  const tr = Jxx + Jyy;
  return {
    deg: (0.5 * Math.atan2(2 * Jxy, Jxx - Jyy) * 180) / Math.PI,
    coh: tr > 1e-12 ? Math.hypot(Jxx - Jyy, 2 * Jxy) / tr : 0,
  };
}

// fold an angle difference into (−90, 90]: hatch strokes have no head or tail,
// so a slant and that slant plus 180° are the same stroke
function foldAngle(a) { return (((a + 90) % 180) + 180) % 180 - 90; }

// stable per-region jitter for the "scattered" aim. Keyed on the region's
// rounded centroid rather than on its index in the scan, so nudging an
// unrelated slider doesn't re-deal every angle in the frame.
function hatchHash(x, y, id) {
  let h = (Math.round(x / 4) * 73856093) ^ (Math.round(y / 4) * 19349663) ^ (id * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function relLum(c) {
  const s = d3.rgb(c);
  return (0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b) / 255;
}

// Where each region's deviation from the base angle comes from. Ordered as the
// UI shows them: the two that read the picture first, the one that doesn't last.
const HATCH_AIMS = [
  ["wave", "Wave", "strokes run across the local slope, so the weave bends with the swell"],
  ["shape", "Shape", "strokes run along each region's own long axis, so a sliver is hatched lengthwise"],
  ["scatter", "Scatter", "each region takes an arbitrary slant — the plainest woodcut reading of an edge"],
];

function buildPenHatch(S, fit, colorAt, opts) {
  const { spacing, relief, threeD, angleDeg, spreadDeg, aim, tone, paper, BW, gN } = opts;
  // the raster carries the front-most surface point's grid coordinate, so the
  // color, the height and the occlusion all come off one pass
  const R = rasterizeSurface(threeD ? { ...S, waveScale: relief } : S, fit, gN, BW, threeD);
  const { BH, NP, GI, GJ, cov } = R;
  const groundAt = (p) => cell2ground((GI[p] / gN) * S.nx, (GJ[p] / gN) * S.ny, S);

  // ---- what color each pixel of the visible surface is
  const cmap = new Map(), palette = [];
  const idxField = new Int32Array(NP).fill(-1);
  for (let p = 0; p < NP; p++) {
    if (!cov[p]) continue;
    const [gx, gy] = groundAt(p);
    const c = colorAt(gx, gy);
    let id = cmap.get(c);
    if (id === undefined) { id = palette.length; cmap.set(c, id); palette.push(c); }
    idxField[p] = id;
  }

  // ---- screen-space gradient of the wave height, for the "wave" aim.
  // Sampled off the mesh through the raster's own grid coordinates, so it is
  // the height of the point actually visible at that pixel — across a crest
  // silhouette the two sheets keep their own slopes instead of averaging.
  let HGX = null, HGY = null;
  if (aim === "wave") {
    const stride = gN + 1;
    const HG = new Float64Array(stride * stride);
    for (let j = 0; j <= gN; j++) for (let i = 0; i <= gN; i++) {
      const [gx, gy] = cell2ground((i / gN) * S.nx, (j / gN) * S.ny, S);
      HG[j * stride + i] = heightAt(gx, gy, S);
    }
    const HR = new Float64Array(NP);
    for (let p = 0; p < NP; p++) {
      if (!cov[p]) continue;
      const fi = Math.max(0, Math.min(gN - 1e-6, GI[p])), fj = Math.max(0, Math.min(gN - 1e-6, GJ[p]));
      const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0, q = j0 * stride + i0;
      HR[p] = (HG[q] * (1 - tx) + HG[q + 1] * tx) * (1 - ty)
            + (HG[q + stride] * (1 - tx) + HG[q + stride + 1] * tx) * ty;
    }
    HGX = new Float64Array(NP); HGY = new Float64Array(NP);
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      const p = y * BW + x;
      if (!cov[p]) continue;
      // one-sided at the water's edge: an uncovered neighbour holds no height
      const xm = x > 0 && cov[p - 1] ? p - 1 : p, xp = x < BW - 1 && cov[p + 1] ? p + 1 : p;
      const ym = y > 0 && cov[p - BW] ? p - BW : p, yp = y < BH - 1 && cov[p + BW] ? p + BW : p;
      const hx = xp - xm, hy = (yp - ym) / BW;      // 0, 1 or 2 pixels apart
      HGX[p] = hx ? (HR[xp] - HR[xm]) / hx : 0;
      HGY[p] = hy ? (HR[yp] - HR[ym]) / hy : 0;
    }
  }

  // ---- connected regions of one color, with the moments each aim needs
  const label = new Int32Array(NP).fill(-1);
  const stack = new Int32Array(NP);
  const comps = [];
  for (let seed = 0; seed < NP; seed++) {
    if (idxField[seed] < 0 || label[seed] >= 0) continue;
    const id = idxField[seed], ci = comps.length;
    let sp = 0; stack[sp++] = seed; label[seed] = ci;
    let area = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    let jxx = 0, jxy = 0, jyy = 0;
    let x0 = BW, x1 = -1, y0 = BH, y1 = -1;
    while (sp) {
      const p = stack[--sp], x = p % BW, y = (p - x) / BW;
      area++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (HGX) { const a = HGX[p], b = HGY[p]; jxx += a * a; jxy += a * b; jyy += b * b; }
      if (x > 0 && idxField[p - 1] === id && label[p - 1] < 0) { label[p - 1] = ci; stack[sp++] = p - 1; }
      if (x < BW - 1 && idxField[p + 1] === id && label[p + 1] < 0) { label[p + 1] = ci; stack[sp++] = p + 1; }
      if (y > 0 && idxField[p - BW] === id && label[p - BW] < 0) { label[p - BW] = ci; stack[sp++] = p - BW; }
      if (y < BH - 1 && idxField[p + BW] === id && label[p + BW] < 0) { label[p + BW] = ci; stack[sp++] = p + BW; }
    }
    const cx = sx / area, cy = sy / area;
    comps.push({
      id, area, cx, cy, x0, x1, y0, y1,
      cov: [sxx / area - cx * cx, sxy / area - cx * cy, syy / area - cy * cy],
      grad: HGX ? [jxx, jxy, jyy] : null,
    });
  }

  // ---- each region's slant.
  // The aim only ever supplies a deviation from the base angle, scaled by the
  // spread: at spread 0 the whole frame is one flat hatch, at 90° each region
  // sits on the angle its own aim asked for. That keeps the base angle the
  // thing that sets the picture's grain, and the spread the thing that decides
  // how much the regions are allowed to argue with it.
  const angleOf = (c) => {
    let u;
    if (aim === "scatter") u = 2 * hatchHash(c.cx, c.cy, c.id) - 1;
    else {
      const t = aim === "wave" ? tensorAxis(c.grad[0], c.grad[1], c.grad[2])
                               : tensorAxis(c.cov[0], c.cov[1], c.cov[2]);
      // "wave": the tensor's axis is the steepest-slope direction, and hatching
      // across the slope reads as form, so the strokes run 90° off it.
      // "shape": it is the region's own long axis, and strokes run along it.
      const want = aim === "wave" ? t.deg + 90 : t.deg;
      u = (foldAngle(want - angleDeg) / 90) * t.coh;
    }
    return ((angleDeg + spreadDeg * u) * Math.PI) / 180;
  };

  // ---- tone: how far a region's color is from the paper decides its density.
  // On white stock a near-white region wants almost no ink and a dark one wants
  // a tight weave; that difference is most of what makes a hatched print read
  // as a picture rather than as a texture. At tone 0 every region is woven the
  // same and only the slant carries the drawing.
  const paperLum = relLum(paper);
  const spaceCache = new Map();
  const spacingFor = (id) => {
    let s = spaceCache.get(id);
    if (s === undefined) {
      const contrast = Math.min(1, Math.abs(relLum(palette[id]) - paperLum) / 0.75);
      s = spacing * (1 + tone * 2.2 * (1 - contrast));
      spaceCache.set(id, s);
    }
    return s;
  };

  const kx = VB_W / BW, ky = VB_H / BH;
  const byColor = new Map();
  const add = (color, sub) => { const a = byColor.get(color) || []; a.push(sub); byColor.set(color, a); };
  // Two decimals, as elsewhere in the export: a stroke is often only a couple
  // of viewBox units long, and a tenth of a unit at each end tilts one of those
  // by degrees. On a style whose entire signal is a consistent slant per
  // region, that is the last thing to round away.
  const pt = (x, y) => (x * kx).toFixed(2) + " " + (y * ky).toFixed(2) + " ";

  for (let ci = 0; ci < comps.length; ci++) {
    const c = comps[ci];
    if (c.area < HATCH_MIN_AREA) continue;
    // A region's own mask is a staircase of whole pixels, and a stroke that
    // stopped on it would end on a pixel edge — a ragged rim along every
    // boundary, at exactly the raster's pitch. Blur the mask into a ramp and
    // take the half crossing instead: the ends land sub-pixel on the curve the
    // boundary actually is, which is the same trick the filled path's
    // silhouette uses.
    const PAD = 2;
    const w = c.x1 - c.x0 + 1 + 2 * PAD, h = c.y1 - c.y0 + 1 + 2 * PAD;
    const ox = c.x0 - PAD, oy = c.y0 - PAD;
    const ind = new Float64Array(w * h);
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++)
      if (label[y * BW + x] === ci) ind[(y - oy) * w + (x - ox)] = 1;
    blurField(ind, w, h, new Float64Array(w * h), 1);
    const sample = (u, v) => {
      if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return 0;
      const i0 = Math.floor(u), j0 = Math.floor(v);
      const i1 = Math.min(w - 1, i0 + 1), j1 = Math.min(h - 1, j0 + 1);
      const tx = u - i0, ty = v - j0;
      return (ind[j0 * w + i0] * (1 - tx) + ind[j0 * w + i1] * tx) * (1 - ty)
           + (ind[j1 * w + i0] * (1 - tx) + ind[j1 * w + i1] * tx) * ty;
    };

    const th = angleOf(c), dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
    let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (const [x, y] of [[ox, oy], [ox + w, oy], [ox, oy + h], [ox + w, oy + h]]) {
      const s = x * dx + y * dy, t = x * nx + y * ny;
      if (s < sMin) sMin = s; if (s > sMax) sMax = s;
      if (t < tMin) tMin = t; if (t > tMax) tMax = t;
    }
    // Phase the stroke set off the region's centroid, not off the frame: a
    // region thinner than the spacing then always has one stroke through its
    // middle instead of falling between two and vanishing. The far field is
    // full of such slivers.
    const step = spacingFor(c.id);
    const tc = c.cx * nx + c.cy * ny;
    const k0 = Math.ceil((tMin - tc) / step), k1 = Math.floor((tMax - tc) / step);
    // Where the water runs off the edge of the raster its mask ends on the
    // frame, and the blurred ramp puts a boundary there like any other — half a
    // pixel OUTSIDE it, which is what makes the weave reach the edge rather than
    // stop a hair short of it. The stroke itself still has to stay on the page,
    // so every span is clipped to the frame: a plotter would otherwise be asked
    // to draw off the sheet.
    const slab = (hi, b, d) => {
      if (Math.abs(d) < 1e-9) return b >= 0 && b <= hi ? [-Infinity, Infinity] : null;
      const a = -b / d, z = (hi - b) / d;
      return a < z ? [a, z] : [z, a];
    };
    const parts = [];
    const emit = (bx, by, lo0, hi0, clipLo, clipHi) => {
      const lo = Math.max(lo0, clipLo), hi = Math.min(hi0, clipHi);
      if (hi - lo > 0.4)
        parts.push("M" + pt(bx + lo * dx, by + lo * dy) + "L" + pt(bx + hi * dx, by + hi * dy));
    };
    for (let k = k0; k <= k1 && k - k0 < HATCH_MAX_LINES; k++) {
      const t = tc + k * step;
      const bx = t * nx, by = t * ny;
      const spanX = slab(BW - 1, bx, dx), spanY = slab(BH - 1, by, dy);
      if (!spanX || !spanY) continue;
      const clipLo = Math.max(spanX[0], spanY[0]), clipHi = Math.min(spanX[1], spanY[1]);
      if (clipHi <= clipLo) continue;
      let prevV = 0, prevS = sMin - HATCH_STEP, inRun = false, aS = 0;
      for (let s = sMin - HATCH_STEP; s <= sMax + HATCH_STEP; s += HATCH_STEP) {
        const v = sample(bx + s * dx - ox, by + s * dy - oy);
        if (!inRun && v >= 0.5) {
          const f = (0.5 - prevV) / ((v - prevV) || 1);
          aS = prevS + (s - prevS) * Math.max(0, Math.min(1, f));
          inRun = true;
        } else if (inRun && v < 0.5) {
          const f = (prevV - 0.5) / ((prevV - v) || 1);
          emit(bx, by, aS, prevS + (s - prevS) * Math.max(0, Math.min(1, f)), clipLo, clipHi);
          inRun = false;
        }
        prevV = v; prevS = s;
      }
      if (inRun) emit(bx, by, aS, prevS, clipLo, clipHi);
    }
    if (parts.length) add(palette[c.id], parts.join(""));
  }
  return [...byColor.entries()].map(([color, subs]) => ({ color, d: subs.join("") }));
}

// Resolution of the 3D surface pass, as named steps. `BW` is the width of the
// screen-space raster the regions are contoured on, `gN` the tessellation of
// the wave surface fed into it — the two limits on how fine a 3D edge can be,
// so they move together. "normal" is the long-standing default and "draft" is
// what low-power mode pins to, both unchanged; the steps above them exist for
// stills and print, where a slow render is worth a cleaner outline. Cost grows
// with BW² (every color layer is contoured over the whole raster), so the top
// steps are export settings, not interactive ones.
const RASTER_LEVELS = [
  { name: "draft",  BW: 320,  gN: 110 },
  { name: "normal", BW: 440,  gN: 150 },
  { name: "fine",   BW: 640,  gN: 200 },
  { name: "high",   BW: 900,  gN: 260 },
  { name: "print",  BW: 1300, gN: 320 },
  { name: "max",    BW: 1900, gN: 400 },
];
const RASTER_DEFAULT = 1;   // "normal"

// Export detail: the raster the *exported* SVG is traced on, as a multiple of
// the preview's.
//
// An exported region outline is a curve fitted to a marching-squares crossing
// per raster pixel, so one raster pixel is the finest — and the smoothest —
// thing the file can say. On screen that is invisible: the preview panel is
// about as wide as the raster. The SVG is not; it gets opened full-screen,
// zoomed into and printed, and at 4× the panel's width every pixel-scale
// decision is 4 pixels tall. That is the wobble along a distant crest: not a
// coarser surface out there (nothing downsamples with range), just the raster
// grid seen from close up.
//
// Retracing the 3D pass wider on the way out fixes it in proportion — the
// preview stays interactive, and one slow pass buys an edge that holds up
// magnified. The mesh (`gN`) deliberately does NOT follow the width: a finer
// mesh packs more surface rows into each raster pixel, and the far field, where
// a pixel already straddles many rows, comes out noisier rather than smoother.
// Only the raster width helps, so only it scales.
const EXPORT_MULTS = [1, 2, 3];
const EXPORT_DEFAULT = 1;      // 2x
// ~9.5M pixels at 16:10. Every layer allocates a full-frame Float64 buffer, so
// this is about as far as a browser tab goes before it starts swapping.
const EXPORT_MAX_BW = 3800;

// Export mesh: the other half of the same trade, and the one that costs
// something. The raster decides how finely an outline is DRAWN; `gN` decides
// how much surface detail there is to draw, and the levels raise it faster than
// any raster can resolve — at a fixed width, a coarser mesh traces visibly
// cleaner edges than a fine one. Standing the mesh down on export is therefore
// a second, independent lever on the same jagged edge.
//
// It is off by default because it is NOT the same picture: unlike the width,
// which resolves the preview's outlines more exactly, a coarser mesh smooths
// the surface itself — crests round off a little and the smallest far-field
// wavelets stop being resolved at all. That is a look, not a fidelity setting,
// so it stays something you ask for. Below MESH_FLOOR the water stops reading
// as water, so the scale never goes there however coarse the step.
const EXPORT_MESHES = [
  { name: "as previewed", f: 1 },
  { name: "softened",     f: 0.7 },
  { name: "smoothed",     f: 0.5 },
];
const EXPORT_MESH_DEFAULT = 0;   // as previewed
const EXPORT_MESH_FLOOR = 110;   // "draft"'s mesh: the coarsest that still holds a wave

// Export edge polish: box-blur passes over the reconstructed field before it is
// contoured (see smoothField). This is the lever that still bites once the
// raster is at its cap — the wobble left there is pixel-scale, and this is the
// only step that acts at that scale without deleting the feature under it.
// Light is the default because at export width it takes the aliasing and little
// else; strong is for a still that has to hold up very large, at the price of
// the thinnest ribbons.
const EXPORT_POLISH = [
  { name: "off",    passes: 0 },
  { name: "light",  passes: 3 },
  { name: "strong", passes: 8 },
];
const EXPORT_POLISH_DEFAULT = 1;   // light
function exportRaster(level, mult, meshF = 1) {
  return {
    gN: Math.max(Math.min(level.gN, EXPORT_MESH_FLOOR), Math.round(level.gN * meshF)),
    BW: Math.min(EXPORT_MAX_BW, Math.round(level.BW * mult)),
  };
}

// ---- PNG export ---------------------------------------------------
// The same picture as the preview, rasterized instead of traced.
//
// Every export step above this one exists to keep a *vector* edge from crawling
// when the file is magnified. An outline in the SVG is a curve through one
// crossing per raster pixel, so the raster's own grid is visible in the file,
// and polish — a blur of the field before the regions are cut — is what takes
// the last of it. A glint, a few raster pixels of a lighter band caught on one
// crest, is exactly what that blur cannot tell from aliasing: it goes, and the
// file is quietly less than what was on screen.
//
// A raster output has no such problem. There is no outline to wobble, only
// pixels, and the ones along an edge get averaged by the rasterizer rather than
// decided by it. So this path runs no polish and no mesh stand-down: it is the
// preview's own geometry at print size. The one export step it does keep is the
// width multiplier, which resolves the same picture finer rather than smoothing
// it — and which the larger scales need, since a preview-raster stair is as
// many output pixels tall as the scale makes it.
const PNG_SCALES = [2, 3, 4, 6];
const PNG_DEFAULT = 2;     // 4x — 3040 x 2000
// Safari, on iOS especially, hands back a blank canvas past ~16.7M pixels
// rather than refusing, so the scale is clamped to fit instead of trusted. The
// top step above sits just under the cap at the current frame; the clamp is
// what keeps that true if the frame ever changes shape.
const PNG_MAX_PIXELS = 16.5e6;
function pngSize(scale) {
  const s = Math.min(scale, Math.sqrt(PNG_MAX_PIXELS / (VB_W * VB_H)));
  // floor, not round: rounding a clamped scale can land a pixel over the cap
  return { w: Math.floor(VB_W * s), h: Math.floor(VB_H * s), capped: s < scale - 1e-9 };
}

// An <img> needs the markup to state its own pixel size: a viewBox alone leaves
// the intrinsic size to the browser, which is where a 300x150 default comes
// from. Same string, same picture — only sized.
function sizedSvg(svg, w, h) {
  return svg.replace(/^<svg /, `<svg width="${w}" height="${h}" `);
}

// SVG string -> a canvas holding it at w x h.
//
// The picture goes through an <img> rather than being redrawn onto the canvas
// by hand, so the browser's own SVG rasterizer resolves it — the same one that
// composites the preview, with the same antialiasing, fill rules and clips. The
// raster is therefore the preview with more pixels, not a second renderer's
// opinion of it. The markup references nothing external, so the data URL counts
// as same-origin and the canvas stays untainted (toBlob throws otherwise).
//
// `into` reuses a canvas across calls, which is what the video export wants:
// one allocation for a couple of hundred frames rather than one apiece.
function svgToCanvas(svg, w, h, into) {
  return new Promise((resolve, reject) => {
    let canvas = into || null, ctx = null;
    try {
      if (!canvas) canvas = document.createElement("canvas");
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx = canvas.getContext("2d");
    } catch (e) { ctx = null; }
    // no 2D context (jsdom, a locked-down sandbox) means no rasterizer at all —
    // fail here rather than waiting on an onload that is never coming
    if (!ctx) { reject(new Error("no canvas")); return; }
    const img = new Image();
    img.onload = () => {
      try {
        // a reused canvas still holds the frame before this one; anything the
        // new picture does not cover should read as empty, not as a ghost
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error("svg decode failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(sizedSvg(svg, w, h));
  });
}

// SVG string -> PNG blob at w x h.
function svgToPngBlob(svg, w, h) {
  return svgToCanvas(svg, w, h).then((canvas) => new Promise((resolve, reject) => {
    if (!canvas.toBlob) { reject(new Error("no canvas")); return; }
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png");
    } catch (e) { reject(e); }
  }));
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
  prepField(S);
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
  // "edge ripple" (coherence): box-blur the reflected-elevation field in water
  // space, exactly as the 2D/panorama path does. Without this the 1D path
  // silently ignored the slider, so the whole surface snapped between sharp
  // (no object) and smoothed (an object forces the 2D path) — the reflection
  // far from the object visibly degrading even though nothing there changed.
  // lo/hi stay the raw range (computed above), so auto-fit is unaffected.
  const passes = Math.max(0, S.coherence | 0);
  if (passes) {
    const tmp = new Float64Array(nx * ny);
    blurField(values, nx, ny, tmp, passes);
    if (wVals) blurField(wVals, nx, ny, tmp, passes);
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

// Distinct panorama colors, stacked bottom-up by the mean elevation row of
// their painted cells — the 2D generalization of the 1D band order.
function panoramaStack(env2d) {
  const { w: EW, h: EH, cells } = env2d;
  const colorId = new Map(), colorOf = [], areas = [];
  const labels = new Int32Array(EW * EH);
  for (let p = 0; p < EW * EH; p++) {
    const c = cells[p];
    let id = colorId.get(c);
    if (id === undefined) { id = colorOf.length; colorId.set(c, id); colorOf.push(c); areas.push(0); }
    labels[p] = id; areas[id]++;
  }
  const K = colorOf.length;
  const rowSum = new Float64Array(K);
  for (let p = 0; p < EW * EH; p++) rowSum[labels[p]] += (p / EW) | 0;
  const order = d3.range(K).sort((a, b) => rowSum[a] / areas[a] - rowSum[b] / areas[b]);
  return { EW, EH, cells, labels, colorOf, areas, order, K };
}

// Walk the stack from the top down, handing each layer its signed distance
// field in panorama cells: >0 inside, <0 outside, zero crossing on the painted
// boundary. Layer k is the UNION of color k and every color above it, so like
// the 1D upper sets each layer solidly contains the next — smoothing can shift
// a shared edge but can never open a background seam between neighbours.
// Composing this field through the reflection and contouring it at zero is
// what keeps a painted region's boundary a smooth curve rather than a trace of
// the panorama's cell grid; both the flat path and the 3D surface use it.
function eachPanoramaLayer(stack, visit) {
  const { EW, EH, labels, order, K } = stack;
  const N = EW * EH;
  const union = new Float64Array(N), inv = new Float64Array(N);
  const D0 = new Float64Array(N), tmpP = new Float64Array(N);
  for (let k = K - 1; k >= 0; k--) {   // top of the stack down, growing the union
    for (let p = 0; p < N; p++) {
      if (labels[p] === order[k]) union[p] = 1;
      inv[p] = 1 - union[p];
    }
    const D = distTransform(union, EW, EH), Dout = distTransform(inv, EW, EH);
    let thick = 0;
    for (let p = 0; p < N; p++) { D[p] -= Dout[p]; if (D[p] > thick) thick = D[p]; }
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
      for (let p = 0; p < N; p++) D0[p] = D[p];
      blurField(D, EW, EH, tmpP, 1);
      for (let p = 0; p < N; p++) {
        if (D0[p] >= 1 && D[p] < 0.25) D[p] = 0.25;
        else if (D0[p] <= -1 && D[p] > -0.25) D[p] = -0.25;
      }
    }
    visit(k, D);
  }
}

function buildSegmentation(S, env2d, azSpan) {
  const { nx, ny } = S;
  prepField(S);
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

  // distinct panorama colors, stacked bottom-up by painted elevation
  const stack = panoramaStack(env2d);
  const { colorOf, order, K } = stack;

  if (K <= SEG_MAX_COLORS) {
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
    eachPanoramaLayer(stack, (k, D) => {
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
    });
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
  computeFit, cell2ground, heightAt, clampLift, penProject, reflectAt, magFrac,
  withWakes, newWake, WAKE_ANGLE_DEG, prepField, slopeAt,
  buildSurface3D, buildSurface3DPanorama, buildSolid3D, crestField,
  buildPenLines, buildPenConcentric, buildPenHatch, HATCH_AIMS,
  RASTER_LEVELS, RASTER_DEFAULT, EXPORT_MULTS, EXPORT_DEFAULT, EXPORT_MAX_BW,
  EXPORT_MESHES, EXPORT_MESH_DEFAULT, EXPORT_MESH_FLOOR, exportRaster,
  EXPORT_POLISH, EXPORT_POLISH_DEFAULT, smoothField,
  PNG_SCALES, PNG_DEFAULT, PNG_MAX_PIXELS, pngSize, sizedSvg, svgToPngBlob, svgToCanvas,
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
// A sheet's outline is contoured with the same d3.contours + Chaikin + bezier
// pipeline as the union layers, so edges stay smooth and correctly projected.
// The graph algorithms (region labeling, denoise, and the peel-order
// planner — greedy + budgeted exact search) live in paperStack.js.
//
// What the regions are labeled ON is the other half of the story. The stack
// used to be planned on the water's GROUND grid, which quietly cost it every
// property the SVG export had gained: colors were read on the flat plane (so
// the sheets ignored the 3D relief), each layer was lifted and projected
// independently (so a wave's hidden far side was cut as a hole overlapping the
// crest in front of it), and the whole plane was planned and emitted even when
// the camera was zoomed into a corner of it. It is now labeled on the SCREEN
// raster instead — buildPaperImage below — which is the same z-buffered
// surface raster the 3D-solid render contours. All three follow from that.

const PAPER_FRAME_COLOR = "#ff2d78"; // fallback registration color if no background

// Smallest feature the stack will keep, as a fraction of the frame's area:
// anything smaller is merged into its biggest neighbour. Scale-free on purpose
// — the minimum cuttable feature is a property of the picture (and of scissors)
// rather than of the raster it happens to be sampled on, so raising the
// resolution buys smoother cut lines, not more speckle to cut out.
const PAPER_MIN_FEATURE = 2.6e-4;

// Cap on the raster the stack is planned on. The "3D surface detail" slider
// drives it (same picture as the render), but the top steps exist to sharpen a
// crest line by a fraction of a pixel — here they would only mean labeling and
// planning millions of pixels for cut lines nobody can cut that finely.
const PAPER_MAX_BW = 560;

// How many colors of paper the stack may call for. Screen colors are free and
// paper colors are not: a smooth gradient — which is what a preset palette
// becomes the moment a reflected object forces the panorama path, and what any
// "melted" painted panorama is — hands the planner dozens of near-identical
// shades, and each one costs at least a sheet (usually several, since a color
// reappearing at another depth needs its own). Posterizing first is what makes
// the difference between a buildable stack and a two-hundred-sheet answer to a
// question nobody asked: on the default scene (a preset palette turned into a
// panorama by the reflected sailboat, times three Fresnel bands) the same
// picture costs 191 sheets ungraded, 34 at 16 colors, and 16 at this cap — the
// knee of that curve, and still above the default band count, so an ordinarily
// banded palette passes through untouched.
const PAPER_MAX_COLORS = 12;

// Weighted k-means in Lab over the DISTINCT colors of the image — a few dozen
// points, so this is trivial next to everything around it. Deterministic
// throughout: seeded by area, then k-means++ by weighted distance², and each
// final center snapped to a real color of the picture, because the answer has
// to be a color you can buy paper in, not a cluster mean.
// `keep` (the mount's color) always survives as its own representative: the
// frame sheet is drawn in it whatever happens, and the background regions have
// to keep matching it or the water edge gets cut a second time.
function reducePaperPalette(palette, counts, K, keep = -1) {
  const n = palette.length;
  if (n <= K) return null;
  const L = palette.map((c) => { const l = d3.lab(c); return [l.l, l.a, l.b]; });
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

  let seed = keep >= 0 ? keep : 0;
  if (keep < 0) for (let i = 1; i < n; i++) if (counts[i] > counts[seed]) seed = i;
  const centers = [L[seed].slice()];
  const near = L.map((p) => d2(p, centers[0]));
  while (centers.length < K) {
    let best = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const s = counts[i] * near[i];
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best < 0 || bestScore <= 0) break;
    centers.push(L[best].slice());
    for (let i = 0; i < n; i++) {
      const dd = d2(L[i], centers[centers.length - 1]);
      if (dd < near[i]) near[i] = dd;
    }
  }

  const k = centers.length;
  const owner = new Int32Array(n);
  for (let it = 0; it < 12; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let b = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = d2(L[i], centers[c]); if (dd < bd) { bd = dd; b = c; } }
      if (owner[i] !== b) { owner[i] = b; moved = true; }
    }
    if (!moved && it) break;
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sum[owner[i]], w = counts[i];
      s[0] += L[i][0] * w; s[1] += L[i][1] * w; s[2] += L[i][2] * w; s[3] += w;
    }
    for (let c = 0; c < k; c++) if (sum[c][3]) {
      centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
  }

  // representative = the cluster's own biggest color, so every sheet names a
  // color that is actually in the picture
  const rep = new Int32Array(k).fill(-1);
  for (let i = 0; i < n; i++) {
    const c = owner[i];
    if (rep[c] < 0 || counts[i] > counts[rep[c]]) rep[c] = i;
  }
  if (keep >= 0) rep[owner[keep]] = keep;
  return { map: (id) => rep[owner[id]] };
}

// The picture the sheets are cut from: one flat color per pixel of a
// screen-space raster of the viewport, sampled at the VISIBLE surface point.
//
// This is the 3D render's own raster (rasterizeSurface) read a second way —
// instead of contouring one band boundary at a time, every pixel is resolved
// to its final color. Three things come with it:
//
//   * 3D surface detail: colors are sampled where the lifted surface actually
//     is, so a sheet edge falls on the crest the render draws it on.
//   * Occlusion: the z-buffer keeps the front-most fragment, so water hidden
//     behind a nearer crest contributes nothing at all.
//   * Frame cropping: the raster IS the viewport, so off-screen water is never
//     sampled, never planned into a sheet, and never exported.
//
// Fields are reconstructed from the surface grid with the same Catmull-Rom
// kernel the render uses (rasterField), which is also what keeps the far field
// — where one pixel spans many wavelengths — from aliasing into a confetti of
// one-pixel regions.
function buildPaperImage(S, fit, opts) {
  const { gN = 150, BW = 440, lift = true, bgColor,
          maxColors = PAPER_MAX_COLORS,
          scalarAt, thresholds, cols,      // preset / 1D palettes: one scalar
          uvAt, env2d,                     // painted panorama: reflected u,v
          gap = 0, gapColor,               // crest gaps, as in the SVG
          fresAt, fresBands, deepMix } = opts;
  const R = rasterizeSurface(S, fit, gN, BW, lift, gap);
  const { NP, cov } = R;

  const idOf = new Map(), palette = [];
  const idFor = (c) => {
    let id = idOf.get(c);
    if (id === undefined) { id = palette.length; idOf.set(c, id); palette.push(c); }
    return id;
  };
  const bgId = idFor(bgColor || PAPER_FRAME_COLOR);
  // a crest gap is a hole in the picture, so on paper it is the sheet behind
  // it showing through — the mount, unless a gap color asks for its own sheet
  const gapF = R.gap;
  const gapId = gapF && gapColor ? idFor(gapColor) : bgId;

  const coh = coherencePasses(S, gN);
  const cbuf = coh ? new Float64Array(R.stride * R.stride) : null;
  let colorOf;
  if (uvAt) {
    const { w: EW, h: EH, cells } = env2d;
    const nv = R.GX.length;
    const su = new Float64Array(nv), sv = new Float64Array(nv);
    for (let q = 0; q < nv; q++) {
      const uv = uvAt(R.GX[q], R.GY[q]); su[q] = uv[0]; sv[q] = uv[1];
    }
    meshBlur(R, su, coh, cbuf); meshBlur(R, sv, coh, cbuf);
    const fu = rasterField(R, su), fv = rasterField(R, sv);
    colorOf = (p) => {
      const u = fu[p] < 0 ? 0 : fu[p] > EW - 1 ? EW - 1 : fu[p] | 0;
      const v = fv[p] < 0 ? 0 : fv[p] > EH - 1 ? EH - 1 : fv[p] | 0;
      return cells[v * EW + u];
    };
  } else {
    const fs = rasterField(R, meshBlur(R, gridSamples(R, scalarAt), coh, cbuf));
    colorOf = (p) => {
      let k = 0;
      for (const t of thresholds) { if (fs[p] >= t) k++; else break; }
      return cols[k] || cols[0];
    };
  }
  const fw = fresAt
    ? rasterField(R, meshBlur(R, gridSamples(R, fresAt), coh, cbuf)) : null;

  const grid = new Int32Array(NP);
  const counts = [];
  for (let p = 0; p < NP; p++) {
    let id;
    if (!cov[p]) id = bgId;                      // off the water: the mount
    else if (gapF && gapF[p] > 0) id = gapId;    // inside a crest gap: cut through
    else {
      let c = colorOf(p);
      if (fw) {
        const b = Math.floor(fw[p] * fresBands);
        c = deepMix(c, b >= fresBands ? fresBands - 1 : b < 0 ? 0 : b);
      }
      id = idFor(c);
    }
    grid[p] = id;
    counts[id] = (counts[id] || 0) + 1;
  }
  for (let i = 0; i < palette.length; i++) if (!counts[i]) counts[i] = 0;

  // posterize to a buyable number of papers (see PAPER_MAX_COLORS)
  const q = maxColors ? reducePaperPalette(palette, counts, maxColors, bgId) : null;
  if (q) for (let p = 0; p < NP; p++) grid[p] = q.map(grid[p]);
  return { W: R.BW, H: R.BH, grid, palette };
}

// full pipeline: color image (+ palette id->hex) -> ordered sheets with paths.
// bgColor is the scene's background fill: the mount/frame sheet takes this color
// and absorbs any background-colored regions, so the water edge is cut once.
function buildPaperStack(image, bgColor, opts = {}) {
  const { W, H, grid, palette } = image;
  const N = W * H;
  const iters = opts.iters || 0;
  const minCells = opts.minCells ?? Math.max(6, Math.round(N * PAPER_MIN_FEATURE));

  // collapse duplicate hexes up front: two grid values with the same paper
  // color must label as ONE color, so its regions can gather onto one sheet
  // (and so no two adjacent regions ever share a color, which the planner's
  // one-color-per-step transitions and lower bound rely on)
  const hexId = new Map();
  const uniq = [];
  for (let p = 0; p < N; p++) {
    const hx = palette[grid[p]];
    let id = hexId.get(hx);
    if (id === undefined) { id = uniq.length; hexId.set(hx, id); uniq.push(hx); }
    grid[p] = id;
  }

  denoiseGrid(grid, W, H, minCells);
  const { label, regions } = labelRegions(grid, W, H);
  for (const r of regions) r.color = uniq[r.value];
  const adj = buildAdjacency(label, regions.length, W, H);

  // frame: a virtual node adjacent to every region touching the frame border.
  // Zoomed in, that border cuts through the water itself — which is the point:
  // the sheets are planned for what is in shot, not for the whole plane.
  const frameId = regions.length;
  regions.push({ value: -1, cells: [], size: 0, color: bgColor || PAPER_FRAME_COLOR, frame: true });
  adj.push(new Set());
  const touch = new Set();
  for (let x = 0; x < W; x++) { touch.add(label[x]); touch.add(label[(H - 1) * W + x]); }
  for (let y = 0; y < H; y++) { touch.add(label[y * W]); touch.add(label[y * W + W - 1]); }
  for (const r of touch) { adj[frameId].add(r); adj[r].add(frameId); }

  const { sheets, method } = planCollapse(regions, adj, frameId);

  // per sheet, contour the HOLE = everything not yet absorbed (the inverse of
  // the cumulative union). The cut line is then the boundary between this
  // sheet's paper and the sheets below; it only touches the water's outline
  // (the water<->background edge) on the top sheet, never re-cutting it
  // afterwards. Because the image is already the visible picture, that outline
  // is the wave silhouette itself — crests included — with no water-plane clip
  // to shear them off.
  //
  // A raw 0/1 mask contour is a per-pixel staircase (marching squares puts
  // every vertex at a pixel-edge midpoint), so — same trick as the union
  // layers — contour the zero level set of a lightly blurred SIGNED DISTANCE
  // field of the mask instead: the crossing interpolates to sub-pixel
  // positions and the cut edge comes out as smooth as the normal export.
  const px = W + 2, py = H + 2;
  const cum = new Uint8Array(N);
  const inv = new Uint8Array(N);
  const F = new Float64Array(N);
  const tmp = new Float64Array(N);
  const FP = new Float64Array(px * py);
  // physical guard: the sheet is one piece only because every paper component
  // reaches the frame border (= the mount margin). True for the planner's mask
  // by construction; the blur must not pinch a thin bridge and break it.
  const paperHoldsTogether = () => {
    const seen = new Uint8Array(N);
    const st = [];
    for (let s = 0; s < N; s++) {
      if (F[s] >= 0 || seen[s]) continue;
      let touchesBorder = false;
      seen[s] = 1; st.push(s);
      while (st.length) {
        const p = st.pop(), x = p % W, y = (p / W) | 0;
        if (x === 0 || x === W - 1 || y === 0 || y === H - 1) touchesBorder = true;
        if (x > 0 && F[p - 1] < 0 && !seen[p - 1]) { seen[p - 1] = 1; st.push(p - 1); }
        if (x < W - 1 && F[p + 1] < 0 && !seen[p + 1]) { seen[p + 1] = 1; st.push(p + 1); }
        if (y > 0 && F[p - W] < 0 && !seen[p - W]) { seen[p - W] = 1; st.push(p - W); }
        if (y < H - 1 && F[p + W] < 0 && !seen[p + W]) { seen[p + W] = 1; st.push(p + W); }
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
    // nothing of this sheet survives the cut — zoomed in past the shore, the
    // mount is a sheet with no background left on it. Don't ask for it.
    if (cumCount === 0) continue;
    let d = "";
    const solid = cumCount >= N;
    if (!solid) {                          // an open hole remains to cut
      for (let p = 0; p < N; p++) inv[p] = 1 - cum[p];
      const Din = distTransform(inv, W, H);   // depth into the hole
      const Dout = distTransform(cum, W, H);  // depth into the paper
      let thick = 0;
      for (let p = 0; p < N; p++) {
        F[p] = Din[p] - Dout[p];                // >0 hole, <0 paper
        if (F[p] > thick) thick = F[p];
      }
      // skip the blur on hairline holes (it would erase them), and undo it if
      // it disconnected the paper — sub-pixel interpolation still smooths
      if (thick >= 2) {
        blurField(F, W, H, tmp, 1);
        if (!paperHoldsTogether()) {
          for (let p = 0; p < N; p++) F[p] = Din[p] - Dout[p];
        }
      }
      for (let j = 0; j < py; j++) {
        const jj = Math.min(H - 1, Math.max(0, j - 1));
        for (let i = 0; i < px; i++) {
          const ii = Math.min(W - 1, Math.max(0, i - 1));
          FP[j * px + i] = F[jj * W + ii];
        }
      }
      const cont = d3.contours().size([px, py]).thresholds([0])(FP)[0];
      if (cont) d = contourToScreenPath(cont, W, H, iters, -1);
    }
    out.push({ color: sh.color, d, frame: !!sh.frame, solid });
  }
  return { sheets: out, nSheets: out.length, method };
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
    // clip the tile to its viewport — the roll transform rotates the picture
    // past the frame edge, and neighbouring tiles are right there. The holes
    // need no further clip: they are contoured on the frame raster, so they
    // already stop at the visible wave silhouette (crests above the water
    // plane included) and never reach past the sheet.
    body += `<clipPath id="ptile${i}"><rect x="${cx}" y="${cy}" width="${tileW}" height="${tileH}"/></clipPath>`;
    body += `<g clip-path="url(#ptile${i})">`;
    // full-sheet paper — this is the whole physical sheet, mount margin and all,
    // in one color; the water<->background edge is NOT drawn here
    body += `<rect x="${cx}" y="${cy}" width="${tileW}" height="${tileH}" fill="${sh.color}"/>`;
    // holes: paper removed to reveal the sheets below (hatched + dashed cut line)
    if (sh.d) body += `<path transform="${tf}" d="${sh.d}" fill="url(#cuthatch)" fill-rule="evenodd"/>`
      + `<path transform="${tf}" d="${sh.d}" fill="none" fill-rule="evenodd" stroke="#0b0f14"`
      + ` stroke-width="1" stroke-dasharray="4 2"/>`;
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

// exported for tests: the two halves of the layered-paper export
export {
  buildPaperImage, buildPaperStack, buildPaperStackSvg, PAPER_MAX_BW, PAPER_MAX_COLORS,
};

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

// one wake: where the vessel is, which way it is going, and how big the
// wake it drags is. No hull is drawn — the boat or board goes on in post.
const WAKE_ARROWS = ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"];
function WakeCard({ wk, idx, halfW, yFar, onChange, onRemove }) {
  return (
    <div style={{ border: "1px solid #26313c", borderRadius: 9, padding: 11,
      marginBottom: 10, background: "#121922" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 10.5, letterSpacing: 1, color: "#6f8294", flex: 1,
          fontFamily: "ui-monospace, monospace" }}>WAKE {idx + 1}</span>
        <button onClick={() => onChange({ on: !wk.on })}
          style={{ fontSize: 10.5, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
            fontFamily: "ui-monospace, monospace",
            background: wk.on ? "#27424b" : "#1a232c", color: wk.on ? "#dff1f6" : "#7f93a4",
            border: "1px solid " + (wk.on ? "#3f7e8f" : "#26313c") }}>
          {wk.on ? "on" : "off"}
        </button>
        <button onClick={onRemove}
          style={{ fontSize: 12, width: 26, height: 26, borderRadius: 6, cursor: "pointer",
            background: "#1a232c", color: "#9a6a6a", border: "1px solid #3a2a2a" }}>✕</button>
      </div>
      <Slider label="position ← →" value={wk.x} min={-halfW + 1} max={halfW - 1} step={0.5}
        onChange={(v) => onChange({ x: v })} fmt={(v) => (v === 0 ? "center" : v.toFixed(1))} />
      <Slider label="distance (near → far)" value={wk.y} min={3} max={yFar - 2} step={0.5}
        onChange={(v) => onChange({ y: v })} fmt={(v) => v.toFixed(1)} />
      <Slider label="heading (way on)" value={wk.dir} min={0} max={355} step={5}
        onChange={(v) => onChange({ dir: v })}
        fmt={(v) => v + "° " + WAKE_ARROWS[Math.round(v / 45) % 8]} />
      <Slider label="scale (vessel length)" value={wk.scale} min={0.5} max={16} step={0.1}
        onChange={(v) => onChange({ scale: v })} fmt={(v) => v.toFixed(1) + " units"} />
      <Slider label="strength" value={wk.amp} min={0} max={2} step={0.05}
        onChange={(v) => onChange({ amp: v })} fmt={(v) => (v === 0 ? "off" : v.toFixed(2))} />
      <Slider label="length (astern)" value={wk.len} min={2} max={30} step={1}
        onChange={(v) => onChange({ len: v })} fmt={(v) => v + "× vessel"} />
      <Slider label="arm detail (finest ripple)" value={wk.detail} min={0.1} max={1.5} step={0.05}
        onChange={(v) => onChange({ detail: v })}
        fmt={(v) => (v <= 0.2 ? "all the feathering" : v <= 0.35 ? "fine"
          : v <= 0.6 ? "medium" : v <= 0.95 ? "coarse" : "broad strokes only")} />
      <Slider label="spread of the V" value={wk.angle} min={8} max={40} step={0.5}
        onChange={(v) => onChange({ angle: v })}
        fmt={(v) => "±" + v.toFixed(1) + "°"
          + (Math.abs(v - WAKE_ANGLE_DEG) < 0.3 ? " (true)" : "")} />
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
  const [crestGap, setCrestGap] = useState(0);      // crest outline width, frame units (0 = off)
  const [crestGapColor, setCrestGapColor] = useState(""); // "" = the background
  const [edges, setEdges] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [manualTime, setManualTime] = useState(0); // scrub the wave phase when not animating
  const [lowPower, setLowPower] = useState(false);  // cap resolution + throttle animation
  const [rasterQ, setRasterQ] = useState(RASTER_DEFAULT); // 3D surface resolution step
  const [exportQ, setExportQ] = useState(EXPORT_DEFAULT);  // export raster, x preview
  const [exportMeshQ, setExportMeshQ] = useState(EXPORT_MESH_DEFAULT); // export mesh step
  const [exportPolishQ, setExportPolishQ] = useState(EXPORT_POLISH_DEFAULT); // export edge polish
  const [exporting, setExporting] = useState(false);       // the big retrace is synchronous
  const [pngQ, setPngQ] = useState(PNG_DEFAULT);           // PNG size, x the SVG frame
  const [pngBusy, setPngBusy] = useState(false);           // retrace + rasterize, same pause
  const [vidSec, setVidSec] = useState(VIDEO_DEFAULT_SEC); // video length, seconds
  const [vidQ, setVidQ] = useState(VIDEO_DEFAULT_SCALE);   // video frame size, x the SVG frame
  const [vidBusy, setVidBusy] = useState(false);           // one frame at a time, for minutes
  const [vidProg, setVidProg] = useState(null);            // { done, total, startedAt }
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

  // boat / board wakes: the water half of a vessel that is added in post
  const [wakes, setWakes] = useState([]);
  const updateWake = (id, patch) =>
    setWakes((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const addWake = () =>
    setWakes((ws) => ws.length >= 4 ? ws :
      [...ws, newWake(ws.reduce((m, w) => Math.max(m, w.id), 0) + 1,
        halfW, yFar, strength)]);
  const removeWake = (id) => setWakes((ws) => ws.filter((w) => w.id !== id));
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

  // floating object (red buoy)
  const [objOn, setObjOn] = useState(true);
  const [objX, setObjX] = useState(0);
  const [objY, setObjY] = useState(14);
  const [objSize, setObjSize] = useState(1.2);
  const [objSub, setObjSub] = useState(0.5);        // fraction of hull under water
  const [objRipple, setObjRipple] = useState(0.9);  // scattered-wave strength
  const [objRippleScale, setObjRippleScale] = useState(0.8);
  const [objBands, setObjBands] = useState(5);      // cel-shade tone count
  const [objLight, setObjLight] = useState(325);    // light direction, degrees
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
  const [penHatchGap, setPenHatchGap] = useState(5); // hatch spacing (viewBox units)
  const [penHatchAngle, setPenHatchAngle] = useState(20);  // base slant, degrees
  const [penHatchSpread, setPenHatchSpread] = useState(60); // per-region deviation
  const [penHatchAim, setPenHatchAim] = useState("shape"); // what sets the deviation
  const [penHatchTone, setPenHatchTone] = useState(0);      // density from color/paper contrast
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
  // Custom paint chits — extra swatches pinned by hand or lifted from a photo
  // palette. Session-lived (not serialized), deduped against the built-in
  // SWATCHES and each other so a chit stays easy to re-select all session.
  const [customChits, setCustomChits] = useState([]);
  const addChits = (colors) => setCustomChits((prev) => mergeChits(prev, colors));
  const [brushSize, setBrushSize] = useState(1);       // radius in cells
  const [brushShape, setBrushShape] = useState("round"); // round | square | diamond
  const [svgOut, setSvgOut] = useState(null);
  const [svgName, setSvgName] = useState("reflection-regions.svg");
  const [stackInfo, setStackInfo] = useState(null); // { nSheets } when a paper stack is exported
  const [copied, setCopied] = useState(false);
  // the finished PNG, held as an object URL so the panel can show and re-offer
  // it; the ref is what actually owns the URL, so each new render frees the last
  const [pngOut, setPngOut] = useState(null);   // { url, w, h, bytes, name }
  const [pngErr, setPngErr] = useState(null);
  const pngUrlRef = useRef(null);
  useEffect(() => () => { if (pngUrlRef.current) URL.revokeObjectURL(pngUrlRef.current); }, []);
  // the finished MP4, same arrangement — plus the one canvas every frame is
  // drawn into, and the flag the render loop polls to stop early
  const [vidOut, setVidOut] = useState(null);   // { url, w, h, bytes, name, seconds, frames }
  const [vidErr, setVidErr] = useState(null);
  const vidUrlRef = useRef(null);
  const vidCancelRef = useRef(false);
  const vidCanvasRef = useRef(null);
  useEffect(() => () => { if (vidUrlRef.current) URL.revokeObjectURL(vidUrlRef.current); }, []);

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
    crestGap: [crestGap, setCrestGap], crestGapColor: [crestGapColor, setCrestGapColor],
    animate: [animate, setAnimate], speed: [speed, setSpeed], quality: [quality, setQuality],
    manualTime: [manualTime, setManualTime], lowPower: [lowPower, setLowPower],
    rasterQ: [rasterQ, setRasterQ], exportQ: [exportQ, setExportQ],
    exportMeshQ: [exportMeshQ, setExportMeshQ],
    exportPolishQ: [exportPolishQ, setExportPolishQ], pngQ: [pngQ, setPngQ],
    vidSec: [vidSec, setVidSec], vidQ: [vidQ, setVidQ],
    advanced: [advanced, setAdvanced], emitters: [emitters, setEmitters],
    wakes: [wakes, setWakes],
    halfW: [halfW, setHalfW], yNear: [yNear, setYNear], yFar: [yFar, setYFar],
    reflMag: [reflMag, setReflMag], objects: [objects, setObjects],
    objOn: [objOn, setObjOn], objX: [objX, setObjX], objY: [objY, setObjY],
    objSize: [objSize, setObjSize], objSub: [objSub, setObjSub],
    objRipple: [objRipple, setObjRipple], objRippleScale: [objRippleScale, setObjRippleScale],
    objBands: [objBands, setObjBands], objLight: [objLight, setObjLight],
    eLo: [eLo, setELo], eHi: [eHi, setEHi], autoFit: [autoFit, setAutoFit],
    penMode: [penMode, setPenMode], penCount: [penCount, setPenCount],
    penRelief: [penRelief, setPenRelief], penWidth: [penWidth, setPenWidth],
    penHidden: [penHidden, setPenHidden], penStyle: [penStyle, setPenStyle],
    penSpacing: [penSpacing, setPenSpacing], penEven: [penEven, setPenEven],
    penHatchGap: [penHatchGap, setPenHatchGap], penHatchAngle: [penHatchAngle, setPenHatchAngle],
    penHatchSpread: [penHatchSpread, setPenHatchSpread], penHatchAim: [penHatchAim, setPenHatchAim],
    penHatchTone: [penHatchTone, setPenHatchTone],
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
    // pin every extracted color as a custom chit so the whole photo palette
    // stays one click away for the rest of the session
    addChits(res.swatches);
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
    // a video export renders one frame at a time on this same thread; letting
    // the preview keep animating underneath it only steals time from it
    if (!animate || vidBusy) return;
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
  }, [animate, speed, lowPower, vidBusy]);

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
  // low power pins the 3D pass to "draft" — the battery saver has the last word
  const rasterLevel = RASTER_LEVELS[
    Math.max(0, Math.min(RASTER_LEVELS.length - 1, lowPower ? 0 : rasterQ))];

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
    // waves scatter off the buoy's hull: a ring source pinned to the object,
    // with a tight decay so the disturbance stays local
    emitters: withWakes(objOn && objRipple > 0
      ? [...emitters, { id: "buoy", on: true, type: "point", x: objX, y: objY,
          size: Math.max(0.3, objSize * objRippleScale), amp: objRipple * 1.5, decay: 0.28 }]
      : emitters, wakes),
  }), [effQuality, steep, pitchDeg, wavelength, strength, sharp, spread, bands, perspective,
       halfW, yNear, yFar, eLo, eHi, zoom, panX, panY, smooth, coherence, rectOutput, surface3d, waveScale,
       bandFractions, fresOn, fresBands, reflMag,
       emitters, wakes, animate, speed, tRef.current, manualTime,
       objOn, objX, objY, objSize, objRipple, objRippleScale]);

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
  const gapFill = crestGapColor || bgFill;
  const layers = use2d ? (seg.layers || null)
    : geom.ds.map((d, k) => ({ d, color: isobandColors[k + 1] }));
  const rng = use2d ? seg : geom;
  // 3D "solid" surface: the lifted color layers have no depth ordering, so a
  // tall wave's far side used to show through the crest in front of it. In this
  // mode we instead z-buffer the surface into a raster and re-contour it (see
  // surf3d) — smooth regions like the flat modes, but occlusion-correct. Pen
  // mode has its own hidden-line path, so this only covers filled regions.
  const solid3d = !penMode && surface3d && perspective;

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

  // pen-plot lines: equally spaced scan lines colored by the reflection beneath.
  // Takes the scene rather than closing over it, so the video export can build
  // the same lines at a wave phase this render is not showing.
  const makePenLines = useCallback((S) => {
    if (!penMode) return null;
    const fit = computeFit(S);
    const mag = S.reflMag || 1;
    prepField(S);
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
    if (penStyle === "hatch") {
      // Hatching is cut from the screen raster, so it wants the same two
      // resolution knobs the filled 3D mode has: the raster decides how finely
      // a region boundary — and so a stroke end — is placed, the mesh how much
      // surface there is to cut up.
      return buildPenHatch(S, fit, colorAt, {
        spacing: penHatchGap, relief: penRelief, threeD,
        angleDeg: penHatchAngle, spreadDeg: penHatchSpread, aim: penHatchAim,
        tone: penHatchTone, paper: bgFill,
        BW: rasterLevel.BW, gN: rasterLevel.gN,
      });
    }
    if (penStyle === "rings") {
      return buildPenConcentric(S, fit, colorAt, {
        spacing: penSpacing, relief: penRelief, threeD, hidden: penHidden,
      });
    }
    return buildPenLines(S, fit, colorAt, {
      nLines: penCount, samples: penHidden ? 360 : 260, relief: penRelief,
      threeD, hidden: penHidden, evenScreen: penEven,
    });
  }, [penMode, penStyle, penCount, penSpacing, penRelief, penHidden, penEven, use2d, mode,
      penHatchGap, penHatchAngle, penHatchSpread, penHatchAim, penHatchTone, bgFill, rasterLevel,
      envEffective, azSpan, colors1d, presetColors, fresOn, fresBands, mixDeep]);
  const penLines = useMemo(() => makePenLines(S), [makePenLines, S]);

  // The fields any surface-raster pass contours: one continuous scalar for
  // preset/1D palettes (the reflected elevation, banded at the palette's
  // boundaries — the same banding buildGeometry uses), the reflected panorama
  // coordinate for painted ones, plus the Fresnel deep-water weight. The live
  // 3D render and the layered-paper export both build their picture from
  // these, so a cut line lands where the rendered color edge does.
  const makeFieldSpec = useCallback((S) => {
    const mag = S.reflMag || 1;
    // occluded Fresnel: the deep-water weight at the front-most surface point,
    // contoured into the same bands the flat path clips with
    const fresAt = fresOn ? (gx, gy) => fresnelDeepW(reflectAt(gx, gy, S)[3]) : null;
    const fresThresholds = fresOn ? d3.range(1, fresBands).map((k) => k / fresBands) : null;
    if (use2d) {
      // arbitrary panorama colors have no single scalar to contour, so the
      // reflected panorama coordinate is the field: the flat path's per-color
      // signed distance fields get composed through it.
      const { w: EW, h: EH } = envEffective, az = azSpan;
      const uvAt = (gx, gy) => {
        const R = reflectAt(gx, gy, S);
        const phi = Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180 / Math.PI;
        let psi = Math.atan2(R[0], R[1]) * 180 / Math.PI; psi = psi < -az ? -az : psi > az ? az : psi;
        let v = magFrac((phi - S.eLo) / ((S.eHi - S.eLo) || 1), mag); v = v < 0 ? 0 : v > 1 ? 1 : v;
        let u = magFrac((psi + az) / (2 * az), mag); u = u < 0 ? 0 : u > 1 ? 1 : u;
        return [u * EW, v * EH];
      };
      return { uvAt, env2d: envEffective, fresAt, fresThresholds };
    }
    const cols = mode === "paint1d" ? colors1d : presetColors, NB = cols.length;
    const mid = (S.eLo + S.eHi) / 2, magSpan = (S.eHi - S.eLo) / mag;
    const bnd = (f) => mid + (f - 0.5) * magSpan;
    const thresholds = S.bandFractions ? S.bandFractions.map(bnd) : d3.range(1, NB).map((k) => bnd(k / NB));
    const scalarAt = (gx, gy) =>
      Math.asin(Math.max(-1, Math.min(1, reflectAt(gx, gy, S)[2]))) * 180 / Math.PI;
    return { scalarAt, thresholds, cols, fresAt, fresThresholds };
  }, [use2d, mode, envEffective, azSpan, colors1d, presetColors, fresOn, fresBands]);
  const fieldSpec = useMemo(() => makeFieldSpec(S), [makeFieldSpec, S]);

  // 3D solid surface: hidden-surface removal on a z-buffered raster, then the
  // usual smooth contouring on top — so the lifted water keeps the flat modes'
  // smooth region outlines but a near crest correctly hides the wave's far
  // side. Produces occluded { layers, fres } that slot straight into the same
  // render path the flat layers use (Fresnel, edges and all).
  const surf3d = useMemo(
    () => (solid3d
      ? buildSolid3D(S, fieldSpec, { gN: rasterLevel.gN, BW: rasterLevel.BW, gap: crestGap })
      : null),
    [solid3d, S, fieldSpec, rasterLevel, crestGap]);

  // in 3D-solid mode the occluded surf3d geometry drives every filled-region
  // code path below (live preview, SVG export, Fresnel clips) in place of the
  // flat/lifted layers, so the rest of the renderer stays untouched
  const drawLayers = solid3d ? surf3d.layers : layers;
  const drawFres = solid3d ? surf3d.fres : fresPaths;
  const drawBg = solid3d ? surf3d.bg : bg;
  // the crest gaps ride on top of every layer, in whatever shows through a
  // hole in the picture — the page background, unless asked for another color
  const drawGap = solid3d ? surf3d.gap : null;

  // floating buoy: projected cap + waterline clip + mirrored reflection
  const makeBuoy = useCallback((S) => {
    if (!objOn) return null;
    const fit = computeFit(S);
    prepField(S);
    return buildBuoy(S, fit, { x: objX, y: objY, size: objSize, sub: objSub });
  }, [objOn, objX, objY, objSize, objSub]);
  const buoy = useMemo(() => makeBuoy(S), [makeBuoy, S]);
  const buoyShade = useMemo(() => makeBuoyBands(objBands, objLight), [objBands, objLight]);

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

  // Everything about the picture that changes when the wave phase does,
  // gathered into one object. The preview's is memoized above, a frame at a
  // time; `frameAt` builds another from scratch at any phase, which is what
  // the video export walks through. Color, camera roll, Fresnel banding and
  // the rest do not move with the phase, so they stay closed over.
  const liveFrame = {
    seg, fresPaths, penLines, buoy,
    drawLayers, drawFres, drawBg, drawGap, bgFill, gapFill,
  };
  const frameAt = (t) => {
    const St = { ...S, t };
    if (penMode) {
      // pen mode has no filled regions at all: lines, the buoy, and paper
      return { ...liveFrame, penLines: makePenLines(St), buoy: makeBuoy(St) };
    }
    const geomT = use2d ? null : buildGeometry(St);
    const segT = use2d ? buildSegmentation(St, envEffective, azSpan) : null;
    const bgT = use2d ? segT.bg : isobandColors[0];
    const bgFillT = bgColor || bgT;
    const layersT = use2d ? (segT.layers || null)
      : geomT.ds.map((d, k) => ({ d, color: isobandColors[k + 1] }));
    const fresT = fresOn ? (use2d ? segT.fres : geomT.fres) : null;
    // the preview's own raster and mesh, deliberately: a video frame is not a
    // print, and the export retrace would multiply a minutes-long render by
    // the frame count for edges nobody will pause on
    const solidT = solid3d
      ? buildSolid3D(St, makeFieldSpec(St),
          { gN: rasterLevel.gN, BW: rasterLevel.BW, gap: crestGap })
      : null;
    return {
      seg: segT, fresPaths: fresT, penLines: null, buoy: makeBuoy(St),
      drawLayers: solid3d ? solidT.layers : layersT,
      drawFres: solid3d ? solidT.fres : fresT,
      drawBg: solid3d ? solidT.bg : bgT,
      drawGap: solid3d ? solidT.gap : null,
      bgFill: bgFillT, gapFill: crestGapColor || bgFillT,
    };
  };

  // `over` is an alternate { bg, layers, fres } for the filled regions — the
  // export retrace at a wider raster. Everything else about the picture (roll,
  // Fresnel banding, buoy, background) is unchanged, so the file matches what
  // is on screen; only the outlines are resolved finer.
  const buildSvg = (over, frame) => {
    const F = frame || liveFrame;
    const { seg, fresPaths, penLines, buoy, bgFill, gapFill } = F;
    const svgLayers = over ? over.layers : F.drawLayers;
    const svgFres = over ? over.fres : F.drawFres;
    const svgBg = over ? over.bg : F.drawBg;
    const svgGap = over ? over.gap : F.drawGap;
    const buoyStr = buoy ? buoySvg(buoy, buoyShade) : "";
    const rollOpen = rollTf ? `<g transform="${rollTf}">` : `<g>`;
    if (penMode) {
      let body = `<rect width="${VB_W}" height="${VB_H}" fill="${bgFill}"/>` + rollOpen;
      penLines.forEach((l) => {
        body += `<path d="${l.d}" fill="none" stroke="${l.color}" stroke-width="${penWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
      });
      body += buoyStr + `</g>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${body}</svg>`;
    }
    let body = `<rect width="${VB_W}" height="${VB_H}" fill="${bgFill}"/>` + rollOpen;
    const stroke = edges ? ` stroke="#000" stroke-opacity="0.25" stroke-width="0.6"` : "";
    let defs = "";
    if (fresOn && svgFres) svgFres.forEach((d, i) => {
      if (d) defs += `<clipPath id="fres${i + 1}"><path d="${d}"/></clipPath>`;
    });
    const bandOpen = (b) => (b > 0 ? `<g clip-path="url(#fres${b})">` : `<g>`);
    if (!solid3d && use2d && !seg.layers) {
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
      body += buoyStr + `</g>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}"><defs>${defs}</defs>${body}</svg>`;
    }
    // layered paths, preset & 2D alike. With Fresnel on, the geometry is
    // shared via <use> so each depth band re-colors the same paths.
    if (use2d && !solid3d) defs += `<clipPath id="watertrap"><path d="${seg.clip}"/></clipPath>`;
    if (fresOn) svgLayers.forEach((l, i) => { defs += `<path id="lyr${i}" d="${l.d}"/>`; });
    // in 3D the waves rise above the flat water trapezoid, so skip the clip
    // (the padded regions already overshoot the frame) — otherwise crests
    // near the edges would be sheared off flat
    body += use2d && !surface3d
      ? `<g clip-path="url(#watertrap)" opacity="0.999">` : `<g opacity="0.999">`;
    fresIdx.forEach((b) => {
      if (b > 0 && !svgFres[b - 1]) return;
      body += bandOpen(b);
      if (b > 0) body += `<rect width="${VB_W}" height="${VB_H}" fill="${mixDeep(svgBg, b)}"/>`;
      svgLayers.forEach((l, i) => {
        body += fresOn
          ? `<use href="#lyr${i}" fill="${mixDeep(l.color, b)}" fill-rule="evenodd"${stroke}/>`
          : `<path d="${l.d}" fill="${l.color}" fill-rule="evenodd"${stroke}/>`;
      });
      body += `</g>`;
    });
    if (svgGap) body += `<path d="${svgGap}" fill="${gapFill}" fill-rule="evenodd"/>`;
    body += `</g>` + buoyStr + `</g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
  };
  const saveBlob = (blob, name) => {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { /* sandbox may block downloads */ }
  };
  const saveSvg = (svg, name) => saveBlob(new Blob([svg], { type: "image/svg+xml" }), name);
  // Export at `exportQ`: in 3D-solid mode the regions are retraced on a raster
  // that many times wider than the preview's before the file is written, which
  // is the whole reason a distant crest comes out as a curve rather than a
  // stair. It is one slow synchronous pass, so hand the browser a frame to
  // paint the "tracing" label first, and fall back to the preview geometry if
  // the big raster cannot be allocated.
  const emitSvg = (over) => {
    const svg = buildSvg(over);
    saveSvg(svg, "reflection-regions.svg");
    setSvgName("reflection-regions.svg");
    setStackInfo(null);
    setSvgOut(svg); // always show a reliable copy fallback
  };
  const exportMult = EXPORT_MULTS[Math.max(0, Math.min(EXPORT_MULTS.length - 1, exportQ))];
  const exportMesh = EXPORT_MESHES[Math.max(0, Math.min(EXPORT_MESHES.length - 1, exportMeshQ))];
  const exportPolish = EXPORT_POLISH[Math.max(0, Math.min(EXPORT_POLISH.length - 1, exportPolishQ))];
  const exportAt = solid3d
    ? { ...exportRaster(rasterLevel, exportMult, exportMesh.f), polish: exportPolish.passes,
        gap: crestGap }
    : null;
  // a retrace is only worth its seconds when it would actually differ from what
  // is already on screen — a wider raster, a stood-down mesh, a polish pass the
  // preview never runs, or any combination
  const exportRetrace = !!exportAt
    && (exportAt.BW > rasterLevel.BW || exportAt.gN < rasterLevel.gN || exportAt.polish > 0);
  const downloadSVG = () => {
    if (exporting || pngBusy) return;
    if (!exportRetrace) { emitSvg(null); return; }
    setExporting(true);
    setTimeout(() => {
      let over = null;
      try {
        over = buildSolid3D(S, fieldSpec, exportAt);
      } catch (e) {
        over = null;   // out of memory: the preview geometry still exports fine
      }
      emitSvg(over);
      setExporting(false);
    }, 30);
  };

  // PNG at `pngQ`: the preview's geometry, drawn by the browser at several
  // times the frame. It keeps the export's width multiplier — that step
  // resolves the same picture finer, and the bigger the output the more it is
  // needed — and deliberately skips the mesh and polish steps, which change the
  // picture to protect a vector edge this file does not have. Same pause as the
  // SVG export when a retrace is involved, then one async rasterize.
  const pngAt = pngSize(PNG_SCALES[Math.max(0, Math.min(PNG_SCALES.length - 1, pngQ))]);
  const pngRetrace = solid3d && exportMult > 1;
  const pngGeom = pngRetrace
    ? { ...exportRaster(rasterLevel, exportMult), polish: 0, gap: crestGap } : null;
  const showPng = (blob, name) => {
    let url = null;
    try {
      if (pngUrlRef.current) URL.revokeObjectURL(pngUrlRef.current);
      url = URL.createObjectURL(blob);
      pngUrlRef.current = url;
    } catch (e) { url = null; }
    setPngOut({ url, w: pngAt.w, h: pngAt.h, bytes: blob.size, name });
  };
  const downloadPNG = () => {
    if (pngBusy || exporting) return;
    setPngBusy(true);
    setPngErr(null);
    setTimeout(() => {
      let over = null;
      if (pngGeom) {
        try {
          over = buildSolid3D(S, fieldSpec, pngGeom);
        } catch (e) {
          over = null;  // out of memory: the preview geometry still rasterizes
        }
      }
      svgToPngBlob(buildSvg(over), pngAt.w, pngAt.h).then((blob) => {
        saveBlob(blob, "reflection-regions.png");
        showPng(blob, "reflection-regions.png");
      }).catch(() => {
        setPngErr("This browser would not rasterize the picture. The SVG export still works,"
          + " and opening that file in any image editor gets you the same PNG.");
      }).then(() => setPngBusy(false), () => setPngBusy(false));
    }, 30);
  };

  // MP4 at `vidSec` seconds: the animation, rendered one frame at a time and
  // played back at a rate this scene may be nowhere near able to hit live.
  //
  // Each frame is the preview's own geometry rebuilt at the wave phase the
  // clip is at by then — `frameAt` — so what comes out is what the animation
  // is *meant* to look like, not what the machine managed. The settings are
  // whatever they were when the button was pressed: the loop holds this
  // render's closures, so moving a slider mid-export changes the next export,
  // never the frames still to come in this one.
  const vidAt = videoSize(VIDEO_SCALES[Math.max(0, Math.min(VIDEO_SCALES.length - 1, vidQ))],
    VB_W, VB_H);
  const vidPlan = framePlan(vidSec, speed);
  const showVid = (blob, name, plan, out) => {
    let url = null;
    try {
      if (vidUrlRef.current) URL.revokeObjectURL(vidUrlRef.current);
      url = URL.createObjectURL(blob);
      vidUrlRef.current = url;
    } catch (e) { url = null; }
    setVidOut({ url, w: vidAt.w, h: vidAt.h, bytes: blob.size, name,
      seconds: plan.seconds, frames: plan.count, entry: out.entry, codec: out.codec });
  };
  const cancelVideo = () => { vidCancelRef.current = true; };
  const exportVideo = async () => {
    if (vidBusy || pngBusy || exporting) return;
    setVidErr(null);
    if (!videoSupported()) {
      setVidErr("This browser has no video encoder at all (WebCodecs). Chrome, Edge,"
        + " Firefox and Safari 16.4+ can write the file; everywhere else, the PNG export"
        + " still gets you one frame at a time.");
      return;
    }
    const plan = vidPlan;
    const startedAt = Date.now();
    vidCancelRef.current = false;
    setVidBusy(true);
    setVidProg({ done: 0, total: plan.count, startedAt });
    // one frame to let the progress bar paint before the first render blocks
    await new Promise((r) => setTimeout(r, 30));
    if (!vidCanvasRef.current && typeof document !== "undefined")
      vidCanvasRef.current = document.createElement("canvas");
    try {
      const out = await encodeMp4({
        width: vidAt.w, height: vidAt.h, fps: plan.fps, count: plan.count,
        renderFrame: (i) => svgToCanvas(buildSvg(null, frameAt(plan.phaseAt(i))),
          vidAt.w, vidAt.h, vidCanvasRef.current),
        onProgress: (done, total) => setVidProg({ done, total, startedAt }),
        cancelled: () => vidCancelRef.current,
      });
      if (out) {
        const blob = new Blob(out.parts, { type: "video/mp4" });
        saveBlob(blob, "reflection-regions.mp4");
        showVid(blob, "reflection-regions.mp4", plan, out);
      }
    } catch (e) {
      setVidErr("The video encoder would not take this scene"
        + (e && e.message ? ` (${e.message})` : "") + "."
        + " The PNG export still writes a single frame at any size.");
    }
    setVidBusy(false);
    setVidProg(null);
  };

  // Layered paper: cut the same picture the SVG export draws. Both resolve the
  // scene on the visible-surface raster, so the sheets ride the 3D relief, stop
  // where a nearer crest hides the water behind it, and cover exactly what is
  // in frame — no plan, and no path, for water the camera cannot see.
  const exportPaperStack = () => {
    const fit = computeFit(S);
    prepField(S);
    const image = buildPaperImage(S, fit, {
      gN: rasterLevel.gN, BW: Math.min(rasterLevel.BW, PAPER_MAX_BW),
      lift: surface3d && perspective,      // the render's own 3D-solid rule
      gap: solid3d ? crestGap : 0, gapColor: crestGapColor,
      bgColor: bgFill, fresBands, deepMix: mixDeep,
      ...fieldSpec,
    });
    const stack = buildPaperStack(image, bgFill, { iters: S.smooth || 0 });
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
              ) : !solid3d && use2d && !layers ? (
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
                    {use2d && !solid3d && <clipPath id="watertrap"><path d={seg.clip} /></clipPath>}
                    {fresOn && drawFres.map((d, i) => d ? (
                      <clipPath key={`f${i}`} id={`fres${i + 1}`}><path d={d} /></clipPath>
                    ) : null)}
                    {fresOn && drawLayers.map((l, i) => (
                      <path key={i} id={`lyr${i}`} d={l.d} />
                    ))}
                  </defs>
                  {/* opacity forces the group into an isolated buffer, so the
                      clip is antialiased once against the composite instead of
                      per layer (per-layer clip AA leaks the colors beneath) */}
                  <g clipPath={use2d && !surface3d ? "url(#watertrap)" : undefined} opacity={0.999}>
                    {fresIdx.map((b) => (b > 0 && !drawFres[b - 1]) ? null : (
                      <g key={`fb${b}`} clipPath={b > 0 ? `url(#fres${b})` : undefined}>
                        {b > 0 && <rect width={VB_W} height={VB_H} fill={mixDeep(drawBg, b)} />}
                        {drawLayers.map((l, i) => fresOn ? (
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
                    {drawGap && <path d={drawGap} fill={gapFill} fillRule="evenodd" />}
                  </g>
                </>
              )}
              {buoy && (
                <g>
                  <defs>
                    {buoy.clipAbove && <clipPath id="buoyAboveP"><path d={buoy.clipAbove} /></clipPath>}
                    {buoy.clipBelow && <clipPath id="buoyBelowP"><path d={buoy.clipBelow} /></clipPath>}
                    <clipPath id="buoyBallP">
                      <ellipse cx={buoy.cx} cy={buoy.cy} rx={buoy.rx} ry={buoy.ry} />
                    </clipPath>
                  </defs>
                  {buoy.reflD && (
                    <g clipPath={buoy.clipBelow ? "url(#buoyBelowP)" : undefined}>
                      <path d={buoy.reflD} fill="#b03328" opacity={0.45} />
                    </g>
                  )}
                  <g clipPath={buoy.clipAbove ? "url(#buoyAboveP)" : undefined}>
                    <g clipPath="url(#buoyBallP)">
                      {buoyBandGeo(buoy, buoyShade).map((e, i) => (
                        <ellipse key={i} cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill={e.color} />
                      ))}
                    </g>
                  </g>
                  {buoy.nearD && (
                    <path d={buoy.nearD} fill="none" stroke="#000" strokeOpacity={0.4} strokeWidth={1.1} />
                  )}
                  {buoy.ortho && buoy.ringD && (
                    <path d={buoy.ringD} fill="none" stroke="#000" strokeOpacity={0.3} strokeWidth={1} />
                  )}
                </g>
              )}
              </g>
            </svg>
            <div style={{ position: "absolute", left: 12, bottom: 10, fontSize: 10.5,
              color: "#6d808f", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5 }}>
              {penMode ? `${penStyle === "rings" ? "rings" : penStyle === "hatch" ? `hatch ${penHatchAngle}\u00b0\u00b1${penHatchSpread}\u00b0` : penCount + " lines"} · ${penLines.length} pens${S.perspective && penRelief > 0 ? " · 3D" : ""}${penHidden || penStyle === "hatch" ? " · hidden-line" : ""}`
                : solid3d ? `${drawLayers.length + 1} regions · ${S.nx}×${S.ny} sample grid · 3D ${rasterLevel.name} ${rasterLevel.BW}px`
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
                    {customChits.map((c) => (
                      <button key={c} onClick={() => setActiveColor(c)}
                        onContextMenu={(e) => { e.preventDefault();
                          setCustomChits((prev) => prev.filter((x) => x !== c)); }}
                        title={c + " — custom chit (right-click to remove)"}
                        style={{ width: 24, height: 24, borderRadius: 5, background: c, cursor: "pointer",
                          padding: 0, border: normHex(activeColor) === c ? "2px solid #fff" : "1px solid #00000055" }} />
                    ))}
                    <label style={{ width: 24, height: 24, borderRadius: 5, cursor: "pointer",
                      border: "1px solid #44525e", position: "relative", overflow: "hidden",
                      background: activeColor, display: "inline-block" }}>
                      <input type="color" value={activeColor}
                        onChange={(e) => setActiveColor(e.target.value)}
                        style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
                    </label>
                    <button onClick={() => addChits(activeColor)}
                      title="Pin the current color as a custom chit for this session"
                      style={{ width: 24, height: 24, borderRadius: 5, background: "#1a232c", cursor: "pointer",
                        padding: 0, color: "#9fb0c0", fontSize: 16, lineHeight: 1,
                        border: "1px dashed #44525e", display: "inline-flex",
                        alignItems: "center", justifyContent: "center" }}>+</button>
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
              <div style={heading}>Floating buoy (in frame)</div>
              <Toggle label="Red buoy" value={objOn} onChange={setObjOn} />
              {objOn && (
                <div style={{ marginTop: 6 }}>
                  <Slider label="position ← →" value={objX} min={-halfW + 1} max={halfW - 1} step={0.5}
                    onChange={setObjX} fmt={(v) => (v === 0 ? "center" : v.toFixed(1))} />
                  <Slider label="distance (near → far)" value={objY} min={5} max={yFar - 3} step={0.5}
                    onChange={setObjY} fmt={(v) => v.toFixed(1)} />
                  <Slider label="size" value={objSize} min={0.4} max={3} step={0.1}
                    onChange={setObjSize} fmt={(v) => v.toFixed(1)} />
                  <Slider label="submersion" value={objSub} min={0.08} max={0.92} step={0.02}
                    onChange={setObjSub} fmt={(v) => Math.round(v * 100) + "%"} />
                  <Slider label="shading bands" value={objBands} min={2} max={8} step={1}
                    onChange={setObjBands} />
                  <Slider label="light direction" value={objLight} min={0} max={360} step={5}
                    onChange={setObjLight}
                    fmt={(v) => v + "° " + ["↑","↗","→","↘","↓","↙","←","↖"][Math.round(v / 45) % 8]} />
                  <Slider label="scattered ripples" value={objRipple} min={0} max={2} step={0.05}
                    onChange={setObjRipple} fmt={(v) => (v === 0 ? "off" : v.toFixed(2))} />
                  {objRipple > 0 && (
                    <Slider label="scattered wavelength" value={objRippleScale} min={0.3} max={2} step={0.05}
                      onChange={setObjRippleScale} fmt={(v) => v.toFixed(2) + "×"} />
                  )}
                  <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    The hull below the waterline is hidden; the cap above it mirrors into the
                    water. Scattered ripples are waves bouncing off the hull — they bend the
                    color regions around the buoy and animate with the rest of the surface.
                  </div>
                </div>
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Boat &amp; board wakes</div>
              <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 10, lineHeight: 1.5,
                fontFamily: "ui-monospace, monospace" }}>
                The water a hull leaves behind it — the V of a Kelvin wake, cut into the color
                regions like any other wave. No vessel is drawn: place the boat or board over
                the apex in post. Scale and strength are the wake&#39;s own, read in scene units
                rather than off the sliders above, so it holds its size and its height when you
                retune the open water — a new wake only starts at the strength the water has.
                Arm detail sets how short a wave the feathering off the arms may carry: turn it
                down for a big scene where those wavelets land a pixel wide and break up under
                the 3D lift, up for a close one where they are the point. The pattern stands
                still in the vessel&#39;s frame, so it does not drift when the waves animate.
              </div>
              {wakes.map((wk, i) => (
                <WakeCard key={wk.id} wk={wk} idx={i} halfW={halfW} yFar={yFar}
                  onChange={(patch) => updateWake(wk.id, patch)}
                  onRemove={() => removeWake(wk.id)} />
              ))}
              {wakes.length < 4 && (
                <button onClick={addWake}
                  style={{ width: "100%", padding: "9px", borderRadius: 8, cursor: "pointer",
                    background: "#1a232c", color: "#9fb0c0", border: "1px dashed #3a4a57",
                    fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                  + add wake
                </button>
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Display</div>
              <Slider label="Edge smoothing" value={smooth} min={0} max={4} step={1}
                onChange={setSmooth} fmt={(v) => (v === 0 ? "off (crisp)" : v + "×")} />
              <Slider label="edge ripple" value={coherence} min={0} max={8} step={1}
                onChange={setCoherence}
                fmt={(v) => (v === 0 ? "sharp" : v <= 2 ? "rippled" : v <= 5 ? "smooth" : "broad")} />
              {coherence > 0 && (
                <div style={{ fontSize: 9.5, color: "#6d808f", marginTop: -4, marginBottom: 4,
                  lineHeight: 1.5, fontFamily: "ui-monospace, monospace" }}>
                  Blurs the reflection everywhere — sharp (0) keeps every wavelet's ripple.
                </div>
              )}
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
                  <Slider label="Crest gap" value={crestGap} min={0} max={8} step={0.25}
                    onChange={setCrestGap} fmt={(v) => (v === 0 ? "off" : v.toFixed(2))} />
                  <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 8, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    Lets the water occlude a little past its own silhouette, opening a strip of
                    background along the far side of every crest. Where a wave crosses water its
                    own color it otherwise blends straight into it — this is what says which one
                    is in front. Measured on the frame, so the export draws the same gap, only
                    traced finer — a coarse preview raster holds it a hair wider, since it
                    cannot place either edge closer than a pixel.
                  </div>
                  {crestGap > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <label style={{ width: 26, height: 26, borderRadius: 6, cursor: "pointer",
                        border: "1px solid #44525e", position: "relative", overflow: "hidden",
                        background: gapFill, display: "inline-block", flex: "none" }}>
                        <input type="color"
                          value={/^#[0-9a-fA-F]{6}$/.test(gapFill) ? gapFill : "#ffffff"}
                          onChange={(e) => setCrestGapColor(e.target.value)}
                          style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
                      </label>
                      <span style={{ fontSize: 11, color: "#9fb0c0", flex: 1,
                        fontFamily: "ui-monospace, monospace" }}>
                        {crestGapColor ? crestGapColor : "gap color: background"}
                      </span>
                      <button onClick={() => setCrestGapColor("")}
                        style={{ ...miniBtn, flex: "none", padding: "6px 12px",
                          opacity: crestGapColor ? 1 : 0.5 }}>Auto</button>
                    </div>
                  )}
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
                <Slider label="3D surface detail" value={rasterQ} min={0} max={RASTER_LEVELS.length - 1}
                  step={1} onChange={setRasterQ}
                  fmt={(v) => {
                    const L = RASTER_LEVELS[v];
                    return `${L.name} · ${L.BW}px` + (lowPower && v > 0 ? " (capped)" : "");
                  }} />
                <div style={{ fontSize: 9.5, color: "#6d808f", marginBottom: 10, lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace" }}>
                  {solid3d
                    ? "Resolution of the 3D pass: the regions are contoured on a raster this many"
                      + " pixels wide, so it sets how fine a wave edge can get — mostly visible"
                      + " along the crest lines, where a near wave cuts across the water behind"
                      + " it. Cost grows with the square, and every color layer pays it: print and"
                      + " max are meant for a still you export, not for panning around — and for"
                      + " an export you can leave this where you like to work and let export"
                      + " detail (next to the button) do the fine trace instead."
                    : penMode && penStyle === "hatch"
                      ? "The hatched pen style is cut from the same kind of raster: it sets how"
                        + " finely a region boundary is placed, and so where a stroke stops."
                        + " The other pen styles don't use it."
                      : "The 3D wave surface is off, so this only sets the resolution of the"
                        + " layered-paper export, which is cut from the same kind of raster."}
                  {` The paper stack caps it at ${PAPER_MAX_BW}px — past that the`
                    + " cut lines get finer than paper and scissors care about."}
                  {lowPower && rasterQ > 0 && " Low power mode is holding this at draft."}
                </div>
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
                    {[["lines", "Parallel"], ["rings", "Concentric"], ["hatch", "Hatched"]].map(([v, lbl]) => (
                      <button key={v} onClick={() => setPenStyle(v)}
                        style={{ flex: 1, padding: "7px 4px", fontSize: 11.5, borderRadius: 6, cursor: "pointer",
                          fontFamily: "ui-monospace, monospace",
                          background: penStyle === v ? "#27424b" : "#1a232c",
                          color: penStyle === v ? "#dff1f6" : "#9fb0c0",
                          border: "1px solid " + (penStyle === v ? "#3f7e8f" : "#26313c") }}>{lbl}</button>
                    ))}
                  </div>
                  {penStyle === "rings" &&
                    <Slider label="ring spacing" value={penSpacing} min={0.5} max={20} step={0.5}
                      onChange={setPenSpacing} fmt={(v) => v.toFixed(1)} />}
                  {penStyle === "lines" &&
                    <Slider label="lines" value={penCount} min={8} max={140} step={2} onChange={setPenCount} />}
                  {penStyle === "lines" && perspective &&
                    <Toggle label="Even spacing on screen" value={penEven} onChange={setPenEven} />}
                  {penStyle === "hatch" && (
                    <>
                      <Slider label="stroke spacing" value={penHatchGap} min={1.5} max={20} step={0.5}
                        onChange={setPenHatchGap} fmt={(v) => v.toFixed(1)} />
                      <Slider label="base slant" value={penHatchAngle} min={-90} max={90} step={5}
                        onChange={setPenHatchAngle} fmt={(v) => v + "\u00b0"} />
                      <Slider label="slant spread" value={penHatchSpread} min={0} max={90} step={5}
                        onChange={setPenHatchSpread}
                        fmt={(v) => (v === 0 ? "one angle" : v + "\u00b0")} />
                      <div style={{ display: "flex", gap: 6, margin: "6px 0 8px" }}>
                        {HATCH_AIMS.map(([v, lbl]) => (
                          <button key={v} onClick={() => setPenHatchAim(v)}
                            disabled={penHatchSpread === 0}
                            style={{ flex: 1, padding: "6px 4px", fontSize: 11, borderRadius: 6,
                              cursor: penHatchSpread === 0 ? "not-allowed" : "pointer",
                              opacity: penHatchSpread === 0 ? 0.45 : 1,
                              fontFamily: "ui-monospace, monospace",
                              background: penHatchAim === v ? "#27424b" : "#1a232c",
                              color: penHatchAim === v ? "#dff1f6" : "#9fb0c0",
                              border: "1px solid " + (penHatchAim === v ? "#3f7e8f" : "#26313c") }}>{lbl}</button>
                        ))}
                      </div>
                      <Slider label="tone from color" value={penHatchTone} min={0} max={1} step={0.05}
                        onChange={setPenHatchTone}
                        fmt={(v) => (v === 0 ? "even weave" : v.toFixed(2))} />
                    </>
                  )}
                  <Slider label="line width" value={penWidth} min={0.4} max={4} step={0.1}
                    onChange={setPenWidth} fmt={(v) => v.toFixed(1)} />
                  <Slider label="3D relief" value={penRelief} min={0} max={120} step={2}
                    onChange={setPenRelief}
                    fmt={(v) => (v === 0 || !perspective ? "flat" : String(v))} />
                  {penStyle !== "hatch" &&
                    <Toggle label="Hide obscured lines" value={penHidden} onChange={setPenHidden} />}
                  <div style={{ fontSize: 10, color: "#6d808f", marginTop: 2, lineHeight: 1.5,
                    fontFamily: "ui-monospace, monospace" }}>
                    {penStyle === "rings"
                      ? "Each color region filled with nested rings that follow its shape — like woodgrain."
                      : penStyle === "hatch"
                        ? "Every color region filled with straight parallel strokes at its own slant, engraving-style — "
                          + "the change of angle draws the edge, so no outline is plotted. "
                          + (penHatchSpread === 0 ? "Spread 0 lays one angle over the whole frame."
                             : HATCH_AIMS.find(([v]) => v === penHatchAim)[2] + ".")
                        : "Equally-spaced scan lines across the surface."}
                    {penStyle === "hatch"
                      ? (perspective
                          ? " Cut from the depth-sorted surface, so nearer crests hide what's behind without an extra pass."
                          : " Turn on Perspective for 3D.")
                      : (perspective ? " Lifted to the wave height (3D); nearer crests hide what's behind." : " Turn on Perspective for 3D.")}
                  </div>
                </div>
              )}
            </div>

            {solid3d && (
              <div style={{ marginBottom: 10 }}>
                <Slider label="export detail" value={exportQ} min={0} max={EXPORT_MULTS.length - 1}
                  step={1} onChange={setExportQ}
                  fmt={(v) => {
                    const m = EXPORT_MULTS[v], bw = exportRaster(rasterLevel, m).BW;
                    return (m === 1 ? "as previewed" : `${m}\u00d7 preview`) + ` \u00b7 ${bw}px`
                      + (bw === EXPORT_MAX_BW && rasterLevel.BW * m > EXPORT_MAX_BW ? " (capped)" : "");
                  }} />
                <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace" }}>
                  The file is a curve fitted to one crossing per raster pixel, so the preview's
                  raster is also the smallest wobble an edge can have — invisible at panel size,
                  a visible stair once the SVG is opened full-screen or printed. This retraces
                  the regions wider on the way out (the same picture, resolved finer), which is
                  what smooths the distant crests. It runs once per export and the page holds
                  still while it does — seconds at {RASTER_LEVELS[RASTER_LEVELS.length - 1].name}.
                </div>
                <Slider label="export mesh" value={exportMeshQ} min={0} max={EXPORT_MESHES.length - 1}
                  step={1} onChange={setExportMeshQ}
                  fmt={(v) => {
                    const m = EXPORT_MESHES[v], gn = exportRaster(rasterLevel, 1, m.f).gN;
                    return `${m.name} · ${gn}`
                      + (m.f < 1 && gn === EXPORT_MESH_FLOOR ? " (floor)" : "");
                  }} />
                <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace" }}>
                  The other half of the same trade. The raster sets how finely an edge is drawn;
                  this sets how much surface there is to draw, and the detail steps raise it
                  faster than any raster can resolve — so standing it down for the export is a
                  second way at the same jagged edge, and it works where a wider raster has
                  run out. Unlike detail, it changes the picture rather than resolving it:
                  crests round off a little and the smallest far-field wavelets stop showing
                  at all. Leave it as previewed for a faithful file; reach for it when a
                  distant edge still crawls at {EXPORT_MAX_BW}px.
                </div>
                <Slider label="edge polish" value={exportPolishQ} min={0} max={EXPORT_POLISH.length - 1}
                  step={1} onChange={setExportPolishQ}
                  fmt={(v) => {
                    const q = EXPORT_POLISH[v];
                    return q.passes ? `${q.name} · ${q.passes} passes` : q.name;
                  }} />
                <div style={{ fontSize: 9.5, color: "#6d808f", lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace" }}>
                  Smooths the field the regions are cut from, just before they are cut. What is
                  left on a far edge once the raster is as wide as it goes is the reflection
                  varying faster than one pixel, and this is the step that reaches it — before
                  the shapes are decided, so the bands stay parallel and a pinched-off speck
                  leaves cleanly rather than as a stray ring. Light takes the crawl and little
                  else. Strong goes further and starts to cost you the thinnest ribbons, which
                  fatten or break into dots — worth it for a still that has to hold up very
                  large, not much else.
                </div>
              </div>
            )}

            <button onClick={downloadSVG} disabled={exporting || pngBusy || vidBusy}
              style={{ width: "100%", background: exporting ? "#1f4650" : "#2f6b78", border: "none",
                color: exporting ? "#9fc4cd" : "#f1fbff",
                padding: "12px", borderRadius: 10, cursor: exporting ? "wait" : "pointer",
                fontSize: 13.5, fontWeight: 600, letterSpacing: 0.3 }}>
              {exporting ? `Tracing at ${exportAt.BW}px\u2026` : "Export SVG"}
            </button>

            <div style={{ marginTop: 12, marginBottom: 8 }}>
              <Slider label="PNG size" value={pngQ} min={0} max={PNG_SCALES.length - 1}
                step={1} onChange={setPngQ}
                fmt={(v) => {
                  const sz = pngSize(PNG_SCALES[v]);
                  return `${sz.w} \u00d7 ${sz.h}` + (sz.capped ? " (capped)" : "");
                }} />
            </div>
            <button onClick={downloadPNG} disabled={pngBusy || exporting || vidBusy}
              title="A pixel image of exactly what is on screen, at print size"
              style={{ width: "100%", background: pngBusy ? "#1f4650" : "#2f6b78", border: "none",
                color: pngBusy ? "#9fc4cd" : "#f1fbff",
                padding: "12px", borderRadius: 10, cursor: pngBusy ? "wait" : "pointer",
                fontSize: 13.5, fontWeight: 600, letterSpacing: 0.3 }}>
              {pngBusy ? `Rendering ${pngAt.w}\u00d7${pngAt.h}\u2026` : "Export PNG"}
            </button>
            <div style={{ fontSize: 10, color: "#6d808f", marginTop: 5, lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace" }}>
              {solid3d ? (
                <>
                  Pixels instead of paths, and the closest thing to the preview this page
                  can hand you. The steps above smooth the vector outline so it survives
                  being magnified — edge polish especially, which blurs the field before
                  the regions are cut and takes the smallest glints and highlights with
                  it. A raster has no outline to smooth, so the PNG runs neither polish
                  nor the mesh stand-down: it draws the preview's own geometry{pngRetrace
                    ? `, retraced at ${exportRaster(rasterLevel, exportMult).BW}px so the edges are resolved for a file this wide.`
                    : "."} Reach for it when the SVG loses something you can see on screen.
                </>
              ) : (
                <>
                  Pixels instead of paths: the same picture the SVG carries, drawn at print
                  size, for anywhere a vector file is not what you want.
                </>
              )}
            </div>

            {pngErr && (
              <div style={{ fontSize: 10.5, color: "#e0a37a", marginTop: 6, lineHeight: 1.5,
                fontFamily: "ui-monospace, monospace" }}>{pngErr}</div>
            )}

            {pngOut && (
              <div style={{ ...panel, marginTop: 12, marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ ...heading, margin: 0, flex: 1 }}>PNG</span>
                  <button onClick={() => {
                    try { if (pngUrlRef.current) URL.revokeObjectURL(pngUrlRef.current); } catch (e) {}
                    pngUrlRef.current = null; setPngOut(null);
                  }} style={{ ...miniBtn, flex: "none", padding: "4px 10px" }}>close</button>
                </div>
                {pngOut.url && (
                  <img src={pngOut.url} alt="exported PNG"
                    style={{ width: "100%", display: "block", borderRadius: 8,
                      border: "1px solid #26313c", marginBottom: 10 }} />
                )}
                <div style={{ fontSize: 10.5, color: "#8a9bab", marginBottom: 10, lineHeight: 1.5 }}>
                  {pngOut.w} × {pngOut.h} px · {(pngOut.bytes / 1024 / 1024).toFixed(1)} MB.
                  A download may have started. If not (some sandboxes block it), use the
                  button below.
                </div>
                {pngOut.url && (
                  <a href={pngOut.url} download={pngOut.name}
                    target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", background: "#1a232c", color: "#cfe6ec",
                      textAlign: "center", padding: "11px", borderRadius: 9, fontSize: 13,
                      fontWeight: 600, textDecoration: "none", border: "1px solid #2f6b78" }}>
                    Open / save PNG
                  </a>
                )}
              </div>
            )}

            <div style={{ marginTop: 14, marginBottom: 8 }}>
              <Slider label="video length" value={vidSec} min={VIDEO_MIN_SEC} max={VIDEO_MAX_SEC}
                step={0.5} onChange={setVidSec}
                fmt={(v) => {
                  const p = framePlan(v, speed);
                  return `${p.seconds.toFixed(1)} s \u00b7 ${p.count} frames`;
                }} />
              <Slider label="video size" value={vidQ} min={0} max={VIDEO_SCALES.length - 1}
                step={1} onChange={setVidQ}
                fmt={(v) => {
                  const sz = videoSize(VIDEO_SCALES[v], VB_W, VB_H);
                  return `${sz.w} \u00d7 ${sz.h}`;
                }} />
            </div>
            <button onClick={exportVideo} disabled={vidBusy || pngBusy || exporting}
              title="Render the animation frame by frame and write it as an MP4"
              style={{ width: "100%", background: vidBusy ? "#1f4650" : "#2f6b78", border: "none",
                color: vidBusy ? "#9fc4cd" : "#f1fbff",
                padding: "12px", borderRadius: 10, cursor: vidBusy ? "wait" : "pointer",
                fontSize: 13.5, fontWeight: 600, letterSpacing: 0.3 }}>
              {vidBusy
                ? `Rendering ${vidPlan.count} frames\u2026`
                : `Export MP4 \u00b7 ${vidPlan.seconds.toFixed(1)} s at ${VIDEO_FPS}fps`}
            </button>

            {vidProg && (
              <div style={{ marginTop: 8 }}>
                <div style={{ height: 8, borderRadius: 5, background: "#141c24",
                  border: "1px solid #26313c", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 4, background: "#4fb0c4",
                    width: `${Math.round((vidProg.done / vidProg.total) * 100)}%`,
                    transition: "width 120ms linear" }} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                  <span style={{ fontSize: 10.5, color: "#8a9bab", flex: 1,
                    fontFamily: "ui-monospace, monospace" }}>
                    frame {vidProg.done} / {vidProg.total}
                    {vidProg.done > 0 && vidProg.done < vidProg.total
                      ? ` \u00b7 ~${formatDuration(etaSeconds(vidProg.done, vidProg.total,
                          (Date.now() - vidProg.startedAt) / 1000))} left`
                      : ""}
                  </span>
                  <button onClick={cancelVideo}
                    style={{ ...miniBtn, flex: "none", padding: "4px 10px" }}>
                    {vidCancelRef.current ? "stopping\u2026" : "cancel"}
                  </button>
                </div>
              </div>
            )}

            <div style={{ fontSize: 10, color: "#6d808f", marginTop: 5, lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace" }}>
              The animation, written out at a steady {VIDEO_FPS}fps whatever this scene renders
              at live. Each frame is built at the wave phase it is due at — starting from
              t&nbsp;=&nbsp;0, ending at {vidPlan.endPhase.toFixed(1)} — so the file plays at the
              speed the scene was set up for, however long it takes to make. Detail costs the
              render, not the playback: a frame that takes two seconds on screen takes two
              seconds here too, and there are {vidPlan.count} of them. The picture is the
              preview's own geometry, like the PNG — no polish pass, no export retrace.
              {speed === 0 ? " Speed is at zero, so every frame would be identical." : ""}
            </div>

            {vidErr && (
              <div style={{ fontSize: 10.5, color: "#e0a37a", marginTop: 6, lineHeight: 1.5,
                fontFamily: "ui-monospace, monospace" }}>{vidErr}</div>
            )}

            {vidOut && (
              <div style={{ ...panel, marginTop: 12, marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ ...heading, margin: 0, flex: 1 }}>MP4</span>
                  <button onClick={() => {
                    try { if (vidUrlRef.current) URL.revokeObjectURL(vidUrlRef.current); } catch (e) {}
                    vidUrlRef.current = null; setVidOut(null);
                  }} style={{ ...miniBtn, flex: "none", padding: "4px 10px" }}>close</button>
                </div>
                {vidOut.url && (
                  <video src={vidOut.url} controls loop playsInline
                    style={{ width: "100%", display: "block", borderRadius: 8,
                      border: "1px solid #26313c", marginBottom: 10 }} />
                )}
                <div style={{ fontSize: 10.5, color: "#8a9bab", marginBottom: 10, lineHeight: 1.5 }}>
                  {vidOut.w} × {vidOut.h} px · {vidOut.seconds.toFixed(1)} s ·
                  {" "}{vidOut.frames} frames · {(vidOut.bytes / 1024 / 1024).toFixed(1)} MB.
                  A download may have started. If not (some sandboxes block it), use the
                  button below.
                  {vidOut.entry === "vp09" && (
                    <> This browser has no H.264 encoder, so the file carries VP9 instead —
                      still an .mp4, and Chrome, Firefox, VLC and Windows play it, but
                      QuickTime and some editors will not.</>
                  )}
                </div>
                {vidOut.url && (
                  <a href={vidOut.url} download={vidOut.name}
                    target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", background: "#1a232c", color: "#cfe6ec",
                      textAlign: "center", padding: "11px", borderRadius: 9, fontSize: 13,
                      fontWeight: 600, textDecoration: "none", border: "1px solid #2f6b78" }}>
                    Open / save MP4
                  </a>
                )}
              </div>
            )}

            <button onClick={exportPaperStack} disabled={penMode || vidBusy}
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
              rebuilds the scene when stacked in order. Cut from the picture on screen —
              the 3D surface, what the crests hide, and the current framing included —
              posterized to at most {PAPER_MAX_COLORS} colors, since paper is not a gradient.
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
