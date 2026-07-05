import React, { useState, useMemo, useEffect } from "react";
import * as d3 from "d3";

/* ------------------------------------------------------------------ *
 *  Liquid macro studio
 *  Chaotic closeups of liquid, ice and carbonation, in the manner of
 *  photorealist macro paintings: flat posterized color regions with
 *  swirling, flow-stretched edges, plus white paint-glint shapes.
 *
 *  Two scalar fields drive everything:
 *   tone  = fBm noise, domain-warped twice, stretched along a flow
 *           direction → contoured into palette bands (the liquid)
 *   glint = ridged fBm sharing the same warp → thresholded twice into
 *           cream + white highlight shapes (the specular filigree)
 *  Carbonation stamps each bubble into both fields: a bright ring and
 *  dark core into tone, a light-facing crescent into glint.
 * ------------------------------------------------------------------ */

const VB_W = 760;
const VB_H = 500;
const ASP = VB_W / VB_H; // scene x ∈ [0, ASP], y ∈ [0, 1]

const PALETTES = {
  "Amber Rush": ["#2a0e07", "#5c1d0f", "#8c3015", "#b5541d", "#d47f2c", "#e8a94a", "#f0cf7f", "#f8e9c4"],
  "Cola":       ["#160502", "#3d1206", "#6b2109", "#9c3a10", "#c65e1b", "#e08a2e", "#efbb5e", "#f8e4ab"],
  "Deep Fizz":  ["#04060e", "#0a1130", "#1a295e", "#324790", "#5872b8", "#8ba3d8", "#c3d3ee", "#eef4fb"],
  "Green Glass": ["#04120a", "#0c2c18", "#1c4f2a", "#397840", "#66a25c", "#9cc687", "#cfe4b8", "#f2f8e2"],
  "Obra Dinn":  ["#0b0b0b", "#262626", "#565656", "#8f8f8f", "#c7c7c7", "#f2f2f2"],
};

const PRESETS = {
  "Whiskey swirl": {
    palette: "Amber Rush", bands: 10, warp: 1.25, detail: 3.4, stretch: 2.0, flow: 28,
    bubbles: 10, bubbleSize: 0.026, glint: 0.8, glintAmt: 1.0, contrast: 1.25, depth: 1.0,
  },
  "Blue fizz": {
    palette: "Deep Fizz", bands: 9, warp: 0.6, detail: 2.5, stretch: 1.15, flow: -18,
    bubbles: 64, bubbleSize: 0.034, glint: 0.9, glintAmt: 0.8, contrast: 1.35, depth: 2.1,
  },
  "Cola & ice": {
    palette: "Cola", bands: 10, warp: 0.95, detail: 2.9, stretch: 1.55, flow: 40,
    bubbles: 34, bubbleSize: 0.022, glint: 0.84, glintAmt: 0.9, contrast: 1.25, depth: 1.5,
  },
};

// ---- noise -----------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFbm(seed) {
  const S = (seed * 1013.13) % 1000;
  const h = (i, j) => {
    const n = Math.sin(i * 127.1 + j * 311.7 + S * 0.137) * 43758.5453;
    return n - Math.floor(n);
  };
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, y, oct) => {
    let s = 0, amp = 0.5, tot = 0;
    for (let o = 0; o < oct; o++) {
      s += amp * vnoise(x, y); tot += amp;
      x = x * 2.03 + 17.31; y = y * 2.01 + 11.7; amp *= 0.5;
    }
    return s / tot;
  };
}

// ---- contour → smooth bezier path -----------------------------------
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

// padded grid: contours overshoot the frame, the viewBox clips them
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

// ---- bubbles ---------------------------------------------------------
function makeBubbles(P) {
  const rnd = mulberry32((P.seed * 2654435761) >>> 0 || 1);
  const out = [];
  let left = P.bubbles;
  while (left > 0) {
    // a cluster: several bubbles crowded together, like foam on a rim
    const n = Math.min(left, 2 + Math.floor(rnd() * 8));
    const cxp = rnd() * ASP, cyp = rnd();
    const spread = 0.05 + rnd() * 0.09;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rr = spread * Math.sqrt(rnd());
      out.push({
        x: cxp + Math.cos(a) * rr,
        y: cyp + Math.sin(a) * rr * 0.8,
        r: P.bubbleSize * (0.45 + 1.4 * rnd() * rnd()),
      });
    }
    left -= n;
  }
  return out;
}

