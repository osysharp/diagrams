// The canvas's own LAYOUT — a layered drawing of a directed graph (the Sugiyama family), and the edge router that goes
// with it. Pure: sizes in, coordinates out; no DOM, no clock, no randomness, so the same graph is the same picture
// every time, and the kit's tests read its answers as plain numbers.
//
// The steps, in the order they run:
//   1. CYCLES     a depth-first walk from the start nodes, edges in declaration order; an edge that returns to a node
//                 still on the walk is a RETURN. It is turned round for ranking and drawn against the flow.
//   2. RANKS      longest path from the starts, so an edge never points backwards; nodes marked as ends share the
//                 LAST rank; a start nothing leads to sits one rank before what it feeds.
//   3. MAIN PATH  the path the caller names — or the longest chain from the first start — is kept on one straight row.
//   4. ORDER      an edge spanning several ranks gets a waypoint in each rank it passes; ranks are then reordered by
//                 the barycentre of their neighbours, down and up for a fixed number of sweeps, keeping the order with
//                 the fewest crossings, and finished with adjacent swaps.
//   5. COORDS     across the flow, by priority: the main path first (exactly straight), then waypoints (so a long edge
//                 runs straight), then nodes with the most neighbours — each as near the median of its neighbours as
//                 the ones already placed allow. Nothing can overlap: a place is always chosen inside the room left.
//   6. PORTS      every edge leaves and enters a node at its OWN point, ordered by where the other end is, so lines do
//                 not cross as they leave, and placed opposite the other end when that makes the line straight.
//   7. ROUTES     between two ranks every bending edge gets its own track, ordered so that edges cross as little as
//                 possible and never lie on one another; corners are rounded; an arrowhead ends each edge.
//
// Everything is worked out in (flow, cross) coordinates and turned into x/y at the very end, which is the whole of
// what a direction is: `right` and `down` swap the axes, `left` and `up` mirror the flow.

export type Direction = 'right' | 'down' | 'left' | 'up';

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Where a walk begins. More than one node may be one. */
  initial?: boolean;
  /** An END — shares the last rank with every other end. */
  terminal?: boolean;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  /** The size of the edge's label, when it has one — room is kept for it on the edge. */
  labelWidth?: number;
  labelHeight?: number;
}

export interface LayoutOptions {
  direction?: Direction;
  /** Clear space between two nodes of one rank. */
  nodeSep?: number;
  /** The least space between two ranks; a gap grows past it to hold its tracks and labels. */
  rankSep?: number;
  /** Clear space between a passing edge and a node, and between two passing edges. */
  edgeSep?: number;
  /** The distance between two tracks in a gap. */
  trackSep?: number;
  /** The most two ports of one node side are apart. */
  portSep?: number;
  /** Corner radius of a routed edge. */
  corner?: number;
  /** The node ids of the path to keep straight, in order. Empty: the longest chain from the first start. */
  mainPath?: readonly string[];
}

export interface Point { x: number; y: number }

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
  order: number;
}

export interface RoutedEdge {
  id: string;
  source: string;
  target: string;
  /** The corners of the route, from the source to the target — every piece runs along one axis. */
  points: Point[];
  /** The route as an SVG path with rounded corners, stopping just inside the arrowhead. */
  path: string;
  /** The arrowhead at the target, as an SVG path. */
  arrow: string;
  /** A RETURN: it runs against the flow (it closed a cycle). */
  reversed: boolean;
  /** An edge from a node to itself. */
  loop: boolean;
  /** Where its label is centred, when it has one. */
  label: Point | null;
}

export interface Layout {
  direction: Direction;
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  width: number;
  height: number;
  ranks: number;
  /** The node ids of the path that was kept straight. */
  mainPath: string[];
}

interface V {
  node: number;            // index into nodes, or -1 for a waypoint
  edge: E | null;          // the edge a waypoint belongs to
  rank: number;
  order: number;
  c: number;               // centre, across the flow
  before: number;          // room it needs on the low side of its centre…
  after: number;           // …and on the high side
  len: number;             // its length along the flow (0 for a waypoint)
  main: boolean;
  up: Seg[];
  down: Seg[];
  r0: number;              // where it starts along the flow
}

interface E {
  idx: number;
  edge: LayoutEdge;
  u: number;               // node indices in the direction it is LAID OUT (after turning a return round)
  v: number;
  reversed: boolean;
  main: boolean;
  segs: Seg[];
}

interface Seg {
  e: E;
  a: V;
  b: V;
  c1: number;              // where it leaves `a`, across the flow
  c2: number;              // where it enters `b`
  t: number;               // the track it bends on, along the flow (unused when it is straight)
}

const EPS = 0.5;

