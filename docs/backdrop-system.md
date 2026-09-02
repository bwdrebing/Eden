# Backdrop system: critique and rearchitecture

Status: proposal. Nothing here is implemented yet.
Scope: everything that answers the question *what does the water reflect?* —
the `preset` / `paint1d` / `paint2d` modes, the reflected-objects catalogue, and
the elevation/azimuth controls that give them meaning.

---

## 1. What is there today

The backdrop is three unrelated representations behind one `mode` enum
(`WaterReflectionContours.jsx:3518`):

| mode | representation | where |
|---|---|---|
| `preset` | a named palette sampled by elevation | `paletteColorAt`, `bandColors` |
| `paint1d` | `envColors`: 64 hex strings, horizon → zenith | `ENV_N`, `PaintStrip` |
| `paint2d` | `env2d`: `{w:84, h:52, cells:[hex]}` | `ENV2D_W/H`, `PaintGrid2D` |

Plus a fourth, parallel system: **objects** (`sailboat`, `dock`, `buoy`, `post`)
that are stamped destructively into a copy of the panorama by `stampObjects`
(`:2309`), max four, from a hardcoded catalogue of shape functions (`:2268`).

The renderer's actual contract with all of this is narrow, and it is already
well drawn in `panoramaStack` / `eachPanoramaLayer` (`:2455`, `:2480`):

> Give me an ordered list of K regions, each with a colour and a signed-distance
> field in some sampling space, plus a way to turn a water sample's reflected ray
> into a coordinate in that space. I will contour the composed field at zero.

Today all four inputs are forced into one shape to satisfy that contract: an
84×52 grid of hex strings indexed by (azimuth, elevation).

---

## 2. The core defect

**The document you edit and the buffer the renderer samples are the same
array.** Every complaint follows from that identity:

- *No layers, no undo, no "move what I just placed".* `PaintGrid2D.paintAt`
  (`:3174`) writes `activeColor` straight into `prev.cells`. The previous colour
  is gone the instant the pointer moves; there is no history anywhere in the file.
- *No shapes, no vectors.* The document is pixels, at the resolution the
  sampler wants — 84 cells across the whole ±45° panorama. The brush radii are
  1 / 4 / 8 / 14 cells (`:3148`), so the "L" brush is a third of the sky. A mast,
  a piling, a tree trunk are not expressible.
- *No depth.* A direction map indexed by (azimuth, elevation) has no depth by
  construction. Everything is at infinity, so nothing has parallax and nothing
  occludes anything.
- *No repeater.* A generator has nowhere to live. Any rule you have in your head
  ("two blue rows, one white row, repeat") can only be baked into pixels by hand.
- *Region identity is the hex string.* Two regions painted the same blue fuse
  into one. `tweakHex` (`:2300`) exists purely to work around this — it nudges an
  object's colour by a few low bits so instances don't merge.
- *Stacking order is a heuristic.* `panoramaStack` orders regions by the mean
  painted row of each colour (`:2468`). It is not authorable and it is not
  stable: repaint a colour somewhere else and its z-order moves.

### Other sharp edges, found by reading and by driving the studio

1. **The mode buttons destroy work.** `enter1d` (`:3604`) and `enter2d`
   (`:3643`) unconditionally reseed the buffer from the current palette. Clicking
   "Paint 2D" while already in Paint 2D wipes the panorama. There is no
   confirmation and no undo.
2. **A painted panorama cannot be saved or shared.** `env2d` is absent from the
   `useUrlSync` field list (`:3564`–`:3602`) — `envColors` is there, `env2d` is
   not. Reload the tab and the 2D backdrop is gone. This is the single largest
   hazard in the current system.
3. **The paint canvas lies about shape.** It is drawn at aspect `84/52 = 1.62`
   (`:3193`) but represents `2·azSpan × (eHi − eLo)` degrees — at the defaults,
   90° × 38°, aspect 2.37. A circle you paint is a 1.5:1 ellipse in the world.
   Worse, moving `azSpan` or the elevation window rescales what the pixels *mean*
   without touching the pixels.
