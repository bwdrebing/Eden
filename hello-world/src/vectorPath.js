// ------------------------------------------------------------------ //
//  Vector paths from traced rings
//
//  The ring helpers both studios draw with: corner-cutting, de-noising and a
//  closed Catmull-Rom fit, from a traced contour to SVG path data. Moved out
//  of WaterReflectionContours.jsx unchanged so the sand studio draws its
//  curves with exactly the same arithmetic; the water file imports them back.
// ------------------------------------------------------------------ //

// ---- ring helpers ---------------------------------------------------
// Rings travel through these as flat Float64Arrays, [x0, y0, x1, y1, …]. A
// smoothed ring is several hundred thousand points per layer, and building
// each one as an array of two-element arrays was a third of the trace time:
// ten million small allocations a frame, most of them thrown away again by
// simplifyRing a moment later. The arithmetic below is exactly what the
// pair-array versions did, operand for operand, so the paths come out
// byte-identical — only the storage changed.
export function flatRing(ring0) {
  const n = ring0.length, f = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { const p = ring0[i]; f[2 * i] = p[0]; f[2 * i + 1] = p[1]; }
  return f;
}

// Chaikin corner cutting, `iters` rounds. Takes a d3 ring (array of pairs) or
// a flat ring; always hands back a flat one.
export function chaikin(ring, iters) {
  let p = ring instanceof Float64Array ? ring : flatRing(ring);
  let n = p.length / 2;
  if (n > 1 && p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1]) { n -= 1; p = p.subarray(0, 2 * n); }
  for (let it = 0; it < iters; it++) {
    if (n < 3) break;
    const q = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
      q[4 * i] = ax * 0.75 + bx * 0.25; q[4 * i + 1] = ay * 0.75 + by * 0.25;
      q[4 * i + 2] = ax * 0.25 + bx * 0.75; q[4 * i + 3] = ay * 0.25 + by * 0.75;
    }
    p = q; n *= 2;
  }
  return p;
}

// drop near-duplicate screen points (keeps the bezier fit stable and the
// files small); also un-closes the ring if last == first.
//
// Each surviving point is the CENTROID of the run it absorbed, not the run's
// first point. The bezier fit downstream interpolates every point handed to
// it, so any per-vertex tracing noise — the raster beating against the field
// at sub-pixel amplitude — would otherwise come back as a scallop per kept
// vertex, at exactly this eps as its wavelength. Averaging the run removes
// that noise at the only scale it exists at; a run is shorter than eps by
// construction, so nothing the output could have resolved is lost.
export function simplifyRing(pts, eps) {
  const N = pts.length / 2, out = new Float64Array(pts.length);
  let m = 0;                                   // points written so far
  let ax = 0, ay = 0, sx = 0, sy = 0, n = 0;   // cluster anchor and running sum
  for (let i = 0; i < N; i++) {
    const px = pts[2 * i], py = pts[2 * i + 1];
    if (n && farther(px - ax, py - ay, eps)) {
      out[2 * m] = sx / n; out[2 * m + 1] = sy / n; m++;
      sx = 0; sy = 0; n = 0;
    }
    if (!n) { ax = px; ay = py; }
    sx += px; sy += py; n++;
  }
  if (n) { out[2 * m] = sx / n; out[2 * m + 1] = sy / n; m++; }
  if (m > 1 && !farther(out[0] - out[2 * m - 2], out[1] - out[2 * m - 1], eps)) m--;
  return out.subarray(0, 2 * m);
}

// Math.hypot(dx, dy) >= eps, decided from the squared distance wherever that
// is unambiguous. hypot is exact to a few ulp, so only a distance within a
// billionth of eps can come out differently, and there the call itself
// decides — the comparison is the one hypot would have made, at a fraction of
// its cost for the millions of points a smoothed frame runs through here.
export function farther(dx, dy, eps) {
  const d2 = dx * dx + dy * dy, e2 = eps * eps;
  if (d2 > e2 * 1.000000002) return true;
  if (d2 < e2 * 0.999999998) return false;
  return Math.hypot(dx, dy) >= eps;
}

// Number#toFixed, only faster. A traced frame formats a couple of million
// coordinates, and the built-in spends most of its time being general. This
// rounds the scaled value directly, which agrees with toFixed everywhere the
// binary value is not within a hair of a rounding tie — and there, where the
// exact decimal expansion has to decide, it defers to toFixed. Digits, signs
// and "-0.00" all come out as the built-in writes them.
export function fixed(x, scale, digits) {
  if (!(x > -1e6 && x < 1e6)) return x.toFixed(digits);
  let s = "";
  if (x < 0) { s = "-"; x = -x; }
  const y = x * scale, fl = Math.floor(y), fr = y - fl;
  if (fr > 0.499999 && fr < 0.500001) return s + x.toFixed(digits);
  const n = fr < 0.5 ? fl : fl + 1;
  const fp = n % scale, ip = (n - fp) / scale;
  if (digits === 1) return s + ip + "." + fp;
  return s + ip + (fp < 10 ? ".0" : ".") + fp;
}
export const fix1 = (x) => fixed(x, 10, 1);
export const fix2 = (x) => fixed(x, 100, 2);

// closed Catmull-Rom spline through the points, emitted as cubic beziers —
// the exported edge is a genuinely smooth curve (an elliptical region becomes
// an actual smooth closed curve, not a polygonal approximation)
// Two decimals, not one: a tenth of a viewBox unit is half a raster pixel at
// export width, so rounding there would re-quantize the sub-pixel crossings
// the whole pipeline works to keep, as visible steps under zoom.
export function ringToBezier(p) {
  const n = p.length / 2;
  let d = "M" + fix2(p[0]) + " " + fix2(p[1]) + " ";
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n, i2 = (i + 1) % n, i3 = (i + 2) % n;
    const p0x = p[2 * i0], p0y = p[2 * i0 + 1], p1x = p[2 * i], p1y = p[2 * i + 1];
    const p2x = p[2 * i2], p2y = p[2 * i2 + 1], p3x = p[2 * i3], p3y = p[2 * i3 + 1];
    const c1x = p1x + (p2x - p0x) / 6, c1y = p1y + (p2y - p0y) / 6;
    const c2x = p2x - (p3x - p1x) / 6, c2y = p2y - (p3y - p1y) / 6;
    d += "C" + fix2(c1x) + " " + fix2(c1y) + " "
       + fix2(c2x) + " " + fix2(c2y) + " "
       + fix2(p2x) + " " + fix2(p2y) + " ";
  }
  return d + "Z ";
}

// straight segments through a flat ring, one decimal — the sharp (smoothing 0)
// and degenerate-ring fallback the tracers share
export function ringToPolyline(p) {
  const n = p.length / 2;
  let d = "";
  for (let i = 0; i < n; i++)
    d += (i === 0 ? "M" : "L") + fix1(p[2 * i]) + " " + fix1(p[2 * i + 1]) + " ";
  return d + "Z ";
}
