import {
  buildPaperImage, buildPaperStack, buildPaperStackSvg, buildSurface3D, computeFit,
  DEFAULT_EMITTERS, PAPER_MAX_COLORS,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * Layered-paper export: the sheets have to be cut from the picture the SVG
 * export draws, not from the water plane underneath it.
 *
 * The stack used to be planned on the ground grid, which quietly cost it
 * three things the normal export has: colors were read on the flat plane (so
 * the sheets ignored the 3D relief), every layer was lifted and projected on
 * its own (so water hidden behind a crest was still cut — as a hole
 * overlapping the crest in front of it), and the whole plane was planned and
 * emitted even with the camera zoomed into a corner of it. Planning on the
 * visible-surface raster fixes all three at once; a test each.
 * ------------------------------------------------------------------ */

const VB_W = 760, VB_H = 500;

// the app's own scene: a steep camera close to the water, waves exaggerated
const baseS = (over) => ({
  nx: 140, ny: 140,
  xMin: -22, xMax: 22, yMin: 3, yMax: 78,
  H: 9,                                    // steep = 1 in the UI
  pitch: (12.6 * Math.PI) / 180,
  omega: 1, t: 0,
  perspective: true, eLo: -5, eHi: 33,
  zoom: 2, panX: 0, panY: 0, smooth: 3, coherence: 0, rectOutput: false,
  surface3d: true, waveScale: 8,
  bandFractions: null, fresOn: false, fresBands: 3, reflMag: 1,
  emitters: DEFAULT_EMITTERS,
  ...over,
});

// a swell travelling into the scene; at this wave height the surface genuinely
// folds in screen space, so near crests hide the water behind them
const withSwell = (S) => {
  S._ems = [{ type: "swell", k0: (2 * Math.PI) / 8, Dx: 0, Dy: 1, ph0: 0, q: 0, aa: 0, A: 1 }];
  return S;
};

const RASTER = { gN: 150, BW: 440 };
const greys = (n) => Array.from({ length: n }, (_, i) =>
  "#" + (16 + i * 13).toString(16).padStart(2, "0").repeat(3));

const pathPoints = (d) => {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
};

// bucketed nearest-point lookup — thousands of queries against thousands of
// candidates (same helper the 3D surface tests use)
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
    if (best <= ring * CELL || (best < Infinity && ring >= 23)) return best;
  }
  return Infinity;
};

// band index per pixel: -1 off the water (the mount sheet), else palette slot
const bandField = (img, cols) => {
  const rank = new Map(cols.map((c, i) => [c, i]));
  const out = new Int32Array(img.W * img.H);
  for (let p = 0; p < out.length; p++) {
    const b = rank.get(img.palette[img.grid[p]]);
    out[p] = b === undefined ? -1 : b;
  }
  return out;
};

test("sheet colors are read off the 3D surface the normal export contours", () => {
  // One scene, one field, two consumers: buildSurface3D contours a band
  // boundary at a time, buildPaperImage resolves every pixel to its color.
  // Where the image's bands meet has to be where the export draws its edge —
  // which only holds if the image is sampled on the lifted, occluded surface
  // rather than on the flat plane below it.
  const S = withSwell(baseS());
  const fit = computeFit(S);
  const scalarAt = (gx, gy) => gx + 3 * Math.sin(gy * 0.4);
  const thresholds = [-10, -3, 4, 11];
  const cols = greys(thresholds.length + 1);
  const img = buildPaperImage(S, fit, {
    ...RASTER, lift: true, bgColor: "#ffffff", scalarAt, thresholds, cols,
  });
  const ref = buildSurface3D(S, fit, { ...RASTER, scalarAt, thresholds });
  expect(ref.layers.length).toBe(thresholds.length);

  const band = bandField(img, cols);
  const { W, H } = img;
  const kx = VB_W / W, ky = VB_H / H;
  const layerPts = ref.layers.map((d) => bucketize(pathPoints(d)));

  let sum = 0, n = 0, far = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x, b = band[p];
    if (b < 0) continue;
    for (const q of [p + 1, p + W]) {
      if (band[q] <= b) continue;              // interior rising edges only
      // the step from band b upward is the contour of {scalar >= thresholds[b]}
      const d = nearestB(layerPts[b], x * kx, y * ky);
      sum += d; n++; if (d > 6) far++;
    }
  }
  expect(n).toBeGreaterThan(500);
  expect(sum / n).toBeLessThan(2.5);           // viewBox units; the frame is 760×500
  expect(far / n).toBeLessThan(0.02);
});

