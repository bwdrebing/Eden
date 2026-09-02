---
name: control-surface
description: >
  The rules for the studio's control panel (the workspace tabs in
  hello-world/src/WaterReflectionContours.jsx). Use this skill whenever a
  change adds, moves, renames, or removes a UI control — a slider, toggle,
  button, color well, panel, or tab — or when deciding where a new feature's
  settings should live, even if the feature itself is mostly renderer work
  that "just needs a slider or two". Also use it when reviewing a PR that
  touches the control column, and before answering any question about why a
  control lives where it does.
---

# The control surface

## Why this file exists

The control panel used to be one flat 320px column. Every feature appended a
panel, and by mid-2025 it was **7,240px tall — eight screens of scroll — with
~90 controls, one "advanced" fold, and three separate sliders bound to the
same `coherence` state** because duplicating a control was easier than
finding it. Users reported spending more time scrolling for a control than
using it.

The fix was the workspace architecture below. It only stays fixed if every
new control follows these rules. Each rule earns its place by pointing at a
specific way the old column went wrong.

## The architecture

The panel shows **one workspace at a time**, picked by a tab strip. A
workspace is a *user task*, not a renderer stage — its name answers the
question a user arrives with: "I want to change ___".

| Workspace | The user's intent | What lives there |
|---|---|---|
| `camera`  | …the view | height, pitch, roll, zoom, pan, framing presets, perspective, rectangular output |
| `waves`   | …the water's shape | ripple λ/strength/sharpness/spread, plane extent, emitters, 3D relief (wave height, crest gap) |
| `color`   | …what the water reflects | palettes, paint 1D/2D, photo import, reflection detail/width, Fresnel depth, background, elevation range |
| `objects` | …the things on the water | buoy, reflected shoreline objects, wakes |
| `style`   | …how it's drawn | fill vs pen-plot, pen styles, edge smoothing/ripple, region outlines |
| `output`  | …the file I get | SVG/PNG/MP4/paper exports and their quality steps, render quality, low power |

Two things deliberately live **outside** the tabs:

- **The transport** (play/pause, speed, time scrub) is docked under the
  preview, because it is touched constantly and belongs next to the picture
  it moves. It holds the scene's one clock: *speed* is that clock's rate and
  stays visible whether or not the preview is running, since it also sets how
  much water a second of exported video covers; the *scrub* is the clock's
  position and appears only while paused. Nothing else earns this spot
  without displacing something.
- **The find box** above the tab strip jumps to any control by name.

All of it is driven by the `WORKSPACES` registry at the top of the UI
section in `WaterReflectionContours.jsx` (search for `const WORKSPACES`).
The registry is the single source of truth for the tab strip *and* the find
index: `SEARCH_INDEX` is derived from each workspace's `find` list.

## Adding a control: the procedure

1. **Name the user's intent, not the implementation.** Ask "when someone
   reaches for this, what are they trying to change?" — not "which renderer
   function reads it". The old "Display" panel died of implementation-first
   grouping: it held camera, surface, quality and animation controls because
   the renderer consumed them in one place. If your answer is one of the six
   intents above, that's the workspace. It almost always is.

2. **Put it in that workspace's tab**, wrapped in the existing
   `{uiTab === "<id>" && ...}` block, next to the controls a user would
   adjust in the same session as yours.

3. **Add a `find` entry** to that workspace in `WORKSPACES`. Write it the
   way a user would type it, synonyms included — `"reflection width
   (azimuth span)"`, not `azSpan`. A control that isn't in the find index
   effectively doesn't exist for anyone who doesn't already know the layout.

4. **If the control's state already has a control somewhere else, stop.**
   One state, one control, one home. Where users will look for it in a
   second place, put a `<JumpNote>` that jumps to the real one (see the
   edge-ripple notes for the pattern). The old column exposed `coherence`
   in three places styled as three local sliders; users tuned one and
   silently changed the "other two".

5. **Long explanation goes in a `<Help>`**, not an inline paragraph. Keep at
   most ~2 lines of always-visible caption; everything else behind the ⓘ.
   The prose itself is valued — write it well — but permanent inline help
   was ~30% of the old column's height, paid on every visit after the first
   read.

