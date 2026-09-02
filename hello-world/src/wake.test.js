import { render, screen, act, fireEvent } from "@testing-library/react";
import App from "./App";
import {
  heightAt, slopeAt, prepField, withWakes, newWake, WAKE_ANGLE_DEG,
} from "./WaterReflectionContours";

/* ------------------------------------------------------------------ *
 * Boat & board wakes
 *
 * A wake is the water half of a vessel the user draws in afterwards, so
 * what has to hold is the shape of the pattern and its independence: the V
 * sits where the physics puts it, it scales as one object, and retuning the
 * open water leaves it exactly where it was. These pin all three, plus the
 * thing that is easy to break silently — slopeAt staying the true gradient
 * of heightAt, since the reflection reads one and the 3D lift the other.
 * ------------------------------------------------------------------ */

// A plan-view field carrying nothing but one wake, so heightAt returns the
// wake alone. Plan view drops the range filter; the grid is fine enough that
// the resolution guard sits at its λ₀ floor, which keeps the field scale-free.
const wakeField = (wake, over = {}) => prepField({
  nx: 400, ny: 400, xMin: -60, xMax: 60, yMin: 0, yMax: 120,
  H: 0.4 * Math.pow(22.5, 0.35), pitch: (12.6 * Math.PI) / 180,
  k: (2 * Math.PI) / 1.8, amp: 0.38 * 0.06, sharp: 0, decay: 0.14,
  omega: 1, t: 0, perspective: false,
  emitters: withWakes([], [{ id: 1, on: true, x: 0, y: 60, dir: 0,
    scale: 4, amp: 1, len: 8, angle: WAKE_ANGLE_DEG, ...wake }]),
  ...over,
});

// with dir 0 the vessel heads +x, so the wake trails toward -x and the
// track is the line gy = 60. (u astern, v across) -> ground.
const at = (S, u, v) => heightAt(-u, 60 + v, S);

// how much wake there is `deg` off the track: the crests run out radially, so
// take the strongest sample over a stretch of range rather than one point
const ampAt = (S, deg, r = 24) => {
  const a = (deg * Math.PI) / 180;
  let m = 0;
  for (let d = -4; d <= 4; d += 0.02)
    m = Math.max(m, Math.abs(at(S, (r + d) * Math.cos(a), (r + d) * Math.sin(a))));
  return m;
};
expect.extend({
  toBeWithin(got, want, tol) {
    const ok = Math.abs(got - want) <= tol;
    return { pass: ok, message: () => `expected ${got}° within ${tol}° of ${want}°` };
  },
});
const peakAngle = (S) => {
  let best = -1, deg = 0;
  for (let a = 2; a <= 44; a += 0.5) {
    const v = ampAt(S, a);
    if (v > best) { best = v; deg = a; }
  }
  return deg;
};

describe("wake geometry", () => {
  test("no wake ahead of the vessel", () => {
    const S = wakeField({});
    for (let u = 0.5; u <= 20; u += 0.5) {
      expect(at(S, -u, 0)).toBe(0);
      expect(at(S, -u, 3)).toBe(0);
    }
  });

  test("the arms sit on the Kelvin angle, and the water past them is flat", () => {
    const S = wakeField({});
    expect(ampAt(S, 0)).toBeGreaterThan(0.01);           // transverse crests on the track
    expect(peakAngle(S)).toBeWithin(WAKE_ANGLE_DEG, 1.5);  // brightest along the arms
    const arm = ampAt(S, WAKE_ANGLE_DEG);
    expect(arm).toBeGreaterThan(1.8 * ampAt(S, 0));
    expect(ampAt(S, 24)).toBeLessThan(0.5 * arm);        // feathered off just past them
    expect(ampAt(S, 27)).toBeLessThan(0.1 * arm);
    expect(ampAt(S, 36)).toBe(0);
  });

  test("the V is symmetric about the track", () => {
    const S = wakeField({});
    for (let u = 3; u <= 30; u += 1.5)
      for (let v = 0.5; v <= 9; v += 0.5)
        expect(at(S, u, -v)).toBeCloseTo(at(S, u, v), 12);
  });

  test("transverse crests sit one vessel length apart", () => {
    const scale = 4;
    const S = wakeField({ scale });
    const zeros = [];
    let prev = at(S, 6, 0);
    for (let u = 6.002; u <= 30; u += 0.002) {
      const z = at(S, u, 0);
      if ((z > 0) !== (prev > 0)) zeros.push(u);
      prev = z;
    }
    expect(zeros.length).toBeGreaterThan(8);
    for (let i = 1; i < zeros.length; i++)
      expect(zeros[i] - zeros[i - 1]).toBeCloseTo(scale / 2, 2);
  });

  test("the spread control moves the arms off the Kelvin angle", () => {
    expect(peakAngle(wakeField({ angle: 32 }))).toBeWithin(32, 2.5);
    expect(peakAngle(wakeField({ angle: 11 }))).toBeWithin(11, 2.5);
  });
});

