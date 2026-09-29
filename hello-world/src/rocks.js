// ------------------------------------------------------------------ //
//  Rocks standing in the water
//
//  A rock is the one thing in this renderer that is neither water nor
//  backdrop: a solid at a finite distance, out on the plane, that the camera
//  sees directly, the water reflects, and the waves bend around. All three of
//  those come out of ONE description of its shape, so they cannot disagree —
//  the black silhouette, the black shape in the water under it, and the rings
//  lapping out from its waterline are the same rock.
//
//  That description is a signed distance: negative inside, positive outside,
//  never more than the true distance to the surface. It is what lets every use
//  below be a field rather than a polygon, and a field is the only thing the
//  rest of the renderer knows how to cut: the silhouette and the reflection are
//  contoured by the same marching squares as a color band, snapped at the same
//  crest seams, polished by the same blur.
//
//  The shape. Shore ledge is granite that has split along its joints, so a rock
//  is built the way it breaks: a few convex chunks, each the intersection of a
//  ring of planes cut around an ellipsoid (a plane's offset is the ellipsoid's
//  own support in its direction, pulled in by a random amount — that is a
//  facet). Smooth ↔ jagged is one number that moves every part of that together:
//
//    smooth: one chunk, many planes, edges rounded off by a log-sum-exp max
//            whose radius is a good fraction of the rock — a glacial boulder
//    jagged: up to four chunks tilted against each other, few planes, deep
//            random cuts and knife edges — a fractured ledge
//
//  Everything here is plain arithmetic on plain data, because it runs in the
//  render worker as well as the studio: `prepRock` turns a rock's settings into
//  the planes, and the settings are what travel.
// ------------------------------------------------------------------ //

export const ROCK_COLOR = "#000000";

// The largest rock count the studio offers, and what a new one starts as.
export const MAX_ROCKS = 6;
export function newRock(id, halfW, yNear, yFar) {
  // dropped a third of the way out, off center so a second one does not land
  // on the first: close enough to read as a rock, far enough to reflect
  const span = Math.max(4, yFar - yNear);
  const side = [0, -0.35, 0.3, -0.15, 0.45, 0.1][(id - 1) % 6];
  return { id, on: true, x: Math.round(side * halfW * 2) / 2,
    y: Math.round((yNear + span * (0.18 + 0.05 * ((id - 1) % 3))) * 2) / 2,
    size: 2, height: 0.7, turn: 15 * ((id * 7) % 5) - 30, stretch: 1.6,
    shape: 0.7, seed: id };
}

