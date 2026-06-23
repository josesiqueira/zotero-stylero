/**
 * renderer.ts - Canvas2D renderer for the Graph View.
 *
 * Draws, in order: edges, nodes, labels, using a theme palette and a pan/zoom
 * view transform. Also exposes hitTest() to map screen pixels back to a node
 * for click / hover / drag. Contains no simulation logic; positions come from
 * the ForceSim via the GraphModel.
 *
 * Clean-room original implementation.
 */

import type { GraphModel, GraphNode } from "./graphData";

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

interface Palette {
  bg: string;
  edge: string;
  edgeDim: string;
  label: string;
  labelDim: string;
  selectionRing: string;
  hoverGlow: string;
  /** Per-itemType fill colors; falls back to `defaultNode`. */
  typeColors: Record<string, string>;
  defaultNode: string;
  nodeDim: string;
}

const LIGHT: Palette = {
  bg: "#fafafa",
  edge: "rgba(80,80,90,0.35)",
  edgeDim: "rgba(80,80,90,0.08)",
  label: "#2b2b2b",
  labelDim: "rgba(43,43,43,0.25)",
  selectionRing: "#1a73e8",
  hoverGlow: "rgba(26,115,232,0.35)",
  typeColors: {
    journalArticle: "#4e79a7",
    book: "#59a14f",
    bookSection: "#8cd17d",
    conferencePaper: "#f28e2b",
    thesis: "#b07aa1",
    report: "#e15759",
    webpage: "#76b7b2",
    note: "#bab0ac",
    author: "#9c755f",
    tag: "#edc948",
  },
  defaultNode: "#79706e",
  nodeDim: "rgba(121,112,110,0.25)",
};

const DARK: Palette = {
  bg: "#1d1e22",
  edge: "rgba(200,205,215,0.30)",
  edgeDim: "rgba(200,205,215,0.07)",
  label: "#e6e6e6",
  labelDim: "rgba(230,230,230,0.25)",
  selectionRing: "#8ab4f8",
  hoverGlow: "rgba(138,180,248,0.40)",
  typeColors: {
    journalArticle: "#6f9bd1",
    book: "#7fc578",
    bookSection: "#a7e09a",
    conferencePaper: "#f6a85a",
    thesis: "#c79bbf",
    report: "#ee8485",
    webpage: "#93cfca",
    note: "#cfc6c2",
    author: "#c0987f",
    tag: "#f3d96b",
  },
  defaultNode: "#a89f9c",
  nodeDim: "rgba(168,159,156,0.25)",
};

/** Minimum scale at which labels are drawn (avoids clutter when zoomed out). */
const LABEL_SCALE_THRESHOLD = 0.7;
const BASE_RADIUS = 4;
const RADIUS_K = 2.2;

