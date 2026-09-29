import {
  buildSolid3D, buildRocks, buildPaperImage, computeFit, prepField, heightAt, loopFit,
  penProject, RASTER_LEVELS,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";
import { prepRock, rockSdf, ROCK_COLOR } from "./rocks";

/* ------------------------------------------------------------------ *
 * Rocks standing in the water
 *
 * One shape, three uses: the rock drawn where it stands, its reflection in
 * the water, and the rings it throws back. The first always shows; the other
 * two each have a switch, and off must mean off.
 * ------------------------------------------------------------------ */

const L = RASTER_LEVELS[0];
const RASTER = { gN: L.gN, BW: L.BW };
// in frame for the saved scene's zoomed camera
const ROCK = { id: 1, on: true, x: -3, y: 22, size: 1.2, height: 0.8, turn: 20,
  stretch: 1.6, shape: 0.8, seed: 1 };

const scene = (extra) => buildScene({ ...GRAZING_RIPPLES, ...extra });
const points = (d) => {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};
const bbox = (d) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of points(d)) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1 };
};

test("a rock is the same rock every time, and jagged breaks it into pieces", () => {
  const a = prepRock(ROCK), b = prepRock({ ...ROCK });
  expect(rockSdf(a, -3, 22, 0.2)).toBe(rockSdf(b, -3, 22, 0.2));
  expect(rockSdf(a, -3, 22, 0.2)).toBeLessThan(0);          // solid at its middle
  expect(rockSdf(a, 10, 22, 0.2)).toBeGreaterThan(5);       // nothing far off
  expect(prepRock({ ...ROCK, shape: 0 }).chunks.length).toBe(1);
  expect(prepRock({ ...ROCK, shape: 1 }).chunks.length).toBeGreaterThan(1);
  // another seed is another rock
  expect(rockSdf(prepRock({ ...ROCK, seed: 2 }), -3, 22, 0.6))
    .not.toBe(rockSdf(a, -3, 22, 0.6));
});

test("no rocks, no paths — and the water is untouched by the option existing", () => {
  const bare = scene({});
  const plain = buildSolid3D(bare.S, bare.fieldSpec, RASTER);
  expect(plain.rocks).toBe(null);
  const off = scene({ rocks: [{ ...ROCK, on: false }] });
  const offOut = buildSolid3D(off.S, off.fieldSpec, RASTER);
  expect(offOut.rocks).toBe(null);
  expect(offOut.layers.map((l) => l.d)).toEqual(plain.layers.map((l) => l.d));
}, 120000);

test("the rock stands where it was put, and its reflection lies below it", () => {
  const { S, fieldSpec } = scene({ rocks: [ROCK], rockRip: false });
  const out = buildSolid3D(S, fieldSpec, RASTER);
  expect(out.rocks.over).toHaveLength(1);
  expect(out.rocks.over[0].color).toBe(ROCK_COLOR);
  const body = bbox(out.rocks.over[0].d);
  const at = penProject(ROCK.x, ROCK.y, 0, S, computeFit(S));
  expect(at[0]).toBeGreaterThan(body.x0); expect(at[0]).toBeLessThan(body.x1);
  expect(at[1]).toBeGreaterThan(body.y0 - 5); expect(at[1]).toBeLessThan(body.y1 + 5);
  // the reflection hangs from the waterline, nearer the camera: lower in frame
  expect(out.rocks.under).toHaveLength(1);
  const img = bbox(out.rocks.under[0].d);
  expect(img.y1).toBeGreaterThan(body.y1);
  expect((img.x0 + img.x1) / 2).toBeGreaterThan(body.x0);
  expect((img.x0 + img.x1) / 2).toBeLessThan(body.x1);
}, 120000);

test("reflections off means no reflection, and the rock itself stays", () => {
  const { S, fieldSpec } = scene({ rocks: [ROCK], rockRefl: false, rockRip: false });
  const out = buildSolid3D(S, fieldSpec, RASTER);
  expect(out.rocks.under).toHaveLength(0);
  expect(out.rocks.over).toHaveLength(1);
}, 120000);

test("ripples ring the rock, die away, and switch off completely", () => {
  const on = scene({ rocks: [ROCK] }).S;
  const off = scene({ rocks: [ROCK], rockRip: false }).S;
  const bare = scene({}).S;
  prepField(on); prepField(off); prepField(bare);
  // off is exactly the scene without a rock, down to the bit
  for (const [x, y] of [[-3, 24.5], [0, 30], [-8, 18]])
    expect(heightAt(x, y, off)).toBe(heightAt(x, y, bare));
  // near the rock, the rings change the water; far away they do not
  const near = [[-3, 24], [-1, 22.5], [-5, 21]].some(
    ([x, y]) => Math.abs(heightAt(x, y, on) - heightAt(x, y, bare)) > 1e-4);
  expect(near).toBe(true);
  expect(heightAt(20, 70, on)).toBe(heightAt(20, 70, bare));
  // they move, so a looped clip has to count them
  expect(loopFit(on, 40).components).toBe(loopFit(bare, 40).components + 1);
});

test("the flat modes and pen mode get the rocks on a raster of their own", () => {
  const { S } = scene({ rocks: [ROCK], rockRip: false });
  const flat = buildRocks({ ...S, surface3d: false }, RASTER);
  expect(flat.over).toHaveLength(1);
  expect(flat.under).toHaveLength(1);
  expect(buildRocks({ ...S, rocks: [] }, RASTER)).toBe(null);
}, 120000);

test("the paper stack cuts the rock as a sheet of its own", () => {
  const { S, fieldSpec } = scene({ rocks: [ROCK], rockRip: false });
  const fit = computeFit(S);
  prepField(S);
  const img = buildPaperImage(S, fit, { gN: L.gN, BW: 240, ...fieldSpec });
  expect(img.palette).toContain(ROCK_COLOR);
}, 120000);
