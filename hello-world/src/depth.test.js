import { buildSegmentation, buildSkyRegions, computeFit, SKY_PAD, envFromRows }
  from "./WaterReflectionContours";
import { compileBackdrop } from "./backdrop/compile";
import {
  backdropDoc, flat, rasterContent, rampContent, DOC_W, DOC_H,
} from "./backdrop/document";

/* ------------------------------------------------------------------ *
 * Depth, in the render
 *
 * The placement tests in backdrop/place.test.js check the intersection on its
 * own. These check the thing it was for: that a flat standing at a distance
 * behaves in the picture like something at a distance — it is missing from
 * water that cannot see it, it covers what is behind it, and it is not the
 * same from everywhere the way the sky is.
 * ------------------------------------------------------------------ */

const AZ = 45;
const scene = (extra = {}) => ({
  nx: 80, ny: 80, xMin: -20, xMax: 20, yMin: 6, yMax: 60,
  H: 0.4 * Math.pow(22.5, 0.6), pitch: (20 * Math.PI) / 180,
  k: (2 * Math.PI) / 2.2, amp: 0.02, sharp: 0, decay: 0.1, omega: 1, t: 3,
  bands: 5, perspective: true, eLo: -3, eHi: 24, zoom: 1, panX: 0, panY: 0,
  smooth: 2, coherence: 0, rectOutput: false, surface3d: false, waveScale: 1,
  fresOn: false, fresBands: 3, reflMag: 1,
  emitters: [{ id: 1, on: true, type: "swell", x: 0, y: 20, dir: 90, size: 3,
    amp: 1, spread: 30, roughness: 0, detail: 8 }],
  ...extra,
});

const sky = (color) => flat(rasterContent(envFromRows(() => color, DOC_W, DOC_H)), "Sky");
const board = (color, place) => ({
  ...flat(rasterContent(envFromRows(() => color, DOC_W, DOC_H)), "Board"),
  place: { kind: "plane", ...place },
});

const compiled = (flats) => compileBackdrop(backdropDoc(flats, DOC_W, DOC_H));
const colors = (seg) => seg.layers.map((l) => l.color);

describe("a flat standing at a distance", () => {
  test("is drawn as its own region, over the sky", () => {
    const S = scene();
    const seg = buildSegmentation(S, compiled([
      sky("#141d33"),
      board("#ff00ff", { distance: 14, width: 60, height: 14 }),
    ]), AZ);
    expect(colors(seg)).toContain("#ff00ff");
    // the sky is painted first, the board over it
    expect(colors(seg).indexOf("#141d33")).toBeLessThan(colors(seg).indexOf("#ff00ff"));
  });

  test("is missing from water it cannot reach", () => {
    // a board close in, on water that runs far past it: the far water reflects
    // rays that leave without ever arriving, so there is nothing of it there
    const S = scene({ yMin: 30, yMax: 60 });
    const far = buildSegmentation(S, compiled([
      sky("#141d33"), board("#ff00ff", { distance: 8, width: 60, height: 14 }),
    ]), AZ);
    expect(colors(far)).not.toContain("#ff00ff");

    const near = buildSegmentation(scene({ yMin: 6, yMax: 20 }), compiled([
      sky("#141d33"), board("#ff00ff", { distance: 30, width: 60, height: 14 }),
    ]), AZ);
    expect(colors(near)).toContain("#ff00ff");
  });

  test("a nearer board covers a further one", () => {
    const S = scene();
    const seg = buildSegmentation(S, compiled([
      sky("#141d33"),
      board("#00ff00", { distance: 40, width: 80, height: 20 }),
      board("#ff00ff", { distance: 12, width: 80, height: 20 }),
    ]), AZ);
    const c = colors(seg);
    expect(c).toContain("#00ff00");
    expect(c).toContain("#ff00ff");
    expect(c.indexOf("#00ff00")).toBeLessThan(c.indexOf("#ff00ff"));
  });

  test("the document's order does not outrank the distance", () => {
    // the near board listed first still ends up in front
    const S = scene();
    const seg = buildSegmentation(S, compiled([
      sky("#141d33"),
      board("#ff00ff", { distance: 12, width: 80, height: 20 }),
      board("#00ff00", { distance: 40, width: 80, height: 20 }),
    ]), AZ);
    const c = colors(seg);
    expect(c.indexOf("#00ff00")).toBeLessThan(c.indexOf("#ff00ff"));
  });

  test("moving it out changes the picture; the sky would not have", () => {
    const S = scene();
    const at = (distance) => buildSegmentation(S, compiled([
      sky("#141d33"), board("#ff00ff", { distance, width: 60, height: 14 }),
    ]), AZ).layers.find((l) => l.color === "#ff00ff");
    const near = at(10), far = at(34);
    expect(near).toBeTruthy();
    expect(far).toBeTruthy();
    expect(near.d).not.toBe(far.d);
  });

  test("a narrower board reflects over less of the water", () => {
    // its edges are where it ends, not where the window ends: rays that pass
    // beside it miss it. (Height does not tell the same story on a grazing
    // scene like this one — every ray that reaches the board reaches it low.)
    const S = scene();
    const area = (width) => {
      const l = buildSegmentation(S, compiled([
        sky("#141d33"), board("#ff00ff", { distance: 16, width, height: 14 }),
      ]), AZ).layers.find((x) => x.color === "#ff00ff");
      return l ? l.d.length : 0;
    };
    expect(area(60)).toBeGreaterThan(area(8));
  });

  test("a hidden board is not in the picture at all", () => {
    const S = scene();
    const b = board("#ff00ff", { distance: 14, width: 60, height: 14 });
    const seg = buildSegmentation(S, compiled([sky("#141d33"), { ...b, visible: false }]), AZ);
    expect(colors(seg)).not.toContain("#ff00ff");
  });
});

describe("the same board, drawn and reflected", () => {
  test("shows up above the horizon as well as in the water", () => {
    const S = scene({ skyPad: SKY_PAD });
    const doc = compiled([
      flat(rampContent("Treeline"), "Sky"),
      board("#ff00ff", { distance: 16, width: 60, height: 14 }),
    ]);
    const above = buildSkyRegions(S, computeFit(S), doc, AZ);
    expect(above).not.toBeNull();
    expect(above.map((l) => l.color)).toContain("#ff00ff");
    // and the water below reflects it
    expect(colors(buildSegmentation(S, doc, AZ))).toContain("#ff00ff");
  });
});
