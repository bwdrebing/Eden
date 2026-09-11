import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import WaterReflectionContours, {
  buildDriftGrid, driftUses, driftShapePath, colorSampler, computeFit, prepField,
  waveHeadingAt, flowTangent, slopeAt, DRIFT_SHAPES, DRIFT_DARK, DRIFT_LIGHT, VB_W, VB_H,
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
    shape: "almond", density: 30, size: 1, spacing: 1,
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

test("the shapes point along the flow the generators set", () => {
  // With the relief at zero there is no rocking left, so the angle is the flow
  // direction and nothing else: a train running across the plane lays the
  // shapes flat, one running away from the camera stands them up.
  const med = (g) => {
    const v = g.cells.map((c) => Math.abs(c.a)).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  expect(med(grid({ ...swell(0), waveScale: 0 }))).toBeLessThan(25);
  expect(med(grid({ ...swell(90), waveScale: 0 }))).toBeGreaterThan(65);
}, 240000);

test("a crest and a trough lie the same way; the flank between them tips over", () => {
  // The rule stated as the user states it: level over the crest, level through
  // the trough, tilted on the flank, and tilted the OTHER way on the far flank.
  const { S } = buildScene({ ...GRAZING_RIPPLES, ...swell(90), waveScale: 9 });
  const fit = computeFit(S);
  prepField(S);
  const gx = 0, relief = S.waveScale, eps = (S.yMax - S.yMin) * 1e-3;
  const at = (gy) => {
    const [dx, dy] = waveHeadingAt(gx, gy, S);
    const [hx, hy] = slopeAt(gx, gy, S);
    const [tx, ty] = flowTangent(gx, gy, dx, dy, S, fit, relief, eps);
    return { gy, slope: hx * dx + hy * dy, a: (Math.atan2(ty, tx) * 180) / Math.PI };
  };
  // a wavelength's worth of the train, well inside the plane
  const line = [];
  for (let gy = 30; gy < 42; gy += 0.05) line.push(at(gy));
  const bySlope = [...line].sort((p, q) => Math.abs(p.slope) - Math.abs(q.slope));
  const level = bySlope.slice(0, 6);                 // the crest and the trough
  const up = line.reduce((b, p) => (p.slope > b.slope ? p : b));
  const down = line.reduce((b, p) => (p.slope < b.slope ? p : b));

  // the level points are a crest AND a trough — genuinely different places
  const heights = level.map((p) => p.gy).sort((a, b) => a - b);
  expect(heights[heights.length - 1] - heights[0]).toBeGreaterThan(1);
  // …and they lie at the same angle, to well under a degree
  const angles = level.map((p) => p.a);
  expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(1);

  // the two flanks tip off that angle, by a real amount and in opposite ways
  const base = angles[0];
  expect(up.a - base).toBeLessThan(-8);              // screen y runs down
  expect(down.a - base).toBeGreaterThan(8);
  // and by about as much either side, because a sine is symmetric about both
  expect(Math.abs(Math.abs(up.a - base) - Math.abs(down.a - base))).toBeLessThan(6);
}, 120000);

test("the shape leans the way the water climbs", () => {
  // A train running across the frame, where the tilt is unambiguous on screen:
  // where the water climbs along the flow, the downwind end of the shape has to
  // sit HIGHER in the picture than the upwind end.
  const { S } = buildScene({ ...GRAZING_RIPPLES, ...swell(0), waveScale: 9 });
  const fit = computeFit(S);
  prepField(S);
  const eps = (S.yMax - S.yMin) * 1e-3, gy = 12;
  const pts = [];
  for (let gx = -20; gx <= 20; gx += 0.2) {
    const [dx, dy] = waveHeadingAt(gx, gy, S);
    const [hx, hy] = slopeAt(gx, gy, S);
    pts.push({ gx, dx, dy, s: hx * dx + hy * dy });
  }
  const peak = Math.max(...pts.map((p) => Math.abs(p.s)));
  expect(peak).toBeGreaterThan(1e-3);              // the train is actually there
  let checked = 0;
  for (const p of pts) {
    if (Math.abs(p.s) < 0.3 * peak) continue;      // too level to judge
    const [tx, ty] = flowTangent(p.gx, gy, p.dx, p.dy, S, fit, S.waveScale, eps);
    // the flow runs +x on screen here, so the shape's own +x end is downwind
    const rising = tx > 0 ? ty < 0 : ty > 0;       // downwind end higher = lower y
    expect(rising).toBe(p.s > 0);
    checked++;
  }
  expect(checked).toBeGreaterThan(40);
}, 120000);

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
