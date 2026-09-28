// ------------------------------------------------------------------ //
//  Ice: the optics of a block of ice standing in front of the backdrop
//
//  The ice view is the backdrop seen straight on, as a picture on a wall, with
//  blocks of ice hanging between it and the camera. Every screen point is a
//  ray; where a ray meets a block it bends in through the face it strikes,
//  crosses the block, bends again on the way out (or reflects back in, when it
//  meets a far face past the critical angle) and lands on the wall somewhere
//  other than straight behind it. That displacement is the whole picture: the
//  renderer contours the backdrop's regions through it exactly as the water
//  contours them through its reflected rays, so a painted edge seen through
//  ice is still one smooth vector outline, just a bent one.
//
//  This module is only the geometry and the optics — plain numbers in, plain
//  numbers out, no DOM and no closures kept — so it runs anywhere a builder
//  does and is testable on its own. Contouring lives in the renderer
//  (buildIceView), next to the sky view it shares its backdrop sampling with.
//
//  The world: camera at the origin looking down +z, x right, y up. The ice
//  hangs about ICE_Z in front of it, where the frame is exactly ICE_SPAN units
//  across; the wall is `dist` further back and is sized to fill the frame, so
//  without ice the picture is the backdrop, edge to edge, undistorted.
//
//  The block is a rounded box — the signed distance field of a box with its
//  edges filleted — which is what makes a real ice cube's soft silhouette and
//  the bright, stretched band along each worn edge. Its SDF is convex, and the
//  distance to a convex set is a convex function along any line, which buys
//  the one property everything here rests on: along a ray, the field has a
//  single minimum. So a hit is not a sphere-trace that might skip a thin
//  corner — it is a golden-section search for that minimum and two
//  bisections either side of it, exact to the last bit a float has.
//
//  That minimum is also the silhouette. It is signed (negative for a ray that
//  passes through the block) and continuous across the outline, so its zero
//  level set IS the outline, to sub-pixel accuracy, with nothing to trace.
// ------------------------------------------------------------------ //

export const ICE_Z = 20;          // how far in front of the camera the ice hangs
export const ICE_T = 0.25;        // tan of half the horizontal field of view
export const ICE_SPAN = 2 * ICE_Z * ICE_T;   // the frame's width at the ice: 10 units
export const ICE_MAX = 5;         // blocks in one scene

// The optical constants, with the real ones as defaults. Water ice is 1.31;
// the slider reaches glass (1.5) and past diamond (2.42) for a stylized look.
export const ICE_IOR = 1.31;
// Dispersion is the gap between the index for red and for blue light. In real
// ice it is ~0.01 — a fringe a fraction of a pixel wide at this scale — so the
// slider's full range is a prism's worth, exaggerated on purpose.
export const ICE_DISPERSION_SPAN = 0.12;

