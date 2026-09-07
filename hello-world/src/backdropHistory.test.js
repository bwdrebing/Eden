import { emptyHistory, pushEdit, undo, redo, canUndo, canRedo, HISTORY_CAP }
  from "./backdropHistory";

// stand-in for the studio's two paint buffers
function studio(initial1d = ["a"], initial2d = { w: 1, h: 1, cells: ["x"] }) {
  const live = { "1d": initial1d, "2d": initial2d };
  return {
    live,
    currentOf: (kind) => live[kind],
    apply: (entry) => { live[entry.kind] = entry.value; },
  };
}

describe("backdrop edit history", () => {
  test("undo restores the buffer an edit overwrote", () => {
    const s = studio(["a"]);
    let h = pushEdit(emptyHistory(), { kind: "1d", value: s.currentOf("1d") });
    s.live["1d"] = ["b"];                       // the edit

    const step = undo(h, s.currentOf);
    s.apply(step.entry);
    expect(s.live["1d"]).toEqual(["a"]);
    expect(canUndo(step.hist)).toBe(false);
    expect(canRedo(step.hist)).toBe(true);
  });

  test("redo puts the edit back", () => {
    const s = studio(["a"]);
    let h = pushEdit(emptyHistory(), { kind: "1d", value: s.currentOf("1d") });
    s.live["1d"] = ["b"];

    let step = undo(h, s.currentOf); s.apply(step.entry); h = step.hist;
    step = redo(h, s.currentOf); s.apply(step.entry); h = step.hist;

    expect(s.live["1d"]).toEqual(["b"]);
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
  });

  test("walks back through edits on both canvases in the order they were made", () => {
    const s = studio(["a"], { w: 1, h: 1, cells: ["x"] });
    let h = emptyHistory();

    h = pushEdit(h, { kind: "1d", value: s.currentOf("1d") });
    s.live["1d"] = ["b"];
    h = pushEdit(h, { kind: "2d", value: s.currentOf("2d") });
    s.live["2d"] = { w: 1, h: 1, cells: ["y"] };

    let step = undo(h, s.currentOf); s.apply(step.entry); h = step.hist;
    expect(s.live["2d"].cells).toEqual(["x"]);
    expect(s.live["1d"]).toEqual(["b"]);        // the 1D edit is still there

    step = undo(h, s.currentOf); s.apply(step.entry); h = step.hist;
    expect(s.live["1d"]).toEqual(["a"]);
  });

  test("editing after an undo drops the redo branch", () => {
    const s = studio(["a"]);
    let h = pushEdit(emptyHistory(), { kind: "1d", value: s.currentOf("1d") });
    s.live["1d"] = ["b"];

    const step = undo(h, s.currentOf); s.apply(step.entry); h = step.hist;
    expect(canRedo(h)).toBe(true);

    h = pushEdit(h, { kind: "1d", value: s.currentOf("1d") });
    s.live["1d"] = ["c"];
    expect(canRedo(h)).toBe(false);
  });

  test("drops the oldest entries past the cap", () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_CAP + 20; i++) h = pushEdit(h, { kind: "1d", value: [i] });
    expect(h.past.length).toBe(HISTORY_CAP);
    expect(h.past[0].value).toEqual([20]);
  });

  test("undo and redo on an empty history do nothing", () => {
    const s = studio();
    expect(undo(emptyHistory(), s.currentOf)).toBeNull();
    expect(redo(emptyHistory(), s.currentOf)).toBeNull();
  });

  test("never mutates the history handed to it", () => {
    const s = studio(["a"]);
    const h0 = pushEdit(emptyHistory(), { kind: "1d", value: ["a"] });
    const snapshot = { past: h0.past.slice(), future: h0.future.slice() };
    undo(h0, s.currentOf);
    expect(h0).toEqual(snapshot);
  });
});
