// ------------------------------------------------------------------ //
//  An SVG as a backdrop layer
//
//  The backdrop already knows two ways to be a picture: painted cells, and
//  shapes stated as formulas in (u, v). An SVG is the third, and it is the one
//  that comes from outside — a skyline traced in Illustrator, a logo, a
//  shoreline someone drew anywhere else. There is no brush wide enough to
//  paint that into 84 cells, and no entry in STAMPS that is somebody's own
//  drawing.
//
//  So an SVG arrives as what it already is: filled outlines. Curves are
//  flattened to polylines once, at import, and everything is normalized into
//  the flat's 0..1 box with y flipped (SVG counts down from the top, a flat
//  counts up from the waterline). What lands in the document is plain numbers,
//  which is what lets a drawing ride in a URL and cross to the render worker.
//
//  PARSING IS MAIN-THREAD, IMPORT-TIME ONLY — for the same reason textMask.js
//  sets type on the main thread. `parseSvg` reads a file through DOMParser, and
//  a builder may not depend on the DOM. Everything else here is arithmetic over
//  the plain data it produces, and is what the worker actually runs.
//
//  Two things an SVG has that a region model does not, and how they are met:
//
//    * alpha. A region is one flat colour, so opacity cannot be honoured —
//      a path that is nearly transparent is dropped rather than drawn solid.
//    * gradients. `fill="url(#g)"` resolves to the mean of the gradient's
//      stops, which is the one colour the band would have averaged to anyway.
//
//  Strokes are expanded into outlines here rather than dropped, because line
//  art is half of what people have lying around, and a drawing that imports
//  blank is worse than one that imports approximately.
// ------------------------------------------------------------------ //
import * as d3 from "d3";
import { DOC_ASPECT } from "./shapes";

// A path is a region, and the renderer's region budget is MAX_REGIONS — so a
// drawing with thousands of outlines cannot be carried whole. The smallest
// ones go first: they are the ones that a backdrop cell could not resolve.
export const MAX_SVG_PATHS = 240;
// The whole document has to fit in a URL (MAX_DOC_LEN), and a point costs four
// characters there. Past this, paths are dropped smallest first, the same
// trade as the path cap above.
export const MAX_SVG_POINTS = 2400;
// Douglas-Peucker tolerance, in flat units. COMPILE_SCALE renders a shape
// layer onto 4x the paint grid — 336 cells across — so half of one of those
// cells is the point past which a kept vertex cannot be seen.
export const SVG_TOLERANCE = 0.0015;

// ---- content -------------------------------------------------------

// A drawing sits in the flat the way a shape does: (x, y) is its centre
// across and its BASE up, w by h in flat units. `aspect` is the artwork's own
// width:height, kept so "fit" can put back the proportions the file had.
// DOC_ASPECT is the same correction a stamp makes, from the same place: the
// grid is wider than it is tall, so a square drawing has to come back through
// it or it lands two thirds of the way across the sky.
export const svgContent = (paths, aspect = 1, patch = {}) => ({
  kind: "svg", paths, aspect,
  x: 0.5, y: 0.1, w: 0.5, h: Math.min(0.8, 0.5 / (aspect || 1) / DOC_ASPECT),
  ...patch,
});

export const svgPointCount = (content) =>
  content.paths.reduce((n, p) => n + p.subs.reduce((m, s) => m + s.length / 2, 0), 0);

// The drawing's box as the shape overlay's one item, so dragging a drawing on
// the canvas is the same code that drags a rectangle.
export const svgBoxItem = (content) =>
  ({ id: "svg", type: "rect", x: content.x, y: content.y, w: content.w, h: content.h });

// Put back the file's own proportions, keeping the height. Someone who has
// squashed a drawing by dragging its corner meant to; this is the way back.
export const fitSvgBox = (content) => ({
  ...content, w: Math.min(0.98, content.h * (content.aspect || 1) * DOC_ASPECT),
});

// Every path one colour: what a silhouette wants, and the fastest way to make
// an imported drawing belong to the scene it landed in.
export const tintSvg = (content, color) => ({
  ...content, paths: content.paths.map((p) => ({ ...p, color })),
});

// ---- rasterizing ---------------------------------------------------

/**
 * Draw the paths onto a w x h grid, earlier paths under later ones — the
 * order the file states, which is the only order an SVG has.
 *
 * Returns { cells, keys } like rasterizeShapes: the colour at each cell and
 * which region painted it, so two paths of one colour stay two regions.
 * `keyOf(pathIndex)` hands back the region key.
 */
