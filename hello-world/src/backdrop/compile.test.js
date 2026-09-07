import { compileBackdrop, MAX_REGIONS } from "./compile";
import { docFromPanorama, envFromRows, flattenDoc, flat, rasterContent, backdropDoc }
  from "./document";

const W = 24, H = 16;

// a panorama with three horizontal bands, waterline (row 0) first
const banded = () => envFromRows((f) => (f < 0.34 ? "#141d33" : f < 0.67 ? "#3f5f93" : "#cfe1ef"), W, H);

const compiled = (env) => compileBackdrop(docFromPanorama(env));

describe("compiling a document into regions", () => {
  test("one region per distinct color", () => {
    const b = compiled(banded());
    expect(b.count).toBe(3);
    expect(b.EW).toBe(W);
    expect(b.EH).toBe(H);
  });

  test("regions are ordered bottom-up by where they were painted", () => {
    const b = compiled(banded());
    expect([b.colorAt(0), b.colorAt(1), b.colorAt(2)])
      .toEqual(["#141d33", "#3f5f93", "#cfe1ef"]);
    expect(b.bg).toBe("#141d33");            // row 0 is what shows behind everything
  });

  test("a color painted in two places is still one region", () => {
    // today's model keys a region on its color; this pins the behavior so the
    // change that gives regions their own identity is a deliberate one
    const env = banded();
    env.cells[2 * W + 3] = "#cfe1ef";
    expect(compiled(env).count).toBe(3);
  });

  test("a region's field is positive on its own cells and negative off them", () => {
    const env = banded();
    const b = compiled(env);
    const fields = [];
    b.eachField((k, D) => { fields[k] = Float64Array.from(D); });

    const at = (k, row, col) => fields[k][row * W + col];
    // the top region: inside its own band, outside the bottom one
    expect(at(2, H - 2, 5)).toBeGreaterThan(0);
    expect(at(2, 1, 5)).toBeLessThan(0);
    // the bottom region's field covers everything, being the whole union
    expect(at(0, 1, 5)).toBeGreaterThan(0);
    expect(at(0, H - 2, 5)).toBeGreaterThan(0);
  });

  test("each region's field contains the one above it", () => {
    // the property that stops a background seam opening between neighbours
    const b = compiled(banded());
    const fields = [];
    b.eachField((k, D) => { fields[k] = Float64Array.from(D); });
    for (let k = 0; k + 1 < b.count; k++) {
      for (let p = 0; p < W * H; p++) {
        if (fields[k + 1][p] >= 1) expect(fields[k][p]).toBeGreaterThan(0);
      }
    }
  });

  test("fields arrive top of the stack first", () => {
    const seen = [];
    compiled(banded()).eachField((k) => seen.push(k));
    expect(seen).toEqual([2, 1, 0]);
  });

  test("flags a document with more regions than the smooth path can take", () => {
    const cells = new Array(W * H);
    for (let p = 0; p < W * H; p++) cells[p] = "#" + (0x100000 + p).toString(16);
    const b = compileBackdrop(docFromPanorama({ w: W, h: H, cells }));
    expect(b.count).toBe(W * H);
    expect(b.count).toBeGreaterThan(MAX_REGIONS);
    expect(b.overflow).toBe(true);
    expect(compiled(banded()).overflow).toBe(false);
  });

  test("an empty document compiles to nothing rather than throwing", () => {
    expect(compileBackdrop(backdropDoc([]))).toBeNull();
  });
});

describe("flattening a document", () => {
  test("one flat is its own cells", () => {
    const env = banded();
    expect(flattenDoc(docFromPanorama(env)).cells).toEqual(env.cells);
  });

  test("a hidden flat is left out", () => {
    const top = { ...flat(rasterContent(envFromRows(() => "#ffffff", W, H)), "top"),
      visible: false };
    const doc = backdropDoc([flat(rasterContent(banded()), "base"), top], W, H);
    expect(flattenDoc(doc).cells).toEqual(banded().cells);
  });

  test("a later flat paints over an earlier one", () => {
    const doc = backdropDoc([
      flat(rasterContent(banded()), "base"),
      flat(rasterContent(envFromRows(() => "#ffffff", W, H)), "top"),
    ], W, H);
    expect(new Set(flattenDoc(doc).cells)).toEqual(new Set(["#ffffff"]));
  });

  test("row 0 of a raster is the waterline, not the sky", () => {
    const env = envFromRows((f) => (f < 0.5 ? "#000000" : "#ffffff"), W, H);
    expect(env.cells[0]).toBe("#000000");
    expect(env.cells[(H - 1) * W]).toBe("#ffffff");
  });
});
