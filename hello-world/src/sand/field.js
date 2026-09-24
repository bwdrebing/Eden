// ------------------------------------------------------------------ //
//  Sand height field
//
//  The sand studio's counterpart to the water's wave field: one scalar,
//  h(x, y) in metres above a flat bed, summed from a short list of FEATURES
//  the way the water sums emitters. Everything the studio draws — the lit
//  regions, the height bands, the pen lines — is a level set of something
//  computed from this one function, so it is the only place the sand's
//  shape is decided.
//
//  Ground units are metres, x east and y north, because the four bedforms
//  live three orders of magnitude apart and a user reasons about them in
//  real sizes: a wind ripple is a hand's width, a current ripple a little
//  more, a backwash rill a stride, a dune a building. Nothing here is a
//  simulation of sand transport; each bedform is a PHASE FIELD (crests are
//  where the phase passes a whole turn) pushed through a profile that has
//  the shape that bedform really has:
//
//    - every one is asymmetric along its driving flow: a long gentle stoss
//      side facing the wind or current, a short steep lee side;
//    - dunes have a sharp brink and suppress the ripples on their slip
//      faces, because sand avalanching down a lee face does not stay
//      rippled;
//    - wind ripples are straight and regular but full of Y-junctions — the
//      "defects" of a real ripple field — which are phase dislocations;
//    - current ripples are sinuous-to-linguoid: crests bent into tongues
//      that alternate from one row to the next;
//    - backwash rills are the opposite orientation: narrow channels running
//      ALONG the flow, braided, cut down into the bed.
//
//  A feature narrower than a few pixels cannot be drawn, only aliased into
//  speckle, so every feature fades out as its wavelength approaches the
//  sample footprint (see `lodFade`). That is what lets one scene hold both a
//  dune on the horizon and the ripples at your feet.
// ------------------------------------------------------------------ //

// Test runners evaluate modules inside a vm context, where every lookup of a
// global like `Math` goes through the context's global proxy — a thirty-fold
// slowdown on code that calls Math a dozen times per sample. One module-level
// binding makes it an ordinary variable everywhere; browsers do not care.
/* global globalThis */
const Math = globalThis.Math;

const TAU = Math.PI * 2;

// ---- noise ---------------------------------------------------------
// 2D gradient noise on a hashed lattice. Integer hashing rather than a
// permutation table so every feature gets its own independent field from
// nothing but a seed, and so the worker-free builders need no module state
// beyond the constant gradient table.
const GRADS = 64;
const GX = new Float64Array(GRADS), GY = new Float64Array(GRADS);
for (let i = 0; i < GRADS; i++) { GX[i] = Math.cos((i * TAU) / GRADS); GY[i] = Math.sin((i * TAU) / GRADS); }

function hash(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// a uniform number in [0, 1) for a lattice cell — used to scatter defects
export function cellRand(ix, iy, seed) { return hash(ix, iy, seed) / 4294967296; }

function grad(ix, iy, seed, fx, fy) {
  const g = hash(ix, iy, seed) & (GRADS - 1);
  return GX[g] * fx + GY[g] * fy;
}

// roughly [-1, 1]
export function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = grad(ix, iy, seed, fx, fy), b = grad(ix + 1, iy, seed, fx - 1, fy);
  const c = grad(ix, iy + 1, seed, fx, fy - 1), d = grad(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
  return 1.4 * (ab + (cd - ab) * uy);
}

// Fractal sum, each octave rotated so the lattice never lines up with
// itself (an unrotated fbm shows its grid as faint axis-aligned streaks,
// which on a ripple field read as a second, wrong wind direction).
const OCT_C = Math.cos(0.83), OCT_S = Math.sin(0.83);
export function fbm(x, y, seed, octaves) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x, y, seed + o * 101);
    norm += amp;
    const nx = OCT_C * x - OCT_S * y, ny = OCT_S * x + OCT_C * y;
    x = nx * 2.03; y = ny * 2.03; amp *= 0.5;
  }
  return sum / norm;
}