export function rasterizeSvg(content, w, h, keyOf) {
  const cells = new Array(w * h).fill(null);
  const keys = new Int32Array(w * h).fill(-1);
  const x0 = (content.x - content.w / 2) * w, sx = content.w * w;
  const y0 = content.y * h, sy = content.h * h;
  content.paths.forEach((path, i) => {
    const key = keyOf(i);
    scanFill(path, w, h, x0, sx, y0, sy, (p) => { cells[p] = path.color; keys[p] = key; });
  });
  return { cells, keys };
}

// Scanline fill of one path. A row is sampled at its centre, exactly where
// rasterizeShapes samples it, so a drawing and a shape land on the same grid.
function scanFill(path, W, H, x0, sx, y0, sy, paint) {
  // edges in grid space: [ax, ay, bx, by], plus the row band they span
  const ex = [];
  let loY = Infinity, hiY = -Infinity;
  for (const sub of path.subs) {
    const n = sub.length / 2;
    if (n < 3) continue;
    let px = x0 + sub[(n - 1) * 2] * sx, py = y0 + sub[(n - 1) * 2 + 1] * sy;
    for (let k = 0; k < n; k++) {
      const qx = x0 + sub[k * 2] * sx, qy = y0 + sub[k * 2 + 1] * sy;
      if (py !== qy) ex.push(px, py, qx, qy);
      if (qy < loY) loY = qy;
      if (qy > hiY) hiY = qy;
      px = qx; py = qy;
    }
  }
  if (!ex.length) return;
  const r0 = Math.max(0, Math.ceil(loY - 0.5));
  const r1 = Math.min(H - 1, Math.floor(hiY - 0.5));
  const xsAt = [], dirAt = [];
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    let n = 0;
    // A crossing counts on the half-open span [ay, by), so a vertex shared by
    // two edges is counted once and a shape does not leak along its own seam.
    for (let e = 0; e < ex.length; e += 4) {
      const ay = ex[e + 1], by = ex[e + 3];
      if ((ay <= y) === (by <= y)) continue;
      xsAt[n] = ex[e] + ((y - ay) / (by - ay)) * (ex[e + 2] - ex[e]);
      dirAt[n] = by > ay ? 1 : -1;
      n++;
    }
    if (n < 2) continue;
    const order = [];
    for (let k = 0; k < n; k++) order.push(k);
    order.sort((a, b) => xsAt[a] - xsAt[b]);
    let wind = 0;
    for (let k = 0; k < n - 1; k++) {
      wind += dirAt[order[k]];
      const inside = path.even ? (k % 2) === 0 : wind !== 0;
      if (!inside) continue;
      const c0 = Math.max(0, Math.ceil(xsAt[order[k]] - 0.5));
      const c1 = Math.min(W - 1, Math.ceil(xsAt[order[k + 1]] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) paint(r * W + c);
    }
  }
}

// ---- reading a file ------------------------------------------------

const DRAW = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
// Elements whose children are definitions, not drawing. <use> reaches into
// them deliberately; walking into them would draw every definition twice.
const HIDDEN = new Set(["defs", "clippath", "mask", "symbol", "marker", "pattern",
  "style", "title", "desc", "metadata", "filter"]);

const IDENTITY = [1, 0, 0, 1, 0, 0];   // [a b c d e f], as SVG writes a matrix
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const applyX = (m, x, y) => m[0] * x + m[2] * y + m[4];
const applyY = (m, x, y) => m[1] * x + m[3] * y + m[5];
// how much the matrix scales lengths, for a stroke width and a flattening step
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

const numsIn = (s) =>
  (String(s).match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);

function parseTransform(str) {
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(String(str)))) {
    const v = numsIn(hit[2]);
    const RAD = Math.PI / 180;
    if (hit[1] === "matrix" && v.length >= 6) m = mul(m, v.slice(0, 6));
    else if (hit[1] === "translate") m = mul(m, [1, 0, 0, 1, v[0] || 0, v[1] || 0]);
    else if (hit[1] === "scale") m = mul(m, [v[0] || 0, 0, 0, v.length > 1 ? v[1] : v[0] || 0, 0, 0]);
    else if (hit[1] === "rotate") {
      const c = Math.cos((v[0] || 0) * RAD), s = Math.sin((v[0] || 0) * RAD);
      const R = [c, s, -s, c, 0, 0];
      m = v.length >= 3
        ? mul(mul(mul(m, [1, 0, 0, 1, v[1], v[2]]), R), [1, 0, 0, 1, -v[1], -v[2]])
        : mul(m, R);
    } else if (hit[1] === "skewX") m = mul(m, [1, 0, Math.tan((v[0] || 0) * RAD), 1, 0, 0]);
    else if (hit[1] === "skewY") m = mul(m, [1, Math.tan((v[0] || 0) * RAD), 0, 1, 0, 0]);
  }
  return m;
}

