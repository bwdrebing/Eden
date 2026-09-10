import v8 from "v8";
import { surfaceDirAt, prepField, buildSolid3D, fieldSpecFor, RASTER_LEVELS }
  from "./WaterReflectionContours";
import { makeFloorPlace } from "./backdrop/place";
import { backdropDoc, flat, gridContent, renderContent, GRID_GROUT, isStatedContent }
  from "./backdrop/document";
import { compileBackdrop } from "./backdrop/compile";
import { encodeDoc, decodeDoc } from "./backdrop/codec";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * The pool floor
 *
 * A backdrop at infinity is a direction, so it answers the same thing
 * however deep the water is: a grid painted on it ripples but never warps.
 * A floor is a PLACE, so the ray has to travel to it, and
 *
 *     displacement = depth x tan(refracted angle)
 *
 * is the bow in the grout lines. These pin that relationship, and the two
 * properties the repeat depends on.
 * ------------------------------------------------------------------ */

let base = null;
const scene = (over) => {
  if (!base) base = buildScene(GRAZING_RIPPLES).S;
  return { ...base, ...over };
};

describe("where a ray lands on the floor", () => {
  test("straight down lands straight below, at any depth", () => {
    for (const depth of [0.5, 4, 20]) {
      const p = makeFloorPlace({ depth, span: 2 });
      expect(p.hit(3, 7, 0, [0, 0, -1])).toEqual([1.5, 3.5]);   // /span
    }
  });

  test("a tilted ray lands depth x tan(angle) away", () => {
    const depth = 5, span = 1;
    const p = makeFloorPlace({ depth, span });
    for (const th of [10, 30, 48]) {
      const t = (th * Math.PI) / 180;
      const uv = p.hit(0, 0, 0, [Math.sin(t), 0, -Math.cos(t)]);
      expect(uv[0]).toBeCloseTo(depth * Math.tan(t), 9);
    }
  });

  test("the wave height it leaves from counts as depth", () => {
    const p = makeFloorPlace({ depth: 5, span: 1 });
    // a ray leaving a crest 1 unit up has 6 units to fall, not 5
    const t = Math.PI / 4, d = [Math.sin(t), 0, -Math.cos(t)];
    expect(p.hit(0, 0, 1, d)[0]).toBeCloseTo(6, 9);
    expect(p.hit(0, 0, -1, d)[0]).toBeCloseTo(4, 9);
  });

  test("a ray that is not going down never reaches it", () => {
    const p = makeFloorPlace({ depth: 5, span: 1 });
    expect(p.hit(0, 0, 0, [0, 1, 0])).toBeNull();       // along the surface
    expect(p.hit(0, 0, 0, [0, 0.7, 0.7])).toBeNull();   // up: a reflected ray
  });

  test("it has no rim to run off", () => {
    expect(makeFloorPlace({ depth: 1, span: 1 }).edge(99, -99)).toBe(Infinity);
  });
});

test("the warp is linear in depth — that is the whole effect", () => {
  const S = scene({ refract: true });
  prepField(S);
  const span = 1.6, tiles = 8;
  const gy = S.yMin + 0.25 * (S.yMax - S.yMin);
  const warp = (depth) => {
    const place = makeFloorPlace({ depth, span });
    const xs = [], us = [];
    for (let i = 0; i < 400; i++) {
      const gx = -2 + (i / 399) * 4;
      const uv = place.hit(gx, gy, 0, surfaceDirAt(gx, gy, S));
      xs.push(gx); us.push(uv[0] * tiles);
    }
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n;
    const mu = us.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (us[i] - mu); sxx += (xs[i] - mx) ** 2; }
    const k = sxy / sxx;
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (us[i] - mu - k * (xs[i] - mx)) ** 2;
    return Math.sqrt(ss / n);
  };
  const w1 = warp(1);
  expect(w1).toBeGreaterThan(0);                       // there IS a warp
  for (const d of [0.25, 3, 12]) {
    expect(warp(d) / d).toBeCloseTo(w1, 6);            // and it scales with depth
  }
});