function smoothstep(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

// A feature whose wavelength spans fewer than LOD_LO samples cannot be drawn;
// by LOD_HI it is drawn in full. Between, it fades — out rather than into
// speckle.
export const LOD_LO = 3.5, LOD_HI = 9;
export function lodFade(lambda, fp) {
  return fp > 0 ? smoothstep(LOD_LO, LOD_HI, lambda / fp) : 1;
}

// ---- the bedform profile ------------------------------------------
// One wavelength of an asymmetric bedform, x in [0, 1) measured along the
// flow from one trough to the next. The crest sits at `s` (0.5 symmetric,
// toward 1 a long stoss and a short steep lee). `sharp` blends the smooth
// profile toward straight flanks, which puts a real brink on the crest: the
// line where the lit face and the shaded face meet. Returns [-1, 1].
function profile(x, s, sharp) {
  let sm, tr;
  if (x < s) {
    const u = x / s;
    sm = -Math.cos(Math.PI * u);
    tr = 2 * u - 1;
  } else {
    const u = (x - s) / (1 - s);
    sm = Math.cos(Math.PI * u);
    tr = 1 - 2 * u;
  }
  return sm + (tr - sm) * sharp;
}

// ---- features -------------------------------------------------------
export const FEATURE_TYPES = ["dunes", "wind", "current", "rills"];

export const FEATURE_LABELS = {
  dunes: "Dunes", wind: "Wind ripples", current: "Current ripples", rills: "Rills",
};

// Defaults a new card of each kind starts from: real sizes, in metres.
export const FEATURE_DEFAULTS = {
  dunes:   { lambda: 40,   amp: 4,     dir: 70, wander: 0.45, asym: 0.7, breakup: 0.2 },
  wind:    { lambda: 0.12, amp: 0.008, dir: 70, wander: 0.3,  asym: 0.6, defects: 0.4 },
  current: { lambda: 0.18, amp: 0.018, dir: 90, wander: 0.5,  asym: 0.55, tongues: 0.5 },
  rills:   { lambda: 0.5,  amp: 0.02,  dir: 90, wander: 0.5,  stretch: 4, braid: 0.6 },
};

export function newFeature(type, id, seed) {
  return { id, on: true, type, seed: seed == null ? id * 7919 : seed, ...FEATURE_DEFAULTS[type] };
}

// ---- dislocations (wind-ripple Y-junctions) -----------------------
// A ripple crest that forks is a phase dislocation: going once around the
// fork point the phase gains a whole turn, which is exactly one extra crest
// on one side. A lone dislocation's phase never decays, though, so a field of
// them cannot be summed over a neighbourhood without seams. Real ripple
// fields have them in pairs — a crest that forks here ends there — and a
// PAIR's phase decays with distance. So each defect is a dipole: +1 at `a`,
// -1 at `b`. Its phase is the angle a–p–b, which jumps by one whole turn
// across the segment ab and nowhere else; the profile is periodic, so that
// jump is invisible. A window fades the dipole out far from the pair, and is
// flat (exactly 1) over the pair itself, so it never touches the jump.
export const DEFECT_CELL = 8;    // wavelengths per scatter cell
const HALF_MIN = 1, HALF_MAX = 2;   // half the pair's separation, in wavelengths
// The window is flat out to 2.4 half-separations and gone by 1.6 times that.
// A pair's centre sits 0.2–0.8 of the way into its cell, so a pair two cells
// away is always at least 1.2 cells off; the widest window must end inside
// that, or such a pair would still reach this point and the 3×3 block below
// would cut it off: a seam along the cell boundary (sand.test.js checks).
const DEFECT_REACH2 = (1.6 * 2.4 * HALF_MAX) ** 2;
function dislocations(f, u, v) {
  // u, v in wavelengths, along and across the flow
  const cu = Math.floor(u / DEFECT_CELL), cv = Math.floor(v / DEFECT_CELL);
  let phi = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ci = cu + di, cj = cv + dj;
    // up to two dipoles a cell, present with probability `defects`
    for (let k = 0; k < 2; k++) {
      const sd = f.seed + 17 + k * 131;
      if (cellRand(ci, cj, sd) > f.defects) continue;
      const pu = (ci + 0.2 + 0.6 * cellRand(ci, cj, sd + 1)) * DEFECT_CELL;
      const pv = (cj + 0.2 + 0.6 * cellRand(ci, cj, sd + 2)) * DEFECT_CELL;
      // nearly every pair in the 3×3 block is out of reach of this point:
      // settle that on the pair's centre before hashing anything else
      const r2 = (u - pu) * (u - pu) + (v - pv) * (v - pv);
      if (r2 >= DEFECT_REACH2) continue;
      // the pair lies mostly along the crest (across the flow), 2–4 λ apart
      const half = HALF_MIN + (HALF_MAX - HALF_MIN) * cellRand(ci, cj, sd + 3);
      const R2 = half * half * 5.76;          // (2.4 half)²
      const w = 1 - smoothstep(R2, 2.56 * R2, r2);
      if (w <= 0) continue;
      const tilt = (cellRand(ci, cj, sd + 4) - 0.5) * 0.9;
      const sgn = cellRand(ci, cj, sd + 5) < 0.5 ? -1 : 1;
      const du = Math.sin(tilt) * half, dv = Math.cos(tilt) * half;
      const ax = u - (pu - du), ay = v - (pv - dv);
      const bx = u - (pu + du), by = v - (pv + dv);
      // angle a–p–b, in (-π, π]
      const ang = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      phi += sgn * w * ang;
    }
  }
  return phi;
}

