// ------------------------------------------------------------------ //
//  The backdrop document
//
//  What the water reflects, as a thing you can hold, separate from the buffer
//  the renderer samples. That separation is the point: the old model made the
//  84x52 grid of hex strings BOTH the document you paint and the field the
//  segmentation reads, so a stroke destroyed information and every rule you
//  had in your head could only be baked into pixels by hand.
//
//  A document is an ordered stack of FLATS, far first, near last. A flat is
//  content placed on a surface:
//
//    place    where it stands. Today only { kind: "sky" } — the sphere at
//             infinity, indexed by direction. A flat at a finite distance is
//             the same shape of thing with a distance on it.
//    content  what is on it, as one of the kinds below. Every kind answers the
//             same question — what colour is at (col, row) — and may answer
//             null, meaning the flat behind shows through. That null is what
//             makes layers layers.
//
//  Content kinds:
//    ramp     a palette down the elevation, the preset backdrop as a layer
//    stripes  a run of bands, optionally repeating: "two blue rows, one white
//             row, all the way up". The generalisation of the painted 1D strip
//    raster   painted cells, what the brush produces
//    shapes   stated rather than drawn — a rectangle at a position, this wide
//             and this tall — so it can be moved afterwards, and rendered at
//             whatever resolution the compiler asks for rather than the
//             brush's (see shapes.js)
//
//  See docs/backdrop-system.md.
// ------------------------------------------------------------------ //
import * as d3 from "d3";
import { paletteColorAt } from "./palettes";
import { rasterizeShapes, shapesContent } from "./shapes";

export { shapesContent };

export const DOC_VERSION = 2;
// The document's cell grid: width is azimuth, height is elevation, row 0 is
// the waterline. Generated content is rendered onto it and the brush paints
// into it, so it is the resolution of the backdrop as a picture.
export const DOC_W = 84;
export const DOC_H = 52;

// ---- content -------------------------------------------------------

export const rampContent = (palette) => ({ kind: "ramp", palette });

export const stripesContent = (bands, repeat = true, anchor = 0) =>
  ({ kind: "stripes", bands, repeat, anchor });

// A tiled floor: square tiles of `tiles` per document block, separated by
// grout `grout` wide as a fraction of a tile. This is the pool bottom, and it
// is STATED rather than painted — so, like shapes, it renders onto the
// compiler's finer grid instead of the brush's, which is what lets a grout
// line be thin without the document being enormous.
//
// Two properties exist for the repeating floor it is meant to sit on (see
// makeFloorPlace), and both are load-bearing rather than cosmetic:
//
//   * the block is offset by HALF a tile, so the document's edges cut through
//     the middle of a tile and never along a grout line.
//   * per-tile colour is keyed on the tile's index within the block, so the
//     copy of a tile on the far side of a seam is the same colour as the one
//     it continues.
export const gridContent = (tiles = 8, grout = 0.12, colors = null, jitter = 0.5) =>
  ({ kind: "grid", tiles, grout, colors: colors || GRID_COLORS, jitter });

export const GRID_COLORS = ["#2e6f9e", "#3f86b4", "#57a0c6", "#1f5c88"];
export const GRID_GROUT = "#cfe4ef";

export const rasterContent = (env) =>
  ({ kind: "raster", w: env.w, h: env.h, cells: env.cells });

export const emptyRaster = (w = DOC_W, h = DOC_H) =>
  ({ kind: "raster", w, h, cells: new Array(w * h).fill(null) });

// horizontal-stripe raster from any elevation->color function
export function envFromRows(colorAtF, w, h) {
  const cells = new Array(w * h);
  for (let r = 0; r < h; r++) {                 // r = 0 is the waterline
    const c = d3.color(colorAtF(r / (h - 1))).formatHex();
    for (let col = 0; col < w; col++) cells[r * w + col] = c;
  }
  return { w, h, cells };
}

// soften a painted raster: 3x3 RGB box blur of the cells, so neighbouring
// colors melt into each other instead of meeting at hard seams. Transparent
// cells stay transparent and take no part in the average.
export function smoothEnv2D(env) {
  const { w, h, cells } = env;
  const out = new Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (cells[r * w + c] == null) { out[r * w + c] = null; continue; }
      let R = 0, G = 0, B = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const v = cells[rr * w + cc];
        if (v == null) continue;
        const col = d3.rgb(v); R += col.r; G += col.g; B += col.b; n++;
      }
      out[r * w + c] = n ? d3.rgb(R / n, G / n, B / n).formatHex() : cells[r * w + c];
    }
  }
  return { w, h, cells: out };
}

