// ------------------------------------------------------------------ //
//  Scalar field primitives
//
//  Two small kernels the backdrop compiler and the renderer both need, kept
//  in one place so there is one definition of each. Moved out of
//  WaterReflectionContours.jsx unchanged — the pen styles still use the
//  distance transform, and the reflected-direction fields still use the box
//  blur, so both remain re-exported from there.
// ------------------------------------------------------------------ //

// chamfer distance transform: 0 outside the region, growing inward
export function distTransform(mask, nx, ny) {
  const INF = 1e9, D = new Float64Array(nx * ny), s2 = Math.SQRT2;
  for (let p = 0; p < nx * ny; p++) D[p] = mask[p] ? INF : 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = j * nx + i; if (D[p] === 0) continue; let m = D[p];
    if (i > 0) m = Math.min(m, D[p - 1] + 1);
    if (j > 0) m = Math.min(m, D[p - nx] + 1);
    if (i > 0 && j > 0) m = Math.min(m, D[p - nx - 1] + s2);
    if (i < nx - 1 && j > 0) m = Math.min(m, D[p - nx + 1] + s2);
    D[p] = m;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const p = j * nx + i; if (D[p] === 0) continue; let m = D[p];
    if (i < nx - 1) m = Math.min(m, D[p + 1] + 1);
    if (j < ny - 1) m = Math.min(m, D[p + nx] + 1);
    if (i < nx - 1 && j < ny - 1) m = Math.min(m, D[p + nx + 1] + s2);
    if (i > 0 && j < ny - 1) m = Math.min(m, D[p + nx - 1] + s2);
    D[p] = m;
  }
  return D;
}

// separable box blur on a continuous field (used to de-jitter the reflected
// direction fields before quantizing them into panorama cells, and to round
// the pixel-corner bevels of a painted region's distance field)
export function blurField(src, nx, ny, tmp, passes) {
  for (let it = 0; it < passes; it++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = src[j * nx + (i > 0 ? i - 1 : i)], b = src[j * nx + i], c = src[j * nx + (i < nx - 1 ? i + 1 : i)];
      tmp[j * nx + i] = (a + b + c) / 3;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = tmp[(j > 0 ? j - 1 : j) * nx + i], b = tmp[j * nx + i], c = tmp[(j < ny - 1 ? j + 1 : j) * nx + i];
      src[j * nx + i] = (a + b + c) / 3;
    }
  }
}
