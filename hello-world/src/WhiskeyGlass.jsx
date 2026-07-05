import React, { useState, useMemo, useEffect } from "react";

/* ------------------------------------------------------------------ *
 *  Whiskey glass studio
 *  A realistic vector still life: a rocks glass of whiskey with ice,
 *  drawn entirely from SVG gradients and paths — no raster filters.
 *  The ice cubes are true 3D boxes, rotated, projected and lit, then
 *  split at the waterline (the submerged half is tinted and shifted
 *  sideways — the refraction break you see in a real glass).
 *  "Poster bands" quantizes every gradient into hard steps, turning
 *  the same scene into flat color-band art.
 * ------------------------------------------------------------------ */

const VB_W = 800;
const VB_H = 600;

const PALETTES = {
  "Speakeasy": {
    bgTop: "#2e1f13", bgBot: "#0b0705", glow: "#9a6428",
    tableTop: "#3b2517", tableBot: "#120a06",
    whisky: ["#2e0f02", "#6b2c06", "#a85812", "#d98b26", "#f2bf5e"],
    surface: ["#7c3a0c", "#c87d1f", "#f2c05f"],
    ice: [225, 238, 246], iceDeep: [150, 185, 205],
    accent: "#f7cd6e", spark: "#fff3d8",
  },
  "Golden Hour": {
    bgTop: "#7a4420", bgBot: "#1c0d05", glow: "#d98e3a",
    tableTop: "#5a3316", tableBot: "#170c04",
    whisky: ["#3a1403", "#7e3708", "#bd6a14", "#e89a2c", "#f9d06e"],
    surface: ["#8d4510", "#d98e26", "#f9d06e"],
    ice: [235, 240, 240], iceDeep: [190, 195, 190],
    accent: "#fbd977", spark: "#fff6e0",
  },
  "Blue Bar": {
    bgTop: "#16222e", bgBot: "#05080c", glow: "#3d6a80",
    tableTop: "#1d2b36", tableBot: "#090e13",
    whisky: ["#381204", "#7a3208", "#b55e12", "#e08f24", "#f4c258"],
    surface: ["#84400e", "#ce7f1e", "#f4c258"],
    ice: [214, 233, 244], iceDeep: [130, 175, 200],
    accent: "#f4c862", spark: "#eef8ff",
  },
  "Emerald Room": {
    bgTop: "#12302a", bgBot: "#050d0b", glow: "#3f7a5e",
    tableTop: "#173229", tableBot: "#07110d",
    whisky: ["#331104", "#713008", "#ad5c12", "#dd9026", "#f5c765"],
    surface: ["#7e3f0e", "#c67e1f", "#f5c765"],
    ice: [220, 238, 236], iceDeep: [150, 195, 185],
    accent: "#f5cd6c", spark: "#f2fff8",
  },
};

