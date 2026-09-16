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
//  An imported drawing is the one thing here whose cost is its geometry rather
//  than its colours, so its points are packed rather than printed: each
//  coordinate is twelve bits of the flat's own 0..1 box, written as two
//  characters, so a point costs four. Twelve bits is 1/4096 of the layer —
//  a twelfth of one cell of the finest grid the compiler contours on, so the
//  packing is below anything the water can show.
//
//  Anything unparseable decodes to null and the caller keeps what it had. A
//  document that will not fit (a smoothed layer with thousands of colours, or
//  a drawing with more outline in it than a URL holds) encodes to null rather
//  than writing a megabyte into someone's URL.
// ------------------------------------------------------------------ //
import { DOC_VERSION, backdropDoc, flat, rampContent, stripesContent } from "./document";
import { shapesContent, shape, SHAPE_KINDS } from "./shapes";
import { svgContent, MAX_SVG_PATHS, MAX_SVG_POINTS } from "./svg";

const MAX_PALETTE = 64;
// a watermark is a name or a title, not an essay — and the whole document has
// to fit in a URL
export const MAX_TEXT = 120;
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

// ---- drawings, packed ----------------------------------------------
// Two characters per coordinate, 4096 steps across the flat. The alphabet is
// URL-safe, and the whole document rides inside a base64url parameter, so
// nothing here needs escaping on the way out.

const A64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const V64 = new Map([...A64].map((c, i) => [c, i]));

export function encodeRing(pts) {
  let out = "";
  for (let k = 0; k < pts.length; k++) {
    const v = Math.max(0, Math.min(4095, Math.round(pts[k] * 4095)));
    out += A64[(v >> 6) & 63] + A64[v & 63];
  }
  return out;
}

export function decodeRing(code) {
  if (typeof code !== "string" || code.length % 4 !== 0 || !code.length) return null;
  const pts = new Array(code.length / 2);
  for (let k = 0; k < code.length; k += 2) {
    const hi = V64.get(code[k]), lo = V64.get(code[k + 1]);
    if (hi === undefined || lo === undefined) return null;
    pts[k / 2] = ((hi << 6) | lo) / 4095;
  }
  return pts;
}

// ---- whole documents -----------------------------------------------

export function encodeDoc(doc) {
  if (!doc || !doc.flats || !doc.flats.length) return null;
  const flats = [];
  for (const f of doc.flats) {
    const c = f.content;
    const head = { n: f.name, v: f.visible ? 1 : 0 };
    // where it stands, when it is not the sky
    if (f.place && f.place.kind === "plane") {
      head.q = [f.place.distance, f.place.width, f.place.height];
    }
    if (c.kind === "ramp") flats.push({ ...head, k: "r", p: c.palette });
    else if (c.kind === "svg") {
      flats.push({ ...head, k: "v",
        z: [c.x, c.y, c.w, c.h, c.aspect].map((v) => Math.round(v * 1e4) / 1e4),
        i: c.paths.map((pth) => ({
          c: pth.color.replace(/^#/, ""),
          e: pth.even ? 1 : 0,
          s: pth.subs.map(encodeRing),
        })) });
    }
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
        // A text shape carries the string and the type it is set in, never
        // the mask those two produce — the mask is thousands of cells, and it
        // is rebuilt from exactly this on the way back in (withTextMasks).
        ...(it.type === "text"
          ? { s: String(it.text || "").slice(0, MAX_TEXT), ff: it.font || "serif",
              fw: it.weight | 0, fi: it.italic ? 1 : 0,
              ft: Math.round((it.tracking || 0) * 1e3) / 1e3 }
          : {}),
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
          ...(it.t === "text"
            ? { text: typeof it.s === "string" ? it.s.slice(0, MAX_TEXT) : "",
                font: typeof it.ff === "string" ? it.ff : "serif",
                weight: it.fw > 0 ? it.fw : 600,
                italic: !!it.fi,
                tracking: Number.isFinite(it.ft) ? it.ft : 0 }
            : {}),
        }));
      content = shapesContent(items);
    } else if (f.k === "v" && Array.isArray(f.i) && Array.isArray(f.z) && f.z.length === 5
      && f.z.every((v) => typeof v === "number" && Number.isFinite(v))) {
      const paths = [];
      let points = 0;
      for (const pth of f.i) {
        if (paths.length >= MAX_SVG_PATHS || !pth || !Array.isArray(pth.s)) break;
        const subs = [];
        for (const code of pth.s) {
          const ring = decodeRing(code);
          if (!ring || ring.length < 6) continue;
          points += ring.length / 2;
          if (points > MAX_SVG_POINTS * 4) return null;   // not a link anyone wrote
          subs.push(ring);
        }
        if (!subs.length) continue;
        paths.push({ color: /^[0-9a-f]{6}$/i.test(String(pth.c)) ? "#" + pth.c : "#141d33",
          even: !!pth.e, subs });
      }
      if (!paths.length) return null;
      content = svgContent(paths, f.z[4] > 0 ? f.z[4] : 1,
        { x: f.z[0], y: f.z[1], w: f.z[2], h: f.z[3] });
    } else if (f.k === "p") {
      const env = decodeCells(f.c);
      if (!env) return null;
      content = { kind: "raster", w: env.w, h: env.h, cells: env.cells };
    }
    if (!content) return null;
    const place = Array.isArray(f.q) && f.q.length === 3 && f.q.every(Number.isFinite)
      ? { kind: "plane", distance: f.q[0], width: f.q[1], height: f.q[2] }
      : { kind: "sky" };
    flats.push({ ...flat(content, name), visible, place });
  }
  const first = flats.find((f) => f.content.kind === "raster");
  return backdropDoc(flats, w || (first && first.content.w), h || (first && first.content.h));
}