// Inline `style` wins over the presentation attribute, which wins over what the
// parent handed down — the cascade, minus the stylesheet. A `<style>` block is
// not read: it needs a selector engine, and every drawing tool writes the
// properties onto the elements as well.
function styleOf(el, parent, defs) {
  const decl = {};
  for (const bit of String(el.getAttribute("style") || "").split(";")) {
    const at = bit.indexOf(":");
    if (at > 0) decl[bit.slice(0, at).trim().toLowerCase()] = bit.slice(at + 1).trim();
  }
  const prop = (name) => decl[name] !== undefined ? decl[name] : el.getAttribute(name);
  const pick = (name, inherited) => {
    const v = prop(name);
    return v == null || v === "" || v === "inherit" ? inherited : v;
  };
  const num = (name, inherited) => {
    const v = pick(name, null);
    const n = v == null ? NaN : parseFloat(v);
    return Number.isFinite(n) ? n : inherited;
  };
  const color = pick("color", parent.color);
  return {
    color,
    fill: resolvePaint(pick("fill", parent.fill), color, defs),
    stroke: resolvePaint(pick("stroke", parent.stroke), color, defs),
    strokeWidth: num("stroke-width", parent.strokeWidth),
    even: String(pick("fill-rule", parent.even ? "evenodd" : "nonzero")).trim() === "evenodd",
    // opacity multiplies down the tree; a region has no alpha to spend it on,
    // so all it can decide is whether the path is there at all
    opacity: parent.opacity * num("opacity", 1),
    fillOpacity: num("fill-opacity", parent.fillOpacity),
    strokeOpacity: num("stroke-opacity", parent.strokeOpacity),
    hidden: parent.hidden || String(pick("display", "")).trim() === "none"
      || String(pick("visibility", "")).trim() === "hidden",
  };
}