test("water hidden behind a crest never reaches the sheets", () => {
  // The scalar is distance, so a band index reads off how far away the visible
  // surface is. On a plane every distance band shows up somewhere and the
  // index walks up the frame one band at a time. On a folded surface most
  // bands are behind a crest and never appear at all, and where a crest cuts
  // across the water the index JUMPS — metres of water are simply missing,
  // because they are hidden. The old export lifted each band's contour on its
  // own, so those hidden bands came out as holes overlapping the crest in
  // front of them; here they are absent from the picture the sheets are cut
  // from, which is the only way a stack of opaque paper could reproduce it.
  const thresholds = [], cols = ["#000000"];
  for (let t = 4; t < 78; t += 1) { thresholds.push(t); cols.push("#" + (t * 3).toString(16).padStart(6, "0")); }
  const shoot = (lift) => {
    const S = withSwell(baseS());
    const img = buildPaperImage(S, computeFit(S), {
      // no posterizing: these 74 bands are a distance ruler, not a palette
      ...RASTER, lift, bgColor: "#ffffff", maxColors: 0,
      scalarAt: (gx, gy) => gy, thresholds, cols,
    });
    const band = bandField(img, cols), { W, H } = img;
    const present = new Set();
    let steps = 0, skipped = 0;
    for (let p = 0; p < band.length; p++) if (band[p] >= 0) present.add(band[p]);
    // near half of the frame only: in the far field one pixel legitimately
    // spans many bands, plane or no plane
    for (let y = Math.floor(H * 0.45); y < H; y++) for (let x = 0; x < W; x++) {
      const a = band[y * W + x], b = band[(y - 1) * W + x];
      if (a < 0 || b < 0 || b === a) continue;
      steps++;
      if (b - a >= 2) skipped++;
    }
    return { present: present.size, steps, skipped };
  };

  const flat = shoot(false), lifted = shoot(true);
  expect(flat.present).toBeGreaterThan(35);    // a plane hides nothing…
  expect(flat.steps).toBeGreaterThan(500);
  expect(flat.skipped).toBe(0);                // …and never skips a band
  expect(lifted.present).toBeLessThan(25);     // most of the water is behind a crest
  expect(lifted.skipped).toBeGreaterThan(200);
});

test("zooming in exports only what is in frame", () => {
  // The sheets are planned on the frame raster, so water the camera has left
  // behind is never labeled, never planned into a sheet, and never emitted.
  // The old ground-grid pipeline planned the whole plane and leaned on a
  // clip-path in the tiled SVG to hide the overspill.
  const thresholds = [10, 18, 26, 34, 42];
  const cols = greys(thresholds.length + 1);
  const shoot = (zoom) => {
    const S = baseS({ zoom, waveScale: 0, surface3d: false });
    S._ems = [];                                // flat plane: pure framing
    const img = buildPaperImage(S, computeFit(S), {
      gN: 120, BW: 320, lift: false, bgColor: "#ffffff",
      scalarAt: (gx, gy) => gy, thresholds, cols,
    });
    return buildPaperStack(img, "#ffffff", { iters: 3 });
  };

  const wide = shoot(1), tight = shoot(6);
  const colorsOf = (st) => new Set(st.sheets.map((s) => s.color));
  expect(colorsOf(wide).size).toBeGreaterThan(colorsOf(tight).size);
  for (const c of colorsOf(tight)) expect(colorsOf(wide).has(c)).toBe(true);

  // …and nothing is drawn outside the frame it was cropped to
  for (const sh of tight.sheets) {
    for (const [x, y] of pathPoints(sh.d)) {
      expect(x).toBeGreaterThan(-12);
      expect(x).toBeLessThan(VB_W + 12);
      expect(y).toBeGreaterThan(-12);
      expect(y).toBeLessThan(VB_H + 12);
    }
  }
  // it is still a stack: holes shrink down to a solid backing…
  expect(tight.sheets[tight.sheets.length - 1].solid).toBe(true);
  expect(tight.nSheets).toBe(tight.sheets.length);
  // …the wide shot keeps its mount, and the tight one — zoomed in past the
  // shore, with no background left in frame — is not asked to cut a sheet away
  // to nothing
  expect(wide.sheets[0].frame).toBe(true);
  expect(tight.sheets.some((s) => s.frame)).toBe(false);
});

