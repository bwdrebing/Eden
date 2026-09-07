// ------------------------------------------------------------------ //
//  Backdrop documents in the URL
//
//  The whole studio state travels in one `?s=` parameter, so a document has
//  to be small. Generated content already is — a repeating stripe layer is
//  its band list, forty bytes or so however tall the backdrop. Painted layers
//  go through the same run-length encoding the single painted panorama used
//  (env2dCodec.js), one string each.
//
//  A layer painted with a hole in it is the one new thing: the transparent
//  cell has no colour, so it takes an EMPTY palette entry — the palette is
//  "-"-separated, so "aabbcc--ddeeff" is three entries with the middle one
//  transparent. (A "-" marker would have been a second separator.)
//
//  Anything unparseable decodes to null and the caller keeps what it had. A
//  document that will not fit (a smoothed layer with thousands of colours)
//  encodes to null rather than writing a megabyte into someone's URL.
// ------------------------------------------------------------------ //
import { DOC_VERSION, backdropDoc, flat, rampContent, stripesContent } from "./document";
import { shapesContent, shape, SHAPE_KINDS } from "./shapes";

const MAX_PALETTE = 64;
export const MAX_DOC_LEN = 12000;

// ---- raster cells, run-length encoded ------------------------------
// w.h.<palette>.<runs>, palette entries hex without "#" and empty for
// transparent, runs as <len>*<idx> with the length dropped when it is 1.

export function encodeCells(w, h, cells) {
  const index = new Map();
  const palette = [];
  const idx = new Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const raw = cells[p];
    const c = raw == null ? "" : String(raw).toLowerCase().replace(/^#/, "");
    let i = index.get(c);
    if (i === undefined) {
      if (palette.length >= MAX_PALETTE) return null;
      i = palette.length; index.set(c, i); palette.push(c);
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
  return w.toString(36) + "." + h.toString(36) + "." + palette.join("-") + "." + runs.join("-");
}

export function decodeCells(code) {
  if (typeof code !== "string" || !code) return null;
  const parts = code.split(".");
  if (parts.length !== 4) return null;
  const w = parseInt(parts[0], 36), h = parseInt(parts[1], 36);
  if (!(w > 0) || !(h > 0) || w * h > 1 << 20) return null;
  const palette = parts[2].split("-").map((s) => (s === "" ? null : "#" + s));
  if (!palette.length) return null;
  if (palette.some((c) => c !== null && !/^#[0-9a-f]{6}$/i.test(c))) return null;
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

// ---- whole documents -----------------------------------------------

export function encodeDoc(doc) {
  if (!doc || !doc.flats || !doc.flats.length) return null;
  const flats = [];
  for (const f of doc.flats) {
    const c = f.content;
    const head = { n: f.name, v: f.visible ? 1 : 0 };
    if (c.kind === "ramp") flats.push({ ...head, k: "r", p: c.palette });
    else if (c.kind === "shapes") {
      // a shape is its statement: type, box, colours. Four numbers and two
      // hexes, whatever resolution it ends up rendered at
      flats.push({ ...head, k: "h", i: c.items.map((it) => ({
        t: it.type,
        b: [it.x, it.y, it.w, it.h].map((v) => Math.round(v * 1e4) / 1e4),
        c: it.color.replace(/^#/, ""),
        d: (it.color2 || "").replace(/^#/, ""),
        m: it.rim ? 1 : 0,
        ...(it.points ? { g: it.points.map((q) => q.map((v) => Math.round(v * 1e4) / 1e4)) } : {}),
      })) });
    }
    else if (c.kind === "stripes") {
      flats.push({ ...head, k: "s", r: c.repeat ? 1 : 0, a: c.anchor | 0,
        b: c.bands.map((b) => [b.color.replace(/^#/, ""), b.size | 0]) });
    } else {
      const code = encodeCells(c.w, c.h, c.cells);
      if (!code) return null;                   // too many colours to carry
      flats.push({ ...head, k: "p", c: code });
    }
  }
  const out = JSON.stringify({ v: DOC_VERSION, w: doc.w, h: doc.h, f: flats });
  return out.length > MAX_DOC_LEN ? null : out;
}

export function decodeDoc(s) {
  if (typeof s !== "string" || !s) return null;
  let raw;
  try { raw = JSON.parse(s); } catch (e) { return null; }
  if (!raw || !Array.isArray(raw.f) || !raw.f.length) return null;
  const w = raw.w > 0 ? raw.w : undefined, h = raw.h > 0 ? raw.h : undefined;
  const flats = [];
  for (const f of raw.f) {
    const name = typeof f.n === "string" ? f.n : "Layer";
    const visible = f.v !== 0;
    let content = null;
    if (f.k === "r" && typeof f.p === "string") content = rampContent(f.p);
    else if (f.k === "s" && Array.isArray(f.b)) {
      const bands = f.b
        .filter((b) => Array.isArray(b) && /^[0-9a-f]{6}$/i.test(String(b[0])))
        .map((b) => ({ color: "#" + b[0], size: Math.max(1, b[1] | 0) }));
      if (!bands.length) return null;
      content = stripesContent(bands, f.r !== 0, f.a | 0);
    } else if (f.k === "h" && Array.isArray(f.i)) {
      const items = f.i
        .filter((it) => SHAPE_KINDS.includes(it.t) && Array.isArray(it.b) && it.b.length === 4
          && it.b.every((v) => typeof v === "number" && Number.isFinite(v)))
        .map((it) => shape(it.t, {
          x: it.b[0], y: it.b[1], w: it.b[2], h: it.b[3],
          color: /^[0-9a-f]{6}$/i.test(String(it.c)) ? "#" + it.c : "#141d33",
          color2: /^[0-9a-f]{6}$/i.test(String(it.d)) ? "#" + it.d : "#9cc3e8",
          rim: it.m ? 1 : 0,
          ...(Array.isArray(it.g) ? { points: it.g } : {}),
        }));
      content = shapesContent(items);
    } else if (f.k === "p") {
      const env = decodeCells(f.c);
      if (!env) return null;
      content = { kind: "raster", w: env.w, h: env.h, cells: env.cells };
    }
    if (!content) return null;
    flats.push({ ...flat(content, name), visible });
  }
  const first = flats.find((f) => f.content.kind === "raster");
  return backdropDoc(flats, w || (first && first.content.w), h || (first && first.content.h));
}
