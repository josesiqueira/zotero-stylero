import { getPref } from "../utils/prefs";
import { ReadingStore } from "./readingStore";

/**
 * Feature 8 - Progress column.
 *
 * Registers a single item-tree column ("stylero-progress") that draws a compact
 * per-page distribution sparkline for an item's PDF attachments. The distribution
 * can come from annotation counts, ReadingStore dwell seconds, or a blend of both,
 * and is drawn as a bar, line, opacity-heat or stacked mini chart.
 *
 * The column is registered through Zotero.ItemTreeManager so it appears in the
 * native column picker and supports native reordering / header context menu.
 *
 * All rendering is render-only and never writes, so it is safe in group / read-only
 * libraries.
 */

export type ProgressStyle = "bar" | "line" | "opacity" | "stack";
export type ProgressSource = "annotations" | "reading" | "both";

/** A page-indexed distribution: bucket index -> magnitude. */
type Distribution = number[];

/** Computed per-item data, ready to draw. */
interface ItemProgress {
  /** Annotation count per bucket. */
  annotations: Distribution;
  /** Reading dwell seconds per bucket. */
  reading: Distribution;
  /** Number of buckets actually used (>= 1). */
  buckets: number;
  /** Max single-bucket value across the selected source (for item normalization). */
  itemMax: number;
  /** Sortable total magnitude. */
  total: number;
}

export class ProgressColumnFactory {
  static readonly DATA_KEY = "stylero-progress";

  /** Tracks whether the column was actually registered (so unregister is a no-op otherwise). */
  private static registered = false;

  /** Symbol returned by Zotero.Prefs.registerObserver, so we can unregister it manually. */
  private static prefObserverID: symbol | null = null;

  /** Per-window injected <link> nodes, so we can remove exactly what we added. */
  private static readonly injectedLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();

  /**
   * Lightweight per-item memo so we do not re-walk attachments / parse annotation
   * positions on every single paint of a recycled row. Keyed by item id; the cached
   * entry stores the item version used so it is invalidated when the item changes.
   */
  private static readonly memo = new Map<
    number,
    {
      version: number;
      source: ProgressSource;
      maxBuckets: number;
      /** Reading-store fingerprint for reading/both sources (null for annotations-only). */
      readingFp: number | null;
      data: ItemProgress;
    }
  >();

  /** Hard cap on memo entries; oldest-inserted entries are evicted past this. */
  private static readonly MEMO_MAX = 2000;

