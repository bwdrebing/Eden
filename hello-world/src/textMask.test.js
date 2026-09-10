import { buildTextMask, textMaskAt, maskExtent, fontString, MARK_FONTS } from "./textMask";
import { barsMask } from "./textMarkFixture";

/* ------------------------------------------------------------------ *
 * Text as a field
 *
 * The mask is the one place a string turns into geometry, and everything
 * downstream — the watermark on the water, a text shape in the backdrop —
 * reads it through `textMaskAt` in em units with the baseline at zero and y
 * pointing UP. Get that mapping wrong by a sign and the type comes out
 * upside down, which is exactly the sort of thing that survives a screenshot
 * and not a second look. So it is pinned here.
 * ------------------------------------------------------------------ */

test("a mask reads in em units, baseline at zero, y up", () => {
  // one bar from 0.1 to 0.45 ems across, 0.72 ems tall, on the baseline
  const m = barsMask([[0.1, 0.45]], 0.72);
  const inside = textMaskAt(m, 0.275, 0.36);          // the bar's own middle
  expect(inside).toBeGreaterThan(0);
  expect(textMaskAt(m, 0.275, 0.05)).toBeGreaterThan(0);   // just above the baseline
  expect(textMaskAt(m, 0.275, -0.1)).toBeLessThan(0);      // below it: nothing
  expect(textMaskAt(m, 0.275, 0.9)).toBeLessThan(0);       // above the cap: nothing
  expect(textMaskAt(m, 0.6, 0.36)).toBeLessThan(0);        // past the right edge
  // the field is a distance, so the middle of the bar is the furthest in
  expect(inside).toBeGreaterThan(textMaskAt(m, 0.12, 0.36));
});

test("the field crosses zero on the ink's edge, not a cell away from it", () => {
  const m = barsMask([[0.1, 0.45]], 0.72);
  for (const u of [0.1, 0.45]) {
    expect(Math.abs(textMaskAt(m, u, 0.36))).toBeLessThan(0.03);
  }
  // and it is signed distance, so stepping in doubles what stepping half as
  // far in gave — which is what lets a halo be the same field at another level
  const a = textMaskAt(m, 0.15, 0.36), b = textMaskAt(m, 0.2, 0.36);
  expect(b - a).toBeCloseTo(0.05, 2);
});

test("the extent is the ink box, so a caller can centre what it places", () => {
  const m = barsMask([[0.1, 0.45], [0.65, 1.0]], 0.72);
  const e = maskExtent(m);
  expect(e.w).toBeGreaterThan(0.9);                  // ~1 em of bars across
  expect(e.h).toBeCloseTo(0.72, 1);
  expect(e.cy).toBeCloseTo(0.36, 1);                 // half way up from the baseline
  // the centre of the box is between the two bars, so it is OUTSIDE the ink —
  // which is the whole reason a caller has to be told the box rather than
  // guessing it from where the field happens to be positive
  expect(textMaskAt(m, e.cx, e.cy)).toBeLessThan(0);
});

test("a point far outside is clamped rather than extrapolated", () => {
  const m = barsMask();
  const near = textMaskAt(m, -0.5, 0.36);
  const far = textMaskAt(m, -500, 0.36);
  expect(far).toBeLessThan(0);
  expect(far).toBeGreaterThanOrEqual(near - 1e-6);   // no runaway negative
  expect(Number.isFinite(far)).toBe(true);
});

test("the font stack is named by a key the URL can carry", () => {
  expect(MARK_FONTS.map((f) => f[0])).toContain("serif");
  const f = fontString({ font: "mono", weight: 700, italic: true });
  expect(f).toMatch(/^italic 700 \d+px /);
  expect(f).toMatch(/mono/i);
  // an unknown key falls back rather than writing "undefined" into the font
  expect(fontString({ font: "nonesuch" })).not.toMatch(/undefined/);
});

test("with no canvas to set type on, a mask is null rather than a guess", () => {
  // jsdom has neither OffscreenCanvas nor a working 2D context, and a
  // watermark that quietly invented its own letterforms there would be worse
  // than one that does not draw: the render worker and this thread would
  // disagree about the picture.
  expect(buildTextMask("Eden", { font: "serif" })).toBe(null);
  expect(buildTextMask("", { font: "serif" })).toBe(null);
  expect(buildTextMask(null)).toBe(null);
});
