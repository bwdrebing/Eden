// ------------------------------------------------------------------ //
//  Palettes
//
//  Moved out of the renderer so a backdrop document can build a colour ramp
//  without importing the renderer — the dependency has to run document ->
//  renderer, never back. Data and two pure functions; both still re-exported
//  from WaterReflectionContours.jsx, so nothing else moves.
// ------------------------------------------------------------------ //
import * as d3 from "d3";

export const PALETTES = {
  "Sunset Lake": ["#1b1640", "#4a2273", "#8e2f72", "#d04e5d", "#f0913f", "#f7d774", "#fbf0cf"],
  "Tunic Glass": ["#0a2b30", "#0f5454", "#1c8a80", "#56bda3", "#bfe2bd", "#eccd83", "#f6ead0"],
  "Treeline":    ["#0a130d", "#10301d", "#2c5736", "#6a8a64", "#b6b08e", "#e3a974", "#b9d6ed"],
  "Obra Dinn":   ["#0b0b0b", "#262626", "#565656", "#8f8f8f", "#c7c7c7", "#f2f2f2"],
};

// Banded palettes: piecewise-constant elevation strips [color, weight] from
// horizon (first) to zenith (last), instead of a smooth ramp. The thin dark
// strips are the key: the reflected-elevation field is continuous, so every
// boundary between the bands on either side must pass THROUGH the strip —
// it draws itself as a closed hairline outline around each color region,
// the "ink line" look of real harbor-water reflections.
export const BANDED_PALETTES = {
  // each ink strip gets a visually identical but UNIQUE hex: a repeated color
  // fuses into one multi-strip region in the 2D segmentation, whose union
  // layer grows hairline protrusions that the sliver blur then eats. Unique
  // strips keep every union a clean upper set of elevation.
  "Harbor Ink": [
    ["#eef7fb", 0.15], ["#06090d", 0.022], ["#9fd2e2", 0.15], ["#070a0e", 0.022],
    ["#4b93bd", 0.16], ["#05080c", 0.022], ["#20608a", 0.15], ["#060a0e", 0.022],
    ["#143b58", 0.14], ["#07090d", 0.026], ["#0d2334", 0.126],
  ],
  "Sunset Buoy": [
    ["#f6edc9", 0.13], ["#e5a94b", 0.05], ["#cd5a28", 0.028], ["#f2d98a", 0.07],
    ["#8c9cc8", 0.12], ["#c8551f", 0.024], ["#46689e", 0.14], ["#2b1710", 0.024],
    ["#31518a", 0.13], ["#15101e", 0.05], ["#101c38", 0.12], ["#7e2d12", 0.022],
    ["#060a14", 0.09],
  ],
  "Black Water": [
    ["#d9f0f4", 0.12], ["#f6fbfb", 0.02], ["#a7c4ef", 0.13], ["#8e959d", 0.024],
    ["#7e97dd", 0.14], ["#494f58", 0.024], ["#0b0e13", 0.22], ["#b9c8ee", 0.028],
    ["#05070b", 0.294],
  ],
};

// cumulative stops of a banded palette: [{c, f0, f1}] with f = fraction of the
// elevation range, horizon (0) -> zenith (1). null for smooth palettes.
export function paletteStops(name) {
  const b = BANDED_PALETTES[name];
  if (!b) return null;
  const total = b.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  return b.map(([c, w]) => { const f0 = acc / total; acc += w; return { c, f0, f1: acc / total }; });
}

export function paletteColorAt(name, f) {
  const stops = paletteStops(name);
  if (!stops) return d3.interpolateRgbBasis(PALETTES[name])(f);
  for (const s of stops) if (f < s.f1) return s.c;
  return stops[stops.length - 1].c;
}

export const paletteNames = () => [...Object.keys(PALETTES), ...Object.keys(BANDED_PALETTES)];