/** Lay a graph out. Nodes and edges are read in the order given, and that order breaks every tie. */
export function layout(nodesIn: readonly LayoutNode[], edgesIn: readonly LayoutEdge[], options: LayoutOptions = {}): Layout {
  const direction = options.direction ?? 'right';
  const horizontal = direction === 'right' || direction === 'left';
  const nodeSep = options.nodeSep ?? 24;
  const rankSepMin = options.rankSep ?? 44;
  const corner = options.corner ?? 8;
  const trackSep = options.trackSep ?? 12;

  const nodes = nodesIn.filter((n, i) => nodesIn.findIndex((m) => m.id === n.id) === i);
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));
  const N = nodes.length;
  const lenOf = (n: LayoutNode) => Math.max(1, horizontal ? n.width : n.height);
  const thickOf = (n: LayoutNode) => Math.max(1, horizontal ? n.height : n.width);
  // A label lies ALONG a horizontal edge and ACROSS a vertical one.
  const labelLen = (e: LayoutEdge) => (e.labelWidth && e.labelHeight ? (horizontal ? e.labelWidth : e.labelHeight) : 0);

  const labelAcross = (e: LayoutEdge) => (horizontal ? e.labelHeight ?? 0 : e.labelWidth ?? 0);
  const real = edgesIn.filter((e) => index.has(e.source) && index.has(e.target));
  const loops = real.filter((e) => e.source === e.target);
  const links = real.filter((e) => e.source !== e.target);
  const lineSep = options.edgeSep ?? 14;
  const portSepMax = options.portSep ?? 14;

  // ── 1. cycles ────────────────────────────────────────────────────────────────────────────────────────────────
  const out: number[][] = Array.from({ length: N }, () => []);
  const inDeg = new Array<number>(N).fill(0);
  links.forEach((e, i) => { out[index.get(e.source)!].push(i); inDeg[index.get(e.target)!]++; });
  const reversed = new Array<boolean>(links.length).fill(false);
  const state = new Uint8Array(N);                       // 0 unseen · 1 on the walk · 2 done
  const roots = [
    ...nodes.map((n, i) => (n.initial ? i : -1)).filter((i) => i >= 0),
    ...nodes.map((_, i) => i).filter((i) => !nodes[i].initial && inDeg[i] === 0),
    ...nodes.map((_, i) => i),
  ];
  for (const root of roots) {
    if (state[root] !== 0) continue;
    const stack: { v: number; k: number }[] = [{ v: root, k: 0 }];
    state[root] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.k >= out[top.v].length) { state[top.v] = 2; stack.pop(); continue; }
      const ei = out[top.v][top.k++];
      const w = index.get(links[ei].target)!;
      if (state[w] === 1) reversed[ei] = true;
      else if (state[w] === 0) { state[w] = 1; stack.push({ v: w, k: 0 }); }
    }
  }
  const es: E[] = links.map((edge, idx) => {
    const s = index.get(edge.source)!; const t = index.get(edge.target)!;
    return { idx, edge, u: reversed[idx] ? t : s, v: reversed[idx] ? s : t, reversed: reversed[idx], main: false, segs: [] };
  });

  // ── 2. ranks ─────────────────────────────────────────────────────────────────────────────────────────────────
  const succ: E[][] = Array.from({ length: N }, () => []);
  const pred: E[][] = Array.from({ length: N }, () => []);
  for (const e of es) { succ[e.u].push(e); pred[e.v].push(e); }
  const topo: number[] = [];
  {
    const left = pred.map((p) => p.length);
    const ready = nodes.map((_, i) => i).filter((i) => left[i] === 0);
    while (ready.length > 0) {
      const v = ready.shift()!;
      topo.push(v);
      for (const e of succ[v]) if (--left[e.v] === 0) { ready.push(e.v); ready.sort((a, b) => a - b); }
    }
  }
  const rank = new Array<number>(N).fill(0);
  for (const v of topo) for (const e of succ[v]) rank[e.v] = Math.max(rank[e.v], rank[v] + 1);
  const last = Math.max(0, ...rank);
  // Ends share the last rank. Only a node nothing leaves can move there without turning an edge backwards.
  const ends = nodes.map((n, i) => (n.terminal && succ[i].length === 0 ? i : -1)).filter((i) => i >= 0);
  for (const i of ends) rank[i] = last;
  // A start nothing leads to sits just before what it feeds, rather than a long way back at rank 0.
  for (let i = 0; i < N; i++) {
    if (pred[i].length === 0 && succ[i].length > 0 && !nodes[i].initial)
      rank[i] = Math.min(...succ[i].map((e) => rank[e.v])) - 1;
  }
  const lowest = Math.min(0, ...rank);
  if (lowest < 0) for (let i = 0; i < N; i++) rank[i] -= lowest;
  const R = N === 0 ? 0 : Math.max(...rank) + 1;

  // ── 3. the main path ─────────────────────────────────────────────────────────────────────────────────────────
  const mainNodes: number[] = [];
  const named = (options.mainPath ?? []).map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  if (named.length > 0) {
    // What the caller named, as far as it is a path that runs forward one edge at a time.
    mainNodes.push(named[0]);
    for (let k = 1; k < named.length; k++) {
      const prev = mainNodes[mainNodes.length - 1];
      const e = es.find((x) => !x.reversed && x.u === prev && x.v === named[k] && !mainNodes.includes(named[k]));
      if (!e) break;
      e.main = true;
      mainNodes.push(named[k]);
    }
  } else if (N > 0) {
    // From the first start to the first END that was declared — the outcome a declaration names first is the one it
    // is about — by the longest way there; with no end marked (or none in reach), the longest chain from that start.
    let at = nodes.findIndex((n) => n.initial);
    if (at < 0) {
      at = 0;
      for (let i = 1; i < N; i++) if (rank[i] < rank[at]) at = i;
    }
    const reach = (goal: number): number[] => {
      const h = new Array<number>(N).fill(goal < 0 ? 0 : -Infinity);
      if (goal >= 0) h[goal] = 0;
      for (let k = topo.length - 1; k >= 0; k--)
        for (const e of succ[topo[k]]) if (!e.reversed) h[topo[k]] = Math.max(h[topo[k]], h[e.v] + 1);
      return h;
    };
    let height = reach(-1);
    for (const goal of ends) { const h = reach(goal); if (h[at] > 0) { height = h; break; } }
    mainNodes.push(at);
    for (;;) {
      let best: E | null = null;
      for (const e of succ[at]) {
        if (e.reversed || mainNodes.includes(e.v) || height[e.v] === -Infinity) continue;
        if (!best || height[e.v] > height[best.v]) best = e;
      }
      if (!best) break;
      best.main = true;
      at = best.v;
      mainNodes.push(at);
    }
  }
  const onMain = new Set(mainNodes);

  // ── 4. waypoints and order ───────────────────────────────────────────────────────────────────────────────────
  const loopsOf = nodes.map((n) => loops.filter((l) => l.source === n.id));
  const LOOP_H = 18;
  const vs: V[] = nodes.map((n, i) => {
    const mine = loopsOf[i];
    const loopRoom = mine.length === 0 ? 0
      : LOOP_H + (mine.length - 1) * 10 + 8 + Math.max(0, ...mine.map((l) => (labelLen(l) > 0 ? labelAcross(l) + 4 : 0)));
    return { node: i, edge: null, rank: rank[i], order: 0, c: 0, before: thickOf(n) / 2 + loopRoom, after: thickOf(n) / 2,
      len: lenOf(n), main: onMain.has(i), up: [], down: [], r0: 0 };
  });
  const all: V[] = [...vs];
  for (const e of es) {
    let a = vs[e.u];
    for (let r = rank[e.u] + 1; r < rank[e.v]; r++) {
      const d: V = { node: -1, edge: e, rank: r, order: 0, c: 0, before: 0, after: 0, len: 0, main: e.main, up: [], down: [], r0: 0 };
      all.push(d);
      const s: Seg = { e, a, b: d, c1: 0, c2: 0, t: 0 };
      e.segs.push(s); a.down.push(s); d.up.push(s);
      a = d;
    }
    const s: Seg = { e, a, b: vs[e.v], c1: 0, c2: 0, t: 0 };
    e.segs.push(s); a.down.push(s); vs[e.v].up.push(s);
  }
  const rows: V[][] = Array.from({ length: R }, () => []);
  // The first order: a walk from the top of each rank, the main path first, so the picture starts from the shape the
  // declaration has and the sweeps only have to mend it. `flip` walks each node's other edges last-declared first — a
  // second starting point, for the graphs where the first one settles on a crossing it need not have.
  const start = (flip: boolean) => {
    for (const row of rows) row.length = 0;
    const seen = new Set<V>();
    const visit = (v: V) => {
      if (seen.has(v)) return;
      seen.add(v);
      v.order = rows[v.rank].length;
      rows[v.rank].push(v);
      const next = [...v.down].sort((p, q) => Number(q.e.main) - Number(p.e.main) || (flip ? q.e.idx - p.e.idx : p.e.idx - q.e.idx));
      for (const s of next) visit(s.b);
    };
    const tops = all.filter((v) => v.up.length === 0)
      .sort((p, q) => p.rank - q.rank || Number(q.main) - Number(p.main) || p.node - q.node);
    for (const v of tops) visit(v);
    for (const v of all) visit(v);
  };
  const gapSegs: Seg[][] = Array.from({ length: Math.max(0, R - 1) }, () => []);
  for (const e of es) for (const s of e.segs) gapSegs[s.a.rank].push(s);
  const crossingsIn = (g: number): number => {
    const ss = gapSegs[g]; let n = 0;
    for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++)
      if ((ss[i].a.order - ss[j].a.order) * (ss[i].b.order - ss[j].b.order) < 0) n++;
    return n;
  };
  const crossingsAll = (): number => { let n = 0; for (let g = 0; g < R - 1; g++) n += crossingsIn(g); return n; };
  const renumber = (r: number) => rows[r].forEach((v, k) => { v.order = k; });
  const snapshot = (): V[][] => rows.map((row) => [...row]);
  const restore = (snap: V[][]) => { snap.forEach((row, r) => { rows[r] = [...row]; renumber(r); }); };
  const settle = (): number => {
    let best = snapshot(); let bestX = crossingsAll();
    for (let sweep = 0; sweep < 24 && bestX > 0; sweep++) {
      const down = sweep % 2 === 0;
      for (let k = 1; k < R; k++) {
        const r = down ? k : R - 1 - k;
        const row = rows[r];
        const bary = new Map<V, number>();
        for (const v of row) {
          const near = down ? v.up.map((s) => s.a.order) : v.down.map((s) => s.b.order);
          if (near.length > 0) bary.set(v, near.reduce((p, q) => p + q, 0) / near.length);
        }
        // A node with no neighbour on that side keeps its place; the others are sorted into the places left.
        const movable = row.filter((v) => bary.has(v)).sort((p, q) => bary.get(p)! - bary.get(q)! || p.order - q.order);
        let m = 0;
        rows[r] = row.map((v) => (bary.has(v) ? movable[m++] : v));
        renumber(r);
      }
      const x = crossingsAll();
      if (x < bestX) { bestX = x; best = snapshot(); }
    }
    restore(best);
    // Adjacent swaps: exchange two neighbours whenever that removes crossings with the ranks either side.
    for (let pass = 0; pass < 12 && bestX > 0; pass++) {
      let improved = false;
      for (let r = 0; r < R; r++) {
        for (let k = 0; k + 1 < rows[r].length; k++) {
          const around = () => (r > 0 ? crossingsIn(r - 1) : 0) + (r < R - 1 ? crossingsIn(r) : 0);
          const was = around();
          const a = rows[r][k]; const b = rows[r][k + 1];
          rows[r][k] = b; rows[r][k + 1] = a; b.order = k; a.order = k + 1;
          if (around() < was) improved = true;
          else { rows[r][k] = a; rows[r][k + 1] = b; a.order = k; b.order = k + 1; }
        }
      }
      if (!improved) break;
    }
    return crossingsAll();
  };
  start(false);
  let fewest = settle();
  if (fewest > 0) {
    const kept = snapshot();
    start(true);
    const other = settle();
    if (other < fewest) fewest = other; else restore(kept);
  }

  // ── 5. coordinates across the flow ───────────────────────────────────────────────────────────────────────────
  const sep = (a: V, b: V) => a.after + b.before + (a.node >= 0 && b.node >= 0 ? nodeSep : lineSep);
  for (const row of rows) {
    let at = 0;
    row.forEach((v, k) => { at = k === 0 ? 0 : at + sep(row[k - 1], v); v.c = at; });
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((p, q) => p - q);
    const m = s.length >> 1;
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const align = (r: number, down: boolean) => {
    const row = rows[r];
    const want = new Map<V, number>();
    const weight = new Map<V, number>();
    for (const v of row) {
      const near = down ? v.up : v.down;
      const other = (s: Seg) => (down ? s.a : s.b);
      const mainNear = v.main ? near.find((s) => s.e.main && other(s).main) : undefined;
      if (mainNear) { want.set(v, other(mainNear).c); weight.set(v, 1e9); continue; }
      if (v.node < 0) {
        // A waypoint follows its own edge — and its edge's other WAYPOINTS before the node at either end, so the middle
        // of a long edge is one straight line and only its first and last pieces bend.
        const here = other(near[0]);
        const far = down ? v.down[0].b : v.up[0].a;
        if (here.node < 0) { want.set(v, here.c); weight.set(v, 1e6); }
        else if (far.node < 0) { want.set(v, far.c); weight.set(v, 1e6); }
        else { want.set(v, here.c); weight.set(v, 1e5); }
        continue;
      }
      if (near.length === 0) { weight.set(v, -1); continue; }
      want.set(v, median(near.map((s) => other(s).c)));
      weight.set(v, near.length);
    }
    const placed = new Array<boolean>(row.length).fill(false);
    const turn = row.map((_, k) => k).sort((p, q) => weight.get(row[q])! - weight.get(row[p])! || p - q);
    for (const k of turn) {
      const v = row[k];
      let lo = -Infinity; let hi = Infinity;
      for (let j = k - 1, room = 0; j >= 0; j--) { room += sep(row[j], row[j + 1]); if (placed[j]) { lo = row[j].c + room; break; } }
      for (let j = k + 1, room = 0; j < row.length; j++) { room += sep(row[j - 1], row[j]); if (placed[j]) { hi = row[j].c - room; break; } }
      const target = want.has(v) ? want.get(v)! : v.c;
      v.c = Math.min(hi, Math.max(lo, target));
      placed[k] = true;
    }
  };
  for (let round = 0; round < 3; round++) {
    for (let r = 1; r < R; r++) align(r, true);
    for (let r = R - 2; r >= 0; r--) align(r, false);
  }
  for (let r = 1; r < R; r++) align(r, true);

  // Then everything that is not the main path settles: a long edge moves, whole, towards the middle of its two ends,
  // and a node towards the middle of its neighbours — each only as far as the room beside it allows, so nothing that
  // was straight bends and nothing overlaps.
  const roomOf = (v: V): [number, number] => {
    const row = rows[v.rank];
    return [v.order > 0 ? row[v.order - 1].c + sep(row[v.order - 1], v) : -Infinity,
      v.order + 1 < row.length ? row[v.order + 1].c - sep(v, row[v.order + 1]) : Infinity];
  };
  for (let round = 0; round < 4; round++) {
    for (const e of es) {
      const chain = e.segs.slice(1).map((s) => s.a);
      if (chain.length === 0 || e.main) continue;
      const want = (vs[e.u].c + vs[e.v].c) / 2 - chain.reduce((sum, d) => sum + d.c, 0) / chain.length;
      let lo = -Infinity; let hi = Infinity;
      for (const d of chain) { const [a, b] = roomOf(d); lo = Math.max(lo, a - d.c); hi = Math.min(hi, b - d.c); }
      const shift = Math.min(hi, Math.max(lo, want));
      for (const d of chain) d.c += shift;
    }
    for (const v of vs) {
      if (v.main || v.up.length + v.down.length === 0) continue;
      const [lo, hi] = roomOf(v);
      v.c = Math.min(hi, Math.max(lo, median([...v.up.map((s) => s.a.c), ...v.down.map((s) => s.b.c)])));
    }
  }

  // ── 6. ports ─────────────────────────────────────────────────────────────────────────────────────────────────
  // One side of one node: its edges in the order of their other ends, each wanting to sit opposite that other end, kept
  // at least a port apart and inside the side.
  const spread = (v: V, segs: Seg[], wantOf: (s: Seg) => number, set: (s: Seg, c: number) => void) => {
    const k = segs.length;
    if (k === 0) return;
    const n = nodes[v.node];
    const half = Math.max(0, thickOf(n) / 2 - Math.min(6, thickOf(n) / 6));
    const anchor = segs.findIndex((s) => s.e.main && v.main);
    const gap = k === 1 ? 0 : anchor >= 0
      ? Math.min(portSepMax, half / Math.max(1, anchor, k - 1 - anchor))
      : Math.min(portSepMax, (2 * half) / (k - 1));
    // The room each port may use, so that every port after it still fits: with a main edge, that one is the centre
    // and the others keep to their own side of it.
    const lo = (i: number) => (anchor >= 0 && i >= anchor ? (i - anchor) * gap : -half + i * gap);
    const hi = (i: number) => (anchor >= 0 && i <= anchor ? -(anchor - i) * gap : half - (k - 1 - i) * gap);
    const o = segs.map((s, i) => Math.min(hi(i), Math.max(lo(i), wantOf(s) - v.c)));
    if (anchor >= 0) {
      o[anchor] = 0;
      for (let i = anchor + 1; i < k; i++) o[i] = Math.max(o[i], o[i - 1] + gap);
      for (let i = anchor - 1; i >= 0; i--) o[i] = Math.min(o[i], o[i + 1] - gap);
    } else {
      for (let i = 1; i < k; i++) o[i] = Math.max(o[i], o[i - 1] + gap);
      for (let i = k - 2; i >= 0; i--) o[i] = Math.min(o[i], o[i + 1] - gap);
    }
    segs.forEach((s, i) => set(s, v.c + o[i]));
  };
  for (const row of rows) for (const v of row) {
    if (v.node < 0) { for (const s of v.down) s.c1 = v.c; for (const s of v.up) s.c2 = v.c; continue; }
    const outs = [...v.down].sort((p, q) => p.b.order - q.b.order || p.e.idx - q.e.idx);
    spread(v, outs, (s) => s.b.c, (s, c) => { s.c1 = c; });
  }
  for (const row of rows) for (const v of row) {
    if (v.node < 0) continue;
    const ins = [...v.up].sort((p, q) => p.a.order - q.a.order || p.c1 - q.c1 || p.e.idx - q.e.idx);
    spread(v, ins, (s) => s.c1, (s, c) => { s.c2 = c; });
  }
  // The waypoints of an edge move, together, to where its first piece can be straight: an edge that leaves a port a
  // little off its node's centre would otherwise make a small jog on the way to its own line.
  for (const e of es) {
    const chain = e.segs.slice(1).map((s) => s.a);
    if (chain.length === 0) continue;
    let lo = -Infinity; let hi = Infinity;
    for (const d of chain) { const [a, b] = roomOf(d); lo = Math.max(lo, a - d.c); hi = Math.min(hi, b - d.c); }
    const shift = Math.min(hi, Math.max(lo, e.segs[0].c1 - chain[0].c));
    for (const d of chain) { d.c += shift; d.up[0].c2 = d.c; d.down[0].c1 = d.c; }
  }
  // …and the port it arrives at follows, when that node has the room.
  for (const row of rows) for (const v of row) {
    if (v.node < 0) continue;
    const ins = [...v.up].sort((p, q) => p.a.order - q.a.order || p.c1 - q.c1 || p.e.idx - q.e.idx);
    spread(v, ins, (s) => s.c1, (s, c) => { s.c2 = c; });
  }

  // ── 7. along the flow: columns, gaps, tracks ─────────────────────────────────────────────────────────────────
  const colLen = rows.map((row) => Math.max(0, ...row.map((v) => v.len)));
  const colStart: number[] = [];
  const PAD = 20;                                         // straight run at each end of a gap: room for an arrowhead
  let at = 0;
  const labelAt = new Map<E, { r: number; c: number }>();
  for (let g = 0; g < R; g++) {
    colStart[g] = at;
    for (const v of rows[g]) v.r0 = at + (colLen[g] - v.len) / 2;
    if (g === R - 1) break;
    const ss = gapSegs[g];
    // A label sits on the first straight run of its edge, beside the node the edge LEAVES — for a return, that is the
    // far end of the gap. The labels of one node are staggered, each a step further along, so two never share a place.
    const lead = ss.filter((s) => labelLen(s.e.edge) > 0 && !s.e.reversed && s.a.node >= 0);
    const tail = ss.filter((s) => labelLen(s.e.edge) > 0 && s.e.reversed && s.b.node >= 0);
    const levels = (list: Seg[], nodeOf: (s: Seg) => V) => {
      const per = new Map<V, number>(); const m = new Map<Seg, number>();
      for (const s of [...list].sort((p, q) => (p.c1 + p.c2) - (q.c1 + q.c2))) {
        const n = per.get(nodeOf(s)) ?? 0; m.set(s, n); per.set(nodeOf(s), n + 1);
      }
      return m;
    };
    const leadLevel = levels(lead, (s) => s.a); const tailLevel = levels(tail, (s) => s.b);
    const step = (list: Seg[]) => Math.max(0, ...list.map((s) => labelLen(s.e.edge))) + 12;
    const zone = (list: Seg[], level: Map<Seg, number>) =>
      (list.length === 0 ? 0 : step(list) * (Math.max(0, ...level.values()) + 1));
    const zoneL = zone(lead, leadLevel); const zoneR = zone(tail, tailLevel);

    // Which of two bending edges takes the earlier track. `p` before `q` costs a crossing when q leaves between p's
    // ends, and another when p arrives between q's ends; and it is FORBIDDEN when p arrives on the line q leaves by,
    // because the two would then run on top of each other.
    const CLOSE = 5;
    const between = (x: number, a: number, b: number) => x > Math.min(a, b) + EPS && x < Math.max(a, b) - EPS;
    const cost = (p: Seg, q: Seg) => (Math.abs(p.c2 - q.c1) < CLOSE ? 1000 : 0)
      + (between(q.c1, p.c1, p.c2) ? 1 : 0) + (between(p.c2, q.c1, q.c2) ? 1 : 0);
    let bends: Seg[] = [];
    for (let round = 0; round < 8; round++) {
      bends = ss.filter((s) => Math.abs(s.c1 - s.c2) >= EPS);
      bends.sort((p, q) => Math.min(p.c1, p.c2) - Math.min(q.c1, q.c2) || p.e.idx - q.e.idx);
      // Each edge in turn is taken out and put back on the track where it costs least, until no move helps. (Sorting
      // by pairs is not enough: "p before q" is not transitive, and a bubble sort settles on an order full of crossings.)
      if (bends.length > 1 && bends.length <= 64) {
        const before = new Map<Seg, Map<Seg, number>>();
        for (const p of bends) { const m = new Map<Seg, number>(); for (const q of bends) if (p !== q) m.set(q, cost(p, q)); before.set(p, m); }
        for (let pass = 0; pass < 6; pass++) {
          let moved = false;
          for (const s of [...bends]) {
            const rest = bends.filter((x) => x !== s);
            // The cost of `s` at position k: everything before it is "x before s", everything after "s before x".
            let here = rest.reduce((sum, x) => sum + before.get(s)!.get(x)!, 0);
            let bestAt = 0; let bestCost = here;
            for (let k = 0; k < rest.length; k++) {
              here += before.get(rest[k])!.get(s)! - before.get(s)!.get(rest[k])!;
              if (here < bestCost) { bestCost = here; bestAt = k + 1; }
            }
            const was = bends.indexOf(s);
            if (bestAt !== was) {
              const now = rest.reduce((sum, x, k) => sum + (k < was ? before.get(x)!.get(s)! : before.get(s)!.get(x)!), 0);
              if (bestCost < now) { rest.splice(bestAt, 0, s); bends.splice(0, bends.length, ...rest); moved = true; }
            }
          }
          if (!moved) break;
        }
      }
      // No order of tracks separates edges that arrive on the lines each other leave by — two of them, or a ring of
      // more. One of their PORTS then steps aside by a few pixels, towards the middle of its node, wherever that keeps
      // clear of every other line in this gap; and the tracks are ordered again.
      let pair: readonly [Seg, Seg] | null = null;
      for (let i = 0; i < bends.length && !pair; i++) for (let j = i + 1; j < bends.length; j++)
        if (Math.abs(bends[i].c2 - bends[j].c1) < CLOSE) { pair = [bends[i], bends[j]]; break; }
      if (!pair) break;
      const clear = (s: Seg, leaving: boolean, c: number, near: number) => {
        const v = leaving ? s.a : s.b;
        if (Math.abs(c - v.c) > thickOf(nodes[v.node]) / 2 - 3) return false;
        return ss.every((o) => o === s || (Math.abs(o.c1 - c) >= near && Math.abs(o.c2 - c) >= near));
      };
      let moved = false;
      // The arriving edge may be passing through, not arriving at a node: then the REST of its line — the waypoints
      // from here on, which no gap has been drawn from yet — steps aside together, so it stays one straight line.
      if (pair[0].b.node < 0) {
        const p = pair[0];
        const rest = p.e.segs.slice(p.e.segs.indexOf(p) + 1).map((x) => x.a);
        const fits = (shift: number, keep: number) => rest.every((d) => {
          const row = rows[d.rank];
          const lo = d.order > 0 ? row[d.order - 1].c + row[d.order - 1].after + keep : -Infinity;
          const hi = d.order + 1 < row.length ? row[d.order + 1].c - row[d.order + 1].before - keep : Infinity;
          return d.c + shift >= lo && d.c + shift <= hi;
        }) && ss.every((o) => o === p || (Math.abs(o.c1 - (p.c2 + shift)) >= 2 && Math.abs(o.c2 - (p.c2 + shift)) >= 2));
        for (const keep of [8, 4]) {
          for (const shift of [6, -6, 8, -8]) {
            if (!fits(shift, keep)) continue;
            for (const d of rest) { d.c += shift; d.up[0].c2 = d.c; d.down[0].c1 = d.c; }
            moved = true;
            break;
          }
          if (moved) break;
        }
      }
      for (const [s, leaving] of moved ? [] : [[pair[0], false], [pair[1], true]] as const) {
        const v = leaving ? s.a : s.b;
        if (v.node < 0) continue;
        const from = leaving ? s.c1 : s.c2;
        const inward = from > v.c ? -1 : 1;
        // First a place clear of every line; failing that, one that is at least not ON another line.
        for (const near of [CLOSE, 2]) {
          for (const step of [6 * inward, -6 * inward, 9 * inward, -9 * inward, 12 * inward, -12 * inward, 3 * inward, -3 * inward]) {
            if (!clear(s, leaving, from + step, near)) continue;
            if (leaving) s.c1 = from + step; else s.c2 = from + step;
            moved = true;
            break;
          }
          if (moved) break;
        }
        if (moved) break;
      }
      if (!moved) break;
    }
    const tracks = bends.length * trackSep;
    const gapLen = Math.max(rankSepMin, PAD + zoneL + Math.max(tracks, bends.length > 0 ? trackSep : 0) + zoneR + PAD);
    const gs = at + colLen[g];
    const free = gapLen - 2 * PAD - zoneL - zoneR - tracks;
    bends.forEach((s, k) => { s.t = gs + PAD + zoneL + free / 2 + (k + 0.5) * trackSep; });
    for (const s of lead) labelAt.set(s.e, { r: gs + PAD + (leadLevel.get(s)! + 0.5) * step(lead), c: s.c1 });
    for (const s of tail) labelAt.set(s.e, { r: gs + gapLen - PAD - (tailLevel.get(s)! + 0.5) * step(tail), c: s.c2 });
    at = gs + gapLen;
  }
  const flowLen = R === 0 ? 0 : colStart[R - 1] + colLen[R - 1];

  // ── out: flow/cross → x/y ───────────────────────────────────────────────────────────────────────────────────
  const pt = (r: number, c: number): Point => {
    const f = direction === 'left' || direction === 'up' ? flowLen - r : r;
    return horizontal ? { x: f, y: c } : { x: c, y: f };
  };
  const placed: PlacedNode[] = vs.map((v) => {
    const n = nodes[v.node];
    const a = pt(v.r0, v.c - thickOf(n) / 2); const b = pt(v.r0 + v.len, v.c + thickOf(n) / 2);
    return { id: n.id, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: n.width, height: n.height, rank: v.rank, order: v.order };
  });
  const routed: RoutedEdge[] = [];
  const labels: { e: LayoutEdge; at: Point }[] = [];
  for (const e of es) {
    const line: Point[] = [];
    const push = (p: Point) => {
      const q = line[line.length - 1];
      if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) return;
      line.push(p);
    };
    for (const s of e.segs) {
      push(pt(s.a.r0 + s.a.len, s.c1));
      if (Math.abs(s.c1 - s.c2) >= EPS) { push(pt(s.t, s.c1)); push(pt(s.t, s.c2)); }
      push(pt(s.b.r0, s.c2));
    }
    const points = simplify(e.reversed ? line.reverse() : line);
    const la = labelAt.get(e);
    const label = la ? pt(la.r, la.c) : null;
    if (label) labels.push({ e: e.edge, at: label });
    routed.push({ id: e.edge.id, source: e.edge.source, target: e.edge.target, points, reversed: e.reversed, loop: false, label,
      path: '', arrow: '' });
  }
  // A loop leaves the low side of its node and comes back to it a little further along.
  nodes.forEach((n, i) => {
    const v = vs[i];
    const count = loopsOf[i].length;
    const maxHalf = Math.max(3, (v.len - 8) / 2);
    const stepBy = Math.min(7, maxHalf / Math.max(1, count));
    const half0 = Math.min(10, maxHalf - stepBy * (count - 1));
    const halfMax = half0 + stepBy * (count - 1);
    const mid = Math.min(v.r0 + v.len - 4 - halfMax, Math.max(v.r0 + 4 + halfMax, v.r0 + v.len * 0.72));
    loopsOf[i].forEach((l, k) => {
      // Several loops on one node are nested: each one wider and taller than the one inside it.
      const h = LOOP_H + k * 10;
      const rStart = mid - half0 - stepBy * k;
      const rEnd = mid + half0 + stepBy * k;
      const c0 = v.c - thickOf(n) / 2;
      const points = [pt(rStart, c0), pt(rStart, c0 - h), pt(rEnd, c0 - h), pt(rEnd, c0)];
      const label = labelLen(l) > 0 ? pt((rStart + rEnd) / 2, c0 - h - labelAcross(l) / 2 - 3) : null;
      if (label) labels.push({ e: l, at: label });
      routed.push({ id: l.id, source: l.source, target: l.target, points, reversed: false, loop: true, label, path: '', arrow: '' });
    });
  });
  // Edges back in the order they were given, so a caller can walk both lists together.
  const given = new Map(real.map((e, i) => [e.id, i]));
  routed.sort((p, q) => given.get(p.id)! - given.get(q.id)!);

  // Move everything so the picture starts at 0,0 — labels and loops included.
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const grow = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const n of placed) { grow(n.x, n.y); grow(n.x + n.width, n.y + n.height); }
  for (const e of routed) for (const p of e.points) grow(p.x, p.y);
  for (const l of labels) {
    grow(l.at.x - l.e.labelWidth! / 2, l.at.y - l.e.labelHeight! / 2);
    grow(l.at.x + l.e.labelWidth! / 2, l.at.y + l.e.labelHeight! / 2);
  }
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
  const round = (v: number) => Math.round(v * 2) / 2;
  for (const n of placed) { n.x = round(n.x - x0); n.y = round(n.y - y0); }
  for (const e of routed) {
    e.points = e.points.map((p) => ({ x: round(p.x - x0), y: round(p.y - y0) }));
    if (e.label) e.label = { x: round(e.label.x - x0), y: round(e.label.y - y0) };
    e.path = roundedPath(e.points, corner, ARROW_LEN - 2);
    e.arrow = arrowPath(e.points);
  }
  return { direction, nodes: placed, edges: routed, width: round(x1 - x0), height: round(y1 - y0), ranks: R,
    mainPath: mainNodes.map((i) => nodes[i].id) };
}

