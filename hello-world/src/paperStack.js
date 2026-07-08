// Pure graph algorithms behind the layered-paper stack export (the geometry
// half — contouring sheet outlines — lives in WaterReflectionContours.jsx).
//
// Model: the scene is a set of colored regions (maximal 4-connected
// same-color areas of the sample grid) plus a virtual "frame" node adjacent
// to every region on the border. A stack is built by growing a blob outward
// from the frame: each step picks one color present on the blob's frontier,
// absorbs every frontier region of that color, and emits one sheet of that
// color shaped as the cumulative union. ANY order yields a valid stack —
// sheets stay contiguous (the blob is connected) and nested (unions only
// grow), so the image is reproduced exactly. Order only changes HOW MANY
// sheets get cut.
//
// Minimizing that count is the interesting part:
//
//  * Dominance: absorbing the whole same-color frontier is never worse than
//    a subset — a bigger blob at the same sheet count exposes a superset of
//    the frontier forever after. So a plan is just a color sequence.
//
//  * Gathering: a color appearing at several depths wants to be delayed
//    until several of its regions reach the frontier together and share one
//    sheet — but delaying is not free when the color gates a deep chain.
//
//  * Hardness: for a design of independent nested motifs on one background,
//    a color sequence completes the design iff it contains each motif's
//    inside-out color string as a subsequence. Minimum sheets there IS the
//    Shortest Common Supersequence problem (NP-hard in general), so no
//    simple greedy rule can be always-optimal — paperStack.test.js has
//    concrete traps. planCollapse therefore runs greedy heuristics, checks
//    them against an admissible lower bound (optimal when they meet it),
//    and otherwise runs a budgeted exact A* search, falling back to the
//    best greedy answer when the budget runs out.

// ---- region extraction ---------------------------------------------

// 4-connected components of equal grid value. Returns per-region cell lists.
export function labelRegions(grid, nx, ny) {
  const label = new Int32Array(nx * ny).fill(-1);
  const regions = [];
  const stack = [];
  for (let s = 0; s < nx * ny; s++) {
    if (label[s] !== -1) continue;
    const val = grid[s];
    const id = regions.length;
    const cells = [];
    label[s] = id; stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      cells.push(p);
      const x = p % nx, y = (p / nx) | 0;
      if (x > 0        && label[p - 1]  === -1 && grid[p - 1]  === val) { label[p - 1]  = id; stack.push(p - 1); }
      if (x < nx - 1   && label[p + 1]  === -1 && grid[p + 1]  === val) { label[p + 1]  = id; stack.push(p + 1); }
      if (y > 0        && label[p - nx] === -1 && grid[p - nx] === val) { label[p - nx] = id; stack.push(p - nx); }
      if (y < ny - 1   && label[p + nx] === -1 && grid[p + nx] === val) { label[p + nx] = id; stack.push(p + nx); }
    }
    regions.push({ value: val, cells, size: cells.length });
  }
  return { label, regions };
}

// shared-edge adjacency between labeled regions (4-connectivity)
export function buildAdjacency(label, nRegions, nx, ny) {
  const adj = Array.from({ length: nRegions }, () => new Set());
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x, a = label[p];
      if (x < nx - 1) { const b = label[p + 1];  if (b !== a) { adj[a].add(b); adj[b].add(a); } }
      if (y < ny - 1) { const b = label[p + nx]; if (b !== a) { adj[a].add(b); adj[b].add(a); } }
    }
  }
  return adj;
}

// merge specks: recolor any region smaller than minCells into the neighbor it
// shares the most boundary with. Keeps the sheet count sane on rippled scenes
// (thousands of one-cell islands would otherwise each become their own sheet).
export function denoiseGrid(grid, nx, ny, minCells, maxPasses = 3) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const { label, regions } = labelRegions(grid, nx, ny);
    const border = regions.map(() => new Map());
    const bump = (a, b) => { border[a].set(b, (border[a].get(b) || 0) + 1); };
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const p = y * nx + x, a = label[p];
        if (x < nx - 1) { const b = label[p + 1];  if (b !== a) { bump(a, b); bump(b, a); } }
        if (y < ny - 1) { const b = label[p + nx]; if (b !== a) { bump(a, b); bump(b, a); } }
      }
    }
    let changed = false;
    for (let id = 0; id < regions.length; id++) {
      if (regions[id].size >= minCells) continue;
      let best = -1, bestN = -1;
      for (const [nb, cnt] of border[id]) if (cnt > bestN) { bestN = cnt; best = nb; }
      if (best < 0 || regions[best].value === regions[id].value) continue;
      const nv = regions[best].value;
      for (const p of regions[id].cells) grid[p] = nv;
      changed = true;
    }
    if (!changed) break;
  }
  return grid;
}