4. **The controls that give the canvas its units live in another panel.**
   `eLo` / `eHi` are sliders inside Advanced → "Range & quality" (`:4987`), three
   panels below the paint grid, with no visual link. `azSpan` is rendered twice
   with two different labels — "azimuth span (panorama width)" (`:4678`) and
   "azimuth span (reflection width)" (`:4763`). This is why the elevation sliders
   feel unreadable: nothing on screen shows the window they define.
5. **Content outside the window silently smears.** `buildSegmentation` clamps
   the reflected elevation to `[0,1]` before sampling (`:2553`), so anything you
   paint above `eHi` is replaced by an infinite extrusion of the top row.
6. **"Smooth colors" is a cliff.** `smoothEnv2D` (`:2358`) blends RGB across the
   whole grid, which can push the distinct-colour count past `SEG_MAX_COLORS`
   = 160 (`:2451`). Past that the renderer silently switches from the smooth
   per-colour SDF path to the row/column compositing fallback (`:2618`) — a
   different look, with no indication that it happened.
7. **You cannot see what the water sees.** `EnvPreview` is only rendered when an
   object is switched on (`:4759`). In plain `paint2d` there is no reflected
   preview at all.
8. **The water lags the brush.** Two sources of truth, `env2d` (live canvas) and
   `segEnv` (committed copy), with the commit on `pointerup` (`:3527`, `:4611`).
9. **Modes are mutually exclusive.** You cannot have a preset sky with a painted
   shoreline in front of it; picking a palette throws away the paint.

---

## 3. The through line

One idea covers every request:

> **A backdrop is an ordered stack of *flats*. A flat is content (regions with
> colours) placed on a surface at a distance. The renderer only ever asks a flat
> one question: given a ray, where does it hit me, and how far is that point
> from the nearest edge of the region it lands in?**

"Flat" as in a stage flat — a painted board standing at a known distance from
the audience. The sky is the flat at infinity.

Four things generalise, and each one is exactly one of the asks:

| Generalise | Today | Proposed | Answers |
|---|---|---|---|
| **Order** | mean painted row | explicit layer order | layers, hide/show, reorder |
| **Content** | hex per cell | vector regions, procedural rules, or pixels | shapes, repeater |
| **Placement** | always at infinity | sphere at infinity **or** a vertical plane at distance *D* | depth |
| **Ray source** | the reflected ray | reflected ray **or** the direct view ray | backdrop visible in the render |

The existing preset / 1D / 2D / objects modes stop being four systems and become
four kinds of content on one stack:

- a **preset palette** → one sky flat with `ramp` content
- the **1D strip** → one sky flat with `stripes` content (a repeater with each
  band's size set by hand — the repeater *is* the generalised 1D strip)
- the **2D panorama** → one sky flat with `raster` content
- a **sailboat / dock** → a `shapes` flat at a distance

### Geometry

For a water sample at ground point `P = (gx, gy, 0)` with reflected direction
`R = (Rx, Ry, Rz)` (`reflectAt`, `:496`, already returns exactly this):

**Sky flat** (the current behaviour, unchanged):

```
u = atan2(Rx, Ry)   // azimuth, degrees
v = asin(Rz)        // elevation, degrees
```

**Plane flat** at distance `D` (a vertical plane `y = D`, facing the camera):

```
t = (D - gy) / Ry              // hit only if Ry > 0 and t > 0
u = gx + t·Rx                  // world units across
v = t·Rz                       // world units above the waterline
```

Both are "(across, up)"; the only difference is units — degrees for the sky,
world units for a flat. `t ≤ 0` means the ray never reaches that plane, which is
the physically correct statement that water 40 units out does not reflect a dock
8 units away. That falloff *is* the depth cue.

The same function serves the direct view ray from the camera, which is what puts
the backdrop on screen (§5.5).

### Compositing

Two rules, and the second one is why this is cheap:

- **Within a flat**, regions are disjoint, so keep the existing construction
  exactly: walk the flat's regions top-down building cumulative unions
  (`eachPanoramaLayer`), so each region's field solidly contains the next. This
  is what prevents background seams and it is already correct.
- **Across flats**, paint far → near with each flat drawn *complete*. No holes
  are cut, so there is no seam to open. Plain painter's algorithm.

This matters: cross-flat occlusion needs no field arithmetic between different
coordinate spaces. Each flat is compiled and contoured in its own space and the
SVG draw order does the rest — the same way the current layer stack is emitted
(`buildSvg`, `:4018`).

---

## 4. Data model

```js
// the whole backdrop, serialisable, small
{
  version: 2,
  sky: { azSpan: 45, eLo: -5, eHi: 33 },   // the sky flat's window, in degrees
  flats: [                                  // far → near
    {
      id: "f1", name: "Sky", visible: true, locked: false,
      place: { kind: "sky" },               // or { kind:"plane", distance: 8 }
      soften: 0,                            // edge blur, in flat units
      content: { ... }                      // one of the kinds below
    },
    ...
  ]
}
```

Content kinds, all producing the same thing — an ordered list of
`{ color, geometry }`:

```js
{ kind: "ramp",    palette: "Treeline", from: 0, to: 1 }
{ kind: "stripes", axis: "up", anchor: 0, repeat: true,
                   bands: [ {color:"#9cc3e8", size:2}, {color:"#ffffff", size:1} ] }
{ kind: "shapes",  items: [ {type:"rect"|"ellipse"|"poly"|"path", color, ...} ] }
{ kind: "raster",  w, h, palette:[hex], cells: Uint8Array }   // freehand, RLE'd in the URL
{ kind: "photo",   ... }                                       // existing extractor, per flat
```

Notes:

- `stripes` with `repeat: true` and `bands: [blue 2, blue 2, white 1]` is the
  requested repeater. With `repeat: false` and one band per run it is exactly
  today's `envRuns` output, which is how `paint1d` migrates losslessly.
- `raster` stores palette indices, not hex strings. 84×52 with 8 colours
  RLE-encodes to a few hundred bytes, so **a painted backdrop becomes shareable
  in the URL for the first time**.
- `soften` replaces the destructive `smoothEnv2D` button: a blur applied to the
  compiled SDF, per flat, non-destructive, and it cannot inflate the colour
  count past `SEG_MAX_COLORS`.

### Undo

Documents are small and immutable-by-convention, so undo is a snapshot ring, not
a command log: push the previous document on every committed edit, cap at ~50,
`Cmd/Ctrl+Z` and `Shift+Cmd/Ctrl+Z`. Freehand strokes commit on `pointerup`
(where `segEnv` already commits today), so a stroke is one undo step.

### Compiler

```js
compileBackdrop(doc) -> {
  regions: [ { color, flatId, order, space, sdf } ],   // far → near, then within-flat order
  hitAt(flat, ray, P) -> [u, v] | null,
  budget: { regions, max: SEG_MAX_COLORS }
}
```

Compilation is memoised on the document and is independent of the wave phase, so
it runs once per edit — never per frame, and `frameAt` (video export) reuses it.
Vector content is scanline-rasterised into the flat's own grid at 4–8× the
current panorama resolution before the distance transform; the SDF is sampled
bilinearly, exactly as now, so higher content resolution costs memory, not
contour time.

---

## 5. Plan

Each phase is independently shippable and independently revertible. Every phase
that touches the contouring input carries the same gate, per `CLAUDE.md`:
run `src/sceneFixture.test.js`, then render **GRAZING_RIPPLES** at
`RASTER_LEVELS[5]`, write the layers to `.svg`, and *look at the top of the
frame at 8–24×* against the same crop before the change.

### Phase 0 — stop the bleeding (~1 day, no new architecture)

The acute pain, fixed where the code stands today.

1. Mode buttons switch modes and nothing else; reseeding moves to the existing
   explicit "Reset to {palette}" buttons.
2. Undo/redo ring over `envColors` and `env2d`, committed on stroke end.
3. `env2d` into the URL as palette-index RLE, with a size guard.
4. Move `eLo` / `eHi` / `azSpan` next to the paint canvas; delete the duplicate
   `azSpan` slider; put degree ticks down the side of the canvas and shade the
   band the water can actually reach.
5. Show `EnvPreview` in both paint modes, not only when an object is on.

### Phase 1 — document and compiler, no UI change (~3–4 days)

New `src/backdrop/`: `document.js`, `compile.js`, `rasterize.js`, `place.js`.
Represent today's three modes as documents; `buildSegmentation` and
`buildSurface3DPanorama` consume compiled regions instead of `env2d`. The
existing UI writes documents through a thin adapter.

Exit criteria: legacy `?s=` URLs — the fixture URL in `CLAUDE.md` above all —
open **byte-identical geometry**, proven by a parity test that diffs the emitted
path data against the pre-change builder.

### Phase 2 — the backdrop in the viewport (~1–2 days)

Pulled ahead of the editor deliberately: it is cheap once Phase 1 lands, and it
is the thing that makes every later phase authorable. You cannot tune an
elevation window you cannot see.

`computeFit` gains optional sky headroom (the horizon sits at
`ry = −tan(pitch)`, above the water plane's far edge — currently just out of
frame). Screen points above it are inverted to view rays and the same compiled
flats are contoured through them, so the sky is drawn as flat vector regions in
the same idiom as the water, not as a bitmap. Toggle: **Show backdrop**.

### Phase 3 — layers and the repeater (~4–5 days)

The layers panel: add / duplicate / delete, eye toggle, drag to reorder, per-flat
opacity-free compositing. Document-level undo replaces the Phase 0 ring. `ramp`,
`stripes` and `raster` content editors, with the stripes editor being the
repeater — band list, sizes in degrees, repeat toggle, anchor.

### Phase 4 — vector shapes (~5–6 days)

`shapes` content: rect, ellipse, polygon, freehand path. Click to select, drag to
move, handles to resize — the "move the thing I just placed" ask. The four
hardcoded objects become shape presets on a flat, `stampObjects` and `tweakHex`
are deleted, and the four-object cap goes with them.

### Phase 5 — depth (~4–5 days)

`place: { kind: "plane", distance }`. Ray/plane intersection in `place.js`,
far→near draw order, and a small top-down plan strip showing the camera, the
water plane, and each flat's distance as a draggable tick. Sizes on a plane flat
are in world units, so "a dock 12 units wide at 8 units out" is finally a thing
you can type.

### Phase 6 — polish

Per-flat `soften` retires "Smooth colors"; photo import targets a flat; a small
library of starter documents (open water, treeline, harbour); region-budget
readout in the panel.

---

## 6. Risks

- **Fidelity regression on the fixture scene.** The mitigation is the gate above,
  on every phase, plus the Phase 1 parity test. This is the risk that matters.
- **Region budget.** `SEG_MAX_COLORS` = 160 becomes a total across flats. Shapes
  make it much easier to spend, so the panel must show the count and the
  fallback path must be a visible, explained state rather than a silent switch.
- **The file convention.** `CLAUDE.md` says nearly everything lives in
  `WaterReflectionContours.jsx`. This proposal deliberately departs: the document
  model, compiler and editor are ~1500 lines with no coupling to the wave maths
  beyond the ray contract, and they need their own tests. The renderer file keeps
  the rendering.
- **Every downstream consumer reads the panorama.** `buildSurface3DPanorama`,
  the paper stack, the pen paths and `frameAt` all take `env2d` today. Phase 1 is
  not done until all of them take compiled regions — a partial migration would
  leave the video export or the paper export drawing a different backdrop from
  the preview.
- **Plane flats and the 3D surface.** With `surface3d` on, the reflected ray
  originates from the lifted wave surface, not `z = 0`. The plane intersection
  must use the surface point, or near flats will swim against the waves. Worth a
  targeted test in Phase 5.
