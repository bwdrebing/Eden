import { buildSolid3D } from "./WaterReflectionContours";
import { HARBOR_WAKE, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * "Edge ripple" (coherence) in the 3D builders
 *
 * The slider blurs the reflected field in water space before the regions are
 * cut. The flat builders do it on their own sample grid; the 3D builders only
 * ever see the field at mesh vertices, and used to skip it entirely — so a
 * scene lost every pass of blur the moment the surface was lifted. On
 * HARBOR_WAKE that turned one contour into a run of scallops with the mesh's
 * own period. These pin that it reaches the 3D path, and that scaling the
 * passes to the mesh keeps the slider meaning the same thing at every raster.
 * ------------------------------------------------------------------ */

const rings = (layers) => layers.reduce((n, l) => n + (l.d.match(/Z/g) || []).length, 0);
const solid = (over, gN, BW = 900) => {
  const { S, fieldSpec } = buildScene({ ...HARBOR_WAKE, ...over });
  return buildSolid3D(S, fieldSpec, { gN, BW });
};

test("the slider reaches the lifted surface at all", () => {
  const off = rings(solid({ coherence: 0 }, 260).layers);
  const on = rings(solid({}, 260).layers);            // the scene ships at 4
  expect(off).toBeGreaterThan(30);                    // the scallops, as separate rings
  expect(on).toBeLessThan(off * 0.7);
});

test("more of it is monotonically calmer", () => {
  const counts = [0, 2, 4, 8].map((c) => rings(solid({ coherence: c }, 260).layers));
  for (let i = 1; i < counts.length; i++)
    expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
});

test("it means the same thing at every mesh, so preview and export agree", () => {
  // passes scale with the mesh because a box blur's reach goes with the cell
  // size; without that the same scene would keep getting sharper as the mesh
  // got finer, and an export would not match what was on screen
  const counts = [150, 200, 260, 320, 400].map((gN) => rings(solid({}, gN).layers));
  const lo = Math.min(...counts), hi = Math.max(...counts);
  expect(hi - lo).toBeLessThanOrEqual(2);
});

test("with the slider at zero the 3D path is left exactly as it was", () => {
  // the blur is skipped, not applied with zero passes — same object, no copy
  const a = solid({ coherence: 0 }, 260).layers.map((l) => l.d).join("");
  const b = solid({ coherence: 0 }, 260).layers.map((l) => l.d).join("");
  expect(a).toBe(b);
  expect(rings(solid({ coherence: 0 }, 260).layers))
    .not.toBe(rings(solid({ coherence: 4 }, 260).layers));
});