// ---- collapse planning ---------------------------------------------

// sheet 0: the frame plus every background-colored region it can gather.
// Absorbing free same-color regions at step 0 is pure dominance — the
// water<->background boundary gets cut once here and never again.
function seedAbsorb(regions, adj, frameId) {
  const absorbed = new Uint8Array(regions.length);
  const frontier = new Set();
  const members = [frameId];
  const frameColor = regions[frameId].color;
  absorbed[frameId] = 1;
  for (const nb of adj[frameId]) if (!absorbed[nb]) frontier.add(nb);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of Array.from(frontier)) {
      if (regions[id].color !== frameColor) continue;
      absorbed[id] = 1; frontier.delete(id); members.push(id);
      for (const nb of adj[id]) if (!absorbed[nb]) frontier.add(nb);
      grew = true;
    }
  }
  return { absorbed, frontier, members };
}

function groupFrontierByColor(regions, frontier) {
  const byColor = new Map();
  for (const id of frontier) {
    const c = regions[id].color;
    let e = byColor.get(c);
    if (!e) { e = { ids: [], area: 0 }; byColor.set(c, e); }
    e.ids.push(id); e.area += regions[id].size;
  }
  return byColor;
}

// Admissible lower bound on the remaining sheet count: the blob advances at
// most one adjacency layer per step, so a region at residual-BFS distance d
// needs >= d more steps; and every distinct remaining color needs >= 1 step
// of its own. Both hold for every plan, so max(ecc, colors) never
// overestimates — and it is consistent (each step drops either term by <= 1),
// which makes the A* below exact.
function residualLowerBound(regions, adj, absorbed) {
  const n = regions.length;
  const dist = new Int32Array(n).fill(-1);
  const q = [];
  for (let i = 0; i < n; i++) {
    if (!absorbed[i]) continue;
    for (const nb of adj[i]) if (!absorbed[nb] && dist[nb] < 0) { dist[nb] = 1; q.push(nb); }
  }
  let ecc = 0;
  const colors = new Set();
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    if (dist[u] > ecc) ecc = dist[u];
    colors.add(regions[u].color);
    for (const nb of adj[u]) if (!absorbed[nb] && dist[nb] < 0) { dist[nb] = dist[u] + 1; q.push(nb); }
  }
  return Math.max(ecc, colors.size);
}

// total-sheet lower bound for a scene (frame sheet included)
export function stackLowerBound(regions, adj, frameId) {
  const { absorbed } = seedAbsorb(regions, adj, frameId);
  return 1 + residualLowerBound(regions, adj, absorbed);
}

// One-pass greedy. Default: absorb the frontier color with the largest area
// (the original export rule). lookahead: simulate each candidate color and
// keep the one whose residual lower bound comes out smallest — this learns to
// "gather" (delay a color until more of its regions reach the frontier); see
// the dead-end-decoy test for a case where area-greedy pays an extra sheet.
export function collapseGreedy(regions, adj, frameId, { lookahead = false } = {}) {
  const { absorbed, frontier, members } = seedAbsorb(regions, adj, frameId);
  const sheets = [{ color: regions[frameId].color, members, frame: true }];
  while (frontier.size) {
    const byColor = groupFrontierByColor(regions, frontier);
    let pick = null, pickE = null, bestScore = Infinity;
    for (const [c, e] of byColor) {
      let use = pick === null;
      if (lookahead) {
        const trial = absorbed.slice();
        for (const id of e.ids) trial[id] = 1;
        const score = residualLowerBound(regions, adj, trial);
        if (!use && score < bestScore) use = true;
        else if (!use && score === bestScore) {
          if (e.ids.length > pickE.ids.length) use = true;
          else if (e.ids.length === pickE.ids.length && e.area > pickE.area) use = true;
        }
        if (use) bestScore = score;
      } else if (!use && e.area > pickE.area) use = true;
      if (use) { pick = c; pickE = e; }
    }
    for (const id of pickE.ids) { absorbed[id] = 1; frontier.delete(id); }
    for (const id of pickE.ids) for (const nb of adj[id]) if (!absorbed[nb]) frontier.add(nb);
    sheets.push({ color: pick, members: pickE.ids });
  }
  return sheets;
}

