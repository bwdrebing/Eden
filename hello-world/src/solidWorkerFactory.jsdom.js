// test-runner stand-in for solidWorkerFactory.js: jsdom has no workers, and the
// real module's import.meta does not parse there. No worker means the studio
// builds inline, which is what every test exercises.
export function createSolidWorker() {
  return null;
}
