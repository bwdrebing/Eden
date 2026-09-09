// ------------------------------------------------------------------ //
//  Backdrop edit history
//
//  Painting used to be irreversible: PaintStrip and PaintGrid2D write the
//  active color straight into the buffer, so the color that was there is
//  gone the moment the pointer moves. This is the smallest thing that
//  fixes it — a snapshot ring over the two paint buffers.
//
//  Snapshots, not a command log, because the buffers are small and every
//  edit (a stroke, a smooth, a reset, a photo import) can be expressed as
//  "the buffer was this before". One entry per committed edit: a stroke
//  snapshots on pointer-down and is one undo step no matter how far it
//  drags.
//
//  Entries are { kind, value }: kind "1d" is the envColors array, "2d" is
//  the { w, h, cells } panorama. The stack is shared across both so undo
//  walks back through edits in the order they were made, whichever canvas
//  they happened on.
//
//  Everything here is pure — the studio holds the history in state and
//  swaps in whatever these return.
// ------------------------------------------------------------------ //

export const HISTORY_CAP = 60;

export const emptyHistory = () => ({ past: [], future: [] });

// Record the state an edit is about to overwrite. Dropping the redo stack
// is the usual editor rule: once you edit after undoing, the branch you
// undid out of is not reachable any more.
export function pushEdit(hist, entry, cap = HISTORY_CAP) {
  const past = hist.past.concat([entry]);
  return { past: past.length > cap ? past.slice(past.length - cap) : past, future: [] };
}

// `currentOf(kind)` hands back the live buffer for that kind, so the state
// being replaced can go onto the other stack. Returns null when there is
// nothing to step to, which is also what the panel's buttons read.
export function undo(hist, currentOf) {
  if (!hist.past.length) return null;
  const entry = hist.past[hist.past.length - 1];
  return {
    hist: { past: hist.past.slice(0, -1),
            future: hist.future.concat([{ kind: entry.kind, value: currentOf(entry.kind) }]) },
    entry,
  };
}

export function redo(hist, currentOf) {
  if (!hist.future.length) return null;
  const entry = hist.future[hist.future.length - 1];
  return {
    hist: { past: hist.past.concat([{ kind: entry.kind, value: currentOf(entry.kind) }]),
            future: hist.future.slice(0, -1) },
    entry,
  };
}

export const canUndo = (hist) => hist.past.length > 0;
export const canRedo = (hist) => hist.future.length > 0;