export const ARROW_LEN = 8;
const ARROW_HALF = 3.5;

/** Drop the middle one of three points on a line. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const a = out[out.length - 2]; const b = out[out.length - 1];
    if (a && b && ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01)))
      out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** A line through `points` with every corner rounded, ending `trim` short of the last point (inside the arrowhead). */
export function roundedPath(points: readonly Point[], radius: number, trim = 0): string {
  if (points.length < 2) return '';
  const pts = points.map((p) => ({ ...p }));
  const n = pts.length;
  const lastLen = Math.hypot(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y);
  if (trim > 0 && lastLen > trim + 1) {
    pts[n - 1].x -= ((pts[n - 1].x - pts[n - 2].x) / lastLen) * trim;
    pts[n - 1].y -= ((pts[n - 1].y - pts[n - 2].y) / lastLen) * trim;
  }
  const f = (v: number) => String(Math.round(v * 100) / 100);
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1];
    const la = Math.hypot(b.x - a.x, b.y - a.y); const lc = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, la / 2, lc / 2);
    if (r < 0.5) { d += `L${f(b.x)} ${f(b.y)}`; continue; }
    d += `L${f(b.x - ((b.x - a.x) / la) * r)} ${f(b.y - ((b.y - a.y) / la) * r)}`
      + `Q${f(b.x)} ${f(b.y)} ${f(b.x + ((c.x - b.x) / lc) * r)} ${f(b.y + ((c.y - b.y) / lc) * r)}`;
  }
  return d + `L${f(pts[n - 1].x)} ${f(pts[n - 1].y)}`;
}

