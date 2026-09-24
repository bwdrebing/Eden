// ------------------------------------------------------------------ //
//  Sand palettes
//
//  Each is a ramp from the deepest shadow to the brightest lit face, plus
//  the sky a perspective view shows above the far dunes. Bands are drawn
//  from these by interpolation, so a ramp only needs its turning points.
// ------------------------------------------------------------------ //
import * as d3 from "d3";

export const SAND_PALETTES = {
  "Dune Sea":    { ramp: ["#3b1f16", "#7a3b1f", "#b8622f", "#dc8c48", "#efb36e", "#f7d9a4"], sky: "#f3e1bf" },
  "Dusk":        { ramp: ["#2b1b3a", "#5b2f55", "#9c4a5a", "#d9745a", "#f2a765", "#fbd99a"], sky: "#f6c48e" },
  "White Sands": { ramp: ["#57557a", "#8b88a8", "#b9b5c8", "#dcd6dc", "#efe9e4", "#fbf8f2"], sky: "#cfe0ea" },
  "Namib":       { ramp: ["#2a0f12", "#5e1c18", "#9a3320", "#c8552b", "#e48245", "#f1b27a"], sky: "#e9c7a2" },
  "Tidal Flat":  { ramp: ["#3f4447", "#6b6f6c", "#9a9687", "#c2b9a2", "#dfd6c1", "#f3eee2"], sky: "#dfe8ec" },
  "Moonlit":     { ramp: ["#070b18", "#131d38", "#26345c", "#3f5383", "#6d82ad", "#b6c4de"], sky: "#0b1226" },
  "Ink":         { ramp: ["#141414", "#3a3a3a", "#6b6b6b", "#9e9e9e", "#d0d0d0", "#f4f1ea"], sky: "#f4f1ea" },
};

export const SAND_PALETTE_NAMES = Object.keys(SAND_PALETTES);

export function sandPalette(name) {
  return SAND_PALETTES[name] || SAND_PALETTES["Dune Sea"];
}

// n colors, dark to light
export function sandBandColors(name, n) {
  const { ramp } = sandPalette(name);
  const interp = d3.interpolateRgbBasis(ramp);
  return d3.range(n).map((k) => d3.color(interp(n === 1 ? 0.5 : k / (n - 1))).formatHex());
}
