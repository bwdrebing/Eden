// The optics of the ice view (ice.js), checked against the physics they claim
// rather than against pictures: a block that bends nothing at index 1, a slab
// that shifts a ray without turning it, blue bending further than red, and the
// critical-angle tear the renderer cuts along.
import { prepIceCube, newIceCube, iceMeet, traceIce, cameraRay, ICE_Z, ICE_T, refract }
  from "./ice";

const block = (o = {}) => prepIceCube({ ...newIceCube(1), bump: 0, round: 0,
  yaw: 0, pitch: 0, roll: 0, ...o });
const through = (ks, u, v, ior, zWall, opts) => {
  const m = iceMeet(ks[0], [0, 0, 0], cameraRay(u, v));
  return m ? { m, r: traceIce(ks, 0, m, ior, zWall, opts) } : null;
};

test("at index 1 nothing bends, however rumpled and turned the block", () => {
  const ks = [block({ yaw: 30, pitch: 20, roll: 12, round: 0.3, bump: 0.8 })];
  let hits = 0;
  for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) {
    const u = -0.5 + i / 24, v = -0.5 + j / 24;
    const t = through(ks, u, v, 1, ICE_Z + 8);
    if (!t || t.m.sil >= 0) continue;
    hits++;
    expect(t.r.u).toBeCloseTo(u, 6);
    expect(t.r.v).toBeCloseTo(v, 6);
  }
  expect(hits).toBeGreaterThan(50);
});

test("a face-on slab shifts a ray sideways without turning it", () => {
  const ks = [block()];
  // straight through the middle: straight behind
  const c = through(ks, 0, 0, 1.31, ICE_Z + 8).r;
  expect(c.u).toBeCloseTo(0, 9);
  expect(c.v).toBeCloseTo(0, 9);
  // off axis the ray comes out parallel to how it went in, so the sideways
  // shift it picked up is the same in world units wherever the wall is
  const u = 0.2, shift = (zWall) => {
    const r = through(ks, u, 0, 1.31, zWall).r;
    return (u - r.u) * zWall * ICE_T;
  };
  expect(shift(ICE_Z + 4)).toBeGreaterThan(0);        // pulled toward the axis
  expect(shift(ICE_Z + 30)).toBeCloseTo(shift(ICE_Z + 4), 6);
});

test("the silhouette value is signed: negative through the block, positive past it", () => {
  const ks = [block()];
  const mid = iceMeet(ks[0], [0, 0, 0], cameraRay(0, 0));
  expect(mid.sil).toBeCloseTo(-ks[0].h, 4);    // the search stops at 2e-5 of the block
  const edge = iceMeet(ks[0], [0, 0, 0], cameraRay(0.4, 0));   // clear of the near face and the far one, in perspective
  expect(edge.sil).toBeGreaterThan(0);
});

test("blue bends further than red (dispersion)", () => {
  const ks = [block({ yaw: 35, pitch: 10 })];
  const at = (n) => through(ks, 0.08, 0.05, n, ICE_Z + 10).r;
  const straight = 0.08;
  const red = Math.abs(at(1.29).u - straight), blue = Math.abs(at(1.41).u - straight);
  expect(blue).toBeGreaterThan(red);
});

test("refract follows Snell's law and reports total internal reflection", () => {
  const s = Math.sin(0.5);
  const t = refract([s, 0, -Math.cos(0.5)], [0, 0, 1], 1 / 1.31);
  expect(t[0]).toBeCloseTo(s / 1.31, 12);
  // from inside, past the critical angle (asin(1/1.31) = 49.8 degrees)
  const g = Math.sin(1.0);
  expect(refract([g, 0, Math.cos(1.0)], [0, 0, -1], 1.31)).toBeNull();
});

test("across the critical-angle tear each side is traced on as though it were not there", () => {
  const ks = [prepIceCube(newIceCube(1))];
  let seen = 0;
  for (let i = 0; i < 40 && seen < 5; i++) for (let j = 0; j < 40 && seen < 5; j++) {
    const u = -0.6 + (1.2 * i) / 39, v = -0.6 + (1.2 * j) / 39;
    const a = through(ks, u, v, 1.31, ICE_Z + 8, { split: 1 });
    if (!a || a.m.sil >= 0 || a.r.disc >= 0) continue;
    const b = traceIce(ks, 0, a.m, 1.31, ICE_Z + 8, { split: 2 });
    // the same ray, the same tear, two different pictures
    expect(b.disc).toBeCloseTo(a.r.disc, 12);
    expect(Math.hypot(a.r.u - b.u, a.r.v - b.v)).toBeGreaterThan(1e-3);
    // and the unsplit trace is the mirrored one: that is what really happens
    const plain = traceIce(ks, 0, a.m, 1.31, ICE_Z + 8);
    expect(plain.u).toBeCloseTo(b.u, 9);
    seen++;
  }
  expect(seen).toBe(5);
});