// mulberry32: a small, well-mixed generator — the shape has to be the same on
// every thread and every reload, so no Math.random anywhere near it
function rng(seed) {
  let a = (Math.imul((seed | 0) + 0x9e3779b9, 0x85ebca6b) ^ 0x2c1b3c6d) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Settings -> planes. `size` is the half-width of the footprint in ground
// units, `height` the tallest chunk's height as a multiple of that, `stretch`
// how much longer than wide it is, `turn` its heading on the plane in degrees,
// `shape` 0 (smooth) … 1 (jagged), `seed` which rock of that description.
// Prepared rocks are cached on their settings: the same rock is asked for by
// the ripples in every sample of every pass and by each surface pass, and its
// shape only changes when a slider does.
const PREP_CACHE = new Map();
export function prepRock(rk) {
  const key = [rk.x, rk.y, rk.size, rk.height, rk.turn, rk.stretch, rk.shape, rk.seed].join(",");
  let pr = PREP_CACHE.get(key);
  if (!pr) {
    if (PREP_CACHE.size > 64) PREP_CACHE.clear();
    pr = buildRock(rk);
    PREP_CACHE.set(key, pr);
  }
  return pr;
}

function buildRock(rk) {
  const size = Math.max(0.1, rk.size || 1);
  const jag = clamp(rk.shape == null ? 0.5 : rk.shape, 0, 1);
  const stretch = clamp(rk.stretch || 1, 1, 5);
  const A = size * Math.sqrt(stretch), B = size / Math.sqrt(stretch);
  const Hh = Math.max(0.05, (rk.height == null ? 0.7 : rk.height) * size);
  const turn = ((rk.turn || 0) * Math.PI) / 180;
  const ct = Math.cos(turn), st = Math.sin(turn);
  const rand = rng(rk.seed == null ? 1 : rk.seed);

  // more of a rock breaks into pieces the more jagged it is; the first chunk
  // is always the main mass and carries the full height
  const C = jag < 0.12 ? 1 : 1 + Math.min(3, Math.floor(jag * 3.2 + rand() * 0.9));
  const P = Math.round(26 - 16 * jag);          // planes around each chunk
  const cut = 0.03 + 0.3 * jag;                 // how deep a facet may bite
  const chunks = [];
  for (let j = 0; j < C; j++) {
    const lead = j === 0;
    const one = C === 1;
    // placed along the rock's own length, so a ledge stays a ledge
    const cu = one ? 0 : lead ? (rand() - 0.5) * 0.3 * A : (rand() - 0.5) * 1.3 * A;
    const cv = one ? 0 : lead ? 0 : (rand() - 0.5) * 0.7 * B;
    const au = one ? A : A * (lead ? 0.8 : 0.35 + 0.35 * rand());
    const bv = one ? B : B * (lead ? 0.85 : 0.45 + 0.35 * rand());
    const hz = Hh * (lead ? 1 : 0.3 + 0.55 * rand());
    // each piece is split off along its own joints: a yaw against the rock's
    // heading and a tilt out of level, both growing with the jaggedness
    const yaw = turn + (one ? 0 : (rand() - 0.5) * 1.1 * jag);
    const tx = (rand() - 0.5) * 0.7 * jag, ty = (rand() - 0.5) * 0.7 * jag;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cx1 = Math.cos(tx), sx1 = Math.sin(tx), cy1 = Math.cos(ty), sy1 = Math.sin(ty);
    // world center, on the waterline
    const wx = rk.x + cu * ct - cv * st, wy = rk.y + cu * st + cv * ct;
    // everything under the water continues down to here, so a trough in front
    // of the rock shows more rock rather than the underside of a floating one
    const sink = Math.max(hz, size) * 1.2;
    const NX = new Float64Array(P + 1), NY = new Float64Array(P + 1);
    const NZ = new Float64Array(P + 1), D = new Float64Array(P + 1);
    for (let i = 0; i < P; i++) {
      // a Fibonacci spiral over the upper cap and the sides, jittered: even
      // enough that the smooth end rounds to an ellipsoid, loose enough that
      // the jagged end reads as broken rather than cut on a lathe
      const f = (i + 0.5) / P;
      let mz = 1 - f * 1.3;                     // down to ~-0.3: the flanks
      const ga = i * 2.39996323 + rand() * jag * 1.2;
      mz = clamp(mz + (rand() - 0.5) * 0.35 * jag, -0.45, 1);
      const rr = Math.sqrt(Math.max(0, 1 - mz * mz));
      let mx = rr * Math.cos(ga), my = rr * Math.sin(ga);
      // support of the ellipsoid (au, bv, hz) in that direction, then the bite
      const s = Math.sqrt((au * mx) ** 2 + (bv * my) ** 2 + (hz * mz) ** 2)
        * (1 - cut * rand() * (i === 0 ? 0.3 : 1));
      // tilt (x then y), then yaw — a normal turns like a direction
      let y1 = my * cx1 - mz * sx1, z1 = my * sx1 + mz * cx1;
      let x2 = mx * cy1 + z1 * sy1, z2 = -mx * sy1 + z1 * cy1;
      mx = x2 * cy - y1 * sy; my = x2 * sy + y1 * cy; mz = z2;
      NX[i] = mx; NY[i] = my; NZ[i] = mz;
      D[i] = s + mx * wx + my * wy;
    }
    // the floor: z >= -sink
    NX[P] = 0; NY[P] = 0; NZ[P] = -1; D[P] = sink;
    const r = Math.min(au, bv, hz) * (0.35 * (1 - jag) * (1 - jag) + 0.012);
    chunks.push({ P: P + 1, NX, NY, NZ, D, r, cx: wx, cy: wy, cz: (hz - sink) / 2,
      br: Math.hypot(au, bv, Math.max(hz, sink)) * 1.02 });
  }
  // the pieces of a smooth rock melt into each other; a jagged one's meet in
  // a crease
  const k = C > 1 ? size * 0.5 * (1 - jag) * (1 - jag) : 0;
  // One box around all of it, for the ray tests and the screen box: the true
  // extent of each chunk's polytope, found from its corners, and let out by
  // the most its rounding can push a face.
  const box = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (const ch of chunks) {
    const e = chunkExtent(ch);
    const m = ch.r * ROUND_LET + 0.01 * size;
    for (let a = 0; a < 3; a++) {
      box[2 * a] = Math.min(box[2 * a], e[2 * a] - m);
      box[2 * a + 1] = Math.max(box[2 * a + 1], e[2 * a + 1] + m);
    }
  }
  const bx = (box[0] + box[1]) / 2, by = (box[2] + box[3]) / 2, bz = (box[4] + box[5]) / 2;
  const bR = Math.hypot(box[1] - bx, box[3] - by, box[5] - bz);
  return { x: rk.x, y: rk.y, size, height: Hh, chunks, k, box, bx, by, bz, bR,
    // the waterline, rounded off for the ripples: rings far out from a rock
    // round off whatever its corners were
    ripR: 0.35 * size,
    minStep: 0.004 * size };
}

// The axis-aligned extent of one chunk: every corner of its polytope (three
// planes meeting at a point no other plane cuts off), held to its sphere.
// A dozen planes is a few hundred triples; a smooth rock's two dozen, a few
// thousand — prep-time arithmetic, once per rock.
function chunkExtent(ch) {
  const { P, NX, NY, NZ, D } = ch;
  const e = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  const tol = 1e-7 * (1 + ch.br);
  for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) for (let c = b + 1; c < P; c++) {
    // Cramer's rule on the three planes
    const det = NX[a] * (NY[b] * NZ[c] - NZ[b] * NY[c])
      - NY[a] * (NX[b] * NZ[c] - NZ[b] * NX[c]) + NZ[a] * (NX[b] * NY[c] - NY[b] * NX[c]);
    if (Math.abs(det) < 1e-9) continue;
    const px = (D[a] * (NY[b] * NZ[c] - NZ[b] * NY[c])
      - NY[a] * (D[b] * NZ[c] - NZ[b] * D[c]) + NZ[a] * (D[b] * NY[c] - NY[b] * D[c])) / det;
    const py = (NX[a] * (D[b] * NZ[c] - NZ[b] * D[c])
      - D[a] * (NX[b] * NZ[c] - NZ[b] * NX[c]) + NZ[a] * (NX[b] * D[c] - D[b] * NX[c])) / det;
    const pz = (NX[a] * (NY[b] * D[c] - D[b] * NY[c])
      - NY[a] * (NX[b] * D[c] - D[b] * NX[c]) + D[a] * (NX[b] * NY[c] - NY[b] * NX[c])) / det;
    let ok = true;
    for (let i = 0; i < P && ok; i++) if (NX[i] * px + NY[i] * py + NZ[i] * pz - D[i] > tol) ok = false;
    if (!ok) continue;
    if (px < e[0]) e[0] = px; if (px > e[1]) e[1] = px;
    if (py < e[2]) e[2] = py; if (py > e[3]) e[3] = py;
    if (pz < e[4]) e[4] = pz; if (pz > e[5]) e[5] = pz;
  }
  // the sphere clip: never more than the sphere, and the sphere alone if the
  // planes somehow closed nothing
  const sb = [ch.cx - ch.br, ch.cx + ch.br, ch.cy - ch.br, ch.cy + ch.br, ch.cz - ch.br, ch.cz + ch.br];
  for (let a = 0; a < 6; a += 2) {
    e[a] = e[a] === Infinity ? sb[a] : Math.max(e[a], sb[a]);
    e[a + 1] = e[a + 1] === -Infinity ? sb[a + 1] : Math.min(e[a + 1], sb[a + 1]);
  }
  return e;
}

