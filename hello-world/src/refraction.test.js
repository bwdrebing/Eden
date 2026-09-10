import v8 from "v8";
import {
  reflectAt, refractAt, surfaceDirAt, normalAt, prepField,
  buildSolid3D, fieldSpecFor, RASTER_LEVELS,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * Refraction: the backdrop read through the surface instead of off it
 *
 * The whole option is one substitution at one seam — surfaceDirAt picks
 * between the mirrored ray and the transmitted one, and every field the
 * renderer contours is sampled through it. So these pin the substitution
 * (Snell, where the rays can land, what the tilt does to the normal) and
 * then that it actually reaches a built picture.
 * ------------------------------------------------------------------ */

const DEG = 180 / Math.PI;
const N_WATER = 1.333;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const CRITICAL = Math.asin(1 / N_WATER) * DEG;      // 48.6°

let base = null;
const scene = (over) => {
  if (!base) base = buildScene(GRAZING_RIPPLES).S;
  return { ...base, ...over };
};
const samples = (S, n = 12) => {
  prepField(S);
  const out = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out.push([S.xMin + ((i + 0.5) / n) * (S.xMax - S.xMin),
                S.yMin + ((j + 0.5) / n) * (S.yMax - S.yMin)]);
    }
  }
  return out;
};

describe("the transmitted ray", () => {
  const S = scene({ refract: true });

  test("obeys Snell's law about the surface normal", () => {
    for (const [gx, gy] of samples(S)) {
      const n = normalAt(gx, gy, S);
      const T = refractAt(gx, gy, S);
      const v = (() => { const a = [gx, gy, -S.H], l = len(a); return a.map((x) => x / l); })();
      const thI = Math.acos(Math.max(-1, Math.min(1, -dot(v, n)))) * DEG;
      const thT = Math.acos(Math.max(-1, Math.min(1, -dot(T, n)))) * DEG;
      expect(Math.sin(thI / DEG)).toBeCloseTo(N_WATER * Math.sin(thT / DEG), 9);
    }
  });

  test("is a unit vector, and reports the air-side incidence cosine", () => {
    for (const [gx, gy] of samples(S)) {
      const T = refractAt(gx, gy, S);
      expect(len(T)).toBeCloseTo(1, 9);
      const n = normalAt(gx, gy, S);
      const v = (() => { const a = [gx, gy, -S.H], l = len(a); return a.map((x) => x / l); })();
      expect(T[3]).toBeCloseTo(-dot(v, n), 9);      // what Fresnel is fed
      expect(T[3]).toBeGreaterThan(0);
    }
  });

  test("stays in the plane of incidence — so azimuth is not compressed", () => {
    for (const [gx, gy] of samples(S)) {
      const n = normalAt(gx, gy, S);
      const T = refractAt(gx, gy, S);
      const v = (() => { const a = [gx, gy, -S.H], l = len(a); return a.map((x) => x / l); })();
      // v x n is the plane's normal; the transmitted ray must lie in it
      const p = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]];
      expect(dot(p, T)).toBeCloseTo(0, 9);
    }
  });

  test("always goes down, and never leaves Snell's window", () => {
    let maxTilt = 0, maxFromDown = 0;
    for (const [gx, gy] of samples(S, 40)) {
      const T = refractAt(gx, gy, S);
      expect(T[2]).toBeLessThan(0);                          // into the water
      const n = normalAt(gx, gy, S);
      // the window is about the FACET's normal, so the world-frame cone is
      // the critical angle plus however far the wavelets tip that facet
      const fromN = Math.acos(Math.max(-1, Math.min(1, -dot(T, n)))) * DEG;
      expect(fromN).toBeLessThanOrEqual(CRITICAL + 1e-9);
      maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, n[2])) * DEG);
      maxFromDown = Math.max(maxFromDown, Math.acos(Math.max(-1, Math.min(1, -T[2]))) * DEG);
    }
    expect(maxFromDown).toBeLessThanOrEqual(CRITICAL + maxTilt + 1e-6);
  });

  test("backfacing wavelets clamp into the window, not out of it", () => {
    // At 87° incidence any facet sloping more than 3° away is turned from the
    // camera and has no transmitted ray. Handing back the reflected one there
    // put near-horizontal rays (-3°) into a field spanning -56°..-38°; every
    // sample must stay in the transmitted family instead.
    let hi = -Infinity;
    for (const [gx, gy] of samples(S, 60)) {
      hi = Math.max(hi, Math.asin(Math.max(-1, Math.min(1, refractAt(gx, gy, S)[2]))) * DEG);
    }
    expect(hi).toBeLessThan(-30);
  });
});

