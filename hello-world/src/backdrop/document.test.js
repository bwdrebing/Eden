import {
  backdropDoc, flat, rampContent, stripesContent, rasterContent, emptyRaster,
  renderContent, flattenDoc, updateFlat, addFlat, duplicateFlat, removeFlat,
  moveFlat, bakeFlat, paintFlat, flatIndex, stripesPeriod, kindLabel,
  docFromPalette, docFromPanorama, envFromRows, smoothEnv2D, DOC_W, DOC_H,
} from "./document";

const W = 8, H = 12;
const doc1 = (...flats) => backdropDoc(flats, W, H);
const rows = (cells) => Array.from({ length: H }, (_, r) => cells[r * W]);

describe("the repeater", () => {
  const two1 = stripesContent([{ color: "#0000ff", size: 2 }, { color: "#ffffff", size: 1 }]);

  test("two blue rows, one white row, all the way up", () => {
    expect(rows(renderContent(two1, W, H))).toEqual([
      "#0000ff", "#0000ff", "#ffffff",
      "#0000ff", "#0000ff", "#ffffff",
      "#0000ff", "#0000ff", "#ffffff",
      "#0000ff", "#0000ff", "#ffffff",
    ]);
  });

  test("a band fills its whole width", () => {
    const cells = renderContent(two1, W, H);
    for (let c = 0; c < W; c++) expect(cells[c]).toBe("#0000ff");
  });

  test("the period is the sum of the band sizes", () => {
    expect(stripesPeriod(two1)).toBe(3);
    expect(stripesPeriod(stripesContent([{ color: "#111111", size: 5 }]))).toBe(5);
  });

  test("the anchor slides the pattern without changing it", () => {
    const shifted = { ...two1, anchor: 1 };
    expect(rows(renderContent(shifted, W, H)).slice(0, 3))
      .toEqual(["#ffffff", "#0000ff", "#0000ff"]);
  });

  test("the anchor tiles downward too, not just up", () => {
    const shifted = { ...two1, anchor: 7 };
    expect(rows(renderContent(shifted, W, H)).every((c) => c)).toBe(true);
  });

  test("with repeat off the list runs once and the rest shows through", () => {
    const once = stripesContent([{ color: "#0000ff", size: 2 }], false, 3);
    const r = rows(renderContent(once, W, H));
    expect(r[2]).toBeNull();
    expect(r[3]).toBe("#0000ff");
    expect(r[4]).toBe("#0000ff");
    expect(r[5]).toBeNull();
  });

  test("a zero-size band still occupies a row rather than looping forever", () => {
    const odd = stripesContent([{ color: "#0000ff", size: 0 }, { color: "#ffffff", size: 0 }]);
    expect(stripesPeriod(odd)).toBe(2);
    expect(renderContent(odd, W, H)[0]).toBe("#0000ff");
  });
});

