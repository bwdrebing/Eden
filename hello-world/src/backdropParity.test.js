import crypto from "crypto";
import { buildSegmentation } from "./WaterReflectionContours";
import { paintedScene } from "./backdropScene";
import { compileBackdrop } from "./backdrop/compile";
import { docFromPanorama } from "./backdrop/document";
import baseline from "./__fixtures__/segmentationBaseline.json";

/* ------------------------------------------------------------------ *
 * Backdrop parity
 *
 * The baseline was recorded from the segmentation as it stood before the
 * backdrop rearchitecture: every region's color, the length of its path data,
 * and a hash of that path data, for a painted panorama with objects stamped
 * into it on the saved scene's camera.
 *
 * The rearchitecture is a refactor of where the region list comes from, not of
 * what it is, so every one of those numbers has to come out the same. This is
 * the test that says so. It is not a smoke test: a single moved control point
 * changes a hash.
 *
 * If a change is MEANT to move the geometry, look at the render first (the
 * CLAUDE.md gate: RASTER_LEVELS[5], write the layers to an .svg, zoom into the
 * top of the frame), and only then re-record the baseline with the change
 * described in the commit.
 * ------------------------------------------------------------------ */

const sig = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

let seg;
beforeAll(() => {
  const { S, env, azSpan } = paintedScene();
  seg = buildSegmentation(S, compileBackdrop(docFromPanorama(env)), azSpan);
}, 120000);

test("the painted scene still resolves to the same regions", () => {
  expect(seg.twoD).toBe(baseline.twoD);
  expect(seg.bg).toBe(baseline.bg);
  expect(seg.count).toBe(baseline.count);
  expect(seg.layers.map((l) => l.color)).toEqual(baseline.layers.map((l) => l.color));
});

test("the reflected elevation range is unchanged", () => {
  expect(+seg.lo.toFixed(6)).toBe(baseline.lo);
  expect(+seg.hi.toFixed(6)).toBe(baseline.hi);
});

test("every region's outline is byte-identical to the baseline", () => {
  // lengths first: a mismatch reads as "region 4 got 300 characters longer",
  // which is a far better failure than "hash differs"
  expect(seg.layers.map((l) => l.d.length)).toEqual(baseline.layers.map((l) => l.len));
  expect(seg.layers.map((l) => sig(l.d))).toEqual(baseline.layers.map((l) => l.hash));
});

test("the water's clip outline is unchanged", () => {
  expect(sig(seg.clip)).toBe(baseline.clipHash);
});