// "none" is not a colour; `currentColor` is whatever `color` resolved to; a
// paint server is averaged down to the one colour a flat region can hold.
function resolvePaint(v, currentColor, defs) {
  const s = String(v == null ? "" : v).trim();
  if (!s || s === "none" || s === "transparent") return null;
  if (s === "currentColor") return resolvePaint(currentColor, null, defs);
  const url = /^url\(\s*['"]?#([^)'"\s]+)/.exec(s);
  if (url) return meanStopColor(defs.get(url[1]), defs);
  const c = d3.color(s);
  return c ? c.formatHex() : null;
}

function meanStopColor(node, defs, depth = 0) {
  if (!node || depth > 4) return null;
  const href = node.getAttribute("href") || node.getAttribute("xlink:href");
  const stops = node.querySelectorAll ? node.querySelectorAll("stop") : [];
  if (!stops.length && href && href.startsWith("#")) {
    return meanStopColor(defs.get(href.slice(1)), defs, depth + 1);
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (const st of stops) {
    const decl = String(st.getAttribute("style") || "");
    const inline = /stop-color\s*:\s*([^;]+)/.exec(decl);
    const c = d3.color((inline ? inline[1] : st.getAttribute("stop-color")) || "");
    if (!c) continue;
    const rgb = c.rgb(); r += rgb.r; g += rgb.g; b += rgb.b; n++;
  }
  return n ? d3.rgb(r / n, g / n, b / n).formatHex() : null;
}

// ---- geometry ------------------------------------------------------
//
// Every element becomes the same thing: closed rings of points in the root's
// user space, already transformed. Curves are flattened here rather than
// stored, because an affine transform and a Bezier commute — flattening after
// the matrix means the step is measured in the units the drawing is finally
// drawn in, not in whatever scale the group it sat in happened to use.

// One flattening step, in root user units. `ref` is the viewport's own size,
// so a step is a fixed fraction of the picture however the file is scaled.
const stepFor = (ref) => Math.max(ref / 900, 1e-6);

function flattenCubic(out, m, x0, y0, x1, y1, x2, y2, x3, y3, step) {
  const s = scaleOf(m);
  const len = (Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1)
    + Math.hypot(x3 - x2, y3 - y2)) * s;
  const n = Math.max(3, Math.min(96, Math.ceil(len / step)));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    const px = a * x0 + b * x1 + c * x2 + d * x3;
    const py = a * y0 + b * y1 + c * y2 + d * y3;
    out.push(applyX(m, px, py), applyY(m, px, py));
  }
}

// An elliptical arc, endpoint form to centre form (SVG implementation notes
// F.6.5), then sampled. Drawing tools emit these for anything round.
function flattenArc(out, m, x0, y0, rx, ry, rot, large, sweep, x1, y1, step) {
  if (!rx || !ry) { out.push(applyX(m, x1, y1), applyY(m, x1, y1)); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const rad = (rot * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
  const ux = cs * dx + sn * dy, uy = -sn * dx + cs * dy;
  const lam = (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry);
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const den = rx * rx * uy * uy + ry * ry * ux * ux;
  let fac = den ? Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den)) : 0;
  if (large === sweep) fac = -fac;
  const cxp = (fac * rx * uy) / ry, cyp = (-fac * ry * ux) / rx;
  const cx = cs * cxp - sn * cyp + (x0 + x1) / 2;
  const cy = sn * cxp + cs * cyp + (y0 + y1) / 2;
  const ang = (vx, vy) => Math.atan2(vy, vx);
  const t0 = ang((ux - cxp) / rx, (uy - cyp) / ry);
  let sweepA = ang((-ux - cxp) / rx, (-uy - cyp) / ry) - t0;
  if (!sweep && sweepA > 0) sweepA -= 2 * Math.PI;
  if (sweep && sweepA < 0) sweepA += 2 * Math.PI;
  const n = Math.max(3, Math.min(192,
    Math.ceil((Math.abs(sweepA) * Math.max(rx, ry) * scaleOf(m)) / step)));
  for (let k = 1; k <= n; k++) {
    const t = t0 + (sweepA * k) / n;
    const px = cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn;
    const py = cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs;
    out.push(applyX(m, px, py), applyY(m, px, py));
  }
}

/**
 * A `d` attribute into rings of transformed points.
 *
 * Returns { subs, open }: the rings, and which of them were left open (never
 * closed with Z). A fill closes every ring anyway — that is what filling
 * means — but a stroke has to know, or every open line comes back as a loop.
 */
export function parsePathData(d, m = IDENTITY, step = 1) {
  const toks = String(d).match(/[astvzqmhlcASTVZQMHLC]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!toks) return { subs: [], open: [] };
  const subs = [], open = [];
  let cur = null, curIdx = -1;
  let x = 0, y = 0, sx = 0, sy = 0;         // pen, and the current ring's start
  let cx2 = 0, cy2 = 0, prev = "";          // last control point, for S and T
  let cmd = null, i = 0;
  const num = () => Number(toks[i++]);
  const has = (n) => i + n <= toks.length;
  const ensure = () => {
    if (cur) return;
    cur = [applyX(m, x, y), applyY(m, x, y)];
    curIdx = subs.push(cur) - 1; open.push(true);
  };
  const lineTo = (nx, ny) => { ensure(); cur.push(applyX(m, nx, ny), applyY(m, nx, ny)); x = nx; y = ny; };

  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    else if (cmd === "M") cmd = "L";        // a repeat after moveto is a lineto
    else if (cmd === "m") cmd = "l";
    else if (cmd == null || cmd === "z" || cmd === "Z") { i++; continue; }
    const rel = cmd >= "a";
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toLowerCase()) {
      case "m": {
        if (!has(2)) { i = toks.length; break; }
        x = ox + num(); y = oy + num();
        sx = x; sy = y;
        cur = [applyX(m, x, y), applyY(m, x, y)];
        curIdx = subs.push(cur) - 1; open.push(true);
        break;
      }
      case "l": if (!has(2)) { i = toks.length; break; } lineTo(ox + num(), oy + num()); break;
      case "h": if (!has(1)) { i = toks.length; break; } lineTo(ox + num(), y); break;
      case "v": if (!has(1)) { i = toks.length; break; } lineTo(x, oy + num()); break;
      case "c": case "s": {
        const need = cmd.toLowerCase() === "c" ? 6 : 4;
        if (!has(need)) { i = toks.length; break; }
        let x1, y1;
        if (need === 6) { x1 = ox + num(); y1 = oy + num(); }
        else { const r = "cs".includes(prev); x1 = r ? 2 * x - cx2 : x; y1 = r ? 2 * y - cy2 : y; }
        const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        ensure();
        flattenCubic(cur, m, x, y, x1, y1, x2, y2, x3, y3, step);
        cx2 = x2; cy2 = y2; x = x3; y = y3;
        break;
      }
      case "q": case "t": {
        const need = cmd.toLowerCase() === "q" ? 4 : 2;
        if (!has(need)) { i = toks.length; break; }
        let qx, qy;
        if (need === 4) { qx = ox + num(); qy = oy + num(); }
        else { const r = "qt".includes(prev); qx = r ? 2 * x - cx2 : x; qy = r ? 2 * y - cy2 : y; }
        const x3 = ox + num(), y3 = oy + num();
        ensure();
        // a quadratic is the cubic with its controls two thirds of the way out
        flattenCubic(cur, m, x, y, x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3), x3, y3, step);
        cx2 = qx; cy2 = qy; x = x3; y = y3;
        break;
      }
      case "a": {
        if (!has(7)) { i = toks.length; break; }
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const x3 = ox + num(), y3 = oy + num();
        ensure();
        flattenArc(cur, m, x, y, rx, ry, rot, large, sweep, x3, y3, step);
        x = x3; y = y3;
        break;
      }
      case "z": {
        if (cur) open[curIdx] = false;
        x = sx; y = sy; cur = null; curIdx = -1;
        break;
      }
      default: i = toks.length;
    }
    prev = cmd.toLowerCase();
  }
  return { subs, open };
}