// Pre-compute everything a feature's evaluation reuses: its heading as a unit
// vector, its wavenumber, the profile's crest position.
export function prepFeatures(features) {
  const out = [];
  for (const f0 of features || []) {
    if (!f0 || !f0.on || !(f0.amp > 0) || !(f0.lambda > 0)) continue;
    const d = FEATURE_DEFAULTS[f0.type];
    if (!d) continue;
    const f = { ...d, ...f0 };
    const a = (f.dir * Math.PI) / 180;
    // `dir` is where the wind or current is blowing TO, as a compass bearing
    f.dx = Math.sin(a); f.dy = Math.cos(a);
    f.k = TAU / f.lambda;
    f.s = 0.5 + 0.38 * Math.max(0, Math.min(1, f.asym == null ? 0.5 : f.asym));
    f.sharp = f.type === "dunes" ? 0.75 : f.type === "wind" ? 0.35 : 0.2;
    out.push(f);
  }
  // dunes first: the ripples read how steep the dune under them is
  out.sort((p, q) => (p.type === "dunes" ? 0 : 1) - (q.type === "dunes" ? 0 : 1));
  return out;
}

// the largest height the features can reach above the bed (for shadow reach
// and for normalising height bands)
export function heightSpan(prepped) {
  let s = 0;
  for (const f of prepped) s += f.type === "rills" ? f.amp : 2 * f.amp;
  return s;
}

// Footprint of one sample along a feature's own flow direction. A sample on a
// receding ground plane is an ellipse — long toward the horizon, narrow
// across it — and a ripple whose crests run across the view is the one that
// aliases first. `fp` is [along the view, across it, view dir x, view dir y,
// height per sample].
function footprintFor(f, fp) {
  if (!fp) return 0;
  const c = f.dx * fp[2] + f.dy * fp[3], sN = f.dx * fp[3] - f.dy * fp[2];
  const a = fp[0] * c, b = fp[1] * sN;
  return Math.sqrt(a * a + b * b);
}

// How much of a feature survives at this footprint. On a grazing view the
// ground's plan-view texture is squeezed toward the horizon, but relief is
// not: a dune eight metres tall half a kilometre off still stands several
// rows high even though its length along the view is less than one. So a
// feature is kept at whichever of its two sizes — wavelength across the
// ground, or height up the frame — the camera resolves better. (A plan view
// passes no height footprint: from straight above relief has no size.)
function keep(f, fp) {
  if (!fp) return 1;
  const w = lodFade(f.lambda, footprintFor(f, fp));
  if (w >= 1 || !(fp[4] > 0)) return w;
  const r = lodFade(2 * f.amp, fp[4]);
  return r > w ? r : w;
}

// written by a dune's evaluation, read straight back by sandHeight: a scratch
// slot rather than a returned pair, because this runs millions of times a
// frame and a tuple per call is an allocation per call
const SLIP = { lee: 0 };

