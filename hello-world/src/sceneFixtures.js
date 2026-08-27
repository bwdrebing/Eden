// ------------------------------------------------------------------ //
//  Scene fixtures
//
//  Real saved scenes, kept in the repo so a change can be tried against
//  something a person actually made rather than a scene invented to suit the
//  change. GRAZING_RIPPLES is the one that surfaced the export-edge work: a
//  44° camera zoomed 22.8× over a 90-unit plane, six painted 1D bands, the
//  sample grid and the 3D detail both at max. The far half of that frame is
//  where every edge artifact this renderer has shows up first.
//
//  Shareable form of the same scene (paste into the studio):
//  https://bwdrebing.github.io/Eden/?s=eyJyZWZsZWN0aW9uIjp7InN0ZWVwIjowLjgxLCJwaXRjaERlZyI6NDQsInJvbGxEZWciOjAsImZyZXNPbiI6ZmFsc2UsImZyZXNCYW5kcyI6MywiZnJlc1N0cmVuZ3RoIjowLjc1LCJkZWVwQ29sb3IiOiIjMDgxMzFkIiwid2F2ZWxlbmd0aCI6MS44LCJzdHJlbmd0aCI6MC4zOCwic2hhcnAiOjAsInNwcmVhZCI6MC4yNSwiYmFuZHMiOjMsInBhbGV0dGUiOiJUcmVlbGluZSIsInBlcnNwZWN0aXZlIjp0cnVlLCJyZWN0T3V0cHV0IjpmYWxzZSwic3VyZmFjZTNkIjp0cnVlLCJ3YXZlU2NhbGUiOjguNTUsImVkZ2VzIjpmYWxzZSwiYW5pbWF0ZSI6ZmFsc2UsInNwZWVkIjowLjUsInF1YWxpdHkiOjIyMCwibWFudWFsVGltZSI6MTcuMTUsImxvd1Bvd2VyIjpmYWxzZSwicmFzdGVyUSI6NSwiZXhwb3J0USI6MiwiYWR2YW5jZWQiOnRydWUsImVtaXR0ZXJzIjpbeyJpZCI6MSwib24iOnRydWUsInR5cGUiOiJyaW5ncyIsIngiOjAsInkiOjIwLCJkaXIiOjY1LCJzaXplIjoyLjgsImFtcCI6MSwic3ByZWFkIjoyNSwicm91Z2huZXNzIjowLCJkZXRhaWwiOjh9LHsiaWQiOjIsIm9uIjp0cnVlLCJ0eXBlIjoic3BlY3RydW0iLCJ4IjowLCJ5IjoyMCwiZGlyIjoxMjUsInNpemUiOjEuNSwiYW1wIjoxLjEsInNwcmVhZCI6NTksInJvdWdobmVzcyI6MC4xLCJkZXRhaWwiOjE1fSx7ImlkIjozLCJvbiI6dHJ1ZSwidHlwZSI6InNwZWN0cnVtIiwieCI6MCwieSI6MjAsImRpciI6OTAsInNpemUiOjEuNywiYW1wIjoxLjksInNwcmVhZCI6MTcsInJvdWdobmVzcyI6MC4xNSwiZGV0YWlsIjoxOX1dLCJoYWxmVyI6NDAsInlOZWFyIjo1LjUsInlGYXIiOjkwLCJyZWZsTWFnIjowLjUsIm9iamVjdHMiOltdLCJvYmpPbiI6ZmFsc2UsIm9ialgiOjAsIm9ialkiOjE0LCJvYmpTaXplIjoxLjIsIm9ialN1YiI6MC41LCJvYmpSaXBwbGUiOjAuOSwib2JqUmlwcGxlU2NhbGUiOjAuOCwib2JqQmFuZHMiOjUsIm9iakxpZ2h0IjozMjUsImVMbyI6NiwiZUhpIjoxNSwiYXV0b0ZpdCI6ZmFsc2UsInBlbk1vZGUiOmZhbHNlLCJwZW5Db3VudCI6NDgsInBlblJlbGllZiI6NDUsInBlbldpZHRoIjoxLjQsInBlbkhpZGRlbiI6dHJ1ZSwicGVuU3R5bGUiOiJsaW5lcyIsInBlblNwYWNpbmciOjcsInBlbkV2ZW4iOmZhbHNlLCJiZ0NvbG9yIjoiIiwiem9vbSI6MjIuOCwicGFuWCI6MC40NDQ2MTkyMjg1MjU5OTk1NSwicGFuWSI6MS4xNzc5MjU5MzU0MzA2NjI2LCJzbW9vdGgiOjMsIm1vZGUiOiJwYWludDFkIiwiZW52Q29sb3JzIjpbIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiNmZmZmZmYiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiI2ZmZmZmZiIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiI2ZmZmZmZiIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjY2ZlMWVmIiwiI2ZmZmZmZiIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiNjZmUxZWYiLCIjY2ZlMWVmIiwiIzNmNWY5MyIsIiMyNzQwNmIiLCIjMjc0MDZiIiwiIzI3NDA2YiIsIiMyNzQwNmIiLCIjMjc0MDZiIiwiIzI3NDA2YiIsIiMzZjVmOTMiLCIjM2Y1ZjkzIiwiIzNmNWY5MyIsIiMyNzQwNmIiLCIjMjc0MDZiIiwiIzI3NDA2YiIsIiMxNDFkMzMiLCIjMTQxZDMzIiwiIzE0MWQzMyIsIiMxNDFkMzMiLCIjMTQxZDMzIiwiIzE0MWQzMyIsIiMxNDFkMzMiXSwiYXpTcGFuIjo0MCwiY29oZXJlbmNlIjowLCJhY3RpdmVDb2xvciI6IiM5Y2MzZTgiLCJicnVzaFNpemUiOjEsImJydXNoU2hhcGUiOiJyb3VuZCJ9fQ
//
//  `buildScene` mirrors how the component assembles S and fieldSpec from
//  saved settings. It is a copy of that assembly, not the assembly itself, so
//  if the component starts deriving S differently this needs the same edit —
//  the fixture test will keep rendering, just not the scene you meant.
// ------------------------------------------------------------------ //
import { reflectAt, buildGeometry, computeFit, withWakes } from "./WaterReflectionContours";

