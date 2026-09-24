// ------------------------------------------------------------------ //
//  Sandscape renderer
//
//  The sand's height field (field.js), lit by a low sun and cut into flat
//  vector regions — the water studio's idiom, pointed at a different
//  surface. The pipeline is three steps and every one of them is here:
//
//    1. SAMPLE the height on a grid laid out for the camera: the frame's own
//       pixels for a plan view, and for a perspective view a grid of
//       (screen column, depth) — columns fan out from the camera and depths
//       step geometrically toward the horizon, so a node is never much
//       smaller or much larger than the pixel it lands on. Every height is
//       evaluated ONCE; slope, shading and shadows are all read back off the
//       grid, which is what makes a scene of millions of ripple crests cost
//       a fraction of a second.
//    2. LIGHT each node: Lambert against the sun, times a cast-shadow term
//       found by walking toward the sun over the grid. The shadow comes out
//       as a soft margin rather than a yes/no, so its edge lands between
//       nodes instead of on them.
//    3. RASTERIZE to the frame and CONTOUR into bands: plan view is already
//       on the frame; perspective walks each column front to back, keeping
//       the nearest surface (a far dune behind a near one is simply never
//       reached). The bands are level sets of that raster, traced with the
//       same marching squares and the same bezier fit as the water.
//
//  The SVG export IS this geometry — the preview shows the same string.
// ------------------------------------------------------------------ //
import * as d3 from "d3";
import { prepFeatures, sandHeight, heightSpan } from "./field";
import { SAND_PRESETS } from "./presets";
import { sandBandColors, sandPalette } from "./palettes";
import { blurField } from "../backdrop/field";
import { chaikin, simplifyRing, ringToBezier, ringToPolyline } from "../vectorPath";

// a module binding, not the global: see the note at the top of field.js
/* global globalThis */
const Math = globalThis.Math;

export const SAND_FRAMES = {
  landscape: [760, 500], square: [600, 600], portrait: [500, 760],
};
export function sandFrame(S) { return SAND_FRAMES[S.frame] || SAND_FRAMES.landscape; }

// preview raster widths; the export multiplies these
export const SAND_RASTERS = [
  { name: "draft", BW: 300 }, { name: "normal", BW: 460 },
  { name: "fine", BW: 640 }, { name: "max", BW: 860 },
];
export const SAND_RASTER_DEFAULT = 1;
export const SAND_EXPORT_MULTS = [1, 2, 3];
export const SAND_EXPORT_MAX_BW = 2600;

// the margin, in raster pixels, sampled past every side of the frame, so a
// region's edge crosses the frame instead of closing half a pixel inside it
const MARGIN = 2;

// Every setting a scene has, at a new scene's values: the settings a
// starting point does not mention (frame, smoothing, …) come from here, the
// rest from the first starting point.
export const SAND_DEFAULTS = {
  features: [],
  view: "perspective",
  camX: 0, camY: 0,
  planWidth: 120,          // plan: metres across the frame
  camHeight: 6,            // perspective: metres above the sand under it
  heading: 0,              // compass bearing the camera looks along
  horizon: 0.3,            // where the horizon sits, from the top of the frame
  focal: 50,               // mm on a 36 mm-wide frame
  sunAz: 250,              // compass bearing the light comes FROM
  sunEl: 14,               // degrees above the horizon
  shadows: true,
  ambient: 0.22,
  haze: 0.35,
  palette: "Dune Sea",
  bands: 6,
  balance: 0,
  colorBy: "light",
  style: "fill",
  lineWidth: 0.8,
  smooth: 2,
  antialias: 1,
  frame: "landscape",
  bgColor: "",
  ...SAND_PRESETS[0].scene,
};

const smoothstep = (a, b, x) => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};

function sunVector(S) {
  const az = (S.sunAz * Math.PI) / 180, el = (Math.max(0.5, Math.min(89.5, S.sunEl)) * Math.PI) / 180;
  return { lx: Math.cos(el) * Math.sin(az), ly: Math.cos(el) * Math.cos(az), lz: Math.sin(el),
    sx: Math.sin(az), sy: Math.cos(az), tanE: Math.tan(el) };
}

