// The FlowCanvas control — a foreign-control shim (mount/update/destroy) over `@xyflow/system`, React Flow's
// framework-independent core.
//
// ⭐ THE DIVISION OF LABOUR, which is the whole design:
//   · xyflow owns the GESTURES — pan/zoom (XYPanZoom), dragging a node (XYDrag), drawing a connection (XYHandle) — and
//     the geometry that goes with them (handle bounds, edge paths, fit-to-view).
//   · this shim owns the DOM those gestures act on: a pane, a transformed viewport, one positioned wrapper per node, the
//     ports on its border, and the SVG edges. xyflow reads that DOM through a small host contract (class names and
//     data-attributes, listed at `buildHandle` and `buildNode`) and never creates any of it.
//   · the PLATFORM renders what each node says: `host.cells[type].render(row, body)` builds the app's own Osy# template
//     into the wrapper's body — its bindings, actions and reads are ordinary Osy#, live and secured as anywhere.
//   · the APP owns the data: a move or a new edge is an EVENT carrying the app's rows, and the app writes it through its
//     unit of work. The shim keeps no model of its own beyond xyflow's lookup, rebuilt from props on every update.
//
// Type-check it with `npm run typecheck`; `flow.control.check.ts` holds it to the ABI the `control` block declares.
//
// The XY chunk is never `import`ed statically: `import(host.chunkUrl("XY"))` is a dynamic import of a runtime string,
// which esbuild leaves alone — the chunk is content-addressed on its own and survives a shim release in the cache.

import type { FlowCanvasHandle, FlowCanvasHost, FlowCanvasProps } from './flow.control';
import FLOW_CSS from './flow.css';

type Host = FlowCanvasHost;
type Props = FlowCanvasProps;
type Row = Record<string, unknown> & { id?: string };
type Transform = [number, number, number];
type Side = 'left' | 'right' | 'top' | 'bottom';

// ── the XY chunk's surface, declared STRUCTURALLY ────────────────────────────────────────────────────────────────
// Deliberately not `import type … from '@xyflow/system'`: the package is a BUILD dependency (the thing
// `scripts/build-chunks.mjs` bundles), and at run time the module arrives as a URL the platform minted. What the shim
// needs is small enough to state, and stating it makes an upgrade that changes a signature a type error here.
interface InternalNode {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };   // absent until the node is measured — never in a host with no layout
  selected?: boolean;
  internals: {
    positionAbsolute: { x: number; y: number };
    handleBounds?: { source?: HandleBound[] | null; target?: HandleBound[] | null };
    userNode: UserNode;
  };
}
interface HandleBound { id: string | null; type: 'source' | 'target'; position: Side; x: number; y: number; width: number; height: number; nodeId: string }
interface UserNode { id: string; position: { x: number; y: number }; data: Record<string, unknown>; draggable?: boolean; selected?: boolean }
interface DragItem { id: string; position: { x: number; y: number }; internals: { positionAbsolute: { x: number; y: number } } }
interface PanZoomInstance {
  update(options: Record<string, unknown>): void;
  destroy(): void;
  getViewport(): { x: number; y: number; zoom: number };
  setViewport(v: { x: number; y: number; zoom: number }, o?: { duration?: number }): Promise<unknown>;
  setViewportConstrained(v: { x: number; y: number; zoom: number }, extent: unknown, translateExtent: unknown): Promise<unknown>;
  scaleBy(factor: number, o?: { duration?: number }): Promise<boolean>;
}
interface ConnectionState {
  inProgress?: boolean;
  from?: { x: number; y: number };
  fromPosition?: Side;
  to?: { x: number; y: number };
  toPosition?: Side;
}
interface XyModule {
  XYPanZoom(p: Record<string, unknown>): PanZoomInstance;
  XYDrag(p: Record<string, unknown>): { update(p: Record<string, unknown>): void; destroy(): void };
  XYHandle: { onPointerDown(event: MouseEvent | TouchEvent, p: Record<string, unknown>): void };
  XYMinimap(p: { domNode: Element; panZoom: PanZoomInstance; getTransform: () => Transform; getViewScale: () => number }):
    { update(p: Record<string, unknown>): void; destroy(): void };
  adoptUserNodes(nodes: UserNode[], lookup: Map<string, InternalNode>, parents: Map<string, unknown>, o?: Record<string, unknown>): unknown;
  updateNodeInternals(updates: Map<string, { id: string; nodeElement: HTMLElement; force?: boolean }>, lookup: Map<string, InternalNode>,
    parents: Map<string, unknown>, domNode: HTMLElement, origin?: [number, number]): { changes: unknown[]; updatedInternals: boolean };
  getBezierPath(p: Record<string, unknown>): [string, number, number, number, number];
  getSmoothStepPath(p: Record<string, unknown>): [string, number, number, number, number];
  getStraightPath(p: Record<string, unknown>): [string, number, number, number, number];
  getHandlePosition(node: InternalNode, handle: HandleBound, fallback?: Side, center?: boolean): { x: number; y: number };
  fitViewport(p: Record<string, unknown>, o?: Record<string, unknown>): Promise<boolean>;
  panBy(p: Record<string, unknown>): Promise<boolean>;
  infiniteExtent: unknown;
}

/** The `Layout` chunk's surface — `@dagrejs/dagre`'s graph and layout, stated structurally as XY's is. */
interface DagreGraph {
  setGraph(g: Record<string, unknown>): void;
  setDefaultEdgeLabel(f: () => Record<string, unknown>): void;
  setNode(id: string, n: { width: number; height: number }): void;
  setEdge(source: string, target: string): void;
  node(id: string): { x: number; y: number; width: number; height: number } | undefined;
}
interface LayoutModule {
  Graph: new (o?: Record<string, unknown>) => DagreGraph;
  layout(g: DagreGraph): void;
}

const LIB = 'osy';          // xyflow's class prefix: `.osy-flow__handle` is what XYHandle looks for under the pointer
const SVG = 'http://www.w3.org/2000/svg';
const KEY_STEP = 10;        // canvas units per arrow press; Shift × 5
let flowSeq = 0;

// What a screen-reader user hears when they ask (`?`) and what every node and edge points at with aria-describedby.
// Written once, here, so the keyboard model and its description cannot drift apart.
const HELP_CANVAS = 'Canvas. Tab moves between nodes and their ports. On a node: arrow keys move it (Shift for larger steps), '
  + 'Alt with an arrow goes to the nearest node that way, E goes to its edges, Delete removes it. On a port: Enter starts a '
  + 'connection and Enter on another node\'s port completes it; Escape cancels. On an edge: S and T go to its two ends, '
  + 'E to the next edge, Delete removes it. Space adds a node to the selection or takes it out; Control A selects every '
  + 'node; arrow keys and Delete then act on the whole selection. Shift L tidies the layout. Plus and minus zoom; zero '
  + 'fits the picture. Question mark repeats this.';
const HELP_READONLY = 'Canvas, read only. Tab moves between nodes. On a node: Alt with an arrow goes to the nearest node '
  + 'that way and E goes to its edges. On an edge: S and T go to its two ends, E to the next edge. Plus and minus zoom; '
  + 'zero fits the picture.';
const HELP_NODE = 'Arrow keys move it. E: its edges. Delete removes it.';
const HELP_EDGE = 'S and T go to its ends. E: next edge. Delete removes it.';

function ensureStyles(doc: Document) {
  if (doc.getElementById('osy-flow-styles')) return;
  const style = doc.createElement('style');
  style.id = 'osy-flow-styles';
  style.textContent = FLOW_CSS;
  doc.head.appendChild(style);
}

/** A number out of a row field — a `double` arrives as a JS number, a `decimal` as an exact object. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** A row's KEY: an entity row's `id` (the platform's own), or — for a list of the app's VALUE objects, which have no
 *  row id (a workflow's `States`, built by the compiler) — their `Id` field. Empty: the row cannot be drawn. */
function rid(r: Row): string {
  const v = r.id ?? (r as Record<string, unknown>).Id;
  return v == null ? '' : String(v);
}

/** A reference field arrives as the referenced row's id (a string); a nested record, if ever, carries `id`. */
function refId(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'id' in (v as Row)) return String((v as Row).id);
  return String(v);
}

interface NodeView {
  id: string;
  row: Row;
  type: string;
  wrapper: HTMLDivElement;
  body: HTMLDivElement;
  /** The node's own description (its type and how it is connected), read after its name. */
  desc: HTMLSpanElement;
  slot: { update(row: unknown): void; destroy(): void } | null;
  drag: { update(p: Record<string, unknown>): void; destroy(): void } | null;
  ports: string;       // a fingerprint of the ports built, so a changed type rebuilds them
}

