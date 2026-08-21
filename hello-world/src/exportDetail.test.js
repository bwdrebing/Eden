import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";

/* ------------------------------------------------------------------ *
 * Export detail, end to end
 *
 * The unit tests pin what a wider raster does to the geometry; this pins the
 * wiring around it — that the button actually routes through the retrace, that
 * the page says so while it holds still, and that a file comes out the other
 * side. jsdom has no createObjectURL, so the download is a no-op and the copy
 * box is the observable result, which is exactly what a sandboxed browser
 * falls back to as well.
 * ------------------------------------------------------------------ */

test("Export SVG retraces at the export raster, then hands back a file", async () => {
  render(<App />);

  // the controls default to 2x the preview's raster ("normal" -> 880px) and to
  // the preview's own mesh — a faithful file unless asked otherwise
  expect(screen.getByText(/2× preview · 880px/)).toBeInTheDocument();
  expect(screen.getByText(/as previewed · 150/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^Export SVG$/ }));
  // the retrace is synchronous, so the page announces it before it starts
  expect(screen.getByRole("button", { name: /Tracing at 880px/ })).toBeDisabled();

  await waitFor(() => expect(screen.getByRole("button", { name: /^Export SVG$/ })).toBeEnabled(),
    { timeout: 60000 });

  const out = await screen.findByDisplayValue(/^<svg xmlns/);
  expect(out.value).toMatch(/viewBox="0 0 760 500"/);
  expect(out.value.length).toBeGreaterThan(1000);
}, 120000);
