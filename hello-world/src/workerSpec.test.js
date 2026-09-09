import v8 from "v8";
import { fieldSpecFor, buildSolid3D, RASTER_LEVELS, envFromRows } from "./WaterReflectionContours";
import {
  backdropDoc, flat, rasterContent, rampContent, stripesContent, DOC_W, DOC_H,
} from "./backdrop/document";
import { shapesContent, shape } from "./backdrop/shapes";

/* ------------------------------------------------------------------ *
 * What crosses to the render worker
 *
 * buildSolid3D runs off the main thread (solidWorker.js), and only data can
 * make that trip — the field spec's sampling closures cannot, so the worker
 * rebuilds them from `spec` with fieldSpecFor. That makes the shape of `spec`
 * a contract, and an easy one to break: hand it anything with a function on
 * it and the studio still works, because the studio never crosses a thread.
 * The worker silently fails instead.
 *
 * So: the backdrop travels as its DOCUMENT, which is data all the way down,
 * and the far side compiles its own. These check that it survives the trip
 * and draws the same picture when it gets there.
 * ------------------------------------------------------------------ */

const S = {
  nx: 60, ny: 60, xMin: -16, xMax: 16, yMin: 6, yMax: 40,
  H: 0.4 * Math.pow(22.5, 0.6), pitch: (22 * Math.PI) / 180,
  k: (2 * Math.PI) / 2.2, amp: 0.02, sharp: 0, decay: 0.1, omega: 1, t: 2,
  bands: 5, perspective: true, eLo: -3, eHi: 24, zoom: 1, panX: 0, panY: 0,
  smooth: 2, coherence: 0, rectOutput: false, surface3d: true, waveScale: 1,
  fresOn: false, fresBands: 3, reflMag: 1,
  emitters: [{ id: 1, on: true, type: "swell", x: 0, y: 20, dir: 90, size: 3,
    amp: 1, spread: 30, roughness: 0, detail: 8 }],
};

// one of every content kind, plus a flat standing at a distance
const doc = () => backdropDoc([
  flat(rampContent("Treeline"), "Sky"),
  flat(stripesContent([{ color: "#9cc3e8", size: 2 }, { color: "#ffffff", size: 1 }]), "Repeat"),
  flat(rasterContent(envFromRows(() => "#141d33", DOC_W, DOC_H)), "Painted"),
  { ...flat(shapesContent([shape("tree"), shape("dock")]), "Shapes"),
    place: { kind: "plane", distance: 14, width: 40, height: 10 } },
], DOC_W, DOC_H);

// jsdom has no structuredClone; v8.serialize is the same structured-clone
// algorithm and, like postMessage, refuses to carry a function
const clone = (v) => (typeof structuredClone === "function"
  ? structuredClone(v) : v8.deserialize(v8.serialize(v)));

const opts = () => ({
  use2d: true, doc: doc(), azSpan: 45,
  cols: ["#141d33", "#9cc3e8"], fresOn: false, fresBands: 3,
});

describe("the spec that crosses to the worker", () => {
  test("is data all the way down", () => {
    // structuredClone is exactly what postMessage does, and it throws on a
    // function — so this is the boundary, tested at the boundary
    expect(() => clone(opts())).not.toThrow();
  });

  test("carries no functions, however deep", () => {
    const walk = (v, path = "spec") => {
      expect(typeof v).not.toBe("function");
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(opts());
  });

  test("rebuilds into a working spec on the far side", () => {
    const spec = fieldSpecFor(S, clone(opts()));
    expect(typeof spec.uvAt).toBe("function");
    expect(typeof spec.rayAt).toBe("function");
    expect(spec.backdrop.count).toBeGreaterThan(0);
    // the flat standing at a distance came through as its own group
    expect(spec.backdrop.groups.map((g) => g.place.kind)).toContain("plane");
  });

  test("draws the same picture whichever side built it", () => {
    // the worker's whole promise: same function, same inputs, other thread
    const here = buildSolid3D(S, fieldSpecFor(S, opts()),
      { gN: RASTER_LEVELS[0].gN, BW: RASTER_LEVELS[0].BW });
    const there = buildSolid3D(S, fieldSpecFor(S, clone(opts())),
      { gN: RASTER_LEVELS[0].gN, BW: RASTER_LEVELS[0].BW });
    expect(there.bg).toBe(here.bg);
    expect(there.layers.map((l) => l.color)).toEqual(here.layers.map((l) => l.color));
    expect(there.layers.map((l) => l.d)).toEqual(here.layers.map((l) => l.d));
  }, 120000);

  test("a preset scene's spec crosses too", () => {
    const flatOpts = { use2d: false, doc: null, azSpan: 45,
      cols: ["#141d33", "#3f5f93", "#9cc3e8"], fresOn: false, fresBands: 3 };
    expect(() => clone(flatOpts)).not.toThrow();
    const spec = fieldSpecFor(S, flatOpts);
    expect(typeof spec.scalarAt).toBe("function");
    expect(spec.thresholds.length).toBe(2);
  });
});