// replace each value with its rank / N — an in-place histogram equalization
function equalize(A) {
  const n = A.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const arr = Array.from(idx).sort((a, b) => A[a] - A[b]);
  for (let r = 0; r < n; r++) A[arr[r]] = r / (n - 1);
}

// ---- field build -----------------------------------------------------
function buildLayers(P) {
  const nx = P.nx, ny = Math.round(P.nx * VB_H / VB_W);
  const px = nx + 2, py = ny + 2;
  const fbm = makeFbm(P.seed);
  const fl = (P.flow * Math.PI) / 180;
  const cF = Math.cos(fl), sF = Math.sin(fl);
  const bubbles = makeBubbles(P);
  const LGT = Math.PI * 0.75; // glint crescents face upper-left

  const T = new Float64Array(px * py);
  const G = new Float64Array(px * py);
  for (let j = 0; j < py; j++) {
    const sy = ((j - 1 + 0.5) / ny);
    for (let i = 0; i < px; i++) {
      const sx = ((i - 1 + 0.5) / nx) * ASP;
      // flow-aligned, stretched noise coordinates
      const u = (cF * sx + sF * sy) / P.stretch;
      const v = (-sF * sx + cF * sy);
      // two rounds of domain warping — the painted swirl
      let qx = u + P.warp * 0.8 * (fbm(u * 1.6 + 11.3, v * 1.6 + 7.7, 3) - 0.5);
      let qy = v + P.warp * 0.8 * (fbm(u * 1.6 + 27.1, v * 1.6 + 91.2, 3) - 0.5);
      qx += P.warp * 0.4 * (fbm(qx * 3.1 + 3.4, qy * 3.1 + 53.2, 3) - 0.5);
      qy += P.warp * 0.4 * (fbm(qx * 3.1 + 19.9, qy * 3.1 + 41.6, 3) - 0.5);
      let tone = fbm(qx * P.detail, qy * P.detail, 4);
      let spec = fbm(qx * P.detail * 1.9 + 77.7, qy * P.detail * 1.9 + 33.3, 4);
      spec = 1 - Math.abs(2 * spec - 1);          // ridged: peaks along veins
      spec = spec * spec * spec;
      spec *= 0.55 + 0.9 * tone;                  // glints live in the light
      // carbonation
      for (const b of bubbles) {
        const dx = sx - b.x, dy = sy - b.y;
        const d2 = dx * dx + dy * dy, R3 = b.r * 3;
        if (d2 > R3 * R3) continue;
        const d = Math.sqrt(d2);
        const ring = Math.exp(-((d - b.r) * (d - b.r)) / (b.r * b.r * 0.09));
        const core = Math.exp(-(d2 / (b.r * b.r)) * 1.6);
        tone += 0.42 * ring - 0.30 * core;
        const cres = ring * Math.pow(Math.max(0, Math.cos(Math.atan2(-dy, dx) - LGT)), 3);
        spec += 1.5 * cres * P.glintAmt;
      }
      const p = j * px + i;
      T[p] = tone;
      G[p] = spec;
    }
  }

  // Histogram-equalize both fields: values become area ranks in [0,1], so
  // thresholds are literal area fractions — every band is guaranteed real
  // coverage, and deep shadow / bright cream regions appear like a painter
  // would allot them. fBm alone bunches around the middle and never would.
  equalize(T);
  equalize(G);
  // S-curve contrast, then a dark bias (gamma) — carbonation scenes live
  // mostly in deep shadow with the light concentrated at the bubbles
  for (let p = 0; p < T.length; p++) {
    let t = 0.5 + (T[p] - 0.5) * P.contrast;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    T[p] = Math.pow(t, P.depth);
  }

  const NB = P.bands;
  const thr = d3.range(1, NB).map((k) => k / NB);
  const conts = d3.contours().size([px, py]).thresholds(thr)(T);
  const ds = conts.map((c) => multiToPath(c, nx, ny, P.smooth));

  // glint thresholds are area fractions too: cream, then pure white on top
  const t1 = P.glint;
  const t2 = P.glint + (1 - P.glint) * 0.55;
  const gl = d3.contours().size([px, py]).thresholds([t1, t2])(G);
  const creamD = P.glintAmt > 0 ? multiToPath(gl[0], nx, ny, P.smooth) : "";
  const whiteD = P.glintAmt > 0 ? multiToPath(gl[1], nx, ny, P.smooth) : "";

  return { ds, creamD, whiteD };
}

