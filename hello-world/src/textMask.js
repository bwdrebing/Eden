// ------------------------------------------------------------------ //
//  Text as a field
//
//  Everything this renderer draws is the zero set of a signed distance
//  field — a painted region, a wave silhouette, a crest seam. Text has to
//  arrive the same way or it cannot take part: laid onto the wave surface it
//  has to be cut by the crest in front of it, smoothed by the same operator
//  the color regions are, and traced by the same marching squares. A glyph
//  outline would have to be intersected with all of that by hand; a field
//  just gets composed.
//
//  So a string becomes ONE PLAIN ARRAY: the signed distance, in mask cells,
//  to the inked shape of the text — positive inside a letter, negative
//  outside. Sampling it is a bilinear tap, which is what lets the same mask
//  serve a 420-pixel preview raster and a 2500-pixel export retrace.
//
//  The glyphs themselves come from the platform's own type, rasterized once
//  through a canvas at EM pixels to the em. That is deliberate: a watermark
//  exists to be READ, and hinted, kerned, real type reads where a stroke font
//  traced from line segments does not.
//
//  Two consequences of that choice worth knowing:
//
//    * A mask is BUILT ON THE MAIN THREAD and carried as data. The render
//      worker has no fonts to speak of and may have no canvas at all, so it
//      must never build its own — it would come back with different type, or
//      with none, and the worker's picture would quietly stop matching the
//      one built inline. Everything here returns plain arrays and numbers for
//      exactly that crossing.
//    * A mask is finite. It reaches PAD cells past the ink and no further,
//      which is all a boundary ever needs, and is why `textMaskAt` clamps
//      rather than extrapolating.
// ------------------------------------------------------------------ //
import { distTransform, blurField } from "./backdrop/field";

// mask cells to the em. The mask is a distance field sampled bilinearly, so
// this is not the resolution the text is drawn at — it is how finely the
// letterforms themselves are captured before the field smooths between them.
const EM = 110;
// how far past the ink the field is carried, in cells. A boundary only ever
// reads the field within a pixel or two of zero; the rest is headroom for the
// halo and for the blur.
const PAD = 30;
// baseline to baseline, in ems
const LINE = 1.25;
// a mask larger than this is a string nobody meant to set
const MAX_CELLS = 1 << 22;

// The type a watermark can be set in. Stacks rather than single families, so
// a scene opened on another machine still gets something of the right
// species. `key` is what travels in the URL.
export const MARK_FONTS = [
  ["serif", "Serif", "Georgia, 'Times New Roman', Times, serif"],
  ["sans", "Sans", "'Helvetica Neue', Helvetica, Arial, sans-serif"],
  ["mono", "Mono", "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"],
  ["script", "Script", "'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive"],
];

const familyOf = (key) => (MARK_FONTS.find((f) => f[0] === key) || MARK_FONTS[0])[2];

export const fontString = (style = {}) =>
  `${style.italic ? "italic " : ""}${style.weight || 400} ${EM}px ${familyOf(style.font)}`;

// An OffscreenCanvas where there is one, a DOM canvas otherwise, and null in
// jsdom — where a test that wants a mask builds one directly (see textMask.test.js).
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    try { return new OffscreenCanvas(Math.max(1, w), Math.max(1, h)); } catch (e) { /* fall through */ }
  }
  if (typeof document !== "undefined" && document.createElement) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  }
  return null;
}

const context = (c) => {
  if (!c) return null;
  try { return c.getContext("2d", { willReadFrequently: true }); } catch (e) { return null; }
};

/**
 * Rasterize a string into a signed distance mask.
 *
 * `style` is { font, weight, italic, tracking } — tracking in ems, since a
 * watermark set wide reads better over busy water than one set tight.
 *
 * Returns plain data, or null when there is nothing to set (an empty string)
 * or nowhere to set it (no canvas):
 *
 *   w, h     the mask grid
 *   sdf      Float32Array, signed distance in cells, positive inside the ink
 *   em       cells per em, so a caller can talk in ems
 *   x0, y0   the ink's top-left in cells-from-origin, where the origin is the
 *            first line's baseline at the block's horizontal centre
 *   box      the ink's extent in EM UNITS: { x0, x1, y0, y1 }, y up
 */
