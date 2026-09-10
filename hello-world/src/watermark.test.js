import {
  buildSolid3D, buildMark, buildPaperImage, computeFit, penProject, prepField,
  RASTER_LEVELS,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";
import { demoMark } from "./textMarkFixture";

/* ------------------------------------------------------------------ *
 * The watermark on the water
 *
 * Text laid on the surface, not reflected in it. Three things have to hold or
 * it is not on the surface at all:
 *
 *   * it lands where it was put, through the same camera as the water;
 *   * it rides the wave geometry, so lifting the surface moves it;
 *   * it takes part in the picture rather than sitting on top of it — cut to
 *     the water's own outline, occluded by the crests in front of it, and
 *     costing the water itself nothing when it is off.
 *
 * The letters are bars from textMarkFixture: real type needs a canvas and a
 * font, and neither is a fact about this renderer.
 * ------------------------------------------------------------------ */

const L = RASTER_LEVELS[0];
const RASTER = { gN: L.gN, BW: L.BW };

const scene = (mark) => {
  const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
  S.mark = mark || null;
  return { S, fieldSpec };
};

const points = (d) => {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};
const bbox = (d) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of points(d)) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
};
const area = (d) => {
  const b = bbox(d);
  return (b.x1 - b.x0) * (b.y1 - b.y0);
};

test("no watermark, no path — and the water is untouched by the option existing", () => {
  const bare = scene(null);
  const plain = buildSolid3D(bare.S, bare.fieldSpec, RASTER);
  expect(plain.mark).toBe(null);

  const { S, fieldSpec } = scene(demoMark());
  const marked = buildSolid3D(S, fieldSpec, RASTER);
  expect(marked.mark).not.toBe(null);
  // the mark is drawn over the picture, never cut into it: every band comes
  // out exactly as it did with no watermark in the scene
  expect(marked.layers.length).toBe(plain.layers.length);
  expect(marked.layers.map((l) => l.d)).toEqual(plain.layers.map((l) => l.d));
}, 120000);

test("it lands where it was put, through the same camera as the water", () => {
  const mark = demoMark({ x: 0, y: 20, size: 6, halo: 0 });
  const { S, fieldSpec } = scene(mark);
  const { mark: layers } = buildSolid3D(S, fieldSpec, RASTER);
  expect(layers.length).toBe(1);                 // ink only, no halo asked for
  expect(layers[0].color).toBe(mark.color);

  const fit = computeFit(S);
  prepField(S);
  const [cx, cy] = penProject(mark.x, mark.y, 0, S, fit);
  const b = bbox(layers[0].d);
  // the bars straddle the point the mark was placed at. Loose bounds on
  // purpose: the surface it is lying on is a wave, so the ink moves with it.
  expect(b.x0).toBeLessThan(cx);
  expect(b.x1).toBeGreaterThan(cx);
  expect(Math.abs((b.y0 + b.y1) / 2 - cy)).toBeLessThan(90);
}, 120000);

test("moving it moves the ink, and turning it moves it differently", () => {
  const { S, fieldSpec } = scene(demoMark({ halo: 0 }));
  const at = (patch) =>
    buildSolid3D({ ...S, mark: { ...S.mark, ...patch } }, fieldSpec, RASTER).mark[0].d;
  // a small step: this scene is zoomed 22.8x, so the window onto the water is
  // a few units across and a big move would simply carry the mark out of frame
  const here = at({});
  const right = at({ x: 1 });
  const turned = at({ angle: 25 });
  expect(right).not.toBe(here);
  expect(turned).not.toBe(here);
  expect(bbox(right).x0).toBeGreaterThan(bbox(here).x0);
}, 180000);