describe("the tile grid", () => {
  const cells = (c, w = 96, h = 96) => renderContent(c, w, h, 1);

  test("is stated content, so it earns the compiler's finer grid", () => {
    expect(isStatedContent(gridContent())).toBe(true);
  });

  test("draws grout between tiles", () => {
    const g = cells(gridContent(4, 0.2));
    expect(g.filter((c) => c === GRID_GROUT).length).toBeGreaterThan(0);
    expect(new Set(g).size).toBeGreaterThan(1);
  });

  test("repeats seamlessly: the block's edges fall mid-tile, not on grout", () => {
    // A grout line sitting ON the seam would have its distance field measured
    // against the grid's edge rather than its neighbour across the repeat, and
    // would contour into a line once per block. The edge column still holds
    // the grout that CROSSES it, so the test is that it holds no more than a
    // mid-tile column does — not that it holds none.
    const w = 96, g = cells(gridContent(4, 0.2), w, w);
    const groutInCol = (c) => {
      let n = 0;
      for (let r = 0; r < w; r++) if (g[r * w + c] === GRID_GROUT) n++;
      return n;
    };
    let worst = 0;
    for (let c = 0; c < w; c++) worst = Math.max(worst, groutInCol(c));
    expect(groutInCol(0)).toBeLessThan(worst);         // not a grout column
    expect(groutInCol(w - 1)).toBeLessThan(worst);
    expect(groutInCol(0)).toBe(groutInCol(w - 1));     // and the two agree
  });

  test("and the picture continues across the seam, both ways", () => {
    const w = 96, g = cells(gridContent(4, 0.2), w, w);
    // the tile the seam splits is ONE tile, so the halves match cell for cell
    for (let r = 0; r < w; r++) expect(g[r * w]).toBe(g[r * w + w - 1]);
    for (let c = 0; c < w; c++) expect(g[c]).toBe(g[(w - 1) * w + c]);
  });

  test("colour variety at 0 makes one flat colour plus grout", () => {
    const g = cells(gridContent(4, 0.2, null, 0));
    expect(new Set(g).size).toBe(2);
  });
});

describe("a floor in a document", () => {
  const poolDoc = (depth = 6) => backdropDoc([
    { ...flat(gridContent(8, 0.14), "Pool floor"),
      place: { kind: "floor", depth, span: 1.6 } },
  ]);

  test("compiles to its own group, placed on the floor", () => {
    const b = compileBackdrop(poolDoc());
    expect(b.groups.length).toBe(1);
    expect(b.groups[0].place.kind).toBe("floor");
    expect(b.groups[0].place.repeat).toBe(true);
  });

  test("is a handful of regions however many tiles there are", () => {
    // a region is keyed on colour, so the cut and the SVG stay small
    expect(compileBackdrop(poolDoc()).count).toBeLessThanOrEqual(8);
  });

  test("survives a shared link", () => {
    const back = decodeDoc(encodeDoc(poolDoc(7.5)));
    expect(back.flats[0].place).toEqual({ kind: "floor", depth: 7.5, span: 1.6 });
    expect(back.flats[0].content.kind).toBe("grid");
    expect(back.flats[0].content.tiles).toBe(8);
    expect(back.flats[0].content.grout).toBeCloseTo(0.14, 6);
  });

  test("crosses to the render worker as data", () => {
    expect(() => v8.deserialize(v8.serialize(poolDoc()))).not.toThrow();
  });

  test("renders warped tiles through refracted water", () => {
    const S = scene({ refract: true });
    const L = RASTER_LEVELS[0];
    const mk = (depth, refract) => {
      const R = { ...S, refract };
      return buildSolid3D(R, fieldSpecFor(R, { use2d: true, doc: poolDoc(depth),
        azSpan: 40, cols: [], fresOn: false, fresBands: 3 }), { gN: L.gN, BW: L.BW });
    };
    const deep = mk(12, true);
    expect(deep.layers.length).toBeGreaterThan(0);
    for (const l of deep.layers) expect((l.d.match(/Z/g) || []).length).toBeGreaterThan(0);
    // a deeper floor is a more warped one, so its outlines carry more vertices
    const shallow = mk(0.5, true);
    const verts = (r) => r.layers.reduce((n, l) => n + (l.d.match(/[MLC]/g) || []).length, 0);
    expect(verts(deep)).toBeGreaterThan(verts(shallow));
  }, 180000);
});
