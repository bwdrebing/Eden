import { prepField, heightAt, slopeAt, loopFit } from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * Rain
 *
 * Drops land, ring and die. What is pinned: that slopeAt is the gradient of
 * heightAt (the reflection reads one, the 3D lift the other); that a slot's
 * old drop is gone before its new one lands, so no frame pops; that the
 * pattern is a function of the clock alone; and that it reads on glass.
 * ------------------------------------------------------------------ */

const scene = (t, extra = {}, em = {}) => ({
  nx: 40, ny: 40, xMin: -12, xMax: 12, yMin: 4, yMax: 34,
  H: 6, pitch: 0.7, k: (2 * Math.PI) / 2, amp: 0, sharp: 0, decay: 0.1,
  omega: 1, t, loopPhase: 0, perspective: true, dispersion: true,
  emitters: [{ id: 1, on: true, type: "rain", x: 0, y: 12, dir: 0, size: 0.8,
    amp: 1, spread: 0, roughness: 0.4, detail: 40, reach: 5, ...em }],
  ...extra,
});

const grid = (S, fn, n = 41) => {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    out.push(fn(S.xMin + ((S.xMax - S.xMin) * i) / (n - 1),
      S.yMin + ((S.yMax - S.yMin) * j) / (n - 1)));
  }
  return out;
};
const heights = (S) => { prepField(S); return grid(S, (x, y) => heightAt(x, y, S)); };

test("rain moves water even when the open water is glass", () => {
  const z = heights(scene(3.3));
  expect(Math.max(...z.map(Math.abs))).toBeGreaterThan(1e-3);
});

test("slopeAt is the gradient of heightAt", () => {
  const S = prepField(scene(6.1));
  const h = 1e-5;
  let worst = 0, scale = 0;
  grid(S, (x, y) => {
    const [hx, hy] = slopeAt(x, y, S);
    const fx = (heightAt(x + h, y, S) - heightAt(x - h, y, S)) / (2 * h);
    const fy = (heightAt(x, y + h, S) - heightAt(x, y - h, S)) / (2 * h);
    worst = Math.max(worst, Math.abs(hx - fx), Math.abs(hy - fy));
    scale = Math.max(scale, Math.abs(hx), Math.abs(hy));
  }, 61);
  expect(scale).toBeGreaterThan(1e-3);
  expect(worst).toBeLessThan(1e-3 * scale);
});

test("the water changes smoothly frame to frame: no drop pops in or out", () => {
  // Step the clock finely across many lifetimes. The worst frame-to-frame
  // change must shrink with the step — a drop that appeared or vanished at
  // full height would leave a jump that no step size removes.
  const worstStep = (dt) => {
    let worst = 0, prev = heights(scene(0));
    for (let t = dt; t < 40; t += dt) {
      const cur = heights(scene(t));
      for (let i = 0; i < cur.length; i++) worst = Math.max(worst, Math.abs(cur[i] - prev[i]));
      prev = cur;
    }
    return worst;
  };
  const coarse = worstStep(0.2), fine = worstStep(0.05);
  expect(fine).toBeLessThan(coarse * 0.5);
});

test("the drops are a function of the clock alone", () => {
  expect(heights(scene(12.5))).toEqual(heights(scene(12.5)));
  // and two rain emitters do not drop in lockstep: each seeds its own drops
  expect(heights(scene(12.5, {}, { id: 2 }))).not.toEqual(heights(scene(12.5)));
});

test("strength 0 or no drops is still water; a frozen clock is a still picture", () => {
  expect(Math.max(...heights(scene(4, {}, { amp: 0 })).map(Math.abs))).toBe(0);
  expect(heights(scene(4, {}, { rate: 0 }))).toEqual(heights(scene(90, {}, { rate: 0 })));
});

test("a loop counts rain's drop cycle as a component", () => {
  const fit = loopFit(scene(0), 30);
  expect(fit.components).toBe(1);
  expect(fit.slowest).toBeGreaterThan(0);
});
