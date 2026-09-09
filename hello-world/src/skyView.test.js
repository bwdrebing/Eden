import * as d3 from "d3";
import {
  buildSkyRegions, buildSkyBands, skyRayField, computeFit, horizonRaw, SKY_PAD, SKY_BW,
  envFromRows, VB_H,
} from "./WaterReflectionContours";
import { compileBackdrop } from "./backdrop/compile";
import { docFromPanorama } from "./backdrop/document";

/* ------------------------------------------------------------------ *
 * The backdrop, drawn
 *
 * The sky pass inverts the projection — screen point back to view ray — which
 * is the one piece of new arithmetic in this path. A sign error in it would
 * still produce a plausible-looking picture, so these check the inversion
 * against the closed form: a view ray at elevation e leaves the camera at
 * raw projected height -tan(pitch + e).
 * ------------------------------------------------------------------ */

const scene = (extra = {}) => ({
  nx: 96, ny: 96, xMin: -16, xMax: 16, yMin: 6, yMax: 60,
  H: 0.4 * Math.pow(22.5, 0.7), pitch: (25 * Math.PI) / 180,
  perspective: true, rectOutput: false, zoom: 1, panX: 0, panY: 0, smooth: 3,
  eLo: -5, eHi: 33, reflMag: 1, skyPad: SKY_PAD, ...extra,
});

// screen y where a ray of elevation e crosses the frame's center column
const screenYOf = (S, fit, e) =>
  fit.oy + (fit.scaleY || fit.scale) * -Math.tan(S.pitch + (e * Math.PI) / 180);

describe("inverting the projection", () => {
  const S = scene(), fit = computeFit(S);
  const R = skyRayField(S, fit, SKY_BW);

  test("the frame includes sky once it is asked to", () => {
    expect(R).not.toBeNull();
    expect(screenYOf(S, fit, 0)).toBeGreaterThan(0);
    expect(screenYOf(S, fit, 0)).toBeLessThan(VB_H);
  });

  // the center column, top to bottom
  const colAt = (frac) => {
    const i = Math.round(frac * (R.BW - 1));
    return d3.range(R.BH).map((j) => ({ j, phi: R.phi[j * R.BW + i], sky: R.sky[j * R.BW + i] }));
  };

  test("elevation falls as the eye goes down the frame, and stops at the horizon", () => {
    const col = colAt(0.5).filter((c) => c.sky);
    expect(col.length).toBeGreaterThan(10);
    for (let k = 1; k < col.length; k++) expect(col[k].phi).toBeLessThan(col[k - 1].phi);
    expect(col[col.length - 1].phi).toBeLessThan(1.5);   // last sky row is at the horizon
    expect(col[col.length - 1].phi).toBeGreaterThan(0);
  });

  test("each elevation lands where -tan(pitch + e) says it does", () => {
    const col = colAt(0.5).filter((c) => c.sky);
    for (const e of [2, 8, 20, 35]) {
      // the row whose elevation is closest to e, converted back to screen y
      let best = col[0];
      for (const c of col) if (Math.abs(c.phi - e) < Math.abs(best.phi - e)) best = c;
      if (Math.abs(best.phi - e) > 1) continue;          // e not in frame, skip
      const y = ((best.j + 0.5) * VB_H) / R.BH;
      expect(y).toBeCloseTo(screenYOf(S, fit, best.phi), 0);
    }
  });

  test("the horizon separates sky from water, exactly", () => {
    const yHor = screenYOf(S, fit, 0);
    for (const c of colAt(0.5)) {
      const y = ((c.j + 0.5) * VB_H) / R.BH;
      if (y < yHor - 2) expect(c.sky).toBe(1);
      if (y > yHor + 2) expect(c.sky).toBe(0);
    }
    expect(horizonRaw(S)).toBeCloseTo(-Math.tan(S.pitch), 12);
  });

  test("azimuth is zero dead ahead and grows across the frame", () => {
    const mid = Math.round(R.BH * 0.15) * R.BW;
    const at = (frac) => R.psi[mid + Math.round(frac * (R.BW - 1))];
    expect(Math.abs(at(0.5))).toBeLessThan(1);   // the center pixel is a pixel off center
    expect(at(0.9)).toBeGreaterThan(at(0.5));
    expect(at(0.1)).toBeLessThan(at(0.5));
  });
});

describe("drawing the backdrop", () => {
  test("preset and 1D backdrops come out as bands, bottom colour first", () => {
    const S = scene(), fit = computeFit(S);
    const cols = ["#141d33", "#3f5f93", "#9cc3e8", "#f2f7fb"];
    const layers = buildSkyBands(S, fit, [4, 14, 24], cols);
    expect(layers.length).toBeGreaterThan(1);
    expect(layers[0].color).toBe(cols[0]);
    expect(layers.map((l) => l.color)).toEqual(cols.slice(0, layers.length));
    for (const l of layers) expect(l.d).toMatch(/^[ML]/);
  });

  test("painted backdrops come out as their regions", () => {
    const S = scene(), fit = computeFit(S);
    const bd = compileBackdrop(docFromPanorama(
      envFromRows((f) => (f < 0.4 ? "#141d33" : f < 0.7 ? "#3f5f93" : "#cfe1ef"), 84, 52)));
    const layers = buildSkyRegions(S, fit, bd, 45);
    expect(layers.length).toBeGreaterThan(0);
    expect(layers[0].color).toBe("#141d33");
  });

  test("nothing is drawn when the horizon is out of frame", () => {
    // the saved scene's framing: zoomed 22.8x into the water, horizon far above
    const S = scene({ zoom: 22.8, panY: 1.17, skyPad: 0 });
    expect(buildSkyBands(S, computeFit(S), [4, 14], ["#111111", "#222222", "#333333"])).toBeNull();
  });

  test("nothing is drawn without a perspective camera", () => {
    const S = scene({ perspective: false });
    expect(buildSkyBands(S, computeFit(S), [4], ["#111111", "#222222"])).toBeNull();
  });

  test("a backdrop past the region cap is left to the water", () => {
    const S = scene(), fit = computeFit(S);
    const cells = new Array(84 * 52);
    for (let p = 0; p < cells.length; p++) cells[p] = "#" + (0x100000 + p).toString(16);
    const bd = compileBackdrop(docFromPanorama({ w: 84, h: 52, cells }));
    expect(bd.overflow).toBe(true);
    expect(buildSkyRegions(S, fit, bd, 45)).toBeNull();
  });

  test("asking for sky reframes the picture to hold the horizon", () => {
    const S = scene();
    const yHor = (fit) => fit.oy + (fit.scaleY || fit.scale) * horizonRaw(S);
    const plain = yHor(computeFit(scene({ skyPad: 0 })));
    const withSky = yHor(computeFit(S));
    // the pad moves the horizon down the frame, which is what makes room for
    // sky above it. (How much room the water was already leaving depends on
    // which dimension the fit binds on, so this is a comparison, not a bound.)
    expect(withSky).toBeGreaterThan(plain);
    expect(withSky).toBeGreaterThan(0);
    expect(withSky).toBeLessThan(VB_H);
  });

  test("the water keeps the frame to itself when the backdrop is off", () => {
    const S = scene();
    const plain = computeFit(scene({ skyPad: 0 })), withSky = computeFit(S);
    // whatever the fit does to scale, the sky pad only ever moves the picture
    // down the frame — it never crops the water off the bottom
    expect(withSky.oy).toBeGreaterThan(plain.oy - 1e-9);
  });
});