// Where the key light is: above, left and a little behind the camera. Only
// the glints read it.
const LIGHT = (() => {
  const v = [-0.45, 0.75, -0.5], l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
const GLINT_POWER = 48;

const DEG = Math.PI / 180;
const GOLD = 0.3819660112501051;   // 2 - phi

// A new block, centered and turned three-quarters on so that its faces and
// edges all show at once — a cube met face-on is a window, not a lump of ice.
export function newIceCube(id, x = 0, y = 0) {
  return { id, on: true, x, y, z: 0, size: 3.2, yaw: 32, pitch: -20, roll: 10,
    round: 0.22, bump: 0.35, bumpSize: 0.45, cloud: 0.4 };
}

// deterministic per-block random numbers (a block's texture must not change
// when another block is added, so it is seeded by the block's id alone)
function seeded(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The surface texture: a sum of plane waves in the block's own frame, used as
// a bump map. Melted ice is not rough, it is RUMPLED — broad, smooth dimples —
// and a handful of waves at one scale with random headings is exactly that
// look, with an analytic gradient and no lattice to show through.
const BUMP_WAVES = 9;

// Everything about one block that does not depend on the ray, precomputed.
export function prepIceCube(c) {
  const h = Math.max(0.05, c.size / 2);
  const r = Math.min(0.98, Math.max(0, c.round || 0)) * h;
  const yaw = (c.yaw || 0) * DEG, pitch = (c.pitch || 0) * DEG, roll = (c.roll || 0) * DEG;
  // local -> world: roll about the view axis, of a pitch about x, of a yaw
  // about the vertical — turn it, tip it toward you, then lean it
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const M = mul3(Rz, mul3(Rx, Ry));
  const rnd = seeded((c.id | 0) + 7);
  const lam = Math.max(0.05, c.bumpSize || 0.5) * 2 * h;   // a dimple's size
  const waves = [];
  for (let i = 0; i < BUMP_WAVES; i++) {
    // a random heading, uniform on the sphere
    const u = rnd() * 2 - 1, a = rnd() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
    const f = ((2 * Math.PI) / lam) * (0.7 + 0.9 * rnd());
    waves.push({ kx: f * s * Math.cos(a), ky: f * s * Math.sin(a), kz: f * u,
      ph: rnd() * 2 * Math.PI, amp: 1 / Math.sqrt(BUMP_WAVES / 2) });
  }
  return {
    h, r, inner: h - r, M,
    C: [c.x || 0, c.y || 0, ICE_Z + (c.z || 0)],
    R: h * Math.sqrt(3) * 1.001,            // bounding sphere
    bump: Math.max(0, c.bump || 0), cloud: Math.max(0, Math.min(1, c.cloud || 0)),
    waves, size: 2 * h,
    bumpNorm: BUMP_WAVES / waves.reduce((a, w) => a + Math.hypot(w.kx, w.ky, w.kz), 0),
  };
}

function mul3(A, B) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return o;
}
const toLocal = (M, v) => [
  M[0] * v[0] + M[3] * v[1] + M[6] * v[2],
  M[1] * v[0] + M[4] * v[1] + M[7] * v[2],
  M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];
const toWorld = (M, v) => [
  M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
  M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
  M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];

// signed distance to the rounded box, in the block's frame
export function iceSdf(k, x, y, z) {
  const qx = Math.abs(x) - k.inner, qy = Math.abs(y) - k.inner, qz = Math.abs(z) - k.inner;
  const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
  const inside = Math.max(qx, qy, qz);
  return Math.sqrt(mx * mx + my * my + mz * mz) + (inside < 0 ? inside : 0) - k.r;
}

// its outward normal: analytic, and continuous round a fillet, which is what
// makes a worn edge a smooth band of bending rather than a crease
function iceNormal(k, x, y, z) {
  const qx = Math.abs(x) - k.inner, qy = Math.abs(y) - k.inner, qz = Math.abs(z) - k.inner;
  if (qx > 0 || qy > 0 || qz > 0) {
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
    const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    return [Math.sign(x) * mx / l, Math.sign(y) * my / l, Math.sign(z) * mz / l];
  }
  if (qx >= qy && qx >= qz) return [Math.sign(x) || 1, 0, 0];
  if (qy >= qz) return [0, Math.sign(y) || 1, 0];
  return [0, 0, Math.sign(z) || 1];
}

// the bump map's gradient (and value) at a point on the block
function bumpAt(k, x, y, z) {
  let gx = 0, gy = 0, gz = 0, v = 0;
  for (const w of k.waves) {
    const t = w.kx * x + w.ky * y + w.kz * z + w.ph;
    const c = Math.cos(t) * w.amp;
    gx += w.kx * c; gy += w.ky * c; gz += w.kz * c;
    v += Math.sin(t) * w.amp;
  }
  // gradient in "radians of tilt per unit of bump", independent of dimple size
  const f = k.bumpNorm;
  return [gx * f, gy * f, gz * f, v];
}

// The normal the light actually meets: the geometric one, tilted by the bump
// map. `fade` (0..1) takes the bump out toward a grazing silhouette, so the
// outline itself stays the block's true outline rather than a noisy one.
function shadingNormal(k, p, n, fade) {
  if (!k.bump || fade <= 0) return n;
  const g = bumpAt(k, p[0], p[1], p[2]);
  const gx = g[0], gy = g[1], gz = g[2];
  const s = 0.45 * k.bump * fade;
  const d = gx * n[0] + gy * n[1] + gz * n[2];
  const bx = n[0] - s * (gx - d * n[0]), by = n[1] - s * (gy - d * n[1]),
        bz = n[2] - s * (gz - d * n[2]);
  const l = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
  return [bx / l, by / l, bz / l];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Snell's law with the normal facing the incoming ray; null past the critical
// angle (total internal reflection)
export function refract(d, n, eta) {
  let ci = -dot(d, n);
  if (ci < 0) { n = [-n[0], -n[1], -n[2]]; ci = -ci; }   // either side of the face
  const k = 1 - eta * eta * (1 - ci * ci);
  if (k < 0) return null;
  const a = eta * ci - Math.sqrt(k);
  return [eta * d[0] + a * n[0], eta * d[1] + a * n[1], eta * d[2] + a * n[2]];
}
const reflect = (d, n) => {
  const c = 2 * dot(d, n);
  return [d[0] - c * n[0], d[1] - c * n[1], d[2] - c * n[2]];
};

// Schlick's approximation to the Fresnel reflectance
function fresnel(cosI, ior) {
  const f0 = ((ior - 1) / (ior + 1)) ** 2;
  const m = 1 - Math.max(0, Math.min(1, cosI));
  return f0 + (1 - f0) * m * m * m * m * m;
}

// Minimum of the (convex) field along o + t d on [a, b], by golden section.
// The answer comes back in lmT / lmF rather than as a pair: this is the inner
// loop of every pixel, and a returned array is an allocation (and, once the
// build tooling has lowered the destructuring, an iterator) per call.
let lmT = 0, lmF = 0;
function lineMin(k, o, d, a, b) {
  const at = (t) => iceSdf(k, o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]);
  let x1 = a + GOLD * (b - a), x2 = b - GOLD * (b - a);
  let f1 = at(x1), f2 = at(x2);
  for (let i = 0; i < 40 && b - a > 2e-5 * k.size; i++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = a + GOLD * (b - a); f1 = at(x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = b - GOLD * (b - a); f2 = at(x2); }
  }
  if (f1 < f2) { lmT = x1; lmF = f1; } else { lmT = x2; lmF = f2; }
}

// The zero of the field between a point inside (lo) and one outside (hi).
function lineZero(k, o, d, lo, hi) {
  for (let i = 0; i < 44 && Math.abs(hi - lo) > 2e-6 * k.size; i++) {
    const m = 0.5 * (lo + hi);
    if (iceSdf(k, o[0] + m * d[0], o[1] + m * d[1], o[2] + m * d[2]) < 0) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}

// Where a world ray meets one block: its closest approach (the signed
// silhouette value), and — for a ray that goes in — the entry point.
// Returns null when the ray does not come within the block's bounding sphere.
function meet(k, o, d) {
  const lo = toLocal(k.M, [o[0] - k.C[0], o[1] - k.C[1], o[2] - k.C[2]]);
  const ld = toLocal(k.M, d);
  const b = dot(lo, ld), c = dot(lo, lo) - k.R * k.R;
  const disc = b * b - c;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, -b - sq), t1 = -b + sq;
  if (t1 <= 0) return null;
  lineMin(k, lo, ld, t0, t1);
  const tm = lmT, sil = lmF;
  const out = { lo, ld, tm, sil, t: Infinity };
  if (sil < 0) out.t = lineZero(k, lo, ld, tm, t0);
  return out;
}

// Refract a ray (local frame) into the block at local point p with incoming
// direction d, then carry it across, reflecting internally where it must,
// and out. Returns the exit (local) ray plus what the crossing looked like.
//
// The first time the ray meets the far side is where the picture inside a
// block tears: on one side of the critical angle the ray leaves, on the other
// it is mirrored back in and ends up somewhere else entirely. A landing that
// jumps between neighbouring pixels contours into a staircase along the jump,
// and no smoothing of the traced outline can straighten it. But which side of
// the critical angle a ray is on is a smooth quantity — the discriminant under
// Snell's square root, `disc` — so the tear has a sub-pixel outline of its own.
// `split` lets the caller trace each side as though the tear were not there:
// 1 always leaves at that first meeting (past the critical angle, along the
// grazing limit), 2 always reflects there. Each is continuous across the tear,
// and the renderer shows one over the other, cut along disc = 0.
function crossBlock(k, p, d, n, eta, maxBounce, split = 0) {
  // in: from air, so never total internal reflection
  let dir = refract(d, n, 1 / eta) || d;
  // A ray that only grazes the block — the continuation past the outline —
  // never gets inside: the limit of a chord shrinking to nothing is a ray
  // bent in and straight back out, which is the ray it was.
  lineMin(k, p, dir, 0, 2.2 * k.R);
  if (lmF >= 0) return { o: p, d, len: 0, core: Infinity, bounces: 0, disc: 1 };
  let at = p;
  let len = 0, core = Infinity, disc0 = 1;
  for (let bounce = 0; bounce <= maxBounce; bounce++) {
    // start just inside the surface and find the far side: the field is
    // convex along the line, so its minimum then the zero past it
    const far = 2.2 * k.R;
    lineMin(k, at, dir, 0, far);
    const tm = lmT, fm = lmF;
    let te = 0;
    if (fm < 0) te = lineZero(k, at, dir, tm, far);
    const q = [at[0] + te * dir[0], at[1] + te * dir[1], at[2] + te * dir[2]];
    // how close the crossing came to the block's heart, for the cloudy core
    const along = Math.max(0, Math.min(te, -dot(at, dir)));
    const cp = [at[0] + along * dir[0], at[1] + along * dir[1], at[2] + along * dir[2]];
    const bv = k.cloud ? bumpAt(k, cp[0] * 0.7, cp[1] * 0.7, cp[2] * 0.7)[3] : 0;
    core = Math.min(core, Math.sqrt(dot(cp, cp)) / k.h + 0.12 * bv);
    len += te;
    at = q;
    const ng = iceNormal(k, q[0], q[1], q[2]);
    // the far face is as rumpled as the near one, but a ray trapped by total
    // internal reflection meets it again and again, and at full strength the
    // bumps compound into confetti; after the first meeting they are damped
    const ns = shadingNormal(k, q, ng, bounce ? 0.4 : 1);
    // out: the normal must face the ray, so it is the inward one
    const inward = [-ns[0], -ns[1], -ns[2]];
    if (bounce === 0) {
      const ci = dot(dir, ns);
      disc0 = 1 - eta * eta * (1 - ci * ci);
    }
    const forceIn = bounce === 0 && split === 2;
    let t = forceIn ? null : refract(dir, inward, eta);
    if (t && dot(t, ng) <= 0) t = refract(dir, [-ng[0], -ng[1], -ng[2]], eta);
    if (!t && bounce === 0 && split === 1) {
      // past the critical angle, but asked to leave: go out along the grazing
      // direction every ray on the other side of the tear tends to
      const ci = dot(dir, ns);
      const g = [dir[0] - ci * ns[0], dir[1] - ci * ns[1], dir[2] - ci * ns[2]];
      const gl = Math.sqrt(dot(g, g)) || 1;
      t = [g[0] / gl, g[1] / gl, g[2] / gl];
    }
    if (t) return { o: q, d: t, len, core, bounces: bounce, disc: disc0 };
    // past the critical angle: it stays in, mirrored off the face
    let r = reflect(dir, ns);
    if (dot(r, ng) >= 0) r = reflect(dir, ng);
    dir = r;
  }
  // trapped (a ray can circulate in a cube for a long time): let it go the
  // way it is heading, which is where most of that light eventually leaves
  return { o: at, d: dir, len, core, bounces: maxBounce + 1, disc: disc0 };
}

// Trace one camera ray for one block's layer.
//
// `first` is that block's own meeting with the ray (from `meet`), which the
// caller computes once per pixel and shares between the colour channels.
// The block is entered even where a nearer block covers it — the nearer one is
// drawn over it — and after leaving it the ray carries on through any block
// further back. The ray finally lands on the wall at z = zWall; the result is
// that landing point as a fraction of the frame, the coordinate the picture
// behind is indexed by.
//
// A ray that just misses the block (0 <= sil < margin) is traced as though it
// grazed it at its closest approach. That is the limit the hits approach at
// the silhouette, so the bent picture continues smoothly a few pixels past
// the outline — which is what lets the renderer clip it there without a seam.
//
// `opts.split` is crossBlock's: trace one side of the first total-internal-
// reflection tear as though it ran on across it. `disc` in the result says
// which side the ray is really on (>= 0: it leaves).
export function traceIce(blocks, ki, first, ior, zWall, opts = {}) {
  const k = blocks[ki];
  const maxBounce = opts.maxBounce == null ? 4 : opts.maxBounce;
  const { lo, ld } = first;
  let p, n, fade;
  if (first.sil < 0) {
    const t = first.t;
    p = [lo[0] + t * ld[0], lo[1] + t * ld[1], lo[2] + t * ld[2]];
    n = iceNormal(k, p[0], p[1], p[2]);
    // the bump fades out over the last stretch before the ray grazes
    const ci = -dot(ld, n);
    fade = ci >= 0.25 ? 1 : ci <= 0 ? 0 : ci / 0.25;
  } else {
    const t = first.tm;
    const c = [lo[0] + t * ld[0], lo[1] + t * ld[1], lo[2] + t * ld[2]];
    const g = iceNormal(k, c[0], c[1], c[2]);
    p = [c[0] - first.sil * g[0], c[1] - first.sil * g[1], c[2] - first.sil * g[2]];
    n = g;
    fade = 0;
  }
  const ns = shadingNormal(k, p, n, fade);
  const nIn = dot(ld, ns) < 0 ? ns : n;
  const ci = Math.max(0, -dot(ld, nIn));
  const F = fresnel(ci, ior);
  const rl = toWorld(k.M, reflect(ld, nIn));
  const glint = Math.pow(Math.max(0, dot(rl, LIGHT)), GLINT_POWER);
  const x = crossBlock(k, p, ld, nIn, ior, maxBounce, opts.split || 0);
  let o = toWorld(k.M, x.o), d = toWorld(k.M, x.d);
  o = [o[0] + k.C[0], o[1] + k.C[1], o[2] + k.C[2]];
  let len = x.len, core = x.core, cloud = k.cloud;
  // and on through anything further back, nearest first
  for (let hop = 0; hop < 3; hop++) {
    let best = null, bj = -1;
    for (let j = 0; j < blocks.length; j++) {
      if (j === ki && hop === 0) continue;
      const m = meet(blocks[j], o, d);
      if (m && m.sil < 0 && m.t > 1e-6 * blocks[j].size && (!best || m.t < best.t)) {
        best = m; bj = j;
      }
    }
    if (!best) break;
    const kb = blocks[bj];
    const pb = [best.lo[0] + best.t * best.ld[0], best.lo[1] + best.t * best.ld[1],
      best.lo[2] + best.t * best.ld[2]];
    const nb = iceNormal(kb, pb[0], pb[1], pb[2]);
    const xb = crossBlock(kb, pb, best.ld, nb, ior, maxBounce);
    o = toWorld(kb.M, xb.o); o = [o[0] + kb.C[0], o[1] + kb.C[1], o[2] + kb.C[2]];
    d = toWorld(kb.M, xb.d);
    len += xb.len;
    if (xb.core < core) { core = xb.core; cloud = Math.max(cloud, kb.cloud); }
  }
  // land on the wall. A ray leaving sideways or backwards (after a reflection)
  // is taken to land very far off, which the backdrop reads as its edge
  const dz = d[2] > 0.02 ? d[2] : 0.02;
  const t = (zWall - o[2]) / dz;
  const X = o[0] + t * d[0], Y = o[1] + t * d[1];
  const W = zWall * ICE_T;
  return { u: X / W, v: Y / W, F, glint, len, core, cloud, bounces: x.bounces, disc: x.disc };
}

// The camera ray through a frame point given as a fraction of the half-width
// (u right, v up — the same coordinates the wall is indexed in).
export function cameraRay(u, v) {
  const x = u * ICE_T, y = v * ICE_T, l = Math.sqrt(x * x + y * y + 1);
  return [x / l, y / l, 1 / l];
}

// One block's footprint on screen, in the same fraction-of-half-width units,
// from its bounding sphere — generous, since everything outside is skipped.
export function iceFootprint(k) {
  const z = k.C[2];
  if (z - k.R <= 0.5) return null;              // it reaches the camera
  const cu = k.C[0] / (z * ICE_T), cv = k.C[1] / (z * ICE_T);
  const rr = k.R / (Math.sqrt(z * z - k.R * k.R) * ICE_T);
  return { u0: cu - rr * 1.15, u1: cu + rr * 1.15, v0: cv - rr * 1.15, v1: cv + rr * 1.15 };
}

export { meet as iceMeet, LIGHT as ICE_LIGHT };