6. **Serialize it.** Add the state to the `useUrlSync("reflection", ...)`
   map so scenes round-trip through the URL. (Removed keys are simply
   ignored when old URLs load — `useUrlSync` only applies fields it knows —
   so renames are safe but should still be rare.)

## Workspace vs. section within a workspace

Default hard to "section". A new **section** (a `panel` block with a
`heading` inside an existing tab) is the right call when the controls serve
one sub-decision of an existing intent — "3D relief" is a section of Waves,
not a workspace, because nobody opens the app thinking "I want to change
the relief" apart from changing the waves.

A new **workspace** must clear all three bars:

- **It's a distinct intent**: a user would say "I want to change ___" where
  the blank fits none of the six existing tabs, even loosely.
- **It's visited independently**: someone would open it without also
  touching a neighboring tab in the same breath. (If every visit to it is
  part of a Waves session, it's a Waves section.)
- **It has the weight**: at least two sections' worth of controls. A
  workspace with three sliders is a section wearing a tab's clothes, and
  every added tab shrinks all the others' labels.

If a *section* is genuinely expert-only, put it last in its tab and give it
a `<Help>` explaining when to reach for it — do not invent a new "advanced"
fold. The old single "advanced" fold ended up hiding the emitters (the most
creative tool in the app) next to sample-grid quality settings, purely by
accretion order.

## The budget: keeping tabs one screen tall

The contract that prevents the scrolling nightmare from regrowing:

- **A tab in its default state fits one screen** — ≤ ~900px at 1440×900
  with a fresh scene. Measure before merging (see checklist). If your
  control pushes its tab over, something in that tab moves behind a
  `<Help>`, becomes conditional on its parent toggle, or the tab's content
  is renegotiated — the budget doesn't grow to fit.
- **Only user data may exceed the budget.** Instance lists (emitters,
  wakes, objects) grow because the *user* added cards; that's their
  choice, not the default cost. Never ship a default scene that opens with
  a tab over budget. (If cards proliferate further, collapsible cards are
  the sanctioned next step — collapse is fine for instances, not for
  hiding whole feature areas.)
- **Conditional controls hide behind their parent.** Sliders that only
  matter when a toggle is on render only when it's on (crest gap under the
  3D toggle, for example). This is what keeps the *default* height low
  while power remains one click away.
- **A mode that reshapes other tabs must be visible where it acts.** Pen
  mode changes what Waves and Output mean; the affected spots carry a
  `<JumpNote>` to it rather than silently changing. Never let a control at
  the bottom of one tab invisibly rewrite another.

## Pre-merge checklist for any control-surface change

- [ ] The control sits in the workspace matching the *user's* intent, and
      you can say that intent in one sentence.
- [ ] `WORKSPACES[...].find` has an entry a user could actually type.
- [ ] No state gained a second control; cross-references are `<JumpNote>`s.
- [ ] Help longer than ~2 lines is behind `<Help>`.
- [ ] New state is in `useUrlSync` and survives a URL round-trip.
- [ ] Every affected tab still fits ~900px in its default state. Measure it:
      run the dev server, open each changed tab with a fresh scene, and read
      `document.body.scrollHeight` (Chromium headless works — see CLAUDE.md's
      rendering-change workflow for the harness).
- [ ] The UI tests still pass (`CI=true npm test`) — several of them click a
      workspace tab before driving a control, so a moved control means
      updating the tab click, not deleting the assertion.

## Anti-patterns, from the column this replaced

Each of these was real, and each is one review-comment away from returning:

- **"It's related to X, and X's panel is right there"** — proximity in the
  code is not proximity in intent. Wave height ended up in "Display", two
  panels from its own wavelength, and the help text had to say "see above".
- **"Users can't find it, so I'll add it here too"** — duplication is the
  symptom; the fix is a `find` entry and, at most, a `<JumpNote>`.
- **"I'll tuck it in advanced"** — a shared junk drawer hides your feature
  next to someone else's quality sliders. Expert controls go last in their
  own workspace instead.
- **"The explanation is important, so it must be visible"** — importance is
  why it's *written*, not why it's *always rendered*. `<Help>` keeps it one
  click away forever.
- **"It's just one more slider"** — eight screens of scroll was assembled
  entirely out of reasonable single sliders.
