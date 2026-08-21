# Eden

A React studio (`hello-world/`) that renders stylized water: a reflected color
environment contoured into flat regions, optionally lifted onto a 3D wave
surface, and exported as SVG or as a cuttable layered-paper stack. Nearly all of
it lives in one file, `hello-world/src/WaterReflectionContours.jsx`, whose
comments carry the reasoning behind each stage — read the comment above a
function before changing it.

## Commands

Run from `hello-world/`:

```
npm test                  # jest + @testing-library, CI=true to run once
npm start                 # dev server
npm run build             # production build; CI=true treats warnings as errors
```

`CI=true npm run build` currently fails on one pre-existing
`react-hooks/exhaustive-deps` warning on `main`. That is expected — check a
change only adds no *new* warnings.

## Test any rendering change against the saved scene

`hello-world/src/sceneFixtures.js` holds **GRAZING_RIPPLES**, a real saved
scene, with `buildScene()` to turn it into the `S` / `fieldSpec` pair the
builders take. Open it in the studio here:

https://bwdrebing.github.io/Eden/?s=eyJyZWZsZWN0aW9uIjp7InN0ZWVwIjowLjgxLCJwaXRjaERlZyI6NDQsInJvbGxEZWciOjAsImZyZXNPbiI6ZmFsc2UsImZyZXNCYW5kcyI6MywiZnJlc1N0cmVuZ3RoIjowLjc1LCJkZWVwQ29sb3IiOiIjMDgxMzFkIiwid2F2ZWxlbmd0aCI6MS44LCJzdHJlbmd0aCI6MC4zOCwic2hhcnAiOjAsInNwcmVhZCI6MC4yNSwiYmFuZHMiOjMsInBhbGV0dGUiOiJUcmVlbGluZSIsInBlcnNwZWN0aXZlIjp0cnVlLCJyZWN0T3V0cHV0IjpmYWxzZSwic3VyZmFjZTNkIjp0cnVlLCJ3YXZlU2NhbGUiOjguNTUsImVkZ2VzIjpmYWxzZSwiYW5pbWF0ZSI6ZmFsc2UsInNwZWVkIjowLjUsInF1YWxpdHkiOjIyMCwibWFudWFsVGltZSI6MTcuMTUsImxvd1Bvd2VyIjpmYWxzZSwicmFzdGVyUSI6NSwiZXhwb3J0USI6MiwiYWR2YW5jZWQiOnRydWUsImVtaXR0ZXJzIjpbeyJpZCI6MSwib24iOnRydWUsInR5cGUiOiJyaW5ncyIsIngiOjAsInkiOjIwLCJkaXIiOjY1LCJzaXplIjoyLjgsImFtcCI6MSwic3ByZWFkIjoyNSwicm91Z2huZXNzIjowLCJkZXRhaWwiOjh9LHsiaWQiOjIsIm9uIjp0cnVlLCJ0eXBlIjoic3BlY3RydW0iLCJ4IjowLCJ5IjoyMCwiZGlyIjoxMjUsInNpemUiOjEuNSwiYW1wIjoxLjEsInNwcmVhZCI6NTksInJvdWdobmVzcyI6MC4xLCJkZXRhaWwiOjE1fSx7ImlkIjozLCJvbiI6dHJ1ZSwidHlwZSI6InNwZWN0cnVtIiwieCI6MCwieSI6MjAsImRpciI6OTAsInNpemUiOjEuNywiYW1wIjoxLjksInNwcmVhZCI6MTcsInJvdWdobmVzcyI6MC4xNSwiZGV0YWlsIjoxOX1dLCJoYWxmVyI6NDAsInlOZWFyIjo1LjUsInlGYXIiOjkwLCJyZWZsTWFnIjowLjUsIm9iamVjdHMiOltdLCJvYmpPbiI6ZmFsc2UsIm9ialgiOjAsIm9ialkiOjE0LCJvYmpTaXplIjoxLjIsIm9ialN1YiI6MC41LCJvYmpSaXBwbGUiOjAuOSwib2JqUmlwcGxlU2NhbGUiOjAuOCwib2JqQmFuZHMiOjUsIm9iakxpZ2h0IjozMjUsImVMbyI6NiwiZUhpIjoxNSwiYXV0b0ZpdCI6ZmFsc2UsInBlbk1vZGUiOmZhbHNlLCJwZW5Db3VudCI6NDgsInBlblJlbGllZiI6NDUsInBlbldpZHRoIjoxLjQsInBlbkhpZGRlbiI6dHJ1ZSwicGVuU3R5bGUiOiJsaW5lcyIsInBlblNwYWNpbmciOjcsInBlbkV2ZW4iOmZhbHNlLCJiZ0NvbG9yIjoiIiwiem9vbSI6MjIuOCwicGFuWCI6MC40NDQ2MTkyMjg1MjU5OTk1NSwicGFuWSI6MS4xNzc5MjU5MzU0MzA2NjI2LCJzbW9vdGgiOjMsIm1vZGUiOiJwYWludDFkIiwiZW52Q29sb3JzIjpbIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiNmZmZmZmYiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiI2ZmZmZmZiIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiI2ZmZmZmZiIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjY2ZlMWVmIiwiI2ZmZmZmZiIsIiNmZmZmZmYiLCIjZmZmZmZmIiwiIzljYzNlOCIsIiM5Y2MzZTgiLCIjOWNjM2U4IiwiIzljYzNlOCIsIiNjZmUxZWYiLCIjY2ZlMWVmIiwiIzNmNWY5MyIsIiMyNzQwNmIiLCIjMjc0MDZiIiwiIzI3NDA2YiIsIiMyNzQwNmIiLCIjMjc0MDZiIiwiIzI3NDA2YiIsIiMzZjVmOTMiLCIjM2Y1ZjkzIiwiIzNmNWY5MyIsIiMyNzQwNmIiLCIjMjc0MDZiIiwiIzI3NDA2YiIsIiMxNDFkMzMiLCIjMTQxZDMzIiwiIzE0MWQzMyIsIiMxNDFkMzMiLCIjMTQxZDMzIiwiIzE0MWQzMyIsIiMxNDFkMzMiXSwiYXpTcGFuIjo0MCwiY29oZXJlbmNlIjowLCJhY3RpdmVDb2xvciI6IiM5Y2MzZTgiLCJicnVzaFNpemUiOjEsImJydXNoU2hhcGUiOiJyb3VuZCJ9fQ

