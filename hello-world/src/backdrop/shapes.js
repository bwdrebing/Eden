// ------------------------------------------------------------------ //
//  Shapes
//
//  A backdrop made of pixels is a backdrop you have to draw pixel by pixel,
//  at whatever resolution the sampler happens to want — 84 cells across the
//  whole panorama, where the smallest brush is more than a degree wide and a
//  mast or a piling is not expressible at all.
//
//  A shape is stated instead of drawn: a rectangle at a position, this wide
//  and this tall. It can be moved after the fact, because it is still there
//  to move. And it is resolution-free — coordinates run 0..1 across the flat,
//  so the same shape renders onto whatever grid the compiler asks for, which
//  is how a shape layer gets edges finer than the brush could ever paint
//  (see COMPILE_SCALE in compile.js).
//
//  Everything here renders to cells, like every other content kind, so the
//  compiler and the renderer below it do not learn a second way to see the
//  world. What shapes add is not a new pipeline; it is that the picture stops
//  being the only copy of itself.
// ------------------------------------------------------------------ //

// Silhouettes evaluated in a local box: u in [-1, 1] across the width, v in
// [0, 1] from the base to the top. 0 = empty, 1 = primary color, 2 = accent.
// The four object shapes are the catalogue the reflected-objects panel has
// always had, now available as something you can put anywhere and drag.
// `tint` is what the shape looks like when you have not said otherwise: a
// tree is a dark trunk under a green crown, not two arbitrary colours.
export const STAMPS = {
  sailboat: { aspect: 1.7, label: ["hull", "sails"], tint: ["#2a1d16", "#f6f2e7"],
    fn: (u, v) => {
    if (v < 0.16 && Math.abs(u) < 0.95 - 1.8 * Math.max(0, 0.09 - v)) return 1; // hull
    if (v >= 0.14 && v < 0.99) {
      const fm = (0.99 - v) / 0.85;                       // mainsail
      if (u >= 0.03 && u < 0.03 + 0.9 * fm) return 2;
      if (v < 0.8) {                                      // jib
        const fj = (0.8 - v) / 0.66;
        if (u <= -0.03 && u > -0.03 - 0.7 * fj) return 2;
      }
    }
    return 0;
  } },
  dock: { aspect: 4.0, label: ["pilings", "deck"], tint: ["#26201a", "#8a6f52"],
    fn: (u, v) => {
    if (v >= 0.5 && v < 0.85) return v >= 0.72 ? 2 : 1;   // deck slab, lit top edge
    if (v < 0.5) {
      for (const k of [-0.7, -0.235, 0.235, 0.7]) if (Math.abs(u - k) < 0.06) return 1;
    }
    return 0;
  } },
  buoy: { aspect: 0.8, label: ["base", "ball"], tint: ["#1a1410", "#c2452e"],
    fn: (u, v) => {
    const dv = (v - 0.52) / 0.46;
    if (u * u + dv * dv <= 1) return 2;                   // the ball
    if (v < 0.1 && Math.abs(u) < 0.3) return 1;           // dark waterline nub
    return 0;
  } },
  post: { aspect: 0.3, label: ["post", "cap"], tint: ["#2a2119", "#6a5340"],
    fn: (u, v) =>
    (Math.abs(u) < 0.55 ? (v > 0.82 ? 2 : 1) : 0) },
  tree: { aspect: 0.75, label: ["trunk", "crown"], tint: ["#241a12", "#2c5736"],
    fn: (u, v) => {
    if (v < 0.3) return Math.abs(u) < 0.13 ? 1 : 0;       // trunk
    const t = (v - 0.3) / 0.7;                            // conical crown
    return Math.abs(u) < 0.95 * (1 - t * t * 0.85) ? 2 : 0;
  } },
};

export const SHAPE_KINDS = ["rect", "ellipse", "poly", ...Object.keys(STAMPS)];

let shapeSeq = 1;
export const newShapeId = () => "s" + shapeSeq++;

// A shape sits at (x, y) — its center across, its BASE up — and is w wide and
// h tall, all as fractions of the flat. Base rather than center vertically
// because everything in a backdrop stands on something: a dock on the
// waterline, a tree on the shore.
export const shape = (type, patch = {}) => {
  const st = STAMPS[type];
  const h = 0.15;
  return {
    id: newShapeId(), type,
    x: 0.5, y: 0.15,
    // a stamp's aspect is width:height of its silhouette, and the flat is
    // wider than it is tall, so the ratio has to come back through the grid
    // or a dock lands two thirds of the way across the sky
    w: st ? h * st.aspect * (DOC_ASPECT) : 0.2,
    h: st ? h : 0.18,
    color: st ? st.tint[0] : "#141d33",
    color2: st ? st.tint[1] : "#9cc3e8",
    rim: 0,
    ...patch,
  };
};

