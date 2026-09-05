// The 3D-solid pass, off the main thread.
//
// buildSolid3D is seconds of work on a detailed scene, and run on the page's
// own thread it held everything: the slider being dragged, the animation
// clock, and eventually the tab, once the browser decided the page had stopped
// responding. Here it runs in a worker, one request at a time in the order
// they arrive, and posts back the { bg, layers, fres, gap } the studio would
// have built itself — the same function on the same inputs, so the picture is
// identical; only the thread changed. The field spec is rebuilt on this side
// from plain data (fieldSpecFor), because its sampling closures cannot cross
// to a worker.
/* eslint-disable no-restricted-globals */
import { buildSolid3D, fieldSpecFor } from "./WaterReflectionContours";

self.onmessage = ({ data }) => {
  const { id, S, spec, raster } = data;
  try {
    self.postMessage({ id, out: buildSolid3D(S, fieldSpecFor(S, spec), raster) });
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || String(e) });
  }
};
