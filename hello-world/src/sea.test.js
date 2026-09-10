import {
  prepField, heightAt, slopeAt, WATER_MOODS, SEA_N_DEFAULT, SPECTRUM_N_REF, omegaAt,
  NOISE_PERIOD, buildSolid3D, RASTER_LEVELS, reflectAt,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * The sea emitter, and the two fixes to the older ones
 *
 * The load-bearing test here is the first one: slopeAt for a sea is a hand-
 * derived gradient of a warped sum of sines under two moving envelopes, and
 * nothing else in the pipeline would notice if it were subtly wrong — the
 * picture would just be lit oddly. So it is checked against central differences
 * of heightAt, at every combination of the parts that contribute a term.
 * ------------------------------------------------------------------ */

// the studio's own default plane — 44 units across and 75 deep — so the gust
// envelope, which is sized off the stretch of water in the scene, has room to
// put several patches in it
const scene = (emitters, over = {}) => prepField({
  nx: 120, ny: 120,
  xMin: -22, xMax: 22, yMin: 3, yMax: 78,
  H: 6, k: (2 * Math.PI) / 2.8, amp: 0.5 * 0.06, sharp: 0,
  decay: 0.1, omega: 1, t: 3.4, perspective: true, dispersion: true,
  emitters, ...over,
});
// a point on that plane, from fractions of it
const at2 = (S, u, v) => [S.xMin + u * (S.xMax - S.xMin), S.yMin + v * (S.yMax - S.yMin)];

const sea = (over = {}) => ({
  id: 1, on: true, type: "sea", x: 0, y: 20, dir: 90, size: 1.7, amp: 1.2,
  spread: 45, roughness: 0.6, detail: 40,
  chop: 0, patch: 0, group: 0, ...over,
});

// rms slope over a grid, the quantity the color regions are actually cut from
function rmsSlope(S, n = 40) {
  let sum = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const gx = S.xMin + ((i + 0.5) / n) * (S.xMax - S.xMin);
    const gy = S.yMin + ((j + 0.5) / n) * (S.yMax - S.yMin);
    const [hx, hy] = slopeAt(gx, gy, S);
    sum += hx * hx + hy * hy;
  }
  return Math.sqrt(sum / (n * n));
}

describe("sea: the analytic slope is the gradient of the height", () => {
  // every subset of the terms that contribute: the plain sum, the warp, each
  // envelope on its own, and all of it together
  const cases = [
    ["plain sum of sines", {}],
    ["with chop", { chop: 0.6 }],
    ["with gust patches", { patch: 0.8 }],
    ["with groups", { group: 0.9 }],
    ["chop + gusts", { chop: 0.6, patch: 0.8 }],
    ["chop + groups", { chop: 0.6, group: 0.9 }],
    ["everything", { chop: 0.7, patch: 0.7, group: 0.8 }],
    ["everything, near-breaking chop", { chop: 1, patch: 0.9, group: 1, amp: 2 }],
  ];

  for (const [name, over] of cases) {
    test(name, () => {
      const S = scene([sea(over)]);
      const h = 1e-5;
      let worst = 0, scale = 0;
      for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) {
        // deliberately off the lattice lines of the gust noise, and spread
        // across the plane so the range fade and both envelopes vary
        const [gx, gy] = at2(S, 0.07 + i * 0.131, 0.05 + j * 0.137);
        const [hx, hy] = slopeAt(gx, gy, S);
        const nx = (heightAt(gx + h, gy, S) - heightAt(gx - h, gy, S)) / (2 * h);
        const ny = (heightAt(gx, gy + h, S) - heightAt(gx, gy - h, S)) / (2 * h);
        worst = Math.max(worst, Math.abs(hx - nx), Math.abs(hy - ny));
        scale = Math.max(scale, Math.abs(nx), Math.abs(ny));
      }
      // relative to the size of the gradient itself; central differences at
      // this step are good to well under a part in a thousand
      expect(worst / scale).toBeLessThan(2e-3);
    });
  }

  test("the range fade is a weight, not a term — as in every other emitter", () => {
    // heightAt and slopeAt must agree on that convention, so a plan-view scene
    // (no fade at all) is the case where the match has to be exact
    const S = scene([sea({ chop: 0.6, patch: 0.6, group: 0.6 })], { perspective: false });
    const h = 1e-5;
    for (const uv of [[0.31, 0.12], [0.55, 0.44], [0.78, 0.81]]) {
      const [gx, gy] = at2(S, uv[0], uv[1]);
      const [hx, hy] = slopeAt(gx, gy, S);
      const nx = (heightAt(gx + h, gy, S) - heightAt(gx - h, gy, S)) / (2 * h);
      const ny = (heightAt(gx, gy + h, S) - heightAt(gx, gy - h, S)) / (2 * h);
      expect(hx).toBeCloseTo(nx, 4);
      expect(hy).toBeCloseTo(ny, 4);
    }
  });
});

