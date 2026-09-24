import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useUrlSync } from "./urlSettings";
import { Slider, Choice, Toggle, Help, JumpNote, ColorWell } from "./controls";
import { svgToPngBlob } from "./svgRaster";
import {
  SAND_DEFAULTS, SAND_RASTERS, SAND_RASTER_DEFAULT, SAND_EXPORT_MULTS, SAND_EXPORT_MAX_BW,
  sandFrame,
} from "./sand/render";
import {
  FEATURE_TYPES, FEATURE_LABELS, FEATURE_DEFAULTS, newFeature,
} from "./sand/field";
import { SAND_PALETTES, SAND_PALETTE_NAMES } from "./sand/palettes";
import { SAND_PRESETS } from "./sand/presets";
import { createSandBuilder } from "./sand/sandBuilder";

/* ------------------------------------------------------------------ *
 *  Sandscape studio
 *  h(x,y) = sand height, summed from bedforms (dunes, wind ripples,
 *  current ripples, backwash rills). Light it with a low sun, contour
 *  the light into flat regions — the water studio's idiom, pointed at
 *  sand. The renderer lives in src/sand/; this file is the panel.
 * ------------------------------------------------------------------ */

// The sand studio's workspaces. Same contract as the water studio's
// WORKSPACES: one tab per user intent, and the `find` lists are the find
// box's whole index — a control missing from them cannot be found by name.
// Read .claude/skills/control-surface/SKILL.md before adding a control.
export const SAND_WORKSPACES = [
  { id: "terrain", name: "Terrain", icon: "∿", find: [
    "starting points (dune sea, scattered dunes, ripples, rills, low tide, topo)",
    "add dunes", "add wind ripples", "add current ripples (tidal, linguoid)",
    "add backwash rills (ribbons, channels)", "wavelength (spacing)", "steepness (height)",
    "wind / flow heading", "crest wander (sinuosity)", "slip face (asymmetry)",
    "breakup (ridges into separate dunes, barchans)", "forks (y-junctions, defects)",
    "tongues (linguoid)", "stretch & braiding (rills)", "new seed (reshuffle)"] },
  { id: "light", name: "Light", icon: "☀", find: [
    "sun bearing (direction)", "sun height (elevation, raking light)", "cast shadows",
    "shadow fill (ambient)", "haze (distance fade)"] },
  { id: "camera", name: "Camera", icon: "◇", find: [
    "plan view (straight down)", "perspective view", "width across (scale)",
    "eye height", "heading (look direction)", "horizon position", "lens (focal length)",
    "position (move, pan)", "frame shape (landscape, square, portrait)"] },
  { id: "style", name: "Style", icon: "✎", find: [
    "palette", "bands (colour count)", "band balance (dark / light)",
    "colour by light or height (topographic)", "fill or lines (pen plot)", "line width",
    "edge smoothing", "antialiasing", "background colour"] },
  { id: "output", name: "Output", icon: "⇲", find: [
    "export svg", "export detail", "export png & size", "copy svg",
    "preview quality (raster)"] },
];
const SAND_SEARCH = SAND_WORKSPACES.flatMap((w) => w.find.map((f) => [f, w.id]));

// Real sizes for each bedform's wavelength slider (log scale, metres).
const LAMBDA_RANGE = { dunes: [5, 400], wind: [0.03, 1.5], current: [0.05, 1.5], rills: [0.1, 8] };
const MAX_FEATURES = 5;
const PNG_SCALES = [2, 3, 4];

