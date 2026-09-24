// The sand studio's renderer: the height field's shape, the camera's
// sampling, and the promise that the file is the preview.
import {
  sandHeight, prepFeatures, newFeature, heightSpan, lodFade, LOD_LO, LOD_HI, FEATURE_TYPES,
  DEFECT_CELL,
} from "./field";
import { buildSand, sandSvg, sampleSand, renderSand, SAND_DEFAULTS } from "./render";
import { SAND_PRESETS } from "./presets";

const only = (type, patch) => prepFeatures([{ ...newFeature(type, 1), ...patch }]);

describe("height field", () => {
  test("off, zero-height and unknown features contribute nothing", () => {
    expect(prepFeatures([{ ...newFeature("dunes", 1), on: false }])).toHaveLength(0);
    expect(prepFeatures([{ ...newFeature("wind", 1), amp: 0 }])).toHaveLength(0);
    expect(prepFeatures([{ id: 1, on: true, type: "nope", amp: 1, lambda: 1 }])).toHaveLength(0);
    expect(sandHeight([], 3, 4)).toBe(0);
  });

  test("is deterministic, and a different seed is different sand", () => {
    const a = only("current", { seed: 5 }), b = only("current", { seed: 6 });
    let same = 0, diff = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.013, y = i * 0.007;
      const h1 = sandHeight(a, x, y), h2 = sandHeight(a, x, y);
      if (h1 === h2) same++;
      if (sandHeight(a, x, y) !== sandHeight(b, x, y)) diff++;
    }
    expect(same).toBe(200);
    expect(diff).toBeGreaterThan(150);
  });

  test("stays within the span it reports", () => {
    for (const type of FEATURE_TYPES) {
      const P = only(type), span = heightSpan(P);
      const lam = P[0].lambda;
      for (let i = 0; i < 400; i++) {
        const h = sandHeight(P, (i % 20) * lam * 0.37, Math.floor(i / 20) * lam * 0.41);
        expect(Math.abs(h)).toBeLessThanOrEqual(span + 1e-9);
      }
    }
  });

  // Each bedform's steep side faces where its wind or water is going: along
  // the flow the surface climbs gently for most of a wavelength and drops in
  // the rest. So more of the ground slopes up than down, and the down-slopes
  // are the steeper ones.
  test("ripples and dunes are asymmetric, steep side downwind", () => {
    for (const type of ["dunes", "wind", "current"]) {
      const P = only(type, { dir: 90, wander: 0, asym: 0.8, defects: 0, tongues: 0, breakup: 0 });
      const lam = P[0].lambda, e = lam / 400;
      let up = 0, down = 0, upMax = 0, downMax = 0;
      for (let i = 0; i < 2000; i++) {
        const x = i * lam * 0.0031, y = 0.3 * lam;
        const g = (sandHeight(P, x + e, y) - sandHeight(P, x - e, y)) / (2 * e);
        if (g > 0) { up++; upMax = Math.max(upMax, g); } else { down++; downMax = Math.max(downMax, -g); }
      }
      expect(up).toBeGreaterThan(down * 1.5);
      expect(downMax).toBeGreaterThan(upMax * 1.5);
    }
  });

  // The forks are phase dislocations summed over a neighbourhood of scatter
  // cells. If a pair's reach ever ran past that neighbourhood, the field
  // would jump exactly where a cell boundary cut it off. So step across
  // every boundary line, a hair either side, all along it, with forks
  // everywhere. (Away from the boundaries the field is only ever sharp at a
  // fork's own core, where every crest meets — which is the fork.)
  test("wind-ripple forks leave no seams at the scatter-cell boundaries", () => {
    const P = only("wind", { dir: 90, defects: 1, wander: 0.2, asym: 0.3 });
    const lam = P[0].lambda, amp = P[0].amp, eps = lam * 1e-6, C = DEFECT_CELL * lam;
    let worst = 0;
    for (let k = -3; k <= 3; k++) {
      for (let i = 0; i < 600; i++) {
        const along = (i - 300) * lam * 0.083;
        // heading 90°: flow-aligned u runs along x, and v along -y
        worst = Math.max(worst,
          Math.abs(sandHeight(P, k * C - eps, along) - sandHeight(P, k * C + eps, along)),
          Math.abs(sandHeight(P, along, k * C - eps) - sandHeight(P, along, k * C + eps)));
      }
    }
    expect(worst).toBeLessThan(amp * 0.01);
  });

  test("a feature too fine for the footprint fades out instead of aliasing", () => {
    const P = only("wind");
    const lam = P[0].lambda;
    expect(lodFade(lam, lam / (LOD_HI + 1))).toBe(1);
    expect(lodFade(lam, lam / (LOD_LO - 0.5))).toBe(0);
    const coarse = [lam, lam, 0, 1];
    for (let i = 0; i < 50; i++) expect(sandHeight(P, i * 0.37, i * 0.11, coarse)).toBe(0);
  });

  test("ripples lie flat on a dune's slip face", () => {
    const dune = { ...newFeature("dunes", 1), dir: 90, wander: 0, breakup: 0, asym: 0.8 };
    const wind = { ...newFeature("wind", 2), dir: 90, defects: 0, wander: 0 };
    const both = prepFeatures([dune, wind]), bare = prepFeatures([dune]);
    const lam = dune.lambda;
    // the lee face of a dune with asymmetry 0.8 is the last ~20% of each
    // wavelength along the wind; the stoss is the rest
    const rough = (x0, x1) => {
      let r = 0;
      for (let i = 0; i < 400; i++) {
        const x = x0 + ((x1 - x0) * i) / 400;
        r += Math.abs(sandHeight(both, x, 1.7) - sandHeight(bare, x, 1.7));
      }
      return r / 400;
    };
    const s = 0.5 + 0.38 * 0.8;
    expect(rough((s + 0.05) * lam, 0.9 * lam)).toBeLessThan(rough(0.2 * lam, 0.6 * lam) * 0.3);
  });
});

