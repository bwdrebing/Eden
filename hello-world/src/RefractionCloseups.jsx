import React, { useState, useMemo, useRef, useEffect } from "react";
import * as d3 from "d3";

/* ------------------------------------------------------------------ *
 *  Refraction closeup studio
 *  A head-on macro view through a clear liquid: champagne bubbles,
 *  chunks of ice. Each clear object contributes an optical thickness
 *  field h(x,y); a view ray is deflected by ∇h (thin-lens/prism
 *  approximation) and so samples the background light gradient at a
 *  shifted position:  ν(x,y) = base(x,y) + A·tanh(K·∇h·L̂).
 *  Color bands = isobands of ν. Same recipe as the reflection studio —
 *  contour one continuous scalar field, get real vector regions.
 * ------------------------------------------------------------------ */

const PALETTES = {
  "Champagne":  ["#2a1608", "#5a2f0e", "#9a5a14", "#d18a24", "#eec258", "#f8e6a8", "#fdf6dd"],
  "Glacier":    ["#06283c", "#0d4a66", "#1f7a99", "#57b3c9", "#a8dde8", "#e4f6f8", "#ffffff"],
  "Deep Pool":  ["#04141f", "#0a2f43", "#155a72", "#2d8a96", "#66bcae", "#c0e8cf", "#f2fbe8"],
  "Rosé":       ["#2b0f1c", "#5c1f33", "#963a4b", "#cc6656", "#eb9c6a", "#f7cf9a", "#fdf0d8"],
  "Obra Dinn":  ["#0b0b0b", "#262626", "#565656", "#8f8f8f", "#c7c7c7", "#f2f2f2"],
};

const VB_W = 760;
const VB_H = 500;
const ASP = VB_W / VB_H; // scene x ∈ [-ASP, ASP], y ∈ [-1, 1] (y up)