/** The arrowhead of a line: a triangle whose tip is the line's last point. */
export function arrowPath(points: readonly Point[]): string {
  const n = points.length;
  if (n < 2) return '';
  return arrowAt(points[n - 1], { x: points[n - 1].x - points[n - 2].x, y: points[n - 1].y - points[n - 2].y });
}

/** An arrowhead with its tip at `tip`, pointing along `dir`. */
export function arrowAt(tip: Point, dir: Point): string {
  const len = Math.hypot(dir.x, dir.y);
  if (len < 0.01) return '';
  const ux = dir.x / len; const uy = dir.y / len;
  const bx = tip.x - ux * ARROW_LEN; const by = tip.y - uy * ARROW_LEN;
  const f = (v: number) => String(Math.round(v * 100) / 100);
  return `M${f(tip.x)} ${f(tip.y)}L${f(bx - uy * ARROW_HALF)} ${f(by + ux * ARROW_HALF)}L${f(bx + uy * ARROW_HALF)} ${f(by - ux * ARROW_HALF)}Z`;
}

/** What is true of a finished picture, counted — the facts the kit's tests hold a layout to. */
export interface Audit {
  /** Places where two edges cross. */
  crossings: number;
  /** Places where two edges lie on one another, or one ends on the other's line. */
  overlaps: number;
  /** Edges that pass through a node. */
  throughNodes: number;
  /** Pairs of nodes that overlap. */
  nodeOverlaps: number;
  /** Labels that lie on a node. */
  labelsOnNodes: number;
  /** Edges that are not returns and yet do not lead to a later rank. */
  backward: number;
  /** Ends that are not in the last rank. */
  endsNotLast: number;
  /** Whether the main path lies on one straight line. */
  mainStraight: boolean;
}