describe("wake independence", () => {
  test("retuning the open water leaves the wake alone", () => {
    const base = wakeField({});
    const retuned = wakeField({}, {
      k: (2 * Math.PI) / 0.4,        // global wavelength 1.8 -> 0.4
      amp: 1.4 * 0.06,               // strength 0.38 -> 1.4
      sharp: 0.6, decay: 0.02, t: 9.5,
    });
    for (let u = 1; u <= 34; u += 1)
      for (let v = -8; v <= 8; v += 2)
        expect(at(retuned, u, v)).toBe(at(base, u, v));
  });

  test("scale takes the whole wake with it", () => {
    const one = wakeField({ scale: 4 });
    const two = wakeField({ scale: 8 });
    // Twice the wake at twice the offsets is twice the wave — to within a few
    // percent. It is not exact, and should not be: the floor that keeps the
    // arms above what the sample grid can hold belongs to the grid, not to the
    // wake, so a wake at half the size really does carry less fine structure.
    let dev = 0, peak = 0;
    for (let u = 2; u <= 30; u += 0.25)
      for (let v = -7; v <= 7; v += 0.25) {
        const a = 2 * at(one, u, v);
        dev = Math.max(dev, Math.abs(at(two, 2 * u, 2 * v) - a));
        peak = Math.max(peak, Math.abs(a));
      }
    expect(peak).toBeGreaterThan(0.05);
    expect(dev / peak).toBeLessThan(0.03);
  });

  test("strength scales the wake, and zero takes it out of the field", () => {
    const one = wakeField({ amp: 1 });
    const half = wakeField({ amp: 0.5 });
    const off = wakeField({ amp: 0 });
    expect(off._ems).toHaveLength(0);
    for (let u = 2; u <= 30; u += 2)
      for (let v = -6; v <= 6; v += 2) {
        expect(at(half, u, v)).toBeCloseTo(at(one, u, v) / 2, 12);
        expect(at(off, u, v)).toBe(0);
      }
  });
});

describe("wake arm detail", () => {
  // RMS of the second difference along the arm: |z\u2033| weights every wave by
  // k², so it reads almost entirely off the shortest ones present. Counting
  // zero crossings does not work here — along the arm the transverse system
  // swings slowly enough to keep the sum on one side of zero.
  const MU = 1 / (2 * Math.SQRT2);
  const fine = (S) => {
    const h = 0.02;
    let n = 0, t = 0;
    for (let u = 6; u <= 34; u += h) {
      const a = at(S, u - h, 0.95 * MU * (u - h));
      const b = at(S, u, 0.95 * MU * u);
      const c = at(S, u + h, 0.95 * MU * (u + h));
      const d2 = (a - 2 * b + c) / (h * h);
      t += d2 * d2; n++;
    }
    return Math.sqrt(t / n);
  };

  test("raising it takes waves out of the arms, monotonically", () => {
    const hf = [0.1, 0.3, 0.6, 1.0, 1.5].map((d) => fine(wakeField({ detail: d })));
    for (let i = 1; i < hf.length; i++) expect(hf[i]).toBeLessThan(hf[i - 1]);
    expect(hf[hf.length - 1]).toBeLessThan(hf[0] * 0.65);
  });

  test("it never touches the transverse crests or the V's own edge", () => {
    const fine = wakeField({ detail: 0.1 }), broad = wakeField({ detail: 1.5 });
    // on the track only the transverse system is live, and it is untouched
    for (let u = 2; u <= 34; u += 0.5) expect(at(broad, u, 0)).toBe(at(fine, u, 0));
    // and the arms stay on the Kelvin angle rather than migrating inward
    expect(peakAngle(broad)).toBeWithin(WAKE_ANGLE_DEG, 1.5);
    expect(ampAt(broad, 36)).toBe(0);
  });
});

