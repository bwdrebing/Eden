import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import {
  PNG_SCALES, PNG_DEFAULT, PNG_MAX_PIXELS, pngSize, pngTraceBW, sizedSvg, svgToPngBlob,
  RASTER_LEVELS, EXPORT_MAX_BW,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * PNG export
 *
 * The PNG exists because the SVG's edge steps are not free: polish blurs the
 * field before the regions are cut, and a glint a few raster pixels across is
 * not distinguishable from aliasing at that point. So what is pinned here is
 * the shape of the escape hatch — a size that a canvas will actually allocate,
 * markup an <img> will accept, a trace raster matched to that size (the step
 * that keeps the edges smooth without smoothing anything), and a failure that
 * comes back as a message rather than a hang, since jsdom (like a locked-down
 * sandbox) has no rasterizer at all.
 * ------------------------------------------------------------------ */

const VB_W = 760, VB_H = 500;

test("every offered size keeps the frame's aspect and fits a canvas", () => {
  for (const scale of PNG_SCALES) {
    const { w, h, capped } = pngSize(scale);
    expect(capped).toBe(false);                       // none of the steps clamp
    expect(w).toBe(VB_W * scale);
    expect(h).toBe(VB_H * scale);
    expect(w * h).toBeLessThanOrEqual(PNG_MAX_PIXELS);
  }
  expect(PNG_SCALES[PNG_DEFAULT]).toBe(4);            // 3040 x 2000 out of the box
  expect(pngSize(PNG_SCALES[PNG_DEFAULT]).w).toBe(3040);
});

test("a scale past the pixel cap is clamped, not handed to the canvas", () => {
  const huge = pngSize(64);
  expect(huge.capped).toBe(true);
  expect(huge.w * huge.h).toBeLessThanOrEqual(PNG_MAX_PIXELS);
  expect(huge.w / huge.h).toBeCloseTo(VB_W / VB_H, 2);
});

test("the regions are traced on the output's own pixel grid", () => {
  // one contour cell per output pixel: the marching-squares step is then a
  // single pixel, which the rasterizer's antialiasing absorbs
  const normal = RASTER_LEVELS[1];                  // preview "normal", BW 440
  for (const scale of PNG_SCALES) {
    const { w } = pngSize(scale);
    if (w <= EXPORT_MAX_BW) expect(pngTraceBW(normal, w)).toBe(w);
  }
  // never coarser than what is already on screen...
  const max = RASTER_LEVELS[RASTER_LEVELS.length - 1];
  expect(pngTraceBW(max, pngSize(2).w)).toBe(max.BW);
  // ...and never past what a tab can allocate
  expect(pngTraceBW(max, pngSize(6).w)).toBe(EXPORT_MAX_BW);
  expect(pngSize(6).w / EXPORT_MAX_BW).toBeLessThan(1.3);   // still ~a pixel a step
  // export detail can trace finer than the output, never coarser: a turned-up
  // slider keeps what it was resolving, a turned-down one cannot cost the file
  // its pixel grid
  expect(pngTraceBW(max, pngSize(4).w, 3)).toBe(EXPORT_MAX_BW);
  expect(pngTraceBW(normal, pngSize(4).w, 1)).toBe(pngSize(4).w);
});

test("the rasterized markup states its pixel size and is otherwise untouched", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}"><path d="M0 0Z"/></svg>`;
  const sized = sizedSvg(svg, 3040, 2000);
  expect(sized).toMatch(/^<svg width="3040" height="2000" xmlns=/);
  expect(sized).toContain(`viewBox="0 0 ${VB_W} ${VB_H}"`);   // still the same frame
  expect(sized).toContain('<path d="M0 0Z"/>');
  expect(sized.length).toBe(svg.length + ' width="3040" height="2000"'.length);
});

test("no 2D context means a rejection, not a promise that never settles", async () => {
  await expect(svgToPngBlob("<svg/>", 100, 100)).rejects.toThrow();
});

test("Export PNG offers the preview at print size, and says so when it cannot", async () => {
  render(<App />);

  expect(screen.getByText(/3040 × 2000/)).toBeInTheDocument();

  // the smallest step, so the trace this exercises is the cheap one
  fireEvent.change(screen.getByLabelText(/PNG size/), { target: { value: "0" } });
  expect(screen.getByText(/1520 × 1000/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^Export PNG$/ }));
  // the retrace is synchronous, so the page announces it before it starts
  expect(screen.getByRole("button", { name: /Tracing at 1520px/ })).toBeDisabled();
  // jsdom has no canvas, so the rasterize fails — the point is that it comes
  // back, re-enables the button and explains itself
  await waitFor(() => expect(screen.getByText(/would not rasterize/)).toBeInTheDocument(),
    { timeout: 60000 });
  expect(screen.getByRole("button", { name: /^Export PNG$/ })).toBeEnabled();
}, 120000);