// height:width of the document grid, so a silhouette's proportions survive the
// trip into flat coordinates
export const DOC_ASPECT = 52 / 84;

export const shapesContent = (items = []) => ({ kind: "shapes", items });

// How many regions a shape contributes: its body, an accent for the stamps
// that have one, and an ink rim when it is asked for.
const stampOf = (item) => STAMPS[item.type];
export function shapeParts(item) {
  const parts = [{ role: "body", color: item.color }];
  if (stampOf(item)) parts.push({ role: "accent", color: item.color2 });
  if (item.rim > 0) parts.push({ role: "rim", color: item.rimColor || "#070a0e" });
  return parts;
}

const inPoly = (pts, x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// Which part of `item` covers the point (fx, fy), both in 0..1 flat
// coordinates: 0 = nothing, 1 = body, 2 = accent.
export function shapeAt(item, fx, fy) {
  const halfW = item.w / 2;
  const u = (fx - item.x) / (halfW || 1e-9);              // -1..1 across
  const v = (fy - item.y) / (item.h || 1e-9);             // 0..1 up from the base
  if (item.type === "rect") return (Math.abs(u) <= 1 && v >= 0 && v <= 1) ? 1 : 0;
  if (item.type === "ellipse") {
    const dv = (v - 0.5) * 2;
    return u * u + dv * dv <= 1 ? 1 : 0;
  }
  if (item.type === "poly") {
    const pts = item.points || [];
    return pts.length >= 3 && inPoly(pts, fx, fy) ? 1 : 0;
  }
  const st = stampOf(item);
  if (!st) return 0;
  if (Math.abs(u) > 1 || v < 0 || v > 1) return 0;
  return st.fn(u, v);
}

/**
 * Render shapes onto a w x h grid, later items over earlier ones.
 *
 * Returns { cells, keys }: the colour at each cell, and which region painted
 * it. Keys are what let two shapes of the same colour stay two regions —
 * the old model keyed a region on its hex, which is why an object's colour
 * had to be nudged a few bits to stop instances fusing into one.
 *
 * `keyOf(item, role)` hands back the region key for one part of one shape.
 */
export function rasterizeShapes(items, w, h, keyOf) {
  const cells = new Array(w * h).fill(null);
  const keys = new Int32Array(w * h).fill(-1);
  for (const item of items) {
    if (item.hidden) continue;
    // the rim first, so the body lands on top of it and only the overhang shows
    if (item.rim > 0) {
      const r = item.rim / Math.max(w, 1);                // rim width, in flat units
      const key = keyOf(item, "rim"), col = item.rimColor || "#070a0e";
      forEachCell(item, w, h, r, (p, fx, fy) => {
        if (cells[p] != null) return;
        for (const [dx, dy] of RIM_TAPS) {
          if (shapeAt(item, fx + dx * r, fy + dy * r)) { cells[p] = col; keys[p] = key; return; }
        }
      });
    }
    forEachCell(item, w, h, 0, (p, fx, fy) => {
      const t = shapeAt(item, fx, fy);
      if (!t) return;
      const role = t === 2 ? "accent" : "body";
      cells[p] = t === 2 ? item.color2 : item.color;
      keys[p] = keyOf(item, role);
    });
  }
  return { cells, keys };
}

const RIM_TAPS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

// walk the cells a shape could touch, padded by `pad` flat units
function forEachCell(item, w, h, pad, visit) {
  const halfW = item.w / 2;
  let x0 = item.x - halfW - pad, x1 = item.x + halfW + pad;
  let y0 = item.y - pad, y1 = item.y + item.h + pad;
  if (item.type === "poly" && item.points && item.points.length) {
    x0 = Math.min(...item.points.map((p) => p[0])) - pad;
    x1 = Math.max(...item.points.map((p) => p[0])) + pad;
    y0 = Math.min(...item.points.map((p) => p[1])) - pad;
    y1 = Math.max(...item.points.map((p) => p[1])) + pad;
  }
  const c0 = Math.max(0, Math.floor(x0 * w)), c1 = Math.min(w - 1, Math.ceil(x1 * w));
  const r0 = Math.max(0, Math.floor(y0 * h)), r1 = Math.min(h - 1, Math.ceil(y1 * h));
  for (let r = r0; r <= r1; r++) {
    const fy = (r + 0.5) / h;
    for (let c = c0; c <= c1; c++) visit(r * w + c, (c + 0.5) / w, fy);
  }
}

// A shape's box in flat coordinates, for hit-testing and drag handles.
export function shapeBox(item) {
  if (item.type === "poly" && item.points && item.points.length) {
    const xs = item.points.map((p) => p[0]), ys = item.points.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs),
             y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  return { x0: item.x - item.w / 2, x1: item.x + item.w / 2,
           y0: item.y, y1: item.y + item.h };
}

export const shapeLabel = (item) => {
  const st = stampOf(item);
  return st ? item.type : item.type;
};