test("a gradient is posterized to a buyable number of papers", () => {
  // A preset palette becomes a smooth ramp the moment anything forces the
  // panorama path, and every shade of it costs at least one sheet. The stack
  // has to be cut from paper you can buy, so the picture is posterized first —
  // keeping the mount's color, which the frame sheet is drawn in whatever
  // happens (lose it and the water edge gets cut a second time).
  const S = withSwell(baseS());
  const fit = computeFit(S);
  const ramp = 48;
  const cols = Array.from({ length: ramp }, (_, i) =>
    "#" + Math.round(20 + (i * 220) / ramp).toString(16).padStart(2, "0").repeat(3));
  const thresholds = Array.from({ length: ramp - 1 }, (_, i) => -6 + (i * 24) / ramp);
  const shoot = (maxColors) => buildPaperImage(S, fit, {
    ...RASTER, lift: true, bgColor: "#ff2d78", maxColors,
    scalarAt: (gx, gy) => gx + 3 * Math.sin(gy * 0.4), thresholds, cols,
  });
  const used = (img) => new Set(Array.from(img.grid, (id) => img.palette[id]));

  const raw = used(shoot(0));
  const cut = used(shoot(PAPER_MAX_COLORS));
  expect(raw.size).toBeGreaterThan(PAPER_MAX_COLORS);
  expect(cut.size).toBeLessThanOrEqual(PAPER_MAX_COLORS);
  expect(cut.has("#ff2d78")).toBe(true);         // the mount keeps its color
  for (const c of cut) expect(raw.has(c)).toBe(true);   // real colors, not means

  // and that is what keeps the stack buildable
  const sheets = (img) => buildPaperStack(img, "#ff2d78", { iters: 3 }).nSheets;
  expect(sheets(shoot(PAPER_MAX_COLORS))).toBeLessThan(sheets(shoot(0)));
});

test("the tiled sheet SVG is one clipped tile per sheet, and nothing else", () => {
  // The tiles used to clip each hole to the flat water trapezoid as well, to
  // contain a 5% overshoot the grid pipeline needed. On a 3D surface that clip
  // shears off every crest standing above the water plane — and the holes now
  // come out of the frame raster, already bounded by the visible silhouette,
  // so the only clip left is the one that keeps a rolled picture inside its
  // own tile.
  const thresholds = [12, 20, 28];
  const cols = greys(thresholds.length + 1);
  const S = withSwell(baseS());
  const img = buildPaperImage(S, computeFit(S), {
    ...RASTER, lift: true, bgColor: "#ffffff",
    scalarAt: (gx, gy) => gy, thresholds, cols,
  });
  const stack = buildPaperStack(img, "#ffffff", { iters: 3 });
  const svg = buildPaperStackSvg(stack, "rotate(6 380 250)");

  expect((svg.match(/<clipPath/g) || []).length).toBe(stack.nSheets);
  expect(svg).not.toContain("NaN");
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.endsWith("</svg>")).toBe(true);
  // every sheet is listed, in stack order, with its paper color on the label
  for (const sh of stack.sheets) expect(svg).toContain(sh.color);
});

test("a crest gap is cut through the sheets, the hole the SVG paints", () => {
  // The stack is meant to be the picture the SVG export draws, so a crest gap
  // has to arrive here too — as the mount showing through, which is exactly
  // what the SVG's background-colored band is.
  const S = withSwell(baseS());
  const fit = computeFit(S);
  const scalarAt = (gx, gy) => gx + 3 * Math.sin(gy * 0.4);
  const opts = { ...RASTER, lift: true, bgColor: "#ffffff", scalarAt,
    thresholds: [-10, -3, 4, 11], cols: greys(5) };
  const count = (img, color) => {
    const id = img.palette.indexOf(color);
    let n = 0;
    for (const v of img.grid) if (v === id) n++;
    return n;
  };
  const plain = buildPaperImage(S, fit, opts);
  const gapped = buildPaperImage(S, fit, { ...opts, gap: 4 });

  expect(count(gapped, "#ffffff")).toBeGreaterThan(count(plain, "#ffffff"));
  expect(gapped.palette).toEqual(plain.palette);   // holes only: no new sheet

  // …unless the gap is given a color of its own, which is then its own sheet
  const tinted = buildPaperImage(S, fit, { ...opts, gap: 4, gapColor: "#ff2d78" });
  expect(tinted.palette).toContain("#ff2d78");
  expect(count(tinted, "#ff2d78")).toBeGreaterThan(0);
});