// The primitives, as the same rings. Ellipses and rounded corners are sampled
// at the same step as a curve, so nothing in a file has a coarser edge than
// anything else in it.
function ringsOf(el, tag, m, step) {
  const at = (n, d = 0) => { const v = parseFloat(el.getAttribute(n)); return Number.isFinite(v) ? v : d; };
  const ring = (pts) => ({ subs: [pts], open: [false] });
  const put = (out, px, py) => out.push(applyX(m, px, py), applyY(m, px, py));
  if (tag === "path") return parsePathData(el.getAttribute("d") || "", m, step);
  if (tag === "rect") {
    const x = at("x"), y = at("y"), w = at("width"), h = at("height");
    if (!(w > 0) || !(h > 0)) return { subs: [], open: [] };
    let rx = at("rx", NaN), ry = at("ry", NaN);
    if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
    if (!Number.isFinite(ry)) ry = rx;
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    const out = [];
    if (rx > 0 && ry > 0) {
      const arc = (x0, y0, x1, y1, cxx, cyy) => {
        const n = Math.max(3, Math.min(48, Math.ceil((Math.PI / 2 * Math.max(rx, ry) * scaleOf(m)) / step)));
        for (let k = 0; k <= n; k++) {
          const t = (k / n) * (Math.PI / 2);
          put(out, cxx + (x0 - cxx) * Math.cos(t) + (x1 - cxx) * Math.sin(t),
            cyy + (y0 - cyy) * Math.cos(t) + (y1 - cyy) * Math.sin(t));
        }
      };
      arc(x + rx, y, x, y + ry, x + rx, y + ry);                     // top-left
      arc(x, y + h - ry, x + rx, y + h, x + rx, y + h - ry);         // bottom-left
      arc(x + w - rx, y + h, x + w, y + h - ry, x + w - rx, y + h - ry);
      arc(x + w, y + ry, x + w - rx, y, x + w - rx, y + ry);
    } else {
      put(out, x, y); put(out, x + w, y); put(out, x + w, y + h); put(out, x, y + h);
    }
    return ring(out);
  }
  if (tag === "circle" || tag === "ellipse") {
    const rx = tag === "circle" ? at("r") : at("rx"), ry = tag === "circle" ? at("r") : at("ry");
    if (!(rx > 0) || !(ry > 0)) return { subs: [], open: [] };
    const cx = at("cx"), cy = at("cy"), out = [];
    const n = Math.max(8, Math.min(256,
      Math.ceil((2 * Math.PI * Math.max(rx, ry) * scaleOf(m)) / step)));
    for (let k = 0; k < n; k++) {
      const t = (k / n) * 2 * Math.PI;
      put(out, cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
    return ring(out);
  }
  if (tag === "line") {
    const out = [];
    put(out, at("x1"), at("y1")); put(out, at("x2"), at("y2"));
    return { subs: [out], open: [true] };
  }
  if (tag === "polyline" || tag === "polygon") {
    const v = numsIn(el.getAttribute("points") || ""), out = [];
    for (let k = 0; k + 1 < v.length; k += 2) put(out, v[k], v[k + 1]);
    if (out.length < 4) return { subs: [], open: [] };
    return { subs: [out], open: [tag === "polyline"] };
  }
  return { subs: [], open: [] };
}

// ---- strokes as outlines -------------------------------------------
//
// A region has an inside, so a stroke has to become one. Each segment turns
// into a quad of the stroke's width and each joint into a square that covers
// the wedge the quads leave — a round join, near enough at the width a
// backdrop cell can resolve. Every quad is wound the same way, so the nonzero
// rule unions them instead of letting an overlap punch a hole.
function strokeRings(subs, open, width) {
  const half = Math.max(width, 1e-6) / 2;
  const out = [];
  subs.forEach((pts, si) => {
    const n = pts.length / 2;
    if (n < 2) {
      if (n === 1) out.push(capSquare(pts[0], pts[1], half));
      return;
    }
    const closed = !open[si];
    const last = closed ? n : n - 1;
    for (let k = 0; k < last; k++) {
      const ax = pts[k * 2], ay = pts[k * 2 + 1];
      const bx = pts[((k + 1) % n) * 2], by = pts[((k + 1) % n) * 2 + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = (-dy / len) * half, ny = (dx / len) * half;
      out.push([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
      if (k > 0 || closed) out.push(capSquare(ax, ay, half));
    }
  });
  return out;
}

// wound the same way round as a segment quad, so a joint adds to the union
// instead of cancelling the segment under it
const capSquare = (x, y, r) => [x - r, y - r, x - r, y + r, x + r, y + r, x + r, y - r];

// ---- normalizing ---------------------------------------------------

// Douglas-Peucker, iteratively: a vertex nearer than `tol` to the line its
// neighbours make cannot be seen at the grid this renders on, and every one
// of them costs four characters in a link.
function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const dx = pts[b * 2] - ax, dy = pts[b * 2 + 1] - ay;
    const den = dx * dx + dy * dy;
    let far = -1, worst = t2;
    for (let k = a + 1; k < b; k++) {
      const px = pts[k * 2] - ax, py = pts[k * 2 + 1] - ay;
      const t = den ? Math.max(0, Math.min(1, (px * dx + py * dy) / den)) : 0;
      const ex = px - t * dx, ey = py - t * dy;
      const d2 = ex * ex + ey * ey;
      if (d2 > worst) { worst = d2; far = k; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k * 2], pts[k * 2 + 1]);
  return out;
}

const ringArea = (pts) => {
  let a = 0;
  for (let k = 0, n = pts.length / 2; k < n; k++) {
    const j = (k + 1) % n;
    a += pts[k * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[k * 2 + 1];
  }
  return Math.abs(a) / 2;
};

// Sutherland-Hodgman against one edge of the unit box. An SVG viewport clips
// what runs past it, and a drawing whose artboard hides a huge backing
// rectangle must not smear that rectangle across the sky.
function clipEdge(pts, axis, limit, keepBelow) {
  const n = pts.length / 2;
  if (!n) return pts;
  const inside = (k) => {
    const v = pts[k * 2 + axis];
    return keepBelow ? v <= limit : v >= limit;
  };
  const out = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ik = inside(k), ij = inside(j);
    if (ik) out.push(pts[k * 2], pts[k * 2 + 1]);
    if (ik !== ij) {
      const a0 = pts[k * 2 + axis], a1 = pts[j * 2 + axis];
      const t = a1 === a0 ? 0 : (limit - a0) / (a1 - a0);
      out.push(pts[k * 2] + t * (pts[j * 2] - pts[k * 2]),
        pts[k * 2 + 1] + t * (pts[j * 2 + 1] - pts[k * 2 + 1]));
    }
  }
  return out;
}

const clipUnit = (pts) => {
  let p = pts;
  p = clipEdge(p, 0, 0, false); p = clipEdge(p, 0, 1, true);
  p = clipEdge(p, 1, 0, false); p = clipEdge(p, 1, 1, true);
  return p;
};

/**
 * Rings in user space into the flat's own 0..1 box.
 *
 * `box` is the viewport the file states, which is the frame its author framed
 * it in — margins and all — so it is what the drawing is normalized against.
 * y is flipped here and only here: an SVG counts down from the top of the
 * page, a flat counts up from the waterline.
 */
function normalize(raw, box, tol) {
  const sx = box.w || 1, sy = box.h || 1;
  const out = [];
  for (const path of raw) {
    const subs = [];
    for (const ring of path.subs) {
      const n = ring.length / 2;
      if (n < 3) continue;
      const norm = new Array(ring.length);
      for (let k = 0; k < n; k++) {
        norm[k * 2] = (ring[k * 2] - box.x) / sx;
        norm[k * 2 + 1] = 1 - (ring[k * 2 + 1] - box.y) / sy;
      }
      const clipped = clipUnit(norm);
      if (clipped.length < 6) continue;
      const thin = simplify(clipped, tol);
      if (thin.length >= 6 && ringArea(thin) > tol * tol) subs.push(thin);
    }
    if (subs.length) out.push({ color: path.color, even: !!path.even, subs });
  }
  return out;
}

// A drawing can hold more outlines than the renderer has regions, and more
// points than a link has room for. Both are traded the same way: the smallest
// paths go, because they are the ones a backdrop cell could not have resolved.
function trim(paths, maxPaths, maxPoints) {
  const area = (p) => p.subs.reduce((a, s) => Math.max(a, ringArea(s)), 0);
  let kept = paths;
  let dropped = 0;
  const points = (list) => list.reduce((n, p) =>
    n + p.subs.reduce((m, s) => m + s.length / 2, 0), 0);
  if (kept.length > maxPaths || points(kept) > maxPoints) {
    const rank = kept.map((p, i) => ({ p, i, a: area(p) }))
      .sort((a, b) => b.a - a.a);
    const take = [];
    let n = 0;
    for (const r of rank) {
      const cost = r.p.subs.reduce((m, s) => m + s.length / 2, 0);
      if (take.length >= maxPaths || n + cost > maxPoints) { dropped++; continue; }
      take.push(r); n += cost;
    }
    // back into the order the file draws them in: an SVG's only z-order
    kept = take.sort((a, b) => a.i - b.i).map((r) => r.p);
  }
  return { paths: kept, dropped };
}

// ---- the file itself -----------------------------------------------

const ROOT_STYLE = {
  color: "#000000", fill: "#000000", stroke: null, strokeWidth: 1,
  even: false, opacity: 1, fillOpacity: 1, strokeOpacity: 1, hidden: false,
};
// Anything under this is a path the flat cannot show anyway, and a path that
// cannot be seen still costs a region and a slice of the link.
const MIN_ALPHA = 0.06;

// The viewport the drawing is framed in: the viewBox if it states one, its
// width and height if not, and failing both, whatever the drawing itself came
// to — so a file with no frame at all still lands filling the layer.
function viewportOf(root, raw) {
  const vb = numsIn(root.getAttribute("viewBox") || "");
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  }
  const w = parseFloat(root.getAttribute("width")), h = parseFloat(root.getAttribute("height"));
  if (w > 0 && h > 0) return { x: 0, y: 0, w, h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of raw) for (const ring of p.subs) {
    for (let k = 0; k < ring.length; k += 2) {
      if (ring[k] < x0) x0 = ring[k];
      if (ring[k] > x1) x1 = ring[k];
      if (ring[k + 1] < y0) y0 = ring[k + 1];
      if (ring[k + 1] > y1) y1 = ring[k + 1];
    }
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Read an SVG file into backdrop content.
 *
 * MAIN THREAD ONLY (DOMParser). Returns { content, paths, dropped, points } or
 * { error } — a string the panel can put in front of someone, because the
 * common failures here are all things a person can act on: the wrong file, a
 * drawing made only of text, a drawing made only of clipped-away artwork.
 */
export function parseSvg(text, opts = {}) {
  const tol = opts.tolerance || SVG_TOLERANCE;
  let dom;
  try {
    dom = new DOMParser().parseFromString(String(text), "image/svg+xml");
  } catch (e) { return { error: "That file could not be read as SVG." }; }
  const root = dom && dom.documentElement;
  if (!root || String(root.tagName).toLowerCase() !== "svg"
      || dom.getElementsByTagName("parsererror").length) {
    return { error: "That file could not be read as SVG." };
  }

  // every id in the file, for url(#...) paints and for <use>
  const defs = new Map();
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const id = all[i].getAttribute && all[i].getAttribute("id");
    if (id && !defs.has(id)) defs.set(id, all[i]);
  }

  const vb = numsIn(root.getAttribute("viewBox") || "");
  const ref = vb.length === 4 && vb[2] > 0
    ? Math.max(vb[2], vb[3])
    : Math.max(parseFloat(root.getAttribute("width")) || 0,
      parseFloat(root.getAttribute("height")) || 0) || 1000;
  const step = stepFor(ref);

  const raw = [];
  let sawText = false;

  const walk = (el, m, style, depth) => {
    if (depth > 24 || raw.length > MAX_SVG_PATHS * 4) return;
    for (let i = 0; i < el.childNodes.length; i++) {
      const kid = el.childNodes[i];
      if (kid.nodeType !== 1) continue;
      const tag = String(kid.tagName).toLowerCase().replace(/^.*:/, "");
      if (HIDDEN.has(tag)) continue;
      if (tag === "text" || tag === "tspan" || tag === "textpath") { sawText = true; continue; }
      const st = styleOf(kid, style, defs);
      const cm = mul(m, parseTransform(kid.getAttribute("transform") || ""));
      if (st.hidden) continue;
      if (tag === "g" || tag === "a" || tag === "switch") { walk(kid, cm, st, depth + 1); continue; }
      if (tag === "svg") {
        // a nested viewport: its own viewBox rescales what is inside it
        walk(kid, mul(cm, nestedViewport(kid)), st, depth + 1);
        continue;
      }
      if (tag === "use") {
        const href = kid.getAttribute("href") || kid.getAttribute("xlink:href") || "";
        const target = href.startsWith("#") ? defs.get(href.slice(1)) : null;
        if (!target || target === kid) continue;
        const ux = parseFloat(kid.getAttribute("x")) || 0;
        const uy = parseFloat(kid.getAttribute("y")) || 0;
        const um = mul(cm, [1, 0, 0, 1, ux, uy]);
        const ttag = String(target.tagName).toLowerCase().replace(/^.*:/, "");
        // <use> of a container draws the container's children; of a shape,
        // the shape itself
        if (ttag === "symbol" || ttag === "g" || ttag === "svg") {
          walk(target, um, styleOf(target, st, defs), depth + 1);
        } else {
          emit(target, ttag, mul(um, parseTransform(target.getAttribute("transform") || "")),
            styleOf(target, st, defs));
        }
        continue;
      }
      if (DRAW.has(tag)) emit(kid, tag, cm, st);
    }
  };

  const emit = (el, tag, m, st) => {
    const { subs, open } = ringsOf(el, tag, m, step);
    if (!subs.length) return;
    // a line, a polyline and an unclosed path have no inside worth filling —
    // filling them is what turns line art into blots
    const fillable = subs.filter((_, k) => !open[k] || tag === "path");
    if (st.fill && st.opacity * st.fillOpacity >= MIN_ALPHA && fillable.length) {
      raw.push({ color: st.fill, even: st.even, subs: fillable });
    }
    if (st.stroke && st.opacity * st.strokeOpacity >= MIN_ALPHA && st.strokeWidth > 0) {
      const rings = strokeRings(subs, open, st.strokeWidth * scaleOf(m));
      if (rings.length) raw.push({ color: st.stroke, even: false, subs: rings });
    }
  };

  const nestedViewport = (el) => {
    const v = numsIn(el.getAttribute("viewBox") || "");
    const w = parseFloat(el.getAttribute("width")), h = parseFloat(el.getAttribute("height"));
    if (v.length !== 4 || !(v[2] > 0) || !(v[3] > 0) || !(w > 0) || !(h > 0)) return IDENTITY;
    const k = Math.min(w / v[2], h / v[3]);
    return [k, 0, 0, k, -v[0] * k, -v[1] * k];
  };

  walk(root, parseTransform(root.getAttribute("transform") || ""), ROOT_STYLE, 0);

  const box = viewportOf(root, raw);
  if (!box) {
    return { error: sawText
      ? "That SVG is only text — convert the type to outlines and try again."
      : "That SVG has nothing filled or stroked in it." };
  }
  const normalized = normalize(raw, box, tol);
  if (!normalized.length) {
    return { error: sawText
      ? "That SVG is only text — convert the type to outlines and try again."
      : "Nothing in that SVG landed inside its own frame." };
  }
  const { paths, dropped } = trim(normalized,
    opts.maxPaths || MAX_SVG_PATHS, opts.maxPoints || MAX_SVG_POINTS);
  const points = paths.reduce((n, p) => n + p.subs.reduce((m, s) => m + s.length / 2, 0), 0);
  return { content: svgContent(paths, box.w / box.h), paths: paths.length, dropped, points };
}

// Coarsen a drawing already in the document — the way back when a link will
// not hold it, or when its edges are finer than the water can show anyway.
export function simplifySvg(content, tol = SVG_TOLERANCE * 2) {
  const paths = [];
  for (const p of content.paths) {
    const subs = [];
    for (const s of p.subs) {
      const thin = simplify(s, tol);
      if (thin.length >= 6 && ringArea(thin) > tol * tol) subs.push(thin);
    }
    if (subs.length) paths.push({ ...p, subs });
  }
  return { ...content, paths: paths.length ? paths : content.paths };
}