describe("rendering", () => {
  const plan = {
    ...SAND_DEFAULTS, view: "plan", planWidth: 3, features: [newFeature("current", 1)],
    sunEl: 20, bands: 5,
  };

  test("a plan view gives one layer per band, the first the whole frame", () => {
    const out = buildSand(plan, 120);
    expect(out.layers).toHaveLength(5);
    expect(out.layers[0].d).toBeNull();
    for (const l of out.layers.slice(1)) {
      expect(typeof l.d).toBe("string");
      expect(l.d.length).toBeGreaterThan(0);
      expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("the preview and the file are the same string", () => {
    const a = renderSand(plan, 120), b = sandSvg(plan, buildSand(plan, 120));
    expect(a.svg).toBe(b);
    expect(a.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 500">')).toBe(true);
  });

  test("the frame shape sets the view box", () => {
    expect(renderSand({ ...plan, frame: "portrait" }, 80).svg).toContain('viewBox="0 0 500 760"');
    expect(renderSand({ ...plan, frame: "square" }, 80).svg).toContain('viewBox="0 0 600 600"');
  });

  test("cast shadows darken the sand beyond what faces away from the sun", () => {
    const S = { ...SAND_DEFAULTS, view: "plan", planWidth: 200, sunEl: 8, antialias: 0,
      features: [{ ...newFeature("dunes", 1), breakup: 0 }] };
    const mean = (R) => R.val.reduce((a, b) => a + b, 0) / R.val.length;
    const lit = mean(sampleSand({ ...S, shadows: false }, 100));
    const shaded = mean(sampleSand({ ...S, shadows: true }, 100));
    expect(shaded).toBeLessThan(lit - 0.02);
  });

  test("a perspective view has sky above a traced skyline", () => {
    const S = { ...SAND_DEFAULTS, horizon: 0.3 };
    const out = buildSand(S, 120);
    expect(out.ground).toBeTruthy();
    const svg = sandSvg(S, out);
    expect(svg).toContain(`fill="${out.sky}"`);
    // the skyline lies near the horizon line, a third of the way down
    const R = sampleSand(S, 120);
    let skyRows = 0;
    for (let j = 0; j < R.RH; j++) if (!R.cov[j * R.RW + Math.floor(R.RW / 2)]) skyRows++;
    expect(skyRows / R.RH).toBeGreaterThan(0.15);
    expect(skyRows / R.RH).toBeLessThan(0.45);
  });

  test("lines mode strokes the band edges on paper", () => {
    const S = { ...plan, style: "lines", colorBy: "height", bands: 8 };
    const svg = renderSand(S, 100).svg;
    expect(svg).toContain('fill="none" stroke=');
    expect((svg.match(/<path /g) || []).length).toBeGreaterThanOrEqual(7);
  });

  // A guard on the cost, not the picture: every starting point has to stay
  // quick enough to drag a slider on. Counted in sampled nodes, which is
  // what the time goes as.
  test("every starting point renders, and within a node budget", () => {
    for (const p of SAND_PRESETS) {
      const S = { ...SAND_DEFAULTS, ...p.scene };
      const out = buildSand(S, 160);
      expect(out.layers.length).toBe(S.bands);
      expect(out.stats.nodes).toBeLessThan(160 * 1400);
    }
  });
});
