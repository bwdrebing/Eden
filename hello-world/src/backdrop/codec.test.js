import { encodeDoc, decodeDoc, encodeCells, decodeCells, MAX_DOC_LEN } from "./codec";
import {
  backdropDoc, flat, rampContent, stripesContent, rasterContent, emptyRaster,
  renderContent, envFromRows, DOC_W, DOC_H,
} from "./document";
import { shape, shapesContent } from "./shapes";

const sameDoc = (a, b) => {
  expect(b.flats.length).toBe(a.flats.length);
  a.flats.forEach((f, i) => {
    expect(b.flats[i].name).toBe(f.name);
    expect(b.flats[i].visible).toBe(f.visible);
    expect(renderContent(b.flats[i].content, b.w, b.h))
      .toEqual(renderContent(f.content, a.w, a.h));
  });
};

describe("cells", () => {
  test("round-trips painted cells, transparency included", () => {
    const cells = new Array(20 * 8).fill(null);
    cells[0] = "#9cc3e8"; cells[1] = "#9cc3e8"; cells[45] = "#ffffff";
    const back = decodeCells(encodeCells(20, 8, cells));
    expect(back.cells).toEqual(cells);
  });

  test("a wholly transparent layer is a handful of characters", () => {
    const code = encodeCells(DOC_W, DOC_H, new Array(DOC_W * DOC_H).fill(null));
    expect(code.length).toBeLessThan(20);
    expect(decodeCells(code).cells.every((c) => c === null)).toBe(true);
  });

  test("declines a layer with more colours than the palette holds", () => {
    const cells = Array.from({ length: 40 * 40 }, (_, p) =>
      "#" + (p % 80 + 0x100000).toString(16).slice(0, 6));
    expect(encodeCells(40, 40, cells)).toBeNull();
  });

  test("rejects junk instead of throwing", () => {
    for (const bad of ["", "x", "2.2.aabbcc", "2.2.aabbcc.9*0", "2.2.zz.4*0", null, 7]) {
      expect(decodeCells(bad)).toBeNull();
    }
  });
});

describe("documents", () => {
  const layered = () => backdropDoc([
    flat(rampContent("Treeline"), "Sky"),
    flat(stripesContent([{ color: "#9cc3e8", size: 2 }, { color: "#ffffff", size: 1 }], true, 3),
      "Repeat"),
    { ...flat(emptyRaster(DOC_W, DOC_H), "Painted"), visible: false },
  ], DOC_W, DOC_H);

  test("round-trips a layered document", () => {
    const d = layered();
    const back = decodeDoc(encodeDoc(d));
    expect(back.w).toBe(d.w);
    expect(back.h).toBe(d.h);
    sameDoc(d, back);
  });

  test("keeps the repeater's own settings, not just its pixels", () => {
    const d = layered();
    const back = decodeDoc(encodeDoc(d));
    const s = back.flats[1].content;
    expect(s.kind).toBe("stripes");
    expect(s.repeat).toBe(true);
    expect(s.anchor).toBe(3);
    expect(s.bands).toEqual([{ color: "#9cc3e8", size: 2 }, { color: "#ffffff", size: 1 }]);
  });

  test("generated layers cost almost nothing to carry", () => {
    // the whole point of a rule over a painting: a repeat is its band list
    const code = encodeDoc(backdropDoc([
      flat(rampContent("Treeline"), "Sky"),
      flat(stripesContent([{ color: "#9cc3e8", size: 2 }, { color: "#ffffff", size: 1 }]), "R"),
    ], DOC_W, DOC_H));
    expect(code.length).toBeLessThan(200);
  });

  test("a painted layer still fits", () => {
    const d = backdropDoc([flat(rasterContent(
      envFromRows((f) => (f < 0.5 ? "#141d33" : "#cfe1ef"), DOC_W, DOC_H)), "P")], DOC_W, DOC_H);
    const code = encodeDoc(d);
    expect(code.length).toBeLessThan(MAX_DOC_LEN);
    sameDoc(d, decodeDoc(code));
  });

  test("declines a document it cannot carry rather than writing a huge link", () => {
    const cells = Array.from({ length: DOC_W * DOC_H }, (_, p) =>
      "#" + (p % 500 + 0x100000).toString(16).slice(0, 6));
    const d = backdropDoc([flat({ kind: "raster", w: DOC_W, h: DOC_H, cells }, "P")], DOC_W, DOC_H);
    expect(encodeDoc(d)).toBeNull();
  });

  test("rejects junk instead of throwing", () => {
    for (const bad of ["", "{", "{}", '{"f":[]}', '{"f":[{"k":"?"}]}',
      '{"f":[{"k":"p","c":"nope"}]}', null, 3]) {
      expect(decodeDoc(bad)).toBeNull();
    }
  });

  test("every decoded layer gets its own id", () => {
    const back = decodeDoc(encodeDoc(layered()));
    expect(new Set(back.flats.map((f) => f.id)).size).toBe(back.flats.length);
  });
});

describe("shape layers", () => {
  test("round-trips shapes as statements, not pixels", () => {
    const items = [
      shape("rect", { x: 0.25, y: 0.1, w: 0.3, h: 0.4, color: "#141d33" }),
      shape("tree", { x: 0.7, y: 0.2, w: 0.12, h: 0.3, color: "#0a130d",
        color2: "#2c5736", rim: 1 }),
      shape("poly", { points: [[0.1, 0.1], [0.3, 0.4], [0.5, 0.1]], color: "#3f5f93" }),
    ];
    const d = backdropDoc([flat(shapesContent(items), "Shapes")], DOC_W, DOC_H);
    const back = decodeDoc(encodeDoc(d));
    const got = back.flats[0].content.items;
    expect(got.map((i) => i.type)).toEqual(["rect", "tree", "poly"]);
    expect(got[0].x).toBeCloseTo(0.25, 4);
    expect(got[0].w).toBeCloseTo(0.3, 4);
    expect(got[1].color2).toBe("#2c5736");
    expect(got[1].rim).toBe(1);
    expect(got[2].points).toEqual([[0.1, 0.1], [0.3, 0.4], [0.5, 0.1]]);
  });

  test("a shape layer is a handful of bytes whatever it draws", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      shape("tree", { x: 0.1 * i, y: 0.1, w: 0.1, h: 0.3 }));
    const code = encodeDoc(backdropDoc([flat(shapesContent(items), "Trees")], DOC_W, DOC_H));
    expect(code.length).toBeLessThan(900);
  });

  test("drops shapes of a type it does not know", () => {
    const code = JSON.stringify({ v: 2, w: DOC_W, h: DOC_H, f: [
      { n: "S", v: 1, k: "h", i: [{ t: "wormhole", b: [0, 0, 1, 1], c: "141d33", d: "", m: 0 }] },
    ] });
    expect(decodeDoc(code).flats[0].content.items).toEqual([]);
  });
});