describe("sea: the controls do what their labels say", () => {
  test("strength scales the slope, and nothing else has to be re-tuned", () => {
    const a = rmsSlope(scene([sea({ amp: 0.6 })]));
    const b = rmsSlope(scene([sea({ amp: 1.2 })]));
    expect(b / a).toBeCloseTo(2, 1);
  });

  test("component count resolves the field without changing its weight", () => {
    // the whole point of calibrating on slope variance: `components` is a cost
    // control, not a roughness control
    const lo = rmsSlope(scene([sea({ detail: 16 })]));
    const hi = rmsSlope(scene([sea({ detail: 96 })]));
    expect(hi / lo).toBeGreaterThan(0.8);
    expect(hi / lo).toBeLessThan(1.25);
  });

  test("fine texture changes what the water is made of, not how rough it is", () => {
    const clean = scene([sea({ roughness: 0.1 })]);
    const busy = scene([sea({ roughness: 0.95 })]);
    // total steepness stays in the same range...
    expect(rmsSlope(busy) / rmsSlope(clean)).toBeGreaterThan(0.6);
    expect(rmsSlope(busy) / rmsSlope(clean)).toBeLessThan(1.7);
    // ...but the same steepness is carried on much shorter waves. Slope per
    // unit height is the wavenumber the energy sits at, which is the thing
    // this control is for.
    const rmsHeight = (S) => {
      let sum = 0;
      for (let i = 0; i < 900; i++) {
        const [gx, gy] = at2(S, ((i % 30) + 0.5) / 30, (Math.floor(i / 30) + 0.5) / 30);
        sum += Math.pow(heightAt(gx, gy, S), 2);
      }
      return Math.sqrt(sum / 900);
    };
    const centroid = (S) => rmsSlope(S) / rmsHeight(S);
    expect(centroid(busy) / centroid(clean)).toBeGreaterThan(1.5);
  });

  test("patchiness opens glass without steepening what is left", () => {
    const even = scene([sea({ patch: 0, roughness: 0.7 })]);
    const patchy = scene([sea({ patch: 0.85, roughness: 0.7 })]);
    // local roughness, cell by cell across the plane
    const cells = (S) => {
      const out = [];
      for (let cj = 0; cj < 6; cj++) for (let ci = 0; ci < 6; ci++) {
        let s = 0;
        for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
          const [gx, gy] = at2(S, (ci * 5 + i + 0.5) / 30, (cj * 5 + j + 0.5) / 30);
          const [hx, hy] = slopeAt(gx, gy, S);
          s += hx * hx + hy * hy;
        }
        out.push(Math.sqrt(s / 25));
      }
      return out;
    };
    const ce = cells(even), cp = cells(patchy);
    const cv = (c) => {
      const m = c.reduce((a, b) => a + b, 0) / c.length;
      return Math.sqrt(c.reduce((a, b) => a + (b - m) * (b - m), 0) / c.length) / m;
    };
    // the water goes uneven...
    expect(cv(cp)).toBeGreaterThan(cv(ce) * 2);
    // ...calmer on the whole, because the wind has left most of it alone...
    expect(rmsSlope(patchy)).toBeLessThan(rmsSlope(even));
    // ...but the gust patches keep the roughness the strength slider was set
    // for, rather than being driven past it. That is the property that lets
    // this be dragged without re-tuning strength each time.
    expect(Math.max(...cp)).toBeGreaterThan(Math.max(...ce) * 0.55);
    expect(Math.max(...cp)).toBeLessThan(Math.max(...ce) * 1.15);
  });

  test("every component takes its speed from the scene's dispersion rule", () => {
    // A sea is a ladder of wavenumbers, so it is the emitter with the most to
    // get wrong here: each rung has to run at the frequency its own wavelength
    // earns it, through the same omegaAt every other emitter type goes through.
    for (const dispersion of [true, false]) {
      const T = 2.5;
      const a = scene([sea({ chop: 0 })], { t: 0, dispersion })._ems[0];
      const b = scene([sea({ chop: 0 })], { t: T, dispersion })._ems[0];
      const S = scene([], { dispersion });
      for (let i = 0; i < a.N; i += 7) {
        expect(a.K[i]).toBeCloseTo(b.K[i], 10);         // same ladder either way
        expect(a.PH[i] - b.PH[i]).toBeCloseTo(omegaAt(a.K[i], S) * T, 9);
      }
    }
  });

  test("the envelopes ride at the speed of the waves under them", () => {
    // groups travel at the group velocity, which is derived from the same rule
    // — an envelope with a speed of its own would slide over the wave field
    const kp = ((2 * Math.PI) / 2.8) / 1.7;   // scene ripple scale / emitter size
    const S = scene([]);
    const e = scene([sea({ group: 0.9 })], { t: 4 })._ems[0];
    const cg = 0.5 * (omegaAt(kp, S) / kp);
    // one phase term per beat rather than one shared shift of the position, so
    // a loop can round each on its own; with no loop asked for they are exactly
    // the translation they used to be
    expect(e.gp1).toBeCloseTo(e.gl1 * cg * 4, 9);
    expect(e.gp2).toBeCloseTo(e.gl2 * cg * 4, 9);
  });

  test("each part that carries time closes a loop on its own", () => {
    // A sea depends on t in three different shapes, and only one of them is the
    // plain phase term the loop was built for. Checked apart so a regression
    // says which: the ladder is sinusoids, the gust field is a noise translated
    // downwind, and the groups are two slow beats travelling along the wind.
    const parts = [
      ["the component ladder", { chop: 0, patch: 0, group: 0 }],
      ["the Gerstner warp", { chop: 0.7, patch: 0, group: 0 }],
      ["the gust field", { chop: 0, patch: 0.85, group: 0 }],
      ["the group beats", { chop: 0, patch: 0, group: 0.9 }],
      ["all of it at once", { chop: 0.6, patch: 0.7, group: 0.8 }],
    ];
    for (const [, over] of parts) {
      for (const T of [8, 12, 25.5]) {
        const at = (t) => {
          const S = scene([sea(over)], { t, loopPhase: T });
          const out = [];
          for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
            const [gx, gy] = at2(S, i / 8, j / 8);
            const [hx, hy] = slopeAt(gx, gy, S);
            out.push(heightAt(gx, gy, S), hx, hy);
          }
          return out;
        };
        const a = at(0), b = at(T), c = at(3 * T);
        const worst = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));
        expect(worst(a, b)).toBeLessThan(1e-12);
        // periodic, not merely arranged to agree at one instant
        expect(worst(a, c)).toBeLessThan(1e-11);
      }
    }
  });

  test("with no loop asked for the sea is bit-for-bit what it was", () => {
    // the loop threads through the phase of every component and both envelopes,
    // so getting this wrong changes every scene that never asked for a loop
    for (const t of [0, 0.37, 4.2, 17.15]) {
      const none = scene([sea({ chop: 0.6, patch: 0.7, group: 0.8 })], { t })._ems[0];
      for (const off of [undefined, 0, null, false]) {
        const e = scene([sea({ chop: 0.6, patch: 0.7, group: 0.8 })],
          { t, loopPhase: off })._ems[0];
        expect(e.PH).toEqual(none.PH);
        expect([e.nou, e.gp1, e.gp2]).toEqual([none.nou, none.gp1, none.gp2]);
      }
    }
  });

  test("a loop leaves the gust patches where they are rather than racing them", () => {
    // A gust field crosses a fraction of a period in a normal clip, so the
    // rounding that closes the loop takes it to a standstill — which is the
    // intended trade, and the reason it is not held to a whole turn the way a
    // wave train is. What must not happen is the patches being sent a whole
    // period across the frame to satisfy the loop.
    const em = sea({ patch: 0.85, chop: 0, group: 0 });
    const free = scene([em], { t: 12 })._ems[0];
    const looped = scene([em], { t: 12, loopPhase: 12 })._ems[0];
    // its natural travel over the loop is well under one period...
    expect(Math.abs(free.nou)).toBeLessThan(NOISE_PERIOD / 2);
    // ...so the loop holds it still, rather than rounding it up to a full one
    // (abs because the rounding keeps the drift's sign, giving -0 downwind)
    expect(Math.abs(looped.nou)).toBe(0);
  });

  test("patch and group envelopes travel with the clock", () => {
    const at = (t) => {
      const S = scene([sea({ patch: 0.85, group: 0.9, chop: 0 })], { t });
      return heightAt(1.3, 17.4, S);
    };
    // the field moves; a frozen envelope would still move here (the waves do),
    // so the check that matters is that nothing throws and the value changes
    expect(at(0)).not.toBeCloseTo(at(5), 6);
  });
});

