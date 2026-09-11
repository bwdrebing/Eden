import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import WaterReflectionContours, {
  buildDriftGrid, driftUses, driftShapePath, colorSampler, computeFit, prepField,
  DRIFT_SHAPES, DRIFT_DARK, DRIFT_LIGHT, VB_W, VB_H,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * The drift grid
 *
 * The illusion is a perceptual claim and no assertion here can check it. What
 * these do check is the structure it stands on: the shapes land on water, they
 * turn with the wave rather than with the frame, and — the one that decides
 * whether the picture drifts at all — every rim in the frame leans the same way
 * off the swell. Hang the rims off each shape's own uphill side instead and
 * every test below still passes except that last one, which is exactly why it
 * is here.
 * ------------------------------------------------------------------ */

const INK = "#2233c4";
const grid = (over = {}, opts = {}) => {
  const { S, fieldSpec } = buildScene({ ...GRAZING_RIPPLES, ...over });
  const fit = computeFit(S);
  prepField(S);
  const colorAt = colorSampler(S, {
    use2d: false, cols: fieldSpec.cols, deepMix: (c) => c,
  });
  return buildDriftGrid(S, fit, colorAt, {
    shape: "almond", density: 30, size: 1, spacing: 1.15,
    tint: true, ink: INK, BW: 320, gN: 110, threeD: true, ...opts,
  });
};

// one swell train, so the frame has a single unambiguous grain to test against
const swell = (dirDeg) => ({
  emitters: [{ id: 1, on: true, type: "swell", dir: dirDeg, size: 2.4, amp: 1.2 }],
});

test("the shapes land on the water, inside the frame, at the asked-for density", () => {
  const g = grid();
  expect(g.cells.length).toBeGreaterThan(100);
  for (const c of g.cells) {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeLessThanOrEqual(VB_W);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeLessThanOrEqual(VB_H);
  }
  // no cell is wider apart than the column pitch the density asked for
  const xs = [...new Set(g.cells.map((c) => c.x))].sort((a, b) => a - b);
  expect(xs.length).toBe(30);
  expect(xs[1] - xs[0]).toBeCloseTo(VB_W / 30, 6);
  // and the shape is drawn at half the cell, per size 1
  expect(g.half).toBeCloseTo(VB_W / 30 / 2, 6);
}, 120000);

test("density and row spacing move the count the way they read", () => {
  const sparse = grid({}, { density: 16 });
  const dense = grid({}, { density: 48 });
  expect(dense.cells.length).toBeGreaterThan(sparse.cells.length * 3);
  // tighter rows at one density is strictly more shapes
  const tight = grid({}, { density: 30, spacing: 0.8 });
  expect(tight.cells.length).toBeGreaterThan(grid({}, { density: 30, spacing: 2.2 }).cells.length);
  // …and size does not: it scales the shape, not the grid
  const big = grid({}, { size: 1.6 });
  expect(big.cells.length).toBe(grid().cells.length);
  expect(big.half).toBeCloseTo(grid().half * 1.6, 6);
}, 240000);

test("the shapes turn with the wave, not with the frame", () => {
  // A swell running along +y has its crests across the plane, so on screen the
  // shapes lie flat; turn the train 90° and they stand up. The angle is the
  // shape's own +y against the crest normal, so "flat shape" is angle ~0.
  const across = grid(swell(90));
  const along = grid(swell(0));
  const med = (g) => {
    const v = g.cells.map((c) => Math.abs(c.a)).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  expect(med(across)).toBeLessThan(20);
  expect(med(along)).toBeGreaterThan(60);
  // the frame's own heading follows the train it was taken from
  expect(Math.abs(across.aim - 90)).toBeLessThan(20);
}, 240000);

test("every rim in the frame leans the same way off the swell", () => {
  // The rims are offset along each shape's local +y, which rotate(a) puts on
  // the crest normal. If that normal is signed per cell — uphill, say — it
  // reverses on every other flank and the drift cancels. Signed against the
  // frame's one heading, every shape's rim has a positive component along it.
  for (const dir of [90, 40, 0, 135]) {
    const g = grid(swell(dir));
    const ar = (g.aim * Math.PI) / 180, rx = Math.cos(ar), ry = Math.sin(ar);
    for (const c of g.cells) {
      const a = (c.a * Math.PI) / 180;
      // rotate(a) · (0,1) — where this shape's light rim sits
      const dot = -Math.sin(a) * rx + Math.cos(a) * ry;
      expect(dot).toBeGreaterThanOrEqual(-1e-9);
    }
  }
}, 480000);

test("the color toggle picks between the scene and one ink", () => {
  const tinted = grid({}, { tint: true });
  const flat = grid({}, { tint: false });
  expect(flat.cells.every((c) => c.c === INK)).toBe(true);
  const { fieldSpec } = buildScene(GRAZING_RIPPLES);
  const palette = new Set(fieldSpec.cols);
  expect(tinted.cells.every((c) => palette.has(c.c))).toBe(true);
  expect(new Set(tinted.cells.map((c) => c.c)).size).toBeGreaterThan(1);
}, 240000);

test("each shape is drawn as a dark rim, a light rim and the shape over both", () => {
  const g = grid({}, { density: 14 });
  const emitted = [];
  driftUses(g, 1.2, (tf, fill) => emitted.push([tf, fill]));
  expect(emitted.length).toBe(g.cells.length * 3);
  const [dark, light, body] = emitted;
  expect(dark[1]).toBe(DRIFT_DARK);
  expect(light[1]).toBe(DRIFT_LIGHT);
  expect(body[1]).toBe(g.cells[0].c);
  // the rim rides inside the rotation and outside the scale, so it is a fixed
  // offset across the crest however big the shape is
  expect(dark[0]).toContain("translate(0 -1.20)");
  expect(light[0]).toContain("translate(0 1.20)");
  expect(body[0]).not.toContain("translate(0");

  // a negative width is the same picture with the rims swapped — that is the
  // control that reverses which way the frame appears to roll
  const rev = [];
  driftUses(g, -1.2, (tf, fill) => rev.push([tf, fill]));
  expect(rev[0][0]).toBe(light[0]);
  expect(rev[0][1]).toBe(DRIFT_DARK);
  expect(rev[1][0]).toBe(dark[0]);

  // and at zero there are no rims at all — the shapes alone, no illusion
  const bare = [];
  driftUses(g, 0, (tf, fill) => bare.push([tf, fill]));
  expect(bare.length).toBe(g.cells.length);
}, 120000);

test("every shape kind is one closed outline about the origin", () => {
  for (const [id, , k] of DRIFT_SHAPES) {
    const d = driftShapePath(id, k);
    expect(d.startsWith("M-1 0")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect((d.match(/A/g) || []).length).toBe(2);
    expect(d).not.toContain("NaN");
  }
}, 30000);

test("the studio wires the drift grid up end to end", () => {
  // the whole setting set rides in the link like any other scene, Style
  // workspace included, so opening one lands on the grid already drawn
  const saved = { reflection: {
    ...GRAZING_RIPPLES, quality: 70, rasterQ: 0, uiTab: "style",
    driftOn: true, driftShape: "almond", driftDensity: 22, driftSize: 0.85,
    driftSpacing: 1.15, driftRim: 1.1, driftTint: false, driftInk: INK,
  } };
  const bytes = new TextEncoder().encode(JSON.stringify(saved));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  const hash = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  window.history.replaceState({}, "", "/?s=" + hash);
  render(<WaterReflectionContours />);

  // the settings came back off the link, and the panel is showing them
  for (const [, label] of DRIFT_SHAPES) expect(screen.getByText(label)).toBeInTheDocument();
  expect(document.body.textContent).toMatch(/22 across/);
  expect(document.body.textContent).toMatch(/almonds/);
  // …and the shape color well is out, because the scene said not to tint
  expect(document.body.textContent).toMatch(/shape color/);

  // the preview is drawn from the one outline in the defs, three copies a shape
  const uses = () => document.querySelectorAll("svg use").length;
  expect(document.querySelectorAll("svg defs path#drift").length).toBe(1);
  const withRims = uses();
  expect(withRims).toBeGreaterThan(60);
  expect(withRims % 3).toBe(0);

  // a shape change re-cuts the grid without throwing, and keeps the count
  fireEvent.click(screen.getByText("Disc"));
  expect(document.querySelectorAll("svg defs path#drift").length).toBe(1);
  expect(uses()).toBeGreaterThan(0);

  // switching to the filled render puts the regions back and takes the grid away
  fireEvent.click(screen.getByText("Filled"));
  expect(document.querySelectorAll("svg use").length).toBe(0);
  expect(document.querySelectorAll("svg path").length).toBeGreaterThan(3);
}, 240000);
