import {
  prepField, heightAt, slopeAt, loopOmega, loopFit, EMITTER_RATE_DEFAULT,
} from "./WaterReflectionContours";
import {
  framePlan, loopSeconds, loopPhaseRange, PHASE_PER_SEC,
  VIDEO_FPS, VIDEO_MIN_SEC, VIDEO_MAX_SEC, VIDEO_LOOP_DEFAULT_PHASE,
} from "./videoExport";
import { GRAZING_RIPPLES, HARBOR_WAKE, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * Perfect loop
 *
 * A video export normally ends wherever the phase got to, which on water made
 * of incommensurate frequencies is nowhere near where it started. The loop
 * option rounds every component's frequency to a whole number of cycles in the
 * clip, which makes the whole field periodic over exactly that span.
 *
 * What is pinned here: that the field really does close on itself, for every
 * emitter type; that closing it costs tempo and nothing else — the first frame
 * is untouched and so is every wavelength, heading and amplitude; and, above
 * all, that with the option off not one number in the field has moved.
 * ------------------------------------------------------------------ */

// A scene with one of each emitter, so the closure test covers every branch of
// prepEmitter rather than whichever two a fixture happens to use.
const everyType = (t, loopPhase, extra = {}) => ({
  nx: 24, ny: 24, xMin: -12, xMax: 12, yMin: 4, yMax: 34,
  H: 6, pitch: 0.7, k: (2 * Math.PI) / 2, amp: 0.06, sharp: 0.3, decay: 0.1,
  omega: 1, t, loopPhase, bands: 4, perspective: true, eLo: 0, eHi: 20,
  zoom: 1, panX: 0, panY: 0, smooth: 0, surface3d: false, waveScale: 1,
  dispersion: true,
  emitters: [
    { id: 1, on: true, type: "swell", x: 0, y: 12, dir: 20, size: 3.1,
      amp: 1, spread: 0, roughness: 0, detail: 8 },
    { id: 2, on: true, type: "spectrum", x: 0, y: 12, dir: 110, size: 1.4,
      amp: 0.9, spread: 40, roughness: 0.3, detail: 11 },
    { id: 3, on: true, type: "rings", x: 0, y: 12, dir: 90, size: 0.9,
      amp: 0.7, spread: 20, roughness: 0.5, detail: 7 },
    { id: 4, on: true, type: "point", x: 2, y: 14, dir: 0, size: 1.2,
      amp: 1.2, spread: 0, roughness: 0, detail: 8 },
    { id: 5, on: true, type: "wake", x: -3, y: 20, dir: 30, scale: 5,
      amp: 0.6, len: 8, detail: 0.3, angle: 19.5 },
    // every part of a sea that moves is switched on here: the component ladder,
    // the Gerstner warp that rides it, the gust field that drifts downwind and
    // the group beats that travel along it. Three different ways of depending
    // on t, and a loop has to close all three.
    { id: 6, on: true, type: "sea", x: 0, y: 12, dir: 70, size: 1.1,
      amp: 0.8, spread: 50, roughness: 0.6, detail: 20,
      chop: 0.5, patch: 0.7, group: 0.6 },
  ],
  ...extra,
});

// The field itself — height and both slope components, which is everything
// downstream of the emitters reads.
function sample(S) {
  prepField(S);
  const out = [];
  for (let i = 0; i < 11; i++) {
    for (let j = 0; j < 11; j++) {
      const gx = S.xMin + ((S.xMax - S.xMin) * i) / 10;
      const gy = S.yMin + ((S.yMax - S.yMin) * j) / 10;
      const [hx, hy] = slopeAt(gx, gy, S);
      out.push(heightAt(gx, gy, S), hx, hy);
    }
  }
  return out;
}
const worstDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

// ---- off changes nothing -------------------------------------------

test("with no loop asked for, the field is bit-for-bit what it always was", () => {
  // Not "close": identical. The loop threads through the one place every
  // emitter's phase is computed, so the cost of getting this wrong is that
  // every existing scene, export and saved link renders differently.
  for (const t of [0, 0.37, 4.2, 17.15]) {
    const none = sample(everyType(t, 0));
    for (const off of [undefined, 0, null, false]) {
      expect(sample(everyType(t, off))).toEqual(none);
    }
  }
});

test("a scene that predates the option renders exactly as it did", () => {
  for (const fixture of [GRAZING_RIPPLES, HARBOR_WAKE]) {
    const S = buildScene({ ...fixture, quality: 40 }).S;
    expect(S.loopPhase).toBe(0);                  // nothing to opt out of
    const plain = sample({ ...S });
    expect(sample({ ...S, loopPhase: 0 })).toEqual(plain);
  }
});

test("loopOmega is the identity when there is no loop, and when a train is frozen", () => {
  for (const om of [0.5, 1, -2.3, 7.77]) {
    expect(loopOmega(om, { loopPhase: 0 })).toBe(om);
    expect(loopOmega(om, {})).toBe(om);
  }
  // rate 0 freezes a train; a loop must not start it moving
  expect(loopOmega(0, { loopPhase: 12 })).toBe(0);
});

test("a frozen train stays frozen inside a loop", () => {
  const frozen = (loopPhase) => everyType(5, loopPhase, {
    emitters: [{ id: 1, on: true, type: "swell", x: 0, y: 12, dir: 20, size: 2,
      amp: 1, spread: 0, roughness: 0, detail: 8, rate: 0 }],
  });
  // still water, and the same still water it would have been without the loop
  expect(sample(frozen(12))).toEqual(sample(frozen(0)));
  expect(sample(frozen(12))).toEqual(sample(everyType(0, 0, {
    emitters: frozen(0).emitters })));
});

// ---- on, it closes --------------------------------------------------

test("every emitter type lands back on its first frame after one loop", () => {
  for (const T of [8, 12, 25.5, 36]) {
    const at0 = sample(everyType(0, T));
    const atT = sample(everyType(T, T));
    // amplitudes here are ~1e-2; 1e-12 is closure, not agreement
    expect(worstDiff(at0, atT)).toBeLessThan(1e-12);
    // and it keeps closing, loop after loop — the field is periodic, not
    // merely arranged to match at one instant
    expect(worstDiff(at0, sample(everyType(3 * T, T)))).toBeLessThan(1e-11);
  }
});

test("the saved scenes close too, under both timing rules", () => {
  for (const fixture of [GRAZING_RIPPLES, HARBOR_WAKE]) {
    for (const dispersion of [false, true]) {
      const T = 24;
      const base = buildScene({ ...fixture, dispersion, quality: 40 }).S;
      const at0 = sample({ ...base, t: 0, loopPhase: T });
      const atT = sample({ ...base, t: T, loopPhase: T });
      expect(worstDiff(at0, atT)).toBeLessThan(1e-11);
      // what it would have done without the loop: nowhere near its own start.
      // This is the artifact the option exists to remove, so it is worth
      // holding onto the fact that it is a large one.
      //
      // Half the field's own rms rather than all of it, because the rms is a
      // generous yardstick on HARBOR_WAKE: that scene is mostly a wake and two
      // long swells, and a wake carries no phase term at all, so a good share
      // of its rms is static by construction and can never pop however long
      // the clip runs. GRAZING_RIPPLES clears this by six to eight times.
      const popped = sample({ ...base, t: T, loopPhase: 0 });
      expect(worstDiff(at0, popped)).toBeGreaterThan(0.5 * rms(at0));
    }
  }
});

test("closing the loop costs tempo and nothing else", () => {
  const T = 24;
  const S = buildScene({ ...GRAZING_RIPPLES, dispersion: true, quality: 40 }).S;
  // the first frame is the scene as it stands: the snap scales a phase term,
  // and at t = 0 there is no phase term
  expect(sample({ ...S, t: 0, loopPhase: T })).toEqual(sample({ ...S, t: 0 }));
  // and the water is still made of the same thing mid-clip — same wavelengths,
  // same amplitudes, so the same energy; only the instant differs
  for (const f of [0.25, 0.5, 0.75]) {
    const trueRms = rms(sample({ ...S, t: T * f }));
    const loopRms = rms(sample({ ...S, t: T * f, loopPhase: T }));
    expect(Math.abs(loopRms - trueRms) / trueRms).toBeLessThan(0.15);
  }
});

test("prepped constants other than the phase are untouched by the loop", () => {
  const T = 20;
  const a = prepField(everyType(3, 0));
  const b = prepField(everyType(3, T));
  a._ems.forEach((e, i) => {
    const f = b._ems[i];
    expect(f.type).toBe(e.type);
    if (e.type === "spectrum") {
      expect(f.K).toEqual(e.K);                   // wavelengths
      expect(f.DX).toEqual(e.DX);                 // headings
      expect(f.DY).toEqual(e.DY);
      expect(f.AMP).toEqual(e.AMP);               // energy per rung
      expect(f.AA).toEqual(e.AA);                 // the range filter
      expect(f.PH).not.toEqual(e.PH);             // only this moved
    }
    if (e.type === "rings") {
      expect(f.CX).toEqual(e.CX);                 // where the sources are
      expect(f.CY).toEqual(e.CY);
      expect(f.K).toEqual(e.K);
      expect(f.AMP).toEqual(e.AMP);
    }
    if (e.type === "swell") {
      expect(f.k0).toBe(e.k0);
      expect([f.Dx, f.Dy, f.A, f.q, f.aa]).toEqual([e.Dx, e.Dy, e.A, e.q, e.aa]);
    }
    if (e.type === "sea") {
      expect(f.K).toEqual(e.K);                   // the ladder
      expect(f.DX).toEqual(e.DX);                 // headings
      expect(f.DY).toEqual(e.DY);
      expect(f.AMP).toEqual(e.AMP);               // energy per rung
      expect(f.AA).toEqual(e.AA);
      expect([f.chop, f.patch, f.group, f.ns, f.lo, f.hi, f.wx, f.wy, f.gl1, f.gl2])
        .toEqual([e.chop, e.patch, e.group, e.ns, e.lo, e.hi, e.wx, e.wy, e.gl1, e.gl2]);
      // the three that carry time: the ladder's phases, the gust field's
      // travel downwind, and each group beat's own phase
      expect(f.PH).not.toEqual(e.PH);
      expect([f.nou, f.gp1, f.gp2]).not.toEqual([e.nou, e.gp1, e.gp2]);
    }
    // a wake has no phase term at all, so a loop is nothing to it
    if (e.type === "wake") expect(f).toEqual(e);
  });
});

// ---- the cost is bounded, and reported ------------------------------

test("loopFit reports the shift the snap actually imposes", () => {
  const S = buildScene({ ...GRAZING_RIPPLES, dispersion: true, quality: 40 }).S;
  const fit = loopFit(S, 36);
  expect(fit.components).toBe(42);               // 8 ring sources + 15 + 19 rungs
  expect(fit.slowest).toBeGreaterThan(0);
  // the worst shift is on the slowest train, and cannot exceed half a cycle
  // spread over the cycles it does complete
  const n = (fit.slowest * 36) / (2 * Math.PI);
  expect(fit.worst).toBeLessThanOrEqual(1 / (2 * n) + 1e-9);
  // and it falls away as the loop lengthens
  expect(loopFit(S, 72).worst).toBeLessThan(fit.worst);
  expect(loopFit(S, 0).worst).toBe(0);
  // a wake contributes no component to count: it never had a phase term
  expect(loopFit(buildScene({ ...HARBOR_WAKE, quality: 40 }).S, 36).components)
    .toBe(loopFit(buildScene({ ...HARBOR_WAKE, quality: 40,
      wakes: [] }).S, 36).components);
});

// ---- the frame plan -------------------------------------------------

test("a looping plan spans exactly one loop, starting at zero", () => {
  const T = 18;
  const p = framePlan(3, 0.5, VIDEO_FPS, T);
  expect(p.loopPhase).toBe(T);
  expect(p.phaseAt(0)).toBe(0);
  expect(p.endPhase).toBe(T);
  // the frames divide the span evenly and the last stops one step short, so
  // the clip runs into its own first frame rather than repeating it
  expect(p.phaseAt(p.count)).toBeCloseTo(T, 12);
  expect(p.phaseAt(p.count - 1)).toBeLessThan(T);
  const step = p.phaseAt(1) - p.phaseAt(0);
  for (let i = 1; i < p.count; i++)
    expect(p.phaseAt(i) - p.phaseAt(i - 1)).toBeCloseTo(step, 12);
  // the duration is what that span comes to at this speed
  expect(p.seconds).toBeCloseTo(loopSeconds(T, 0.5), 1);
});

test("a plan with no loop is the plan it always was", () => {
  for (const [secs, speed] of [[3, 1], [2, 0.5], [10, 1.5], [0.1, 1], [99, 1]]) {
    const was = framePlan(secs, speed);
    const now = framePlan(secs, speed, VIDEO_FPS, 0);
    expect([now.count, now.seconds, now.endPhase])
      .toEqual([was.count, was.seconds, was.endPhase]);
    expect(now.loopPhase).toBe(0);
    expect(was.endPhase).toBeCloseTo(was.seconds * PHASE_PER_SEC * speed, 10);
  }
});

test("the offered loop lengths are ones the clip can actually hold", () => {
  for (const speed of [0.05, 0.5, 1, 1.5]) {
    const r = loopPhaseRange(speed);
    expect(loopSeconds(r.min, speed)).toBeCloseTo(VIDEO_MIN_SEC, 10);
    expect(loopSeconds(r.max, speed)).toBeCloseTo(VIDEO_MAX_SEC, 10);
    // every length in range renders as a whole clip, not a clamped one
    for (const T of [r.min, (r.min + r.max) / 2, r.max]) {
      const p = framePlan(0, speed, VIDEO_FPS, T);
      expect(p.endPhase).toBe(T);
      expect(p.seconds).toBeGreaterThanOrEqual(VIDEO_MIN_SEC);
      expect(p.seconds).toBeLessThanOrEqual(VIDEO_MAX_SEC);
    }
  }
  // the default sits inside the range at the studio's own default speed
  const at05 = loopPhaseRange(0.5);
  expect(VIDEO_LOOP_DEFAULT_PHASE).toBeGreaterThanOrEqual(at05.min);
  expect(VIDEO_LOOP_DEFAULT_PHASE).toBeLessThanOrEqual(at05.max);
});

test("the emitter rate is folded in before the snap, not after", () => {
  // A trimmed train turns at omegaAt * rate, and that is the frequency the
  // loop has to land on. Snapping the untrimmed one and multiplying after
  // would close nothing, so this is the whole of the `rate` interaction.
  const T = 16;
  const trimmed = (t, loopPhase) => everyType(t, loopPhase, {
    emitters: [{ id: 1, on: true, type: "swell", x: 0, y: 12, dir: 20, size: 2.7,
      amp: 1, spread: 0, roughness: 0, detail: 8, rate: 0.37 }],
  });
  expect(worstDiff(sample(trimmed(0, T)), sample(trimmed(T, T)))).toBeLessThan(1e-12);
  expect(EMITTER_RATE_DEFAULT).toBe(1);
});
