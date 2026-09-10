// ------------------------------------------------------------------ //
//  A text mask without a canvas
//
//  Real masks come from the platform's own type (textMask.js), which means a
//  canvas and a font stack — neither of which jsdom has, and neither of which
//  a test should depend on anyway: "does Georgia's lowercase g have a closed
//  loop on this machine" is not a fact about this renderer.
//
//  So the tests build their letters here instead: upright bars, as a signed
//  distance field in the same plain-data shape `buildTextMask` returns. It is
//  enough shape to answer the questions that ARE about the renderer — whether
//  the mark lands where it was put, rides the surface, is cut by the crest in
//  front of it, and comes out the same on either thread.
// ------------------------------------------------------------------ //
const EM = 24, PAD = 8;

/**
 * A mask of upright bars, each `[left, right]` in ems, `height` ems tall,
 * standing on the baseline with the left edge of the ink box on the origin.
 */
export function barsMask(bars = [[0.1, 0.45], [0.65, 1.0]], height = 0.72) {
  const wEm = bars[bars.length - 1][1];
  const W = Math.round(wEm * EM) + 2 * PAD, H = Math.round(height * EM) + 2 * PAD;
  const sdf = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const u = (c - PAD) / EM, v = (H - PAD - r) / EM;   // ink-box coords, y up
      let best = -1e3;
      for (const [a, b] of bars) {
        best = Math.max(best, Math.min(u - a, b - u, v, height - v));
      }
      sdf[r * W + c] = best * EM;                         // the field is in cells
    }
  }
  const x0 = 0, y0 = -Math.round(height * EM);            // ink top, canvas-down
  return { w: W, h: H, sdf, em: EM, pad: PAD, x0, y0,
    box: { x0: x0 / EM, x1: (x0 + W - 2 * PAD) / EM,
           y0: -(y0 + H - 2 * PAD) / EM, y1: -y0 / EM } };
}

// A watermark spec ready to hang on S, over the fixtures' own water.
export const demoMark = (patch = {}) => ({
  mask: barsMask(), x: 0, y: 20, size: 6, angle: 0,
  color: "#ff2d55", halo: 0.35, haloColor: "#10151c", ...patch,
});