export const GRAZING_RIPPLES = {
    "steep": 0.81,
    "pitchDeg": 44,
    "rollDeg": 0,
    "fresOn": false,
    "fresBands": 3,
    "fresStrength": 0.75,
    "deepColor": "#08131d",
    "wavelength": 1.8,
    "strength": 0.38,
    "sharp": 0,
    "spread": 0.25,
    "bands": 3,
    "palette": "Treeline",
    "perspective": true,
    "rectOutput": false,
    "surface3d": true,
    "waveScale": 8.55,
    "edges": false,
    "animate": false,
    "speed": 0.5,
    "quality": 220,
    "manualTime": 17.15,
    "lowPower": false,
    "rasterQ": 5,
    "exportQ": 2,
    "advanced": true,
    "emitters": [
      {
        "id": 1,
        "on": true,
        "type": "rings",
        "x": 0,
        "y": 20,
        "dir": 65,
        "size": 2.8,
        "amp": 1,
        "spread": 25,
        "roughness": 0,
        "detail": 8
      },
      {
        "id": 2,
        "on": true,
        "type": "spectrum",
        "x": 0,
        "y": 20,
        "dir": 125,
        "size": 1.5,
        "amp": 1.1,
        "spread": 59,
        "roughness": 0.1,
        "detail": 15
      },
      {
        "id": 3,
        "on": true,
        "type": "spectrum",
        "x": 0,
        "y": 20,
        "dir": 90,
        "size": 1.7,
        "amp": 1.9,
        "spread": 17,
        "roughness": 0.15,
        "detail": 19
      }
    ],
    "halfW": 40,
    "yNear": 5.5,
    "yFar": 90,
    "reflMag": 0.5,
    "objects": [],
    "objOn": false,
    "objX": 0,
    "objY": 14,
    "objSize": 1.2,
    "objSub": 0.5,
    "objRipple": 0.9,
    "objRippleScale": 0.8,
    "objBands": 5,
    "objLight": 325,
    "eLo": 6,
    "eHi": 15,
    "autoFit": false,
    "penMode": false,
    "penCount": 48,
    "penRelief": 45,
    "penWidth": 1.4,
    "penHidden": true,
    "penStyle": "lines",
    "penSpacing": 7,
    "penEven": false,
    "bgColor": "",
    "zoom": 22.8,
    "panX": 0.44461922852599955,
    "panY": 1.1779259354306626,
    "smooth": 3,
    "mode": "paint1d",
    "envColors": [
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#ffffff",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#cfe1ef",
      "#ffffff",
      "#ffffff",
      "#ffffff",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#9cc3e8",
      "#cfe1ef",
      "#cfe1ef",
      "#3f5f93",
      "#27406b",
      "#27406b",
      "#27406b",
      "#27406b",
      "#27406b",
      "#27406b",
      "#3f5f93",
      "#3f5f93",
      "#3f5f93",
      "#27406b",
      "#27406b",
      "#27406b",
      "#141d33",
      "#141d33",
      "#141d33",
      "#141d33",
      "#141d33",
      "#141d33",
      "#141d33"
    ],
    "azSpan": 40,
    "coherence": 0,
    "activeColor": "#9cc3e8",
    "brushSize": 1,
    "brushShape": "round"
  };