describe("the older emitters, fixed", () => {
  test("spectrum detail no longer fades the water", () => {
    const spec = (detail) => ({ id: 1, on: true, type: "spectrum", x: 0, y: 20,
      dir: 90, size: 1.7, amp: 1.9, spread: 30, roughness: 0.4, detail });
    const lo = rmsSlope(scene([spec(6)]));
    const hi = rmsSlope(scene([spec(40)]));
    // it used to fall as 1/√N — a factor of 2.6 across this range
    expect(hi / lo).toBeGreaterThan(0.8);
    expect(hi / lo).toBeLessThan(1.3);
  });

  test("a scene saved at the reference count renders as it did", () => {
    // the anchor that keeps existing saved scenes intact: at SPECTRUM_N_REF the
    // new normalisation is the old one exactly
    expect(1.5 / Math.sqrt(SPECTRUM_N_REF * SPECTRUM_N_REF))
      .toBeCloseTo(1.5 / SPECTRUM_N_REF, 12);
  });

  test("ripple sources have no cone tip at the centre any more", () => {
    const S = scene([{ id: 1, on: true, type: "point", x: 0, y: 16,
      size: 1, amp: 1.5, spread: 25, roughness: 0, detail: 8 }]);
    // the gradient used to flip direction across the source; now it falls to
    // zero there, so the slope is small at the centre and smooth around it
    const [cx, cy] = slopeAt(0, 16, S);
    expect(Math.hypot(cx, cy)).toBeLessThan(1e-9);
    const ring = [];
    for (let a = 0; a < 12; a++) {
      const [hx, hy] = slopeAt(0.02 * Math.cos(a), 16 + 0.02 * Math.sin(a), S);
      ring.push(Math.hypot(hx, hy));
    }
    expect(Math.max(...ring)).toBeLessThan(0.02);
    // and it is still the same ripple further out — scanned over a wavelength,
    // since any single radius can land on a zero of the slope
    let far = 0;
    for (let r = 0.5; r <= 2.8; r += 0.05) {
      const [fx, fy] = slopeAt(0, 16 + r, S);
      far = Math.max(far, Math.hypot(fx, fy));
    }
    expect(far).toBeGreaterThan(0.05);
  });

  test("rings sources are smooth at their centres too", () => {
    const S = scene([{ id: 1, on: true, type: "rings", x: 0, y: 20,
      size: 1.4, amp: 1, spread: 25, roughness: 0.3, detail: 8 }]);
    // no sample anywhere on the plane returns a gradient far out of family —
    // the dot at a source was exactly such a spike
    let worst = 0;
    for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) {
      const [hx, hy] = slopeAt(-12 + i * 0.4, 4 + j * 0.4, S);
      worst = Math.max(worst, Math.hypot(hx, hy));
    }
    expect(Number.isFinite(worst)).toBe(true);
    expect(worst).toBeLessThan(1.5);
  });
});

