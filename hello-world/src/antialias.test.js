import { ANTIALIAS, ANTIALIAS_DEFAULT, antialiasAt, polishPlan, EXPORT_POLISH,
         buildPaperImage, computeFit,
         RASTER_LEVELS, buildSolid3D } from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * Antialiasing
 *
 * The scene setting that blurs the field before the regions are cut, so a
 * distant edge stops zigzagging against the raster grid it is traced on. Two
 * things are worth pinning: that it is off unless asked for, so no saved scene
 * changes on its own, and that every output reads the same number off it —
 * the preview, the PNG, the video frames and the paper stack are one picture,
 * and only the SVG adds its own polish on top.
 * ------------------------------------------------------------------ */

const points = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).length / 2;
const verts = (r) => r.layers.reduce((n, l) => n + points(l.d), 0);

test("the steps go off, then up, and a scene starts with none", () => {
  expect(ANTIALIAS[0].passes).toBe(0);
  expect(ANTIALIAS[ANTIALIAS_DEFAULT].passes).toBe(0);
  for (let i = 1; i < ANTIALIAS.length; i++) {
    expect(ANTIALIAS[i].passes).toBeGreaterThan(ANTIALIAS[i - 1].passes);
  }
  // a slider that ran off either end still names a step
  expect(antialiasAt(-3)).toBe(ANTIALIAS[0]);
  expect(antialiasAt(99)).toBe(ANTIALIAS[ANTIALIAS.length - 1]);
});

test("every output polishes by what the preview did, and only the SVG adds", () => {
  const light = ANTIALIAS[1].passes, ex = EXPORT_POLISH[1].passes;
  const p = polishPlan(light, ex);
  // the PNG, the video and the paper stack are the picture on screen
  expect([p.png, p.paper]).toEqual([p.preview, p.preview]);
  expect(p.preview).toBe(light);
  // the file is that, plus the step it asks for on the way out
  expect(p.svg).toBe(light + ex);
  expect(p.retrace).toBe(true);
  // with nothing extra to add, there is nothing to retrace for
  expect(polishPlan(light, 0)).toMatchObject({ svg: light, retrace: false });
  // and off is off, everywhere
  expect(polishPlan(0, 0)).toMatchObject({ preview: 0, png: 0, paper: 0, svg: 0 });
});

// The saved scene, at the raster it was saved at, is what this setting exists
// for: the far half of that frame is where the grid shows. Draft here, so the
// suite stays quick — the artifact is the same one, only coarser.
test("antialiasing the saved scene keeps every band and takes the wobble off it", () => {
  const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
  const L = RASTER_LEVELS[0];
  const off = buildSolid3D(S, fieldSpec, { gN: L.gN, BW: L.BW, polish: 0 });
  let prev = verts(off);
  for (let i = 1; i < ANTIALIAS.length; i++) {
    const on = buildSolid3D(S, fieldSpec,
      { gN: L.gN, BW: L.BW, polish: ANTIALIAS[i].passes });
    // no band is smoothed out of existence, however far the slider goes
    expect(on.layers.length).toBe(off.layers.length);
    for (const l of on.layers) expect(l.d).toMatch(/Z/);
    // fewer vertices along the same outlines: the pixel-scale zigzag is what
    // is gone, and each step takes more of it than the one before
    expect(verts(on)).toBeLessThan(prev);
    prev = verts(on);
  }
}, 180000);

// The paper stack is cut from the same picture, resolved a pixel at a time
// instead of a boundary at a time, so it has to carry the setting too — a
// sheet whose edge is the raster staircase is a staircase to cut out.
test("the paper image carries it, without inventing a color to do it", () => {
  const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
  const L = RASTER_LEVELS[0];
  const at = (polish) => buildPaperImage(S, computeFit(S), {
    gN: L.gN, BW: L.BW, lift: true, bgColor: "#ffffff",
    maxColors: 0,                       // no posterizing: compare the real palette
    polish, ...fieldSpec,
  });
  // boundary length: how many neighbouring pixels disagree about their color.
  // Blurring the fields the colors are read from should straighten the edges,
  // so this falls; it is the same wobble the contour path traces as a zigzag.
  const edges = (img) => {
    const { W, H, grid } = img;
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) {
      const p = y * W + x;
      if (grid[p] !== grid[p - 1]) n++;
      if (y && grid[p] !== grid[p - W]) n++;
    }
    return n;
  };
  const off = at(0), on = at(ANTIALIAS[1].passes);
  expect(edges(on)).toBeLessThan(edges(off));
  // the blur is on the fields, never on the colors: every sheet is still one
  // of the papers the scene was painted with
  expect(new Set(on.palette).size).toBeLessThanOrEqual(new Set(off.palette).size);
  for (const c of on.palette) expect(off.palette).toContain(c);
}, 180000);
