import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import WaterReflectionContours, {
  buildPenHatch, HATCH_AIMS, prepField, reflectAt, magFrac, computeFit,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * Hatched pen style, over the saved scene
 *
 * The style's whole claim is that the change of slant draws the edge, so what
 * has to hold is: every region gets strokes, the strokes stay inside the
 * frame, and the per-region angles actually differ when the spread asks them
 * to (and stop differing when it doesn't). Rendering it to look at is the
 * other half — see CLAUDE.md.
 * ------------------------------------------------------------------ */

// the same color lookup the pen path builds for a 1D/preset scene
function colorLookup(S, cols, fracs) {
  const mag = S.reflMag || 1;
  return (gx, gy) => {
    const R = reflectAt(gx, gy, S);
    const phi = (Math.asin(Math.max(-1, Math.min(1, R[2]))) * 180) / Math.PI;
    let v = magFrac((phi - S.eLo) / ((S.eHi - S.eLo) || 1), mag);
    v = v < 0 ? 0 : v >= 1 ? 0.999999 : v;
    let idx = 0;
    for (const f of fracs) { if (v >= f) idx++; else break; }
    return cols[idx] || cols[0];
  };
}

function scene() {
  const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
  prepField(S);
  const mid = (S.eLo + S.eHi) / 2, span = (S.eHi - S.eLo) / (S.reflMag || 1);
  const fracs = fieldSpec.thresholds.map((t) => (t - mid) / span + 0.5);
  return { S, fit: computeFit(S), colorAt: colorLookup(S, fieldSpec.cols, fracs) };
}

const OPTS = {
  spacing: 5, relief: 45, threeD: true, angleDeg: 20, spreadDeg: 60,
  aim: "wave", tone: 0, paper: "#0a0d12", BW: 320, gN: 110,
};

const segments = (d) => (d.match(/M/g) || []).length;
const points = (d) => {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};
// every stroke's slant, as an angle folded into (-90, 90]
const slants = (pens) => {
  const out = [];
  for (const pen of pens) {
    const p = points(pen.d);
    for (let i = 0; i + 1 < p.length; i += 2) {
      const dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1];
      // short strokes carry the coordinate rounding as angle noise, so read
      // the slant only off ones long enough for it to mean something
      if (Math.hypot(dx, dy) < 8) continue;
      out.push(((((Math.atan2(dy, dx) * 180) / Math.PI + 90) % 180) + 180) % 180 - 90);
    }
  }
  return out;
};

test("hatches the saved scene into colored strokes inside the frame", () => {
  const { S, fit, colorAt } = scene();
  const pens = buildPenHatch(S, fit, colorAt, OPTS);
  expect(pens.length).toBeGreaterThan(3);          // several inks
  let total = 0;
  for (const pen of pens) {
    expect(pen.color).toMatch(/^#[0-9a-f]{6}$/i);
    const n = segments(pen.d);
    expect(n).toBeGreaterThan(0);
    total += n;
    for (const [x, y] of points(pen.d)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(760);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(500);
    }
  }
  expect(total).toBeGreaterThan(500);              // a weave, not a handful of lines
}, 120000);

test("every stroke is a straight two-point segment", () => {
  const { S, fit, colorAt } = scene();
  const pens = buildPenHatch(S, fit, colorAt, OPTS);
  for (const pen of pens) {
    // "M x y L x y " repeated: as many L commands as M commands, no curves
    expect((pen.d.match(/L/g) || []).length).toBe(segments(pen.d));
    expect(pen.d).not.toMatch(/[CQZ]/);
  }
}, 120000);

test("spread 0 lays one angle over the frame; the aims spread it out", () => {
  const { S, fit, colorAt } = scene();
  const flat = slants(buildPenHatch(S, fit, colorAt, { ...OPTS, spreadDeg: 0 }));
  expect(flat.length).toBeGreaterThan(100);
  for (const a of flat) expect(Math.abs(a - OPTS.angleDeg)).toBeLessThan(1);

  const spread = (aim) => {
    const a = slants(buildPenHatch(S, fit, colorAt, { ...OPTS, aim }));
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  };
  for (const [aim] of HATCH_AIMS) expect(spread(aim)).toBeGreaterThan(5);
}, 240000);

test("closer spacing lays down more ink, tone re-weights it by color", () => {
  const { S, fit, colorAt } = scene();
  const ink = (o) => buildPenHatch(S, fit, colorAt, { ...OPTS, ...o })
    .reduce((n, p) => n + segments(p.d), 0);
  const wide = ink({ spacing: 10 });
  expect(ink({ spacing: 3.5 })).toBeGreaterThan(wide * 1.5);
  // tone only ever thins a region out (it stretches the spacing of the ones
  // that sit close to the paper), so it can never add ink
  expect(ink({ tone: 1 })).toBeLessThan(ink({ tone: 0 }));
}, 240000);

test("the studio wires the hatched style up end to end", () => {
  // uiTab rides in the saved scene like any other setting — landing on the
  // Style workspace is itself part of the wiring under test
  const saved = { reflection: { ...GRAZING_RIPPLES, quality: 70, penMode: true, penStyle: "hatch", rasterQ: 0, uiTab: "style" } };
  const bytes = new TextEncoder().encode(JSON.stringify(saved));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  const hash = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  window.history.replaceState({}, "", "/?s=" + hash);
  render(<WaterReflectionContours />);

  expect(screen.getByText("Hatched")).toBeInTheDocument();
  expect(document.body.textContent).toMatch(/stroke spacing/);
  expect(document.body.textContent).toMatch(/hatch 20\u00b0\u00b160\u00b0/);
  for (const [, label] of HATCH_AIMS) expect(screen.getByText(label)).toBeInTheDocument();
  const drawn = () => document.querySelectorAll("svg path").length;
  expect(drawn()).toBeGreaterThan(3);
  fireEvent.click(screen.getByText("Scatter"));      // re-hatches without throwing
  expect(drawn()).toBeGreaterThan(3);
}, 300000);