class FlowCanvas {
  readonly ready: Promise<void>;
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly viewport: HTMLDivElement;
  private readonly edgeLayer: SVGSVGElement;
  private readonly connectionPath: SVGPathElement;
  private readonly status: HTMLDivElement;
  private readonly labelLayer: HTMLDivElement;
  private readonly helpNode: HTMLSpanElement;
  private readonly helpEdge: HTMLSpanElement;
  private readonly flowId = `osy-flow-${++flowSeq}`;
  private xy: XyModule | null = null;
  private panZoom: PanZoomInstance | null = null;
  private transform: Transform = [0, 0, 1];
  private readonly nodeLookup = new Map<string, InternalNode>();
  private readonly parentLookup = new Map<string, unknown>();
  private readonly views = new Map<string, NodeView>();
  private userNodes: UserNode[] = [];
  private edgeRows: Row[] = [];
  private selected: { kind: 'node' | 'edge'; id: string } | null = null;
  private pendingFrom: { nodeId: string; port: string } | null = null;
  /** The node a keyboard user reached the current edge FROM (E on a node) — so E walks that node's edges and Escape
   *  goes back to it, rather than wherever the edge happens to start. */
  private edgeOrigin: string | null = null;
  private moveAnnounce: ReturnType<typeof setTimeout> | null = null;
  /** The SELECTION — any number of nodes and edges. `selected` above is its primary member (the one last picked),
   *  which is what `nodeSelected` reports and the probe calls `selected`. */
  private readonly selNodes = new Set<string>();
  private readonly selEdges = new Set<string>();
  private selectionQueued = false;
  private lastSelectionKey = '';
  private panOptions: Record<string, unknown> = {};
  private box: { el: HTMLDivElement; x0: number; y0: number; additive: boolean } | null = null;
  private minimap: { el: HTMLDivElement; svg: SVGSVGElement; nodes: SVGGElement; mask: SVGPathElement;
    xy: { update(p: Record<string, unknown>): void; destroy(): void }; scale: number } | null = null;
  private controlsPanel: HTMLDivElement | null = null;
  private toolsKey = '';
  private layoutModule: Promise<LayoutModule> | null = null;
  /** For `autoLayout: always` — where the LAST layout put each node, which is where it is drawn (the row's own position
   *  fields are ignored). Re-laid out when the set of nodes or edges changes. */
  private laidOut = new Map<string, { x: number; y: number }>();
  private laidOutKey = '';
  private layingOut = false;
  private glide: number | null = null;
  private highlightKey = '';
  /** Set once the first picture is on screen: from then on, what ARRIVES and LEAVES moves; the first paint does not. */
  private painted = false;
  private resize: ResizeObserver | null = null;
  private fitted = false;
  private destroyed = false;

  constructor(private readonly el: HTMLElement, private props: Props, private readonly host: Host) {
    this.doc = el.ownerDocument;
    ensureStyles(this.doc);
    // The host FILLS the box the app gave it because the control declares `sizing fill` and the platform sizes it —
    // this shim never touches its host's size. A pane shorter than its box would break XYHandle's auto-pan, which pans
    // when the pointer nears the pane's edge: mid-connection, the pointer would read as "near the bottom edge" of a pane
    // that ended early, and the graph would pan away.
    this.root = this.doc.createElement('div');
    this.root.className = 'osy-flow';
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-roledescription', 'canvas');
    this.root.setAttribute('aria-label', HELP_CANVAS);
    this.viewport = this.doc.createElement('div');
    this.viewport.className = 'xyflow__viewport';   // ⚠ this exact class: `updateNodeInternals` reads the zoom off it
    this.edgeLayer = this.doc.createElementNS(SVG, 'svg');
    this.edgeLayer.setAttribute('class', 'osy-flow__edges');
    this.connectionPath = this.doc.createElementNS(SVG, 'path');
    this.connectionPath.setAttribute('class', 'osy-flow__connection');
    this.edgeLayer.appendChild(this.connectionPath);
    this.viewport.appendChild(this.edgeLayer);
    // Edge LABELS are HTML, not SVG text: they take the app's font and wrap like text, and they sit above the edges
    // but below the nodes, so a label never covers a port.
    this.labelLayer = this.doc.createElement('div');
    this.labelLayer.className = 'osy-flow__labels';
    this.labelLayer.setAttribute('aria-hidden', 'true');   // each label is already in its edge's accessible name
    this.viewport.appendChild(this.labelLayer);
    // The two shared how-to lines every node and every edge is described by (after its own name and description).
    this.helpNode = this.hidden(`${this.flowId}-help-node`, HELP_NODE);
    this.helpEdge = this.hidden(`${this.flowId}-help-edge`, HELP_EDGE);
    this.status = this.doc.createElement('div');
    this.status.className = 'osy-flow__status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.root.append(this.viewport, this.status, this.helpNode, this.helpEdge);
    this.el.replaceChildren(this.root);
    this.root.addEventListener('keydown', this.onKeyDown);
    // CAPTURE phase: a box selection (Shift + drag on the empty pane) has to switch the pane's pan off BEFORE d3-zoom's
    // own mousedown listener on this same element decides to start a pan.
    this.root.addEventListener('mousedown', this.onPaneMouseDown, true);
    this.root.addEventListener('focusin', this.onFocusIn);

    this.ready = import(/* @vite-ignore */ this.host.chunkUrl('XY')).then((mod: XyModule) => {
      if (this.destroyed) return;
      this.xy = mod;
      this.start();
    });
  }