// Total height of one run through the band list. A repeat tiles this.
export const stripesPeriod = (content) =>
  content.bands.reduce((n, b) => n + Math.max(1, b.size | 0), 0);

function stripeColorAtRow(content, row) {
  const period = stripesPeriod(content);
  if (period <= 0) return null;
  let r = row - (content.anchor | 0);   // `row` is already in document rows
  if (content.repeat) {
    r = ((r % period) + period) % period;       // tile in both directions
  } else if (r < 0 || r >= period) {
    return null;                                // one run only: the rest shows through
  }
  for (const b of content.bands) {
    const size = Math.max(1, b.size | 0);
    if (r < size) return b.color;
    r -= size;
  }
  return null;
}

/**
 * Render content onto a w x h grid. Null means transparent.
 *
 * `rowScale` is how many grid rows one document row comes to, so content
 * measured in document rows — a repeat's band sizes — keeps its proportions
 * when the compiler renders onto a finer grid than the brush paints on.
 */
export function renderContent(content, w = DOC_W, h = DOC_H, rowScale = 1) {
  if (!content) return new Array(w * h).fill(null);
  if (content.kind === "raster") {
    if (content.w === w && content.h === h) return content.cells;
    // a raster saved at another size: nearest-neighbour so a document from an
    // older link still lands on the current grid
    const out = new Array(w * h);
    for (let r = 0; r < h; r++) {
      const sr = Math.min(content.h - 1, Math.floor((r * content.h) / h));
      for (let c = 0; c < w; c++) {
        const sc = Math.min(content.w - 1, Math.floor((c * content.w) / w));
        out[r * w + c] = content.cells[sr * content.w + sc];
      }
    }
    return out;
  }
  if (content.kind === "ramp") {
    return envFromRows((f) => paletteColorAt(content.palette, f), w, h).cells;
  }
  if (content.kind === "stripes") {
    const out = new Array(w * h);
    for (let r = 0; r < h; r++) {
      const c = stripeColorAtRow(content, Math.floor(r / rowScale));
      for (let col = 0; col < w; col++) out[r * w + col] = c;
    }
    return out;
  }
  if (content.kind === "grid") {
    const out = new Array(w * h);
    const N = Math.max(1, content.tiles | 0);
    const g = Math.min(0.45, Math.max(0, content.grout));
    const cols = content.colors && content.colors.length ? content.colors : GRID_COLORS;
    const jit = content.jitter == null ? 0.5 : content.jitter;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        // half-tile offset: the block's edges land mid-tile, not on grout
        const u = (c + 0.5) / w * N + 0.5, v = (r + 0.5) / h * N + 0.5;
        const iu = Math.floor(u), iv = Math.floor(v);
        const fu = u - iu, fv = v - iv;
        // distance into the tile from its nearest edge, in tile fractions
        const d = Math.min(fu, 1 - fu, fv, 1 - fv);
        if (d < g / 2) { out[r * w + c] = GRID_GROUT; continue; }
        // keyed on the WITHIN-BLOCK tile index so the repeat is seamless
        const ti = ((iu % N) + N) % N, tj = ((iv % N) + N) % N;
        const hsh = (ti * 73856093) ^ (tj * 19349663);
        const pick = jit <= 0 ? 0
          : Math.abs(hsh + (hsh >> 13)) % Math.max(1, Math.round(cols.length * jit) || 1);
        out[r * w + c] = cols[pick % cols.length];
      }
    }
    return out;
  }
  if (content.kind === "shapes") {
    return rasterizeShapes(content.items, w, h, () => 0).cells;
  }
  return new Array(w * h).fill(null);
}

// ---- flats and documents -------------------------------------------

let nextId = 1;
export const newFlatId = () => "f" + nextId++;

export const flat = (content, name, extra = {}) => ({
  id: newFlatId(), name, visible: true, place: { kind: "sky" }, content, ...extra,
});

export const backdropDoc = (flats, w = DOC_W, h = DOC_H) =>
  ({ version: DOC_VERSION, w, h, flats });

// A single painted panorama as a one-flat document — how the studio's old
// paint buffer, and any link that carries one, arrives here.
export const docFromPanorama = (env, name = "Painted") =>
  backdropDoc([flat(rasterContent(env), name)], env.w, env.h);

export const docFromPalette = (palette) =>
  backdropDoc([flat(rampContent(palette), palette)]);