describe("layers", () => {
  const base = () => doc1(
    flat(rampContent("Treeline"), "Sky"),
    flat(stripesContent([{ color: "#ffffff", size: 1 }], false, 4), "Line"));

  test("a transparent layer lets the one behind through", () => {
    const cells = flattenDoc(base()).cells;
    expect(cells[4 * W]).toBe("#ffffff");
    expect(cells[0]).not.toBe("#ffffff");
  });

  test("hiding a layer takes it out of the picture", () => {
    const d = base();
    const ramp = renderContent(d.flats[0].content, W, H);
    expect(flattenDoc(d).cells[4 * W]).toBe("#ffffff");
    const hidden = updateFlat(d, d.flats[1].id, { visible: false });
    expect(flattenDoc(hidden).cells[4 * W]).toBe(ramp[4 * W]);   // the ramp, uncovered
  });

  test("order decides who covers whom", () => {
    const d = doc1(
      flat(rasterContent(envFromRows(() => "#111111", W, H)), "a"),
      flat(rasterContent(envFromRows(() => "#222222", W, H)), "b"));
    expect(flattenDoc(d).cells[0]).toBe("#222222");
    expect(flattenDoc(moveFlat(d, d.flats[1].id, -1)).cells[0]).toBe("#111111");
  });

  test("moving past either end is a no-op", () => {
    const d = base();
    expect(moveFlat(d, d.flats[0].id, -1)).toBe(d);
    expect(moveFlat(d, d.flats[1].id, 1)).toBe(d);
  });

  test("adding puts the new layer above the one selected", () => {
    const d = base();
    const { doc: next, id } = addFlat(d, emptyRaster(W, H), "new", d.flats[0].id);
    expect(next.flats.length).toBe(3);
    expect(flatIndex(next, id)).toBe(1);
  });

  test("a copy is independent of what it was copied from", () => {
    const d = doc1(flat(rasterContent(envFromRows(() => "#111111", W, H)), "a"));
    const { doc: next, id } = duplicateFlat(d, d.flats[0].id);
    const painted = paintFlat(next, id, (cells) => { cells[0] = "#ff0000"; });
    expect(painted.flats[1].content.cells[0]).toBe("#ff0000");
    expect(painted.flats[0].content.cells[0]).toBe("#111111");
  });

  test("the last layer cannot be removed", () => {
    const d = doc1(flat(rampContent("Treeline"), "Sky"));
    expect(removeFlat(d, d.flats[0].id)).toBe(d);
  });

  test("baking freezes generated content into pixels, unchanged", () => {
    const d = doc1(flat(rampContent("Treeline"), "Sky"));
    const baked = bakeFlat(d, d.flats[0].id);
    expect(baked.flats[0].content.kind).toBe("raster");
    expect(renderContent(baked.flats[0].content, W, H))
      .toEqual(renderContent(d.flats[0].content, W, H));
  });

  test("the brush only writes to painted layers", () => {
    const d = doc1(flat(rampContent("Treeline"), "Sky"));
    expect(paintFlat(d, d.flats[0].id, (cells) => { cells[0] = "#ff0000"; })).toBe(d);
  });

  test("painting never mutates the document it was given", () => {
    const d = doc1(flat(rasterContent(envFromRows(() => "#111111", W, H)), "a"));
    const before = d.flats[0].content.cells.slice();
    paintFlat(d, d.flats[0].id, (cells) => { cells[3] = "#ff0000"; });
    expect(d.flats[0].content.cells).toEqual(before);
  });

  test("a document with every layer hidden has nothing to draw", () => {
    const d = doc1(flat(rampContent("Treeline"), "Sky"));
    expect(flattenDoc(updateFlat(d, d.flats[0].id, { visible: false }))).toBeNull();
  });

  test("holes left over the bottom layer are filled, not handed on as gaps", () => {
    // the renderer has no colour for a null cell, so flattening must not emit one
    const d = doc1(flat(stripesContent([{ color: "#ffffff", size: 1 }], false, 4), "Line"));
    const cells = flattenDoc(d).cells;
    expect(cells.every((c) => c != null)).toBe(true);
  });
});

describe("documents", () => {
  test("a palette document is one ramp layer on the studio's grid", () => {
    const d = docFromPalette("Treeline");
    expect(d.flats.length).toBe(1);
    expect(d.w).toBe(DOC_W);
    expect(d.h).toBe(DOC_H);
    expect(kindLabel(d.flats[0].content)).toBe("ramp");
  });

  test("a painted panorama is one painted layer at its own size", () => {
    const d = docFromPanorama(envFromRows(() => "#111111", 20, 10));
    expect(d.w).toBe(20);
    expect(d.h).toBe(10);
    expect(kindLabel(d.flats[0].content)).toBe("painted");
  });

  test("a raster saved at another size still lands on the grid", () => {
    const small = rasterContent(envFromRows((f) => (f < 0.5 ? "#000000" : "#ffffff"), 4, 4));
    const cells = renderContent(small, W, H);
    expect(cells.length).toBe(W * H);
    expect(cells[0]).toBe("#000000");
    expect(cells[(H - 1) * W]).toBe("#ffffff");
  });

  test("smoothing leaves transparent cells transparent", () => {
    const cells = new Array(W * H).fill(null);
    cells[3 * W + 3] = "#ffffff";
    const out = smoothEnv2D({ w: W, h: H, cells });
    expect(out.cells[0]).toBeNull();
    expect(out.cells[3 * W + 3]).toBe("#ffffff");
  });

  test("layer kinds read as what they are", () => {
    expect(kindLabel(stripesContent([{ color: "#111111", size: 1 }], true))).toBe("repeat");
    expect(kindLabel(stripesContent([{ color: "#111111", size: 1 }], false))).toBe("bands");
  });
});
