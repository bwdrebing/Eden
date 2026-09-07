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
//      direction and becomes a point on a plane (see docs/backdrop-system.md).
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
