// The sand renderer, off the main thread.
//
// A perspective scene samples a million-odd nodes and walks a shadow ray
// from most of them — a second or two of work that, on the page's own
// thread, would freeze the slider being dragged. Here it runs in a worker
// and posts back the finished SVG: the same string the export writes, so
// the preview cannot drift from the file.
/* eslint-disable no-restricted-globals */
import { renderSand } from "./render";

self.onmessage = ({ data }) => {
  const { id, S, BW } = data;
  try {
    self.postMessage({ id, out: renderSand(S, BW) });
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || String(e) });
  }
};
