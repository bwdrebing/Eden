// ------------------------------------------------------------------ //
//  The backdrop document
//
//  What the water reflects, as a thing you can hold, separate from the buffer
//  the renderer samples. That separation is the point: the old model made the
//  84x52 grid of hex strings BOTH the document you paint and the field the
//  segmentation reads, so a stroke destroyed information, a region's identity
//  was its hex string, and stacking order was a guess made from pixels.
//
//  A document is an ordered stack of FLATS. A flat is content placed on a
//  surface:
//
//    place    where it stands. Today only { kind: "sky" } — the sphere at
//             infinity, indexed by direction. A flat at a finite distance is
//             the same shape of thing with a distance on it.
//    content  what is on it. Today only { kind: "raster" } — painted cells,
//             which is what the studio's two paint canvases produce. Ramps,
//             repeating stripes and vector shapes are further kinds, and the
//             compiler cares only that a kind can be flattened.
//
//  So this file is deliberately thin: it is the seam, holding today's single
//  painted panorama in the shape the rest of the plan needs, plus the
//  constructors that used to be scattered through the renderer.
//
//  See docs/backdrop-system.md.
// ------------------------------------------------------------------ //
import * as d3 from "d3";

export const DOC_VERSION = 2;

// ---- content -------------------------------------------------------

export const rasterContent = (env) => ({ kind: "raster", w: env.w, h: env.h, cells: env.cells });

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
// colors melt into each other instead of meeting at hard seams
export function smoothEnv2D(env) {
  const { w, h, cells } = env;
  const out = new Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const col = d3.rgb(cells[rr * w + cc]); R += col.r; G += col.g; B += col.b; n++;
      }
      out[r * w + c] = d3.rgb(R / n, G / n, B / n).formatHex();
    }
  }
  return { w, h, cells: out };
}

// ---- flats and documents -------------------------------------------

let nextId = 1;
export const skyFlat = (content, name = "Backdrop") => ({
  id: "f" + nextId++, name, visible: true, locked: false,
  place: { kind: "sky" }, soften: 0, content,
});

export const backdropDoc = (flats) => ({ version: DOC_VERSION, flats });

// The studio's painted panorama (or a stripe raster derived from the preset
// palette or the 1D strip) as a one-flat document. Every mode the studio has
// today lands here; what changes later is how many flats come out.
export const docFromPanorama = (env, name) => backdropDoc([skyFlat(rasterContent(env), name)]);

// Flatten a document back to a single raster. With one flat this is that
// flat's cells; with several it will be the near-to-far composite. The
// renderer's fallback path and the panorama preview both want a plain grid.
export function flattenDoc(doc) {
  const visible = doc.flats.filter((f) => f.visible);
  if (!visible.length) return null;
  const base = visible[0].content;
  if (visible.length === 1) return { w: base.w, h: base.h, cells: base.cells };
  const { w, h } = base;
  const cells = base.cells.slice();
  for (let i = 1; i < visible.length; i++) {
    const c = visible[i].content;
    if (c.w !== w || c.h !== h) continue;       // mismatched grids: phase 3's problem
    for (let p = 0; p < w * h; p++) if (c.cells[p] != null) cells[p] = c.cells[p];
  }
  return { w, h, cells };
}