export function buildTextMask(text, style = {}) {
  const lines = String(text == null ? "" : text).split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length || !lines.some((l) => l.trim())) return null;

  const probe = context(makeCanvas(8, 8));
  if (!probe) return null;
  const font = fontString(style);
  probe.font = font;
  const track = (style.tracking || 0) * EM;
  // Tracking is drawn character by character, so the advance has to be summed
  // the same way — measuring the whole string and adding n gaps drifts from
  // what actually lands, by the kerning the per-character pass gives up.
  const chars = lines.map((l) => Array.from(l));
  const advance = (cs) => cs.reduce((x, ch) => x + probe.measureText(ch).width + track, 0)
    - (cs.length ? track : 0);
  const widths = chars.map((cs) => (track ? advance(cs) : probe.measureText(cs.join("")).width));
  const blockW = Math.max(...widths);
  if (!(blockW > 0)) return null;               // a canvas that measures nothing

  // The ink box, in cells from the origin (x right, y DOWN — canvas order).
  // Metrics can be missing; the em box is the honest fallback.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  lines.forEach((line, i) => {
    const m = probe.measureText(line);
    const by = i * LINE * EM;
    const lx = -widths[i] / 2;                  // each line centred on the block
    const l = Number.isFinite(m.actualBoundingBoxLeft) ? -m.actualBoundingBoxLeft : 0;
    const r = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : widths[i];
    const a = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : EM * 0.75;
    const d = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : EM * 0.25;
    x0 = Math.min(x0, lx + l); x1 = Math.max(x1, lx + Math.max(r, widths[i]));
    y0 = Math.min(y0, by - a); y1 = Math.max(y1, by + d);
  });
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  const W = Math.ceil(x1 - x0) + 2 * PAD, H = Math.ceil(y1 - y0) + 2 * PAD;
  if (!(W > 0) || !(H > 0) || W * H > MAX_CELLS) return null;

  const ctx = context(makeCanvas(W, H));
  if (!ctx) return null;
  ctx.clearRect(0, 0, W, H);
  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  // the ink's own top-left lands on (PAD, PAD), so the mask is the text and a
  // fixed border, whatever the string's ascenders and descenders come to
  const ox = PAD - x0, oy = PAD - y0;
  lines.forEach((line, i) => {
    let x = ox - widths[i] / 2;
    const y = oy + i * LINE * EM;
    if (!track) { ctx.fillText(line, x, y); return; }
    for (const ch of chars[i]) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + track; }
  });

  let px;
  try { px = ctx.getImageData(0, 0, W, H).data; } catch (e) { return null; }
  const N = W * H;
  const inside = new Uint8Array(N), outside = new Uint8Array(N);
  let ink = 0;
  for (let p = 0; p < N; p++) {
    const on = px[4 * p + 3] >= 128 ? 1 : 0;
    inside[p] = on; outside[p] = 1 - on;
    ink += on;
  }
  if (!ink) return null;                        // a font that drew nothing

  // Signed distance, then one blur pass to round the pixel-corner bevels of
  // the rasterized outline — exactly what the backdrop compiler does to a
  // painted region's field, and for the same reason: the staircase is in the
  // mask, so it has to come off in the mask's own space. The sign clamp keeps
  // solidly inked and solidly empty cells on their own side, so a hairline
  // serif survives the pass.
  const Din = distTransform(inside, W, H), Dout = distTransform(outside, W, H);
  const sdf = new Float64Array(N), raw = new Float64Array(N);
  for (let p = 0; p < N; p++) { sdf[p] = Din[p] - Dout[p]; raw[p] = sdf[p]; }
  blurField(sdf, W, H, new Float64Array(N), 1);
  const out = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    let v = sdf[p];
    if (raw[p] >= 1 && v < 0.25) v = 0.25;
    else if (raw[p] <= -1 && v > -0.25) v = -0.25;
    out[p] = v;
  }
  return {
    w: W, h: H, sdf: out, em: EM, pad: PAD, x0, y0,
    box: { x0: x0 / EM, x1: (x0 + (W - 2 * PAD)) / EM,
           y0: -(y0 + (H - 2 * PAD)) / EM, y1: -y0 / EM },
  };
}

/**
 * Signed distance to the text at (u, v), both in EM UNITS with the origin on
 * the first line's baseline, x right and y UP — the sense the rest of the
 * renderer works in. Positive inside a letter.
 *
 * A point past the mask's border is not extrapolated: the field there is only
 * ever asked "am I outside", and the border's own value already answers that.
 */
export function textMaskAt(mask, u, v) {
  const { w, h, sdf, em, pad, x0, y0 } = mask;
  const fx = u * em - x0 + pad, fy = -v * em - y0 + pad;
  const out = -pad / em;
  if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return out;
  const i = fx | 0, j = fy | 0;
  const i1 = i + 1 < w ? i + 1 : i, j1 = j + 1 < h ? j + 1 : j;
  const tx = fx - i, ty = fy - j;
  const a = sdf[j * w + i] * (1 - tx) + sdf[j * w + i1] * tx;
  const b = sdf[j1 * w + i] * (1 - tx) + sdf[j1 * w + i1] * tx;
  return (a * (1 - ty) + b * ty) / em;
}

// The ink box's centre and size in em units — what a caller fits its own
// rectangle to, so a string of capitals and one with descenders both land
// where they were put rather than where their metrics happen to fall.
export function maskExtent(mask) {
  const b = mask.box;
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2,
           w: b.x1 - b.x0, h: b.y1 - b.y0 };
}
