import {
  labelRegions, buildAdjacency, denoiseGrid,
  collapseGreedy, collapseOptimal, planCollapse, stackLowerBound,
} from "./paperStack";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Star-of-motifs builder: a background/frame node plus one nested chain of
// regions per motif, given as inside-out color strings. This is the exact
// shape of "several nested blobs on one background" — e.g. petal ["B","R","B"]
// is a blue disc containing a red annulus containing a blue disc.
// A plan completes a star iff its color sequence contains every petal string
// as a subsequence, so minimum sheets = 1 + shortest common supersequence.
function star(petals, sizes = null) {
  const regions = [];
  const adj = [];
  const addNode = (color, size) => {
    regions.push({ color, size, cells: [] });
    adj.push(new Set());
    return regions.length - 1;
  };
  const link = (a, b) => { adj[a].add(b); adj[b].add(a); };
  const frameId = addNode("BG", 1000);
  petals.forEach((colors, p) => {
    let prev = frameId;
    colors.forEach((c, i) => {
      const id = addNode(c, (sizes && sizes[p] && sizes[p][i]) || 1);
      link(prev, id);
      prev = id;
    });
  });
  return { regions, adj, frameId };
}

// Independent reference: plain breadth-first search over absorbed-sets with
// no heuristics, pruning, or bitmask tricks. Deliberately re-implements the
// transition semantics so it can cross-check collapseOptimal.
function bruteMinSheets(regions, adj, frameId, capSteps = 12) {
  const n = regions.length;
  const bg = regions[frameId].color;
  const start = new Uint8Array(n);
  start[frameId] = 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (start[i] || regions[i].color !== bg) continue;
      if ([...adj[i]].some((j) => start[j])) { start[i] = 1; changed = true; }
    }
  }
  const done = (m) => m.every((v) => v);
  if (done(start)) return 1;
  let layer = new Map([[start.join(""), start]]);
  for (let steps = 1; steps <= capSteps; steps++) {
    const next = new Map();
    for (const m of layer.values()) {
      const colors = new Set();
      for (let i = 0; i < n; i++)
        if (!m[i] && [...adj[i]].some((j) => m[j])) colors.add(regions[i].color);
      for (const c of colors) {
        const m2 = m.slice();
        for (let i = 0; i < n; i++)
          if (!m2[i] && regions[i].color === c && [...adj[i]].some((j) => m[j])) m2[i] = 1;
        if (done(m2)) return 1 + steps;
        next.set(m2.join(""), m2);
      }
    }
    layer = next;
  }
  throw new Error("bruteMinSheets: cap exceeded");
}

// deterministic RNG for the fuzz test
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// random nesting tree: node 0 is the background/frame, every other node hangs
// off a random earlier node with a color different from its parent's
function randomTree(rng, nNodes, colors) {
  const regions = [{ color: "BG", size: 1000, cells: [] }];
  const adj = [new Set()];
  for (let i = 1; i < nNodes; i++) {
    const parent = Math.floor(rng() * i);
    let c;
    do { c = colors[Math.floor(rng() * colors.length)]; } while (c === regions[parent].color);
    regions.push({ color: c, size: 1 + Math.floor(rng() * 9), cells: [] });
    adj.push(new Set());
    adj[i].add(parent); adj[parent].add(i);
  }
  return { regions, adj, frameId: 0 };
}

const colorsOf = (sheets) => sheets.map((s) => s.color);

/* ------------------------------------------------------------------ *
 * Baselines: cases where greedy IS optimal
 * ------------------------------------------------------------------ */

test("bullseye: a single nested motif is a forced path — greedy is optimal", () => {
  const g = star([["R", "B", "R"]]);
  // only one frontier region exists at every step; nothing to choose
  expect(collapseGreedy(g.regions, g.adj, g.frameId)).toHaveLength(4);
  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(4);
  expect(plan.method).toBe("optimal"); // greedy met the lower bound
  expect(colorsOf(plan.sheets)).toEqual(["BG", "R", "B", "R"]);
});