// log-sum-exp scratch, one per thread
const V = new Float64Array(64);
const ROUND_CAP = 1.2, ROUND_LET = 0.6;

// One chunk's distance: the max over its planes, rounded to radius `rr`.
// Writes the gradient into `g` when asked.
function chunkAt(ch, x, y, z, rr, g) {
  const { P, NX, NY, NZ, D } = ch;
  let m = -Infinity, im = 0;
  for (let i = 0; i < P; i++) {
    const v = NX[i] * x + NY[i] * y + NZ[i] * z - D[i];
    V[i] = v;
    if (v > m) { m = v; im = i; }
  }
  let val;
  if (rr < 1e-9) {
    if (g) { g[0] = NX[im]; g[1] = NY[im]; g[2] = NZ[im]; }
    val = m;
  } else {
    // terms more than 9 radii below the max add less than 1e-4 of a radius
    const lo = m - 9 * rr;
    let s = 0, gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < P; i++) {
      if (V[i] < lo) continue;
      const w = Math.exp((V[i] - m) / rr);
      s += w;
      if (g) { gx += w * NX[i]; gy += w * NY[i]; gz += w * NZ[i]; }
    }
    // Log-sum-exp rounds an edge by overshooting the max there — by r·ln 2
    // where two faces meet, r·ln 3 at a corner. Where many faces are nearly
    // level at once (the flank of a smooth rock, the middle of any chunk) the
    // overshoot would grow with their count and eat the rock from inside, so
    // it is capped at about a corner's worth, and the whole chunk let out by
    // half of that so rounding does not also shrink it.
    const ls = Math.log(s);
    if (g) {
      if (ls < ROUND_CAP) { g[0] = gx / s; g[1] = gy / s; g[2] = gz / s; }
      else { g[0] = NX[im]; g[1] = NY[im]; g[2] = NZ[im]; }
    }
    val = m + rr * ((ls < ROUND_CAP ? ls : ROUND_CAP) - ROUND_LET);
  }
  // A few planes tangent to an ellipsoid can meet in a spike well outside it,
  // so each chunk is also held inside its bounding sphere. That is what makes
  // the sphere a promise the ray tests and the chunk skip can rely on.
  const ex = x - ch.cx, ey = y - ch.cy, ez = z - ch.cz;
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const sv = el - ch.br;
  if (sv > val) {
    if (g && el > 0) { g[0] = ex / el; g[1] = ey / el; g[2] = ez / el; }
    return sv;
  }
  return val;
}