// ---- seeded RNG -----------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- scene generation ----------------------------------------------
// Bubbles: {x0, y0, r, sp (rise speed), ph (wobble phase), wob}
// Chunks:  {cx, cy, R, vx[], vy[], er (edge radius), hgt, bound2,
//           facets as parallel arrays fsx/fsy (softmax seed dirs) and
//           fgx/fgy/fc (per-facet plane gradients + offsets), bob}
function makeScene({ seed, bubbleCount, bubbleSize, bubbleMode, chunkCount, chunkSize }) {
  const rnd = mulberry32((seed * 2654435761) >>> 0 || 1);

  const bubbles = [];
  if (bubbleMode === "rise") {
    // champagne: strings of bubbles rising from nucleation points,
    // growing as they climb
    const cols = Math.max(1, Math.round(bubbleCount / 9));
    const perCol = Math.max(1, Math.round(bubbleCount / cols));
    for (let c = 0; c < cols; c++) {
      const x0 = (rnd() * 2 - 1) * (ASP - 0.15);
      const ph = rnd() * Math.PI * 2;
      for (let i = 0; i < perCol; i++) {
        const prog = (i + rnd() * 0.6) / perCol;          // 0 bottom → 1 top
        const r = bubbleSize * (0.45 + 0.95 * prog) * (0.75 + 0.5 * rnd());
        bubbles.push({
          x0, y0: -1.1 + 2.3 * prog, r,
          sp: 0.18 + 1.6 * r, ph: ph + prog * 5,
          wob: 0.025 + r * 0.6,
        });
      }
    }
  } else {
    for (let i = 0; i < bubbleCount; i++) {
      const u = rnd();
      bubbles.push({
        x0: (rnd() * 2 - 1) * (ASP - 0.1),
        y0: (rnd() * 2 - 1) * 0.95,
        r: bubbleSize * (0.5 + 1.3 * u * u),
        sp: 0.1 + rnd() * 0.2, ph: rnd() * Math.PI * 2, wob: 0.02,
      });
    }
  }

  const chunks = [];
  for (let m = 0; m < chunkCount; m++) {
    const R = chunkSize * (0.75 + 0.5 * rnd());
    // scatter with loose overlap rejection
    let cx = 0, cy = 0;
    for (let att = 0; att < 14; att++) {
      cx = (rnd() * 2 - 1) * (ASP - 0.5 * R);
      cy = (rnd() * 2 - 1) * Math.max(0.1, 1 - 0.55 * R);
      let ok = true;
      for (const o of chunks) {
        if (Math.hypot(cx - o.cx, cy - o.cy) < 0.72 * (R + o.R)) { ok = false; break; }
      }
      if (ok) break;
    }
    // irregular convex-ish outline: jittered angles + radii
    const k = 5 + Math.floor(rnd() * 3);
    const rot = rnd() * Math.PI * 2;
    const vx = [], vy = [];
    for (let i = 0; i < k; i++) {
      const a = rot + (i + (rnd() - 0.5) * 0.55) * (2 * Math.PI / k);
      const rr = R * (0.72 + 0.45 * rnd());
      vx.push(Math.cos(a) * rr); vy.push(Math.sin(a) * rr);
    }
    // internal facets: softmax-blended tilted planes → prism-like
    // regions inside the ice, soft "crack" seams between them
    const nf = 3 + Math.floor(rnd() * 3);
    const fsx = [], fsy = [], fgx = [], fgy = [], fc = [];
    for (let f = 0; f < nf; f++) {
      const sa = rnd() * Math.PI * 2;
      fsx.push(Math.cos(sa)); fsy.push(Math.sin(sa));
      const ga = rnd() * Math.PI * 2;
      const gm = (0.35 + 0.75 * rnd()) / R;
      fgx.push(Math.cos(ga) * gm); fgy.push(Math.sin(ga) * gm);
      fc.push((rnd() - 0.5) * 0.6);
    }
    const er = R * (0.16 + 0.14 * rnd());
    chunks.push({
      cx, cy, R, vx, vy, er,
      hgt: R * 0.85,
      bound2: (R * 1.25 + er) * (R * 1.25 + er),
      fsx, fsy, fgx, fgy, fc,
      bob: rnd() * Math.PI * 2,
    });
  }
  return { bubbles, chunks };
}

// exact signed distance to a polygon (negative inside) — iq's formula
function polySDF(px, py, VX, VY) {
  const n = VX.length;
  let d = (px - VX[0]) * (px - VX[0]) + (py - VY[0]) * (py - VY[0]);
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = VX[j] - VX[i], ey = VY[j] - VY[i];
    const wx = px - VX[i], wy = py - VY[i];
    const tt = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * tt, by = wy - ey * tt;
    const dd = bx * bx + by * by;
    if (dd < d) d = dd;
    const c1 = py >= VY[i], c2 = py < VY[j], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// optical thickness at a scene point, given per-frame object positions
function heightAt(sx, sy, P) {
  let h = 0;
  if (P.shimmer > 0) {
    const t = P.t;
    h += P.shimmer * (0.55 * Math.sin(2.1 * sx + 2.9 * sy + 0.8 * t + 0.7)
                    + 0.30 * Math.sin(4.3 * sx - 3.1 * sy - 0.6 * t + 2.3)
                    + 0.15 * Math.sin(6.7 * sx + 5.3 * sy + 1.1 * t + 4.1));
  }
  for (const b of P.pb) {          // bubbles: a gas sphere is LESS optical
    const dx = sx - b.x, dy = sy - b.y;       // path → negative spherical cap
    const d2 = dx * dx + dy * dy;
    if (d2 < b.r2) h -= Math.sqrt(b.r2 - d2);
  }
  for (const ch of P.pc) {
    const lx = sx - ch.cx, ly = sy - ch.cy;
    if (lx * lx + ly * ly > ch.bound2) continue;
    const sd = polySDF(lx, ly, ch.vx, ch.vy);
    if (sd >= 0) continue;
    const t01 = Math.min(1, -sd / ch.er);     // 0 at outline → 1 one edge-radius in
    const rim = Math.sin(t01 * Math.PI / 2);  // rounded shoulder, flat top
    let f = 0;
    if (P.facet > 0) {
      let num = 0, den = 0;
      for (let k = 0; k < ch.fsx.length; k++) {
        const w = Math.exp(8 * (ch.fsx[k] * lx + ch.fsy[k] * ly) / ch.R);
        num += w * (ch.fgx[k] * lx + ch.fgy[k] * ly + ch.fc[k]);
        den += w;
      }
      f = num / den;
    }
    h += ch.hgt * (rim + P.facet * t01 * f);
  }
  return h;
}

// light separable box blur (same trick as the reflection studio)
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

// ---- contour → smooth bezier path (grid → screen is a plain scale) --
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

// grid is padded one cell on each side, so contours overshoot the frame
// instead of tracing it; the SVG viewBox clips the overhang
function multiToPath(multi, nx, ny, iters) {
  let d = "";
  for (const poly of multi.coordinates) {
    for (const ring0 of poly) {
      const ring = iters ? chaikin(ring0, iters) : ring0;
      const pts = [];
      for (const [gi, gj] of ring) {
        pts.push([((gi - 1) / nx) * VB_W, ((gj - 1) / ny) * VB_H]);
      }
      if (iters) {
        const simp = simplifyRing(pts, 1.1);
        if (simp.length >= 3) { d += ringToBezier(simp); continue; }
      }
      for (let i = 0; i < pts.length; i++) {
        d += (i === 0 ? "M" : "L") + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1) + " ";
      }
      d += "Z ";
    }
  }
  return d;
}