describe("wake slopes", () => {
  // slopeAt is what the reflection reads; heightAt is what the 3D lift reads.
  // If they part company the surface and its colors stop agreeing.
  const grad = (S, gx, gy, h) => [
    (heightAt(gx + h, gy, S) - heightAt(gx - h, gy, S)) / (2 * h),
    (heightAt(gx, gy + h, S) - heightAt(gx, gy - h, S)) / (2 * h),
  ];

  test("matches a central difference along the track", () => {
    const S = wakeField({});
    for (let u = 3; u <= 30; u += 0.7) {
      const [hx, hy] = slopeAt(-u, 60, S);
      const [fx, fy] = grad(S, -u, 60, 1e-5);
      expect(hx).toBeCloseTo(fx, 4);
      expect(hy).toBeCloseTo(fy, 4);
      expect(hy).toBeCloseTo(0, 9);         // flat across the track, by symmetry
    }
  });

  test("matches a central difference across the arms", () => {
    const S = wakeField({});
    let worst = 0, scale = 0;
    for (let u = 4; u <= 30; u += 0.9)
      for (let v = -6; v <= 6; v += 0.3) {
        const [hx, hy] = slopeAt(-u, 60 + v, S);
        const [fx, fy] = grad(S, -u, 60 + v, 1e-5);
        worst = Math.max(worst, Math.abs(hx - fx), Math.abs(hy - fy));
        scale = Math.max(scale, Math.abs(fx), Math.abs(fy));
      }
    expect(scale).toBeGreaterThan(0.05);
    expect(worst / scale).toBeLessThan(0.05);
  });
});

describe("withWakes", () => {
  test("adds only the live wakes, and nothing when there are none", () => {
    const ems = [{ id: 1, on: true, type: "swell" }];
    expect(withWakes(ems, [])).toBe(ems);
    expect(withWakes(ems, undefined)).toBe(ems);
    expect(withWakes(ems, [{ id: 1, on: false, amp: 1 }])).toBe(ems);
    expect(withWakes(ems, [{ id: 1, on: true, amp: 0 }])).toBe(ems);
    const out = withWakes(ems, [{ id: 2, on: true, amp: 1, x: 0, y: 5 }]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ type: "wake", on: true, id: "wake2" });
    expect(ems).toHaveLength(1);                    // caller's list untouched
  });

  test("a new wake is sized to the scene it lands in", () => {
    const w = newWake(3, 40, 90, 0.38);
    expect(w).toMatchObject({ id: 3, on: true, x: 0 });
    expect(w.y).toBeGreaterThan(0);
    expect(w.y).toBeLessThan(90);
    expect(w.scale).toBeGreaterThan(1);
    expect(w.angle).toBeCloseTo(WAKE_ANGLE_DEG, 1);
    expect(w.detail).toBeGreaterThan(0);
  });

  test("a new wake starts at the strength the open water has, not above it", () => {
    // absolute once set, but seeded from the scene: dropped onto glass it has
    // to be a whisper, and onto a rough sea it has to be visible at all
    expect(newWake(1, 22, 78, 0.38).amp).toBeCloseTo(0.4, 10);
    expect(newWake(1, 22, 78, 1).amp).toBeCloseTo(1, 10);
    expect(newWake(1, 22, 78, 0).amp).toBeCloseTo(0.1, 10);     // glass: the floor
    expect(newWake(1, 22, 78, 9).amp).toBeCloseTo(1.5, 10);     // and a ceiling
    expect(newWake(1, 22, 78, undefined).amp).toBeCloseTo(0.1, 10);
  });
});

describe("the wakes panel", () => {
  // the field math is covered above; this is the wiring — that the control
  // actually reaches S, which is the half a saved scene depends on.
  test("adding a wake puts one in the studio and in the URL", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /objects/i }));
    fireEvent.click(screen.getByRole("button", { name: /add wake/i }));
    expect(screen.getByText("WAKE 1")).toBeInTheDocument();
    expect(screen.getByText(/scale \(vessel length\)/i)).toBeInTheDocument();

    await act(async () => { await new Promise(requestAnimationFrame); });
    const s = new URLSearchParams(window.location.search).get("s");
    const saved = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    expect(saved.reflection.wakes).toHaveLength(1);
    expect(saved.reflection.wakes[0]).toMatchObject({ on: true, dir: 15 });
  }, 120000);   // mounting the studio renders the whole scene twice
});