// Exact minimum-sheet order via A* over absorbed-sets. States are bitmasks;
// one transition per frontier color (dominance makes that WLOG). Returns
//   { sheets }        a plan strictly better than upperBound steps,
//   { proved: true }  search exhausted: nothing beats upperBound (the
//                     incumbent greedy plan is optimal), or
//   null              state/time budget hit — result unknown, keep greedy.
export function collapseOptimal(regions, adj, frameId,
  { maxStates = 60000, timeBudgetMs = 1500, upperBound = Infinity } = {}) {
  const n = regions.length;
  const seed = seedAbsorb(regions, adj, frameId);
  const frameSheet = { color: regions[frameId].color, members: seed.members, frame: true };
  if (seed.frontier.size === 0) return { sheets: [frameSheet] };

  const W = (n + 31) >> 5;
  const bit = (m, i) => (m[i >> 5] >>> (i & 31)) & 1;
  const scratch = new Uint8Array(n);
  const boundOf = (m) => {
    for (let i = 0; i < n; i++) scratch[i] = bit(m, i);
    return residualLowerBound(regions, adj, scratch);
  };

  const startMask = new Uint32Array(W);
  for (let i = 0; i < n; i++) if (seed.absorbed[i]) startMask[i >> 5] |= 1 << (i & 31);
  const startKey = startMask.join(",");
  const h0 = boundOf(startMask);
  if (h0 >= upperBound) return { proved: true };   // incumbent already meets the bound

  // key -> { mask, g, count, parent, color, ids, closed }
  const nodes = new Map();
  nodes.set(startKey, { mask: startMask, g: 0, count: seed.members.length,
    parent: null, color: null, ids: null, closed: false });

  // binary min-heap on f, ties toward larger g (dig toward goals first)
  const heap = [[h0, 0, startKey]];
  const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] > b[1]);
  const push = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i], heap[p])) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let b = i;
        if (l < heap.length && before(heap[l], heap[b])) b = l;
        if (r < heap.length && before(heap[r], heap[b])) b = r;
        if (b === i) break;
        const t = heap[b]; heap[b] = heap[i]; heap[i] = t; i = b;
      }
    }
    return top;
  };

  const t0 = Date.now();
  let ticks = 0;
  while (heap.length) {
    if (nodes.size > maxStates) return null;
    if ((++ticks & 63) === 0 && Date.now() - t0 > timeBudgetMs) return null;
    const [, g, key] = pop();
    const node = nodes.get(key);
    if (node.closed || node.g !== g) continue;   // stale heap entry
    node.closed = true;
    if (node.count === n) {                       // goal: everything absorbed
      const rev = [];
      for (let cur = node; cur.parent; cur = nodes.get(cur.parent))
        rev.push({ color: cur.color, members: cur.ids });
      rev.reverse();
      return { sheets: [frameSheet, ...rev] };
    }
    const frontier = new Set();
    for (let i = 0; i < n; i++) {
      if (!bit(node.mask, i)) continue;
      for (const nb of adj[i]) if (!bit(node.mask, nb)) frontier.add(nb);
    }
    for (const [c, e] of groupFrontierByColor(regions, frontier)) {
      const m2 = node.mask.slice();
      for (const id of e.ids) m2[id >> 5] |= 1 << (id & 31);
      const k2 = m2.join(","), g2 = g + 1;
      const seen = nodes.get(k2);
      if (seen && seen.g <= g2) continue;
      const f2 = g2 + boundOf(m2);
      if (f2 >= upperBound) continue;             // cannot beat the incumbent
      nodes.set(k2, { mask: m2, g: g2, count: node.count + e.ids.length,
        parent: key, color: c, ids: e.ids, closed: false });
      push([f2, g2, k2]);
    }
  }
  return { proved: true };   // search space exhausted below upperBound
}

// Facade: best greedy plan, certified optimal when it meets the lower bound,
// otherwise improved (or proved optimal) by budgeted exact search.
export function planCollapse(regions, adj, frameId, opts = {}) {
  const gArea = collapseGreedy(regions, adj, frameId);
  const gLook = collapseGreedy(regions, adj, frameId, { lookahead: true });
  const best = gLook.length <= gArea.length ? gLook : gArea;
  const lowerBound = stackLowerBound(regions, adj, frameId);
  if (best.length <= lowerBound) return { sheets: best, method: "optimal", lowerBound };
  if (regions.length <= (opts.maxExactRegions ?? 800)) {
    const exact = collapseOptimal(regions, adj, frameId, { ...opts, upperBound: best.length - 1 });
    if (exact && exact.sheets) return { sheets: exact.sheets, method: "optimal", lowerBound };
    if (exact && exact.proved) return { sheets: best, method: "optimal", lowerBound };
  }
  return { sheets: best, method: "greedy", lowerBound };
}