test("background-colored petal head merges into the frame sheet", () => {
  const g = star([["BG", "R"]]); // a background-colored blob with a red disc inside
  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(2);
  expect(plan.sheets[0].members).toHaveLength(2); // frame + BG blob, one sheet
});

/* ------------------------------------------------------------------ *
 * Greedy-by-area is NOT optimal
 * ------------------------------------------------------------------ */

test("dead-end decoy: area-greedy rushes the big color and pays an extra sheet", () => {
  // Scene: on the background, (a) one HUGE red disc, and (b) a small blue
  // disc containing a red annulus containing a blue disc.
  //
  //   area-greedy: R(huge) . B . R . B      -> 5 sheets
  //   optimal:     B . R(huge + annulus) . B -> 4 sheets
  //
  // Waiting one step lets BOTH red regions reach the frontier together and
  // share a single sheet of red paper — the "gathering" principle. Greedy
  // rushes the big red, then meets red again one level deeper.
  const g = star([["R"], ["B", "R", "B"]], [[50], [1, 1, 1]]);

  const area = collapseGreedy(g.regions, g.adj, g.frameId);
  expect(colorsOf(area)).toEqual(["BG", "R", "B", "R", "B"]); // 5 sheets

  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(4);
  expect(plan.method).toBe("optimal");
  expect(colorsOf(plan.sheets)).toEqual(["BG", "B", "R", "B"]);
  // the red step really did gather both red regions onto one sheet
  expect(plan.sheets[2].members).toHaveLength(2);
});

test("interleaved motifs: minimum sheets = shortest common supersequence", () => {
  // petals "R,B" (big head) and "B,R,B". SCS("RB","BRB") = "BRB" (RB is a
  // subsequence of BRB), so 1+3 = 4 sheets suffice; area-greedy burns 5.
  const g = star([["R", "B"], ["B", "R", "B"]], [[50, 1], [1, 1, 1]]);
  expect(collapseGreedy(g.regions, g.adj, g.frameId)).toHaveLength(5);
  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(4);
  expect(colorsOf(plan.sheets)).toEqual(["BG", "B", "R", "B"]);
});

/* ------------------------------------------------------------------ *
 * Even the lookahead greedy is NOT optimal
 *
 * Found by exhaustively comparing both greedy rules against brute force
 * over every pair of nested motifs with petals of length <= 4 over three
 * colors (4529 instances): area-greedy loses on 1489 of them (worst: +3
 * sheets), lookahead-greedy still loses on 594 (worst: +2). The exact
 * planner matched brute force on all 4529. No greedy rule we tried
 * survives — consistent with the problem containing Shortest Common
 * Supersequence, so a search is genuinely required for the minimum.
 * ------------------------------------------------------------------ */

test("worst area-greedy gap found: 8 sheets where 5 suffice", () => {
  // petals "A,B,C" and "C,A,B,C": SCS is "CABC" itself (ABC is one of its
  // subsequences), so 5 sheets total. Area-greedy burns 8.
  const g = star([["A", "B", "C"], ["C", "A", "B", "C"]]);
  expect(collapseGreedy(g.regions, g.adj, g.frameId)).toHaveLength(8);
  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(5);
  expect(plan.method).toBe("optimal");
  expect(colorsOf(plan.sheets)).toEqual(["BG", "C", "A", "B", "C"]);
});

test("lookahead-greedy also fails: 8 sheets where 6 suffice", () => {
  // petals "A,B,A,C" and "C,A,B,A": SCS("ABAC","CABA") = "CABAC" -> 6 sheets.
  // The lookahead rule (minimize the residual lower bound) is myopic here —
  // the bound can't see the deep desynchronization — and pays 2 extra sheets.
  const g = star([["A", "B", "A", "C"], ["C", "A", "B", "A"]]);
  expect(collapseGreedy(g.regions, g.adj, g.frameId, { lookahead: true }))
    .toHaveLength(8);
  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(6);
  expect(plan.method).toBe("optimal");
  expect(bruteMinSheets(g.regions, g.adj, g.frameId)).toBe(6);
});

/* ------------------------------------------------------------------ *
 * The exact search itself
 * ------------------------------------------------------------------ */

