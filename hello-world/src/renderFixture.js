// Dev-only: render the saved GRAZING_RIPPLES scene to an .svg at a real
// raster, for the look-at-it step the project asks for on any change to the
// contouring, rasterizing, projection or export path. Not part of the app.
//   node -r ./scripts/babelReg.js  — or run it through the jest env:
//   CI=true npx react-scripts test --watchAll=false -t "render the fixture"
import {
  buildSolid3D, RASTER_LEVELS, EXPORT_POLISH, WATER_MOODS,
} from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

// `mood` swaps the saved scene's emitters (and the four surface settings they
// were tuned with) for one of the presets, keeping its camera, palette and
// elevation range — which is how a new emitter gets tried at the grazing
// framing that shows far-field trouble first.
export function fixtureSvg({ level = 5, polish = 1, mood = null } = {}) {
  let settings = GRAZING_RIPPLES;
  if (mood) {
    const m = WATER_MOODS.find((w) => w.name === mood);
    if (!m) throw new Error("no mood " + mood);
    settings = { ...settings, emitters: m.emitters,
      wavelength: m.wavelength, strength: m.strength, sharp: m.sharp, spread: m.spread };
  }
  const { S, fieldSpec } = buildScene(settings);
  const L = RASTER_LEVELS[level];
  const { bg, layers } = buildSolid3D(S, fieldSpec,
    { gN: L.gN, BW: L.BW, polish: EXPORT_POLISH[polish].passes });
  const body = layers
    .map((l) => `<path d="${l.d}" fill="${l.color}" fill-rule="evenodd"/>`)
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 500" width="760" height="500">
<rect width="760" height="500" fill="${bg}"/>
${body}
</svg>`;
}