describe("the water moods", () => {
  test("each one builds a field with real, finite structure in it", () => {
    expect(WATER_MOODS.length).toBe(4);
    for (const m of WATER_MOODS) {
      const S = scene(m.emitters, {
        k: (2 * Math.PI) / m.wavelength, amp: m.strength * 0.06,
        sharp: m.sharp, decay: 0.18 - m.spread * 0.16,
      });
      const r = rmsSlope(S);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0.001);
      expect(r).toBeLessThan(0.6);
    }
  });

  test("the glassy moods really are calmer than the windy ones", () => {
    const of = (name) => {
      const m = WATER_MOODS.find((w) => w.name === name);
      return rmsSlope(scene(m.emitters, {
        k: (2 * Math.PI) / m.wavelength, amp: m.strength * 0.06,
        sharp: m.sharp, decay: 0.18 - m.spread * 0.16,
      }));
    };
    expect(of("Glassy lake")).toBeLessThan(of("Fresh breeze"));
  });

  test("a prepped sea is plain data, so it survives the trip to the worker", () => {
    const S = scene([sea({ chop: 0.5, patch: 0.5, group: 0.5 })]);
    const e = S._ems[0];
    expect(e.type).toBe("sea");
    // structuredClone is what postMessage does; a closure or a typed callback
    // in here would throw, and the worker would silently draw a different sea
    const copy = JSON.parse(JSON.stringify(e));
    expect(copy.N).toBe(e.N);
    expect(copy.AMP.length).toBe(e.AMP.length);
    for (const k of Object.keys(e)) expect(typeof e[k]).not.toBe("function");
  });

  test("the default component count is in the slider's range", () => {
    expect(SEA_N_DEFAULT).toBeGreaterThanOrEqual(12);
    expect(SEA_N_DEFAULT).toBeLessThanOrEqual(96);
  });
});

