/**
 * graphData.ts - Pure data layer for the Graph View feature.
 *
 * Builds a normalized {nodes, edges} GraphModel from an array of Zotero items
 * for one of the three real graph modes (related / author / tag). It performs
 * weighting, de-duplication, degree computation and node-cap truncation.
 *
 * This module deliberately contains NO rendering and NO simulation logic. It
 * only touches Zotero item APIs to read relations, creators and tags, then
 * returns plain serialisable objects.
 *
 * Clean-room original implementation: behaviour mirrors a generic knowledge
 * graph builder, no code is copied from any other plugin.
 */

export interface GraphNode {
  id: number;
  key: string;
  label: string;
  itemType: string;
  /** Optional explicit fill color (used for tag / author derived nodes). */
  color?: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

export interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  /** Total candidate node count before the cap was applied. */
  total: number;
  mode: GraphMode;
}

export type GraphMode = "default" | "related" | "author" | "tag";

/** Maximum number of tag edges emitted per item to bound combinatorics. */
const MAX_TAGS_PER_ITEM = 12;

/**
 * Build a deterministic HSL-ish hex color from an arbitrary string key.
 * Used as a fallback fill for tag / author nodes lacking an explicit color.
 */
export function hashColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map the hash to a hue, keep saturation/lightness in a pleasant range.
  const hue = Math.abs(h) % 360;
  const sat = 55 + (Math.abs(h >> 8) % 25); // 55..79
  const light = 50 + (Math.abs(h >> 16) % 12); // 50..61
  return hslToHex(hue, sat, light);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const to2 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function makeNode(
  id: number,
  key: string,
  label: string,
  itemType: string,
  color?: string,
): GraphNode {
  return {
    id,
    key,
    label,
    itemType,
    color,
    degree: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  };
}

/**
 * Normalize a creator into a merge key: lowercase lastName + first initial.
 * This is an intentionally conservative heuristic to merge "John Smith" and
 * "J. Smith". Single-field (institutional) creators use the whole name.
 */
function creatorKey(creator: {
  lastName?: string;
  firstName?: string;
  name?: string;
  fieldMode?: number;
}): { key: string; label: string } | null {
  // fieldMode === 1 means a single-field (institutional) name.
  if (creator.fieldMode === 1 || (!creator.lastName && creator.name)) {
    const single = (creator.name || creator.lastName || "").trim();
    if (!single) return null;
    return { key: `n:${single.toLowerCase()}`, label: single };
  }
  const last = (creator.lastName || "").trim();
  const first = (creator.firstName || "").trim();
  if (!last && !first) return null;
  const initial = first ? first[0]!.toLowerCase() : "";
  const key = `${last.toLowerCase()}|${initial}`;
  const label = first ? `${last}, ${first[0]!.toUpperCase()}.` : last;
  return { key, label };
}

/**
 * Add an undirected edge between two node ids, merging duplicates by summing
 * weight. Self-loops are ignored.
 */
function addEdge(
  map: Map<string, GraphEdge>,
  a: number,
  b: number,
  weight: number,
): void {
  if (a === b) return;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const k = `${lo}-${hi}`;
  const existing = map.get(k);
  if (existing) {
    existing.weight += weight;
  } else {
    map.set(k, { source: lo, target: hi, weight });
  }
}

/**
 * Compute degrees in-place from the edge list, then cap to `cap` nodes keeping
 * the highest-degree nodes and dropping edges referencing removed nodes.
 */
