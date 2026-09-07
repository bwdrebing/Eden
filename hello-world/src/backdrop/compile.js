// ------------------------------------------------------------------ //
//  Compiling a backdrop document into regions
//
//  The renderer's whole contract with a backdrop is:
//
//    an ordered list of regions, each with a color and a signed distance
//    field in the flat's own space (positive inside, negative outside, zero
//    on the boundary), bottom of the stack first.
//
//  Contouring THAT composed through the reflection is what keeps a painted
//  region's edge a smooth curve instead of a trace of the panorama's cell
//  grid — the reasoning is in the renderer, above buildSegmentation, and it
//  has not changed. What has changed is where the list comes from: a document
//  is compiled into it, rather than a grid of hex strings being reverse
//  engineered into it every render.
//
//  Two properties the renderer depends on, both preserved here:
//
//    * Region k's field is the UNION of region k and every region above it,
//      so each layer solidly contains the next. Smoothing can shift a shared
//      edge but can never open a background seam between neighbours.
//    * A hand-smoothed panorama can hold thousands of near-identical colors.
//      Past MAX_REGIONS the per-region path is abandoned for the renderer's
//      row/column fallback, where the per-cell structure is invisible because
//      neighbouring colors are near-equal.
//
//  Today a document is one raster flat, so a region is a distinct color in it
//  and the stack order is the color's mean painted row — the same heuristic as
//  before, now confined to one function (`rasterRegions`) instead of being the
//  model. When flats carry their own order, this is the only thing that
//  changes.
// ------------------------------------------------------------------ //
import * as d3 from "d3";
import { distTransform, blurField } from "./field";
import { flattenDoc } from "./document";

export const MAX_REGIONS = 160;

// Distinct colors of a raster, stacked bottom-up by the mean row of their
// painted cells — the 2D generalization of the 1D band order.
function rasterRegions(env) {
  const { w: EW, h: EH, cells } = env;
  const colorId = new Map(), colorOf = [], areas = [];
  const labels = new Int32Array(EW * EH);
  for (let p = 0; p < EW * EH; p++) {
    const c = cells[p];
    let id = colorId.get(c);
    if (id === undefined) { id = colorOf.length; colorId.set(c, id); colorOf.push(c); areas.push(0); }
    labels[p] = id; areas[id]++;
  }
  const K = colorOf.length;
  const rowSum = new Float64Array(K);
  for (let p = 0; p < EW * EH; p++) rowSum[labels[p]] += (p / EW) | 0;
  const order = d3.range(K).sort((a, b) => rowSum[a] / areas[a] - rowSum[b] / areas[b]);
  return { EW, EH, cells, labels, colorOf, areas, order, K };
}

// Walk the stack from the top down, handing each region its signed distance
// field in flat cells: >0 inside, <0 outside, zero crossing on the painted
// boundary.
function eachStackField(stack, visit) {
  const { EW, EH, labels, order, K } = stack;
  const N = EW * EH;
  const union = new Float64Array(N), inv = new Float64Array(N);
  const D0 = new Float64Array(N), tmpP = new Float64Array(N);
  for (let k = K - 1; k >= 0; k--) {   // top of the stack down, growing the union
    for (let p = 0; p < N; p++) {
      if (labels[p] === order[k]) union[p] = 1;
      inv[p] = 1 - union[p];
    }
    const D = distTransform(union, EW, EH), Dout = distTransform(inv, EW, EH);
    let thick = 0;
    for (let p = 0; p < N; p++) { D[p] -= Dout[p]; if (D[p] > thick) thick = D[p]; }
    // a light blur rounds the pixel-corner bevels of the painted boundary — in
    // FLAT space, where the corners live. (Blurring the composed field in
    // water space instead flattens every small ripple's excursion, erasing the
    // fine reflection rings the 1D path keeps.) For a stripe boundary the SDF
    // is linear across it, so the blur is a no-op there and stripes stay in
    // exact 1D parity. Skip thin unions (the topmost gradient rows): nothing
    // to round, and the blur would erase them. The sign clamp keeps solidly
    // inside/outside cells on their own side, so 1-cell features (object ink
    // rims) survive.
    if (thick >= 2) {
      for (let p = 0; p < N; p++) D0[p] = D[p];
      blurField(D, EW, EH, tmpP, 1);
      for (let p = 0; p < N; p++) {
        if (D0[p] >= 1 && D[p] < 0.25) D[p] = 0.25;
        else if (D0[p] <= -1 && D[p] > -0.25) D[p] = -0.25;
      }
    }
    visit(k, D);
  }
}

/**
 * Compile a document into what the renderer needs.
 *
 *   EW, EH     the flat's cell grid
 *   cells      the flattened raster (the fallback path and the panorama
 *              preview both read it)
 *   bg         what shows where nothing is drawn
 *   colorAt(k) the color of region k, bottom of the stack first
 *   count      how many regions there are
 *   overflow   true when there are more regions than the smooth path can take
 *   eachField  hand each region its signed distance field, top down
 */
export function compileBackdrop(doc) {
  const env = flattenDoc(doc);
  if (!env) return null;
  const stack = rasterRegions(env);
  const { colorOf, order, K } = stack;
  return {
    EW: stack.EW, EH: stack.EH, cells: stack.cells,
    bg: stack.cells[0],
    count: K,
    overflow: K > MAX_REGIONS,
    colorAt: (k) => colorOf[order[k]],
    eachField: (visit) => eachStackField(stack, visit),
  };
}
