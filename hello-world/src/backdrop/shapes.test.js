import { shape, shapeAt, shapeBox, rasterizeShapes, STAMPS, SHAPE_KINDS } from "./shapes";
import { compileBackdrop } from "./compile";
import { backdropDoc, flat, shapesContent, rampContent, DOC_W, DOC_H } from "./document";

const W = 40, H = 40;
const keyPerPart = () => {
  const seen = new Map();
  return (item, role) => {
    const k = `${item.id}:${role}`;
    if (!seen.has(k)) seen.set(k, seen.size);
    return seen.get(k);
  };
};
const raster = (items) => rasterizeShapes(items, W, H, keyPerPart());
const at = (cells, fx, fy) =>
  cells[Math.floor(fy * H) * W + Math.floor(fx * W)];

describe("shapes are stated, not drawn", () => {
  test("a rect covers its box and nothing else", () => {
    const r = shape("rect", { x: 0.5, y: 0.25, w: 0.4, h: 0.3, color: "#ff0000" });
    expect(shapeAt(r, 0.5, 0.4)).toBe(1);
    expect(shapeAt(r, 0.5, 0.1)).toBe(0);       // below the base
    expect(shapeAt(r, 0.5, 0.6)).toBe(0);       // above the top
    expect(shapeAt(r, 0.1, 0.3)).toBe(0);       // outside the width
  });

  test("a shape stands on its y, it does not straddle it", () => {
    // everything in a backdrop stands on something, so y is the base
    const r = shape("rect", { x: 0.5, y: 0.3, w: 0.2, h: 0.4 });
    const b = shapeBox(r);
    expect(b.y0).toBeCloseTo(0.3, 6);
    expect(b.y1).toBeCloseTo(0.7, 6);
  });

  test("an ellipse is round, not square", () => {
    const e = shape("ellipse", { x: 0.5, y: 0.3, w: 0.4, h: 0.4 });
    expect(shapeAt(e, 0.5, 0.5)).toBe(1);       // center
    expect(shapeAt(e, 0.31, 0.31)).toBe(0);     // corner of the box
  });

  test("a polygon fills its own outline", () => {
    const p = shape("poly", { points: [[0.2, 0.1], [0.5, 0.6], [0.8, 0.1]] });
    expect(shapeAt(p, 0.5, 0.2)).toBe(1);
    expect(shapeAt(p, 0.25, 0.5)).toBe(0);
  });

  test("moving a shape moves what it covers", () => {
    const r = shape("rect", { x: 0.3, y: 0.3, w: 0.2, h: 0.2 });
    expect(shapeAt(r, 0.3, 0.35)).toBe(1);
    const moved = { ...r, x: 0.7 };
    expect(shapeAt(moved, 0.3, 0.35)).toBe(0);
    expect(shapeAt(moved, 0.7, 0.35)).toBe(1);
  });

  test("the same shape renders at any resolution", () => {
    const r = [shape("rect", { x: 0.5, y: 0.25, w: 0.4, h: 0.3, color: "#ff0000" })];
    const coarse = rasterizeShapes(r, 20, 20, keyPerPart()).cells;
    const fine = rasterizeShapes(r, 200, 200, keyPerPart()).cells;
    const covered = (cells, n) => cells.filter((c) => c != null).length / (n * n);
    expect(covered(fine, 200)).toBeCloseTo(covered(coarse, 20), 1);
  });

  test("every stamp in the catalogue draws something", () => {
    for (const type of Object.keys(STAMPS)) {
      const it = shape(type, { x: 0.5, y: 0.2, w: 0.3, h: 0.4 });
      const { cells } = raster([it]);
      expect(cells.some((c) => c != null)).toBe(true);
    }
    expect(SHAPE_KINDS).toEqual(expect.arrayContaining(["rect", "ellipse", "poly", "sailboat"]));
  });

  test("a stamp's accent is its own colour", () => {
    const it = shape("sailboat", { x: 0.5, y: 0.1, w: 0.5, h: 0.6,
      color: "#111111", color2: "#eeeeee" });
    const { cells } = raster([it]);
    expect(cells).toContain("#111111");         // hull
    expect(cells).toContain("#eeeeee");         // sails
  });

  test("an ink rim rings the shape without eating it", () => {
    const it = shape("rect", { x: 0.5, y: 0.4, w: 0.3, h: 0.3,
      color: "#ffffff", rim: 1, rimColor: "#000000" });
    const { cells } = raster([it]);
    expect(at(cells, 0.5, 0.5)).toBe("#ffffff");            // the body survives
    expect(cells.filter((c) => c === "#000000").length).toBeGreaterThan(0);
  });

  test("later shapes cover earlier ones", () => {
    const a = shape("rect", { x: 0.5, y: 0.3, w: 0.6, h: 0.3, color: "#111111" });
    const b = shape("rect", { x: 0.5, y: 0.3, w: 0.2, h: 0.3, color: "#222222" });
    const { cells } = raster([a, b]);
    expect(at(cells, 0.5, 0.4)).toBe("#222222");
    expect(at(cells, 0.25, 0.4)).toBe("#111111");
  });

  test("a hidden shape draws nothing", () => {
    const it = shape("rect", { x: 0.5, y: 0.3, w: 0.4, h: 0.3, hidden: true });
    expect(raster([it]).cells.every((c) => c == null)).toBe(true);
  });
});