It is a 44° camera zoomed 22.8× over a 90-unit plane, six painted 1D colors in
fourteen runs, sample grid and 3D surface detail both at max. **The far half of
that frame is where every edge artifact this renderer has shows up first** —
jagged region boundaries, crest-seam slivers, far-field speckle. A change that
looks fine on an invented test scene can still wreck this one.

So, for any change to the contouring, rasterizing, projection or export path:

1. Run `src/sceneFixture.test.js` — the smoke test over that scene.
2. **Look at it**, do not only assert on it. Render it at a real raster
   (`RASTER_LEVELS[5]`, plus whatever export step is in play), write the layers
   to an `.svg`, and open it — zoomed well past 1:1, into the top of the frame.
   Most of what matters here is only visible at 8–24× on a far edge, and no
   assertion in this repo catches it.
3. Compare before and after at the same crop. A change that trades detail for
   smoothness is a legitimate choice, but it must be a chosen one.

Chromium is available for that: it renders an SVG headlessly, and an `<img>`
scaled inside a fixed-size `<div>` gives a zoomed crop to screenshot.

## Things worth knowing before changing the renderer

- **The SVG export is the same geometry as the preview**, not a separate render
  — the export path may retrace at a wider raster, but it draws the same
  picture. Keep it that way: a file that does not match what was on screen is a
  bug, unless the user asked for it (the mesh and polish export steps do, and
  say so in their help text).
- **Two different limits control how fine an edge can be.** `BW` is the raster
  the regions are contoured on — how finely an outline is *drawn*. `gN` is the
  wave mesh — how much surface there is *to* draw. They are not
  interchangeable, and raising `gN` faster than `BW` makes distant edges worse,
  not better.
- **Smoothing that acts on the traced path cannot fix a jagged edge**; Chaikin
  already converges to the spline of that polyline. The field is where to act
  (see `smoothField`), before the topology is decided.
- The 1D/preset path and the 2D panorama path are separate builders
  (`buildSurface3D`, `buildSurface3DPanorama`) that must stay in step. A new
  option on one usually belongs on the other; `buildSolid3D` is where both are
  chosen from.
