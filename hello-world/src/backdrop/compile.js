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
import { renderContent, docHasShapes, isStatedContent } from "./document";
import { rasterizeShapes } from "./shapes";
import { makePlanePlace, makeFloorPlace } from "./place";

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
function flattenKeyed(doc, EW, EH, flats, fillHoles) {
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

  flats.forEach((f, li) => {
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
    } else if (isStatedContent(f.content)) {
      // Stated content (a tile grid) is not painted, so the argument below
      // does not apply to it: it has as much detail as the grid it is asked
      // for, and a grout line wants to be thin. Render it at the compiler's
      // resolution and key it by colour like any other flat — a tiled floor
      // is two or three regions (grout, and each tile colour), not one per
      // tile, because colour is what a region is keyed on.
      const src = renderContent(f.content, EW, EH, 1);
      for (let p = 0; p < EW * EH; p++) {
        const v = src[p];
        if (v == null) continue;
        cells[p] = v;
        labels[p] = keyFor(`${li}:c:${v}`, v, li, -1);
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

  let fill = -1;
  for (let p = 0; p < EW * EH; p++) if (labels[p] >= 0) { fill = labels[p]; break; }
  if (fill < 0) return null;
  // The furthest flat is what the water falls back on, so it may not have a
  // hole in it: a null cell has no colour to contour, and anything still
  // uncovered takes the lowest colour it can see. A board is the opposite —
  // its transparent cells are where the sky behind it shows through, and
  // filling them would turn every board into a solid slab.
  if (fillHoles) {
    for (let p = 0; p < EW * EH; p++) {
      if (labels[p] < 0) { labels[p] = fill; cells[p] = info[fill].color; }
    }
  }
  return { cells, labels, info };
}

// Stack the regions bottom-up. Within a colour-keyed layer that is the mean
// row of the region's cells, as it has always been; a shape layer keeps the
// order the shapes are in, which is the order they were drawn in and the order
// the panel shows. Layers themselves stack in their own order.
function stackRegions(doc, EW, EH, flats, fillHoles) {
  const flat = flattenKeyed(doc, EW, EH, flats, fillHoles);
  if (!flat) return null;
  const { cells, labels, info } = flat;
  const K = info.length;
  const areas = new Float64Array(K), rowSum = new Float64Array(K);
  for (let p = 0; p < EW * EH; p++) {
    const k = labels[p];
    if (k < 0) continue;                        // a hole in a board
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
function groupOf(stack, place) {
  const { colorOf, order, K } = stack;
  return {
    place,
    EW: stack.EW, EH: stack.EH, cells: stack.cells,
    count: K,
    colorAt: (k) => colorOf[order[k]],
    eachField: (visit) => eachStackField(stack, visit),
  };
}

/**
 * Compile a document into what the renderer needs.
 *
 * The result is a list of GROUPS, furthest first. Every flat on the sky is one
 * group — they share a coordinate space, so they composite into one grid the
 * way they always have. A flat standing at a distance is its own group,
 * because it has its own space: its own ray query, its own hit and miss.
 *
 * Across groups the renderer paints far to near with each group drawn whole,
 * so no group cuts a hole in the one behind it and there is no seam to open.
 * Within a group the union construction is unchanged, which is what keeps
 * neighbours from parting. A document with no boards compiles to exactly one
 * group, which is exactly what it compiled to before there were boards.
 */
export function compileBackdrop(doc, opts = {}) {
  // shapes render onto a finer grid than the brush paints on; everything else
  // compiles at the resolution it was authored at
  const stated = docHasShapes(doc) || doc.flats.some((f) => isStatedContent(f.content));
  const scale = opts.scale || (stated ? COMPILE_SCALE : 1);
  const EW = doc.w * scale, EH = doc.h * scale;

  const placed = (f, k) => f.place && f.place.kind === k;
  const sky = doc.flats.filter((f) => !placed(f, "plane") && !placed(f, "floor"));
  const boards = doc.flats.filter((f) => placed(f, "plane"));
  // A floor is under everything, so it goes in first and every other flat
  // draws over it.
  const floors = doc.flats.filter((f) => placed(f, "floor"));

  const groups = [];
  floors.forEach((f) => {
    const st = stackRegions(doc, EW, EH, [f], true);
    if (st) groups.push(groupOf(st, makeFloorPlace(f.place)));
  });
  const skyStack = sky.length ? stackRegions(doc, EW, EH, sky, true) : null;
  // the sky is a flat at infinity, and saying so keeps the group list
  // self-describing: every group has a distance, and they come out sorted
  if (skyStack) groups.push(groupOf(skyStack, { kind: "sky", distance: Infinity }));
  // furthest board first; boards at the same distance keep the document's order
  boards
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (b.f.place.distance - a.f.place.distance) || (a.i - b.i))
    .forEach(({ f }) => {
      const st = stackRegions(doc, EW, EH, [f], false);
      if (st) groups.push(groupOf(st, makePlanePlace(f.place)));
    });
  if (!groups.length) return null;

  const count = groups.reduce((n, g) => n + g.count, 0);
  const base = groups[0];
  return {
    groups, scale, count,
    overflow: count > MAX_REGIONS,
    // the furthest group is the one the water falls back on, and the one the
    // single-group paths (the panorama preview, the paper export) still read
    EW: base.EW, EH: base.EH, cells: base.cells,
    bg: base.cells[0],
    colorAt: (k) => base.colorAt(k),
    eachField: (visit) => base.eachField(visit),
  };
}
