// Not a test — the harness that writes the saved scene to an .svg so it can be
// looked at, which is what the project asks for on any rendering change, and
// which nothing here automated before. Jest is only the easiest way to run the
// module graph. Skipped unless EDEN_RENDER names a file to write:
//
//   EDEN_RENDER=/tmp/before.svg CI=true npx react-scripts test \
//     --watchAll=false --testPathPattern renderFixture
//
// EDEN_LEVEL picks the raster (0-5, default 5 = "max"), EDEN_POLISH the export
// edge polish (0-2), and EDEN_MOOD renders one of the water presets on the
// saved scene's camera instead of its own emitters.
import fs from "fs";
import { fixtureSvg } from "./renderFixture";

const out = process.env.EDEN_RENDER;
const level = Number(process.env.EDEN_LEVEL || 5);
const polish = Number(process.env.EDEN_POLISH || 1);

(out ? test : test.skip)("render the fixture to an svg", () => {
  fs.writeFileSync(out, fixtureSvg({ level, polish, mood: process.env.EDEN_MOOD || null }));
  expect(fs.statSync(out).size).toBeGreaterThan(1000);
}, 900000);
