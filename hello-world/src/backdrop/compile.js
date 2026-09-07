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
import { renderContent, docHasShapes } from "./document";
import { rasterizeShapes } from "./shapes";

export const MAX_REGIONS = 160;
// A shape layer is stated, not painted, so it can be rendered onto a finer
// grid than the brush works at — which is the whole reason a stated edge beats
// a painted one. The distance transform is linear in the cell count and runs
// once per document, so paying 16x for it buys edges the brush could not draw.
export const COMPILE_SCALE = 4;

/**
 * Composite a document into cells plus a label per cell saying WHICH REGION
 * painted it — which is the thing the old model could not say. It keyed a
 * region on its hex colour, so two shapes of one colour fused into one region
 * and an object's colour had to be nudged a few bits to stop it happening.
 *
 * Painted, ramp and repeat layers still key on colour, per layer: that is what
 * "a colour is a band" means for them, and it keeps a one-layer document
 * identical to what it compiled to before. Shape layers key per shape.
 */
function flattenKeyed(doc, EW, EH) {
  const rowScale = EH / doc.h, colScale = EW / doc.w;
  const cells = new Array(EW * EH).fill(null);
  const labels = new Int32Array(EW * EH).fill(-1);
  const info = [];                              // label -> { color, layer, item }
  const seen = new Map();
  const keyFor = (name, color, layer, item) => {
    let k = seen.get(name);
    if (k === undefined) { k = info.length; seen.set(name, k); info.push({ color, layer, item }); }
    return k;
  };

  doc.flats.forEach((f, li) => {
    if (!f.visible) return;
    if (f.content.kind === "shapes") {
      const items = f.content.items;
      const { cells: sc, keys: sk } = rasterizeShapes(items, EW, EH, (item, role) => {
        const color = role === "accent" ? item.color2
          : role === "rim" ? (item.rimColor || "#070a0e") : item.color;
        return keyFor(`${li}:${item.id}:${role}`, color, li, items.indexOf(item));
      });
      for (let p = 0; p < EW * EH; p++) {
        if (sc[p] != null) { cells[p] = sc[p]; labels[p] = sk[p]; }
      }
    } else {
      // Colour-keyed layers are authored at the document's own resolution —
      // the brush paints there, and a ramp's colours are its rows. Rendering
      // one onto the finer grid would not add detail, it would subdivide the
      // ramp into four times as many colours, and a smooth palette would blow
      // the region budget on its own. So render at the document's size and
      // repeat each cell.
      const src = renderContent(f.content, doc.w, doc.h, 1);
      for (let r = 0; r < EH; r++) {
        const sr = Math.min(doc.h - 1, Math.floor(r / rowScale));
        for (let c = 0; c < EW; c++) {
          const v = src[sr * doc.w + Math.min(doc.w - 1, Math.floor(c / colScale))];
          if (v == null) continue;
          const p = r * EW + c;
          cells[p] = v;
          labels[p] = keyFor(`${li}:c:${v}`, v, li, -1);
        }
      }
    }
  });

  // A null cell has no colour to contour, so anything still uncovered takes
  // the lowest colour it can see — what the water would have reflected there.
  let fill = -1;
  for (let p = 0; p < EW * EH; p++) if (labels[p] >= 0) { fill = labels[p]; break; }
  if (fill < 0) return null;
  for (let p = 0; p < EW * EH; p++) {
    if (labels[p] < 0) { labels[p] = fill; cells[p] = info[fill].color; }
  }
  return { cells, labels, info };
}

// Stack the regions bottom-up. Within a colour-keyed layer that is the mean
// row of the region's cells, as it has always been; a shape layer keeps the
// order the shapes are in, which is the order they were drawn in and the order
// the panel shows. Layers themselves stack in their own order.
function stackRegions(doc, EW, EH) {
  const flat = flattenKeyed(doc, EW, EH);
  if (!flat) return null;
  const { cells, labels, info } = flat;
  const K = info.length;
  const areas = new Float64Array(K), rowSum = new Float64Array(K);
  for (let p = 0; p < EW * EH; p++) {
    const k = labels[p];
    areas[k]++; rowSum[k] += (p / EW) | 0;
  }
  const meanRow = (k) => (areas[k] ? rowSum[k] / areas[k] : 0);
  const order = d3.range(K).sort((a, b) => {
    if (info[a].layer !== info[b].layer) return info[a].layer - info[b].layer;
    if (info[a].item >= 0 && info[b].item >= 0) return info[a].item - info[b].item;
    return meanRow(a) - meanRow(b);
  });
  return { EW, EH, cells, labels, colorOf: info.map((i) => i.color), areas, order, K };
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
export function compileBackdrop(doc, opts = {}) {
  // shapes render onto a finer grid than the brush paints on; everything else
  // compiles at the resolution it was authored at
  const scale = opts.scale || (docHasShapes(doc) ? COMPILE_SCALE : 1);
  const stack = stackRegions(doc, doc.w * scale, doc.h * scale);
  if (!stack) return null;
  const { colorOf, order, K } = stack;
  return {
    EW: stack.EW, EH: stack.EH, cells: stack.cells, scale,
    bg: stack.cells[0],
    count: K,
    overflow: K > MAX_REGIONS,
    colorAt: (k) => colorOf[order[k]],
    eachField: (visit) => eachStackField(stack, visit),
  };
}
