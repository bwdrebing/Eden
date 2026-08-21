import { buildSolid3D, RASTER_LEVELS, EXPORT_POLISH } from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * The saved scene, rendered
 *
 * A smoke test over a real scene rather than an invented one: it renders at
 * draft so the suite stays quick, and only asserts what any change to the
 * pipeline has to keep true — every painted band comes out, as closed filled
 * curves, inside the frame. It is here to be run, and to be the starting point
 * when a change needs looking at rather than asserting: swap the raster for
 * RASTER_LEVELS[5] and a polish step, write the paths to an .svg, and open it.
 * ------------------------------------------------------------------ */

const rings = (d) => (d.match(/Z/g) || []).length;
const points = (d) => {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};

test("the saved grazing-ripples scene renders every band it was painted with", () => {
  const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
  expect(S.zoom).toBeGreaterThan(20);           // the framing that shows edge artifacts
  // the painted strip collapses to its runs, not its distinct colors: six
  // colors, but fourteen runs of them down the elevation ramp
  expect(new Set(fieldSpec.cols).size).toBe(6);
  expect(fieldSpec.cols.length).toBe(14);
  expect(fieldSpec.thresholds.length).toBe(13);

  const L = RASTER_LEVELS[0];
  const { layers } = buildSolid3D(S, fieldSpec, { gN: L.gN, BW: L.BW });
  expect(layers.length).toBe(13);
  for (const l of layers) {
    expect(rings(l.d)).toBeGreaterThan(0);      // closed, fillable rings
    const pts = points(l.d);
    expect(pts.length).toBeGreaterThan(20);
    // one assertion per layer, not per vertex: there are ~100k of them
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    // inside the frame, allowing the one-cell overshoot the clip wants
    expect([minX > -40, maxX < 800, minY > -40, maxY < 540])
      .toEqual([true, true, true, true]);
  }
}, 120000);

test("polishing the saved scene keeps its bands and shortens its outlines", () => {
  const { S, fieldSpec } = buildScene(GRAZING_RIPPLES);
  const L = RASTER_LEVELS[0];
  const plain = buildSolid3D(S, fieldSpec, { gN: L.gN, BW: L.BW });
  const polished = buildSolid3D(S, fieldSpec,
    { gN: L.gN, BW: L.BW, polish: EXPORT_POLISH[1].passes });
  expect(polished.layers.length).toBe(plain.layers.length);
  const verts = (r) => r.layers.reduce((n, l) => n + points(l.d).length, 0);
  expect(verts(polished)).toBeLessThan(verts(plain));
}, 120000);
