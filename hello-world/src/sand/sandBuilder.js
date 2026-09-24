// A handle on the sand render worker (sandWorker.js).
//
// render() posts one request and resolves with { svg, stats, VW, VH }.
// Where workers do not exist — jsdom, a locked-down browser — or the worker
// dies (a script that failed to load, a crash), it renders on this thread
// instead, after yielding once so the "rendering…" label can paint first:
// slower, but the same function on the same settings, so the same picture.
// Requests run in order; a caller that only wants the newest picture keeps
// one waiting and drops the rest (see SandscapeStudio).
import { createSandWorker } from "./sandWorkerFactory";
import { renderSand } from "./render";

function renderInline(S, BW) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(renderSand(S, BW)); } catch (e) { reject(e); }
    }, 0);
  });
}

export function createSandBuilder() {
  let worker = createSandWorker();
  if (!worker) return { render: renderInline, terminate() {} };
  let next = 1;
  const waiting = new Map();
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    if (data.error) w.reject(new Error(data.error));
    else w.resolve(data.out);
  };
  // nothing sent will ever answer: finish what was waiting here, and send
  // everything after it here too
  worker.onerror = (e) => {
    if (e && e.preventDefault) e.preventDefault();   // handled: it is not the page's error
    if (worker) worker.terminate();
    worker = null;
    for (const w of waiting.values()) renderInline(w.S, w.BW).then(w.resolve, w.reject);
    waiting.clear();
  };
  return {
    render(S, BW) {
      if (!worker) return renderInline(S, BW);
      return new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject, S, BW });
        try {
          worker.postMessage({ id, S, BW });
        } catch (e) {
          waiting.delete(id);
          reject(e);
        }
      });
    },
    // Stop the worker. Whatever was still waiting is rejected with a
    // `stopped` error rather than left hanging — a caller that chains its
    // next request off the last one settling would otherwise wait forever.
    terminate() {
      if (worker) worker.terminate();
      worker = null;
      const err = new Error("stopped");
      err.stopped = true;
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
    },
  };
}
