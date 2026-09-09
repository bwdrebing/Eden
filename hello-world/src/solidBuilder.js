// A handle on the render worker (solidWorker.js).
//
// build() posts one 3D-solid request and resolves with its result. Requests
// run in the order they are sent, so a caller that only wants the newest
// picture (the preview) keeps one request waiting and replaces it, while a
// caller that wants every frame (the video export) awaits each in turn.
// Returns null where workers do not exist — jsdom, a locked-down browser —
// and the studio then builds on its own thread as it always did.
import { createSolidWorker } from "./solidWorkerFactory";

export function createSolidBuilder() {
  const worker = createSolidWorker();
  if (!worker) return null;
  let next = 1;
  const waiting = new Map();
  const failAll = (message) => {
    const err = new Error(message);
    err.fatal = true;                           // the worker itself is gone
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    if (data.error) w.reject(new Error(data.error));
    else w.resolve(data.out);
  };
  // a script that failed to load, or a crash: nothing sent will ever answer
  worker.onerror = (e) => failAll((e && e.message) || "the render worker failed");
  return {
    build(S, spec, raster) {
      return new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        // S may carry this thread's baked emitters (_ems); the worker bakes
        // its own from the settings, so those stay behind
        const { _ems, ...settings } = S;
        try {
          worker.postMessage({ id, S: settings, spec, raster });
        } catch (e) {
          waiting.delete(id);
          reject(e);
        }
      });
    },
    terminate() {
      worker.terminate();
      failAll("the render worker was stopped");
    },
  };
}