describe("shapes as regions", () => {
  const twoTrees = () => backdropDoc([
    flat(rampContent("Treeline"), "Sky"),
    flat(shapesContent([
      shape("rect", { x: 0.25, y: 0.1, w: 0.15, h: 0.3, color: "#ff00ff" }),
      shape("rect", { x: 0.75, y: 0.1, w: 0.15, h: 0.3, color: "#ff00ff" }),
    ]), "Shapes"),
  ], DOC_W, DOC_H);

  test("two shapes of one colour are two regions", () => {
    // the old model keyed a region on its hex, which is why an object's colour
    // had to be nudged a few bits to stop instances fusing
    const b = compileBackdrop(twoTrees());
    const greens = [];
    for (let k = 0; k < b.count; k++) if (b.colorAt(k) === "#ff00ff") greens.push(k);
    expect(greens.length).toBe(2);
  });

  test("a ramp keeps its own region count on the finer grid", () => {
    // rendering a smooth palette at 4x would subdivide it into four times as
    // many colours and spend the whole region budget on the sky
    const plain = compileBackdrop(backdropDoc([flat(rampContent("Treeline"), "Sky")], DOC_W, DOC_H));
    const withShapes = compileBackdrop(twoTrees());
    expect(withShapes.count).toBe(plain.count + 2);
    expect(withShapes.overflow).toBe(false);
  });

  test("a shape document compiles onto a finer grid than it is edited on", () => {
    const b = compileBackdrop(twoTrees());
    expect(b.scale).toBeGreaterThan(1);
    expect(b.EW).toBe(DOC_W * b.scale);
    expect(b.EH).toBe(DOC_H * b.scale);
  });

  test("a document without shapes compiles at its own resolution", () => {
    const b = compileBackdrop(backdropDoc([flat(rampContent("Treeline"), "Sky")], DOC_W, DOC_H));
    expect(b.scale).toBe(1);
    expect(b.EW).toBe(DOC_W);
  });

  test("shapes keep the order they were added in, layers keep theirs", () => {
    const b = compileBackdrop(twoTrees());
    // the ramp is the lower layer, so all of its regions come first
    const rampRegions = [];
    for (let k = 0; k < b.count; k++) if (b.colorAt(k) !== "#ff00ff") rampRegions.push(k);
    const shapeRegions = [];
    for (let k = 0; k < b.count; k++) if (b.colorAt(k) === "#ff00ff") shapeRegions.push(k);
    expect(Math.max(...rampRegions)).toBeLessThan(Math.min(...shapeRegions));
  });
});