// ---- helpers ---------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex2rgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function rgb2hex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
function mixHex(a, b, t) {
  const A = Array.isArray(a) ? a : hex2rgb(a), B = Array.isArray(b) ? b : hex2rgb(b);
  return rgb2hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
// sample a multi-stop ramp at t ∈ [0,1]
function rampAt(cols, t) {
  const n = cols.length - 1;
  const x = Math.max(0, Math.min(1, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return mixHex(cols[i], cols[i + 1], x - i);
}
// gradient stops — continuous, or quantized into hard poster bands
function stops(cols, banded, nb, opac) {
  const op = (o) => (o === undefined ? "" : ` stop-opacity="${o}"`);
  if (!banded) {
    return cols.map((c, i) => {
      const t = cols.length === 1 ? 0 : i / (cols.length - 1);
      const o = Array.isArray(opac) ? opac[i] : opac;
      return `<stop offset="${(t * 100).toFixed(1)}%" stop-color="${Array.isArray(c) ? rgb2hex(...c) : c}"${op(o)}/>`;
    }).join("");
  }
  let s = "";
  for (let k = 0; k < nb; k++) {
    const c = rampAt(cols, (k + 0.5) / nb);
    const o = Array.isArray(opac)
      ? opac[0] + (opac[opac.length - 1] - opac[0]) * ((k + 0.5) / nb)
      : opac;
    const a = ((k / nb) * 100).toFixed(1), b = (((k + 1) / nb) * 100).toFixed(1);
    s += `<stop offset="${a}%" stop-color="${c}"${op(o)}/><stop offset="${b}%" stop-color="${c}"${op(o)}/>`;
  }
  return s;
}

// ---- 3D ice cube ------------------------------------------------------
const CUBE_FACES = [
  { idx: [0, 1, 2, 3], n: [0, 0, 1] },   // front
  { idx: [5, 4, 7, 6], n: [0, 0, -1] },  // back
  { idx: [4, 0, 3, 7], n: [-1, 0, 0] },  // left
  { idx: [1, 5, 6, 2], n: [1, 0, 0] },   // right
  { idx: [3, 2, 6, 7], n: [0, 1, 0] },   // top
  { idx: [4, 5, 1, 0], n: [0, -1, 0] },  // bottom
];
const CUBE_CORNERS = [
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
];

function rotXYZ([x, y, z], yaw, tilt, roll) {
  let c = Math.cos(yaw), s = Math.sin(yaw);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(tilt); s = Math.sin(tilt);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(roll); s = Math.sin(roll);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

// project with the same mild top-down camera as the glass ellipses
const CAM_Q = 0.22;
function proj([x, y, z]) {
  return [x, -y * 0.975 + z * CAM_Q, z * 0.975 + y * CAM_Q];
}

// one ice cube → svg strings for its lit translucent faces
function cubeSvg(cube, P, tint, extraOp, dxRefr) {
  const { cx0, cy0, e, yaw, tilt, roll } = cube;
  const L = norm3([P.lightX, 0.9, 0.55]);
  const V = norm3([0, CAM_Q, 0.97]);
  const pts = CUBE_CORNERS.map((c) =>
    rotXYZ([c[0] * e / 2, c[1] * e / 2, c[2] * e / 2], yaw, tilt, roll));
  const scr = pts.map((p) => { const q = proj(p); return [cx0 + q[0] + dxRefr, cy0 + q[1], q[2]]; });
  const faces = CUBE_FACES.map((f) => {
    const n = rotXYZ(f.n, yaw, tilt, roll);
    const depth = f.idx.reduce((s, i) => s + scr[i][2], 0) / 4;
    return { ...f, nr: n, depth, front: dot3(n, V) > 0 };
  }).sort((a, b) => a.depth - b.depth);

  let s = "";
  for (const f of faces) {
    const lit = Math.max(0, dot3(f.nr, L));
    const up = Math.max(0, f.nr[1]);
    let col = mixHex(P.pal.iceDeep, P.pal.ice, 0.25 + 0.55 * lit + 0.25 * up);
    if (tint) col = mixHex(col, tint, 0.55 - 0.22 * lit);
    let op = f.front ? 0.30 + 0.38 * lit + 0.12 * up : 0.15;
    op = Math.min(0.85, op + extraOp);
    const d = "M" + f.idx.map((i) => scr[i][0].toFixed(1) + " " + scr[i][1].toFixed(1)).join("L") + "Z";
    s += `<path d="${d}" fill="${col}" fill-opacity="${op.toFixed(2)}"`
       + ` stroke="${col}" stroke-opacity="${(op * 0.9).toFixed(2)}" stroke-width="5" stroke-linejoin="round"/>`;
    if (f.front) {
      // frosty haze on lit faces
      s += `<path d="${d}" fill="${P.pal.spark}" fill-opacity="${(0.05 + 0.13 * lit).toFixed(2)}"/>`;
      s += `<path d="${d}" fill="none" stroke="${P.pal.spark}" stroke-opacity="${(0.16 + 0.30 * lit).toFixed(2)}"`
         + ` stroke-width="1.6" stroke-linejoin="round"/>`;
    }
  }
  // brightest top edge catch-light
  const top = faces.filter((f) => f.front).sort((a, b) => dot3(b.nr, L) - dot3(a.nr, L))[0];
  if (top) {
    const [a, b] = [scr[top.idx[0]], scr[top.idx[1]]];
    s += `<path d="M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}"`
       + ` stroke="${P.pal.spark}" stroke-opacity="0.85" stroke-width="2.4" stroke-linecap="round"/>`;
  }
  return s;
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm3(v) { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

// ---- the scene --------------------------------------------------------
function buildScene(P) {
  const { pal, banded, nb } = P;
  const cx = 400;
  const rimY = 128;
  const botY = 492;                       // outer bottom (on the table)
  const rimRx = P.rimRx, baseRx = rimRx * P.taper;
  const q = CAM_Q;
  const rimRy = rimRx * q, baseRy = baseRx * q;
  const wallT = 11;
  const baseH = 54;                       // thick glass slab
  const inBotY = botY - baseH;            // interior floor
  const rxAt = (y) => baseRx + (rimRx - baseRx) * ((botY - y) / (botY - rimY));
  const inRxAt = (y) => rxAt(y) - wallT;
  const surfY = inBotY - 8 + (rimY + 30 - (inBotY - 8)) * P.fill;
  const surfRx = inRxAt(surfY), surfRy = surfRx * q;
  const tableY = 408;
  const LX = P.lightX;                    // -1 … 1, light side

  // ---- gradients ----
  const defs = [];
  const grad = (id, kind, attrs, body) =>
    defs.push(`<${kind}Gradient id="${id}" ${attrs}>${body}</${kind}Gradient>`);

  grad("bg", "linear", `x1="0" y1="0" x2="0" y2="1"`,
    stops([pal.bgTop, pal.bgBot], banded, nb));
  grad("glow", "radial", `cx="50%" cy="50%" r="50%"`,
    stops([pal.glow, pal.glow], banded, Math.max(3, nb - 3), [0.55, 0]));
  grad("table", "linear", `x1="0" y1="0" x2="0" y2="1"`,
    stops([pal.tableTop, pal.tableBot], banded, nb));
  grad("whisky", "linear",
    `x1="${0.5 - 0.35 * LX}" y1="0" x2="${0.5 + 0.35 * LX}" y2="1"`,
    stops(pal.whisky, banded, nb));
  grad("wcore", "radial", `cx="${50 + 22 * LX}%" cy="78%" r="62%"`,
    stops([pal.accent, pal.accent], banded, Math.max(3, nb - 4), [0.5, 0]));
  grad("surf", "linear", `x1="${LX > 0 ? 1 : 0}" y1="0" x2="${LX > 0 ? 0 : 1}" y2="0"`,
    stops(pal.surface, banded, nb));
  grad("streak", "linear", `x1="0" y1="0" x2="0" y2="1"`,
    stops(["#ffffff", "#ffffff"], banded, Math.max(3, nb - 4), [0.5, 0.03]));
  grad("caustic", "radial", `cx="50%" cy="50%" r="50%"`,
    stops([pal.accent, pal.accent], banded, Math.max(3, nb - 3), [0.6, 0]));
  grad("shadow", "radial", `cx="50%" cy="50%" r="50%"`,
    stops(["#000000", "#000000"], banded, Math.max(3, nb - 4), [0.62, 0]));
  grad("rimlight", "linear", `x1="0" y1="0" x2="1" y2="0"`,
    stops(["#ffffff", "#ffffff", "#ffffff"], false, 0, [0, 0.8, 0]));
  grad("reflFade", "linear", `x1="0" y1="0" x2="0" y2="1"`,
    `<stop offset="0%" stop-color="${pal.tableTop}" stop-opacity="0"/>` +
    `<stop offset="90%" stop-color="${pal.tableBot}" stop-opacity="1"/>`);
  grad("baseGlass", "linear", `x1="0" y1="0" x2="0" y2="1"`,
    stops([rampAt(pal.whisky, 0.75), rampAt(pal.whisky, 0.35), "#0e0906"], banded, nb, [0.9, 0.95, 1]));
  grad("vign", "radial", `cx="50%" cy="42%" r="72%"`,
    `<stop offset="55%" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="#000" stop-opacity="0.42"/>`);

  // ---- shared paths ----
  // outer glass silhouette
  const glassPath =
    `M${cx - rimRx} ${rimY}` +
    `C${cx - rimRx - 2} ${rimY + 130} ${cx - baseRx - 3} ${botY - baseRy - 90} ${cx - baseRx} ${botY - baseRy}` +
    `A${baseRx} ${baseRy} 0 0 0 ${cx + baseRx} ${botY - baseRy}` +
    `C${cx + baseRx + 3} ${botY - baseRy - 90} ${cx + rimRx + 2} ${rimY + 130} ${cx + rimRx} ${rimY}` +
    `A${rimRx} ${rimRy} 0 0 0 ${cx - rimRx} ${rimY}Z`;
  // interior region, open at the top (clips the cubes to inside the glass)
  const inRimRx = rimRx - wallT, inBotRx = inRxAt(inBotY);
  const interiorClip =
    `M${cx - inRimRx} 0 L${cx - inRimRx} ${rimY}` +
    `C${cx - inRimRx - 2} ${rimY + 120} ${cx - inBotRx - 2} ${inBotY - 80} ${cx - inBotRx} ${inBotY}` +
    `A${inBotRx} ${inBotRx * q} 0 0 0 ${cx + inBotRx} ${inBotY}` +
    `C${cx + inBotRx + 2} ${inBotY - 80} ${cx + inRimRx + 2} ${rimY + 120} ${cx + inRimRx} ${rimY}` +
    `L${cx + inRimRx} 0 Z`;
  // waterline arc (sags toward the viewer)
  const sag = surfRy * 0.62;
  const aboveClip =
    `M0 0 H${VB_W} V${surfY} H${cx + surfRx}` +
    `A${surfRx} ${sag} 0 0 0 ${cx - surfRx} ${surfY}` +
    `H0 Z`;
  const belowClip =
    `M0 ${surfY} H${cx - surfRx}` +
    `A${surfRx} ${sag} 0 0 0 ${cx + surfRx} ${surfY}` +
    `H${VB_W} V${VB_H} H0 Z`;
  defs.push(`<clipPath id="cInterior"><path d="${interiorClip}"/></clipPath>`);
  defs.push(`<clipPath id="cAbove"><path d="${aboveClip}"/></clipPath>`);
  defs.push(`<clipPath id="cBelow"><path d="${belowClip}"/></clipPath>`);

  // whiskey body: surface down the walls to the interior floor
  const whiskyPath =
    `M${cx - surfRx} ${surfY}` +
    `C${cx - surfRx - 2} ${surfY + (inBotY - surfY) * 0.55} ${cx - inBotRx - 2} ${inBotY - 40} ${cx - inBotRx} ${inBotY}` +
    `A${inBotRx} ${inBotRx * q} 0 0 0 ${cx + inBotRx} ${inBotY}` +
    `C${cx + inBotRx + 2} ${inBotY - 40} ${cx + surfRx + 2} ${surfY + (inBotY - surfY) * 0.55} ${cx + surfRx} ${surfY}` +
    `A${surfRx} ${sag} 0 0 1 ${cx - surfRx} ${surfY}Z`;

  // ---- ice cubes ----
  const rnd = mulberry32((P.seed * 2654435761) >>> 0 || 1);
  const cubes = [];
  const e = inBotRx * 1.12 * P.iceSize;
  for (let k = 0; k < P.cubes; k++) {
    const stackY = inBotY - e * 0.5 - k * e * 0.44;
    cubes.push({
      cx0: cx + (k % 2 === 0 ? -1 : 1) * (10 + rnd() * 22) + (rnd() - 0.5) * 8,
      cy0: stackY - rnd() * 6,
      e: e * (0.94 + rnd() * 0.12),
      yaw: rnd() * Math.PI,
      tilt: (0.14 + 0.18 * rnd() + k * 0.14) * (rnd() < 0.5 ? 1 : -1),
      roll: (rnd() - 0.5) * (0.3 + k * 0.3),
    });
  }
  const CP = { lightX: LX, pal };
  const tintCol = rampAt(pal.whisky, 0.68);
  let cubesBelow = "", cubesAbove = "";
  for (const c of cubes) {
    cubesBelow += cubeSvg(c, CP, tintCol, 0.14, 6 * LX + 3);
    cubesAbove += cubeSvg(c, CP, null, 0.06, 0);
  }

  // ---- assemble ----
  const b = [];
  b.push(`<rect width="${VB_W}" height="${VB_H}" fill="url(#bg)"/>`);
  b.push(`<ellipse cx="${cx - 60 * LX}" cy="${rimY + 130}" rx="380" ry="270" fill="url(#glow)"/>`);
  b.push(`<rect x="0" y="${tableY}" width="${VB_W}" height="${VB_H - tableY}" fill="url(#table)"/>`);

  // reflection on the table
  b.push(`<g transform="translate(0 ${2 * botY}) scale(1 -1)" opacity="0.30">` +
    `<g transform="translate(0 ${botY * 0.0}) scale(1 0.55) translate(0 ${botY * 0.818})">` +
    `<path d="${glassPath}" fill="#ffffff" fill-opacity="0.05"/>` +
    `<path d="${whiskyPath}" fill="url(#whisky)" opacity="0.7"/>` +
    `<rect x="${cx - baseRx}" y="${inBotY}" width="${2 * baseRx}" height="${baseH}" fill="url(#baseGlass)" opacity="0.8"/>` +
    `</g></g>`);
  b.push(`<rect x="0" y="${botY - 2}" width="${VB_W}" height="${VB_H - botY + 2}" fill="url(#reflFade)"/>`);

  // contact shadow + caustic patch thrown past the glass
  b.push(`<ellipse cx="${cx + 6 * LX}" cy="${botY + 6}" rx="${baseRx + 34}" ry="17" fill="url(#shadow)"/>`);
  b.push(`<ellipse cx="${cx - LX * (baseRx + 86)}" cy="${botY + 13}" rx="120" ry="20" fill="url(#caustic)" opacity="0.85"/>`);
  b.push(`<ellipse cx="${cx - LX * (baseRx + 66)}" cy="${botY + 11}" rx="56" ry="9" fill="${pal.spark}" opacity="${banded ? 0.5 : 0.32}"/>`);

  // glass body film + wall edges + back rim
  b.push(`<path d="${glassPath}" fill="#ffffff" fill-opacity="0.045"/>`);
  b.push(`<path d="M${cx - rimRx} ${rimY} C${cx - rimRx - 2} ${rimY + 130} ${cx - baseRx - 3} ${botY - baseRy - 90} ${cx - baseRx} ${botY - baseRy}"` +
    ` fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1.6"/>`);
  b.push(`<path d="M${cx + rimRx} ${rimY} C${cx + rimRx + 2} ${rimY + 130} ${cx + baseRx + 3} ${botY - baseRy - 90} ${cx + baseRx} ${botY - baseRy}"` +
    ` fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1.6"/>`);
  b.push(`<path d="M${cx - rimRx} ${rimY} A${rimRx} ${rimRy} 0 0 1 ${cx + rimRx} ${rimY}"` +
    ` fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>`);

  // whiskey
  b.push(`<path d="${whiskyPath}" fill="url(#whisky)"/>`);
  b.push(`<path d="${whiskyPath}" fill="url(#wcore)"/>`);
  // caustic crescents inside the pour
  b.push(`<path d="M${cx - inBotRx * 0.72} ${inBotY - 6}` +
    ` Q${cx - LX * 30} ${inBotY - 34} ${cx + inBotRx * 0.72} ${inBotY - 8}` +
    ` Q${cx - LX * 20} ${inBotY - 16} ${cx - inBotRx * 0.72} ${inBotY - 6}Z"` +
    ` fill="${pal.accent}" opacity="${banded ? 0.5 : 0.35}"/>`);

  // submerged ice (tinted, refraction-shifted), then the liquid film in front
  b.push(`<g clip-path="url(#cInterior)"><g clip-path="url(#cBelow)">${cubesBelow}</g></g>`);
  // a few tiny bubbles clinging near the ice
  let bub = "";
  for (let i = 0; i < 7; i++) {
    const bxp = cx + (rnd() - 0.5) * surfRx * 1.5;
    const byp = surfY + 14 + rnd() * Math.max(8, inBotY - surfY - 26);
    bub += `<circle cx="${bxp.toFixed(0)}" cy="${byp.toFixed(0)}" r="${(1.4 + rnd() * 1.9).toFixed(1)}"` +
      ` fill="${pal.spark}" opacity="${(0.18 + rnd() * 0.22).toFixed(2)}"/>`;
  }
  b.push(`<g clip-path="url(#cInterior)">${bub}</g>`);
  b.push(`<path d="${whiskyPath}" fill="url(#whisky)" opacity="0.34"/>`);

  // liquid surface (darker toward the back edge, bright meniscus in front)
  b.push(`<ellipse cx="${cx}" cy="${surfY}" rx="${surfRx}" ry="${surfRy}" fill="url(#surf)" opacity="0.88"/>`);
  b.push(`<path d="M${cx - surfRx} ${surfY} A${surfRx} ${surfRy} 0 0 1 ${cx + surfRx} ${surfY}"` +
    ` fill="none" stroke="${rampAt(pal.whisky, 0.12)}" stroke-opacity="0.6" stroke-width="2.4"/>`);
  b.push(`<path d="M${cx - surfRx} ${surfY} A${surfRx} ${surfRy} 0 0 0 ${cx + surfRx} ${surfY}"` +
    ` fill="none" stroke="${pal.accent}" stroke-opacity="0.6" stroke-width="1.6"/>`);

  // meniscus shadow where each cube pierces the surface — seats it in the pour
  for (const c of cubes) {
    const topY = c.cy0 - c.e * 0.78;
    if (topY < surfY) {                    // cube actually breaks the surface
      const dx = Math.min(0.92, Math.abs(c.cx0 - cx) / surfRx);
      const yseat = surfY + sag * Math.sqrt(1 - dx * dx) * 0.85;
      b.push(`<ellipse cx="${c.cx0}" cy="${yseat.toFixed(1)}" rx="${(c.e * 0.58).toFixed(0)}"` +
        ` ry="${(c.e * 0.58 * CAM_Q * 0.8).toFixed(1)}" fill="${rampAt(pal.whisky, 0.22)}" opacity="0.5"/>`);
    }
  }
  // ice above the waterline
  b.push(`<g clip-path="url(#cInterior)"><g clip-path="url(#cAbove)">${cubesAbove}</g></g>`);
  // waterline catch-light across the cubes
  if (P.cubes > 0) {
    b.push(`<path d="M${cx - surfRx * 0.9} ${surfY + sag * 0.35}` +
      ` A${surfRx * 0.9} ${sag * 0.9} 0 0 0 ${cx + surfRx * 0.9} ${surfY + sag * 0.35}"` +
      ` fill="none" stroke="${pal.spark}" stroke-opacity="0.28" stroke-width="2"/>`);
  }

  // thick glass base: refracted amber slab + bright streaks
  const bx = cx - baseRx + 3;
  b.push(`<path d="M${bx} ${inBotY} H${cx + baseRx - 3} V${botY - 10}` +
    ` A${baseRx - 3} ${(baseRx - 3) * q} 0 0 1 ${bx} ${botY - 10} Z" fill="url(#baseGlass)" opacity="0.92"/>`);
  b.push(`<ellipse cx="${cx - LX * baseRx * 0.35}" cy="${inBotY + baseH * 0.45}" rx="${baseRx * 0.62}" ry="7"` +
    ` fill="${pal.accent}" opacity="${banded ? 0.55 : 0.4}"/>`);
  b.push(`<ellipse cx="${cx + LX * baseRx * 0.4}" cy="${inBotY + baseH * 0.7}" rx="${baseRx * 0.3}" ry="4"` +
    ` fill="${pal.spark}" opacity="0.5"/>`);
  b.push(`<path d="M${cx - baseRx} ${botY - baseRy} A${baseRx} ${baseRy} 0 0 0 ${cx + baseRx} ${botY - baseRy}"` +
    ` fill="none" stroke="${pal.spark}" stroke-opacity="0.5" stroke-width="2.2"/>`);

  // wall shading + speculars
  const sxL = cx - rimRx + wallT * 0.5, sxR = cx + rimRx - wallT * 0.5;
  const streakX = LX >= 0 ? sxL + 8 : sxR - 22;
  b.push(`<path d="M${streakX} ${rimY + 26} q-6 130 ${LX >= 0 ? 8 : -8} 300 l14 0 q${LX >= 0 ? -12 : 12} -170 -4 -300 Z"` +
    ` fill="url(#streak)" opacity="0.8"/>`);
  const thinX = LX >= 0 ? sxR - 10 : sxL + 10;
  b.push(`<path d="M${thinX} ${rimY + 40} q${LX >= 0 ? 4 : -4} 150 ${LX >= 0 ? 2 : -2} 250"` +
    ` fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="3.4" stroke-linecap="round"/>`);
  // front rim + specular bite
  b.push(`<path d="M${cx - rimRx} ${rimY} A${rimRx} ${rimRy} 0 0 0 ${cx + rimRx} ${rimY}"` +
    ` fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2.4"/>`);
  b.push(`<path d="M${cx - LX * rimRx * 0.8 - 30} ${rimY + (LX > 0 ? rimRy * 0.86 : -rimRy * 0.86)} h60"` +
    ` fill="none" stroke="url(#rimlight)" stroke-width="4" stroke-linecap="round"/>`);

  b.push(`<rect width="${VB_W}" height="${VB_H}" fill="url(#vign)"/>`);

  return `<defs>${defs.join("")}</defs>${b.join("")}`;
}

// ---- UI --------------------------------------------------------------
function Slider({ label, value, min, max, step, onChange, fmt }) {
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

function Toggle({ label, value, onChange }) {
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

function useWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export default function WhiskeyGlass() {
  const width = useWidth();
  const isNarrow = width < 820;

  const [seed, setSeed] = useState(3);
  const [cubes, setCubes] = useState(2);
  const [iceSize, setIceSize] = useState(1);
  const [fill, setFill] = useState(0.5);
  const [rimRx, setRimRx] = useState(128);
  const [taper, setTaper] = useState(0.9);
  const [lightX, setLightX] = useState(0.6);
  const [palette, setPalette] = useState("Speakeasy");
  const [banded, setBanded] = useState(false);
  const [nb, setNb] = useState(7);
  const [svgOut, setSvgOut] = useState(null);
  const [copied, setCopied] = useState(false);

  const inner = useMemo(() => buildScene({
    pal: PALETTES[palette], seed, cubes, iceSize, fill, rimRx, taper, lightX, banded, nb,
  }), [palette, seed, cubes, iceSize, fill, rimRx, taper, lightX, banded, nb]);

  const buildSvg = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">${inner}</svg>`;
  const downloadSVG = () => {
    const svg = buildSvg();
    try {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a");
      a.href = url; a.download = "whiskey-glass.svg";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { /* sandbox may block downloads */ }
    setSvgOut(svg);
  };
  const copySvg = () => {
    if (svgOut && navigator.clipboard) {
      navigator.clipboard.writeText(svgOut).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
    }
  };

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
  const chip = (on) => ({
    flex: "1 0 40%", padding: "8px 6px", fontSize: 11, borderRadius: 7,
    cursor: "pointer", fontFamily: "ui-monospace, monospace",
    background: on ? "#27424b" : "#1a232c",
    color: on ? "#dff1f6" : "#9fb0c0",
    border: "1px solid " + (on ? "#3f7e8f" : "#26313c"),
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0b0f14", color: "#e6eef5",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      padding: isNarrow ? "16px 12px 50px" : "22px 16px 60px" }}>
      <style>{`
        input[type=range]{ -webkit-appearance:none; appearance:none; background:transparent; touch-action:pan-y; }
        input[type=range]::-webkit-slider-runnable-track{ height:5px; border-radius:3px; background:#2a3640; }
        input[type=range]::-moz-range-track{ height:5px; border-radius:3px; background:#2a3640; }
        input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:24px; height:24px; border-radius:50%; background:#5fb6c9; margin-top:-10px; box-shadow:0 1px 4px rgba(0,0,0,.6); }
        input[type=range]::-moz-range-thumb{ width:24px; height:24px; border:none; border-radius:50%; background:#5fb6c9; box-shadow:0 1px 4px rgba(0,0,0,.6); }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ marginBottom: isNarrow ? 12 : 18 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "#5f7384",
            fontFamily: "ui-monospace, monospace" }}>VECTOR STILL LIFE · GRADIENTS ONLY, NO RASTER</div>
          <h1 style={{ fontSize: isNarrow ? 21 : 27, margin: "4px 0 4px", fontWeight: 600,
            fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: -0.2 }}>
            Whiskey Glass Studio
          </h1>
          {!isNarrow && (
            <p style={{ fontSize: 13.5, color: "#8a9bab", maxWidth: 620, lineHeight: 1.5, margin: 0 }}>
              A rocks glass, a pour of whiskey, real 3D ice — lit, projected and split
              at the waterline, all drawn with SVG gradients. Flip on poster bands to
              quantize the same scene into flat color regions.
            </p>
          )}
        </header>

        <div style={{ display: isNarrow ? "block" : "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16, alignItems: "start" }}>

          {/* PREVIEW */}
          <div style={{ background: "#05080b", borderRadius: 14, border: "1px solid #1b2530",
            overflow: "hidden", position: "sticky",
            top: isNarrow ? 8 : 22, zIndex: 5,
            marginBottom: isNarrow ? 14 : 0,
            boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }}>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`}
              style={{ width: "100%", display: "block" }}
              dangerouslySetInnerHTML={{ __html: inner }} />
          </div>

          {/* CONTROLS */}
          <div>
            <div style={panel}>
              <div style={heading}>The pour</div>
              <Slider label="Whiskey fill" value={fill} min={0.15} max={0.75} step={0.01}
                onChange={setFill} fmt={(v) => Math.round(v * 100) + "%"} />
              <Slider label="Ice cubes" value={cubes} min={0} max={4} step={1} onChange={setCubes} />
              {cubes > 0 && (
                <Slider label="Ice size" value={iceSize} min={0.6} max={1.35} step={0.05}
                  onChange={setIceSize} fmt={(v) => v.toFixed(2) + "×"} />
              )}
              <button onClick={() => setSeed((s) => s + 1)}
                style={{ width: "100%", padding: "9px", borderRadius: 8, cursor: "pointer",
                  background: "#1a232c", color: "#9fd0d9", border: "1px solid #2f6b78",
                  fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                ⟳ re-drop the ice · #{seed}
              </button>
            </div>

            <div style={panel}>
              <div style={heading}>Glass & light</div>
              <Slider label="Glass width" value={rimRx} min={104} max={150} step={2} onChange={setRimRx} />
              <Slider label="Taper" value={taper} min={0.78} max={1} step={0.01}
                onChange={setTaper} fmt={(v) => v.toFixed(2)} />
              <Slider label="Light direction" value={lightX} min={-1} max={1} step={0.05}
                onChange={setLightX} fmt={(v) => (v < -0.1 ? "← left" : v > 0.1 ? "right →" : "front")} />
            </div>

            <div style={panel}>
              <div style={heading}>Mood</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {Object.keys(PALETTES).map((p) => (
                  <button key={p} onClick={() => setPalette(p)} style={chip(palette === p)}>{p}</button>
                ))}
              </div>
              <Toggle label="Poster bands (flat regions)" value={banded} onChange={setBanded} />
              {banded && (
                <Slider label="Bands" value={nb} min={3} max={14} step={1} onChange={setNb} />
              )}
            </div>

            <button onClick={downloadSVG}
              style={{ width: "100%", background: "#2f6b78", border: "none", color: "#f1fbff",
                padding: "12px", borderRadius: 10, cursor: "pointer", fontSize: 13.5,
                fontWeight: 600, letterSpacing: 0.3 }}>
              Export SVG
            </button>

            {svgOut && (
              <div style={{ ...panel, marginTop: 12, marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ ...heading, margin: 0, flex: 1 }}>Export</span>
                  <button onClick={() => setSvgOut(null)}
                    style={{ ...miniBtn, flex: "none", padding: "4px 10px" }}>close</button>
                </div>
                <div style={{ fontSize: 10.5, color: "#8a9bab", marginBottom: 10, lineHeight: 1.5 }}>
                  A download may have started. If not (some sandboxes block it), use a button below.
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <button onClick={copySvg}
                    style={{ flex: 1, background: "#2f6b78", border: "none", color: "#f1fbff",
                      padding: "11px", borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                    {copied ? "Copied ✓" : "Copy SVG code"}
                  </button>
                  <a href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgOut)}`}
                    download="whiskey-glass.svg" target="_blank" rel="noopener noreferrer"
                    style={{ flex: 1, background: "#1a232c", color: "#cfe6ec", textAlign: "center",
                      padding: "11px", borderRadius: 9, fontSize: 13, fontWeight: 600,
                      textDecoration: "none", border: "1px solid #2f6b78" }}>
                    Open / save
                  </a>
                </div>
                <textarea readOnly value={svgOut} onFocus={(e) => e.target.select()}
                  style={{ width: "100%", height: 90, resize: "vertical", boxSizing: "border-box",
                    background: "#0b1118", color: "#9fb0c0", border: "1px solid #26313c",
                    borderRadius: 8, padding: 8, fontSize: 10.5, fontFamily: "ui-monospace, monospace" }} />
                <div style={{ fontSize: 10, color: "#5f7384", marginTop: 6, fontFamily: "ui-monospace, monospace" }}>
                  Or select all in the box above and copy. {(svgOut.length / 1024).toFixed(0)} KB.
                </div>
              </div>
            )}

            <p style={{ fontSize: 10.5, color: "#5f7384", marginTop: 8, lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace" }}>
              Pure vector: gradients, paths and clips only — no blur filters, so it
              renders identically in browsers, Figma and cutters.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