  private get readOnly(): boolean { return this.props.readOnly ?? false; }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────
  private start() {
    const xy = this.xy!;
    this.panZoom = xy.XYPanZoom({
      domNode: this.root, minZoom: 0.2, maxZoom: 2.5, translateExtent: xy.infiniteExtent,
      viewport: { x: 0, y: 0, zoom: 1 },
      onDraggingChange: () => {},
    });
    this.panOptions = {
      noWheelClassName: 'nowheel', noPanClassName: 'nopan', preventScrolling: true,
      panOnScroll: false, panOnDrag: true, panOnScrollMode: 'free', panOnScrollSpeed: 0.5,
      userSelectionActive: false, zoomOnPinch: true, zoomOnScroll: true, zoomOnDoubleClick: false,
      zoomActivationKeyPressed: false, lib: LIB, connectionInProgress: false, paneClickDistance: 0,
      onTransformChange: (t: Transform) => { this.transform = t; this.applyTransform(); },
    };
    this.panZoom.update(this.panOptions);
    // A host with no layout engine (a test DOM) has no ResizeObserver: the canvas still draws its nodes, it simply
    // never learns their sizes — so nothing is measured, and nothing that reads a size may assume one.
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      const updates = new Map<string, { id: string; nodeElement: HTMLElement; force: boolean }>();
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) updates.set(id, { id, nodeElement: e.target as HTMLElement, force: true });
      }
      this.measure(updates);
    });
    this.sync();
  }

  update(next: Props) {
    this.props = next;
    if (this.xy) this.sync();
  }

  destroy() {
    this.destroyed = true;
    for (const v of this.views.values()) this.dropView(v);
    this.views.clear();
    this.resize?.disconnect();
    this.panZoom?.destroy();
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.removeEventListener('mousedown', this.onPaneMouseDown, true);
    this.root.removeEventListener('focusin', this.onFocusIn);
    this.minimap?.xy.destroy();
    this.endBox();
    if (this.moveAnnounce) clearTimeout(this.moveAnnounce);
    if (this.glide) cancelAnimationFrame(this.glide);
    this.el.replaceChildren();
  }

  layoutCommand() { void this.ready.then(() => this.runLayout('asked')); }
  fitViewCommand() { void this.ready.then(() => this.fit(true)); }

  probe() {
    return {
      nodes: this.views.size,
      edges: this.edgeLayer.querySelectorAll('.osy-flow__edge').length,
      zoom: Math.round(this.transform[2] * 1000) / 1000,
      selected: this.selected?.id ?? null,
      focused: this.focusedId(),
      selection: this.selNodes.size + this.selEdges.size,
    };
  }

  /** The id of the node or edge that has keyboard focus, or null — what a keyboard test asks "where am I?". */
  private focusedId(): string | null {
    const a = this.doc.activeElement;
    if (!a || !this.root.contains(a)) return null;
    const hit = (a as Element).closest?.('.osy-flow__node, .osy-flow__edge') as HTMLElement | SVGGElement | null;
    return hit?.dataset.id ?? null;
  }

  // ── props → xyflow's lookup → DOM ──────────────────────────────────────────────────────────────────────────────
  private sync() {
    const p = this.props;
    const rows = (p.nodes ?? []) as unknown as Row[];
    const xField = p.xField ?? 'X';
    const yField = p.yField ?? 'Y';
    const firstType = p.nodeTypes?.[0]?.Name ?? '';
    this.root.classList.toggle('readonly', this.readOnly);

    const always = this.props.autoLayout === 'always';
    this.userNodes = rows.filter((r) => rid(r) !== '').map((r) => ({
      id: rid(r),
      position: always ? (this.laidOut.get(rid(r)) ?? { x: 0, y: 0 }) : { x: num(r[xField]), y: num(r[yField]) },
      data: r,
      draggable: !this.readOnly,
      selected: this.selNodes.has(rid(r)),
    }));
    // Keep what was measured: `adoptUserNodes` rebuilds each internal node from the user node, and a node it rebuilt
    // without `measured` has no size and no handle bounds until the ResizeObserver fires again — which it does not,
    // because the element did not change size. So the measurement rides the user node, as React Flow's store does.
    for (const u of this.userNodes) {
      const prev = this.nodeLookup.get(u.id);
      if (prev?.measured?.width) (u as UserNode & { measured?: unknown }).measured = { ...prev.measured };
    }
    this.xy!.adoptUserNodes(this.userNodes, this.nodeLookup, this.parentLookup,
      { nodeOrigin: [0, 0], nodeExtent: this.xy!.infiniteExtent, elevateNodesOnSelect: false, checkEquality: false });
    // …and the handle bounds, which `adoptUserNodes` resets whenever it rebuilds a node.
    const remeasure = new Map<string, { id: string; nodeElement: HTMLElement; force: boolean }>();

    const seen = new Set<string>();
    for (const u of this.userNodes) {
      seen.add(u.id);
      const row = u.data as Row;
      const type = (p.typeField ? String(row[p.typeField] ?? '') : '') || firstType;
      let view = this.views.get(u.id);
      if (!view) {
        view = this.buildNode(u.id, row, type);
        this.views.set(u.id, view);
      } else {
        view.row = row;
        if (view.type !== type) {        // its type changed: a different template, different ports
          view.slot?.destroy();
          view.type = type;
          view.slot = this.renderBody(view);
        } else {
          view.slot?.update(row);
        }
      }
      this.buildPorts(view);
      view.wrapper.classList.toggle('selected', !!u.selected);
      view.wrapper.classList.toggle('current', this.isCurrent(u.id));
      view.wrapper.classList.toggle('visited', !this.isCurrent(u.id) && this.isVisited(u.id));
      view.drag?.update(this.dragParams(view));
      this.place(view);
      remeasure.set(u.id, { id: u.id, nodeElement: view.wrapper, force: true });
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) { this.views.delete(id); this.leave(view); }
    }
    this.edgeRows = ((p.edges ?? []) as unknown as Row[]).filter((r) => rid(r) !== '');
    // A row that left (deleted, or filtered out by the app) leaves the selection with it.
    const edgeIds = new Set(this.edgeRows.map((r) => rid(r)));
    let pruned = false;
    for (const id of [...this.selNodes]) if (!this.views.has(id)) { this.selNodes.delete(id); pruned = true; }
    for (const id of [...this.selEdges]) if (!edgeIds.has(id)) { this.selEdges.delete(id); pruned = true; }
    if (this.selected && !(this.selected.kind === 'node' ? this.selNodes : this.selEdges).has(this.selected.id)) this.selected = null;
    if (pruned) this.queueSelectionChanged();
    this.syncChrome();
    // Where the run IS moved: say so (a sighted user sees the ring jump; a listener has to be told).
    const hk = (p.highlighted ?? []).join(',');
    if (hk !== this.highlightKey) {
      const first = this.highlightKey === '';
      this.highlightKey = hk;
      const names = (p.highlighted ?? []).map((id) => this.views.get(id)).filter((v): v is NodeView => !!v).map((v) => this.labelOf(v));
      if (!first && names.length) this.announce(`Now at ${names.join(', ')}.`);
    }
    this.measure(remeasure);
    this.root.setAttribute('aria-label', this.readOnly ? HELP_READONLY : HELP_CANVAS);
    // After the templates have had their turn: a name that falls back to the node's own text reads what the template
    // RENDERED, and a template updates in its own effect, not inside this call.
    queueMicrotask(() => { if (!this.destroyed) this.describeAll(); });
    // From the end of the FIRST complete sync on, what arrives animates. Not from inside it: an observer may fire while
    // the first nodes are still being built (a test host's fires synchronously), and the first paint must not move.
    if (this.views.size > 0 || this.edgeRows.length > 0) this.painted = true;
  }

  private measure(updates: Map<string, { id: string; nodeElement: HTMLElement; force: boolean }>) {
    if (!this.xy || updates.size === 0) { this.drawEdges(); return; }
    this.xy.updateNodeInternals(updates, this.nodeLookup, this.parentLookup, this.root, [0, 0]);
    this.drawEdges();
    const measured = this.userNodes.length > 0 && [...this.nodeLookup.values()].every((n) => n.measured?.width);
    if (!measured) return;
    const mode = this.props.autoLayout ?? 'initial';
    if (mode === 'always' && this.shapeKey() !== this.laidOutKey) { void this.runLayout('auto'); return; }
    if (!this.fitted) {
      this.fitted = true;
      if (mode === 'initial' && this.unpositioned()) { void this.runLayout('auto'); return; }
      void this.fit();
    }
  }

  /** Fit the whole picture — or, `animated`, glide to it (unless the person asked for less motion). */
  private async fit(animated = false) {
    const r = this.root.getBoundingClientRect();
    if (!this.panZoom || r.width === 0) return;
    await this.xy!.fitViewport({
      nodes: this.nodeLookup, width: r.width, height: r.height, panZoom: this.panZoom, minZoom: 0.2, maxZoom: 1,
    }, { padding: 0.15, duration: animated ? this.motionMs() : 0 });
  }

  private isCurrent(id: string): boolean { return (this.props.highlighted ?? []).includes(id); }
  private isVisited(id: string): boolean { return (this.props.visited ?? []).includes(id); }

  /** A graph nobody has placed: more than one node and all of them at one point (the default 0,0 of a new row). */
  private unpositioned(): boolean {
    const ps = this.userNodes.map((u) => u.position);
    return ps.length > 1 && ps.every((p) => p.x === ps[0].x && p.y === ps[0].y);
  }

  /** Which nodes and edges exist — a layout is re-run for `always` only when THIS changes, never for a field edit. */
  private shapeKey(): string {
    const sf = this.props.sourceField ?? 'Source';
    const tf = this.props.targetField ?? 'Target';
    return [...this.views.keys()].sort().join(',') + '|'
      + this.edgeRows.map((r) => `${refId(r[sf])}>${refId(r[tf])}`).sort().join(',');
  }

  private loadLayout(): Promise<LayoutModule> {
    return this.layoutModule ??= import(/* @vite-ignore */ this.host.chunkUrl('Layout')) as Promise<LayoutModule>;
  }

  /** Lay the graph out with dagre and move every node to its place — gliding there (the theme's motion) unless this is
   *  the first paint or the person prefers less motion.
   *  `auto`   — the canvas decided (initial / always): an editor's first layout is still reported, as `nodeMoved`s, so
   *             the app stores what the person sees; a picture reports nothing.
   *  `asked`  — the Tidy button or the `Layout` command: reported in an editor, one announcement for the whole move. */
  private async runLayout(why: 'auto' | 'asked') {
    if (this.layingOut || !this.xy) return;
    this.layingOut = true;
    try {
      const mod = await this.loadLayout();
      if (this.destroyed) return;
      const rankdir = ({ right: 'LR', down: 'TB', left: 'RL', up: 'BT' } as Record<string, string>)[this.props.layoutDirection ?? 'right'] ?? 'LR';
      const g = new mod.Graph({ multigraph: false });
      g.setGraph({ rankdir, nodesep: 48, ranksep: 96, edgesep: 24, marginx: 0, marginy: 0 });
      g.setDefaultEdgeLabel(() => ({}));
      for (const n of this.nodeLookup.values()) g.setNode(n.id, { width: n.measured?.width ?? 0, height: n.measured?.height ?? 0 });
      for (const r of this.edgeRows) {
        const s = this.endOf(rid(r), 'source');
        const t = this.endOf(rid(r), 'target');
        if (this.nodeLookup.has(s) && this.nodeLookup.has(t) && s !== t) g.setEdge(s, t);
      }
      mod.layout(g);
      const snap = this.props.snap ?? 0;
      const targets = new Map<string, { x: number; y: number }>();
      for (const n of this.nodeLookup.values()) {
        const p = g.node(n.id);
        if (!p) continue;
        let x = p.x - p.width / 2;
        let y = p.y - p.height / 2;
        x = snap > 0 ? Math.round(x / snap) * snap : Math.round(x);
        y = snap > 0 ? Math.round(y / snap) * snap : Math.round(y);
        targets.set(n.id, { x, y });
      }
      const first = !this.fitted || this.laidOutKey === '';
      this.laidOut = targets;
      this.laidOutKey = this.shapeKey();
      await this.glideTo(targets, first && why === 'auto' ? 0 : this.motionMs());
      const report = !this.readOnly && this.props.autoLayout !== 'always';
      if (report && targets.size > 0) this.gesture('Lay out');
      if (report) for (const [id, p] of targets) { const v = this.views.get(id); if (v) this.emitMoved(v, p.x, p.y); }
      this.fitted = true;
      await this.fit(!first);
      if (why === 'asked') this.announce(`Laid out ${targets.size} nodes.`);
    } finally {
      this.layingOut = false;
    }
  }

  /** Move nodes to new positions over `ms`, redrawing edges every frame so they stay attached. */
  private glideTo(targets: Map<string, { x: number; y: number }>, ms: number): Promise<void> {
    const from = new Map<string, { x: number; y: number }>();
    for (const [id] of targets) { const n = this.nodeLookup.get(id); if (n) from.set(id, { ...n.position }); }
    const set = (t: number) => {
      const e = t < 1 ? 1 - Math.pow(1 - t, 3) : 1;          // ease-out: fast away, gentle arrival
      for (const [id, to] of targets) {
        const n = this.nodeLookup.get(id); const a = from.get(id);
        if (!n || !a) continue;
        const p = { x: a.x + (to.x - a.x) * e, y: a.y + (to.y - a.y) * e };
        n.position = p;
        n.internals.positionAbsolute = { ...p };
        const u = this.userNodes.find((x) => x.id === id);
        if (u) u.position = t < 1 ? p : { ...to };
        const v = this.views.get(id);
        if (v) this.place(v);
      }
      this.drawEdges();
    };
    if (this.glide) cancelAnimationFrame(this.glide);
    if (ms <= 0) { set(1); return Promise.resolve(); }
    return new Promise((done) => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        set(t);
        if (t < 1 && !this.destroyed) this.glide = requestAnimationFrame(step); else { this.glide = null; done(); }
      };
      this.glide = requestAnimationFrame(step);
    });
  }

  /** How long a view change takes: the theme's `Motion.Normal`, or 0 when the person prefers reduced motion. */
  private motionMs(): number {
    if (this.reducedMotion()) return 0;
    return this.motion().ms;
  }

  private reducedMotion(): boolean {
    return !!this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  /** The theme's `Motion.Normal` — a transition shorthand (`all 200ms cubic-bezier(…)`) — split into the duration and
   *  easing an element animation needs, so the canvas moves exactly as fast, and with the same curve, as the rest of
   *  the app. A theme that does not say falls back to a short ease-out. */
  private motion(): { ms: number; easing: string } {
    const token = this.host.tokens.get('motion-normal') ?? '';
    const d = /([\d.]+)(ms|s)\b/.exec(token);
    const e = /(cubic-bezier\([^)]*\)|ease-in-out|ease-out|ease-in|linear|ease)/.exec(token);
    return { ms: d ? Number(d[1]) * (d[2] === 's' ? 1000 : 1) : 200, easing: e ? e[1] : 'cubic-bezier(.2,.8,.2,1)' };
  }

  // ── motion: arriving, leaving, drawing in ────────────────────────────────────────────────────────────────────────
  /** A new node eases in — a small rise in scale with its fade. Someone who asked for less motion gets the fade alone,
   *  which carries the same news ("this is new") without the movement. */
  private enter(el: HTMLElement) {
    if (typeof el.animate !== 'function') return;          // a host with no animation engine: it simply appears
    const { ms, easing } = this.motion();
    const still = this.reducedMotion();
    el.animate(still
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, scale: '0.94' }, { opacity: 1, scale: '1' }], { duration: ms, easing });
  }

  /** A node whose row left fades out where it stood, THEN goes — its edges are already gone, so for that moment it is
   *  plainly the one being removed. It no longer takes part in anything: not focusable, not draggable, not measured. */
  private leave(view: NodeView) {
    view.drag?.destroy();
    view.drag = null;
    this.resize?.unobserve(view.wrapper);
    view.wrapper.classList.add('leaving');
    view.wrapper.removeAttribute('tabindex');
    view.wrapper.setAttribute('aria-hidden', 'true');
    const { ms, easing } = this.motion();
    const still = this.reducedMotion();
    if (ms <= 0 || typeof view.wrapper.animate !== 'function') { this.dropView(view); return; }
    const a = view.wrapper.animate(still
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.94' }], { duration: ms, easing, fill: 'forwards' });
    a.onfinish = () => this.dropView(view);
    a.oncancel = () => this.dropView(view);
  }

  /** A new edge is DRAWN from its source to its target — the one place motion explains something a still frame
   *  cannot: which way the new connection runs. Reduced motion: it simply appears. */
  private drawIn(g: SVGGElement) {
    if (this.reducedMotion()) return;
    const line = g.querySelector<SVGPathElement>('.osy-flow__edge-path');
    if (!line || typeof line.getTotalLength !== 'function' || typeof line.animate !== 'function') return;
    const len = Math.max(1, line.getTotalLength());
    const { ms, easing } = this.motion();
    line.animate([{ strokeDasharray: `${len}`, strokeDashoffset: `${len}` }, { strokeDasharray: `${len}`, strokeDashoffset: '0' }],
      { duration: ms * 1.6, easing });
  }

  private zoomBy(factor: number) {
    void this.panZoom?.scaleBy(factor, { duration: this.motionMs() });
  }

  // ── chrome: the controls panel and the minimap ──────────────────────────────────────────────────────────────────
  private syncChrome() {
    this.root.dataset.background = this.props.background ?? 'dots';
    const wantControls = this.props.controls ?? true;
    if (wantControls && !this.controlsPanel) this.buildControls();
    this.syncTools();
    if (!wantControls && this.controlsPanel) { this.controlsPanel.remove(); this.controlsPanel = null; }
    const wantMap = this.props.minimap ?? false;
    if (wantMap && !this.minimap) this.buildMinimap();
    if (!wantMap && this.minimap) { this.minimap.xy.destroy(); this.minimap.el.remove(); this.minimap = null; }
    this.applyTransform();
  }

  /** Zoom in, zoom out, fit — real buttons, so a keyboard and a screen reader reach them like anything else. */
  private buildControls() {
    const panel = this.doc.createElement('div');
    panel.className = 'osy-flow__controls nopan nowheel';
    panel.setAttribute('role', 'toolbar');
    panel.setAttribute('aria-label', 'View');
    const button = (label: string, glyph: string, run: () => void) => {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = 'osy-flow__control';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${glyph}</svg>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      panel.appendChild(b);
      return b;
    };
    button('Zoom in', '<path d="M8 3v10M3 8h10"/>', () => this.zoomBy(1.2));
    button('Zoom out', '<path d="M3 8h10"/>', () => this.zoomBy(1 / 1.2));
    button('Fit the picture', '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>', () => void this.fit(true));
    const tidy = button('Tidy up (lay the graph out)', '<path d="M2 4h4M10 4h4M2 12h4M10 12h4M6 4l4 8M6 12l4-8"/>',
      () => void this.runLayout('asked'));
    tidy.classList.add('osy-flow__control--tidy');
    this.root.appendChild(panel);
    this.controlsPanel = panel;
    this.syncTools();
  }

  /** The app's own `tools`, as text buttons after the canvas's own. Each runs the action the app gave it. */
  private syncTools() {
    const panel = this.controlsPanel;
    if (!panel) return;
    panel.querySelector('.osy-flow__control--tidy')?.toggleAttribute('hidden', this.readOnly);
    const tools = (this.props.tools ?? []) as unknown as { Label: string; Run: unknown }[];
    const key = tools.map((t) => t.Label).join('\u0000');
    if (key === this.toolsKey) {
      // Same labels: rebind the actions (a new render hands new handles) without rebuilding the buttons.
      panel.querySelectorAll<HTMLButtonElement>('.osy-flow__tool').forEach((b, i) => { (b as unknown as { run: unknown }).run = tools[i]?.Run; });
      return;
    }
    this.toolsKey = key;
    panel.querySelectorAll('.osy-flow__tool').forEach((b) => b.remove());
    for (const t of tools) {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = 'osy-flow__control osy-flow__tool';
      b.textContent = t.Label;
      (b as unknown as { run: unknown }).run = t.Run;
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const run = (b as unknown as { run: unknown }).run;
        if (typeof run === 'function') (run as () => void)();
      });
      panel.appendChild(b);
    }
  }

  private buildMinimap() {
    if (!this.xy || !this.panZoom) return;
    const el = this.doc.createElement('div');
    el.className = 'osy-flow__minimap nopan nowheel';
    const svg = this.doc.createElementNS(SVG, 'svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Overview of the whole canvas; drag it to move the view.');
    const nodes = this.doc.createElementNS(SVG, 'g');
    nodes.setAttribute('class', 'osy-flow__minimap-nodes');
    const mask = this.doc.createElementNS(SVG, 'path');
    mask.setAttribute('class', 'osy-flow__minimap-mask');
    mask.setAttribute('fill-rule', 'evenodd');
    svg.append(nodes, mask);
    el.appendChild(svg);
    this.root.appendChild(el);
    const mm = { el, svg, nodes, mask, scale: 1, xy: null as unknown as { update(p: Record<string, unknown>): void; destroy(): void } };
    mm.xy = this.xy.XYMinimap({ domNode: svg, panZoom: this.panZoom, getTransform: () => this.transform, getViewScale: () => mm.scale });
    this.minimap = mm;
    this.drawMinimap();
  }

  /** The minimap is React Flow's geometry: the view box covers every node AND the current view, and a mask dims all but
   *  the view. XYMinimap turns a drag on it into a pan of the real canvas. */
  private drawMinimap() {
    const mm = this.minimap;
    if (!mm) return;
    const r = this.root.getBoundingClientRect();
    const mw = mm.el.clientWidth || 200;
    const mh = mm.el.clientHeight || 140;
    const [tx, ty, z] = this.transform;
    const view = { x: -tx / z, y: -ty / z, w: r.width / z, h: r.height / z };
    let x0 = view.x, y0 = view.y, x1 = view.x + view.w, y1 = view.y + view.h;
    for (const n of this.nodeLookup.values()) {
      const { x, y } = n.internals.positionAbsolute;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + (n.measured?.width ?? 0)); y1 = Math.max(y1, y + (n.measured?.height ?? 0));
    }
    const bw = x1 - x0; const bh = y1 - y0;
    const scale = Math.max(bw / mw, bh / mh);
    const vw = scale * mw; const vh = scale * mh;
    const pad = 5 * scale;
    const vx = x0 - (vw - bw) / 2 - pad; const vy = y0 - (vh - bh) / 2 - pad;
    const w = vw + pad * 2; const h = vh + pad * 2;
    mm.scale = scale;
    mm.svg.setAttribute('viewBox', `${vx} ${vy} ${w} ${h}`);
    const rects: string[] = [];
    for (const n of this.nodeLookup.values()) {
      const { x, y } = n.internals.positionAbsolute;
      rects.push(`<rect class="${this.selNodes.has(n.id) ? 'selected' : ''}" x="${x}" y="${y}" width="${n.measured?.width ?? 0}" `
        + `height="${n.measured?.height ?? 0}" rx="${4 * scale}"/>`);
    }
    mm.nodes.innerHTML = rects.join('');
    mm.mask.setAttribute('d', `M${vx - pad},${vy - pad}h${w + pad * 2}v${h + pad * 2}h${-w - pad * 2}z `
      + `M${view.x},${view.y}h${view.w}v${view.h}h${-view.w}z`);
    mm.xy.update({ translateExtent: this.xy!.infiniteExtent, width: r.width, height: r.height, pannable: true, zoomable: true });
  }

  private applyTransform() {
    const [x, y, z] = this.transform;
    this.viewport.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    // The grid is part of the CANVAS, so it pans and zooms with it — a background that stayed put while the picture
    // moved over it is how a canvas reads as a screenshot.
    const g = this.gridSize() * z;
    this.root.style.backgroundSize = `${g}px ${g}px`;
    this.root.style.backgroundPosition = `${x}px ${y}px`;
    this.drawMinimap();
  }

  /** Canvas units between grid lines: the snap, when the app snaps, so what you see is what a drop lands on. */
  private gridSize(): number { return (this.props.snap ?? 0) > 0 ? this.props.snap! : 20; }

  // ── nodes ──────────────────────────────────────────────────────────────────────────────────────────────────────
  /** One positioned wrapper per node. The xyflow host contract for a node: a `data-id` (the ResizeObserver maps an
   *  entry back to its node by it), `nopan` (the pane's zoom must not start on a node), and a wrapper whose
   *  `offsetWidth/Height` is the node's size. Everything inside `.osy-flow__body` is the app's. */
  private buildNode(id: string, row: Row, type: string): NodeView {
    const wrapper = this.doc.createElement('div');
    wrapper.className = 'osy-flow__node nopan';
    wrapper.dataset.id = id;
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute('aria-roledescription', 'node');
    const body = this.doc.createElement('div');
    body.className = 'osy-flow__body';
    const desc = this.hidden(`${this.flowId}-desc-${id}`, '');
    wrapper.append(body, desc);
    wrapper.setAttribute('aria-describedby', `${desc.id} ${this.helpNode.id}`);
    this.viewport.appendChild(wrapper);
    // Focus picks a node — unless it is part of a larger selection, which a keyboard user built with Space and must be
    // able to Tab across without losing.
    wrapper.addEventListener('focus', () => {
      if (this.selNodes.size + this.selEdges.size > 1) return;
      this.select({ kind: 'node', id });
    });
    // Pointer selection, in CAPTURE so it lands before XYDrag decides what to drag: Shift/Ctrl/Cmd adds or removes;
    // a plain press on a node already in the selection keeps it (so the drag that follows moves them all).
    wrapper.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest?.('.osy-flow__handle')) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) this.select({ kind: 'node', id }, true);
      else if (!this.selNodes.has(id)) this.select({ kind: 'node', id });
      else this.selected = { kind: 'node', id };
    }, true);
    const view: NodeView = { id, row, type, wrapper, body, desc, slot: null, drag: null, ports: '' };
    view.slot = this.renderBody(view);
    if (!this.readOnly && this.xy) {
      view.drag = this.xy.XYDrag({
        getStoreItems: () => this.storeItems(),
        onNodeMouseDown: () => {},
        onDragStart: () => wrapper.classList.add('dragging'),
        onDragStop: () => wrapper.classList.remove('dragging'),
      });
    }
    this.resize?.observe(wrapper);
    // A node that ARRIVES (a new row) eases in; the first paint does not — a whole canvas fading up is noise.
    if (this.painted) this.enter(wrapper);
    return view;
  }

  /** The app's own Osy# for this node — the template the call site wrote for its TYPE (`slot Task { s => … }`), or
   *  the anonymous one when it wrote a single `{ s => … }`. The platform builds it; the shim only says where. */
  private renderBody(view: NodeView) {
    const tmpl = this.host.cells?.[view.type] ?? this.host.slot;
    view.body.replaceChildren();
    if (!tmpl) {
      view.body.textContent = view.type || view.id;
      return null;
    }
    return tmpl.render(view.row, view.body);
  }

  private dragParams(view: NodeView) {
    return { domNode: view.wrapper, nodeId: view.id, noDragClassName: 'nodrag', isSelectable: true, nodeClickDistance: 0 };
  }

  private place(view: NodeView) {
    const n = this.nodeLookup.get(view.id);
    if (!n) return;
    const { x, y } = n.internals.positionAbsolute;
    view.wrapper.style.transform = `translate(${x}px, ${y}px)`;
  }

  private dropView(view: NodeView) {
    view.drag?.destroy();
    view.slot?.destroy();
    this.resize?.unobserve(view.wrapper);
    view.wrapper.remove();
  }

  /** What XYDrag reads on every start/move/end — fresh each time, so it never holds a stale lookup or transform. */
  private storeItems() {
    const snap = this.props.snap ?? 0;
    return {
      nodes: this.userNodes, nodeLookup: this.nodeLookup, edges: [], nodeExtent: this.xy!.infiniteExtent,
      snapGrid: [snap || 1, snap || 1], snapToGrid: snap > 0, nodeOrigin: [0, 0],
      // The selection is kept HERE (see `select`), so xyflow must never clear it on a drag of its own accord: a press
      // on an unselected node has already made it the selection by the time XYDrag starts.
      multiSelectionActive: true,
      domNode: this.root, transform: this.transform, autoPanOnNodeDrag: true, nodesDraggable: !this.readOnly,
      selectNodesOnDrag: false, nodeDragThreshold: 1,
      panBy: (delta: { x: number; y: number }) => this.panBy(delta),
      unselectNodesAndEdges: () => this.select(null),
      updateNodePositions: (items: Map<string, DragItem>, dragging: boolean) => this.moved(items, dragging),
    };
  }

  private panBy(delta: { x: number; y: number }): Promise<boolean> {
    const r = this.root.getBoundingClientRect();
    return this.xy!.panBy({ delta, panZoom: this.panZoom, transform: this.transform,
      translateExtent: this.xy!.infiniteExtent, width: r.width, height: r.height });
  }

  /** XYDrag moved nodes. Written into the lookup and the DOM at once, so the node follows the pointer with no
   *  round trip; on the DROP (`dragging` false) the app hears it once, with the row — never once per frame. */
  private moved(items: Map<string, DragItem>, dragging: boolean) {
    if (!dragging) {
      const first = this.views.get([...items.keys()][0] ?? '');
      if (items.size > 1) this.gesture(`Move ${items.size} nodes`);
      else if (first) this.gesture(`Move ${this.labelOf(first)}`);
    }
    for (const item of items.values()) {
      const n = this.nodeLookup.get(item.id);
      if (!n) continue;
      n.position = { ...item.position };
      n.internals.positionAbsolute = { ...item.internals.positionAbsolute };
      const view = this.views.get(item.id);
      if (view) this.place(view);
      if (!dragging && view) this.emitMoved(view, item.position.x, item.position.y);
    }
    if (!dragging && items.size > 1) this.announce(`Moved ${items.size} nodes.`);
    this.drawEdges();
  }

  /** One editing gesture is about to raise its events: say so first, once, with a sentence naming it — the app marks
   *  its unit of work here, so one Undo takes the whole gesture back (a ten-node drag is one step, not ten). */
  private gesture(label: string) {
    this.host.emit('gesture', label as never);
  }

  private emitMoved(view: NodeView, x: number, y: number) {
    this.host.emit('nodeMoved', view.row as never, Math.round(x), Math.round(y));
  }

  // ── ports (xyflow "handles") ───────────────────────────────────────────────────────────────────────────────────
  private buildPorts(view: NodeView) {
    const type = (this.props.nodeTypes ?? []).find((t) => t.Name === view.type);
    const ports = type?.Ports ?? [];
    const fingerprint = JSON.stringify(ports.map((p) => [p.Id, p.Kind, p.Side])) + (this.readOnly ? ':ro' : '');
    if (fingerprint === view.ports) return;
    view.ports = fingerprint;
    view.wrapper.querySelectorAll(':scope > .osy-flow__handle').forEach((h) => h.remove());
    // Two ports on one side would sit on top of each other; spread them along it.
    const bySide = new Map<string, number>();
    for (const port of ports) bySide.set(port.Side, (bySide.get(port.Side) ?? 0) + 1);
    const placed = new Map<string, number>();
    for (const port of ports) {
      const i = placed.get(port.Side) ?? 0;
      placed.set(port.Side, i + 1);
      view.wrapper.appendChild(this.buildHandle(view, port.Id, port.Kind === 'target' ? 'target' : 'source',
        (['left', 'right', 'top', 'bottom'].includes(port.Side) ? port.Side : 'right') as Side, i, bySide.get(port.Side)!));
    }
  }

  /** The xyflow host contract for a handle, in full: class `osy-flow__handle` (XYHandle's `.${lib}-flow__handle`),
   *  `source`|`target` (measured by `getHandleBounds`, and how XYHandle types the one under the pointer),
   *  `connectable connectableend` (both, or XYHandle refuses to end on it), and `data-nodeid` / `data-handleid` /
   *  `data-handlepos` / `data-id="{flowId}-{node}-{handle}-{type}"`. `nodrag nopan` keep XYDrag and the pane off it. */
  private buildHandle(view: NodeView, portId: string, kind: 'source' | 'target', side: Side, index: number, count: number) {
    const h = this.doc.createElement('div');
    const connectable = this.readOnly ? '' : ' connectable connectablestart connectableend';
    h.className = `${LIB}-flow__handle osy-flow__handle ${kind} nodrag nopan${connectable}`;
    h.dataset.nodeid = view.id;
    h.dataset.handleid = portId;
    h.dataset.handlepos = side;
    h.dataset.id = `${this.flowId}-${view.id}-${portId}-${kind}`;
    if (count > 1) {
      const pct = `${((index + 1) * 100) / (count + 1)}%`;
      if (side === 'left' || side === 'right') h.style.top = pct; else h.style.left = pct;
    }
    if (!this.readOnly) {
      h.tabIndex = 0;
      h.setAttribute('role', 'button');
      h.setAttribute('aria-label', kind === 'source'
        ? `${this.labelOf(view)}: connect from ${portId}` : `${this.labelOf(view)}: connect to ${portId}`);
      h.addEventListener('mousedown', (e) => this.startConnection(e, view.id, portId, kind === 'target', h));
      h.addEventListener('touchstart', (e) => this.startConnection(e, view.id, portId, kind === 'target', h), { passive: false });
      h.addEventListener('keydown', (e) => this.onHandleKey(e, view.id, portId, kind));
    }
    return h;
  }

  private startConnection(e: MouseEvent | TouchEvent, nodeId: string, portId: string, isTarget: boolean, handleEl: HTMLElement) {
    if (e instanceof MouseEvent && e.button !== 0) return;
    e.stopPropagation();
    // The press is a connection gesture, never a text selection: without this, drawing an edge across a node
    // selected the words of every template it crossed.
    e.preventDefault();
    this.xy!.XYHandle.onPointerDown(e, {
      autoPanOnConnect: true, connectionMode: 'strict', connectionRadius: 24, domNode: this.root,
      handleId: portId, nodeId, isTarget, nodeLookup: this.nodeLookup, lib: LIB, flowId: this.flowId,
      panBy: (d: { x: number; y: number }) => this.panBy(d),
      cancelConnection: () => this.connectionPath.setAttribute('d', ''),
      updateConnection: (c: ConnectionState) => this.drawConnection(c),
      onConnect: (c: { source: string; target: string; sourceHandle: string | null; targetHandle: string | null }) =>
        this.emitConnected(c.source, c.target, c.sourceHandle ?? '', c.targetHandle ?? ''),
      getTransform: () => this.transform,
      getFromHandle: () => ({ nodeId, id: portId, type: isTarget ? 'target' : 'source' }),
      handleDomNode: handleEl,
    });
  }

  private emitConnected(source: string, target: string, sourcePort: string, targetPort: string) {
    const s = this.views.get(source);
    const t = this.views.get(target);
    if (!s || !t) return;
    this.gesture(`Connect ${this.labelOf(s)} to ${this.labelOf(t)}`);
    this.host.emit('connected', s.row as never, t.row as never, sourcePort, targetPort);
    this.announce(`Connected ${this.labelOf(s)} ${sourcePort} to ${this.labelOf(t)} ${targetPort}.`);
  }

  // ── edges ──────────────────────────────────────────────────────────────────────────────────────────────────────
  private portOf(nodeId: string, kind: 'source' | 'target', portId: string | null): { node: InternalNode; handle: HandleBound } | null {
    const node = this.nodeLookup.get(nodeId);
    const list = node?.internals.handleBounds?.[kind] ?? [];
    const handle = (portId ? list.find((h) => h.id === portId) : undefined) ?? list[0];
    return node && handle ? { node, handle } : null;
  }

  private drawEdges() {
    if (!this.xy) return;
    const p = this.props;
    const sf = p.sourceField ?? 'Source';
    const tf = p.targetField ?? 'Target';
    const shape = p.edgeShape ?? 'bezier';
    const keep = new Set<Element>([this.connectionPath]);
    const keepLabels = new Set<Element>();
    for (const row of this.edgeRows) {
      const id = rid(row);
      const s = this.portOf(refId(row[sf]) ?? '', 'source', p.sourcePortField ? String(row[p.sourcePortField] ?? '') || null : null);
      const t = this.portOf(refId(row[tf]) ?? '', 'target', p.targetPortField ? String(row[p.targetPortField] ?? '') || null : null);
      if (!s || !t) continue;           // an endpoint not on the canvas (yet) — or not measured yet
      const a = this.xy.getHandlePosition(s.node, s.handle, s.handle.position);
      const b = this.xy.getHandlePosition(t.node, t.handle, t.handle.position);
      const args = { sourceX: a.x, sourceY: a.y, sourcePosition: s.handle.position, targetX: b.x, targetY: b.y, targetPosition: t.handle.position };
      const [d, lx, ly] = shape === 'straight' ? this.xy.getStraightPath(args)
        : shape === 'smoothstep' ? this.xy.getSmoothStepPath(args) : this.xy.getBezierPath(args);
      let g = this.edgeLayer.querySelector<SVGGElement>(`g[data-id="${CSS.escape(id)}"]`);
      const isNew = !g;
      if (!g) g = this.buildEdge(id);
      g.querySelectorAll('path').forEach((path) => path.setAttribute('d', d));
      if (isNew && this.painted) this.drawIn(g);
      g.classList.toggle('selected', this.selected?.kind === 'edge' && this.selected.id === id);
      // A run's PATH: an edge between two places it has been is travelled; the one that brought it to where it is now
      // flows (and in a cycle more than one can — every way in from where it has been).
      const sId = this.endOf(id, 'source'); const tId = this.endOf(id, 'target');
      const been = (n: string) => this.isVisited(n) || this.isCurrent(n);
      g.classList.toggle('travelled', been(sId) && been(tId));
      g.classList.toggle('active', this.isVisited(sId) && this.isCurrent(tId));
      keep.add(g);
      const text = this.edgeLabelOf(row);
      if (text) {
        let label = this.labelLayer.querySelector<HTMLDivElement>(`[data-id="${CSS.escape(id)}"]`);
        if (!label) {
          label = this.doc.createElement('div');
          label.className = 'osy-flow__edge-label';
          label.dataset.id = id;
          this.labelLayer.appendChild(label);
        }
        if (label.textContent !== text) label.textContent = text;
        label.style.transform = `translate(${lx}px, ${ly}px) translate(-50%, -50%)`;
        label.classList.toggle('selected', this.selected?.kind === 'edge' && this.selected.id === id);
        keepLabels.add(label);
      }
    }
    for (const child of [...this.edgeLayer.children]) if (!keep.has(child)) child.remove();
    for (const child of [...this.labelLayer.children]) if (!keepLabels.has(child)) child.remove();
    this.describeEdges();
    this.drawMinimap();
  }

  private buildEdge(id: string): SVGGElement {
    const g = this.doc.createElementNS(SVG, 'g');
    g.setAttribute('class', 'osy-flow__edge nopan');
    g.dataset.id = id;
    // Focusable but NOT in the Tab order: a graph has more edges than nodes, and a Tab walk through every one of them
    // is how a keyboard user gets lost. They are reached from their nodes (E), which is also the question a person
    // is asking — "what is this connected to?" — rather than "what is the fourteenth edge?".
    g.setAttribute('tabindex', '-1');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-roledescription', 'edge');
    g.setAttribute('aria-describedby', this.helpEdge.id);
    const hit = this.doc.createElementNS(SVG, 'path');
    hit.setAttribute('class', 'osy-flow__edge-hit');
    const line = this.doc.createElementNS(SVG, 'path');
    line.setAttribute('class', 'osy-flow__edge-path');
    g.append(hit, line);
    g.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this.select({ kind: 'edge', id }, e.shiftKey || e.metaKey || e.ctrlKey);
      g.focus({ preventScroll: true });
    });
    this.edgeLayer.insertBefore(g, this.connectionPath);
    return g;
  }

  private drawConnection(c: ConnectionState) {
    if (!c.inProgress || !c.from || !c.to || !this.xy) { this.connectionPath.setAttribute('d', ''); return; }
    const [x, y, z] = this.transform;
    // `to` is in PANE pixels (the pointer); the path lives in the viewport's canvas units.
    const to = { x: (c.to.x - x) / z, y: (c.to.y - y) / z };
    const [d] = this.xy.getBezierPath({ sourceX: c.from.x, sourceY: c.from.y, sourcePosition: c.fromPosition ?? 'right',
      targetX: to.x, targetY: to.y, targetPosition: c.toPosition ?? 'left' });
    this.connectionPath.setAttribute('d', d);
  }

  // ── selection + keyboard ───────────────────────────────────────────────────────────────────────────────────────
  /** Change the selection. `additive` toggles `next` in or out of what is already selected (Shift/Ctrl/Cmd, Space);
   *  otherwise `next` becomes the whole selection, and `null` clears it. */
  private select(next: { kind: 'node' | 'edge'; id: string } | null, additive = false) {
    const prior = this.selected;
    if (!additive) { this.selNodes.clear(); this.selEdges.clear(); }
    if (next) {
      const set = next.kind === 'node' ? this.selNodes : this.selEdges;
      if (additive && set.has(next.id)) set.delete(next.id); else set.add(next.id);
    }
    this.selected = next && (next.kind === 'node' ? this.selNodes : this.selEdges).has(next.id) ? next : null;
    this.paintSelection();
    const same = this.selected?.kind === prior?.kind && this.selected?.id === prior?.id;
    if (!same && this.selected?.kind === 'node') {
      const v = this.views.get(this.selected.id);
      if (v) this.host.emit('nodeSelected', v.row as never);
    }
    this.queueSelectionChanged();
  }

  private selectAll() {
    this.selNodes.clear(); this.selEdges.clear();
    for (const id of this.views.keys()) this.selNodes.add(id);
    this.paintSelection();
    this.queueSelectionChanged();
    this.announce(`Selected all ${this.selNodes.size} nodes.`);
  }

  /** The selection as the canvas SHOWS it, and as xyflow must see it: a drag moves every `selected` internal node. */
  private paintSelection() {
    for (const v of this.views.values()) v.wrapper.classList.toggle('selected', this.selNodes.has(v.id));
    for (const n of this.nodeLookup.values()) n.selected = this.selNodes.has(n.id);
    for (const u of this.userNodes) u.selected = this.selNodes.has(u.id);
    for (const g of this.edgeLayer.querySelectorAll<SVGGElement>('g.osy-flow__edge'))
      g.classList.toggle('selected', this.selEdges.has(g.dataset.id!));
    for (const l of this.labelLayer.querySelectorAll<HTMLElement>('.osy-flow__edge-label'))
      l.classList.toggle('selected', this.selEdges.has(l.dataset.id!));
    this.root.classList.toggle('multi', this.selNodes.size + this.selEdges.size > 1);
    this.drawMinimap();
  }

  /** `selectionChanged` once per burst of changes (a box select touches every node it crosses), and only when the SET
   *  changed — re-picking the same node is not news. */
  private queueSelectionChanged() {
    if (this.selectionQueued) return;
    this.selectionQueued = true;
    queueMicrotask(() => {
      this.selectionQueued = false;
      if (this.destroyed) return;
      const key = [...this.selNodes].sort().join(',') + '|' + [...this.selEdges].sort().join(',');
      if (key === this.lastSelectionKey) return;
      this.lastSelectionKey = key;
      const nodes = [...this.selNodes].map((id) => this.views.get(id)?.row).filter((r): r is Row => !!r);
      const edges = this.edgeRows.filter((r) => this.selEdges.has(rid(r)));
      this.host.emit('selectionChanged', nodes as never, edges as never);
    });
  }

  /** The rows a Delete / arrow press acts on: the whole selection when the focused item is IN it, else just that one. */
  private targetsOf(kind: 'node' | 'edge', id: string): { nodes: string[]; edges: string[] } {
    const inSelection = (kind === 'node' ? this.selNodes : this.selEdges).has(id);
    if (inSelection && this.selNodes.size + this.selEdges.size > 1) return { nodes: [...this.selNodes], edges: [...this.selEdges] };
    return kind === 'node' ? { nodes: [id], edges: [] } : { nodes: [], edges: [id] };
  }

  // ── the pane: click to clear, Shift + drag to box-select ────────────────────────────────────────────────────────
  private isPane(t: EventTarget | null): boolean {
    return t === this.root || t === this.viewport || t === this.edgeLayer || t === this.labelLayer;
  }

  private onPaneMouseDown = (e: MouseEvent) => {
    if (!this.isPane(e.target) || e.button !== 0) return;
    if (e.shiftKey) { this.beginBox(e); return; }
    this.select(null);
  };

  private beginBox(e: MouseEvent) {
    e.preventDefault();
    this.panZoom?.update({ ...this.panOptions, userSelectionActive: true });   // d3-zoom's filter: no pan while boxing
    const r = this.root.getBoundingClientRect();
    const el = this.doc.createElement('div');
    el.className = 'osy-flow__selection';
    this.root.appendChild(el);
    this.box = { el, x0: e.clientX - r.left, y0: e.clientY - r.top, additive: true };
    this.doc.addEventListener('mousemove', this.onBoxMove);
    this.doc.addEventListener('mouseup', this.onBoxUp);
    this.onBoxMove(e);
  }

  private boxRect(e: MouseEvent) {
    const r = this.root.getBoundingClientRect();
    const x1 = e.clientX - r.left;
    const y1 = e.clientY - r.top;
    const b = this.box!;
    return { x: Math.min(b.x0, x1), y: Math.min(b.y0, y1), w: Math.abs(x1 - b.x0), h: Math.abs(y1 - b.y0) };
  }

  private onBoxMove = (e: MouseEvent) => {
    if (!this.box) return;
    const { x, y, w, h } = this.boxRect(e);
    Object.assign(this.box.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  };

  private onBoxUp = (e: MouseEvent) => {
    if (!this.box) return;
    const { x, y, w, h } = this.boxRect(e);
    this.endBox();
    if (w < 3 && h < 3) return;
    // Pane pixels → canvas units, then every node wholly inside the box; and the edges BETWEEN two of them, which is
    // what a person dragging a box around part of a diagram means by "these".
    const [tx, ty, z] = this.transform;
    const cx0 = (x - tx) / z; const cy0 = (y - ty) / z; const cx1 = (x + w - tx) / z; const cy1 = (y + h - ty) / z;
    let added = 0;
    for (const n of this.nodeLookup.values()) {
      const { x: nx, y: ny } = n.internals.positionAbsolute;
      const nw = n.measured?.width ?? 0; const nh = n.measured?.height ?? 0;
      if (nx >= cx0 && ny >= cy0 && nx + nw <= cx1 && ny + nh <= cy1 && !this.selNodes.has(n.id)) { this.selNodes.add(n.id); added++; }
    }
    for (const r of this.edgeRows) {
      const id = rid(r);
      if (this.selNodes.has(this.endOf(id, 'source')) && this.selNodes.has(this.endOf(id, 'target'))) this.selEdges.add(id);
    }
    if (!this.selected && this.selNodes.size) this.selected = { kind: 'node', id: [...this.selNodes][0] };
    this.paintSelection();
    this.queueSelectionChanged();
    this.announce(`Selected ${this.selNodes.size} ${this.selNodes.size === 1 ? 'node' : 'nodes'}` + (added ? '.' : ', none new.'));
  };

  private endBox() {
    if (!this.box) return;
    this.box.el.remove();
    this.box = null;
    this.doc.removeEventListener('mousemove', this.onBoxMove);
    this.doc.removeEventListener('mouseup', this.onBoxUp);
    this.panZoom?.update({ ...this.panOptions, userSelectionActive: false });
  }

  /** Keys on the canvas as a whole — handled ONLY when the node, edge or pane itself has focus, never when the key
   *  lands inside a node's own content: an `Input` in a node template must get its arrow keys and its Backspace. */
  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as Element;
    const nodeEl = target.closest?.('.osy-flow__node') as HTMLElement | null;
    const onNode = nodeEl !== null && nodeEl === target;
    const onEdge = target.classList?.contains('osy-flow__edge');
    const onPane = target === this.root;
    if (!onNode && !onEdge && !onPane) return;

    const edgeId = onEdge ? (target as SVGGElement).dataset.id ?? null : null;
    const nodeId = onNode ? nodeEl!.dataset.id ?? null : null;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (e.key === '?') { this.announce(this.readOnly ? HELP_READONLY : HELP_CANVAS); e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (this.pendingFrom) { this.cancelPending(); this.announce('Connection cancelled.'); e.preventDefault(); return; }
      if (this.selNodes.size + this.selEdges.size > 1) {
        this.select(onNode ? { kind: 'node', id: nodeId! } : onEdge ? { kind: 'edge', id: edgeId! } : null);
        this.announce('Selection cleared.');
        e.preventDefault();
        return;
      }
      // Escape backs OUT one level: from an edge to the node it was reached from, from a node to the canvas.
      if (onEdge) { this.focusNode(this.edgeOrigin ?? this.endOf(edgeId!, 'source')); e.preventDefault(); return; }
      if (onNode) { this.root.focus({ preventScroll: true }); e.preventDefault(); return; }
      return;
    }
    if ((e.key === '+' || e.key === '=') && this.panZoom) { this.zoomBy(1.2); e.preventDefault(); return; }
    if (e.key === '-' && this.panZoom) { this.zoomBy(1 / 1.2); e.preventDefault(); return; }
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) { void this.fit(true); e.preventDefault(); return; }
    if (key === 'l' && e.shiftKey && !this.readOnly && !e.ctrlKey && !e.metaKey && !e.altKey) { void this.runLayout('asked'); e.preventDefault(); return; }
    if (key === 'a' && (e.ctrlKey || e.metaKey)) { this.selectAll(); e.preventDefault(); return; }
    if (onNode && e.key === ' ') {
      e.preventDefault();
      this.select({ kind: 'node', id: nodeId! }, true);
      const v = this.views.get(nodeId!);
      const n = this.selNodes.size + this.selEdges.size;
      this.announce(`${v ? this.labelOf(v) : 'Node'} ${this.selNodes.has(nodeId!) ? 'added to' : 'taken out of'} the selection; ${n} selected.`);
      return;
    }

    // ── getting AROUND — the same in a picture and an editor ─────────────────────────────────────────────────────
    if (key === 'e' && !e.altKey && !e.ctrlKey && !e.metaKey && (onNode || onEdge)) {
      e.preventDefault();
      const origin = onNode ? nodeId! : (this.edgeOrigin ?? this.endOf(edgeId!, 'source'));
      this.focusEdgeOf(origin, onEdge ? edgeId : null, e.shiftKey ? -1 : 1);
      return;
    }
    if (onEdge && (key === 's' || key === 't') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.focusNode(this.endOf(edgeId!, key === 's' ? 'source' : 'target'));
      return;
    }
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (onNode && e.altKey && dirs[e.key]) {
      e.preventDefault();
      const next = this.neighbour(nodeId!, dirs[e.key]);
      if (next) this.focusNode(next); else this.announce('No node that way.');
      return;
    }
    if (this.readOnly) return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && (onNode || onEdge)) {
      e.preventDefault();
      const t = this.targetsOf(onNode ? 'node' : 'edge', (onNode ? nodeId : edgeId)!);
      if (t.nodes.length + t.edges.length > 1) {
        // The whole selection: edges first, then nodes — so an app whose node delete cascades its edges never sees an
        // edge event for a row that is already gone.
        const order = [...this.views.keys()];
        const next = order.find((id) => !t.nodes.includes(id)) ?? null;
        this.gesture(`Remove ${t.nodes.length ? `${t.nodes.length} ${t.nodes.length === 1 ? 'node' : 'nodes'}` : ''}`
          + `${t.nodes.length && t.edges.length ? ' and ' : ''}${t.edges.length ? `${t.edges.length} ${t.edges.length === 1 ? 'edge' : 'edges'}` : ''}`);
        for (const r of this.edgeRows.filter((r) => t.edges.includes(rid(r)))) this.host.emit('edgeRemoved', r as never);
        for (const id of t.nodes) { const v = this.views.get(id); if (v) this.host.emit('nodeRemoved', v.row as never); }
        this.announce(`Removed ${t.nodes.length} ${t.nodes.length === 1 ? 'node' : 'nodes'}`
          + (t.edges.length ? ` and ${t.edges.length} ${t.edges.length === 1 ? 'edge' : 'edges'}.` : '.'));
        this.select(null);
        if (next) this.focusNode(next); else this.root.focus({ preventScroll: true });
        return;
      }
      if (onNode) {
        const v = this.views.get(nodeId!);
        if (v) {
          // Focus goes to the NEXT node (or the canvas) before the row leaves, so the keyboard user is never left on
          // an element that is about to be removed — which drops focus to the page body, miles from where they were.
          const order = [...this.views.keys()];
          const next = order[order.indexOf(nodeId!) + 1] ?? order[order.indexOf(nodeId!) - 1] ?? null;
          this.gesture(`Remove ${this.labelOf(v)}`);
          this.host.emit('nodeRemoved', v.row as never);
          this.announce(`Removed ${this.labelOf(v)}.`);
          if (next) this.focusNode(next); else this.root.focus({ preventScroll: true });
        }
      } else {
        const row = this.edgeRows.find((r) => rid(r) === edgeId);
        if (row) {
          const back = this.edgeOrigin ?? this.endOf(edgeId!, 'source');
          const name = this.edgeName(row);
          this.gesture(`Remove the edge ${name}`);
          this.host.emit('edgeRemoved', row as never);
          this.announce(`Removed the edge ${name}.`);
          this.focusNode(back);
        }
      }
      return;
    }
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (onNode && delta[e.key]) {
      e.preventDefault();
      const focused = this.views.get(nodeEl!.dataset.id!);
      if (!focused) return;
      // With a snap grid a press is one grid step (Shift: five), and a node off the grid lands ON it first.
      const snap = this.props.snap ?? 0;
      const step = (snap > 0 ? snap : KEY_STEP) * (e.shiftKey ? 5 : 1);
      const ids = this.targetsOf('node', focused.id).nodes;
      this.gesture(ids.length > 1 ? `Move ${ids.length} nodes` : `Move ${this.labelOf(focused)}`);
      let last = { x: 0, y: 0 };
      for (const id of ids) {
        const view = this.views.get(id);
        const n = view && this.nodeLookup.get(id);
        if (!view || !n) continue;
        let x = n.position.x + delta[e.key][0] * step;
        let y = n.position.y + delta[e.key][1] * step;
        if (snap > 0) { x = Math.round(x / snap) * snap; y = Math.round(y / snap) * snap; }
        n.position = { x, y };
        n.internals.positionAbsolute = { x, y };
        this.place(view);
        this.emitMoved(view, x, y);
        if (view === focused) last = { x, y };
      }
      this.drawEdges();
      this.ensureVisible(focused.wrapper);
      // Announced once the keys stop, not per press: twelve presses are one move to a listener, not twelve.
      if (this.moveAnnounce) clearTimeout(this.moveAnnounce);
      this.moveAnnounce = setTimeout(() => this.announce(ids.length > 1
        ? `Moved ${ids.length} nodes.`
        : `${this.labelOf(focused)} moved to ${Math.round(last.x)}, ${Math.round(last.y)}.`), 450);
    }
  };

  /** Drawing an edge WITHOUT a pointer: Enter/Space on a source port arms it; Enter/Space on a target port of
   *  another node completes it. The same `connected` event a drag raises, so the app has one path, not two. */
  private onHandleKey(e: KeyboardEvent, nodeId: string, portId: string, kind: 'source' | 'target') {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'source') {
      this.cancelPending();
      this.pendingFrom = { nodeId, port: portId };
      (e.currentTarget as HTMLElement).classList.add('pending');
      this.announce(`Connecting from ${this.labelOf(this.views.get(nodeId)!)} ${portId}. Tab to another node's port and press Enter; Escape cancels.`);
      return;
    }
    if (this.pendingFrom && this.pendingFrom.nodeId !== nodeId) {
      const from = this.pendingFrom;
      this.cancelPending();
      this.emitConnected(from.nodeId, nodeId, from.port, portId);
    }
  }

  private cancelPending() {
    this.pendingFrom = null;
    this.root.querySelectorAll('.osy-flow__handle.pending').forEach((h) => h.classList.remove('pending'));
  }

  /** Say something to a screen reader. Cleared first, so saying the same words twice is heard twice. */
  private announce(text: string) {
    this.status.textContent = '';
    setTimeout(() => { if (!this.destroyed) this.status.textContent = text; }, 30);
  }

  private hidden(id: string, text: string): HTMLSpanElement {
    const s = this.doc.createElement('span');
    s.id = id;
    s.className = 'osy-flow__sr';
    s.textContent = text;
    return s;
  }

  // ── accessible names ─────────────────────────────────────────────────────────────────────────────────────────
  /** A node's NAME: the `labelField` when the app named one, else the words its template rendered. */
  private labelOf(view: NodeView): string {
    const f = this.props.labelField;
    const v = f ? view.row[f] : undefined;
    const named = v != null ? String(v).trim() : '';
    const text = named || (view.body.textContent ?? '').replace(/\s+/g, ' ').trim();
    return (text || view.type || view.id).slice(0, 120);
  }

  private edgeLabelOf(row: Row): string {
    const f = this.props.edgeLabelField;
    const v = f ? row[f] : undefined;
    return v != null ? String(v).trim() : '';
  }

  private endOf(edgeId: string, end: 'source' | 'target'): string {
    const row = this.edgeRows.find((r) => rid(r) === edgeId);
    const f = end === 'source' ? (this.props.sourceField ?? 'Source') : (this.props.targetField ?? 'Target');
    return row ? refId(row[f]) ?? '' : '';
  }

  /** "from Receive request to Approve?" — what an edge IS, to someone who cannot see the line. */
  private edgeName(row: Row): string {
    const id = rid(row);
    const s = this.views.get(this.endOf(id, 'source'));
    const t = this.views.get(this.endOf(id, 'target'));
    const label = this.edgeLabelOf(row);
    return `from ${s ? this.labelOf(s) : 'a node not shown'} to ${t ? this.labelOf(t) : 'a node not shown'}`
      + (label ? `, ${label}` : '');
  }

  private describeAll() {
    for (const v of this.views.values()) {
      const name = this.labelOf(v);
      if (v.wrapper.getAttribute('aria-label') !== name) v.wrapper.setAttribute('aria-label', name);
      let out = 0; let into = 0;
      for (const r of this.edgeRows) {
        if (this.endOf(rid(r), 'source') === v.id) out++;
        if (this.endOf(rid(r), 'target') === v.id) into++;
      }
      const d = (this.isCurrent(v.id) ? 'Current. ' : this.isVisited(v.id) ? 'Visited. ' : '')
        + `${v.type ? v.type + '. ' : ''}${out} ${out === 1 ? 'edge' : 'edges'} out, ${into} in.`
        + (this.selNodes.has(v.id) ? ' Selected.' : '');
      if (v.desc.textContent !== d) v.desc.textContent = d;
      v.wrapper.querySelectorAll<HTMLElement>(':scope > .osy-flow__handle[role="button"]').forEach((h) => {
        const kind = h.classList.contains('source') ? 'from' : 'to';
        const label = `${name}: connect ${kind} ${h.dataset.handleid}`;
        if (h.getAttribute('aria-label') !== label) h.setAttribute('aria-label', label);
      });
    }
    this.describeEdges();
  }

  private describeEdges() {
    for (const g of this.edgeLayer.querySelectorAll<SVGGElement>('g.osy-flow__edge')) {
      const row = this.edgeRows.find((r) => rid(r) === g.dataset.id);
      if (!row) continue;
      const label = `Edge ${this.edgeName(row)}`;
      if (g.getAttribute('aria-label') !== label) g.setAttribute('aria-label', label);
    }
  }

  // ── focus ───────────────────────────────────────────────────────────────────────────────────────────────────
  /** Focus stays inside the canvas's own geometry: the pane is `overflow: hidden`, and a browser SCROLLS such a box
   *  to show a focused child — which slides the whole picture out from under the transform the canvas believes in.
   *  So every focus is `preventScroll`, any scroll that happens anyway is undone, and the node is brought into view
   *  by PANNING instead. */
  private onFocusIn = (e: FocusEvent) => {
    if (this.root.scrollTop || this.root.scrollLeft) { this.root.scrollTop = 0; this.root.scrollLeft = 0; }
    const t = e.target as Element;
    const nodeEl = t.closest?.('.osy-flow__node') as HTMLElement | null;
    if (nodeEl) this.ensureVisible(nodeEl);
    const edgeEl = t.closest?.('.osy-flow__edge') as SVGGElement | null;
    if (edgeEl && !(this.selEdges.has(edgeEl.dataset.id!) && this.selNodes.size + this.selEdges.size > 1))
      this.select({ kind: 'edge', id: edgeEl.dataset.id! });
  };

  private focusNode(id: string | null) {
    const v = id ? this.views.get(id) : undefined;
    if (!v) return;
    v.wrapper.focus({ preventScroll: true });
    this.ensureVisible(v.wrapper);
  }

  private focusEdge(id: string) {
    const g = this.edgeLayer.querySelector<SVGGElement>(`g[data-id="${CSS.escape(id)}"]`);
    if (!g) return;
    g.focus({ preventScroll: true });
    const row = this.edgeRows.find((r) => rid(r) === id);
    // Some screen readers do not re-read a focused SVG group's name reliably, so the move is also SAID.
    if (row) this.announce(`Edge ${this.edgeName(row)}.`);
  }

  /** E on a node: its edges, outgoing first then incoming, in a stable order; E again walks on, Shift+E walks back. */
  private focusEdgeOf(nodeId: string, current: string | null, step: 1 | -1) {
    const mine = this.edgeRows.filter((r) => this.endOf(rid(r), 'source') === nodeId)
      .concat(this.edgeRows.filter((r) => this.endOf(rid(r), 'target') === nodeId
        && this.endOf(rid(r), 'source') !== nodeId))
      .map((r) => rid(r))
      .filter((id) => this.edgeLayer.querySelector(`g[data-id="${CSS.escape(id)}"]`));
    if (mine.length === 0) {
      const v = this.views.get(nodeId);
      this.announce(`${v ? this.labelOf(v) : 'This node'} has no edges.`);
      return;
    }
    const at = current ? mine.indexOf(current) : -1;
    const next = mine[((at < 0 ? (step === 1 ? -1 : 0) : at) + step + mine.length) % mine.length];
    this.edgeOrigin = nodeId;
    this.focusEdge(next);
  }

  /** The nearest node in a direction — measured centre to centre, and a node well off to the side counts as further
   *  than one straight ahead, which is what "the node to the right" means to a person looking at the picture. */
  private neighbour(fromId: string, [dx, dy]: [number, number]): string | null {
    const centre = (id: string) => {
      const n = this.nodeLookup.get(id);
      if (!n) return null;
      const { x, y } = n.internals.positionAbsolute;
      return { x: x + (n.measured?.width ?? 0) / 2, y: y + (n.measured?.height ?? 0) / 2 };
    };
    const a = centre(fromId);
    if (!a) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const id of this.views.keys()) {
      if (id === fromId) continue;
      const b = centre(id);
      if (!b) continue;
      const along = (b.x - a.x) * dx + (b.y - a.y) * dy;
      if (along <= 0) continue;
      const across = Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx);
      if (across > along * 2) continue;              // more than ~63° off the direction is not "that way"
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  /** Pan (never scroll) so a node the keyboard reached is on screen, with a margin. */
  private ensureVisible(el: Element) {
    if (!this.panZoom || !this.xy) return;
    const r = el.getBoundingClientRect();
    const p = this.root.getBoundingClientRect();
    const m = 24;
    let x = 0; let y = 0;
    if (r.left < p.left + m) x = p.left + m - r.left;
    else if (r.right > p.right - m) x = p.right - m - r.right;
    if (r.top < p.top + m) y = p.top + m - r.top;
    else if (r.bottom > p.bottom - m) y = p.bottom - m - r.bottom;
    if (x || y) void this.panBy({ x, y });
  }
}

export function mount(el: HTMLElement, props: Props, host: Host): FlowCanvasHandle {
  const canvas = new FlowCanvas(el, props, host);
  return {
    update: (next) => canvas.update(next),
    destroy: () => canvas.destroy(),
    probe: () => canvas.probe(),
    ready: canvas.ready,
    commands: {
      layout: () => canvas.layoutCommand(),
      fitView: () => canvas.fitViewCommand(),
    },
  };
}