function fmtLen(m) {
  if (m >= 10) return m.toFixed(0) + " m";
  if (m >= 1) return m.toFixed(1) + " m";
  if (m >= 0.1) return (m * 100).toFixed(0) + " cm";
  if (m >= 0.01) return (m * 100).toFixed(1) + " cm";
  return (m * 1000).toFixed(1) + " mm";
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const fmtBearing = (v) => `${Math.round(v)}° ${COMPASS[Math.round(((v % 360) + 360) % 360 / 45) % 8]}`;

// a slider over a quantity that spans decades: the track is log10 of it
function LogSlider({ label, value, min, max, onChange, fmt }) {
  const lv = Math.log10(Math.max(min, Math.min(max, value)));
  return (
    <Slider label={label} value={lv} min={Math.log10(min)} max={Math.log10(max)} step={0.005}
      onChange={(v) => onChange(Number(Math.pow(10, v).toPrecision(3)))}
      fmt={() => fmt(value)} />
  );
}

// One bedform. Collapsed it is a one-line summary, so a scene with several
// stays inside the tab's height budget; one card is open at a time.
function FeatureCard({ ft, idx, open, onOpen, onChange, onRemove }) {
  const flow = ft.type === "current" || ft.type === "rills";
  const [lmin, lmax] = LAMBDA_RANGE[ft.type] || [0.01, 1000];
  const steep = (2 * ft.amp) / ft.lambda;
  const onBtn = (on) => ({
    fontSize: 10.5, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
    fontFamily: "ui-monospace, monospace",
    background: on ? "#3b3324" : "#1a232c", color: on ? "#f6e2b0" : "#7f93a4",
    border: "1px solid " + (on ? "#8a7445" : "#26313c"),
  });
  return (
    <div style={{ border: "1px solid " + (open ? "#4a4030" : "#26313c"), borderRadius: 9,
      padding: open ? 11 : "7px 11px", marginBottom: 8, background: "#121922" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: open ? 10 : 0 }}>
        <button onClick={onOpen} aria-expanded={open}
          style={{ flex: 1, textAlign: "left", background: "none", border: "none", padding: 0,
            cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 11,
            color: ft.on ? "#cdd9e3" : "#5f7384" }}>
          <span style={{ color: "#6f8294", marginRight: 6 }}>{open ? "▾" : "▸"}</span>
          {FEATURE_LABELS[ft.type]}
          <span style={{ color: "#6f8294" }}> · {fmtLen(ft.lambda)} · {flow ? "flow" : "wind"} {fmtBearing(ft.dir)}</span>
        </button>
        <button onClick={() => onChange({ on: !ft.on })} style={onBtn(ft.on)}>{ft.on ? "on" : "off"}</button>
        <button onClick={onRemove} aria-label={`Remove ${FEATURE_LABELS[ft.type]} ${idx + 1}`}
          style={{ fontSize: 12, width: 26, height: 26, borderRadius: 6, cursor: "pointer",
            background: "#1a232c", color: "#9a6a6a", border: "1px solid #3a2a2a" }}>✕</button>
      </div>
      {open && <>
        <LogSlider label="wavelength (crest spacing)" value={ft.lambda} min={lmin} max={lmax}
          fmt={fmtLen}
          onChange={(v) => onChange({ lambda: v, amp: (ft.amp * v) / ft.lambda })} />
        <Slider label={ft.type === "rills" ? "depth (÷ spacing)" : "steepness (height ÷ wavelength)"}
          value={steep} min={0.005} max={0.35} step={0.005}
          onChange={(v) => onChange({ amp: (v * ft.lambda) / 2 })}
          fmt={(v) => `${v.toFixed(3)} · ${fmtLen(v * ft.lambda)} ${ft.type === "rills" ? "deep" : "tall"}`} />
        <Slider label={flow ? "flow heading (toward)" : "wind heading (toward)"} value={ft.dir}
          min={0} max={360} step={1} onChange={(v) => onChange({ dir: v })} fmt={fmtBearing} />
        <Slider label="crest wander" value={ft.wander} min={0} max={1} step={0.01}
          onChange={(v) => onChange({ wander: v })}
          fmt={(v) => (v < 0.2 ? "straight" : v < 0.55 ? "sinuous" : "meandering")} />
        {ft.type !== "rills" && (
          <Slider label="slip face (asymmetry)" value={ft.asym} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ asym: v })}
            fmt={(v) => (v < 0.2 ? "symmetric" : v < 0.6 ? "leaning" : "steep lee")} />
        )}
        {ft.type === "dunes" && (
          <Slider label="breakup (ridges → separate dunes)" value={ft.breakup} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ breakup: v })}
            fmt={(v) => (v < 0.25 ? "ridges" : v < 0.7 ? "broken" : "scattered")} />
        )}
        {ft.type === "wind" && (
          <Slider label="forks (Y-junctions)" value={ft.defects} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ defects: v })}
            fmt={(v) => (v < 0.05 ? "none" : v < 0.4 ? "few" : v < 0.75 ? "many" : "tangled")} />
        )}
        {ft.type === "current" && (
          <Slider label="tongues (straight → linguoid)" value={ft.tongues} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ tongues: v })}
            fmt={(v) => (v < 0.2 ? "straight" : v < 0.6 ? "sinuous" : "linguoid")} />
        )}
        {ft.type === "rills" && <>
          <Slider label="stretch along the flow" value={ft.stretch} min={1} max={10} step={0.1}
            onChange={(v) => onChange({ stretch: v })} fmt={(v) => v.toFixed(1) + "×"} />
          <Slider label="braiding" value={ft.braid} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ braid: v })}
            fmt={(v) => (v < 0.25 ? "parallel" : v < 0.65 ? "braided" : "tangled")} />
        </>}
        <button onClick={() => onChange({ seed: Math.floor(Math.random() * 1e6) })}
          style={{ fontSize: 10.5, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
            fontFamily: "ui-monospace, monospace", background: "#1a232c", color: "#9fb0c0",
            border: "1px solid #26313c" }}>↻ new seed</button>
      </>}
    </div>
  );
}