export const kindLabel = (content) =>
  content.kind === "ramp" ? "ramp"
    : content.kind === "stripes" ? (content.repeat ? "repeat" : "bands")
      : content.kind === "shapes" ? `${content.items.length} shape`
        + (content.items.length === 1 ? "" : "s")
        : content.kind === "grid" ? `${content.tiles}x${content.tiles} tiles`
          : "painted";

// Content that is STATED rather than painted, and so is worth rendering onto
// the compiler's finer grid: a brush stroke has no detail below the cell it
// was painted in, but a grid line or a shape edge has as much as you ask for.
export const isStatedContent = (content) =>
  !!content && (content.kind === "shapes" || content.kind === "grid");

export const docHasShapes = (doc) =>
  doc.flats.some((f) => f.visible && f.content.kind === "shapes");

// ---- editing (all pure: hand back a new document) ------------------

const withFlats = (doc, flats) => ({ ...doc, flats });

export const flatIndex = (doc, id) => doc.flats.findIndex((f) => f.id === id);

export function updateFlat(doc, id, patch) {
  return withFlats(doc, doc.flats.map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

export function addFlat(doc, content, name, aboveId) {
  const f = flat(content, name);
  const at = aboveId ? flatIndex(doc, aboveId) + 1 : doc.flats.length;
  const flats = doc.flats.slice();
  flats.splice(at, 0, f);
  return { doc: withFlats(doc, flats), id: f.id };
}

export function duplicateFlat(doc, id) {
  const i = flatIndex(doc, id);
  if (i < 0) return { doc, id };
  const src = doc.flats[i];
  const copy = { ...src, id: newFlatId(), name: src.name + " copy",
    content: src.content.kind === "raster"
      ? { ...src.content, cells: src.content.cells.slice() } : { ...src.content } };
  const flats = doc.flats.slice();
  flats.splice(i + 1, 0, copy);
  return { doc: withFlats(doc, flats), id: copy.id };
}

// The last flat cannot be removed: a document with nothing in it has no colour
// to give the water, and the renderer would have nothing to draw.
export function removeFlat(doc, id) {
  if (doc.flats.length <= 1) return doc;
  return withFlats(doc, doc.flats.filter((f) => f.id !== id));
}

export function moveFlat(doc, id, delta) {
  const i = flatIndex(doc, id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.flats.length) return doc;
  const flats = doc.flats.slice();
  const [f] = flats.splice(i, 1);
  flats.splice(j, 0, f);
  return withFlats(doc, flats);
}

// Freeze generated content into pixels, so the brush can touch it.
export function bakeFlat(doc, id) {
  const f = doc.flats[flatIndex(doc, id)];
  if (!f || f.content.kind === "raster") return doc;
  return updateFlat(doc, id, {
    content: { kind: "raster", w: doc.w, h: doc.h,
      cells: renderContent(f.content, doc.w, doc.h).slice() },
  });
}

// Paint into one flat's raster. `paint(cells)` mutates the copy it is given.
export function paintFlat(doc, id, paint) {
  const f = doc.flats[flatIndex(doc, id)];
  if (!f || f.content.kind !== "raster") return doc;
  const cells = f.content.cells.slice();
  paint(cells);
  return updateFlat(doc, id, { content: { ...f.content, cells } });
}

// ---- flattening ----------------------------------------------------

// Composite the visible flats far to near. A cell is whatever the nearest
// visible flat says at that point, or the one behind it where that flat is
// transparent. This is the whole of cross-flat compositing while every flat
// is on the sky; once flats stand at different distances they stop sharing a
// grid and the composite moves into the renderer's draw order instead.
export function flattenDoc(doc) {
  const { w, h } = doc;
  const visible = doc.flats.filter((f) => f.visible);
  if (!visible.length) return null;
  const cells = new Array(w * h).fill(null);
  for (const f of visible) {
    const src = renderContent(f.content, w, h);
    for (let p = 0; p < w * h; p++) if (src[p] != null) cells[p] = src[p];
  }
  // Nothing may reach the renderer as a hole: a null cell has no colour to
  // contour. Anything still uncovered takes the lowest colour it can see,
  // which is what the water would have reflected there anyway.
  let fill = null;
  for (let p = 0; p < w * h; p++) if (cells[p] != null) { fill = cells[p]; break; }
  if (fill == null) return null;
  for (let p = 0; p < w * h; p++) if (cells[p] == null) cells[p] = fill;
  return { w, h, cells };
}
