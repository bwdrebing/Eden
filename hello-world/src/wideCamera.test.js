import {
  reflectAt, prepField, computeFit, cell2ground, rawProject, penProject,
  buildSolid3D, RASTER_LEVELS, VB_W, VB_H,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * The wide ("scan") camera, and the frame it prints onto
 *
 * Two claims worth pinning down, because both are invisible in the middle
 * of the frame and only show up at the far left and right — which is the
 * whole reason the mode exists:
 *
 *   * the reflection at a point depends on its DISTANCE and nothing else,
 *   * the picture stops converging sideways, while its center column and
 *     its near edge stay exactly where the ordinary camera put them.
 * ------------------------------------------------------------------ */

// a scene with the wave field switched off: then the reflected elevation is
// pure camera geometry, which is what these tests are about
const flat = (extra) => {
  const S = {
    nx: 40, ny: 40, xMin: -40, xMax: 40, yMin: 5, yMax: 60,
    H: 5, pitch: (30 * Math.PI) / 180, perspective: true,
    emitters: [], t: 0, zoom: 1, panX: 0, panY: 0, ...extra,
  };
  prepField(S);
  return S;
};
const elevAt = (gx, gy, S) =>
  (Math.asin(Math.max(-1, Math.min(1, reflectAt(gx, gy, S)[2]))) * 180) / Math.PI;
const nums = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

test("the wide camera's reflection is set by distance alone", () => {
  const one = flat(), wide = flat({ wide: true });
  // straight ahead the two cameras agree exactly
  expect(elevAt(0, 20, wide)).toBeCloseTo(elevAt(0, 20, one), 10);
  // off to the side they do not: one vantage point sees that water edge-on
  for (const gx of [10, 25, 40]) {
    expect(elevAt(gx, 20, wide)).toBeCloseTo(elevAt(0, 20, wide), 10);
    expect(Math.abs(elevAt(gx, 20, one) - elevAt(0, 20, one))).toBeGreaterThan(0.5);
  }
  // …and it is the distance that carries it, so depth still changes the angle
  expect(elevAt(0, 50, wide)).not.toBeCloseTo(elevAt(0, 20, wide), 3);
});

test("the wide camera's reflected azimuth is the wave's own, not the seat's", () => {
  const one = flat(), wide = flat({ wide: true });
  const az = (gx, gy, S) => Math.atan2(reflectAt(gx, gy, S)[0], reflectAt(gx, gy, S)[1]);
  expect(az(40, 20, wide)).toBeCloseTo(0, 10);       // flat water, aimed straight out
  expect(Math.abs(az(40, 20, one))).toBeGreaterThan(0.5);
});

test("the wide picture is a rectangle that keeps the center column and near edge", () => {
  const one = flat(), wide = flat({ wide: true });
  // in camera units, before any fit: this is the claim the mode makes
  for (const gy of [5, 20, 60]) {
    expect(rawProject(0, gy, wide)[0]).toBeCloseTo(0, 12);          // center column
    expect(rawProject(40, gy, wide)[1])                             // rows untouched
      .toBeCloseTo(rawProject(40, gy, one)[1], 12);
  }
  // the near edge keeps exactly the width the ordinary camera gave it…
  expect(rawProject(40, 5, wide)[0]).toBeCloseTo(rawProject(40, 5, one)[0], 12);
  // …and every row behind it keeps that same width, instead of converging
  expect(rawProject(40, 60, wide)[0]).toBeCloseTo(rawProject(40, 5, wide)[0], 12);
  expect(rawProject(40, 60, one)[0]).toBeLessThan(rawProject(40, 5, one)[0] * 0.5);

  // and on screen the water plane is a rectangle: four corners, two x's
  const fit = computeFit(wide);
  const px = (gx, gy) => penProject(gx, gy, 0, wide, fit);
  expect(px(-40, 60)[0]).toBeCloseTo(px(-40, 5)[0], 6);
  expect(px(40, 60)[0]).toBeCloseTo(px(40, 5)[0], 6);
  expect(px(40, 5)[0] - px(-40, 5)[0]).toBeGreaterThan(0);
});

test("the wide camera leaves the sample grid uniform under rectangular output", () => {
  const wide = flat({ wide: true, rectOutput: true });
  const [x0] = cell2ground(0, 0, wide);
  const [x1] = cell2ground(0, wide.ny, wide);
  expect(x0).toBeCloseTo(-40, 10);
  expect(x1).toBeCloseTo(-40, 10);        // the near row is no wider than the far one
});

test("a wider frame is more picture, not a stretched one", () => {
  // full-bleed, so the two axes are fitted independently and each can be
  // read on its own
  const wide = flat({ wide: true, rectOutput: true });
  const long = flat({ wide: true, rectOutput: true, vbW: 2280 });
  const fitW = computeFit(wide), fitL = computeFit(long);
  // the frame's own center, and three times the room to fill
  expect(fitW.ox).toBeCloseTo(VB_W / 2, 6);
  expect(fitL.ox).toBeCloseTo(2280 / 2, 6);
  expect(fitL.scale / fitW.scale).toBeCloseTo((2280 - 28) / (VB_W - 28), 6);
  // vertical scale is untouched — the sheet is longer, not taller
  expect(fitL.scaleY).toBeCloseTo(fitW.scaleY, 6);
  expect(fitL.oy).toBeCloseTo(fitW.oy, 6);
});

test("the saved scene renders through the wide camera onto a long frame", () => {
  const settings = {
    ...GRAZING_RIPPLES,
    wide: true, rectOutput: true, halfW: 120, frameW: 2280,
    zoom: 1, panX: 0, panY: 0, quality: 90,
  };
  const { S, fieldSpec } = buildScene(settings);
  expect(S.vbW).toBe(2280);
  expect(S.nx).toBe(Math.round(90 * 2280 / VB_W));   // samples are a density
  const L = RASTER_LEVELS[0];
  const { layers } = buildSolid3D(S, fieldSpec,
    { gN: L.gN, BW: Math.round(L.BW * 2280 / VB_W) });
  expect(layers.length).toBeGreaterThan(0);
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) {
    const n = nums(l.d);
    expect(n.length).toBeGreaterThan(20);
    for (let i = 0; i + 1 < n.length; i += 2) {
      if (n[i] < minX) minX = n[i];
      if (n[i] > maxX) maxX = n[i];
      if (n[i + 1] > maxY) maxY = n[i + 1];
    }
  }
  // it uses the long frame, and stays on it (bar the one-cell overshoot)
  expect(maxX).toBeGreaterThan(VB_W * 2);
  expect(maxX).toBeLessThan(2280 + 40);
  expect(minX).toBeGreaterThan(-40);
  expect(maxY).toBeLessThan(VB_H + 40);
}, 120000);