function bandColors(NB, palette) {
  const interp = d3.interpolateRgbBasis(PALETTES[palette]);
  return d3.range(NB).map((k) => interp(NB === 1 ? 0 : k / (NB - 1)));
}

// ---- UI --------------------------------------------------------------
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

function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export default function LiquidMacro() {
  const width = useWidth();
  const isNarrow = width < 820;

  const [preset, setPreset] = useState("Whiskey swirl");
  const [seed, setSeed] = useState(11);
  const [palette, setPalette] = useState(PRESETS["Whiskey swirl"].palette);
  const [bands, setBands] = useState(PRESETS["Whiskey swirl"].bands);
  const [warp, setWarp] = useState(PRESETS["Whiskey swirl"].warp);
  const [detail, setDetail] = useState(PRESETS["Whiskey swirl"].detail);
  const [stretch, setStretch] = useState(PRESETS["Whiskey swirl"].stretch);
  const [flow, setFlow] = useState(PRESETS["Whiskey swirl"].flow);
  const [bubbles, setBubbles] = useState(PRESETS["Whiskey swirl"].bubbles);
  const [bubbleSize, setBubbleSize] = useState(PRESETS["Whiskey swirl"].bubbleSize);
  const [glint, setGlint] = useState(PRESETS["Whiskey swirl"].glint);
  const [glintAmt, setGlintAmt] = useState(PRESETS["Whiskey swirl"].glintAmt);
  const [contrast, setContrast] = useState(PRESETS["Whiskey swirl"].contrast);
  const [depth, setDepth] = useState(PRESETS["Whiskey swirl"].depth);
  const [smooth, setSmooth] = useState(2);
  const [quality, setQuality] = useState(() =>
    (typeof window !== "undefined" && window.innerWidth < 820) ? 150 : 190);
  const [svgOut, setSvgOut] = useState(null);
  const [copied, setCopied] = useState(false);

  const applyPreset = (name) => {
    const p = PRESETS[name];
    setPreset(name);
    setPalette(p.palette); setBands(p.bands); setWarp(p.warp); setDetail(p.detail);
    setStretch(p.stretch); setFlow(p.flow); setBubbles(p.bubbles);
    setBubbleSize(p.bubbleSize); setGlint(p.glint); setGlintAmt(p.glintAmt);
    setContrast(p.contrast); setDepth(p.depth);
  };

  const P = useMemo(() => ({
    nx: quality, seed, warp, detail, stretch, flow, bubbles, bubbleSize,
    glint, glintAmt, contrast, depth, bands, smooth,
  }), [quality, seed, warp, detail, stretch, flow, bubbles, bubbleSize,
       glint, glintAmt, contrast, depth, bands, smooth]);

  const geom = useMemo(() => buildLayers(P), [P]);
  const colors = useMemo(() => bandColors(bands, palette), [bands, palette]);
  const cream = PALETTES[palette][PALETTES[palette].length - 1];
  const layers = geom.ds.map((d, k) => ({ d, color: colors[k + 1] }));
  const regionCount = layers.length + 1 + (glintAmt > 0 ? 2 : 0);

  const buildSvg = () => {
    let body = `<rect width="${VB_W}" height="${VB_H}" fill="${colors[0]}"/>`;
    layers.forEach((l) => {
      body += `<path d="${l.d}" fill="${l.color}" fill-rule="evenodd"/>`;
    });
    if (geom.creamD) body += `<path d="${geom.creamD}" fill="${cream}" fill-rule="evenodd"/>`;
    if (geom.whiteD) body += `<path d="${geom.whiteD}" fill="#ffffff" fill-rule="evenodd"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${body}</svg>`;
  };
  const downloadSVG = () => {
    const svg = buildSvg();
    try {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a");
      a.href = url; a.download = "liquid-macro.svg";
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
            fontFamily: "ui-monospace, monospace" }}>TWO FIELDS · WARPED TONE + RIDGED GLINT</div>
          <h1 style={{ fontSize: isNarrow ? 21 : 27, margin: "4px 0 4px", fontWeight: 600,
            fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: -0.2 }}>
            Liquid Macro Studio
          </h1>
          {!isNarrow && (
            <p style={{ fontSize: 13.5, color: "#8a9bab", maxWidth: 620, lineHeight: 1.5, margin: 0 }}>
              Chaotic closeups of liquid, ice and carbonation, painted the way macro
              photorealists do it: flat swirling color regions with white glint shapes
              riding the flow. Every region is a vector contour.
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
                <path key={i} d={l.d} fill={l.color} fillRule="evenodd" />
              ))}
              {geom.creamD && <path d={geom.creamD} fill={cream} fillRule="evenodd" />}
              {geom.whiteD && <path d={geom.whiteD} fill="#ffffff" fillRule="evenodd" />}
            </svg>
            <div style={{ position: "absolute", left: 12, bottom: 10, fontSize: 10.5,
              color: "#6d808f", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5,
              textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
              {regionCount} regions · {P.nx}×{Math.round(P.nx * VB_H / VB_W)} sample grid
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
                ⟳ new pour · #{seed}
              </button>
              <Slider label="Turbulence (domain warp)" value={warp} min={0} max={1.8} step={0.05}
                onChange={setWarp} fmt={(v) => (v < 0.3 ? "calm" : v < 0.8 ? "swirling" : v < 1.3 ? "churning" : "violent")} />
              <Slider label="Detail scale" value={detail} min={1.2} max={6} step={0.1}
                onChange={setDetail} fmt={(v) => v.toFixed(1)} />
              <Slider label="Flow stretch" value={stretch} min={1} max={3} step={0.05}
                onChange={setStretch} fmt={(v) => v.toFixed(2) + "×"} />
              <Slider label="Flow direction" value={flow} min={-90} max={90} step={2}
                onChange={setFlow} fmt={(v) => v + "°"} />
              <Slider label="Contrast" value={contrast} min={0.7} max={1.8} step={0.05}
                onChange={setContrast} fmt={(v) => v.toFixed(2)} />
              <Slider label="Depth (dark bias)" value={depth} min={0.6} max={2.6} step={0.05}
                onChange={setDepth} fmt={(v) => (v < 0.9 ? "airy" : v <= 1.1 ? "even" : v < 1.8 ? "moody" : "abyssal")} />
            </div>

            <div style={panel}>
              <div style={heading}>Carbonation</div>
              <Slider label="Bubbles" value={bubbles} min={0} max={120} step={1} onChange={setBubbles} />
              {bubbles > 0 && (
                <Slider label="Bubble size" value={bubbleSize} min={0.012} max={0.07} step={0.002}
                  onChange={setBubbleSize} fmt={(v) => (v * 1000).toFixed(0)} />
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Glints</div>
              <Slider label="Amount" value={glintAmt} min={0} max={1.5} step={0.05}
                onChange={setGlintAmt} fmt={(v) => (v === 0 ? "off" : v.toFixed(2))} />
              {glintAmt > 0 && (
                <Slider label="Coverage" value={glint} min={0.6} max={0.97} step={0.01}
                  onChange={setGlint} fmt={(v) => Math.round((1 - v) * 100) + "% of frame"} />
              )}
            </div>

            <div style={panel}>
              <div style={heading}>Palette & output</div>
              <Slider label="Color regions" value={bands} min={4} max={16} step={1} onChange={setBands} />
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {Object.keys(PALETTES).map((p) => (
                  <button key={p} onClick={() => setPalette(p)} style={chip(palette === p)}>{p}</button>
                ))}
              </div>
              <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden",
                border: "1px solid #26313c", marginBottom: 10 }}>
                {colors.map((c, i) => (<div key={i} style={{ flex: 1, background: c }} />))}
              </div>
              <Slider label="Edge smoothing" value={smooth} min={0} max={4} step={1}
                onChange={setSmooth} fmt={(v) => (v === 0 ? "off (crisp)" : v + "×")} />
              <Slider label="Sample grid" value={quality} min={120} max={260} step={10} onChange={setQuality} />
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
                    download="liquid-macro.svg" target="_blank" rel="noopener noreferrer"
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
              Exports as {regionCount} stacked vector regions — the same flat-shape
              construction a photorealist painter uses, so it scales cleanly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
