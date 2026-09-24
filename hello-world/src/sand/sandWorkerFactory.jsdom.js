// test-runner stand-in for sandWorkerFactory.js: jsdom has no workers, and the
// real module's import.meta does not parse there. No worker means the studio
// renders inline, which is what every test exercises.
export function createSandWorker() {
  return null;
}