export function audit(l: Layout, nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Audit {
  type S = { e: number; x1: number; y1: number; x2: number; y2: number; h: boolean };
  const segs: S[] = [];
  l.edges.forEach((e, i) => {
    for (let k = 0; k + 1 < e.points.length; k++) {
      const a = e.points[k]; const b = e.points[k + 1];
      segs.push({ e: i, x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y), h: Math.abs(a.y - b.y) < 0.01 });
    }
  });
  let crossings = 0; let overlaps = 0;
  const t = 0.25;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const p = segs[i]; const q = segs[j];
    if (p.e === q.e) continue;
    if (p.h === q.h) {
      const same = p.h ? Math.abs(p.y1 - q.y1) < t : Math.abs(p.x1 - q.x1) < t;
      const shared = p.h ? Math.min(p.x2, q.x2) - Math.max(p.x1, q.x1) : Math.min(p.y2, q.y2) - Math.max(p.y1, q.y1);
      if (same && shared > t) overlaps++;
      continue;
    }
    const hz = p.h ? p : q; const vt = p.h ? q : p;
    const inX = vt.x1 > hz.x1 + t && vt.x1 < hz.x2 - t;
    const inY = hz.y1 > vt.y1 + t && hz.y1 < vt.y2 - t;
    const onX = vt.x1 >= hz.x1 - t && vt.x1 <= hz.x2 + t;
    const onY = hz.y1 >= vt.y1 - t && hz.y1 <= vt.y2 + t;
    if (inX && inY) crossings++;
    else if (onX && onY) overlaps++;
  }
  let throughNodes = 0;
  l.edges.forEach((_, i) => {
    const hit = l.nodes.some((n) => segs.some((s) => s.e === i
      && s.x2 > n.x + 1 && s.x1 < n.x + n.width - 1 && s.y2 > n.y + 1 && s.y1 < n.y + n.height - 1));
    if (hit) throughNodes++;
  });
  let nodeOverlaps = 0;
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
    const a = l.nodes[i]; const b = l.nodes[j];
    if (a.x < b.x + b.width - t && b.x < a.x + a.width - t && a.y < b.y + b.height - t && b.y < a.y + a.height - t) nodeOverlaps++;
  }
  const size = new Map(edges.map((e) => [e.id, e]));
  let labelsOnNodes = 0;
  for (const e of l.edges) {
    const s = size.get(e.id);
    if (!e.label || !s?.labelWidth || !s.labelHeight) continue;
    const x = e.label.x - s.labelWidth / 2; const y = e.label.y - s.labelHeight / 2;
    if (l.nodes.some((n) => x < n.x + n.width - t && n.x < x + s.labelWidth! - t && y < n.y + n.height - t && n.y < y + s.labelHeight! - t)) labelsOnNodes++;
  }
  const at = new Map(l.nodes.map((n) => [n.id, n]));
  const backward = l.edges.filter((e) => !e.reversed && !e.loop && at.get(e.target)!.rank <= at.get(e.source)!.rank).length;
  const leaves = new Set(edges.filter((e) => e.source !== e.target).map((e) => e.source));
  const endsNotLast = nodes.filter((n) => n.terminal && !leaves.has(n.id) && at.get(n.id)!.rank !== l.ranks - 1).length;
  const flowsAlongX = l.direction === 'right' || l.direction === 'left';
  const centres = l.mainPath.map((id) => at.get(id)!).map((n) => (flowsAlongX ? n.y + n.height / 2 : n.x + n.width / 2));
  const mainStraight = centres.every((c) => Math.abs(c - centres[0]) < 0.75);
  return { crossings, overlaps, throughNodes, nodeOverlaps, labelsOnNodes, backward, endsNotLast, mainStraight };
}

/** A short fingerprint of a layout: two runs over the same graph must answer the same one. */
export function fingerprint(l: Layout): string {
  let h = 2166136261;
  const eat = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } };
  for (const n of l.nodes) eat(`${n.id}@${n.x},${n.y};`);
  for (const e of l.edges) eat(`${e.id}:${e.path};`);
  return (h >>> 0).toString(16).padStart(8, '0');
}
