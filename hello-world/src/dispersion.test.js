import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";
import {
  prepField, heightAt, omegaAt, dispersionFor, DISPERSION_DEFAULT,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";
import { readSlice } from "./urlSettings";

/* ------------------------------------------------------------------ *
 * Speed follows wavelength
 *
 * A deep-water wave does not get to pick its own speed: omega = sqrt(g k),
 * so a train of wavelength L bobs at 1/sqrt(L) and carries its crests at
 * sqrt(L). What is pinned here is that the renderer's trains obey that ratio
 * when the rule is on, that the ratio is the *realistic* one rather than the
 * far steeper one the old timing produced, that every emitter type is on the
 * same rule, and that a scene saved before the rule renders exactly as it did.
 *
 * The reference is the scene's own ripple scale: a train at 1.0x wavelength
 * runs at exactly the clock, whatever that scale is set to. So the global
 * scale slider stays a size control, and what the rule decides is the trains'
 * speeds relative to each other.
 * ------------------------------------------------------------------ */

// One straight-crested train heading along +x, so its phase is a plain
// function of gx and the crest speed can be read off as a shift.
const swell = (size, t, extra = {}) => ({
  nx: 40, ny: 40, xMin: -10, xMax: 10, yMin: 3, yMax: 30,
  H: 6, pitch: 0.7, k: 2 * Math.PI / 2, amp: 0.06, sharp: 0, decay: 0.1,
  omega: 1, t, bands: 4, perspective: false, eLo: 0, eHi: 20,
  zoom: 1, panX: 0, panY: 0, smooth: 0, surface3d: false, waveScale: 1,
  dispersion: true,
  emitters: [{ id: 1, on: true, type: "swell", x: 0, y: 10, dir: 0,
    size, amp: 1, spread: 0, roughness: 0, detail: 8 }],
  ...extra,
});

// sample a line across the field; perspective is off, so nothing here fades
// with range and a shift in x is a clean shift of the pattern
const line = (S, dx = 0) => {
  prepField(S);
  const out = [];
  for (let i = 0; i <= 24; i++) out.push(heightAt(-9 + 0.7 * i + dx, 12, S));
  return out;
};
const same = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

// How far this train's crests move in one unit of the clock: the distance the
// pattern has to be pushed forward for the field at t = 1 to lie back on the
// field at t = 0. Swept rather than read off the emitter's constants, so what
// is measured is the rendered field and not the formula restated. The sweep
// stops one wavelength along — past that the pattern repeats and every answer
// is right, which is the wrong kind of right.
function crestSpeed(size, S0 = swell) {
  const at0 = line(S0(size, 0));
  const lam = 2 * size;                        // the scene's lambda0 is 2
  let best = 0, bestErr = Infinity;
  for (let i = 0; i < 4000; i++) {
    const c = (i * lam) / 4000;
    const shifted = line(S0(size, 1), c);
    const e = shifted.reduce((a, v, j) => a + (v - at0[j]) * (v - at0[j]), 0);
    if (e < bestErr) { bestErr = e; best = c; }
  }
  return best;
}

describe("the rule itself", () => {
  test("omega goes as sqrt(k), normalized to the scene's own wavelength", () => {
    const S = { omega: 1, k: 2 * Math.PI / 2, dispersion: true };
    // a train at the scene's wavelength runs at exactly the clock
    expect(omegaAt(S.k, S)).toBeCloseTo(1, 12);
    // four times the wavenumber (a quarter the wavelength) is twice the
    // frequency, not four times it
    expect(omegaAt(4 * S.k, S)).toBeCloseTo(2, 12);
    expect(omegaAt(S.k / 4, S)).toBeCloseTo(0.5, 12);
    // and the normalization really is to lambda0: a scene at a different
    // ripple scale gives a 1.0x train the same frequency
    const wide = { omega: 1, k: 2 * Math.PI / 7, dispersion: true };
    expect(omegaAt(wide.k, wide)).toBeCloseTo(1, 12);
  });

  test("off, one frequency serves every wavelength", () => {
    const S = { omega: 1, k: 2 * Math.PI / 2, dispersion: false };
    expect(omegaAt(S.k, S)).toBe(1);
    expect(omegaAt(9 * S.k, S)).toBe(1);
    // a scene that carries no flag at all is a scene from before the rule
    expect(omegaAt(9 * S.k, { omega: 1, k: S.k })).toBe(1);
  });

  test("the panel's numbers are the rule's numbers", () => {
    const d = dispersionFor(4, true);
    expect(d.crest).toBeCloseTo(2, 12);
    expect(d.bob).toBeCloseTo(0.5, 12);
    expect(dispersionFor(4, false)).toEqual({ crest: 1, bob: 1 });
  });
});

describe("what the water does", () => {
  test("a train's period grows as sqrt of its wavelength", () => {
    // size 1 sits at the scene's own wavelength, so its period is the clock's
    expect(same(line(swell(1, 0)), line(swell(1, 2 * Math.PI)))).toBe(true);
    // size 4 takes twice as long to come round
    expect(same(line(swell(4, 0)), line(swell(4, 4 * Math.PI)))).toBe(true);
    expect(same(line(swell(4, 0)), line(swell(4, 2 * Math.PI)))).toBe(false);
    // and a quarter the wavelength, half the period
    expect(same(line(swell(0.25, 0)), line(swell(0.25, Math.PI)))).toBe(true);
  });

  test("crests carry as sqrt of the wavelength, not as the wavelength", () => {
    const c1 = crestSpeed(1), c4 = crestSpeed(4);
    // sqrt(4) = 2. The old timing gave this pair a ratio of 4 — a long swell
    // crossing the frame while the chop stood still, which is what reads wrong
    expect(c4 / c1).toBeGreaterThan(1.9);
    expect(c4 / c1).toBeLessThan(2.1);

    const off = (size, t) => swell(size, t, { dispersion: false });
    const o1 = crestSpeed(1, off), o4 = crestSpeed(4, off);
    expect(o4 / o1).toBeGreaterThan(3.8);
    expect(o4 / o1).toBeLessThan(4.2);
  });

  test("longer still means faster — the rule softens the ratio, it does not invert it", () => {
    const speeds = [0.5, 1, 2, 4].map((s) => crestSpeed(s));
    for (let i = 1; i < speeds.length; i++)
      expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
  });
});

describe("every emitter type is on the one rule", () => {
  // period of a train at wavelength `size`, under the rule, is 2*pi*sqrt(size)
  const period = (size) => 2 * Math.PI * Math.sqrt(size);
  const scene = (type, size, t, extra = {}) => ({
    ...swell(size, t),
    emitters: [{ id: 1, on: true, type, x: 0, y: 12, dir: 0, size, amp: 1,
      spread: 0, roughness: 0, detail: 6, ...extra }],
  });

  test.each([["swell"], ["point"], ["rings"]])("%s", (type) => {
    const S0 = scene(type, 4, 0), Sp = scene(type, 4, period(4));
    expect(same(line(S0), line(Sp), 1e-7)).toBe(true);
    // and it is not simply periodic at the clock's own period, which is what
    // it would be if this type had been left behind on the old timing
    expect(same(line(S0), line(scene(type, 4, 2 * Math.PI)), 1e-7)).toBe(false);
  });

  test("spectrum — every rung of the ladder, not just the dominant one", () => {
    // A spectrum spans octaves, so the field it sums has no period to catch it
    // by. Read the baked phases instead: the drift of each component's phase
    // over one unit of the clock is that component's frequency.
    const bake = (t, on) => {
      const S = { ...scene("spectrum", 4, t, { detail: 12, roughness: 0.4, spread: 20 }),
        dispersion: on };
      prepField(S);
      return S;
    };
    const A = bake(0, true), B = bake(1, true);
    const a = A._ems[0], b = B._ems[0];
    expect(a.N).toBe(12);
    for (let i = 0; i < a.N; i++) {
      expect(b.K[i]).toBeCloseTo(a.K[i], 12);            // same ladder
      expect(a.PH[i] - b.PH[i]).toBeCloseTo(omegaAt(a.K[i], A), 12);
    }
    // The dominant rung is the one the panel quotes. It lands near 1/sqrt(4)
    // rather than on it, because the ladder's wavelengths carry a deliberate
    // +-17% jitter so the rungs do not beat against each other — a band, not
    // a number, is the honest assertion here.
    expect(a.PH[0] - b.PH[0]).toBeGreaterThan(0.5 * 0.91);
    expect(a.PH[0] - b.PH[0]).toBeLessThan(0.5 * 1.1);
    // off, the rungs still disperse among themselves — that part was always
    // right — but against a reference that has nothing to do with this scene,
    // so the dominant rung does not match a swell of the same wavelength
    const c = bake(0, false)._ems[0], d = bake(1, false)._ems[0];
    expect(c.PH[0] - d.PH[0]).not.toBeCloseTo(0.5, 2);
  });

  test("a rings field with varied wavelengths stops pulsing in unison", () => {
    // uniform sources still share one period, whatever the rule
    const uni = (t) => scene("rings", 4, t, { roughness: 0, detail: 6 });
    expect(same(line(uni(0)), line(uni(period(4))), 1e-7)).toBe(true);
    // varied ones each take the period their own wavelength earns, so the
    // field beats instead of repeating
    const varied = (t) => scene("rings", 4, t, { roughness: 0.8, detail: 6 });
    expect(same(line(varied(0)), line(varied(period(4))), 1e-7)).toBe(false);
    // under the old timing they shared the clock's period no matter how much
    // their wavelengths differed
    const old = (t) => ({ ...varied(t), dispersion: false });
    expect(same(line(old(0)), line(old(2 * Math.PI)), 1e-7)).toBe(true);
  });

  test("a wake is a standing pattern, and the rule leaves it standing", () => {
    const wake = (t) => ({
      ...swell(1, t),
      emitters: [{ id: "w1", on: true, type: "wake", x: 0, y: 12, dir: 0,
        scale: 4, amp: 1, len: 8, detail: 1.25, angle: 19.47 }],
    });
    expect(same(line(wake(0)), line(wake(3.7)))).toBe(true);
  });
});

describe("the rate slider is still there, as a trim", () => {
  test("rate r under the rule is the rule's own timing at r*t", () => {
    const geared = (t, rate) => ({
      ...swell(4, t),
      emitters: [{ ...swell(4, t).emitters[0], rate }],
    });
    expect(same(line(geared(4, 0.5)), line(geared(2, 1)))).toBe(true);
    expect(same(line(geared(4, 0.5)), line(geared(4, 1)))).toBe(false);
    // 0 still freezes one train without flattening it
    const frozen = line(geared(9, 0));
    expect(Math.max(...frozen.map(Math.abs))).toBeGreaterThan(0);
    expect(same(frozen, line(geared(0, 0)))).toBe(true);
  });
});

describe("scenes saved before the rule", () => {
  test("carry no flag, and render as they did", () => {
    expect(GRAZING_RIPPLES.dispersion).toBeUndefined();
    const asSaved = buildScene({ ...GRAZING_RIPPLES, quality: 60 }).S;
    const stated = buildScene({ ...GRAZING_RIPPLES, quality: 60, dispersion: false }).S;
    const under = buildScene({ ...GRAZING_RIPPLES, quality: 60, dispersion: true }).S;
    const grid = (S) => {
      prepField(S);
      const out = [];
      for (let i = 0; i <= 8; i++)
        for (let j = 0; j <= 8; j++) out.push(heightAt(-8 + 2 * i, 8 + 4 * j, S));
      return out;
    };
    // absence of the flag is the old rule, exactly — not something close to it
    expect(same(grid(asSaved), grid(stated))).toBe(true);
    // and the rule is a real change to this scene when it is asked for
    expect(same(grid(asSaved), grid(under))).toBe(false);
  });
});

describe("the studio", () => {
  // The emitter panel says which rule is in force: with it on, each card
  // carries the share its wavelength earns and its rate reads as a trim on
  // that; with it off, the rate is the gearing off the clock it always was.
  const ON = /the rule gives it crests at/;
  const RATE_ON = /rate \(trim on the above\)/;
  const RATE_OFF = /rate \(× the scene clock\)/;

  afterEach(() => window.history.replaceState(null, "", "/"));

  test("a new scene starts under the rule, and it can be turned off", () => {
    expect(DISPERSION_DEFAULT).toBe(true);
    window.history.replaceState(null, "", "/");
    render(<App />);
    fireEvent.click(screen.getByText(/\+ advanced/));
    expect(screen.getAllByText(ON).length).toBe(3);       // one per emitter
    expect(screen.getAllByText(RATE_ON).length).toBe(3);
    expect(screen.queryByText(RATE_OFF)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Speed follows wavelength/ }));
    expect(screen.queryByText(ON)).toBeNull();
    expect(screen.getAllByText(RATE_OFF).length).toBe(3);
  }, 120000);

  test("a link saved before the rule reopens with it off", () => {
    // A slice is written whole, so one that carries `speed` but no
    // `dispersion` is a link from before the rule existed — the studio must
    // not silently re-time the scene its author saved and froze.
    const slice = { reflection: { advanced: true, speed: 0.5, manualTime: 3 } };
    const b64 = Buffer.from(JSON.stringify(slice), "utf8").toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    window.history.replaceState(null, "", "/?s=" + b64);
    render(<App />);
    expect(screen.getAllByText(RATE_OFF).length).toBe(3);
    expect(screen.queryByText(ON)).toBeNull();
    // and reopening it writes the choice down, so the link stops being
    // ambiguous from here on (the address bar itself catches up a frame
    // later, which is why this reads the slice the studio committed)
    expect(readSlice("reflection").dispersion).toBe(false);
  }, 120000);
});
