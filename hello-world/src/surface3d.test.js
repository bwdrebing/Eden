import {
  buildSurface3D, computeFit, DEFAULT_EMITTERS,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * 3D solid surface: smooth regions + hidden-surface removal
 *
 * The 3D water must look like the flat modes — smooth, sub-cell region
 * outlines — while still hiding a tall wave's far side behind the crest in
 * front of it. buildSurface3D gets both by resolving occlusion on a z-buffered
 * raster and then contouring that raster with the same marching-squares +
 * Chaikin + bezier pipeline the flat modes use. These tests pin the two
 * properties that matter: the output is smooth curves (not axis-aligned cell
 * facets), and the raster maps depth to screen the way projection does.
 * ------------------------------------------------------------------ */

const baseS = () => ({
  nx: 60, ny: 60,
  xMin: -12, xMax: 12, yMin: 3, yMax: 46,
  H: 0.4 * Math.pow(22.5, 0.35),
  pitch: (12.6 * Math.PI) / 180,
  omega: 1, t: 0,
  perspective: true, eLo: 0, eHi: 20,
  zoom: 1, panX: 0, panY: 0, smooth: 2, coherence: 0, rectOutput: false,
  surface3d: true, waveScale: 8,
  bandFractions: null, fresOn: false, fresBands: 3, reflMag: 1,
  emitters: DEFAULT_EMITTERS,
});

// a steep swell travelling into the scene (z = A·sin(k·gy)) so the surface
// genuinely folds in screen space at this exaggerated wave height
const withSwell = (S) => {
  S._ems = [{ type: "swell", k0: (2 * Math.PI) / 8, Dx: 0, Dy: 1, ph0: 0, q: 0, aa: 0, A: 1 }];
  return S;
};

// pull the (x, y) pairs out of a path string — every command emits pairs
const pathYs = (d) => {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  return nums.filter((_, i) => i % 2 === 1);
};

test("3D regions are smooth bezier curves, not axis-aligned cell facets", () => {
  const S = withSwell(baseS());
  const fit = computeFit(S);
  const scalarAt = (gx, gy) => gy + 3 * Math.sin(gx * 0.5); // banded, wavy boundaries
  const { layers } = buildSurface3D(S, fit, { scalarAt, thresholds: [12, 22, 32], gN: 120, BW: 380 });

  expect(layers.length).toBe(3);
  const all = layers.join("");
  expect(all).toContain("C");           // cubic beziers => genuinely smooth
  // and not a staircase of only horizontal/vertical hops
  expect(all).not.toMatch(/^[ML0-9. ]+Z\s*$/);
});

test("raising the wave height keeps the output smooth (no crash, still curved)", () => {
  const mk = (waveScale) => {
    const S = withSwell({ ...baseS(), waveScale });
    return buildSurface3D(S, computeFit(S), { scalarAt: (gx, gy) => gy, thresholds: [15, 25], gN: 100, BW: 320 });
  };
  for (const ws of [0.5, 4, 8, 10]) {
    const { layers } = mk(ws);
    expect(layers.length).toBe(2);
    expect(layers.join("")).toContain("C");
  }
});

test("Fresnel bands are produced only when a Fresnel field is supplied", () => {
  const S = withSwell(baseS());
  const fit = computeFit(S);
  const scalarAt = (gx, gy) => gy;
  const noF = buildSurface3D(S, fit, { scalarAt, thresholds: [15, 25], gN: 90, BW: 300 });
  expect(noF.fres).toBeNull();

  const withF = buildSurface3D(S, fit, {
    scalarAt, thresholds: [15, 25],
    fresAt: (gx, gy) => Math.min(1, Math.max(0, (gy - 3) / 40)),
    fresThresholds: [0.33, 0.66], gN: 90, BW: 300,
  });
  expect(Array.isArray(withF.fres)).toBe(true);
  expect(withF.fres.length).toBe(2);
});

test("a farther band lands higher on screen (occluded raster projects correctly)", () => {
  const S = baseS();
  S._ems = []; // flat plane: depth ordering is pure geometry
  const fit = computeFit(S);
  const mid = (S.yMin + S.yMax) / 2;
  const { layers } = buildSurface3D(S, fit, { scalarAt: (gx, gy) => gy, thresholds: [mid], gN: 120, BW: 380 });
  // {gy >= mid} is the far half of the plane → the upper part of the 500-tall
  // frame (perspective puts distance near the top)
  const ys = pathYs(layers[0]);
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  expect(meanY).toBeLessThan(250);
});