const G1 = new Float64Array(3);

// The rock's signed distance at a point (a lower bound outside). `rip` asks for
// the rounded waterline the ripples follow instead of the rock's own edges.
export function rockSdf(pr, x, y, z, rip = false, g = null) {
  let best = Infinity;
  const k = pr.k;
  const chunks = pr.chunks;
  for (let j = 0; j < chunks.length; j++) {
    const ch = chunks[j];
    // a chunk whose bounding sphere is farther than what is already found
    // cannot be the nearest — skipping it keeps the value a lower bound
    const ex = x - ch.cx, ey = y - ch.cy, ez = z - ch.cz;
    const bnd = Math.sqrt(ex * ex + ey * ey + ez * ez) - ch.br;
    if (bnd > best + k) continue;
    const rr = rip ? Math.max(ch.r, pr.ripR) : ch.r;
    const v = chunkAt(ch, x, y, z, rr, g ? G1 : null);
    if (best === Infinity) {
      best = v;
      if (g) { g[0] = G1[0]; g[1] = G1[1]; g[2] = G1[2]; }
    } else if (k > 0 && Math.abs(v - best) < k) {
      // polynomial smooth-min, and its gradient: the mix it takes of the two
      const h = (k - Math.abs(v - best)) / k;
      const wa = v < best ? 1 - h / 2 : h / 2;           // weight on the new chunk
      if (g) for (let c = 0; c < 3; c++) g[c] = wa * G1[c] + (1 - wa) * g[c];
      best = Math.min(v, best) - (h * h * k) / 4;
    } else if (v < best) {
      best = v;
      if (g) { g[0] = G1[0]; g[1] = G1[1]; g[2] = G1[2]; }
    }
  }
  return best;
}

