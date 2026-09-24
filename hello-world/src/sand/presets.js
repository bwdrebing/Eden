// ------------------------------------------------------------------ //
//  Starting points
//
//  Whole scenes, one per kind of sand the studio is for. Each sets the
//  bedforms AND the camera, light and palette that show them off, because
//  the right view depends on the scale: a dune field wants a low eye and a
//  long lens, a patch of ripples wants to be looked straight down at from
//  a hand's height with the sun nearly on the horizon.
// ------------------------------------------------------------------ //
import { newFeature } from "./field";

const f = (type, id, patch) => ({ ...newFeature(type, id), ...patch });

export const SAND_PRESETS = [
  {
    name: "Dune sea",
    scene: {
      features: [
        f("dunes", 1, { lambda: 48, amp: 5, dir: 95, wander: 0.5, asym: 0.75, breakup: 0.15 }),
        f("wind", 2, { lambda: 0.14, amp: 0.009, dir: 95 }),
      ],
      view: "perspective", camX: 0, camY: 0, camHeight: 14, heading: 0, horizon: 0.3, focal: 70,
      sunAz: 260, sunEl: 10, shadows: true, ambient: 0.22, haze: 0.35,
      palette: "Dune Sea", bands: 6, balance: 0, colorBy: "light", style: "fill",
    },
  },
  {
    name: "Scattered dunes",
    scene: {
      features: [
        f("dunes", 1, { lambda: 70, amp: 6, dir: 100, wander: 0.35, asym: 0.8, breakup: 0.85 }),
      ],
      view: "plan", camX: 0, camY: 0, planWidth: 420,
      sunAz: 230, sunEl: 22, shadows: true, ambient: 0.25, haze: 0,
      palette: "Namib", bands: 5, balance: 0, colorBy: "light", style: "fill",
    },
  },
  {
    name: "Wind ripples",
    scene: {
      features: [f("wind", 1, { lambda: 0.11, amp: 0.008, dir: 60, wander: 0.35, defects: 0.55 })],
      view: "plan", camX: 0, camY: 0, planWidth: 2.4,
      sunAz: 235, sunEl: 16, shadows: true, ambient: 0.2, haze: 0,
      palette: "White Sands", bands: 5, balance: 0, colorBy: "light", style: "fill",
    },
  },
  {
    name: "Tidal ripples",
    scene: {
      features: [f("current", 1, { lambda: 0.16, amp: 0.018, dir: 95, wander: 0.45, tongues: 0.7 })],
      view: "plan", camX: 0, camY: 0, planWidth: 2.2,
      sunAz: 200, sunEl: 22, shadows: true, ambient: 0.25, haze: 0,
      palette: "Tidal Flat", bands: 6, balance: 0, colorBy: "light", style: "fill",
    },
  },
  {
    name: "Backwash rills",
    scene: {
      features: [
        f("rills", 1, { lambda: 0.45, amp: 0.025, dir: 180, wander: 0.6, stretch: 5, braid: 0.7 }),
      ],
      view: "plan", camX: 0, camY: 0, planWidth: 4,
      sunAz: 260, sunEl: 24, shadows: true, ambient: 0.3, haze: 0,
      palette: "Tidal Flat", bands: 5, balance: 0.2, colorBy: "light", style: "fill",
    },
  },
  {
    name: "Low tide",
    scene: {
      features: [
        f("current", 1, { lambda: 0.2, amp: 0.02, dir: 85, wander: 0.5, tongues: 0.45 }),
        f("rills", 2, { lambda: 1.2, amp: 0.03, dir: 175, wander: 0.5, stretch: 6, braid: 0.5 }),
      ],
      view: "perspective", camX: 0, camY: 0, camHeight: 1.4, heading: 0, horizon: 0.24, focal: 35,
      sunAz: 250, sunEl: 10, shadows: true, ambient: 0.3, haze: 0.3,
      palette: "Tidal Flat", bands: 6, balance: 0, colorBy: "light", style: "fill",
    },
  },
  {
    name: "Topo lines",
    scene: {
      features: [
        f("dunes", 1, { lambda: 60, amp: 6, dir: 80, wander: 0.55, asym: 0.7, breakup: 0.35 }),
      ],
      view: "plan", camX: 0, camY: 0, planWidth: 300,
      sunAz: 250, sunEl: 30, shadows: false, ambient: 0.25, haze: 0,
      palette: "Ink", bands: 14, balance: 0, colorBy: "height", style: "lines",
    },
  },
];