// ---- field build -----------------------------------------------------
function buildLayers(scene, P) {
  const { nx, ny } = P;
  const px = nx + 2, py = ny + 2;      // contoured grid (1-cell pad)
  const hw = nx + 4, hh = ny + 4;      // thickness grid (extra ring for diffs)

  // per-frame object positions
  const pb = scene.bubbles.map((b) => {
    let x = b.x0, y = b.y0;
    if (P.rise) {
      const span = 2.3 + 2 * b.r;
      y = ((b.y0 + 1.15 + b.r + P.t * b.sp) % span + span) % span - 1.15 - b.r;
      x = b.x0 + b.wob * Math.sin(y * 5 + b.ph);
    }
    return { x, y, r2: b.r * b.r };
  });
  const pc = scene.chunks.map((ch) => ({
    ...ch, cy: ch.cy + (P.rise ? 0.012 * Math.sin(P.t * 0.7 + ch.bob) : 0),
  }));
  const HP = { ...P, pb, pc };

  const H = new Float64Array(hw * hh);
  for (let j = 0; j < hh; j++) {
    const sy = 1 - ((j - 2 + 0.5) / ny) * 2;
    for (let i = 0; i < hw; i++) {
      const sx = (((i - 2 + 0.5) / nx) * 2 - 1) * ASP;
      H[j * hw + i] = heightAt(sx, sy, HP);
    }
  }

  const dxs = (2 * ASP) / nx, dys = 2 / ny;
  const la = (P.lightAngle * Math.PI) / 180;
  const dirx = Math.sin(la), diry = Math.cos(la);
  const uNorm = Math.abs(dirx) * ASP + Math.abs(diry);
  const V = new Float64Array(px * py);
  const G = new Float64Array(px * py);
  for (let j = 0; j < py; j++) {
    const sy = 1 - ((j - 1 + 0.5) / ny) * 2;
    const r = j + 1;
    for (let i = 0; i < px; i++) {
      const sx = (((i - 1 + 0.5) / nx) * 2 - 1) * ASP;
      const q = r * hw + (i + 1);
      const hx = (H[q + 1] - H[q - 1]) / (2 * dxs);
      const hy = (H[q - hw] - H[q + hw]) / (2 * dys);      // d/dsy, sy up
      const lap = (H[q + 1] + H[q - 1] - 2 * H[q]) / (dxs * dxs)
                + (H[q + hw] + H[q - hw] - 2 * H[q]) / (dys * dys);
      const base = 0.5 + 0.5 * ((dirx * sx - diry * sy) / uNorm);
      const g = dirx * hx - diry * hy;                     // deflection along L̂
      const p = j * px + i;
      V[p] = base + P.refr * Math.tanh(P.density * g);
      G[p] = Math.tanh(lap / 6);
    }
  }
  if (P.soften > 0) {
    const tmp = new Float64Array(px * py);
    blurField(V, px, py, tmp, P.soften);
    if (P.glints) blurField(G, px, py, tmp, P.soften);
  }

  let lo = Infinity, hi = -Infinity;
  for (const v of V) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const NB = P.bands;
  const thresholds = d3.range(1, NB).map((k) => lo + ((hi - lo) * k) / NB);
  const conts = d3.contours().size([px, py]).thresholds(thresholds)(V);
  const ds = conts.map((c) => multiToPath(c, nx, ny, P.smooth));

  let brightD = "", darkD = "";
  if (P.glints) {
    const tau = P.glintThresh;
    brightD = multiToPath(d3.contours().size([px, py]).thresholds([tau])(G)[0], nx, ny, P.smooth);
    const NG = new Float64Array(px * py);
    for (let p = 0; p < NG.length; p++) NG[p] = -G[p];
    darkD = multiToPath(d3.contours().size([px, py]).thresholds([tau])(NG)[0], nx, ny, P.smooth);
  }
  return { ds, brightD, darkD, lo, hi };
}