function PaletteButton({ name, on, onClick }) {
  const p = SAND_PALETTES[name];
  return (
    <button onClick={onClick} title={name}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: 5, borderRadius: 7,
        cursor: "pointer", background: on ? "#26303a" : "#131a22",
        border: "1px solid " + (on ? "#f6e2b0" : "#2b3945") }}>
      <span style={{ display: "flex", height: 12, borderRadius: 3, overflow: "hidden", width: "100%" }}>
        {p.ramp.map((c) => <span key={c} style={{ flex: 1, background: c }} />)}
      </span>
      <span style={{ fontSize: 9.5, color: on ? "#f6e2b0" : "#9fb0c0",
        fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>{name}</span>
    </button>
  );
}

function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function saveBlob(blob, name) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { /* sandbox may block downloads */ }
}

const SCENE_KEYS = Object.keys(SAND_DEFAULTS);

export default function SandscapeStudio({ studioSwitch = null }) {
  const width = useWidth();
  const isNarrow = width < 820;

  const [scene, setScene] = useState(SAND_DEFAULTS);
  const set = useCallback((k) => (v) => setScene((s) => ({ ...s, [k]: v })), []);
  const [savedTab, setUiTab] = useState("terrain");
  const uiTab = SAND_WORKSPACES.some((w) => w.id === savedTab) ? savedTab : SAND_WORKSPACES[0].id;
  const [rasterQ, setRasterQ] = useState(SAND_RASTER_DEFAULT);
  const [exportQ, setExportQ] = useState(1);
  const [pngQ, setPngQ] = useState(1);
  const [openId, setOpenId] = useState(null);
  const [findQ, setFindQ] = useState("");
  const [flash, setFlash] = useState(0);

  // every scene setting rides in the URL's "sand" slice, one key per field,
  // so a shared link reopens the same sand
  const urlFields = { uiTab: [savedTab, setUiTab], rasterQ: [rasterQ, setRasterQ],
    exportQ: [exportQ, setExportQ], pngQ: [pngQ, setPngQ] };
  for (const k of SCENE_KEYS) urlFields[k] = [scene[k], set(k)];
  useUrlSync("sand", urlFields);

  const features = Array.isArray(scene.features) ? scene.features : [];
  const updateFeature = (id, patch) =>
    set("features")(features.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const removeFeature = (id) => set("features")(features.filter((f) => f.id !== id));
  const addFeature = (type) => {
    if (features.length >= MAX_FEATURES) return;
    const id = features.reduce((m, f) => Math.max(m, f.id | 0), 0) + 1;
    const lead = features.find((f) => f.on);
    // a new bedform starts under the same wind as what is already there
    set("features")([...features, { ...newFeature(type, id), dir: lead ? lead.dir : FEATURE_DEFAULTS[type].dir }]);
    setOpenId(id);
  };
  const applyPreset = (p) => {
    setScene({ ...SAND_DEFAULTS, frame: scene.frame, smooth: scene.smooth,
      antialias: scene.antialias, lineWidth: scene.lineWidth, ...p.scene });
    setOpenId(null);
  };

  // ---- rendering: newest request wins, the last picture stays up ------
  const builder = useRef(null);
  useEffect(() => {
    builder.current = createSandBuilder();
    return () => { if (builder.current) builder.current.terminate(); builder.current = null; };
  }, []);
  const [pic, setPic] = useState(null);           // { svg, stats, VW, VH }
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const queue = useRef({ running: false, next: null });
  const previewBW = SAND_RASTERS[rasterQ] ? SAND_RASTERS[rasterQ].BW : SAND_RASTERS[SAND_RASTER_DEFAULT].BW;
  const sceneKey = JSON.stringify(scene);
  // A change is drawn twice: first at draft size, which comes back fast
  // enough to follow a dragged slider, then at the chosen quality once
  // nothing newer is waiting. A newer change drops both.
  const pump = useCallback(() => {
    const q = queue.current, b = builder.current;
    if (q.running || !q.next || !b) return;
    const { S, BW, then } = q.next;
    q.next = null; q.running = true;
    setRendering(true);
    b.render(S, BW).then((out) => { setPic(out); setError(""); },
      (e) => { if (!e.stopped) setError(e.message || String(e)); })
      .finally(() => {
        q.running = false;
        if (!q.next && then) q.next = then;
        if (q.next) pump(); else setRendering(false);
      });
  }, []);
  useEffect(() => {
    const S = JSON.parse(sceneKey), draft = SAND_RASTERS[0].BW;
    queue.current.next = previewBW > draft
      ? { S, BW: draft, then: { S, BW: previewBW } } : { S, BW: previewBW };
    pump();
  }, [sceneKey, previewBW, pump]);

  // ---- export ------------------------------------------------------
  const [exporting, setExporting] = useState("");
  const [svgInfo, setSvgInfo] = useState("");
  const [copied, setCopied] = useState(false);
  const exportBW = Math.min(SAND_EXPORT_MAX_BW, previewBW * SAND_EXPORT_MULTS[exportQ]);
  const [VW, VH] = sandFrame(scene);
  const exportSvg = async () => {
    if (!builder.current || exporting) return;
    setExporting("svg");
    try {
      const out = await builder.current.render(scene, exportBW);
      saveBlob(new Blob([out.svg], { type: "image/svg+xml" }), "sandscape.svg");
      setSvgInfo(`${(out.svg.length / 1e6).toFixed(1)} MB · traced at ${exportBW}px`);
    } catch (e) { if (!e.stopped) setError(e.message || String(e)); }
    setExporting("");
  };
  const exportPng = async () => {
    if (!pic || exporting) return;
    setExporting("png");
    try {
      // the preview's own picture, rasterized bigger — like the water's PNG.
      // If what is on screen is still the quick draft, the full-quality
      // preview is drawn first: the PNG is the preview, not its sketch.
      const s = PNG_SCALES[pngQ];
      const src = pic.BW === previewBW ? pic : await builder.current.render(scene, previewBW);
      const blob = await svgToPngBlob(src.svg, src.VW * s, src.VH * s);
      saveBlob(blob, "sandscape.png");
    } catch (e) { setError("PNG export needs a canvas this browser would not give"); }
    setExporting("");
  };
  const copySvg = () => {
    if (pic && navigator.clipboard) {
      navigator.clipboard.writeText(pic.svg).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  };

  // ---- find box ------------------------------------------------------
  const findHits = findQ.trim()
    ? SAND_SEARCH.filter(([label]) => label.toLowerCase().includes(findQ.trim().toLowerCase())).slice(0, 8)
    : [];
  const jumpTo = (id) => { setUiTab(id); setFindQ(""); setFlash((f) => f + 1); };
  const [flashOn, setFlashOn] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setFlashOn(true);
    const t = setTimeout(() => setFlashOn(false), 700);
    return () => clearTimeout(t);
  }, [flash]);

  const persp = scene.view !== "plan";
  const lines = scene.style !== "fill";
  // what the background is when it is left to the palette (as sandSvg picks it)
  const pal = SAND_PALETTES[scene.palette] || SAND_PALETTES["Dune Sea"];
  const autoBg = scene.style === "lines" ? pal.ramp[pal.ramp.length - 1] : persp ? pal.sky : pal.ramp[0];
  const panRange = persp ? 400 : scene.planWidth * 3;
  const posRange = (v) => Math.max(panRange, Math.ceil(Math.abs(v)));
  const previewSvg = useMemo(() => (pic ? { __html: pic.svg } : null), [pic]);

  const panel = {
    background: "#151c24", border: "1px solid #232d38", borderRadius: 12,
    padding: 16, marginBottom: 14,
  };
  const heading = {
    fontSize: 10.5, letterSpacing: 1.6, textTransform: "uppercase",
    color: "#6f8294", marginBottom: 12, fontFamily: "ui-monospace, monospace",
  };
  const miniBtn = {
    flex: 1, padding: "8px 4px", fontSize: 11, borderRadius: 6, cursor: "pointer",
    background: "#1a232c", color: "#9fb0c0", border: "1px solid #26313c",
    fontFamily: "ui-monospace, monospace",
  };
  const bigBtn = (busy) => ({
    width: "100%", padding: "11px 12px", borderRadius: 8, cursor: busy ? "wait" : "pointer",
    fontSize: 13, fontFamily: "ui-monospace, monospace", marginBottom: 8,
    background: "#3b3324", color: "#f6e2b0", border: "1px solid #8a7445",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0e0c0a", color: "#efe7da",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      padding: isNarrow ? "16px 12px 50px" : "22px 16px 60px" }}>
      <style>{`
        input[type=range]{ -webkit-appearance:none; appearance:none; background:transparent; touch-action:pan-y; }
        input[type=range]::-webkit-slider-runnable-track{ height:5px; border-radius:3px; background:#2a3640; }
        input[type=range]::-moz-range-track{ height:5px; border-radius:3px; background:#2a3640; }
        input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:24px; height:24px; border-radius:50%; background:#d9a55b; margin-top:-10px; box-shadow:0 1px 4px rgba(0,0,0,.6); }
        input[type=range]::-moz-range-thumb{ width:24px; height:24px; border:none; border-radius:50%; background:#d9a55b; box-shadow:0 1px 4px rgba(0,0,0,.6); }
        .sand-preview svg{ width:100%; height:auto; display:block; }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ marginBottom: isNarrow ? 12 : 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, flexWrap: "wrap-reverse" }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: "#7a6a55",
              fontFamily: "ui-monospace, monospace" }}>SCALAR FIELD · h = SAND HEIGHT, LIT</div>
            {studioSwitch}
          </div>
          <h1 style={{ fontSize: isNarrow ? 21 : 27, margin: "4px 0 4px", fontWeight: 600,
            fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: -0.2 }}>
            Sandscape Studio
          </h1>
          {!isNarrow && (
            <p style={{ fontSize: 13.5, color: "#a89880", maxWidth: 620, lineHeight: 1.5, margin: 0 }}>
              Dunes, wind ripples, current ripples and backwash rills, summed into one height
              field and lit by a low sun. Every tone is a level set of that light, traced as a
              real vector region.
            </p>
          )}
        </header>

        <div style={{ display: isNarrow ? "block" : "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16, alignItems: "start" }}>

          {/* PREVIEW — the export's own SVG string, not a separate drawing */}
          <div style={{ background: "#070605", borderRadius: 14, border: "1px solid #2a241c",
            overflow: "hidden", position: isNarrow ? "relative" : "sticky", top: isNarrow ? 0 : 22,
            marginBottom: isNarrow ? 14 : 0, boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }}>
            <div style={{ position: "relative", aspectRatio: `${VW} / ${VH}` }}>
              {previewSvg
                ? <div className="sand-preview" data-testid="sand-preview" dangerouslySetInnerHTML={previewSvg} />
                : <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                    justifyContent: "center", color: "#7a6a55", fontSize: 12,
                    fontFamily: "ui-monospace, monospace" }}>shaping sand…</div>}
              <div style={{ position: "absolute", left: 12, bottom: 10, fontSize: 10.5,
                color: "#8a7a64", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5,
                textShadow: "0 0 4px rgba(0,0,0,.8)" }}>
                {pic ? `${pic.stats.bands} bands · ${persp ? "perspective" : "plan"} · ${pic.BW}px`
                  + ` · ${(pic.stats.ms / 1000).toFixed(1)} s` : ""}
                {rendering ? " · rendering…" : ""}
                {error ? ` · ${error}` : ""}
              </div>
            </div>
          </div>

          {/* CONTROLS — one workspace at a time; see SAND_WORKSPACES */}
          <div style={{ boxShadow: flashOn ? "0 0 0 2px #8a7445" : "none",
            borderRadius: 12, transition: "box-shadow .5s" }}>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input value={findQ} onChange={(e) => setFindQ(e.target.value)}
                placeholder="Find a control…" aria-label="Find a control"
                style={{ width: "100%", boxSizing: "border-box", background: "#151c24",
                  color: "#e6eef5", border: "1px solid #232d38", borderRadius: 9,
                  padding: "9px 12px", fontSize: 12, fontFamily: "ui-monospace, monospace" }} />
              {findHits.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30,
                  marginTop: 4, background: "#141b23", border: "1px solid #33414e",
                  borderRadius: 9, overflow: "hidden", boxShadow: "0 12px 30px rgba(0,0,0,.6)" }}>
                  {findHits.map(([label, ws]) => (
                    <button key={label} onClick={() => jumpTo(ws)}
                      style={{ display: "flex", width: "100%", alignItems: "center", gap: 8,
                        background: "none", border: "none", borderBottom: "1px solid #232d38",
                        color: "#9fb0c0", fontFamily: "ui-monospace, monospace", fontSize: 11,
                        padding: "7px 10px", cursor: "pointer", textAlign: "left" }}>
                      <span style={{ flex: 1 }}>{label}</span>
                      <span style={{ fontSize: 9, color: "#d9a55b", border: "1px solid #6b5634",
                        borderRadius: 3, padding: "0 5px", flex: "none" }}>
                        {SAND_WORKSPACES.find((w) => w.id === ws).name}</span>
                    </button>
                  ))}
                </div>
              )}
              {findQ.trim() !== "" && findHits.length === 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30,
                  marginTop: 4, background: "#141b23", border: "1px solid #33414e",
                  borderRadius: 9, padding: "7px 10px", fontSize: 11, color: "#6d808f",
                  fontFamily: "ui-monospace, monospace" }}>no matching control</div>
              )}
            </div>

            <div role="tablist" aria-label="Sand workspaces"
              style={{ display: "grid", gridTemplateColumns: `repeat(${SAND_WORKSPACES.length}, 1fr)`,
                gap: 4, marginBottom: 12 }}>
              {SAND_WORKSPACES.map((w) => {
                const on = uiTab === w.id;
                return (
                  <button key={w.id} role="tab" aria-selected={on} onClick={() => setUiTab(w.id)}
                    style={{ padding: "7px 2px 5px", borderRadius: 8, cursor: "pointer",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                      background: on ? "#2a251d" : "none", color: on ? "#f6e2b0" : "#6f8294",
                      border: "1px solid " + (on ? "#8a7445" : "transparent") }}>
                    <span style={{ fontSize: 14, lineHeight: 1.2 }}>{w.icon}</span>
                    <span style={{ fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase",
                      fontFamily: "ui-monospace, monospace" }}>{w.name}</span>
                  </button>
                );
              })}
            </div>

            {uiTab === "terrain" && <>
              <div style={panel}>
                <div style={heading}>Starting points</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 5, marginBottom: 6 }}>
                  {SAND_PRESETS.map((p) => (
                    <button key={p.name} style={{ ...miniBtn, padding: "7px 4px" }}
                      onClick={() => applyPreset(p)}>{p.name}</button>
                  ))}
                </div>
                <Help label="what a starting point sets">
                  A starting point replaces the bedforms and also sets the camera, the sun and the
                  palette that suit them — ripples want to be looked straight down at under a
                  nearly flat sun; a dune field wants a low eye and a long lens. Frame shape,
                  smoothing and line width are yours and stay as they are.
                </Help>
              </div>
              <div style={panel}>
                <div style={heading}>Bedforms</div>
                {features.length === 0 && (
                  <div style={{ fontSize: 11, color: "#7a6a55", marginBottom: 10,
                    fontFamily: "ui-monospace, monospace" }}>Flat sand. Add a bedform below.</div>
                )}
                {features.map((ft, i) => (
                  <FeatureCard key={ft.id} ft={ft} idx={i} open={openId === ft.id}
                    onOpen={() => setOpenId(openId === ft.id ? null : ft.id)}
                    onChange={(patch) => updateFeature(ft.id, patch)}
                    onRemove={() => removeFeature(ft.id)} />
                ))}
                {features.length < MAX_FEATURES && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 5, marginTop: 4 }}>
                    {FEATURE_TYPES.map((t) => (
                      <button key={t} style={miniBtn} onClick={() => addFeature(t)}>+ {FEATURE_LABELS[t]}</button>
                    ))}
                  </div>
                )}
                <Help label="the four bedforms">
                  <b>Dunes</b> are tens of metres long, with a long gentle slope facing the wind and
                  a steep slip face behind the crest; ripples do not survive on a slip face, so they
                  fade there. <b>Wind ripples</b> are the fine, regular wrinkles wind combs into dry
                  sand — straight crests with the odd fork where a crest splits. <b>Current
                  ripples</b> are what flowing water leaves: taller, more sinuous, and in faster flow
                  broken into staggered tongues. <b>Rills</b> are the braided little channels
                  running <i>along</i> the flow where a wave drains back down a beach. The heading is
                  where the wind or water is going; the steep side of every ripple faces it.
                </Help>
              </div>
            </>}

            {uiTab === "light" && <>
              {scene.colorBy === "height" && (
                <JumpNote label="coloured by height — the light is not drawn (Style)"
                  onJump={() => jumpTo("style")} />
              )}
              <div style={panel}>
                <div style={heading}>Sun</div>
                <Slider label="sun bearing (light comes from)" value={scene.sunAz} min={0} max={360} step={1}
                  onChange={set("sunAz")} fmt={fmtBearing} />
                <Slider label="sun height" value={scene.sunEl} min={2} max={75} step={0.5}
                  onChange={set("sunEl")}
                  fmt={(v) => `${v.toFixed(1)}° · ${v < 10 ? "grazing" : v < 25 ? "raking" : v < 50 ? "day" : "high"}`} />
                <Toggle label="Cast shadows" value={scene.shadows} onChange={set("shadows")} />
                <Help label="why the sun is low">
                  Sand is one colour; everything you see of its shape is light. A low sun across the
                  crests lights the faces turned toward it and throws the others into shadow — that
                  is what makes ripples readable at all. Put the sun roughly across the heading of
                  the bedform you want to show; straight along it, the crests go flat.
                </Help>
              </div>
              <div style={panel}>
                <div style={heading}>Air</div>
                <Slider label="shadow fill (sky light)" value={scene.ambient} min={0} max={0.8} step={0.01}
                  onChange={set("ambient")} fmt={(v) => (v < 0.15 ? "black" : v < 0.4 ? "deep" : "open")} />
                {persp && (
                  <Slider label="haze (distance fade)" value={scene.haze} min={0} max={1} step={0.01}
                    onChange={set("haze")} fmt={(v) => (v === 0 ? "clear" : v < 0.4 ? "light" : v < 0.75 ? "dusty" : "thick")} />
                )}
              </div>
            </>}

            {uiTab === "camera" && <>
              <div style={panel}>
                <div style={heading}>View</div>
                <Choice label="looking" value={scene.view}
                  options={[["plan", "Straight down"], ["perspective", "Across"]]} onChange={set("view")} />
                <Choice label="frame" value={scene.frame}
                  options={[["landscape", "3:2"], ["square", "1:1"], ["portrait", "2:3"]]} onChange={set("frame")} />
              </div>
              <div style={panel}>
                <div style={heading}>{persp ? "Eye" : "Framing"}</div>
                {persp ? <>
                  <LogSlider label="eye height" value={scene.camHeight} min={0.2} max={300}
                    onChange={set("camHeight")} fmt={fmtLen} />
                  <Slider label="heading (looking toward)" value={scene.heading} min={0} max={360} step={1}
                    onChange={set("heading")} fmt={fmtBearing} />
                  <Slider label="horizon (from top of frame)" value={scene.horizon} min={0.05} max={0.9} step={0.01}
                    onChange={set("horizon")} fmt={(v) => Math.round(v * 100) + "%"} />
                  <LogSlider label="lens (focal length)" value={scene.focal} min={12} max={400}
                    onChange={set("focal")} fmt={(v) => Math.round(v) + " mm"} />
                </> : (
                  <LogSlider label="width across the frame" value={scene.planWidth} min={0.3} max={2000}
                    onChange={set("planWidth")} fmt={fmtLen} />
                )}
                <Slider label="position ← west · east →" value={scene.camX}
                  min={-posRange(scene.camX)} max={posRange(scene.camX)} step={persp ? 0.5 : scene.planWidth / 200}
                  onChange={set("camX")} fmt={fmtLen} />
                <Slider label="position ↓ south · north ↑" value={scene.camY}
                  min={-posRange(scene.camY)} max={posRange(scene.camY)} step={persp ? 0.5 : scene.planWidth / 200}
                  onChange={set("camY")} fmt={fmtLen} />
              </div>
            </>}

            {uiTab === "style" && <>
              <div style={panel}>
                <div style={heading}>Colour</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 5, marginBottom: 12 }}>
                  {SAND_PALETTE_NAMES.map((n) => (
                    <PaletteButton key={n} name={n} on={scene.palette === n} onClick={() => set("palette")(n)} />
                  ))}
                </div>
                <Slider label="bands" value={scene.bands} min={2} max={16} step={1} onChange={set("bands")} />
                <Slider label="band balance" value={scene.balance} min={-1} max={1} step={0.05}
                  onChange={set("balance")}
                  fmt={(v) => (Math.abs(v) < 0.05 ? "even" : v < 0 ? "more dark" : "more light")} />
                <Choice label="colour by" value={scene.colorBy}
                  options={[["light", "Light"], ["height", "Height"]]} onChange={set("colorBy")} />
              </div>
              <div style={panel}>
                <div style={heading}>Drawing</div>
                <Choice label="draw" value={scene.style}
                  options={[["fill", "Fill"], ["lines", "Lines"], ["both", "Both"]]} onChange={set("style")} />
                {lines && (
                  <Slider label="line width" value={scene.lineWidth} min={0.2} max={3} step={0.05}
                    onChange={set("lineWidth")} fmt={(v) => v.toFixed(2)} />
                )}
                <Slider label="edge smoothing" value={scene.smooth} min={0} max={4} step={1}
                  onChange={set("smooth")} fmt={(v) => (v === 0 ? "sharp" : v + " passes")} />
                <Slider label="antialiasing" value={scene.antialias} min={0} max={3} step={1}
                  onChange={set("antialias")} fmt={(v) => (v === 0 ? "off" : ["", "light", "medium", "strong"][v])} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <ColorWell label={persp && !lines ? "sky" : "background"} value={scene.bgColor || autoBg}
                    onChange={set("bgColor")} />
                  {scene.bgColor && (
                    <button style={{ ...miniBtn, flex: "none", padding: "4px 8px" }}
                      onClick={() => set("bgColor")("")}>use palette's</button>
                  )}
                </div>
                <Help label="lines and height">
                  <b>Lines</b> strokes the edge between every pair of bands instead of filling
                  them — a pen-plotter drawing of the same picture. Coloured by <b>height</b>
                  with many bands, that is a topographic map of the sand; by <b>light</b>, it is
                  the shading's own contour lines.
                </Help>
              </div>
            </>}

            {uiTab === "output" && <>
              <div style={panel}>
                <div style={heading}>SVG</div>
                <Choice label="export detail" value={exportQ}
                  options={SAND_EXPORT_MULTS.map((m, i) => [i, m + "×"])} onChange={setExportQ} />
                <button style={bigBtn(exporting === "svg")} onClick={exportSvg} disabled={!!exporting}>
                  {exporting === "svg" ? "tracing…" : "Export SVG"}</button>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <button style={miniBtn} onClick={copySvg} disabled={!pic || rendering}>{copied ? "copied" : "Copy preview SVG"}</button>
                </div>
                {svgInfo && (
                  <div style={{ fontSize: 10, color: "#8a7a64", fontFamily: "ui-monospace, monospace" }}>{svgInfo}</div>
                )}
                <Help label="what export detail does">
                  The file is the same picture as the preview, traced again on a raster {SAND_EXPORT_MULTS[exportQ]}×
                  as wide ({exportBW}px here), so every edge is placed more finely. It is the same
                  geometry, not a different render.
                </Help>
              </div>
              <div style={panel}>
                <div style={heading}>PNG</div>
                <Choice label="size" value={pngQ}
                  options={PNG_SCALES.map((s, i) => [i, `${VW * s}×${VH * s}`])} onChange={setPngQ} />
                <button style={bigBtn(exporting === "png")} onClick={exportPng} disabled={!!exporting || !pic}>
                  {exporting === "png" ? "rasterizing…" : "Export PNG"}</button>
              </div>
              <div style={panel}>
                <div style={heading}>Preview</div>
                <Choice label="preview quality" value={rasterQ}
                  options={SAND_RASTERS.map((r, i) => [i, r.name])} onChange={setRasterQ} />
              </div>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