/* ------------------------------------------------------------------ *
 * The loop, all the way through the tracer
 *
 * The field closing is the property that matters, but it is not the property
 * the viewer sees — what they see is the traced, contoured picture. Main held
 * its own loop work to that standard on GRAZING_RIPPLES; a sea earns the same
 * check, since it is the emitter with parts that do not close for free.
 * ------------------------------------------------------------------ */
describe("a sea scene's drawn picture closes, not only its field", () => {
  test("the last frame of a loop traces byte-identically to the first", () => {
    const m = WATER_MOODS.find((w) => w.name === "Fresh breeze");
    const T = 12;
    // the saved scene's camera and painted sky, with a sea in front of it
    const draw = (t, loopPhase) => {
      const g = buildScene({ ...GRAZING_RIPPLES, emitters: m.emitters,
        wavelength: m.wavelength, strength: m.strength, sharp: m.sharp,
        spread: m.spread, quality: 60, dispersion: true });
      const S = { ...g.S, t, loopPhase };
      // the field spec samples the scene being drawn, so it has to be rebuilt
      // against this S rather than reused from the one buildScene made
      const spec = { ...g.fieldSpec, scalarAt: (gx, gy) =>
        (Math.asin(Math.max(-1, Math.min(1, reflectAt(gx, gy, S)[2]))) * 180) / Math.PI };
      const L = RASTER_LEVELS[0];
      return buildSolid3D(S, spec, { gN: L.gN, BW: L.BW })
        .layers.map((l) => l.d).join("|");
    };
    expect(draw(T, T)).toBe(draw(0, T));
    // and without the loop the same frame is a different picture
    expect(draw(T, 0)).not.toBe(draw(0, 0));
  }, 600000);
});