test("the halo is the same field cut a little wider, and it goes underneath", () => {
  const { S, fieldSpec } = scene(demoMark({ halo: 0.5 }));
  const layers = buildSolid3D(S, fieldSpec, RASTER).mark;
  expect(layers.length).toBe(2);
  expect(layers[0].color).toBe(S.mark.haloColor);   // drawn first: under the ink
  expect(layers[1].color).toBe(S.mark.color);
  // the outline contains the letters, so its box is the wider of the two
  const h = bbox(layers[0].d), k = bbox(layers[1].d);
  expect(h.x0).toBeLessThanOrEqual(k.x0 + 0.01);
  expect(h.x1).toBeGreaterThanOrEqual(k.x1 - 0.01);
  expect(area(layers[0].d)).toBeGreaterThan(area(layers[1].d));
}, 120000);

test("it rides the surface: lifting the waves moves the letters", () => {
  // the same mark, the same camera, the same instant — only whether the
  // surface it is lying on is a plane or a wave
  const { S } = scene(demoMark({ halo: 0 }));
  const flat = buildMark({ ...S, surface3d: false }, RASTER);
  const rode = buildMark({ ...S, surface3d: true }, RASTER);
  expect(flat).not.toBe(null);
  expect(rode).not.toBe(null);
  expect(rode[0].d).not.toBe(flat[0].d);
  // and it is the same text in the same place, not some other picture: the
  // two boxes overlap
  const a = bbox(flat[0].d), b = bbox(rode[0].d);
  expect(b.x1).toBeGreaterThan(a.x0);
  expect(b.x0).toBeLessThan(a.x1);
}, 180000);

test("it is cut to the water, never drawn past the frame", () => {
  // a mark far wider than the plane: the parts with no water under them have
  // nowhere to be, and the silhouette is what says so
  const wide = demoMark({ size: 60, x: 0, y: 20, halo: 0 });
  const { S, fieldSpec } = scene(wide);
  const layers = buildSolid3D(S, fieldSpec, RASTER).mark;
  if (!layers) return;                            // nothing visible is also correct
  for (const [x, y] of points(layers[0].d)) {
    expect(x).toBeGreaterThan(-40);
    expect(x).toBeLessThan(800);
    expect(y).toBeGreaterThan(-40);
    expect(y).toBeLessThan(540);
  }
}, 120000);

test("the flat modes get one too, on a raster of their own", () => {
  const { S } = scene(demoMark({ halo: 0.3 }));
  const layers = buildMark({ ...S, surface3d: false }, RASTER);
  expect(layers.length).toBe(2);
  expect(layers.every((l) => l.d && l.d.includes("Z"))).toBe(true);
  expect(buildMark({ ...S, mark: null }, RASTER)).toBe(null);
  // an item with no mask is a text shape nobody could set: it draws nothing
  // rather than drawing a box where the words would have been
  expect(buildMark({ ...S, mark: { ...S.mark, mask: null } }, RASTER)).toBe(null);
}, 180000);

test("on paper the watermark is a sheet, cut with everything else", () => {
  const { S, fieldSpec } = scene(demoMark({ halo: 0.4 }));
  const fit = computeFit(S);
  prepField(S);
  const opts = { gN: RASTER.gN, BW: 300, lift: true, bgColor: "#101010",
                 maxColors: 0, ...fieldSpec };
  const marked = buildPaperImage(S, fit, opts);
  const plain = buildPaperImage({ ...S, mark: null }, fit, opts);
  expect(marked.palette).toContain(S.mark.color);
  expect(marked.palette).toContain(S.mark.haloColor);
  expect(plain.palette).not.toContain(S.mark.color);
  // the ink covers real area, so the two images differ in more than a pixel
  let differ = 0;
  for (let p = 0; p < marked.grid.length; p++) {
    if (marked.palette[marked.grid[p]] !== plain.palette[plain.grid[p]]) differ++;
  }
  expect(differ).toBeGreaterThan(50);
}, 180000);

test("a mask with no ink in reach draws nothing rather than a stray curve", () => {
  // placed far behind the camera, off the plane entirely
  const { S, fieldSpec } = scene(demoMark({ y: -400, size: 1, halo: 0 }));
  expect(buildSolid3D(S, fieldSpec, RASTER).mark).toBe(null);
}, 120000);
