import { fieldSpecFor, reflectAt } from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * Fresnel on the surface the scene draws
 *
 * The deep-water weight reads its normal off the LIFTED surface in the
 * 3D-solid pass (so a face the lift tilts toward the camera darkens as a face
 * that steep would), and counts a reflected ray that points into the water as
 * blocked — all water, no sky.
 * ------------------------------------------------------------------ */

const specFor = (over) => {
  const { S, fieldSpec } = buildScene({ ...GRAZING_RIPPLES, fresOn: true, ...over });
  return { S, spec: fieldSpecFor(S, { use2d: false, cols: fieldSpec.cols, fresOn: true, fresBands: 3 }) };
};
const row = (fresAt, gy) => Array.from({ length: 400 }, (_, i) => fresAt(-8 + (16 * i) / 400, gy));
const spread = (v) => Math.max(...v) - Math.min(...v);

test("the lifted surface's steeper faces spread the Fresnel weight across each wave", () => {
  const flat = specFor({ surface3d: false }).spec.fresAt;
  const lifted = specFor({ surface3d: true }).spec.fresAt;   // waveScale 8.55
  for (const gy of [10, 20, 30]) expect(spread(row(lifted, gy))).toBeGreaterThan(1.5 * spread(row(flat, gy)));
}, 120000);

test("at or below the physical wave height the lift changes nothing", () => {
  const a = specFor({ surface3d: false, waveScale: 1 }).spec.fresAt;
  const b = specFor({ surface3d: true, waveScale: 1 }).spec.fresAt;
  const c = specFor({ surface3d: true, waveScale: 0 }).spec.fresAt;
  expect(row(b, 20)).toEqual(row(a, 20));
  expect(row(c, 20)).toEqual(row(a, 20));
}, 120000);

test("a reflection that points into the water is all water", () => {
  const { S, spec } = specFor({ surface3d: false });
  let hit = 0;
  for (let gy = 70; gy < 90; gy += 0.13) for (let gx = -8; gx < 8; gx += 0.17) {
    if (reflectAt(gx, gy, S)[2] < -0.06) { hit++; expect(spec.fresAt(gx, gy)).toBe(1); }
  }
  expect(hit).toBeGreaterThan(10);                     // the far field does have some
}, 120000);
