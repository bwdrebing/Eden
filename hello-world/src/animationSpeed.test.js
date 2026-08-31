import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";
import {
  prepField, heightAt, buildGeometry, SPEED_MIN, SPEED_MAX, EMITTER_RATE_DEFAULT,
} from "./WaterReflectionContours";
import { framePlan, PHASE_PER_SEC } from "./videoExport";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * How fast the water moves
 *
 * There is one clock. `speed` is its rate — the same number for the preview
 * animation and for how much water a second of exported video covers — and a
 * per-emitter `rate` is that train's gearing off it. What is pinned here is
 * that the gearing is a phase scaling and nothing else (a frozen train is a
 * still wave pattern, not flat water), that the two multiply the way the
 * panel says they do, and that a scene saved before any of this existed
 * renders exactly as it did.
 * ------------------------------------------------------------------ */

// a scene with one swell, so a rate change has one thing to act on
const swellScene = (t, rate) => ({
  nx: 40, ny: 40, xMin: -10, xMax: 10, yMin: 3, yMax: 30,
  H: 6, pitch: 0.7, k: 2 * Math.PI / 2, amp: 0.06, sharp: 0, decay: 0.1,
  omega: 1, t, bands: 4, perspective: true, eLo: 0, eHi: 20,
  zoom: 1, panX: 0, panY: 0, smooth: 0, surface3d: false, waveScale: 1,
  emitters: [{ id: 1, on: true, type: "swell", x: 0, y: 10, dir: 90,
    size: 1, amp: 1, spread: 0, roughness: 0, detail: 8,
    ...(rate === undefined ? {} : { rate }) }],
});

const surface = (S) => {
  prepField(S);
  const out = [];
  for (let i = 0; i <= 8; i++)
    for (let j = 0; j <= 8; j++) out.push(heightAt(-8 + 2 * i, 4 + 3 * j, S));
  return out;
};
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test("a rate is gearing off the clock: rate r at t is the clock at r*t", () => {
  // half rate covers half the phase — the definition the emitter panel states
  expect(same(surface(swellScene(4, 0.5)), surface(swellScene(2, 1)))).toBe(true);
  expect(same(surface(swellScene(3, 2)), surface(swellScene(6, 1)))).toBe(true);
  // and it really is a change: same t, different rate, different water
  expect(same(surface(swellScene(4, 0.5)), surface(swellScene(4, 1)))).toBe(false);
});

test("a frozen train is a still wave pattern, not flat water", () => {
  const frozen = surface(swellScene(9, 0));
  // the waves are still there — freezing stops the phase, it does not
  // flatten the surface
  expect(Math.max(...frozen.map(Math.abs))).toBeGreaterThan(0);
  // and it is the same water at every moment of the clock
  expect(same(frozen, surface(swellScene(0, 0)))).toBe(true);
  expect(same(frozen, surface(swellScene(37, 0)))).toBe(true);
});

test("one train can be geared down while the rest of the water moves", () => {
  const two = (t) => ({
    ...swellScene(t),
    emitters: [
      { id: 1, on: true, type: "swell", x: 0, y: 10, dir: 90, size: 2.5, amp: 1,
        spread: 0, roughness: 0, detail: 8, rate: 0.2 },        // the slow swell
      { id: 2, on: true, type: "spectrum", x: 0, y: 10, dir: 120, size: 0.6, amp: 0.7,
        spread: 30, roughness: 0.5, detail: 10, rate: 2 },      // chop racing on top
    ],
  });
  // the mixture moves, and does not match either train's own timing
  expect(same(surface(two(0)), surface(two(1)))).toBe(false);
  const solo = (t, keep) => {
    const S = two(t);
    S.emitters = S.emitters.filter((e) => e.id === keep);
    return surface(S);
  };
  expect(same(solo(0, 1), solo(1, 1))).toBe(false);
  expect(same(solo(0, 2), solo(1, 2))).toBe(false);
});

test("a scene saved before rates existed renders exactly as it did", () => {
  // GRAZING_RIPPLES carries no rate on any emitter; the default has to be a
  // true no-op, not a value that happens to be close
  expect(GRAZING_RIPPLES.emitters.every((e) => e.rate === undefined)).toBe(true);
  expect(EMITTER_RATE_DEFAULT).toBe(1);
  const { S } = buildScene({ ...GRAZING_RIPPLES, manualTime: 5.5 });
  const withRate = buildScene({
    ...GRAZING_RIPPLES, manualTime: 5.5,
    emitters: GRAZING_RIPPLES.emitters.map((e) => ({ ...e, rate: 1 })),
  }).S;
  buildGeometry(S); buildGeometry(withRate);
  expect(same(surface(S), surface(withRate))).toBe(true);
}, 120000);

test("the clock's rate and the clip's length are the two halves of one span", () => {
  // "slower over a longer time": drop the speed, raise the length, and the
  // same water unfolds — five times the frames for the same stretch of phase
  const fast = framePlan(2, 0.5), slow = framePlan(10, 0.1);
  expect(slow.endPhase).toBeCloseTo(fast.endPhase, 10);
  expect(slow.count).toBe(5 * fast.count);
  // the floor has to buy something: the slowest ten seconds must cover less
  // water than a default-speed clip of the same length
  expect(framePlan(10, SPEED_MIN).endPhase).toBeLessThan(framePlan(10, 0.5).endPhase / 5);
  expect(framePlan(1, SPEED_MAX).endPhase).toBeCloseTo(SPEED_MAX * PHASE_PER_SEC, 10);
});

test("the speed control is reachable whether or not the preview is animating", () => {
  render(<App />);
  // with the animation off — the state a video export is usually set up in —
  // this slider used to be hidden behind the toggle entirely
  const speed = screen.getByLabelText(/^Speed/);
  expect(Number(speed.min)).toBe(SPEED_MIN);
  expect(Number(speed.max)).toBe(SPEED_MAX);
  // and scrubbing to a frozen moment is still offered alongside it
  expect(screen.getByLabelText(/Time \(wave phase\)/)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/Animate ripples/));
  expect(screen.getByLabelText(/^Speed/)).toBeInTheDocument();
}, 120000);