describe("how much detail each map carries", () => {
  // The finding the mode is designed around, pinned as arithmetic: a mirror
  // deflects by exactly twice the normal tilt at EVERY incidence, while
  // refraction's sensitivity climbs with it. Grazing water is where a
  // refracted picture has the most to show, which is the opposite of the
  // intuition that the surface should be turned to face the camera.
  const sens = (thDeg, fn) => {
    const t = thDeg / DEG, d = 1e-5;
    const v = [0, Math.sin(t), -Math.cos(t)];
    const flat = { H: 1, pitch: 0, surfaceTilt: 0, _ems: [] };
    // sample the map directly at two normals by driving it through a stub
    const at = (nrm) => {
      const ci = -dot(v, nrm);
      if (fn === "reflect") {
        return [v[0] + 2 * ci * nrm[0], v[1] + 2 * ci * nrm[1], v[2] + 2 * ci * nrm[2]];
      }
      const eta = 1 / N_WATER;
      const f = eta * ci - Math.sqrt(1 - eta * eta * (1 - ci * ci));
      return [eta * v[0] + f * nrm[0], eta * v[1] + f * nrm[1], eta * v[2] + f * nrm[2]];
    };
    void flat;
    const a = at([0, 0, 1]);
    const b = at([0, Math.sin(d), Math.cos(d)]);
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) / d;
  };

  test("reflection is flat at 2.0, refraction climbs from 0.25 to ~0.94", () => {
    for (const th of [0, 20, 40, 60, 80, 87]) {
      expect(sens(th, "reflect")).toBeCloseTo(2, 3);
    }
    expect(sens(0, "refract")).toBeCloseTo(0.25, 3);      // head-on: 1/n
    expect(sens(87, "refract")).toBeGreaterThan(0.9);     // grazing: near rigid
    // strictly increasing with incidence
    const seq = [0, 20, 40, 60, 80, 87].map((t) => sens(t, "refract"));
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]);
  });
});

describe("surface tilt", () => {
  test("0 leaves the normal exactly as the wave slope made it", () => {
    const a = scene({ refract: true, surfaceTilt: 0 });
    const b = scene({ refract: true });                    // absent, not zero
    prepField(a); prepField(b);
    for (const [gx, gy] of samples(a, 6)) {
      expect(normalAt(gx, gy, a)).toEqual(normalAt(gx, gy, b));
    }
  });

  test("1 stands the normal on the camera's own axis", () => {
    const S = scene({ refract: true, surfaceTilt: 1 });
    prepField(S);
    // with the waves stilled, a fully tilted normal is the view axis: pitch
    // from vertical, leaning toward the camera
    const still = { ...S, _ems: [] };
    const n = normalAt(0, 20, still);
    // the camera is at y = 0 and the water is out at +y, so a normal that
    // faces the lens leans toward -y
    expect(Math.atan2(n[1], n[2]) * DEG).toBeCloseTo(-(90 - S.pitch * DEG), 6);
  });

  test("costs refracted detail — the reason it defaults to 0", () => {
    const spread = (tilt) => {
      const S = scene({ refract: true, surfaceTilt: tilt });
      prepField(S);
      let lo = Infinity, hi = -Infinity;
      for (const [gx, gy] of samples(S, 24)) {
        const e = Math.asin(Math.max(-1, Math.min(1, refractAt(gx, gy, S)[2]))) * DEG;
        // local contrast across one row is what makes wavelets read; take the
        // whole-frame spread's stand-in: the spread at a fixed far row
        if (Math.abs(gy - S.yMax) < (S.yMax - S.yMin) / 24) {
          if (e < lo) lo = e; if (e > hi) hi = e;
        }
      }
      return hi - lo;
    };
    expect(spread(0)).toBeGreaterThan(spread(1));
  });
});

describe("the mode reaches the picture", () => {
  test("surfaceDirAt is the seam, and it switches", () => {
    const r = scene({ refract: false }), t = scene({ refract: true });
    prepField(r); prepField(t);
    for (const [gx, gy] of samples(r, 6)) {
      expect(surfaceDirAt(gx, gy, r)).toEqual(reflectAt(gx, gy, r));
      expect(surfaceDirAt(gx, gy, t)).toEqual(refractAt(gx, gy, t));
    }
  });

  test("a refracted scene still builds every band it was painted with", () => {
    // reflMag 0.5 (what the fixture ships) deliberately spreads the bands wider
    // than the window, so the outer ones fall outside any field. Fit both here:
    // this is the "fit the window to the water" button's job.
    const { S, fieldSpec } = buildScene({ ...GRAZING_RIPPLES, eLo: -56, eHi: -37, reflMag: 1 });
    const R = { ...S, refract: true };
    const L = RASTER_LEVELS[0];
    const spec = fieldSpecFor(R, { use2d: false, doc: null, azSpan: GRAZING_RIPPLES.azSpan,
      cols: fieldSpec.cols, fresOn: false, fresBands: 3 });
    const { layers } = buildSolid3D(R, spec, { gN: L.gN, BW: L.BW });
    expect(layers.length).toBe(13);
    for (const l of layers) expect((l.d.match(/Z/g) || []).length).toBeGreaterThan(0);
  }, 120000);

  test("and draws a different picture from the reflected one", () => {
    const { S, fieldSpec } = buildScene({ ...GRAZING_RIPPLES, eLo: -56, eHi: -37 });
    const L = RASTER_LEVELS[0];
    const mk = (refract) => {
      const R = { ...S, refract };
      return buildSolid3D(R, fieldSpecFor(R, { use2d: false, doc: null,
        azSpan: GRAZING_RIPPLES.azSpan, cols: fieldSpec.cols, fresOn: false, fresBands: 3 }),
        { gN: L.gN, BW: L.BW });
    };
    expect(mk(true).layers.map((l) => l.d)).not.toEqual(mk(false).layers.map((l) => l.d));
  }, 120000);

  test("the mode is plain data, so it crosses to the render worker", () => {
    const S = scene({ refract: true, surfaceTilt: 0.4 });
    const clone = v8.deserialize(v8.serialize({
      refract: S.refract, surfaceTilt: S.surfaceTilt }));
    expect(clone).toEqual({ refract: true, surfaceTilt: 0.4 });
  });
});