// the component's envRuns: a painted 1D strip collapses to its color runs
function envRuns(envColors) {
  const colors = [], fracs = [];
  const n = envColors.length;
  for (let i = 0; i < n; i++) {
    if (i === 0 || envColors[i] !== envColors[i - 1]) {
      colors.push(envColors[i]);
      if (i > 0) fracs.push(i / n);
    }
  }
  return { colors, fracs };
}

// settings -> { S, fit, fieldSpec } ready for buildSolid3D. 1D/preset scenes
// only: a paint2d scene needs the panorama spec (uvAt/env2d) instead.
export function buildScene(settings) {
  const g = settings;
  const runs = envRuns(g.envColors);
  const S = {
    nx: g.quality, ny: g.quality,
    xMin: -g.halfW, xMax: g.halfW,
    yMin: Math.min(g.yNear, g.yFar - 2), yMax: g.yFar,
    H: 0.4 * Math.pow(22.5, g.steep),
    pitch: (g.pitchDeg * Math.PI) / 180,
    k: (2 * Math.PI) / g.wavelength,
    amp: g.strength * 0.06,
    sharp: g.sharp,
    decay: 0.18 - g.spread * 0.16,
    omega: 1.0, t: g.manualTime,
    bands: g.bands, perspective: g.perspective, eLo: g.eLo, eHi: g.eHi,
    zoom: g.zoom, panX: g.panX, panY: g.panY, smooth: g.smooth,
    coherence: g.coherence, rectOutput: g.rectOutput,
    surface3d: g.surface3d, waveScale: g.waveScale,
    bandFractions: runs.fracs,
    fresOn: g.fresOn, fresBands: g.fresBands, reflMag: g.reflMag,
    emitters: withWakes(g.emitters, g.wakes),
  };
  const fit = computeFit(S);
  buildGeometry(S);                         // prepares S._ems from the emitters
  const scalarAt = (gx, gy) =>
    (Math.asin(Math.max(-1, Math.min(1, reflectAt(gx, gy, S)[2]))) * 180) / Math.PI;
  const mid = (S.eLo + S.eHi) / 2, magSpan = (S.eHi - S.eLo) / (S.reflMag || 1);
  const bnd = (f) => mid + (f - 0.5) * magSpan;
  return {
    S, fit,
    fieldSpec: { scalarAt, thresholds: runs.fracs.map(bnd), cols: runs.colors },
  };
}
