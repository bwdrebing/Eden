import {
  buildSurfaceBands, computeFit, DEFAULT_EMITTERS,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * 3D solid surface: depth-sorted paint order
 *
 * The bug: lifted color layers were painted in reflected-backdrop-elevation
 * order, which ignores camera depth. On tall waves the grazing back-face
 * colors (bottom of the backdrop) painted last and showed THROUGH the crest
 * in front of them — "the higher the wave, the more of the backside you see".
 *
 * The fix tessellates the lifted surface into per-row bands painted strictly
 * far-to-near, so a nearer crest overpaints whatever it occludes. These tests
 * pin that invariant: the farthest row is emitted first, the nearest last, and
 * the surface is fully tiled.
 * ------------------------------------------------------------------ */

const baseS = () => ({
  nx: 40, ny: 40,
  xMin: -12, xMax: 12, yMin: 3, yMax: 46,
  H: 0.4 * Math.pow(22.5, 0.35),
  pitch: (12.6 * Math.PI) / 180,
  omega: 1, t: 0,
  perspective: true, eLo: 0, eHi: 20,
  zoom: 1, panX: 0, panY: 0, smooth: 0, coherence: 0, rectOutput: false,
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

// one distinct color per grid row (cell centers in a row share gy)
const rowColorAt = (gx, gy) => "row" + gy.toFixed(4);
const rowGy = (S, j) => S.yMin + ((j + 0.5) / S.ny) * (S.yMax - S.yMin);

test("bands are painted far-to-near regardless of wave height", () => {
  const S = withSwell(baseS());
  const fit = computeFit(S);
  const bands = buildSurfaceBands(S, fit, rowColorAt);

  // one band per row (each row is a single color), farthest first
  expect(bands.length).toBe(S.ny);
  expect(bands[0].color).toBe("row" + rowGy(S, S.ny - 1).toFixed(4)); // far edge
  expect(bands[bands.length - 1].color).toBe("row" + rowGy(S, 0).toFixed(4)); // near edge

  // strictly monotonic: every band is nearer than the one painted before it
  const gyOf = (b) => parseFloat(b.color.slice(3));
  for (let i = 1; i < bands.length; i++) {
    expect(gyOf(bands[i])).toBeLessThan(gyOf(bands[i - 1]));
  }
});

test("the lifted surface is fully tiled (no empty bands)", () => {
  const S = withSwell(baseS());
  const fit = computeFit(S);
  // a two-color field so runs get split within rows too
  const bands = buildSurfaceBands(S, fit, (gx) => (gx < 0 ? "#a" : "#b"));
  expect(bands.length).toBeGreaterThan(0);
  for (const b of bands) {
    expect(b.d.startsWith("M")).toBe(true);
    expect(b.d.endsWith("Z")).toBe(true);
    // a real quad-strip band has at least four vertices (M + 3×L)
    expect((b.d.match(/L/g) || []).length).toBeGreaterThanOrEqual(3);
  }
});

test("raising the wave height does not change the row paint order", () => {
  const mk = (waveScale) => {
    const S = withSwell({ ...baseS(), waveScale });
    return buildSurfaceBands(S, computeFit(S), rowColorAt).map((b) => b.color);
  };
  // occlusion is a paint-order property; the order is height-independent even
  // though the projected geometry folds more and more as the wave grows
  expect(mk(10)).toEqual(mk(0.5));
});
