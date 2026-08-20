import {
  buildSurface3D, buildSurface3DPanorama, buildSolid3D, buildSegmentation, computeFit, penProject,
  reflectAt, magFrac, envFromRows, paletteColorAt, ENV2D_W, DEFAULT_EMITTERS,
  crestField, RASTER_LEVELS, RASTER_DEFAULT, EXPORT_MULTS, EXPORT_MAX_BW, exportRaster,
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
const pathPoints = (d) => {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
};
const nearest = (pts, x, y) => {
  let best = Infinity;
  for (const q of pts) {
    const d = Math.hypot(q[0] - x, q[1] - y);
    if (d < best) best = d;
  }
  return best;
};

// bucketed nearest-point lookup: the layer-by-layer comparisons below run tens
// of thousands of queries against thousands of candidates
const CELL = 16;
const bucketize = (pts) => {
  const m = new Map();
  for (const q of pts) {
    const key = Math.floor(q[0] / CELL) + "," + Math.floor(q[1] / CELL);
    const a = m.get(key); if (a) a.push(q); else m.set(key, [q]);
  }
  return m;
};
const nearestB = (m, x, y) => {
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
  let best = Infinity;
  for (let ring = 0; ring < 24; ring++) {
    for (let j = cj - ring; j <= cj + ring; j++) for (let i = ci - ring; i <= ci + ring; i++) {
      if (ring && Math.abs(i - ci) !== ring && Math.abs(j - cj) !== ring) continue;
      const a = m.get(i + "," + j); if (!a) continue;
      for (const q of a) {
        const d = Math.hypot(q[0] - x, q[1] - y);
        if (d < best) best = d;
      }
    }
    // a hit inside the searched box is only final once the box clears it
    if (best <= ring * CELL || (best < Infinity && ring >= 23)) return best;
  }
  return Infinity;
};

// the app's own grazing camera: a near-field grid row covers a big slice of the
// frame here, which is exactly the regime where how the raster reconstructs a
// scalar between grid samples decides whether regions look smooth or faceted
const grazingS = () => ({
  ...baseS(),
  nx: 140, ny: 140, xMin: -22, xMax: 22, yMin: 3, yMax: 78,
  H: 0.4 * Math.pow(22.5, 0.83), zoom: 5, smooth: 3, waveScale: 0,
});

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

test("a curved region outline tracks its analytic contour in the near field", () => {
  // A circle on the water right under the camera, where one grid row projects
  // ~50 viewBox units tall. A quadratic contour cannot be represented by
  // interpolating the scalar linearly across a cell that big, so this measures
  // the reconstruction: Catmull-Rom lands worst-case ~1.2 units off the true
  // circle where linear interpolation is ~1.9. Everything here is deterministic
  // float math, so the margin is stable — a loosening means the raster stopped
  // reconstructing the field smoothly between grid samples.
  const S = grazingS();
  S._ems = [];                                  // flat plane: pure geometry
  const fit = computeFit(S);
  const cx = 0, cy = 6.2, r = 2.6;
  const scalarAt = (gx, gy) => -((gx - cx) ** 2 + (gy - cy) ** 2);
  const { layers } = buildSurface3D(S, fit, { scalarAt, thresholds: [-r * r], gN: 150, BW: 440 });
  const pts = pathPoints(layers[0]);

  let sum = 0, worst = 0, n = 0;
  for (let a = 0; a < 240; a++) {
    const th = (a / 240) * 2 * Math.PI;
    const [sx, sy] = penProject(cx + r * Math.cos(th), cy + r * Math.sin(th), 0, S, fit);
    const d = nearest(pts, sx, sy);
    sum += d; if (d > worst) worst = d; n++;
  }
  expect(sum / n).toBeLessThan(0.9);            // viewBox units, frame is 760×500
  expect(worst).toBeLessThan(1.6);
});

test("a striped panorama gives the same 3D boundary as the continuous field", () => {
  // A painted panorama has no scalar to contour: rank its colors and you are
  // contouring a step function of the panorama grid, which snaps every boundary
  // onto that grid. For a panorama striped by elevation the answer is known —
  // the stripe edge must land exactly where the continuous elevation field
  // crosses that row, the same curve the preset path would draw.
  const S = grazingS();
  S._ems = [];
  const fit = computeFit(S);
  const EW = 84, EH = 52, R = 30;
  const cells = new Array(EW * EH);
  for (let r = 0; r < EH; r++) for (let c = 0; c < EW; c++)
    cells[r * EW + c] = r < R ? "#101820" : "#e0e8f0";

  // stand-in for the reflected panorama coordinate: elevation only (so the
  // color boundary IS a level set), wavy enough to have sub-cell structure
  const vAt = (gx, gy) => {
    const v = ((gy - S.yMin) / (S.yMax - S.yMin)) * EH + 9 * Math.sin(gx * 0.3);
    return v < 0 ? 0 : v > EH ? EH : v;
  };
  const raster = { gN: 150, BW: 440 };
  const pano = buildSurface3DPanorama(S, fit, {
    uvAt: (gx, gy) => [EW / 2, vAt(gx, gy)], env2d: { w: EW, h: EH, cells }, ...raster,
  });
  const ref = buildSurface3D(S, fit, { scalarAt: vAt, thresholds: [R], ...raster });

  // layer 0 is the whole silhouette, layer 1 the upper stripe
  expect(pano.layers.length).toBe(2);
  expect(pano.layers[1].color).toBe("#e0e8f0");
  const got = pathPoints(pano.layers[1].d), want = pathPoints(ref.layers[0]);
  expect(want.length).toBeGreaterThan(40);
  let sum = 0;
  for (const [x, y] of want) sum += nearest(got, x, y);
  expect(sum / want.length).toBeLessThan(2);
});

test("with the waves flattened, the 3D panorama redraws the flat 2D render", () => {
  // The user-facing contract for the whole 3D path: turning the wave height
  // down to zero must give back the flat render's regions. Runs the real
  // scene — real emitters, a real banded panorama, the real reflection field —
  // through both builders and matches their layers up by color. (It guards the
  // structure, not the smoothness: a boundary made of straight facets still
  // sits close to the curve it should have been.)
  const S = { ...grazingS(), eLo: -5, eHi: 33, waveScale: 0, surface3d: false,
    k: (2 * Math.PI) / 2.8, amp: 0.78 * 0.06, sharp: 0.3, decay: 0.18 - 0.5 * 0.16 };
  const AZ = 45, EW = ENV2D_W, EH = 52;
  const env2d = envFromRows((f) => paletteColorAt("Black Water", f), EW, EH);
  const flat = buildSegmentation(S, env2d, AZ);   // also prepares S._ems
  const fit = computeFit(S);
  const uvAt = (gx, gy) => {
    const R = reflectAt(gx, gy, S);
    const phi = (Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180) / Math.PI;
    let psi = (Math.atan2(R[0], R[1]) * 180) / Math.PI;
    psi = psi < -AZ ? -AZ : psi > AZ ? AZ : psi;
    let v = magFrac((phi - S.eLo) / (S.eHi - S.eLo), 1); v = v < 0 ? 0 : v > 1 ? 1 : v;
    let u = magFrac((psi + AZ) / (2 * AZ), 1); u = u < 0 ? 0 : u > 1 ? 1 : u;
    return [u * EW, v * EH];
  };
  const pano = buildSurface3DPanorama(S, fit, { uvAt, env2d, gN: 150, BW: 440 });

  expect(flat.layers.length).toBeGreaterThan(4);
  expect(pano.layers.map((l) => l.color)).toEqual(flat.layers.map((l) => l.color));
  const byColor = new Map(pano.layers.map((l) => [l.color, bucketize(pathPoints(l.d))]));
  let sum = 0, n = 0;
  for (const l of flat.layers) {
    const got = byColor.get(l.color);
    const want = pathPoints(l.d);
    for (let i = 0; i < want.length; i += 8) {
      const [x, y] = want[i];
      if (x < 60 || x > 700 || y < 60 || y > 440) continue;   // skip the frame edges
      sum += nearestB(got, x, y); n++;
    }
  }
  expect(n).toBeGreaterThan(1000);
  expect(sum / n).toBeLessThan(4);
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

/* ------------------------------------------------------------------ *
 * Crest seams and render resolution
 * ------------------------------------------------------------------ */

test("raster levels step up from the long-standing defaults", () => {
  expect(RASTER_LEVELS[RASTER_DEFAULT]).toEqual({ name: "normal", BW: 440, gN: 150 });
  expect(RASTER_LEVELS[0]).toEqual({ name: "draft", BW: 320, gN: 110 });   // low-power pin
  for (let i = 1; i < RASTER_LEVELS.length; i++) {
    expect(RASTER_LEVELS[i].BW).toBeGreaterThan(RASTER_LEVELS[i - 1].BW);
    expect(RASTER_LEVELS[i].gN).toBeGreaterThan(RASTER_LEVELS[i - 1].gN);
  }
});

test("no crest field when nothing occludes anything", () => {
  const BW = 40, BH = 30, NP = BW * BH;
  const cov = new Uint8Array(NP).fill(1);
  expect(crestField(new Uint8Array(NP), cov, BW, BH, NP)).toBeNull();
});

test("a crest field crosses zero sub-pixel along a staircase edge", () => {
  // an occluding sheet whose raster boundary is a shallow staircase: one step
  // down every four pixels, exactly the pattern a near-horizontal crest makes
  const BW = 64, BH = 40, NP = BW * BH;
  const cov = new Uint8Array(NP).fill(1);
  const occ = new Uint8Array(NP);
  const edgeAt = (x) => 20 + Math.floor(x / 4);
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++)
    if (y >= edgeAt(x)) occ[y * BW + x] = 1;
  const cr = crestField(occ, cov, BW, BH, NP);
  expect(cr).not.toBeNull();

  // where the field crosses zero down each column, in sub-pixel rows
  const crossings = [];
  for (let x = 2; x < BW - 2; x++) {
    for (let y = 1; y < BH - 1; y++) {
      const a = cr[y * BW + x], b = cr[(y + 1) * BW + x];
      if (a && b && ((a < 0) !== (b < 0))) { crossings.push(y + a / (a - b)); break; }
    }
  }
  expect(crossings.length).toBeGreaterThan(40);
  // the staircase itself only ever crosses at whole pixels; a sub-pixel
  // estimate has to land off the integers most of the time
  const fracs = crossings.map((c) => Math.abs(c - Math.round(c)));
  const offGrid = fracs.filter((f) => f > 0.08).length;
  expect(offGrid / fracs.length).toBeGreaterThan(0.5);
  // and it has to stay monotone along the edge — a smoothed staircase, not noise
  for (let i = 1; i < crossings.length; i++)
    expect(crossings[i]).toBeGreaterThanOrEqual(crossings[i - 1] - 0.01);

  // away from the edge there is no band, so nothing gets snapped
  expect(cr[2 * BW + 30]).toBe(0);
  expect(cr[(BH - 3) * BW + 30]).toBe(0);
});

/* ------------------------------------------------------------------ *
 * Export detail: the same picture, traced on a wider raster
 *
 * An exported outline is a curve through one marching-squares crossing per
 * raster pixel, so the preview's raster is the finest — and smoothest — thing
 * the file can carry. Blown up (full screen, or printed) that pixel grid is
 * what reads as a stair along a distant crest. Retracing wider on the way out
 * is the fix, and it has to stay a retrace: the same regions in the same
 * places, only resolved finer.
 * ------------------------------------------------------------------ */

test("the export raster scales the width, holds the mesh, and caps", () => {
  const level = { name: "normal", BW: 440, gN: 150 };
  expect(exportRaster(level, 1)).toEqual({ BW: 440, gN: 150 });
  expect(exportRaster(level, 2)).toEqual({ BW: 880, gN: 150 });
  // the mesh deliberately does not follow: more surface rows per raster pixel
  // makes the far field noisier, not smoother
  for (const m of EXPORT_MULTS) expect(exportRaster(level, m).gN).toBe(level.gN);
  // and no multiplier can push past what a browser tab can allocate
  const top = RASTER_LEVELS[RASTER_LEVELS.length - 1];
  for (const m of EXPORT_MULTS) expect(exportRaster(top, m).BW).toBeLessThanOrEqual(EXPORT_MAX_BW);
  expect(exportRaster(top, 3).BW).toBe(EXPORT_MAX_BW);
});

test("a wider export raster redraws the preview's regions, resolved finer", () => {
  const S = { ...grazingS(), eLo: -5, eHi: 33, waveScale: 8, surface3d: true,
    k: (2 * Math.PI) / 2.8, amp: 0.78 * 0.06, sharp: 0.3, decay: 0.18 - 0.5 * 0.16 };
  const cols = ["#0b0f14", "#28405e", "#4f6294", "#8fa5cd"];
  const scalarAt = (gx, gy) =>
    (Math.asin(Math.max(-1, Math.min(1, reflectAt(gx, gy, S)[2]))) * 180) / Math.PI;
  const fieldSpec = { scalarAt, thresholds: [2, 10, 18], cols };
  const level = { name: "normal", BW: 440, gN: 150 };

  const preview = buildSolid3D(S, fieldSpec, exportRaster(level, 1));
  const wide = buildSolid3D(S, fieldSpec, exportRaster(level, 2));

  expect(preview.layers.map((l) => l.color)).toEqual(wide.layers.map((l) => l.color));
  for (let i = 0; i < preview.layers.length; i++) {
    const near = pathPoints(preview.layers[i].d), far = pathPoints(wide.layers[i].d);
    // finer raster, finer trace: more vertices along the same outlines
    expect(far.length).toBeGreaterThan(near.length);
    // …and they are the same outlines — every preview vertex has a wide-raster
    // vertex sitting on top of it
    const bucket = bucketize(far);
    let sum = 0, n = 0;
    for (let k = 0; k < near.length; k += 4) {
      const [x, y] = near[k];
      if (x < 40 || x > 720 || y < 40 || y > 460) continue;   // skip the frame edges
      sum += nearestB(bucket, x, y); n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(sum / n).toBeLessThan(3);
  }
});
