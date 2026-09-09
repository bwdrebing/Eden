// ------------------------------------------------------------------ //
//  A painted 2D backdrop, on the saved scene's camera
//
//  GRAZING_RIPPLES is a 1D scene, so it never exercises the panorama path —
//  the per-color signed distance fields, the stack order, the object stamp,
//  the ink rims. This is that scene's camera and waves with a painted
//  panorama in front of it, built deterministically so the same call always
//  produces the same geometry.
//
//  It exists to be diffed. backdropParity.test.js renders it and compares
//  against a recorded baseline, which is how the backdrop rearchitecture
//  proves it did not move a single path.
// ------------------------------------------------------------------ //
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";
import { envFromRows, stampObjects, ENV2D_W } from "./WaterReflectionContours";

export const PAINTED_AZ_SPAN = 40;
const PW = ENV2D_W, PH = 52;

// A shoreline: sky ramp, a treeline band, a white strip on the water, and a
// hand-painted dark blob off to one side — four shapes with hard edges, which
// is what the per-color distance fields have to keep smooth.
export function paintedPanorama() {
  const bands = [
    [0.00, "#141d33"], [0.16, "#27406b"], [0.30, "#3f5f93"],
    [0.42, "#ffffff"], [0.50, "#9cc3e8"], [0.72, "#cfe1ef"], [0.88, "#f2f7fb"],
  ];
  const env = envFromRows((f) => {
    let c = bands[0][1];
    for (const [at, col] of bands) if (f >= at) c = col;
    return c;
  }, PW, PH);
  const cells = env.cells.slice();
  // a blob that spans rows and columns, so its region is not a stripe
  for (let r = 12; r < 30; r++) {
    const halfW = Math.round(7 - Math.abs(r - 21) * 0.35);
    for (let c = 18 - halfW; c <= 18 + halfW; c++) {
      if (c >= 0 && c < PW) cells[r * PW + c] = "#0a130d";
    }
  }
  // a second region in a color already used elsewhere, which today fuses with
  // it into one region — the behavior the region model has to keep until the
  // model itself changes
  for (let r = 34; r < 38; r++) {
    for (let c = 60; c < 74; c++) cells[r * PW + c] = "#ffffff";
  }
  return { w: PW, h: PH, cells };
}

export function paintedScene() {
  const { S } = buildScene(GRAZING_RIPPLES);
  // a smaller grid than the saved 220: the parity check wants every code path,
  // not every sample, and 220^2 x 20 regions is a slow test
  S.nx = S.ny = 96;
  // the saved scene's window is 6deg-15deg, a telephoto slice well above the
  // horizon; objects sit ON the waterline, so in that window every one of them
  // falls off the bottom of the panorama and stamps nothing. A normal window
  // puts them back in frame.
  S.eLo = -5; S.eHi = 33;
  const objects = [
    { id: 1, on: true, type: "sailboat", az: -12, size: 5.5,
      color: "#c2452e", color2: "#f6f2e7" },
    { id: 2, on: true, type: "dock", az: 22, size: 3, color: "#3a2c22", color2: "#8a6f52" },
  ];
  const env = stampObjects(paintedPanorama(), objects, PAINTED_AZ_SPAN, S.eLo, S.eHi);
  return { S, env, azSpan: PAINTED_AZ_SPAN };
}