// ---- lighting -----------------------------------------------------
// Light one node. `look(x, y, d)` is the height at a ground point `d` metres
// toward the sun, read off whatever grid the camera sampled (or evaluated,
// where the grid does not reach).
//
// The shadow is a MARGIN: the most any point toward the sun rises above the
// sun's ray from here. Where it is positive the node is in shadow; near zero
// the shadow's edge passes between this node and its neighbour, and the soft
// step puts it there proportionally — which is what lets the traced edge
// fall between samples instead of stepping from one to the next.
function lightNode(h, gx, gy, x, y, fp, sun, S, span, look) {
  const len = Math.sqrt(gx * gx + gy * gy + 1);
  const dot = (-gx * sun.lx - gy * sun.ly + sun.lz) / len;
  let diffuse = dot > 0 ? dot : 0;
  if (diffuse > 0 && S.shadows) {
    const reach = (span - h) / sun.tanE;
    const soft = fp * sun.tanE + 1e-6;
    // Coarse pass: geometric steps out to where nothing can reach the ray.
    let d = 1.5 * fp, margin = -Infinity, n = 0;
    for (let it = 0; it < 60 && d < reach; it++) {
      const q = look(x + sun.sx * d, y + sun.sy * d, d);
      if (!Number.isNaN(q)) {
        const m = q - h - d * sun.tanE;
        MD[n] = d; MM[n] = m; n++;
        if (m > margin) { margin = m; if (margin > soft) break; }
      }
      d *= STEP;
    }
    // A dune's brink is a sharp crest, and a crest between two coarse steps
    // is missed by up to the slope times the gap — which drew every dune's
    // shadow with a sawtooth edge, one tooth per step. So the two most
    // promising PEAKS of the coarse profile (a peak's promise is its margin
    // plus what a crest hidden in the gaps beside it could still add) are
    // resampled: the bracket, then the bracket around the best of those.
    if (margin <= soft && n > 1) {
      let c1 = -1, p1 = -Infinity, c2 = -1, p2 = -Infinity;
      for (let q = 1; q < n; q++) {
        if (!(MM[q] >= MM[q - 1] && (q === n - 1 || MM[q] >= MM[q + 1]))) continue;
        const pot = MM[q] + GAP_SLOPE * MD[q];
        if (pot > p1) { c2 = c1; p2 = p1; c1 = q; p1 = pot; } else if (pot > p2) { c2 = q; p2 = pot; }
      }
      for (const c of [c1, c2]) {
        if (c < 0 || !(MM[c] + GAP_SLOPE * MD[c] > -soft)) continue;
        let lo2 = MD[c] / STEP, hi2 = Math.min(reach, MD[c] * STEP);
        for (let pass = 0; pass < 2 && margin <= soft; pass++) {
          let bb = MD[c], bm = -Infinity;
          for (let q2 = 0; q2 <= 8; q2++) {
            const dd = lo2 + ((hi2 - lo2) * q2) / 8;
            const q = look(x + sun.sx * dd, y + sun.sy * dd, dd);
            if (Number.isNaN(q)) continue;
            const m = q - h - dd * sun.tanE;
            if (m > bm) { bm = m; bb = dd; }
          }
          if (bm > margin) margin = bm;
          const half = (hi2 - lo2) / 8;
          lo2 = bb - half; hi2 = bb + half;
        }
      }
    }
    if (margin > -soft) diffuse *= 1 - smoothstep(-soft, soft, margin);
  }
  return S.ambient + (1 - S.ambient) * diffuse;
}

// the shadow march's scratch: one coarse profile at a time, reused
const STEP = 1.3, GAP_SLOPE = (STEP - 1) * 0.5;
const MD = new Float64Array(64), MM = new Float64Array(64);

