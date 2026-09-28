// The ice view as a picture: the backdrop straight on, bent inside each block.
// Built on the saved grazing-ripples scene's painted strip and on a layered 2D
// backdrop, the two forms the view samples.
import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";
import { buildIceView, iceSvgMarkup, bandThresholds, VB_W } from "./WaterReflectionContours";
import { newIceCube } from "./ice";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";
import { docFromPalette } from "./backdrop/document";
import { compileBackdrop } from "./backdrop/compile";

const BW = 200;   // small: this is about structure, not edges
const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
const S1 = { ...S, reflMag: 1 };
const cols = fieldSpec.cols;
const bands = { cols, thresholds: bandThresholds(S1, cols.length), bg: cols[0],
  azSpan: GRAZING_RIPPLES.azSpan };
const plain = { ior: 1.31, dispersion: 0, dist: 8, tintAmt: 0.35, tintColor: "#d6f0f7",
  shine: 0.7, despeckle: 12 };

test("with no ice the view is the backdrop, flat: one band per painted run", () => {
  const v = buildIceView(S1, bands, { ...plain, cubes: [] }, { BW });
  expect(v.blocks).toHaveLength(0);
  // the window spans the strip exactly, so every run of it shows
  expect(v.base.length).toBe(cols.length);
  expect(v.base.map((l) => l.color)).toEqual(cols);
});

test("a block is cut to its own outline and carries its tint, core and shine", () => {
  const v = buildIceView(S1, bands, { ...plain, cubes: [newIceCube(1)] }, { BW });
  expect(v.blocks).toHaveLength(1);
  const b = v.blocks[0];
  expect(b.clip.length).toBeGreaterThan(20);
  expect(b.chans).toHaveLength(1);
  expect(b.chans[0].layers.length).toBeGreaterThan(0);
  expect(b.tint.length + b.core.length + b.shine.length).toBeGreaterThan(0);
  // each wash is translucent, and stacks up to its own level
  for (const w of [...b.tint, ...b.core, ...b.shine]) {
    expect(w.a).toBeGreaterThan(0);
    expect(w.a).toBeLessThan(1);
  }
  const svg = iceSvgMarkup(v);
  expect(svg).toContain('<clipPath id="ice0">');
  expect(svg).not.toContain("mix-blend-mode");
});

test("a block turned off, or pushed behind the camera, draws nothing", () => {
  const off = buildIceView(S1, bands, { ...plain, cubes: [{ ...newIceCube(1), on: false }] },
    { BW });
  expect(off.blocks).toHaveLength(0);
  const behind = buildIceView(S1, bands,
    { ...plain, cubes: [{ ...newIceCube(1), z: -19 }] }, { BW });
  expect(behind.blocks).toHaveLength(0);
});

test("dispersion traces three channels and adds them back together", () => {
  const v = buildIceView(S1, bands, { ...plain, dispersion: 0.7, cubes: [newIceCube(1)] },
    { BW });
  expect(v.blocks[0].chans).toHaveLength(3);
  const svg = iceSvgMarkup(v);
  expect(svg).toContain("isolation:isolate");
  expect((svg.match(/mix-blend-mode:screen/g) || []).length).toBe(3);
  // channel colours carry one channel each
  expect(svg).toMatch(/rgb\(\d+,0,0\)/);
  expect(svg).toMatch(/rgb\(0,0,\d+\)/);
});

test("a layered 2D backdrop is bent the same way", () => {
  const bd = compileBackdrop(docFromPalette("Sunset Lake"));
  const look = { backdrop: bd, bg: bd.bg, azSpan: 45 };
  const v = buildIceView({ ...S1, eLo: -5, eHi: 33 }, look,
    { ...plain, cubes: [newIceCube(1, -2, 0), { ...newIceCube(2, 2, 0), z: 4 }] }, { BW });
  expect(v.base.length).toBeGreaterThan(3);
  expect(v.blocks).toHaveLength(2);
  expect(v.blocks.every((b) => b.chans[0].layers.length > 0)).toBe(true);
});

test("the Ice tab turns the view on, and the preview draws it", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("tab", { name: /ice/i }));
  fireEvent.click(screen.getByText("Ice view"));
  expect(document.querySelector('clipPath[id="ice0"]')).not.toBeNull();
  expect(screen.getByText(/ice view · 1 block ·/)).toBeInTheDocument();
  // the other tabs say the water is gone rather than silently doing nothing
  fireEvent.click(screen.getByRole("tab", { name: /waves/i }));
  expect(screen.getByText(/Ice view is on/)).toBeInTheDocument();
  expect(VB_W).toBe(760);
});