function finalize(
  nodes: GraphNode[],
  edgeMap: Map<string, GraphEdge>,
  cap: number,
  mode: GraphMode,
): GraphModel {
  let edges = Array.from(edgeMap.values());

  // Degree = number of incident edges (weighted by 1 each, not edge weight).
  const degById = new Map<number, number>();
  for (const e of edges) {
    degById.set(e.source, (degById.get(e.source) || 0) + 1);
    degById.set(e.target, (degById.get(e.target) || 0) + 1);
  }
  for (const n of nodes) {
    n.degree = degById.get(n.id) || 0;
  }

  const total = nodes.length;
  let truncated = false;
  if (cap > 0 && nodes.length > cap) {
    truncated = true;
    // Keep highest-degree nodes; stable tie-break by id for determinism.
    const sorted = [...nodes].sort(
      (a, b) => b.degree - a.degree || a.id - b.id,
    );
    const kept = new Set(sorted.slice(0, cap).map((n) => n.id));
    nodes = nodes.filter((n) => kept.has(n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
    // Recompute degree after pruning so node radius reflects visible graph.
    const deg2 = new Map<number, number>();
    for (const e of edges) {
      deg2.set(e.source, (deg2.get(e.source) || 0) + 1);
      deg2.set(e.target, (deg2.get(e.target) || 0) + 1);
    }
    for (const n of nodes) n.degree = deg2.get(n.id) || 0;
  }

  return { nodes, edges, truncated, total, mode };
}

export class GraphData {
  /**
   * Build a GraphModel from the supplied items for the given mode.
   *
   * - "related": one node per regular item, an edge for each Zotero
   *   related-item link between two items in the set.
   * - "author": one node per item plus one node per normalized creator;
   *   edges connect items to their authors (a bipartite-ish graph that
   *   naturally clusters co-authored work).
   * - "tag": one node per item plus one node per distinct tag; edges
   *   connect items to their tags (clusters items sharing tags). Tag node
   *   color reuses the Zotero colored-tag color when available.
   *
   * @param items Zotero regular items to graph.
   * @param mode  Graph mode.
   * @param cap   Maximum node count (0 = unbounded).
   */
  static async build(
    items: Zotero.Item[],
    mode: GraphMode,
    cap: number,
  ): Promise<GraphModel> {
    if (mode === "default") {
      return { nodes: [], edges: [], truncated: false, total: 0, mode };
    }

    // Restrict to regular (top-level) items; skip notes/attachments/feed items.
    const regular = items.filter(
      (it) =>
        it &&
        typeof it.isRegularItem === "function" &&
        it.isRegularItem() &&
        !(it as any).isFeedItem?.(),
    );

    if (mode === "related") {
      return GraphData.buildRelated(regular, cap);
    }
    if (mode === "author") {
      return GraphData.buildAuthor(regular, cap);
    }
    return GraphData.buildTag(regular, cap);
  }

  private static buildRelated(
    items: Zotero.Item[],
    cap: number,
  ): GraphModel {
    const nodes: GraphNode[] = [];
    const idSet = new Set<number>();
    // key (zotero item key) -> node id, for resolving related links.
    const keyToId = new Map<string, number>();

    for (const it of items) {
      const node = makeNode(
        it.id,
        it.key,
        safeTitle(it),
        it.itemType || "document",
      );
      nodes.push(node);
      idSet.add(it.id);
      keyToId.set(it.key, it.id);
    }

    const edgeMap = new Map<string, GraphEdge>();
    for (const it of items) {
      let relatedKeys: string[] = [];
      try {
        // relatedItems returns an array of item keys in the same library.
        const rel = (it as any).relatedItems;
        if (Array.isArray(rel)) relatedKeys = rel;
      } catch {
        relatedKeys = [];
      }
      for (const rk of relatedKeys) {
        const targetId = keyToId.get(rk);
        if (targetId !== undefined && idSet.has(targetId)) {
          addEdge(edgeMap, it.id, targetId, 1);
        }
      }
    }

    return finalize(nodes, edgeMap, cap, "related");
  }

  private static buildAuthor(
    items: Zotero.Item[],
    cap: number,
  ): GraphModel {
    const nodes: GraphNode[] = [];
    const edgeMap = new Map<string, GraphEdge>();

    // Synthetic ids for author nodes must not collide with real item ids.
    // Real item ids are positive integers; author ids are negative.
    let nextAuthorId = -1;
    const authorIdByKey = new Map<string, number>();

    for (const it of items) {
      nodes.push(
        makeNode(it.id, it.key, safeTitle(it), it.itemType || "document"),
      );

      let creators: any[] = [];
      try {
        creators = it.getCreators() || [];
      } catch {
        creators = [];
      }
      const seenThisItem = new Set<string>();
      for (const c of creators) {
        const ck = creatorKey(c);
        if (!ck) continue;
        if (seenThisItem.has(ck.key)) continue;
        seenThisItem.add(ck.key);
        let aId = authorIdByKey.get(ck.key);
        if (aId === undefined) {
          aId = nextAuthorId--;
          authorIdByKey.set(ck.key, aId);
          nodes.push(
            makeNode(aId, `author:${ck.key}`, ck.label, "author", hashColor(ck.key)),
          );
        }
        addEdge(edgeMap, it.id, aId, 1);
      }
    }

    return finalize(nodes, edgeMap, cap, "author");
  }

  private static buildTag(items: Zotero.Item[], cap: number): GraphModel {
    const nodes: GraphNode[] = [];
    const edgeMap = new Map<string, GraphEdge>();

    let nextTagId = -1;
    const tagIdByName = new Map<string, number>();

    for (const it of items) {
      nodes.push(
        makeNode(it.id, it.key, safeTitle(it), it.itemType || "document"),
      );

      // Resolve colored-tag colors once per item for reuse as node fill.
      const colorByTag = new Map<string, string>();
      try {
        const colored = (it as any).getColoredTags?.() || [];
        for (const ct of colored) {
          if (ct && ct.tag && ct.color) colorByTag.set(ct.tag, ct.color);
        }
      } catch {
        /* colored tags unavailable; fall back to hashed colors */
      }

      let tags: any[] = [];
      try {
        tags = it.getTags() || [];
      } catch {
        tags = [];
      }

      let count = 0;
      const seenThisItem = new Set<string>();
      for (const t of tags) {
        const name = (t && t.tag ? String(t.tag) : "").trim();
        if (!name) continue;
        if (seenThisItem.has(name)) continue;
        if (count >= MAX_TAGS_PER_ITEM) break;
        seenThisItem.add(name);
        count++;

        let tId = tagIdByName.get(name);
        if (tId === undefined) {
          tId = nextTagId--;
          tagIdByName.set(name, tId);
          const color = colorByTag.get(name) || hashColor(`tag:${name}`);
          nodes.push(makeNode(tId, `tag:${name}`, name, "tag", color));
        }
        addEdge(edgeMap, it.id, tId, 1);
      }
    }

    return finalize(nodes, edgeMap, cap, "tag");
  }
}

function safeTitle(it: Zotero.Item): string {
  try {
    const t = it.getDisplayTitle?.();
    if (t) return t;
  } catch {
    /* ignore */
  }
  try {
    const f = it.getField?.("title");
    if (f) return String(f);
  } catch {
    /* ignore */
  }
  return `[${it.key}]`;
}
