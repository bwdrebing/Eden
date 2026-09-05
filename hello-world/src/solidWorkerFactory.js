// One call in its own module: `new URL(…, import.meta.url)` is the form the
// bundler recognises as a worker entry, and import.meta is also the one thing
// the test runner cannot parse — package.json maps this module to a stub there.
export function createSolidWorker() {
  if (typeof Worker !== "function") return null;
  try {
    return new Worker(new URL("./solidWorker.js", import.meta.url), { name: "solid3d" });
  } catch (e) {
    return null;                                // no worker: the studio builds inline
  }
}
