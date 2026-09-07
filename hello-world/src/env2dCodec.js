// ------------------------------------------------------------------ //
//  Painted-panorama URL codec
//
//  The 2D backdrop is 84x52 cells of hex string. Serialized naively that
//  is ~40 KB of JSON, which is why it was left out of the URL slice
//  entirely — and why a painted panorama could never be saved or shared.
//
//  Painted panoramas are not photographs: they hold a handful of colors in
//  long runs, so a palette plus run-length encoding of palette indices
//  gets a typical one into a few hundred characters. Everything here is
//  base36 and "." / "-" separated, so the result survives base64url in
//  urlSettings.js without growing.
//
//  Format:  w.h.<hex>-<hex>-...  .<len>*<idx>-<len>*<idx>-...
//  Colors are stored without their leading "#". A run of length 1 drops
//  the "1*" prefix. Anything unparseable decodes to null, and the caller
//  keeps whatever it already had.
// ------------------------------------------------------------------ //

// A hand-smoothed panorama can hold thousands of near-identical colors;
// past this many the palette itself is the payload and RLE has nothing to
// give, so we decline to encode rather than write a megabyte into the URL.
export const MAX_PALETTE = 64;
// Ceiling on the encoded string. Browsers take far more than this, but a
// URL people paste into a message should stay pasteable.
export const MAX_CODE_LEN = 6000;

export function encodeEnv2d(env) {
  if (!env || !env.cells || !env.w || !env.h) return null;
  const { w, h, cells } = env;
  if (cells.length !== w * h) return null;

  const index = new Map();
  const palette = [];
  const idx = new Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const c = String(cells[p]).toLowerCase();
    let i = index.get(c);
    if (i === undefined) {
      if (palette.length >= MAX_PALETTE) return null;
      i = palette.length;
      index.set(c, i);
      palette.push(c.charAt(0) === "#" ? c.slice(1) : c);
    }
    idx[p] = i;
  }

  const runs = [];
  let start = 0;
  for (let p = 1; p <= w * h; p++) {
    if (p === w * h || idx[p] !== idx[start]) {
      const len = p - start;
      runs.push((len > 1 ? len.toString(36) + "*" : "") + idx[start].toString(36));
      start = p;
    }
  }

  const code = w.toString(36) + "." + h.toString(36) + "."
    + palette.join("-") + "." + runs.join("-");
  return code.length > MAX_CODE_LEN ? null : code;
}

export function decodeEnv2d(code) {
  if (typeof code !== "string" || !code) return null;
  const parts = code.split(".");
  if (parts.length !== 4) return null;
  const w = parseInt(parts[0], 36), h = parseInt(parts[1], 36);
  if (!(w > 0) || !(h > 0) || w * h > 1 << 20) return null;

  const palette = parts[2].split("-").map((s) => "#" + s);
  if (!palette.length || palette.some((c) => !/^#[0-9a-f]{6}$/i.test(c))) return null;

  const cells = new Array(w * h);
  let at = 0;
  for (const run of parts[3].split("-")) {
    const star = run.indexOf("*");
    const len = star < 0 ? 1 : parseInt(run.slice(0, star), 36);
    const i = parseInt(star < 0 ? run : run.slice(star + 1), 36);
    if (!(len > 0) || !(i >= 0) || i >= palette.length) return null;
    if (at + len > w * h) return null;
    const c = palette[i];
    for (let k = 0; k < len; k++) cells[at + k] = c;
    at += len;
  }
  if (at !== w * h) return null;
  return { w, h, cells };
}