// The closest a ray comes to the rock: out[0] = the least signed distance
// along it (negative: it goes in, and how deep), out[1] = where along the ray
// that was, out[2] = where it first went in (-1 if it never did). The
// direction must be unit length.
//
// Three tolerances, all the caller's, because they are pixels and only the
// caller knows how big a pixel is out there: `reach` is how far off a miss
// still matters (past it the answer is only a bound, which is all a clamped
// field needs), `deep` how far in a hit still matters (past it the ray stops:
// the rock is in front and where it went in is known), and `eps` the finest
// step worth taking.
//
// Sphere tracing, over-relaxed (Keinert et al., "Enhanced Sphere Tracing"),
// with the minimum kept on the way — the classic soft-shadow trick — and a
// short golden-section search at the end, because the steps that land nearest
// the rock are also where the minimum is least resolved.
export function rayMin(pr, ox, oy, oz, dx, dy, dz, reach, deep, eps, tMax, out) {
  // clip the ray to the rock's box, let out by `reach`: a ray that misses it
  // is simply "at least reach away"
  const box = pr.box;
  let t = 0, t1 = tMax;
  for (let a = 0; a < 3 && t <= t1; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz, d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = box[2 * a] - reach, hi = box[2 * a + 1] + reach;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) t1 = -1;
      continue;
    }
    let ta = (lo - o) / d, tz = (hi - o) / d;
    if (ta > tz) { const x = ta; ta = tz; tz = x; }
    if (ta > t) t = ta;
    if (tz < t1) t1 = tz;
  }
  if (t > t1) {
    out[0] = reach * 1.5; out[1] = Math.max(0, t); out[2] = -1;
    return out;
  }
  const minStep = Math.max(pr.minStep, eps);
  let best = Infinity, tb = t, hit = -1, stepB = minStep;
  let omega = 1.6, prevR = 0, stepLen = 0;
  for (let n = 0; n < 200 && t <= t1; n++) {
    const v = rockSdf(pr, ox + t * dx, oy + t * dy, oz + t * dz);
    const r = Math.abs(v);
    // over-relaxation failed: the spheres at the last two points do not
    // overlap, so the step may have jumped something — go back, and walk
    // plainly from there
    if (omega > 1 && r + prevR < stepLen) {
      t -= stepLen - stepLen / omega;
      omega = 1; prevR = 0; stepLen = 0;
      continue;
    }
    if (v < best) { best = v; tb = t; stepB = Math.max(r, minStep); }
    if (hit < 0 && v <= 0) hit = t;
    if (v < -deep) break;
    stepLen = Math.max(r * omega, minStep);
    // near the rock, plain steps: the minimum is being looked for here
    if (r < 4 * minStep) { omega = 1; stepLen = Math.max(r, minStep); }
    prevR = r;
    t += stepLen;
  }
  if (best < reach && best > -deep) {
    let a = Math.max(0, tb - stepB), b = tb + stepB;
    const gr = 0.381966;
    let c = a + gr * (b - a), d = b - gr * (b - a);
    let fc = rockSdf(pr, ox + c * dx, oy + c * dy, oz + c * dz);
    let fd = rockSdf(pr, ox + d * dx, oy + d * dy, oz + d * dz);
    for (let n = 0; n < 8; n++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = a + gr * (b - a);
        fc = rockSdf(pr, ox + c * dx, oy + c * dy, oz + c * dz); }
      else { a = c; c = d; fc = fd; d = b - gr * (b - a);
        fd = rockSdf(pr, ox + d * dx, oy + d * dy, oz + d * dz); }
    }
    if (fc < best) { best = fc; tb = c; }
    if (fd < best) { best = fd; tb = d; }
    if (hit < 0 && best <= 0) hit = tb;
  }
  out[0] = best; out[1] = tb; out[2] = hit;
  return out;
}

// Distance out from the rock's waterline, in ground units, with its gradient
// on the plane — what the ripples ring outward from. Negative under the rock.
const G2 = new Float64Array(3);
export function waterlineAt(pr, gx, gy, g) {
  const d = rockSdf(pr, gx, gy, 0, true, g ? G2 : null);
  if (g) {
    // the gradient of a lower bound can point a little up out of the plane;
    // what the rings follow is its horizontal part, renormalized
    const l = Math.sqrt(G2[0] * G2[0] + G2[1] * G2[1]) || 1;
    g[0] = G2[0] / l; g[1] = G2[1] / l;
  }
  return d;
}
