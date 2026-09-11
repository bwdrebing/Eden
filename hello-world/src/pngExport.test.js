import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import {
  PNG_SCALES, PNG_DEFAULT, PNG_MAX_PIXELS, pngSize, sizedSvg, svgToPngBlob,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * PNG export
 *
 * The PNG exists because the SVG's edge steps are not free: polish blurs the
 * field before the regions are cut, and a glint a few raster pixels across is
 * not distinguishable from aliasing at that point. So what is pinned here is
 * the shape of the escape hatch — a size that a canvas will actually allocate,
 * markup an <img> will accept, and a failure that comes back as a message
 * rather than a hang, since jsdom (like a locked-down sandbox) has no
 * rasterizer at all.
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
  fireEvent.click(screen.getByRole("tab", { name: /output/i }));

  expect(screen.getByText(/3040 × 2000/)).toBeInTheDocument();

  const btn = screen.getByRole("button", { name: /^Export PNG$/ });
  fireEvent.click(btn);
  // jsdom has no canvas, so the rasterize fails — the point is that it comes
  // back, re-enables the button and explains itself
  await waitFor(() => expect(screen.getByText(/would not rasterize/)).toBeInTheDocument(),
    { timeout: 60000 });
  expect(screen.getByRole("button", { name: /^Export PNG$/ })).toBeEnabled();
}, 120000);