// bilinear read of a node grid; NaN outside it
function bilinear(arr, W, H, fi, fj) {
  if (!(fi >= 0 && fj >= 0 && fi <= W - 1 && fj <= H - 1)) return NaN;
  const i0 = Math.min(W - 2, Math.floor(fi)), j0 = Math.min(H - 2, Math.floor(fj));
  const tx = fi - i0, ty = fj - j0, p = j0 * W + i0;
  const a = arr[p], b = arr[p + 1], c = arr[p + W], e = arr[p + W + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
}

// ---- plan view ----------------------------------------------------
function samplePlan(S, P, BW, BH, span, sun) {
  const M = MARGIN, RW = BW + 2 * M, RH = BH + 2 * M, N = RW * RH;
  const pix = S.planWidth / BW;
  const x0 = S.camX - (BW / 2 + M - 0.5) * pix, y0 = S.camY + (BH / 2 + M - 0.5) * pix;
  const fp = [pix, pix, 0, 1];
  const hgt = new Float32Array(N);
  for (let j = 0; j < RH; j++) {
    const y = y0 - j * pix;
    for (let i = 0; i < RW; i++) hgt[j * RW + i] = sandHeight(P, x0 + i * pix, y, fp);
  }

  // Casters beyond the frame: at a low sun a dune well outside the picture
  // throws its shadow into it. A coarse grid over the frame swept back
  // toward the sun holds them, at a spacing where only dune-sized relief is
  // left to cast anything.
  let coarse = null;
  if (S.shadows) {
    const reach = Math.min((2 * span) / sun.tanE, 3 * S.planWidth);
    const cell = 4 * pix;
    const xa = Math.min(x0, x0 + sun.sx * reach), xb = Math.max(x0 + (RW - 1) * pix, x0 + (RW - 1) * pix + sun.sx * reach);
    const yb = Math.max(y0, y0 + sun.sy * reach), ya = Math.min(y0 - (RH - 1) * pix, y0 - (RH - 1) * pix + sun.sy * reach);
    const CW = Math.max(2, Math.ceil((xb - xa) / cell) + 1), CH = Math.max(2, Math.ceil((yb - ya) / cell) + 1);
    if (CW * CH < 4e5) {
      const ch = new Float32Array(CW * CH), cfp = [cell, cell, 0, 1];
      for (let j = 0; j < CH; j++) for (let i = 0; i < CW; i++)
        ch[j * CW + i] = sandHeight(P, xa + i * cell, yb - j * cell, cfp);
      coarse = { ch, CW, CH, xa, yb, cell };
    }
  }
  const near = 10 * pix;
  const look = (x, y, d) => {
    if (d < near) {
      const v = bilinear(hgt, RW, RH, (x - x0) / pix, (y0 - y) / pix);
      if (!Number.isNaN(v)) return v;
    }
    if (!coarse) return NaN;
    return bilinear(coarse.ch, coarse.CW, coarse.CH, (x - coarse.xa) / coarse.cell, (coarse.yb - y) / coarse.cell);
  };

  const val = new Float32Array(N);
  const light = S.colorBy !== "height";
  for (let j = 0; j < RH; j++) {
    const ju = j > 0 ? j - 1 : j, jd = j < RH - 1 ? j + 1 : j;
    for (let i = 0; i < RW; i++) {
      const p = j * RW + i;
      if (!light) { val[p] = hgt[p]; continue; }
      const il = i > 0 ? i - 1 : i, ir = i < RW - 1 ? i + 1 : i;
      const gx = (hgt[j * RW + ir] - hgt[j * RW + il]) / ((ir - il) * pix);
      const gy = (hgt[ju * RW + i] - hgt[jd * RW + i]) / ((jd - ju) * pix);
      val[p] = lightNode(hgt[p], gx, gy, x0 + i * pix, y0 - j * pix, pix, sun, S, span, look);
    }
  }
  return { RW, RH, M, val, cov: null, sil: null, nodes: N };
}

// Heights for shadow rays that leave the camera's own grid, on lattices
// filled in only where rays actually go. One lattice per power-of-two
// spacing, each evaluated at a footprint of its own spacing, so a lookup at
// footprint `fp` reads the lattice just finer than it. With the sun behind
// the camera nearly every ray from the foreground leaves the view, and
// neighbouring rays cross the same few cells — evaluated once, not once per
// ray.
function casterCache(P) {
  // tiles of TILE×TILE cells, each holding its (TILE+1)² corner heights so
  // a bilinear read never leaves its tile: one map lookup per read
  const TILE = 32, TW = TILE + 1, OFF = 1 << 20, SPAN = 1 << 21;
  const tiles = new Map(), fp = [0, 0, 0, 1];
  let lastKey = -1, last = null;
  return (x, y, want) => {
    const L = Math.max(-10, Math.ceil(Math.log2(want)));
    const cell = Math.pow(2, L);
    const gx = x / cell, gy = y / cell;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const tx = Math.floor(ix / TILE), ty = Math.floor(iy / TILE);
    if (!(Math.abs(tx) < OFF - 1 && Math.abs(ty) < OFF - 1)) {
      fp[0] = fp[1] = cell;
      return sandHeight(P, x, y, fp);
    }
    const key = ((L + 64) * SPAN + (tx + OFF)) * SPAN + (ty + OFF);
    let tile = key === lastKey ? last : tiles.get(key);
    if (!tile) { tile = new Float32Array(TW * TW).fill(NaN); tiles.set(key, tile); }
    lastKey = key; last = tile;
    const i0 = ix - tx * TILE, j0 = iy - ty * TILE, q = j0 * TW + i0;
    let a = tile[q], b = tile[q + 1], c = tile[q + TW], e = tile[q + TW + 1];
    if (a !== a || b !== b || c !== c || e !== e) { // eslint-disable-line no-self-compare
      fp[0] = fp[1] = cell;
      const X0 = ix * cell, Y0 = iy * cell;
      if (a !== a) a = tile[q] = sandHeight(P, X0, Y0, fp); // eslint-disable-line no-self-compare
      if (b !== b) b = tile[q + 1] = sandHeight(P, X0 + cell, Y0, fp); // eslint-disable-line no-self-compare
      if (c !== c) c = tile[q + TW] = sandHeight(P, X0, Y0 + cell, fp); // eslint-disable-line no-self-compare
      if (e !== e) e = tile[q + TW + 1] = sandHeight(P, X0 + cell, Y0 + cell, fp); // eslint-disable-line no-self-compare
    }
    const fx = gx - ix, fy = gy - iy;
    return (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
  };
}

// ---- perspective view ---------------------------------------------
// A level camera with a shifted lens: the horizon can sit anywhere in the
// frame while verticals stay vertical. That is also what makes each screen
// column one vertical slice of the world, so visibility is a single front-
// to-back walk per column.
export function perspCamera(S, P, BW, BH, span) {
  const M = MARGIN, RW = BW + 2 * M, RH = BH + 2 * M;
  const tanHalf = 18 / S.focal, Sc = BW / 2 / tanHalf;
  const hr = M + S.horizon * BH;
  const yaw = (S.heading * Math.PI) / 180;
  const fx = Math.sin(yaw), fy = Math.cos(yaw), rx = Math.cos(yaw), ry = -Math.sin(yaw);
  // stand on the sand: the camera's height is above the dunes under it
  const ground = sandHeight(P, S.camX, S.camY, [S.camHeight, S.camHeight, fx, fy]);
  const Hc = ground + S.camHeight;
  const Hs = Math.max(S.camHeight * 0.25, Hc + span);   // above the lowest possible sand
  const Hm = Math.max(S.camHeight * 0.3, Hc);           // above the mean bed
  // Past this depth even the lowest sand is within half a row of the
  // horizon. Haze shortens it: once the air is ~99% of what reaches the eye
  // nothing more of the sand can be told apart, and the march stops there —
  // the rows left between it and the horizon are filled with the same air.
  // On a long lens that is most of the work saved.
  const hazeD = S.colorBy !== "height" && S.haze > 0
    ? Hm * Sc * 0.25 * Math.pow(1.02 - S.haze, 2.2) : Infinity;
  const tMax = Math.min(2 * Hs * Sc, 4.5 * hazeD);
  const us = new Float64Array(RW);
  for (let i = 0; i < RW; i++) us[i] = (i + 0.5 - M - BW / 2) / Sc;
  return { M, RW, RH, Sc, hr, fx, fy, rx, ry, Hc, Hm, tMax, hazeD, us, t0: 0.05 * S.camHeight };
}

// The depth steps are chosen as the march goes: each one is sized so the
// visible surface moves about half a row on screen, measured on the row of
// nodes just computed, in whichever column moves most. Sand still below the
// frame, or hidden behind a nearer crest, needs no such care and the step
// grows; a dune face turned toward the camera, which sweeps many rows in a
// short depth, pulls it back in. A fixed schedule has to assume the worst
// everywhere — this one pays for rows only where there are rows to fill.
const STEP_ROWS = 0.6, STEP_MAX_FRAC = 0.02, STEP_CAP = 6000;

function samplePersp(S, P, BW, BH, span, sun) {
  const cam = perspCamera(S, P, BW, BH, span);
  const { M, RW, RH, Sc, hr, fx, fy, rx, ry, Hc, Hm, tMax, hazeD, us } = cam;
  let cap = 1024 * RW;
  let hgt = new Float32Array(cap);
  const tList = [];
  const fp = [0, 0, 0, 0, 0];
  let t = cam.t0, dt = cam.t0 * 0.05, k = 0;
  let prevRow = null;
  const rowNow = new Float64Array(RW);
  const rTop = new Float64Array(RW).fill(Infinity);
  while (t < tMax && k < STEP_CAP) {
    if ((k + 1) * RW > cap) { const nh = new Float32Array(cap * 2); nh.set(hgt); hgt = nh; cap *= 2; }
    const base = k * RW;
    let moved = 0, seen = false;
    // a step that swept the surface several rows at once is taken again,
    // shorter: the first rows a dune face pushes into the frame are exactly
    // where a coarse step would show, as a sawtooth along every edge
    for (let tries = 0; tries < 6; tries++) {
      const along = Math.max(dt, (t * t) / (Hm * Sc)), across = t / Sc;
      moved = 0; seen = false;
      for (let i = 0; i < RW; i++) {
        const u = us[i], dx = fx + u * rx, dy = fy + u * ry, dl = Math.sqrt(dx * dx + dy * dy);
        fp[0] = along * dl; fp[1] = across * dl; fp[2] = dx / dl; fp[3] = dy / dl; fp[4] = across;
        const h = sandHeight(P, S.camX + t * dx, S.camY + t * dy, fp);
        hgt[base + i] = h;
        const r = hr - ((h - Hc) / t) * Sc;
        rowNow[i] = r;
        // only surface that can be SEEN sets the pace: rising past the
        // highest row this column has reached so far. A lee face sinking
        // behind its own crest sweeps just as many rows, all of them hidden.
        if (prevRow) {
          const pr = prevRow[i], top = rTop[i] + 0.5;
          if ((r < top || pr < top) && (r < RH || pr < RH)) {
            seen = true;
            const m = Math.abs(r - pr);
            if (m > moved) moved = m;
          }
        }
      }
      if (!prevRow || !seen || moved <= 3 * STEP_ROWS || dt < 1e-4) break;
      const back = Math.max(0.1, (STEP_ROWS / moved) * 0.9);
      t -= dt; dt *= back; t += dt;
    }
    tList.push(t);
    if (!prevRow) prevRow = new Float64Array(RW);
    prevRow.set(rowNow);
    for (let i = 0; i < RW; i++) if (rowNow[i] < rTop[i]) rTop[i] = rowNow[i];
    k++;
    // size the next step from how far this one moved the surface on screen
    let grow = seen ? (moved > 1e-9 ? STEP_ROWS / moved : 2) : 2;
    grow = grow < 0.5 ? 0.5 : grow > 1.6 ? 1.6 : grow;
    dt = Math.min(dt * grow, STEP_MAX_FRAC * t);
    if (!seen) dt = Math.min(dt * 1.6, 0.1 * t);
    t += Math.max(dt, 1e-5);
  }
  const K = k, ts = Float64Array.from(tList);
  const NN = K * RW;

  // Read a ground point back off the (column, depth) grid. The shadow march
  // does this tens of millions of times a frame, so finding the depth step
  // is a table lookup on log depth plus a short walk, not a search.
  const lnT0 = Math.log(ts[0]), NBIN = 4096;
  const binK = (NBIN - 1) / Math.max(1e-9, Math.log(ts[K - 1]) - lnT0);
  const kAt = new Int32Array(NBIN);
  for (let b = 0, kk = 0; b < NBIN; b++) {
    const tb = Math.exp(lnT0 + b / binK);
    while (kk < K - 2 && ts[kk + 1] <= tb) kk++;
    kAt[b] = kk;
  }
  const lookGrid = (x, y) => {
    const dx = x - S.camX, dy = y - S.camY;
    const tt = dx * fx + dy * fy;
    if (!(tt >= ts[0] && tt <= ts[K - 1])) return NaN;
    const fi = ((dx * rx + dy * ry) / tt) * Sc + BW / 2 + M - 0.5;
    if (!(fi >= 0 && fi <= RW - 1)) return NaN;
    let lo = kAt[Math.floor((Math.log(tt) - lnT0) * binK)];
    while (lo < K - 2 && ts[lo + 1] <= tt) lo++;
    const fj = lo + (tt - ts[lo]) / (ts[lo + 1] - ts[lo] || 1);
    return bilinear(hgt, RW, K, fi, fj);
  };
  const offGrid = casterCache(P);
  const look = (x, y, d) => {
    const v = lookGrid(x, y);
    if (!Number.isNaN(v)) return v;
    // Off the grid (behind the camera, outside the view). The footprint
    // grows with the distance marched so the fine relief drops out, but
    // slowly — a dune casting across the edge of the view must be the same
    // dune on both sides of it, or its shadow tears there.
    return offGrid(x, y, d * 0.04);
  };

  const light = S.colorBy !== "height";
  const nodeVal = new Float32Array(NN);
  const hazeOn = hazeD < Infinity;
  const hazeTo = S.ambient + (1 - S.ambient) * 0.9;
  for (let kk = 0; kk < K; kk++) {
    const tk = ts[kk];
    const kp = kk > 0 ? kk - 1 : kk, kn = kk < K - 1 ? kk + 1 : kk;
    const dtk = ts[kn] - ts[kp] || 1;
    const fpk = Math.max(dtk * 0.5, tk / Sc);
    const fog = hazeOn ? 1 - Math.exp(-tk / hazeD) : 0;
    for (let i = 0; i < RW; i++) {
      const p = kk * RW + i;
      if (!light) { nodeVal[p] = hgt[p]; continue; }
      const il = i > 0 ? i - 1 : i, ir = i < RW - 1 ? i + 1 : i;
      const u = us[i];
      const hu = (hgt[kk * RW + ir] - hgt[kk * RW + il]) / (us[ir] - us[il]);
      const htt = (hgt[kn * RW + i] - hgt[kp * RW + i]) / dtk;
      const gR = hu / tk, gF = htt - u * gR;
      const gx = gF * fx + gR * rx, gy = gF * fy + gR * ry;
      const x = S.camX + tk * (fx + u * rx), y = S.camY + tk * (fy + u * ry);
      const L = lightNode(hgt[p], gx, gy, x, y, fpk, sun, S, span, look);
      nodeVal[p] = L + (hazeTo - L) * fog;
    }
  }

  // Visibility, one column at a time, front to back. A row is reached the
  // first time the surface rises past it on screen; everything the surface
  // passes behind is simply never assigned. Each row interpolates between
  // the two depth nodes it fell between, so the picture is continuous along
  // a column even where a node spans several rows.
  const N = RW * RH;
  const val = new Float32Array(N), cov = new Uint8Array(N), sil = new Float32Array(N);
  for (let i = 0; i < RW; i++) {
    let j = RH - 1;
    let prevR = hr - ((hgt[i] - Hc) / ts[0]) * Sc, rMin = prevR;
    while (j >= 0 && j + 0.5 >= prevR) { val[j * RW + i] = nodeVal[i]; cov[j * RW + i] = 1; j--; }
    for (let kk = 1; kk < K && j >= 0; kk++) {
      const p = kk * RW + i;
      const r = hr - ((hgt[p] - Hc) / ts[kk]) * Sc;
      if (r < rMin) rMin = r;
      while (j >= 0 && j + 0.5 >= r) {
        let f = prevR > r ? (prevR - (j + 0.5)) / (prevR - r) : 1;
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        const a = nodeVal[p - RW];
        val[j * RW + i] = a + (nodeVal[p] - a) * f;
        cov[j * RW + i] = 1;
        j--;
      }
      prevR = r;
    }
    // beyond the last step the sand runs on, flat and as far off as the
    // last step was, to the horizon
    const last = nodeVal[(K - 1) * RW + i];
    while (j >= 0 && j + 0.5 >= hr) { val[j * RW + i] = last; cov[j * RW + i] = 1; j--; }
    if (hr < rMin) rMin = hr;
    // the skyline, as a signed distance in rows: positive on the sand
    for (let jj = 0; jj < RH; jj++) sil[jj * RW + i] = jj + 0.5 - rMin;
    // sky pixels carry the nearest sand value, so a blur never drags the
    // skyline's colors toward zero
    const top = j + 1;
    if (top < RH) for (let jj = 0; jj < top; jj++) val[jj * RW + i] = val[top * RW + i];
  }
  return { RW, RH, M, val, cov, sil, nodes: NN };
}

// ---- raster -> bands ----------------------------------------------
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const x = q * (sorted.length - 1), i = Math.floor(x), f = x - i;
  return sorted[i] + ((sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * f);
}

function ringArea(r) {
  let a = 0;
  for (let q = 0, n = r.length, j = n - 1; q < n; j = q++) a += (r[j][0] + r[q][0]) * (r[j][1] - r[q][1]);
  return Math.abs(a) / 2;
}

// A traced multipolygon as smooth path data in view-box units. Rings
// smaller than `minArea` raster px² are dropped — an island that small is a
// speck of noise, not a feature, and a hole that small is better filled —
// and an island takes its holes with it.
function toPath(multi, M, k, iters, minArea) {
  let d = "";
  for (const poly of multi.coordinates) {
    for (let r = 0; r < poly.length; r++) {
      const ring0 = poly[r];
      if (minArea && ringArea(ring0) < minArea) { if (r === 0) break; continue; }
      const n = ring0.length;
      let ring = new Float64Array(n * 2);
      for (let q = 0; q < n; q++) {
        ring[2 * q] = (ring0[q][0] - M) * k; ring[2 * q + 1] = (ring0[q][1] - M) * k;
      }
      if (iters) ring = chaikin(ring, iters);
      const simp = simplifyRing(ring, 0.45);
      d += simp.length >= 6 ? ringToBezier(simp) : ringToPolyline(ring);
    }
  }
  return d;
}

// Steps 1 and 2 on their own: the lit (or height) raster the bands are cut
// from, with the frame's margin. `cov`/`sil` are null for a plan view.
export function sampleSand(S0, BW) {
  const S = { ...SAND_DEFAULTS, ...S0 };
  const [VW, VH] = sandFrame(S);
  const BH = Math.max(8, Math.round((BW * VH) / VW));
  const P = prepFeatures(S.features);
  const span = Math.max(1e-4, heightSpan(P));
  const sun = sunVector(S);
  const R = S.view === "plan" ? samplePlan(S, P, BW, BH, span, sun) : samplePersp(S, P, BW, BH, span, sun);
  return { ...R, S, VW, VH, BW, BH };
}

// Everything the studio draws, from the settings alone. `BW` is the raster
// width the frame is sampled at — the preview's, or a wider one for export.
export function buildSand(S0, BW) {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const R = sampleSand(S0, BW);
  const { S, VW, VH, BH, RW, RH, M, val, cov, sil } = R, N = RW * RH;

  // Band edges. Spread evenly over the range this frame shows (trimmed a
  // little, so a few extreme pixels do not waste a band), then pulled part
  // way toward equal AREA: in raking light most of the frame is either in
  // shadow or on a lit face, and even steps alone spend bands on tones almost
  // nothing has. Only part way, because all the way puts band edges inside
  // the few percent of variation across a flat lit face and draws its noise
  // as blotches. `balance` bends both toward the dark or light end.
  const sample = [];
  const stride = Math.max(1, Math.floor(N / 40000));
  for (let p = 0; p < N; p += stride) if (!cov || cov[p]) sample.push(val[p]);
  sample.sort((a, b) => a - b);
  const lo = quantile(sample, 0.01), hi = quantile(sample, 0.99);
  const NB = Math.max(2, Math.min(16, S.bands | 0));
  const gamma = Math.pow(2, -(S.balance || 0));
  const minGap = (hi - lo || 1) / (NB * 4);
  const thresholds = [];
  for (let kk = 1; kk < NB; kk++) {
    const f = Math.pow(kk / NB, gamma);
    let tau = 0.7 * (lo + (hi - lo) * f) + 0.3 * quantile(sample, f);
    if (thresholds.length && tau < thresholds[thresholds.length - 1] + minGap)
      tau = thresholds[thresholds.length - 1] + minGap;
    thresholds.push(tau);
  }
  const colors = sandBandColors(S.palette, NB);
  const pal = sandPalette(S.palette);

  // Each band is cut from its own field: the value's distance past the
  // threshold, CLAMPED to one band-gap either side. Along a smooth slope
  // that is just the value, so the edge lands between pixels where it
  // should. Across a hard edge — a shadow line, where the light drops the
  // whole range in one pixel — every band's field saturates on both sides,
  // so every band's edge lands in the same place. Unclamped, each threshold
  // would cross at its own fraction of that pixel and leave a sliver of
  // every intermediate tone along every shadow. Antialiasing then blurs the
  // clamped field, which rounds the edge without fattening anything.
  const k = VW / BW, iters = Math.max(0, S.smooth | 0);
  const aa = Math.max(0, S.antialias | 0);
  const buf = new Float64Array(N), tmp = aa ? new Float64Array(N) : null;
  const w = minGap * 2;
  const minArea = 5 / (k * k);                 // raster px² worth 5 view-box units²
  const cut = (tau) => {
    for (let p = 0; p < N; p++) {
      const v = (val[p] - tau) / w;
      buf[p] = v < -1 ? -1 : v > 1 ? 1 : v;
    }
    if (aa) blurField(buf, RW, RH, tmp, aa);
    if (sil) for (let p = 0; p < N; p++) { const e = sil[p]; if (e < buf[p]) buf[p] = e; }
    return toPath(d3.contours().size([RW, RH]).thresholds([0])(buf)[0], M, k, iters, minArea);
  };
  let ground = null;
  if (sil) {
    for (let p = 0; p < N; p++) buf[p] = sil[p];
    ground = toPath(d3.contours().size([RW, RH]).thresholds([0])(buf)[0], M, k, iters, 0);
  }
  const bounds = thresholds.map(cut);

  const layers = [{ d: ground, color: colors[0] }]
    .concat(bounds.map((d, i) => ({ d, color: colors[i + 1] })));
  const t1 = typeof performance !== "undefined" ? performance.now() : 0;
  return {
    VW, VH, BW, BH, sky: pal.sky, ink: pal.ramp[0], paper: pal.ramp[pal.ramp.length - 1],
    view: S.view, layers, bounds, ground,
    stats: { nodes: R.nodes, bands: NB, ms: t1 - t0 },
  };
}

// The picture as an SVG document. The preview shows exactly this string, so
// the file and the screen cannot disagree.
export function sandSvg(S0, out) {
  const S = { ...SAND_DEFAULTS, ...S0 };
  const { VW, VH } = out;
  const lines = S.style === "lines", both = S.style === "both";
  const bg = S.bgColor || (lines ? out.paper : out.view === "plan" ? out.layers[0].color : out.sky);
  const ink = lines ? out.ink : "#000";
  let body = `<rect width="${VW}" height="${VH}" fill="${bg}"/>`;
  const frameRect = `M0 0H${VW}V${VH}H0Z`;
  if (!lines) {
    for (const l of out.layers) {
      const d = l.d == null ? frameRect : l.d;
      if (d) body += `<path d="${d}" fill="${l.color}" fill-rule="evenodd"/>`;
    }
  }
  if (lines || both) {
    const w = S.lineWidth, op = both ? ` stroke-opacity="0.35"` : "";
    let clip = "", grp = "";
    if (out.ground) {
      clip = `<defs><clipPath id="sand"><path d="${out.ground}"/></clipPath></defs>`;
      grp = ` clip-path="url(#sand)"`;
    }
    body += clip + `<g fill="none" stroke="${ink}" stroke-width="${w}"${op} stroke-linejoin="round"${grp}>`;
    for (const d of out.bounds) if (d) body += `<path d="${d}"/>`;
    body += `</g>`;
    if (out.ground) {
      body += `<path d="${out.ground}" fill="none" stroke="${ink}" stroke-width="${w}"${op}/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}">${body}</svg>`;
}

// the one call the studio makes: settings in, the finished picture out
export function renderSand(S, BW) {
  const out = buildSand(S, BW);
  return { svg: sandSvg(S, out), stats: out.stats, VW: out.VW, VH: out.VH, BW };
}
