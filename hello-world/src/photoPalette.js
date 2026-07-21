// ------------------------------------------------------------------ //
//  Photo -> palette extraction
//
//  A photo of water is, from the renderer's point of view, a distorted
//  sample of the reflected environment: far water (top of the frame)
//  reflects the sky near the horizon, near water (bottom) reflects
//  higher elevations. So the vertical axis of the photo maps directly
//  onto the 1D environment strip the paint-1D mode already consumes.
//
//  extractPhotoStrip quantizes the photo to k dominant colors (k-means
//  in Lab space, deterministic seeding) and resamples the rows into an
//  ENV_N-cell strip: strip[0] = top of photo = horizon, strip[n-1] =
//  bottom = zenith end. Band widths fall out of the row proportions.
//
//  Rows are usually a MIX of colors (glints threaded through greens),
//  and a single strip cell holds one color — so instead of flattening
//  each row to its dominant color (which collapses the texture into a
//  few mega-bands), the mix is encoded as proportionally interleaved
//  runs via error diffusion along the strip. The waves sweep across
//  those thin alternating bands and shred them back into glints, which
//  is exactly how the app's banded palettes get the harbor-water look.
// ------------------------------------------------------------------ //
import * as d3 from "d3";

// deterministic RNG so the same photo always yields the same palette
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (p, c) => {
  const dl = p[0] - c[0], da = p[1] - c[1], db = p[2] - c[2];
  return dl * dl + da * da + db * db;
};

// k-means++ over Lab triples. points: Float64Array-like [[L,a,b],...]
// Returns { centers: [[L,a,b],...], labels: Int32Array }
export function kmeansLab(points, k, iters = 16, seed = 1234) {
  const n = points.length;
  const kk = Math.max(1, Math.min(k, n));
  const rand = mulberry32(seed + kk * 7919);

  // k-means++ seeding
  const centers = [points[Math.floor(rand() * n)].slice()];
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < kk) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(points[i], c);
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    let r = rand() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
    centers.push(points[pick].slice());
  }

  const labels = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; moved = true; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sums[labels[i]], p = points[i];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] === 0) continue; // empty cluster keeps its old center
      centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (!moved && it > 0) break;
  }
  return { centers, labels };
}

function labToHex(c) {
  return d3.lab(c[0], c[1], c[2]).formatHex();
}

// image: { data: RGBA byte array, width, height } (an ImageData works).
// k: number of dominant colors. n: cells in the output strip.
// Returns:
//   strip    - n hex colors, index 0 = horizon (top of photo)
//   swatches - the k cluster hexes ordered horizon -> zenith by mean row
//   deep     - the darkest cluster hex (a ready-made deep-water color)
export function extractPhotoStrip(image, k = 5, n = 64) {
  const { data, width: w, height: h } = image;
  if (!w || !h) return null;

  const labs = new Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const c = d3.lab(d3.rgb(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
    labs[i] = [c.l, c.a, c.b];
  }
  const { centers, labels } = kmeansLab(labs, k);
  const nc = centers.length;

  // per-row cluster shares
  const rowShare = new Float64Array(h * nc);
  for (let r = 0; r < h; r++) {
    for (let x = 0; x < w; x++) rowShare[r * nc + labels[r * w + x]]++;
    for (let c = 0; c < nc; c++) rowShare[r * nc + c] /= w;
  }

  // walk the strip in 2-cell blocks; each block's row window yields cluster
  // shares, and error diffusion turns those shares into interleaved runs —
  // a 60/40 window comes out as alternating bands in a 60/40 ratio, while a
  // pure window stays one solid run. A cluster only fires where it actually
  // appears (share above a floor), so diffused credit can't drift a color
  // into rows that never contained it.
  const Q = 2, NB = Math.ceil(n / Q);
  const cellLabel = new Int32Array(n);
  const err = new Float64Array(nc);
  const p = new Float64Array(nc);
  for (let b = 0; b < NB; b++) {
    const r0 = Math.floor((b * h) / NB), r1 = Math.max(r0 + 1, Math.floor(((b + 1) * h) / NB));
    p.fill(0);
    for (let r = r0; r < r1; r++) for (let c = 0; c < nc; c++) p[c] += rowShare[r * nc + c];
    for (let c = 0; c < nc; c++) { p[c] /= (r1 - r0); err[c] += p[c]; }
    let pick = -1;
    for (let c = 0; c < nc; c++) {
      if (p[c] > 0.05 && (pick < 0 || err[c] > err[pick])) pick = c;
    }
    if (pick < 0) { pick = 0; for (let c = 1; c < nc; c++) if (p[c] > p[pick]) pick = c; }
    err[pick] -= 1;
    for (let i = b * Q; i < Math.min(n, (b + 1) * Q); i++) cellLabel[i] = pick;
  }

  const hexes = centers.map(labToHex);
  const strip = Array.from(cellLabel).map((c) => hexes[c]);

  // swatches: clusters that survived into the strip, horizon -> zenith
  const meanRow = centers.map(() => ({ s: 0, n: 0 }));
  for (let i = 0; i < w * h; i++) { const m = meanRow[labels[i]]; m.s += Math.floor(i / w); m.n++; }
  const used = [...new Set(Array.from(cellLabel))];
  used.sort((a, b) => {
    const ma = meanRow[a].n ? meanRow[a].s / meanRow[a].n : h;
    const mb = meanRow[b].n ? meanRow[b].s / meanRow[b].n : h;
    return ma - mb;
  });
  const swatches = used.map((c) => hexes[c]);

  let deep = 0;
  for (let c = 1; c < centers.length; c++) if (centers[c][0] < centers[deep][0]) deep = c;

  return { strip, swatches, deep: hexes[deep] };
}
