// ------------------------------------------------------------------ //
//  Placement: where a ray lands on a flat
//
//  The renderer asks a backdrop exactly one question, and this is it: given a
//  ray, where does it hit, in that flat's own coordinates?
//
//  Today every flat is the sky — the sphere at infinity — so the answer is a
//  pair of angles, and the flat's coordinates are panorama cells. That is what
//  buildSegmentation used to compute inline. It lives here instead because two
//  other things want the same answer:
//
//    * the direct view ray, so the backdrop can be drawn on screen above the
//      horizon rather than only inferred from its reflection;
//    * a flat standing at a finite distance, where the answer stops being a
//      direction and becomes a point on a plane.
//
//  Both arrive on top of this seam, not through another copy of the arithmetic.
// ------------------------------------------------------------------ //

const DEG = 180 / Math.PI;

// Reflection detail ("angular zoom"): stretch the reflected-direction mapping
// about the middle of the environment window. At mag = 1 the window [eLo, eHi]
// spans the environment exactly as painted; at mag > 1 the same environment is
// compressed into a 1/mag-narrower cone about the window center, so a small
// ripple tilt sweeps a larger fraction of the colors — the telephoto close-up
// look where every wavelet carries the whole gradient.
export function magFrac(f, mag) {
  return mag === 1 ? f : 0.5 + (f - 0.5) * mag;
}

// A direction vector [x, y, z] as the two angles the sky is indexed by.
// Elevation is signed from the horizon; azimuth is signed across the view.
export function rayAngles(R) {
  const z = R[2] < -1 ? -1 : R[2] > 1 ? 1 : R[2];
  return [Math.asin(z) * DEG, Math.atan2(R[0], R[1]) * DEG];
}

// The sky flat: a window of [eLo, eHi] in elevation and +/- azSpan in azimuth,
// mapped onto an EW x EH cell grid. Rays outside the window saturate at the
// edge cell, which is why paint above eHi smears over everything above it.
export function makeSkyPlace({ eLo, eHi, azSpan, mag = 1, EW, EH }) {
  const span = (eHi - eLo) || 1;
  const az = azSpan;
  const unit = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return {
    EW, EH, azSpan: az,
    // azimuth is clamped to the window before any smoothing, elevation after —
    // the order buildSegmentation established, kept exactly
    clampAz: (psi) => (psi < -az ? -az : psi > az ? az : psi),
    row: (phi) => unit(magFrac((phi - eLo) / span, mag)) * EH,
    col: (psi) => unit(magFrac((psi + az) / (2 * az), mag)) * EW,
  };
}

// ---- a flat at a finite distance ------------------------------------
//
// A stage flat: a vertical board standing across the water at `distance`,
// `width` units wide and `height` units tall, facing the camera. Where the sky
// answers with a direction, this answers with a point on a board — which is
// the whole of depth. Two things follow that no direction map can give:
//
//   * parallax. The sky is the same from everywhere on the water; a board at
//     eight units is not, so its reflection slides as the eye travels across
//     the frame and its edges converge the way a real thing's do.
//   * a ray can MISS. Water beyond the board reflects rays that leave without
//     ever reaching it, so the board simply is not in that part of the water.
//     That falloff is the depth cue, and it costs nothing to compute: it is
//     the sign of t.
//
// `hit(x, y, z, R)` takes a point on the water and a ray leaving it, and
// returns [u, v] in 0..1 across and up the board, or null.
export function makePlanePlace({ distance, width, height }) {
  const D = distance, W = width || 1, H = height || 1;
  return {
    kind: "plane", distance: D, width: W, height: H,
    // Null means the ray never arrives — it runs parallel to the board or
    // away from it — which is a genuine fold in the reflection and belongs as
    // a hard boundary. Landing PAST the board's edge is a different thing: it
    // is an edge, and an edge wants to be smooth, so those coordinates come
    // back as they are (outside 0..1) and `edge` says how far outside. A
    // binary in-or-out here would contour into a sawtooth at the sample grid.
    hit(x, y, z, R) {
      const ry = R[1];
      if (ry <= 1e-9) return null;              // parallel to the board, or away
      const t = (D - y) / ry;
      if (t <= 0) return null;                  // the board is behind this ray
      const hx = x + t * R[0], hz = z + t * R[2];
      return [(hx + W / 2) / W, hz / H];
    },
    // signed distance to the board's rectangle, in flat units: positive on it
    edge(u, v) { return Math.min(u, 1 - u, v, 1 - v); },
  };
}

// The sky as the same shape of thing, so a renderer can hold one list of
// placements and ask each the same question. Coordinates come back in 0..1
// rather than cells, which is what the plane speaks.
export function skyPlaceUnit(sky) {
  const p = makeSkyPlace({ ...sky, EW: 1, EH: 1 });
  return {
    kind: "sky", distance: Infinity,
    hit(x, y, z, R) {
      const [phi, psi] = rayAngles(R);
      return [p.col(p.clampAz(psi)), p.row(phi)];
    },
  };
}

// Sort flats the way the water sees them: furthest first, so the nearer ones
// are drawn over them. Ties keep the order the document has them in.
export const byDepth = (a, b) => (b.distance - a.distance) || 0;

// ---- the floor under the water --------------------------------------
//
// A pool bottom: a HORIZONTAL plane a fixed depth below the surface, which is
// the one thing a backdrop at infinity cannot be. The difference is the whole
// look of tiled water. A direction map answers the same thing however deep
// the pool is, so a grid painted into it would ripple but never warp; a floor
// is a place, so the ray has to travel to it, and how far it travels off the
// straight-down point is
//
//     displacement = depth * tan(refracted angle)
//
// That is the warp. Grout lines bow where the surface tilts, the bow grows
// with depth, and it goes to nothing as the water gets shallow — all of it
// falls out of the intersection rather than being drawn in.
//
// The floor REPEATS: `span` world units carry one copy of the document, so a
// pool is tiled by construction and never runs out under the frame the way a
// bounded board would. Two things follow, and the grid content is built to
// match them (see gridContent):
//
//   * the document's edges must fall in the MIDDLE of a tile, never along a
//     grout line. Each region's distance field is transformed on the document
//     grid, which is not periodic, so a feature sitting on the seam gets its
//     field measured against the grid's edge instead of its neighbour across
//     the repeat. Mid-tile, both sides of the seam are deep inside the same
//     region, the field is large and equal on both, and nothing contours.
//   * anything varying per tile has to be keyed on the tile's index WITHIN
//     the block, so the copy on the far side of a seam is the same tile.
export function makeFloorPlace({ depth, span, spanY }) {
  const D = depth, SX = span || 1, SY = spanY || span || 1;
  return {
    kind: "floor", distance: D, depth: D, span: SX, spanY: SY, repeat: true,
    // (x, y, z) is the point on the WATER — z is the wave height there, not
    // zero, so a floor under a lifted crest is that much further away and the
    // warp answers to the surface the camera can actually see.
    hit(x, y, z, R) {
      if (R[2] >= -1e-9) return null;           // not heading down: no floor
      const t = (-D - z) / R[2];
      if (t <= 0) return null;
      return [(x + t * R[0]) / SX, (y + t * R[1]) / SY];
    },
    // the floor has no rim to run off — it is under everything
    edge() { return Infinity; },
  };
}