  /**
   * One-time global registration. No-op (and column NOT registered) when
   * `progressColumn.enable` is false, matching the original off-by-default behavior.
   */
  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("progressColumn.enable")) {
      return;
    }

    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: ProgressColumnFactory.DATA_KEY,
      label: "Progress",
      // Sortable value: cheap, O(annotations) without parsing positions.
      dataProvider: (item: Zotero.Item) => {
        return String(ProgressColumnFactory.computeSortValue(item));
      },
      renderCell: (
        index: number,
        data: string,
        column: any,
        isFirstColumn: boolean,
        doc: Document,
      ) => {
        return ProgressColumnFactory.renderCell(index, data, column, doc);
      },
    } as any);

    this.registered = true;

    // Pref changes (style/source/color/normalize) don't bump item versions and the tree
    // does not repaint on its own, so observe the relevant prefs and refresh manually.
    // Not covered by ztoolkit, so we unregister this in unregister().
    try {
      const prefix = addon.data.config.prefsPrefix;
      const watched = [
        `${prefix}.progressColumn.style`,
        `${prefix}.progressColumn.source`,
        `${prefix}.progressColumn.color`,
        `${prefix}.progressColumn.normalize`,
      ];
      this.prefObserverID = Zotero.Prefs.registerObserver(
        `${prefix}.progressColumn`,
        (name: string) => {
          if (!watched.includes(name)) {
            return;
          }
          ProgressColumnFactory.onRelevantPrefChange();
        },
        true,
      );
    } catch (e) {
      ztoolkit.log("[stylero] progressColumn pref observer registration failed", e);
    }
  }

  /**
   * React to a relevant pref change: re-apply the color custom property (for color
   * changes) and refresh the items view in every main window so cells repaint with the
   * new style/source/normalize settings. Memos are cleared because source/maxBuckets
   * changes alter cached distributions.
   */
  private static onRelevantPrefChange(): void {
    this.memo.clear();
    this.viewMaxCache = null;
    for (const win of Zotero.getMainWindows()) {
      try {
        this.applyColorVar(win as _ZoteroTypes.MainWindow);
        const view = (win as any)?.ZoteroPane?.itemsView;
        if (view?.tree && typeof view.tree.invalidate === "function") {
          view.tree.invalidate();
        } else if (view && typeof view.refresh === "function") {
          void view.refresh();
        }
      } catch (e) {
        ztoolkit.log("[stylero] progressColumn pref refresh failed", e);
      }
    }
  }

  /** Per-window CSS injection. */
  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("progressColumn.enable")) {
      return;
    }
    const doc = win.document;
    if (!doc) {
      return;
    }
    // Avoid duplicate injection on reload.
    if (this.injectedLinks.has(win)) {
      return;
    }
    const href = `chrome://${addon.data.config.addonRef}/content/progressColumn.css`;
    const link = ztoolkit.UI.createElement(doc, "link", {
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href,
      },
      attributes: {
        "data-stylero": "progressColumn",
      },
    }) as HTMLLinkElement;
    doc.documentElement?.appendChild(link);
    this.injectedLinks.set(win, link);

    // Expose the configured base fill color to the stylesheet via a custom property.
    this.applyColorVar(win);
  }

  /** Manual cleanup of the injected <link>. The column itself is freed by ztoolkit.unregisterAll. */
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const link = this.injectedLinks.get(win);
    if (link) {
      link.remove();
      this.injectedLinks.delete(win);
    }
    const root = win.document?.documentElement as HTMLElement | undefined;
    root?.style.removeProperty("--stylero-progress-color");
  }

  /** Explicit column removal + memo clear. Also covered by ztoolkit.unregisterAll via pluginID. */
  static unregister(): void {
    if (this.registered) {
      try {
        Zotero.ItemTreeManager.unregisterColumns(ProgressColumnFactory.DATA_KEY);
      } catch (e) {
        ztoolkit.log("[stylero] progressColumn unregister failed", e);
      }
      this.registered = false;
    }
    // Manual cleanup of the pref observer (not covered by ztoolkit.unregisterAll).
    if (this.prefObserverID !== null) {
      try {
        Zotero.Prefs.unregisterObserver(this.prefObserverID);
      } catch (e) {
        ztoolkit.log("[stylero] progressColumn pref observer unregister failed", e);
      }
      this.prefObserverID = null;
    }
    this.memo.clear();
    this.viewMaxCache = null;
  }

  // --------------------------------------------------------------------------
  // Color custom property
  // --------------------------------------------------------------------------

  private static applyColorVar(win: _ZoteroTypes.MainWindow): void {
    const color = String(getPref("progressColumn.color") || "#e8694a");
    const root = win.document?.documentElement as HTMLElement | undefined;
    root?.style.setProperty("--stylero-progress-color", color);
  }

  // --------------------------------------------------------------------------
  // Sorting value (cheap)
  // --------------------------------------------------------------------------

  /**
   * Sortable magnitude. Kept cheap: counts annotations and/or sums dwell, but never
   * parses annotation positions. Items with nothing sort to the bottom (returns 0).
   */
  private static computeSortValue(item: Zotero.Item): number {
    if (!item || !item.isRegularItem || !item.isRegularItem()) {
      return 0;
    }
    const source = ProgressColumnFactory.getSource();
    let value = 0;

    if (source === "annotations" || source === "both") {
      for (const pdf of ProgressColumnFactory.getPDFAttachments(item)) {
        try {
          value += pdf.getAnnotations().length;
        } catch (e) {
          // ignore
        }
      }
    }
    if (source === "reading" || source === "both") {
      const rs = ProgressColumnFactory.readingFor(item);
      if (rs) {
        value += rs.total;
      }
    }
    return value;
  }

  // --------------------------------------------------------------------------
  // Cell rendering
  // --------------------------------------------------------------------------

  private static renderCell(
    index: number,
    data: string,
    column: any,
    doc: Document,
  ): HTMLElement {
    // Always rebuild the subtree from scratch (tree DOM is virtualized / recycled).
    const span = doc.createElement("span");
    span.className = `cell ${column?.className ?? ""} stylero-progress-cell`;

    const item = ProgressColumnFactory.resolveItem(index, doc);
    if (!item) {
      span.classList.add("stylero-progress-empty");
      return span;
    }

    const style = ProgressColumnFactory.getStyle();
    const source = ProgressColumnFactory.getSource();
    const maxBuckets = ProgressColumnFactory.getMaxBuckets();
    const prog = ProgressColumnFactory.getItemProgress(item, source, maxBuckets);

    if (!prog || prog.total <= 0) {
      const track = doc.createElement("span");
      track.className = "stylero-progress-track stylero-progress-empty";
      span.appendChild(track);
      return span;
    }

    // Determine the normalization denominator.
    const normalize = ProgressColumnFactory.getNormalize();
    let denom = prog.itemMax;
    if (normalize === "view") {
      const viewMax = ProgressColumnFactory.computeViewMax(doc, source, maxBuckets);
      if (viewMax > 0) {
        denom = viewMax;
      }
    }
    if (denom <= 0) {
      denom = 1;
    }

    let chart: HTMLElement;
    switch (style) {
      case "line":
        chart = ProgressColumnFactory.buildLineChart(doc, prog, source, denom);
        break;
      case "opacity":
        chart = ProgressColumnFactory.buildOpacityChart(doc, prog, source, denom);
        break;
      case "stack":
        chart = ProgressColumnFactory.buildStackChart(doc, prog, source, denom);
        break;
      case "bar":
      default:
        chart = ProgressColumnFactory.buildBarChart(doc, prog, source, denom);
        break;
    }
    span.appendChild(chart);
    return span;
  }

  /**
   * Pick the magnitude series to draw given the source. For "both" the primary
   * (bar/height) series is annotations and the secondary (opacity) is reading.
   */
  private static primarySeries(prog: ItemProgress, source: ProgressSource): Distribution {
    if (source === "reading") {
      return prog.reading;
    }
    // annotations | both -> annotations drive the primary geometry
    return prog.annotations;
  }

  private static buildBarChart(
    doc: Document,
    prog: ItemProgress,
    source: ProgressSource,
    denom: number,
  ): HTMLElement {
    const track = doc.createElement("span");
    track.className = "stylero-progress-track stylero-progress-bar";
    const series = ProgressColumnFactory.primarySeries(prog, source);
    const overlay = source === "both" ? prog.reading : null;
    const overlayMax = overlay
      ? Math.max(1, ...overlay.map((v) => v || 0))
      : 1;

    for (let i = 0; i < prog.buckets; i++) {
      const cell = doc.createElement("span");
      cell.className = "stylero-progress-cellbar";
      const v = series[i] || 0;
      const h = Math.max(0, Math.min(100, (v / denom) * 100));
      const fill = doc.createElement("span");
      fill.className = "stylero-progress-fill";
      fill.style.height = `${h}%`;
      if (overlay) {
        const o = Math.max(0, Math.min(1, (overlay[i] || 0) / overlayMax));
        // blend reading dwell as background opacity behind the bar
        cell.style.setProperty("--stylero-heat", o.toFixed(3));
        cell.classList.add("stylero-progress-heated");
      }
      cell.appendChild(fill);
      track.appendChild(cell);
    }
    return track;
  }

  private static buildStackChart(
    doc: Document,
    prog: ItemProgress,
    source: ProgressSource,
    denom: number,
  ): HTMLElement {
    // Single continuous horizontal track; each bucket is a slice whose intensity
    // (and for "both", whose two stacked sub-slices) encode the magnitude.
    const track = doc.createElement("span");
    track.className = "stylero-progress-track stylero-progress-stack";
    const annMax = Math.max(1, ...prog.annotations.map((v) => v || 0));
    const readMax = Math.max(1, ...prog.reading.map((v) => v || 0));

    for (let i = 0; i < prog.buckets; i++) {
      const slice = doc.createElement("span");
      slice.className = "stylero-progress-slice";

      if (source === "both") {
        const a = doc.createElement("span");
        a.className = "stylero-progress-substack stylero-progress-sub-ann";
        a.style.flexGrow = String(Math.max(0, prog.annotations[i] || 0) / annMax);
        const r = doc.createElement("span");
        r.className = "stylero-progress-substack stylero-progress-sub-read";
        r.style.flexGrow = String(Math.max(0, prog.reading[i] || 0) / readMax);
        slice.appendChild(a);
        slice.appendChild(r);
      } else {
        const series = ProgressColumnFactory.primarySeries(prog, source);
        const v = series[i] || 0;
        const intensity = Math.max(0, Math.min(1, v / denom));
        slice.style.setProperty("--stylero-heat", intensity.toFixed(3));
        slice.classList.add("stylero-progress-heated");
      }
      track.appendChild(slice);
    }
    return track;
  }

  private static buildOpacityChart(
    doc: Document,
    prog: ItemProgress,
    source: ProgressSource,
    denom: number,
  ): HTMLElement {
    const track = doc.createElement("span");
    track.className = "stylero-progress-track stylero-progress-opacity";
    const series = ProgressColumnFactory.primarySeries(prog, source);
    for (let i = 0; i < prog.buckets; i++) {
      const cell = doc.createElement("span");
      cell.className = "stylero-progress-heatcell";
      const v = series[i] || 0;
      const intensity = Math.max(0, Math.min(1, v / denom));
      cell.style.setProperty("--stylero-heat", intensity.toFixed(3));
      track.appendChild(cell);
    }
    return track;
  }

  private static buildLineChart(
    doc: Document,
    prog: ItemProgress,
    source: ProgressSource,
    denom: number,
  ): HTMLElement {
    const NS = "http://www.w3.org/2000/svg";
    const wrap = doc.createElement("span");
    wrap.className = "stylero-progress-track stylero-progress-line";

    const series = ProgressColumnFactory.primarySeries(prog, source);
    const n = prog.buckets;

    // viewBox uses a fixed coordinate space; CSS scales it to the cell.
    const W = 100;
    const H = 100;
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "stylero-progress-svg");

    const stepX = n > 1 ? W / (n - 1) : W;
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = series[i] || 0;
      const norm = Math.max(0, Math.min(1, v / denom));
      const x = n > 1 ? i * stepX : W / 2;
      const y = H - norm * H;
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }

    // Filled area under the line for a sparkline look.
    if (n > 0) {
      const area = doc.createElementNS(NS, "polygon");
      const areaPoints = `0,${H} ${points.join(" ")} ${W},${H}`;
      area.setAttribute("points", areaPoints);
      area.setAttribute("class", "stylero-progress-area");
      svg.appendChild(area);
    }

    const poly = doc.createElementNS(NS, "polyline");
    poly.setAttribute("points", points.join(" "));
    poly.setAttribute("fill", "none");
    poly.setAttribute("class", "stylero-progress-polyline");
    poly.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(poly);

    wrap.appendChild(svg);
    return wrap;
  }

  // --------------------------------------------------------------------------
  // Item resolution from the owning window's items view
  // --------------------------------------------------------------------------

  /**
   * Resolve the Zotero.Item for a given row index. Uses the owner document's window
   * ZoteroPane.itemsView (not the global one) so multi-window setups stay correct.
   */
  private static resolveItem(index: number, doc: Document): Zotero.Item | null {
    try {
      const win = (doc.defaultView ?? null) as any;
      const pane =
        (win && win.ZoteroPane) || ztoolkit.getGlobal("ZoteroPane");
      const view = pane?.itemsView;
      if (!view || typeof view.getRow !== "function") {
        return null;
      }
      const row = view.getRow(index);
      const ref = row?.ref as Zotero.Item | undefined;
      return ref ?? null;
    } catch (e) {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Distribution computation (memoized)
  // --------------------------------------------------------------------------

  private static getItemProgress(
    item: Zotero.Item,
    source: ProgressSource,
    maxBuckets: number,
  ): ItemProgress | null {
    if (!item || !item.isRegularItem || !item.isRegularItem()) {
      return null;
    }
    const id = item.id;
    const version = (item as any).version ?? 0;
    // Reading-sourced charts depend on ReadingStore (which mutates without bumping
    // the item version), so fold a reading fingerprint into the memo key and skip the
    // version-only short-circuit for reading/both sources.
    const usesReading = source === "reading" || source === "both";
    const readingFp = usesReading
      ? ProgressColumnFactory.readingFor(item)?.total ?? 0
      : null;
    const cached = this.memo.get(id);
    if (
      cached &&
      cached.version === version &&
      cached.source === source &&
      cached.maxBuckets === maxBuckets &&
      cached.readingFp === readingFp
    ) {
      return cached.data;
    }

    const data = ProgressColumnFactory.computeItemProgress(item, source, maxBuckets);
    if (data) {
      // Bound the memo: evict the oldest-inserted entry once over the cap.
      if (!this.memo.has(id) && this.memo.size >= this.MEMO_MAX) {
        const oldest = this.memo.keys().next().value;
        if (oldest !== undefined) {
          this.memo.delete(oldest);
        }
      }
      this.memo.set(id, { version, source, maxBuckets, readingFp, data });
    }
    return data;
  }

  private static computeItemProgress(
    item: Zotero.Item,
    source: ProgressSource,
    maxBuckets: number,
  ): ItemProgress | null {
    // 1. Gather raw per-page values for each requested source.
    const rawAnn = new Map<number, number>(); // pageIndex -> count
    let maxPageAnn = -1;

    if (source === "annotations" || source === "both") {
      for (const pdf of ProgressColumnFactory.getPDFAttachments(item)) {
        let annotations: Zotero.Item[] = [];
        try {
          annotations = pdf.getAnnotations() as Zotero.Item[];
        } catch (e) {
          annotations = [];
        }
        for (const ann of annotations) {
          const page = ProgressColumnFactory.annotationPage(ann);
          if (page === null) {
            continue;
          }
          rawAnn.set(page, (rawAnn.get(page) || 0) + 1);
          if (page > maxPageAnn) {
            maxPageAnn = page;
          }
        }
      }
    }

    const rawRead = new Map<number, number>(); // pageIndex -> seconds
    let maxPageRead = -1;
    if (source === "reading" || source === "both") {
      const rs = ProgressColumnFactory.readingFor(item);
      if (rs) {
        for (const key of Object.keys(rs.pages)) {
          const page = parseInt(key, 10);
          if (!Number.isFinite(page) || page < 0) {
            continue;
          }
          const secs = rs.pages[page] || 0;
          if (secs <= 0) {
            continue;
          }
          rawRead.set(page, secs);
          if (page > maxPageRead) {
            maxPageRead = page;
          }
        }
      }
    }

    const maxPage = Math.max(maxPageAnn, maxPageRead);
    if (maxPage < 0) {
      // Nothing to draw at all.
      return {
        annotations: [],
        reading: [],
        buckets: 0,
        itemMax: 0,
        total: 0,
      };
    }

    const pageCount = maxPage + 1;
    const buckets = Math.max(1, Math.min(maxBuckets, pageCount));
    // pages per bucket (aggregation factor for very long PDFs)
    const factor = pageCount / buckets;

    const annDist: Distribution = new Array(buckets).fill(0);
    const readDist: Distribution = new Array(buckets).fill(0);

    const bucketFor = (page: number) =>
      Math.min(buckets - 1, Math.floor(page / factor));

    rawAnn.forEach((count, page) => {
      annDist[bucketFor(page)] += count;
    });
    rawRead.forEach((secs, page) => {
      readDist[bucketFor(page)] += secs;
    });

    // itemMax / total are computed against the geometry-driving series.
    let itemMax = 0;
    let total = 0;
    const driving =
      source === "reading" ? readDist : annDist; // both -> annotations drive geometry
    for (const v of driving) {
      if (v > itemMax) {
        itemMax = v;
      }
      total += v;
    }
    // For "both", include reading in the sortable total so reading-only items still rank.
    if (source === "both") {
      for (const v of readDist) {
        total += v;
      }
    }

    return {
      annotations: annDist,
      reading: readDist,
      buckets,
      itemMax,
      total,
    };
  }

  /**
   * Render-pass cache for the "view" normalization max. computeViewMax can rescan up
   * to 1000 rows, and renderCell runs once per painted cell, so without this every
   * cell paint in a pass would repeat the full scan. The cached value is reused while
   * the invalidation key (rowCount + source + maxBuckets) holds and a short time
   * window has not elapsed; an rAF callback also clears it at the end of the pass.
   */
  private static viewMaxCache: {
    key: string;
    value: number;
    at: number;
  } | null = null;

  /** Whether an rAF invalidation of viewMaxCache is already scheduled. */
  private static viewMaxRafScheduled = false;

  /** Max age (ms) for a cached view max before it is recomputed regardless of rAF. */
  private static readonly VIEW_MAX_TTL = 250;

  /**
   * Compute the max single-bucket value across all currently visible rows, for the
   * "view" normalization mode. Iterates the owning window's items view rows and reuses
   * the per-item memo so this stays cheap. The result is memoized for the duration of a
   * single render pass (see viewMaxCache) so it is not recomputed inside every cell.
   */
  private static computeViewMax(
    doc: Document,
    source: ProgressSource,
    maxBuckets: number,
  ): number {
    try {
      const win = (doc.defaultView ?? null) as any;
      const pane =
        (win && win.ZoteroPane) || ztoolkit.getGlobal("ZoteroPane");
      const view = pane?.itemsView;
      if (!view || typeof view.getRow !== "function") {
        return 0;
      }
      const rowCount: number =
        typeof view.rowCount === "number"
          ? view.rowCount
          : view._rows?.length || 0;

      // Reuse the value for the rest of this render pass if the cheap invalidation key
      // still matches and the short time window has not elapsed.
      const key = `${rowCount}|${source}|${maxBuckets}`;
      const now = Date.now();
      const cache = ProgressColumnFactory.viewMaxCache;
      if (
        cache &&
        cache.key === key &&
        now - cache.at < ProgressColumnFactory.VIEW_MAX_TTL
      ) {
        return cache.value;
      }

      let max = 0;
      const limit = Math.min(rowCount, 1000); // safety cap
      for (let i = 0; i < limit; i++) {
        const ref = view.getRow(i)?.ref as Zotero.Item | undefined;
        if (!ref) {
          continue;
        }
        const prog = ProgressColumnFactory.getItemProgress(ref, source, maxBuckets);
        if (prog && prog.itemMax > max) {
          max = prog.itemMax;
        }
      }

      ProgressColumnFactory.viewMaxCache = { key, value: max, at: now };
      // Clear the cache at the end of the current frame so a fresh pass recomputes.
      if (
        !ProgressColumnFactory.viewMaxRafScheduled &&
        win &&
        typeof win.requestAnimationFrame === "function"
      ) {
        ProgressColumnFactory.viewMaxRafScheduled = true;
        win.requestAnimationFrame(() => {
          ProgressColumnFactory.viewMaxRafScheduled = false;
          ProgressColumnFactory.viewMaxCache = null;
        });
      }
      return max;
    } catch (e) {
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Resolve an item's PDF attachment items. */
  private static getPDFAttachments(item: Zotero.Item): Zotero.Item[] {
    const out: Zotero.Item[] = [];
    let ids: number[] = [];
    try {
      ids = item.getAttachments() as number[];
    } catch (e) {
      ids = [];
    }
    for (const id of ids) {
      const att = Zotero.Items.get(id) as Zotero.Item | undefined;
      if (!att) {
        continue;
      }
      const isPdf =
        (typeof (att as any).isPDFAttachment === "function" &&
          (att as any).isPDFAttachment()) ||
        (att as any).attachmentContentType === "application/pdf";
      if (isPdf) {
        out.push(att);
      }
    }
    return out;
  }

  /**
   * Resolve the 0-based page index for an annotation. Prefers the parsed
   * annotationPosition JSON pageIndex; falls back to annotationPageLabel parsed to an
   * integer (1-based label -> 0-based index). Returns null if neither parses.
   */
  private static annotationPage(ann: Zotero.Item): number | null {
    const posStr = (ann as any).annotationPosition as string | undefined;
    if (posStr) {
      try {
        const pos = JSON.parse(posStr);
        if (typeof pos?.pageIndex === "number" && pos.pageIndex >= 0) {
          return pos.pageIndex;
        }
      } catch (e) {
        // fall through to label
      }
    }
    const label = (ann as any).annotationPageLabel as string | undefined;
    if (label) {
      const n = parseInt(label, 10);
      if (Number.isFinite(n) && n >= 1) {
        return n - 1; // labels are typically 1-based
      }
    }
    return null;
  }

  /** Read-only access to ReadingStore for an item, guarded against the store not existing. */
  private static readingFor(
    item: Zotero.Item,
  ): { pages: { [page: number]: number }; total: number } | undefined {
    try {
      if (typeof ReadingStore === "undefined" || !ReadingStore) {
        return undefined;
      }
      const key = (item as any).key as string | undefined;
      if (!key) {
        return undefined;
      }
      return ReadingStore.getItemData(key);
    } catch (e) {
      return undefined;
    }
  }

  private static getStyle(): ProgressStyle {
    const v = String(getPref("progressColumn.style") || "bar");
    if (v === "line" || v === "opacity" || v === "stack" || v === "bar") {
      return v;
    }
    return "bar";
  }

  private static getSource(): ProgressSource {
    const v = String(getPref("progressColumn.source") || "annotations");
    if (v === "annotations" || v === "reading" || v === "both") {
      return v;
    }
    return "annotations";
  }

  private static getNormalize(): "item" | "view" {
    const v = String(getPref("progressColumn.normalize") || "item");
    return v === "view" ? "view" : "item";
  }

  private static getMaxBuckets(): number {
    const v = Number(getPref("progressColumn.maxBuckets"));
    if (!Number.isFinite(v) || v < 1) {
      return 40;
    }
    return Math.min(400, Math.floor(v));
  }
}

export const PREFS: Record<string, string | number | boolean> = {
  "progressColumn.enable": false,
  "progressColumn.style": "bar",
  "progressColumn.source": "annotations",
  "progressColumn.normalize": "item",
  "progressColumn.color": "#e8694a",
  "progressColumn.maxBuckets": 40,
};