function bandColors(NB, palette) {
  const interp = d3.interpolateRgbBasis(PALETTES[palette]);
  return d3.range(NB).map((k) => interp(NB === 1 ? 0 : k / (NB - 1)));
}

// ---- scene presets ---------------------------------------------------
const PRESETS = {
  "Champagne": {
    bubbleCount: 64, bubbleSize: 0.055, bubbleMode: "rise",
    chunkCount: 0, chunkSize: 0.5, facet: 0.55,
    refr: 0.42, density: 3.2, shimmer: 0.014, lightAngle: 8,
    palette: "Champagne", glints: true, glintThresh: 0.86,
  },
  "Ice water": {
    bubbleCount: 7, bubbleSize: 0.035, bubbleMode: "drift",
    chunkCount: 3, chunkSize: 0.5, facet: 0.6,
    refr: 0.46, density: 3.0, shimmer: 0.02, lightAngle: -12,
    palette: "Glacier", glints: true, glintThresh: 0.88,
  },
  "On the rocks": {
    bubbleCount: 26, bubbleSize: 0.045, bubbleMode: "rise",
    chunkCount: 2, chunkSize: 0.55, facet: 0.5,
    refr: 0.44, density: 3.2, shimmer: 0.016, lightAngle: 5,
    palette: "Rosé", glints: true, glintThresh: 0.87,
  },
};

// ---- UI bits (visual language shared with the reflection studio) ----
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