// one feature's height at (x, y); `lee` is how much of the point sits on a
// dune slip face (0..1), read by the ripples
function featureHeight(f, x, y, fp, lee) {
  const w = keep(f, fp);
  if (w <= 0) return 0;
  // flow-aligned coordinates, in wavelengths
  const u = (x * f.dx + y * f.dy) / f.lambda;
  const v = (x * f.dy - y * f.dx) / f.lambda;
  const seed = f.seed | 0;
  switch (f.type) {
    case "dunes": {
      // crest lines wander at a few dune-lengths' scale
      const warp = f.wander * 0.9 * fbm(u / 1.7, v / 2.4, seed, 3);
      // Breakup cuts the ridges into separate dunes: where the noise `body`
      // is low the relief melts into the interdune flat. It also BOWS each
      // piece — the middle, where it is tallest, pushed upwind of its ends —
      // which bends a ridge fragment toward a barchan's crescent, ends
      // trailing downwind.
      // As breakup grows, the noise has to reach higher to raise a dune, so
      // the pieces shrink from a broken ridge to isolated crescents.
      let body = 1;
      if (f.breakup > 0) {
        const lo = -0.3 + 0.4 * f.breakup;
        const sc = 1.5 - 0.6 * f.breakup;           // pieces round up as they shrink
        body = smoothstep(lo, lo + 0.45, fbm(u / sc + 7.1, v / (sc * 1.25), seed + 999, 2));
      }
      const ph = u + warp + 0.35 * f.breakup * body;
      const x01 = ph - Math.floor(ph);
      let p = profile(x01, f.s, f.sharp);
      // the relief is modulated ABOVE the trough, so the dune melts away
      // instead of being cut off — continuous everywhere, even in a trough
      // (by 0.87 the flats between pieces are dead flat)
      const m = 1 - Math.min(1, 1.15 * f.breakup) * (1 - body);
      if (f.breakup > 0) p = -1 + (p + 1) * m;
      // how far onto a slip face this point is: 1 on the face, 0 on the
      // stoss slope and on the interdune flat, eased at both ends
      SLIP.lee = w * m * smoothstep(f.s, f.s + 0.03, x01) * (1 - smoothstep(0.93, 1, x01));
      return w * f.amp * p;
    }
    case "wind": {
      const warp = f.wander * 0.55 * fbm(u / 5, v / 9, seed, 3);
      let ph = u + warp;
      if (f.defects > 0) ph += dislocations(f, u, v) / TAU;
      const x01 = ph - Math.floor(ph);
      const p = profile(x01, f.s, f.sharp);
      return w * f.amp * (1 - 0.85 * lee) * p;
    }
    case "current": {
      const warp = f.wander * 0.9 * fbm(u / 3, v / 4, seed, 3);
      const ph0 = u + warp;
      // Linguoid ripples: tongues across the flow, staggered by half a
      // tongue from one crest row to the next. Shifting the across-flow
      // phase by half a turn per crest does the staggering continuously —
      // there is no row index to jump — and bending each crest forward
      // where its tongue is fullest gives the tongue its curved front.
      // The bend stays under 1/π per unit of phase, so crests never fold.
      const across = v / 1.5 + 0.35 * fbm(u / 4 + 3.3, v / 3, seed + 55, 2);
      const q = Math.cos(TAU * (across + 0.5 * ph0));
      const t = f.tongues || 0;
      const ph = ph0 + 0.28 * t * q;
      const x01 = ph - Math.floor(ph);
      let p = profile(x01, f.s, f.sharp);
      p = -1 + (p + 1) * (1 - 0.7 * t * (0.5 - 0.5 * q));
      return w * f.amp * (1 - 0.85 * lee) * p;
    }
    case "rills": {
      // channels run ALONG the flow: stretch the noise that way, then fold
      // it so its zero set becomes a sharp-bottomed valley
      const st = Math.max(1, f.stretch || 1);
      const bu = u / st, bv = v;
      const wu = f.braid * 0.8 * fbm(bu * 0.7 + 11, bv * 0.7, seed + 7, 2);
      const wv = f.braid * 0.8 * fbm(bu * 0.7, bv * 0.7 + 5, seed + 13, 2);
      const warpA = f.wander * 0.6 * fbm(bu / 3, bv / 3, seed + 21, 2);
      const n = fbm(bu + wu, bv + wv + warpA, seed, 3);
      const ridge = 1 - Math.min(1, Math.abs(n) * 2.2);
      return -w * f.amp * ridge * ridge * (1 - 0.85 * lee);
    }
    default:
      return 0;
  }
}

// The sand's height at (x, y). `fp` (optional) is the sample footprint —
// [along view, across view, view dir x, view dir y, height per sample] in
// metres — which fades
// features too fine for it; without one everything is drawn.
export function sandHeight(prepped, x, y, fp) {
  let h = 0, lee = 0;
  for (let i = 0; i < prepped.length; i++) {
    const f = prepped[i];
    if (f.type === "dunes") {
      SLIP.lee = 0;
      h += featureHeight(f, x, y, fp, 0);
      if (SLIP.lee > lee) lee = SLIP.lee;
    } else {
      h += featureHeight(f, x, y, fp, lee);
    }
  }
  return h;
}