test("A* alone (no upper bound) finds the optimal plan", () => {
  const g = star([["R"], ["B", "R", "B"]], [[50], [1, 1, 1]]);
  const r = collapseOptimal(g.regions, g.adj, g.frameId);
  expect(r.sheets).toHaveLength(4);
});

test("A* can PROVE a greedy plan optimal when it beats the naive lower bound", () => {
  // petals "A,B" and "B,A": lower bound is max(depth 2, 2 colors) = 2 steps,
  // but SCS("AB","BA") has length 3 — no 3-sheet stack exists. The exact
  // search must exhaust the space to certify greedy's 4 sheets as optimal.
  const g = star([["A", "B"], ["B", "A"]]);
  expect(stackLowerBound(g.regions, g.adj, g.frameId)).toBe(3);
  const plan = planCollapse(g.regions, g.adj, g.frameId);
  expect(plan.sheets).toHaveLength(4);
  expect(plan.method).toBe("optimal"); // certified by exhausting the search
});

test("upper-bound pruning can certify optimality with almost no stored states", () => {
  // AB/BA: every depth-1 child already has f >= the greedy incumbent, so the
  // search proves optimality by pruning alone — even with maxStates = 1
  const g = star([["A", "B"], ["B", "A"]]);
  const plan = planCollapse(g.regions, g.adj, g.frameId, { maxStates: 1, timeBudgetMs: 0 });
  expect(plan.method).toBe("optimal");
  expect(plan.sheets).toHaveLength(4);
});

test("budget exhaustion falls back to greedy (returns null, plan says so)", () => {
  // three interleaved motifs: a real gap between the naive lower bound and
  // the optimum, and multiple unprunable children — the search must actually
  // store states, and the budget forbids it
  const g = star([["A", "B", "A"], ["B", "A", "B"], ["C", "A", "C"]]);
  expect(collapseOptimal(g.regions, g.adj, g.frameId, { maxStates: 1, timeBudgetMs: 0 }))
    .toBeNull();
  const plan = planCollapse(g.regions, g.adj, g.frameId, { maxStates: 2, timeBudgetMs: 0 });
  expect(plan.method).toBe("greedy"); // can't certify without the search
  // the fallback is still a valid stack that covers every region exactly once
  const seen = new Set();
  for (const s of plan.sheets) for (const id of s.members) seen.add(id);
  expect(seen.size).toBe(g.regions.length);
  // and with a real budget the same instance IS solved exactly
  const full = planCollapse(g.regions, g.adj, g.frameId);
  expect(full.method).toBe("optimal");
  expect(full.sheets.length).toBeLessThanOrEqual(plan.sheets.length);
  expect(full.sheets.length).toBe(bruteMinSheets(g.regions, g.adj, g.frameId));
});

/* ------------------------------------------------------------------ *
 * Fuzz: exact planner vs an independent brute force
 * ------------------------------------------------------------------ */

test("fuzz: planCollapse matches brute force and never loses to either greedy", () => {
  const rng = mulberry32(20260708);
  const COLORS = ["A", "B", "C"];
  for (let iter = 0; iter < 120; iter++) {
    const g = iter % 2 === 0
      ? randomTree(rng, 3 + Math.floor(rng() * 8), COLORS)
      : star(
          Array.from({ length: 1 + Math.floor(rng() * 3) }, () => {
            const len = 1 + Math.floor(rng() * 4);
            const petal = [];
            for (let i = 0; i < len; i++) {
              let c;
              do { c = COLORS[Math.floor(rng() * COLORS.length)]; }
              while (c === petal[i - 1]);
              petal.push(c);
            }
            return petal;
          }),
        );
    const exact = bruteMinSheets(g.regions, g.adj, g.frameId);
    const plan = planCollapse(g.regions, g.adj, g.frameId);
    const gArea = collapseGreedy(g.regions, g.adj, g.frameId);
    const gLook = collapseGreedy(g.regions, g.adj, g.frameId, { lookahead: true });
    expect(plan.sheets.length).toBe(exact);
    expect(plan.sheets.length).toBeLessThanOrEqual(gArea.length);
    expect(plan.sheets.length).toBeLessThanOrEqual(gLook.length);
    // every region lands on exactly one sheet
    const seen = new Set();
    for (const s of plan.sheets) for (const id of s.members) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(g.regions.length);
  }
});

