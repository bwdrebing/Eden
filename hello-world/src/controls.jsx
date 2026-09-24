// ------------------------------------------------------------------ //
//  Control primitives
//
//  The small controls both studios' panels are built from. Moved out of
//  WaterReflectionContours.jsx unchanged, so the sand studio's panel is made
//  of the same parts — and obeys the same rules: long help goes behind a
//  <Help>, a control reached from a second place is a <JumpNote>. See
//  .claude/skills/control-surface/SKILL.md.
// ------------------------------------------------------------------ //
import { useState } from "react";

export function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5,
        letterSpacing: 0.3, color: "#9fb0c0", marginBottom: 4, fontFamily: "ui-monospace, monospace" }}>
        <span>{label}</span>
        <span style={{ color: "#e6eef5" }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 24, cursor: "pointer" }} />
    </label>
  );
}

// A line (or a few) of type to set. A textarea rather than an input because a
// watermark is often two lines — a name over a date — and the mask takes the
// newline as a line break.
export function TextField({ label, value, rows = 2, placeholder, onChange }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 11.5, letterSpacing: 0.3, color: "#9fb0c0", marginBottom: 4,
        fontFamily: "ui-monospace, monospace" }}>{label}</div>
      <textarea value={value} rows={rows} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", resize: "vertical",
          padding: "7px 8px", borderRadius: 7, border: "1px solid #2b3945",
          background: "#0d141b", color: "#e6eef5", fontSize: 13,
          fontFamily: "ui-monospace, monospace", lineHeight: 1.4 }} />
    </label>
  );
}

// One of a short list of choices, as a row of buttons — for settings with too
// few values to be worth a slider and too many to be a toggle.
export function Choice({ label, value, options, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11.5, letterSpacing: 0.3, color: "#9fb0c0", marginBottom: 4,
        fontFamily: "ui-monospace, monospace" }}>{label}</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map(([v, name]) => (
          <button key={String(v)} onClick={() => onChange(v)}
            style={{ flex: 1, padding: "6px 2px", borderRadius: 6, cursor: "pointer",
              border: "1px solid " + (v === value ? "#f6e2b0" : "#2b3945"),
              background: v === value ? "#26303a" : "#131a22",
              color: v === value ? "#f6e2b0" : "#9fb0c0",
              fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, value, onChange }) {
  return (
    <button onClick={() => onChange(!value)}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
        background: "none", border: "none", padding: "9px 0", cursor: "pointer", minHeight: 42,
        color: "#cdd9e3", fontSize: 13.5, fontFamily: "ui-monospace, monospace" }}>
      <span style={{ width: 36, height: 21, borderRadius: 11, padding: 2,
        background: value ? "#3f8597" : "#2a3640", transition: "background .15s", flexShrink: 0,
        display: "inline-flex", justifyContent: value ? "flex-end" : "flex-start" }}>
        <span style={{ width: 17, height: 17, borderRadius: "50%", background: "#eaf2f7" }} />
      </span>
      {label}
    </button>
  );
}

// Long-form help lives behind this one-line disclosure so a control costs
// its own height, not its documentation's. Anything longer than ~2 lines
// of prose goes in a <Help>, per the control-surface skill.
export function Help({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "0 0 8px" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ background: "none", border: "none", padding: "1px 0", cursor: "pointer",
          fontSize: 10, color: open ? "#9fd0d9" : "#5f7384",
          fontFamily: "ui-monospace, monospace" }}>
        ⓘ {label || "how this works"} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div style={{ fontSize: 10.5, color: "#8a9bab", lineHeight: 1.55, marginTop: 3,
          fontFamily: "ui-monospace, monospace", borderLeft: "2px solid #26313c",
          paddingLeft: 9 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// Where a control used to be duplicated, its old spots carry this pointer
// to its one home instead — one state, one control, one place to learn it.
export function JumpNote({ label, onJump }) {
  return (
    <button onClick={onJump}
      style={{ background: "none", border: "1px dashed #2a3640", borderRadius: 6,
        padding: "5px 9px", cursor: "pointer", fontSize: 10, color: "#7f93a4",
        fontFamily: "ui-monospace, monospace", marginBottom: 8, display: "block" }}>
      {label} →
    </button>
  );
}

export function ColorWell({ label, value, onChange }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer",
      fontSize: 10, color: "#8fa4b5", fontFamily: "ui-monospace, monospace" }}>
      <span style={{ width: 22, height: 22, borderRadius: 5, border: "1px solid #44525e",
        position: "relative", overflow: "hidden", background: value, display: "inline-block" }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={{ position: "absolute", inset: -4, opacity: 0, cursor: "pointer" }} />
      </span>
      {label}
    </label>
  );
}