function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export default function RefractionCloseups() {
  const width = useWidth();
  const isNarrow = width < 820;

  const [preset, setPreset] = useState("Champagne");
  const [seed, setSeed] = useState(7);
  const [bubbleCount, setBubbleCount] = useState(PRESETS.Champagne.bubbleCount);
  const [bubbleSize, setBubbleSize] = useState(PRESETS.Champagne.bubbleSize);
  const [bubbleMode, setBubbleMode] = useState(PRESETS.Champagne.bubbleMode);
  const [chunkCount, setChunkCount] = useState(PRESETS.Champagne.chunkCount);
  const [chunkSize, setChunkSize] = useState(PRESETS.Champagne.chunkSize);
  const [facet, setFacet] = useState(PRESETS.Champagne.facet);
  const [refr, setRefr] = useState(PRESETS.Champagne.refr);
  const [density, setDensity] = useState(PRESETS.Champagne.density);
  const [shimmer, setShimmer] = useState(PRESETS.Champagne.shimmer);
  const [lightAngle, setLightAngle] = useState(PRESETS.Champagne.lightAngle);
  const [glints, setGlints] = useState(PRESETS.Champagne.glints);
  const [glintThresh, setGlintThresh] = useState(PRESETS.Champagne.glintThresh);
  const [palette, setPalette] = useState(PRESETS.Champagne.palette);

  const [bands, setBands] = useState(9);
  const [smooth, setSmooth] = useState(2);
  const [soften, setSoften] = useState(1);
  const [edges, setEdges] = useState(false);
  const [quality, setQuality] = useState(() =>
    (typeof window !== "undefined" && window.innerWidth < 820) ? 96 : 128);
  const [animate, setAnimate] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [svgOut, setSvgOut] = useState(null);
  const [copied, setCopied] = useState(false);

  const applyPreset = (name) => {
    const p = PRESETS[name];
    setPreset(name);
    setBubbleCount(p.bubbleCount); setBubbleSize(p.bubbleSize); setBubbleMode(p.bubbleMode);
    setChunkCount(p.chunkCount); setChunkSize(p.chunkSize); setFacet(p.facet);
    setRefr(p.refr); setDensity(p.density); setShimmer(p.shimmer);
    setLightAngle(p.lightAngle); setPalette(p.palette);
    setGlints(p.glints); setGlintThresh(p.glintThresh);
  };

  const tRef = useRef(0);
  const [, force] = useState(0);
  useEffect(() => {
    if (!animate) return;
    let raf;
    const loop = () => { tRef.current += 0.05 * speed; force((n) => n + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate, speed]);

  const scene = useMemo(
    () => makeScene({ seed, bubbleCount, bubbleSize, bubbleMode, chunkCount, chunkSize }),
    [seed, bubbleCount, bubbleSize, bubbleMode, chunkCount, chunkSize]);

  const P = useMemo(() => ({
    nx: quality, ny: Math.round(quality * VB_H / VB_W),
    refr, density, shimmer, lightAngle, facet,
    bands, smooth, soften, glints, glintThresh,
    rise: bubbleMode === "rise" || animate,
    t: animate ? tRef.current : 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [quality, refr, density, shimmer, lightAngle, facet, bands, smooth, soften,
       glints, glintThresh, bubbleMode, animate, speed, tRef.current]);

  const geom = useMemo(() => buildLayers(scene, P), [scene, P]);
  const colors = useMemo(() => bandColors(bands, palette), [bands, palette]);
  const brightC = PALETTES[palette][PALETTES[palette].length - 1];
  const darkC = PALETTES[palette][0];
  const layers = geom.ds.map((d, k) => ({ d, color: colors[k + 1] }));
  const regionCount = layers.length + 1 + (glints ? 2 : 0);

  const buildSvg = () => {
    const stroke = edges ? ` stroke="#000" stroke-opacity="0.25" stroke-width="0.6"` : "";
    let body = `<rect width="${VB_W}" height="${VB_H}" fill="${colors[0]}"/>`;
    layers.forEach((l) => {
      body += `<path d="${l.d}" fill="${l.color}" fill-rule="evenodd"${stroke}/>`;
    });
    if (glints && geom.darkD) body += `<path d="${geom.darkD}" fill="${darkC}" fill-rule="evenodd"${stroke}/>`;
    if (glints && geom.brightD) body += `<path d="${geom.brightD}" fill="${brightC}" fill-rule="evenodd"${stroke}/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${body}</svg>`;
  };
  const downloadSVG = () => {
    const svg = buildSvg();
    try {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a");
      a.href = url; a.download = "refraction-closeup.svg";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { /* sandbox may block downloads */ }
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
  const chip = (on) => ({
    flex: "1 0 30%", padding: "8px 6px", fontSize: 11, borderRadius: 7,
    cursor: "pointer", fontFamily: "ui-monospace, monospace",
    background: on ? "#27424b" : "#1a232c",
    color: on ? "#dff1f6" : "#9fb0c0",
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
            fontFamily: "ui-monospace, monospace" }}>SCALAR FIELD · ν = REFRACTED BACKGROUND</div>
          <h1 style={{ fontSize: isNarrow ? 21 : 27, margin: "4px 0 4px", fontWeight: 600,
            fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: -0.2 }}>
            Refraction Closeup Studio
          </h1>
          {!isNarrow && (
            <p style={{ fontSize: 13.5, color: "#8a9bab", maxWidth: 620, lineHeight: 1.5, margin: 0 }}>
              A macro view through the glass: champagne bubbles and chunks of ice bend
              the light gradient behind them. Every band is a level set of one refracted
              field — contoured into real vector regions, not pixels.
            </p>
          )}
        </header>

        <div style={{ display: isNarrow ? "block" : "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16, alignItems: "start" }}>

          {/* PREVIEW */}
          <div style={{ background: "#05080b", borderRadius: 14, border: "1px solid #1b2530",
            overflow: "hidden", position: "sticky",
            top: isNarrow ? 8 : 22, zIndex: 5,
            marginBottom: isNarrow ? 14 : 0,
            boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }}>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ width: "100%", display: "block" }}>
              <rect width={VB_W} height={VB_H} fill={colors[0]} />
              {layers.map((l, i) => (
                <path key={i} d={l.d} fill={l.color} fillRule="evenodd"
                  stroke={edges ? "#000" : "none"} strokeOpacity={edges ? 0.28 : 0}
                  strokeWidth={edges ? 0.6 : 0} />
              ))}
              {glints && geom.darkD && (
                <path d={geom.darkD} fill={darkC} fillRule="evenodd" />
              )}
              {glints && geom.brightD && (
                <path d={geom.brightD} fill={brightC} fillRule="evenodd" />
              )}
            </svg>
            <div style={{ position: "absolute", left: 12, bottom: 10, fontSize: 10.5,
              color: "#6d808f", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5 }}>
              {regionCount} regions · {P.nx}×{P.ny} sample grid
            </div>
          </div>

          {/* CONTROLS */}
          <div>
            <div style={panel}>
              <div style={heading}>Scene</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {Object.keys(PRESETS).map((p) => (
                  <button key={p} onClick={() => applyPreset(p)} style={chip(preset === p)}>{p}</button>
                ))}
              </div>
              <button onClick={() => setSeed((s) => s + 1)}
                style={{ width: "100%", padding: "9px", borderRadius: 8, cursor: "pointer",
                  background: "#1a232c", color: "#9fd0d9", border: "1px solid #2f6b78",
                  fontFamily: "ui-monospace, monospace", fontSize: 12, marginBottom: 12 }}>
                ⟳ shuffle arrangement · #{seed}
              </button>
              <Slider label="Bubbles" value={bubbleCount} min={0} max={120} step={1} onChange={setBubbleCount} />
              {bubbleCount > 0 && <>
                <Slider label="Bubble size" value={bubbleSize} min={0.02} max={0.16} step={0.005}
                  onChange={setBubbleSize} fmt={(v) => (v * 100).toFixed(1)} />
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  {[["rise", "Rising strings"], ["drift", "Scattered"]].map(([v, lbl]) => (
                    <button key={v} onClick={() => setBubbleMode(v)} style={chip(bubbleMode === v)}>{lbl}</button>
                  ))}
                </div>
              </>}
              <Slider label="Ice chunks" value={chunkCount} min={0} max={5} step={1} onChange={setChunkCount} />
              {chunkCount > 0 && <>
                <Slider label="Chunk size" value={chunkSize} min={0.2} max={0.8} step={0.02}
                  onChange={setChunkSize} fmt={(v) => v.toFixed(2)} />
                <Slider label="Facet relief" value={facet} min={0} max={1} step={0.02}
                  onChange={setFacet} fmt={(v) => (v === 0 ? "smooth" : v < 0.4 ? "gentle" : v < 0.75 ? "cracked" : "shattered")} />
              </>}
            </div>

            <div style={panel}>
              <div style={heading}>Optics</div>
              <Slider label="Refraction strength" value={refr} min={0.05} max={0.6} step={0.01}
                onChange={setRefr} fmt={(v) => v.toFixed(2)} />
              <Slider label="Optical density" value={density} min={0.8} max={8} step={0.1}
                onChange={setDensity} fmt={(v) => v.toFixed(1)} />
              <Slider label="Liquid shimmer" value={shimmer} min={0} max={0.05} step={0.001}
                onChange={setShimmer} fmt={(v) => (v === 0 ? "still" : (v * 1000).toFixed(0))} />
              <Slider label="Light tilt" value={lightAngle} min={-45} max={45} step={1}
                onChange={setLightAngle} fmt={(v) => v + "°"} />
              <Toggle label="Glints (bright / dark rims)" value={glints} onChange={setGlints} />
              {glints && (
                <Slider label="Glint threshold" value={glintThresh} min={0.4} max={0.97} step={0.01}
                  onChange={setGlintThresh} fmt={(v) => v.toFixed(2)} />
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Environment</div>
              <Slider label="Color regions" value={bands} min={3} max={16} step={1} onChange={setBands} />
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {Object.keys(PALETTES).map((p) => (
                  <button key={p} onClick={() => setPalette(p)} style={chip(palette === p)}>{p}</button>
                ))}
              </div>
              <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden",
                border: "1px solid #26313c" }}>
                {colors.map((c, i) => (<div key={i} style={{ flex: 1, background: c }} />))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5,
                color: "#6d808f", marginTop: 3, fontFamily: "ui-monospace, monospace" }}>
                <span>deep</span><span>toward the light</span>
              </div>
            </div>

            <div style={panel}>
              <div style={heading}>Display</div>
              <Slider label="Edge smoothing" value={smooth} min={0} max={4} step={1}
                onChange={setSmooth} fmt={(v) => (v === 0 ? "off (crisp)" : v + "×")} />
              <Slider label="Field softening" value={soften} min={0} max={4} step={1}
                onChange={setSoften} fmt={(v) => (v === 0 ? "raw" : v + "×")} />
              <Slider label="Sample grid" value={quality} min={70} max={170} step={10} onChange={setQuality} />
              <Toggle label="Show region edges" value={edges} onChange={setEdges} />
              <Toggle label="Animate (bubbles rise)" value={animate} onChange={setAnimate} />
              {animate && (
                <div style={{ marginTop: 8 }}>
                  <Slider label="Speed" value={speed} min={0.1} max={1.5} step={0.05}
                    onChange={setSpeed} fmt={(v) => v.toFixed(2)} />
                </div>
              )}
            </div>

            <button onClick={downloadSVG}
              style={{ width: "100%", background: "#2f6b78", border: "none", color: "#f1fbff",
                padding: "12px", borderRadius: 10, cursor: "pointer", fontSize: 13.5,
                fontWeight: 600, letterSpacing: 0.3 }}>
              Export SVG
            </button>

            {svgOut && (
              <div style={{ ...panel, marginTop: 12, marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ ...heading, margin: 0, flex: 1 }}>Export</span>
                  <button onClick={() => setSvgOut(null)}
                    style={{ ...miniBtn, flex: "none", padding: "4px 10px" }}>close</button>
                </div>
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
                    download="refraction-closeup.svg" target="_blank" rel="noopener noreferrer"
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
                  Or select all in the box above and copy. {(svgOut.length / 1024).toFixed(0)} KB · {regionCount} regions.
                </div>
              </div>
            )}

            <p style={{ fontSize: 10.5, color: "#5f7384", marginTop: 8, lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace" }}>
              Exports as {regionCount} vector regions. Bubble rims and ice facets are
              genuine contour curves, so the vector stays clean at any zoom.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