export class GraphRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private palette: Palette;
  private showLabels = true;
  /** CSS pixel dimensions (canvas backing store may be larger for HiDPI). */
  private cssW = 0;
  private cssH = 0;

  constructor(canvas: HTMLCanvasElement, theme: "light" | "dark") {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error("GraphRenderer: 2D context unavailable");
    this.ctx = ctx;
    this.palette = theme === "dark" ? DARK : LIGHT;
  }

  setTheme(theme: "light" | "dark"): void {
    this.palette = theme === "dark" ? DARK : LIGHT;
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show;
  }

  /**
   * Resize the canvas backing store to match its CSS box, scaled by dpr so
   * lines stay crisp on HiDPI displays. Call on mount and ResizeObserver.
   */
  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Reset transform then scale so all drawing uses CSS pixel coordinates.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get width(): number {
    return this.cssW;
  }

  get height(): number {
    return this.cssH;
  }

  private nodeRadius(n: GraphNode): number {
    return BASE_RADIUS + RADIUS_K * Math.sqrt(Math.max(0, n.degree));
  }

  private nodeColor(n: GraphNode): string {
    if (n.color) return n.color;
    return this.palette.typeColors[n.itemType] || this.palette.defaultNode;
  }

  /**
   * Draw the whole graph. `sel` is the set of selected node ids (highlighted +
   * everything else dimmed); `hover` is the currently hovered node id or null.
   */
  draw(
    model: GraphModel,
    view: ViewTransform,
    sel: Set<number>,
    hover: number | null,
  ): void {
    const ctx = this.ctx;
    const p = this.palette;
    const hasSel = sel.size > 0;

    ctx.save();
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // Apply the view (pan/zoom) transform on top of the dpr transform.
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);

    // --- Edges ---
    for (const e of model.edges) {
      const s = this.nodeById(model, e.source);
      const t = this.nodeById(model, e.target);
      if (!s || !t) continue;
      const incident =
        !hasSel || sel.has(e.source) || sel.has(e.target);
      ctx.strokeStyle = incident ? p.edge : p.edgeDim;
      ctx.lineWidth =
        (incident ? 1 : 0.5) * (0.6 + Math.min(3, Math.log2(1 + e.weight))) /
        view.scale;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }

    // --- Nodes ---
    for (const n of model.nodes) {
      const r = this.nodeRadius(n);
      const isSel = sel.has(n.id);
      const isHover = hover === n.id;
      const dim = hasSel && !isSel;

      if (isHover) {
        ctx.beginPath();
        ctx.fillStyle = p.hoverGlow;
        ctx.arc(n.x, n.y, r + 5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.fillStyle = dim ? p.nodeDim : this.nodeColor(n);
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (isSel) {
        ctx.beginPath();
        ctx.strokeStyle = p.selectionRing;
        ctx.lineWidth = 2 / view.scale;
        ctx.arc(n.x, n.y, r + 2.5 / view.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- Labels ---
    if (this.showLabels && view.scale >= LABEL_SCALE_THRESHOLD) {
      const fontPx = 11 / view.scale;
      ctx.font = `${fontPx}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of model.nodes) {
        const dim = hasSel && !sel.has(n.id);
        // When a selection exists, only label selected/hovered nodes to reduce
        // clutter; otherwise label everything.
        if (hasSel && dim && hover !== n.id) continue;
        const r = this.nodeRadius(n);
        ctx.fillStyle = dim ? p.labelDim : p.label;
        const text = truncate(n.label, 28);
        ctx.fillText(text, n.x, n.y + r + 2 / view.scale);
      }
    }

    ctx.restore();
  }

  /**
   * Map screen-space pixel coordinates (relative to the canvas CSS box) to the
   * nearest node whose disc contains the point, or null. Uses the inverse of
   * the view transform.
   */
  hitTest(
    px: number,
    py: number,
    model: GraphModel,
    view: ViewTransform,
  ): GraphNode | null {
    const wx = (px - view.tx) / view.scale;
    const wy = (py - view.ty) / view.scale;
    let best: GraphNode | null = null;
    let bestD2 = Infinity;
    for (const n of model.nodes) {
      const r = this.nodeRadius(n) + 3 / view.scale;
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2;
        best = n;
      }
    }
    return best;
  }

  /** Convert a screen point to world (graph) coordinates. */
  screenToWorld(
    px: number,
    py: number,
    view: ViewTransform,
  ): { x: number; y: number } {
    return {
      x: (px - view.tx) / view.scale,
      y: (py - view.ty) / view.scale,
    };
  }

  private nodeById(model: GraphModel, id: number): GraphNode | undefined {
    // Linear scan kept simple; model.nodes is bounded by the node cap.
    // Cache a map lazily on the model for repeated lookups within a frame.
    const cache = (model as any).__byId as Map<number, GraphNode> | undefined;
    if (cache) return cache.get(id);
    const m = new Map<number, GraphNode>();
    for (const n of model.nodes) m.set(n.id, n);
    (model as any).__byId = m;
    return m.get(id);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