/* ------------------------------------------------------------------ *
 * Full grid pipeline: the smilie
 * ------------------------------------------------------------------ */

function components4(mask, nx, ny) {
  const seen = new Uint8Array(nx * ny);
  let comps = 0;
  for (let s = 0; s < nx * ny; s++) {
    if (!mask[s] || seen[s]) continue;
    comps++;
    const st = [s]; seen[s] = 1;
    while (st.length) {
      const p = st.pop(), x = p % nx, y = (p / nx) | 0;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; st.push(p - 1); }
      if (x < nx - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; st.push(p + 1); }
      if (y > 0 && mask[p - nx] && !seen[p - nx]) { seen[p - nx] = 1; st.push(p - nx); }
      if (y < ny - 1 && mask[p + nx] && !seen[p + nx]) { seen[p + nx] = 1; st.push(p + nx); }
    }
  }
  return comps;
}

test("grid pipeline: smilie collapses to 4 contiguous sheets that reproduce the image", () => {
  const NX = 60, NY = 60;
  const WHITE = "#fff", BLACK = "#000", YELLOW = "#ff0";
  const palette = [WHITE, BLACK, YELLOW]; // like buildPaperStack: one id per hex
  const grid = new Int32Array(NX * NY);
  const cx = 29.5, cy = 29.5;
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const r = Math.hypot(x - cx, y - cy);
      let v = 0;                                   // white background
      if (r <= 26) v = 1;                          // black ring
      if (r <= 23) v = 2;                          // yellow face
      const eye = (ex) => Math.hypot(x - ex, y - (cy - 6)) <= 3;
      if (eye(cx - 8) || eye(cx + 8)) v = 1;       // eyes (black again)
      if (Math.hypot((x - cx) / 10, (y - (cy + 8)) / 3) <= 1) v = 1; // mouth
      grid[y * NX + x] = v;
    }
  }

  denoiseGrid(grid, NX, NY, 5);
  const { label, regions } = labelRegions(grid, NX, NY);
  for (const r of regions) r.color = palette[r.value];
  const adj = buildAdjacency(label, regions.length, NX, NY);
  const frameId = regions.length;
  regions.push({ value: -1, cells: [], size: 0, color: WHITE, frame: true });
  adj.push(new Set());
  const touch = new Set();
  for (let x = 0; x < NX; x++) { touch.add(label[x]); touch.add(label[(NY - 1) * NX + x]); }
  for (let y = 0; y < NY; y++) { touch.add(label[y * NX]); touch.add(label[y * NX + NX - 1]); }
  for (const r of touch) { adj[frameId].add(r); adj[r].add(frameId); }

  const plan = planCollapse(regions, adj, frameId);
  expect(plan.method).toBe("optimal");
  expect(plan.sheets).toHaveLength(4);
  expect(colorsOf(plan.sheets)).toEqual([WHITE, BLACK, YELLOW, BLACK]);
  // eyes + mouth gathered onto the last sheet as one piece of paper
  expect(plan.sheets[3].members).toHaveLength(3);

  // physical invariants: cumulative sheets stay one 4-connected piece, and
  // the first sheet (from the top) covering a cell has that cell's color
  const cum = new Uint8Array(NX * NY);
  const masks = [];
  for (const s of plan.sheets) {
    for (const id of s.members) for (const p of (regions[id].cells || [])) cum[p] = 1;
    masks.push(cum.slice());
    expect(components4(cum, NX, NY)).toBe(1);
  }
  for (let p = 0; p < NX * NY; p++) {
    const first = masks.findIndex((m) => m[p]);
    expect(plan.sheets[first].color).toBe(palette[grid[p]]);
  }
  expect(masks[masks.length - 1].every((v) => v)).toBe(true); // solid backing
});
