import {
  buildGeometry, buildSegmentation, envFromRows, stampObjects,
  paletteStops, paletteColorAt, DERIVED_ENV_H, ENV2D_W, DEFAULT_EMITTERS,
  computeFit, cell2ground, heightAt, clampLift, penProject,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * 1D vs 2D fidelity parity
 *
 * The 1D (preset / painted-strip) path contours the continuous reflected-
 * elevation field directly, so every small ripple whose φ excursion crosses
 * a band boundary draws its own color ring. The 2D (panorama) path — which
 * also takes over whenever a reflected object is live — must not lose that
 * detail: for a striped panorama its layer boundaries are the same level
 * sets, so the amount of contour structure should match the 1D output.
 *
 * Detail metric: the number of closed subpaths ("M" commands) across all
 * region paths. Water-space blurring of the composed fields (the old
 * behaviour) collapses small rings and slashes this count; the panorama-
 * space formulation keeps it at parity.
 * ------------------------------------------------------------------ */

const PAL = "Harbor Ink";
const AZ = 45;

// mirrors the app's default settings (quality 100, default emitters)
const baseS = () => ({
  nx: 100, ny: 100,
  xMin: -12, xMax: 12, yMin: 3, yMax: 46,
  H: 0.4 * Math.pow(22.5, 0.35),
  pitch: (12.6 * Math.PI) / 180,
  k: (2 * Math.PI) / 3.0,
  amp: 0.52 * 0.06,
  sharp: 0.3,
  decay: 0.18 - 0.5 * 0.16,
  omega: 1, t: 0,
  bands: 9, perspective: true, eLo: 0, eHi: 20,
  zoom: 1, panX: 0, panY: 0, smooth: 2, coherence: 0, rectOutput: false,
  surface3d: false, waveScale: 1.5,
  bandFractions: null, fresOn: false, fresBands: 3, reflMag: 1,
  emitters: DEFAULT_EMITTERS,
});

const subpaths = (ds) =>
  ds.reduce((n, d) => n + ((d || "").match(/M/g) || []).length, 0);

// 1D reference: banded palette contoured at its exact band fractions
const geom1d = () => {
  const S = { ...baseS(), bandFractions: paletteStops(PAL).slice(1).map((s) => s.f0) };
  return buildGeometry(S);
};

// the striped panorama the app derives from the same palette when a
// reflected object forces the 2D path
const stripedEnv = () =>
  envFromRows((f) => paletteColorAt(PAL, f), ENV2D_W, DERIVED_ENV_H);

test("striped 2D panorama keeps the 1D path's ring detail", () => {
  const n1 = subpaths(geom1d().ds);
  expect(n1).toBeGreaterThan(50); // sanity: the scene is genuinely detailed

  const seg = buildSegmentation(baseS(), stripedEnv(), AZ);
  expect(seg.layers).toBeTruthy(); // union path, not the >160-color fallback
  const n2 = subpaths(seg.layers.map((l) => l.d));
  expect(n2).toBeGreaterThanOrEqual(0.8 * n1);
});

test("adding a reflected object does not collapse scene detail", () => {
  const n1 = subpaths(geom1d().ds);
  const objects = [
    { id: 1, on: true, type: "sailboat", az: 14, size: 8, color: "#c2521f", color2: "#efe9d9" },
  ];
  const env = stampObjects(stripedEnv(), objects, AZ, 0, 20);
  const seg = buildSegmentation(baseS(), env, AZ);
  expect(seg.layers).toBeTruthy();
  const n2 = subpaths(seg.layers.map((l) => l.d));
  expect(n2).toBeGreaterThanOrEqual(0.8 * n1);
});

test("3D waves: 2D layers hug the lifted water edge (no container walls)", () => {
  // The 2D path contours on a one-cell-padded grid whose overshoot is meant
  // to be trimmed by the flat watertrap clip — which 3D mode skips so crests
  // can rise above the trapezoid. Pad-zone vertices must therefore land ON
  // the lifted water edge; if they hang outside it, every layer grows a
  // colored apron below the near edge ("sides like a container").
  const S = { ...baseS(), surface3d: true, waveScale: 8 };
  const seg = buildSegmentation(S, stripedEnv(), AZ); // also preps S._ems

  let maxY = -Infinity; // bottom-most vertex across all layers
  for (const l of seg.layers) {
    const nums = (l.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    for (let i = 1; i < nums.length; i += 2) if (nums[i] > maxY) maxY = nums[i];
  }

  // the true lifted near-edge silhouette, projected point by point
  const fit = computeFit(S);
  let edgeMaxY = -Infinity;
  for (let i = 0; i <= S.nx; i++) {
    const [gx, gy] = cell2ground(i, 0, S);
    const gz = clampLift(heightAt(gx, gy, S) * S.waveScale, S, fit);
    const y = penProject(gx, gy, gz, S, fit)[1];
    if (y > edgeMaxY) edgeMaxY = y;
  }
  expect(maxY).toBeLessThanOrEqual(edgeMaxY + 3); // 3px: bezier control slack
});

test("the de-jitter blur is opt-in: coherence 0 must not smooth", () => {
  // raising coherence should strictly reduce detail; at 0 the segmentation
  // must sit at (or above) the smoothed count — i.e. the blur is not baked in
  const sharp = buildSegmentation(baseS(), stripedEnv(), AZ);
  const calm = buildSegmentation({ ...baseS(), coherence: 4 }, stripedEnv(), AZ);
  const nSharp = subpaths(sharp.layers.map((l) => l.d));
  const nCalm = subpaths(calm.layers.map((l) => l.d));
  expect(nSharp).toBeGreaterThan(nCalm);
});
