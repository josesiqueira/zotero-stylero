import { getPref } from "../utils/prefs";
import { ReadingStore } from "./readingStore";

/**
 * Bucket B - custom "stylero-title" item-tree column.
 *
 * Mirrors the native Title content (via getDisplayTitle for sort/quicksearch)
 * but decorates each cell with:
 *   - a reading-time HEAT background normalized against the currently visible
 *     rows (ReadingStore is the data source, consumed read-only),
 *   - the file-type / attachment icon (item.getImageSrc()),
 *   - colored tag swatches (item.getColoredTags()) before the title,
 *   - odd/even row striping,
 *   - whole-cell bold for unread (feed) items.
 *
 * Implemented as a REGISTERED column via Zotero.ItemTreeManager.registerColumns
 * (the supported Zotero 9 API), NOT by patching the native primary cell. Each
 * renderCell call returns a fresh, self-contained node so the virtualized tree
 * can safely recycle row DOM.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_KEY = "stylero-title";
const CSS_LINK_ID = "stylero-titleColumn-css";

// ---------------------------------------------------------------------------
// Pref typing / access
// ---------------------------------------------------------------------------

/**
 * Strongly-typed view of this feature's preferences. Keys are namespaced under
 * `titleColumn.*` and documented in {@link PREFS}.
 */
export interface TitleColumnPrefs {
  /** Master toggle. When false the column is not registered. */
  "titleColumn.enable": boolean;
  /** Show the reading-time heat background behind the title. */
  "titleColumn.heat.enable": boolean;
  /** Base hue (HSL degrees) for the heat color ramp. */
  "titleColumn.heat.hue": number;
  /** Max background opacity for the hottest visible row (string in prefs.js). */
  "titleColumn.heat.maxAlpha": string;
  /** Normalization curve: 'linear' or 'sqrt'. */
  "titleColumn.heat.scale": string;
  /** Prepend the file-type icon from item.getImageSrc(). */
  "titleColumn.icon.enable": boolean;
  /** Apply odd/even row striping based on row-index parity. */
  "titleColumn.striping.enable": boolean;
  /** Render colored tag dots before the title. */
  "titleColumn.tagSwatches.enable": boolean;
  /** Maximum number of colored tag dots per row. */
  "titleColumn.tagSwatches.max": number;
  /** Unread-bold scope: 'feeds', 'all', or 'off'. */
  "titleColumn.bold.scope": string;
}

type PrefKey = keyof TitleColumnPrefs;

/**
 * Typed pref reader. The scaffold-generated PluginPrefsMap does not know about
 * our namespaced keys, so we read through the shared getPref helper with a
 * narrow cast rather than editing shared typings.
 */
function pref<K extends PrefKey>(key: K): TitleColumnPrefs[K] {
  return getPref(key as any) as TitleColumnPrefs[K];
}

// ---------------------------------------------------------------------------
// Per-paint memoization of the visible-row heat maximum
// ---------------------------------------------------------------------------

/**
 * Memoizes the maximum total dwell across the currently visible rows so the
 * O(n) visible-range scan runs once per paint tick instead of once per cell
 * (which would be O(n^2)). The cache is keyed per document and invalidated on
 * the next animation frame, on tree scroll, and on tree refresh.
 */
interface HeatMemo {
  value: number;
  token: number;
  scheduled: boolean;
}

const heatMemoByDoc = new WeakMap<Document, HeatMemo>();

function getHeatMemo(doc: Document): HeatMemo {
  let memo = heatMemoByDoc.get(doc);
  if (!memo) {
    memo = { value: 0, token: 0, scheduled: false };
    heatMemoByDoc.set(doc, memo);
  }
  return memo;
}

function invalidateHeatMemo(doc: Document): void {
  const memo = heatMemoByDoc.get(doc);
  if (memo) {
    memo.token = 0; // forces recompute on next read
  }
}

// ---------------------------------------------------------------------------
// Helpers (kept synchronous and cheap; run on every row paint)
// ---------------------------------------------------------------------------

/** Resolve the live ItemTree instance backing this document, if any. */
function getItemsView(doc: Document): any {
  try {
    const win: any = doc.defaultView;
    return win?.ZoteroPane?.itemsView ?? null;
  } catch {
    return null;
  }
}

/** Resolve the Zotero.Item for a given row, guarding fast-scroll recycling. */
function getRowItem(doc: Document, index: number): Zotero.Item | null {
  try {
    const view = getItemsView(doc);
    if (!view || typeof view.getRow !== "function") {
      return null;
    }
    const row = view.getRow(index);
    return (row && row.ref) || null;
  } catch {
    return null;
  }
}

/**
 * Determine the on-screen row range. Falls back to the full loaded range when
 * the semi-private tree accessors are unavailable on this Zotero build, so the
 * normalization window merely widens (correctness is preserved).
 */
function getVisibleRowRange(view: any): { first: number; last: number } {
  const rowCount: number =
    typeof view?.rowCount === "number" ? view.rowCount : 0;
  let first = 0;
  let last = rowCount - 1;

  try {
    const treebox = view?._treebox;
    if (
      treebox &&
      typeof treebox.getFirstVisibleRow === "function" &&
      typeof treebox.getLastVisibleRow === "function"
    ) {
      const f = treebox.getFirstVisibleRow();
      const l = treebox.getLastVisibleRow();
      if (Number.isFinite(f) && Number.isFinite(l) && l >= f) {
        first = Math.max(0, f);
        last = Math.min(rowCount - 1, l);
      }
    }
  } catch {
    /* fall back to the full loaded range */
  }

  if (last < first) {
    last = first;
  }
  return { first, last };
}

/**
 * Compute (and memoize per paint tick) the maximum ReadingStore total across
 * the currently visible rows. Returns 0 when nothing is readable or the store
 * is not ready, in which case heat rendering is skipped entirely.
 */
function getVisibleMaxTotal(doc: Document): number {
  const memo = getHeatMemo(doc);
  if (memo.token !== 0) {
    // Already computed for the current paint tick.
    return memo.value;
  }

  const view = getItemsView(doc);
  let max = 0;
  if (view && typeof view.getRow === "function") {
    const { first, last } = getVisibleRowRange(view);
    const keys: string[] = [];
    for (let i = first; i <= last; i++) {
      let row: any;
      try {
        row = view.getRow(i);
      } catch {
        continue;
      }
      const item = row && row.ref;
      if (item && item.key) {
        keys.push(item.key);
      }
    }
    if (keys.length) {
      try {
        max = ReadingStore.getMaxTotalInView(keys) || 0;
      } catch {
        max = 0;
      }
    }
  }

  memo.value = max > 0 ? max : 0;
  memo.token = 1; // mark as fresh for this paint tick

  // Invalidate on the next frame so a subsequent scroll/refresh recomputes
  // against the new visible set. Guarded so we only schedule one rAF per tick.
  if (!memo.scheduled) {
    memo.scheduled = true;
    const win: any = doc.defaultView;
    const raf =
      (win && typeof win.requestAnimationFrame === "function"
        ? win.requestAnimationFrame.bind(win)
        : null) ||
      ((cb: () => void) => setTimeout(cb, 16));
    raf(() => {
      memo.scheduled = false;
      memo.token = 0;
    });
  }

  return memo.value;
}

/**
 * Normalized heat ratio (0..1) for an item, relative to the visible-row max and
 * shaped by the heat.scale pref. Returns 0 when the store is unavailable, the
 * item has no dwell, or the visible max is 0 (avoids divide-by-zero).
 */
function computeHeatRatio(itemKey: string, doc: Document): number {
  let total = 0;
  try {
    const data = ReadingStore.getItemData(itemKey);
    total = data ? data.total : 0;
  } catch {
    total = 0;
  }
  if (!total || total <= 0) {
    return 0;
  }

  const max = getVisibleMaxTotal(doc);
  if (!max || max <= 0) {
    return 0;
  }

  let ratio = total / max;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;

  const scale = pref("titleColumn.heat.scale");
  if (scale === "sqrt") {
    ratio = Math.sqrt(ratio);
  }
  return ratio;
}

/** Parse and clamp the maxAlpha pref (stored as a string in prefs.js). */
function getMaxAlpha(): number {
  const raw = pref("titleColumn.heat.maxAlpha");
  let alpha = parseFloat(String(raw));
  if (!Number.isFinite(alpha)) {
    alpha = 0.45;
  }
  if (alpha < 0) alpha = 0;
  if (alpha > 1) alpha = 1;
  return alpha;
}

/** Build the colored tag swatches that precede the title. */
function buildTagDots(item: Zotero.Item, doc: Document): HTMLElement | null {
  let tags: Array<{ tag: string; color: string }> = [];
  try {
    const fn = (item as any).getColoredTags;
    if (typeof fn === "function") {
      tags = fn.call(item) || [];
    }
  } catch {
    tags = [];
  }
  if (!tags || !tags.length) {
    return null;
  }

  let maxDots = Number(pref("titleColumn.tagSwatches.max"));
  if (!Number.isFinite(maxDots) || maxDots < 0) {
    maxDots = 5;
  }
  if (maxDots === 0) {
    return null;
  }

  const frag = doc.createElement("span");
  frag.className = "stylero-tag-dots";
  frag.style.display = "flex";
  frag.style.flex = "0 0 auto";
  frag.style.flexDirection = "row";
  frag.style.gap = "2px";

  let count = 0;
  for (const t of tags) {
    if (count >= maxDots) {
      break;
    }
    if (!t || !t.color) {
      continue;
    }
    const dot = doc.createElement("span");
    dot.className = "stylero-tag-dot";
    dot.style.background = t.color;
    dot.setAttribute("title", t.tag || "");
    frag.appendChild(dot);
    count++;
  }

  return count > 0 ? frag : null;
}

/** Build the file-type / attachment icon image. */
function buildIcon(item: Zotero.Item, doc: Document): HTMLElement | null {
  let src = "";
  try {
    const fn = (item as any).getImageSrc;
    if (typeof fn === "function") {
      src = fn.call(item) || "";
    }
  } catch {
    src = "";
  }
  if (!src) {
    return null;
  }
  const img = doc.createElement("img");
  img.className = "stylero-title-icon";
  img.setAttribute("src", src);
  return img;
}

/** Decide whether this item's cell should be bold, per the bold.scope pref. */
function shouldBold(item: Zotero.Item): boolean {
  const scope = pref("titleColumn.bold.scope");
  if (scope === "off") {
    return false;
  }
  if (scope === "all") {
    // isRead may be undefined for non-feed items; only bold true-unread.
    return (item as any).isRead === false;
  }
  // Default 'feeds': only feed items that are unread.
  const isFeed =
    typeof (item as any).isFeedItem === "boolean"
      ? (item as any).isFeedItem
      : false;
  return isFeed && (item as any).isRead === false;
}

// ---------------------------------------------------------------------------
// dataProvider / renderCell
// ---------------------------------------------------------------------------

/**
 * Plain-string value for native sort and quicksearch. We deliberately return
 * the display title so sorting on this column behaves like the native Title.
 */
function dataProvider(item: Zotero.Item, _dataKey: string): string {
  try {
    return item.getDisplayTitle() || "";
  } catch {
    return "";
  }
}

function renderCell(
  index: number,
  data: string,
  column: any,
  _isFirstColumn: boolean,
  doc: Document,
): HTMLElement {
  const cell = doc.createElement("span");
  cell.className = `cell ${column?.className ?? ""} stylero-title-cell`.trim();

  // Resolve the live item; never trust `data` for the item ref.
  const item = getRowItem(doc, index);

  // Striping: always set exactly one parity class so a recycled node never
  // keeps a stale class. Gated by the pref.
  if (pref("titleColumn.striping.enable")) {
    cell.classList.add(index % 2 === 0 ? "stylero-row-even" : "stylero-row-odd");
  }

  // Minimal cell when the row could not be resolved (fast scroll / recycle):
  // just the title text from `data`.
  if (!item) {
    const text = doc.createElement("span");
    text.className = "stylero-title-text";
    text.textContent = data || "";
    cell.appendChild(text);
    return cell;
  }

  // Bold the whole cell for unread items in scope.
  if (shouldBold(item)) {
    cell.classList.add("stylero-unread");
  }

  // HEAT: absolutely-positioned background layer behind everything. Added only
  // when enabled and the computed alpha is meaningfully > 0.
  if (pref("titleColumn.heat.enable")) {
    const ratio = computeHeatRatio(item.key, doc);
    if (ratio > 0) {
      const alpha = ratio * getMaxAlpha();
      if (alpha > 0.001) {
        let hue = Number(pref("titleColumn.heat.hue"));
        if (!Number.isFinite(hue)) {
          hue = 12;
        }
        const heat = doc.createElement("span");
        heat.className = "stylero-heat";
        heat.style.background = `hsla(${hue}, 85%, 50%, ${alpha})`;
        cell.appendChild(heat);
      }
    }
  }

  // ICON before the text.
  if (pref("titleColumn.icon.enable")) {
    const icon = buildIcon(item, doc);
    if (icon) {
      cell.appendChild(icon);
    }
  }

  // TAG DOTS before the text.
  if (pref("titleColumn.tagSwatches.enable")) {
    const dots = buildTagDots(item, doc);
    if (dots) {
      cell.appendChild(dots);
    }
  }

  // TITLE TEXT (textContent only; never innerHTML).
  const text = doc.createElement("span");
  text.className = "stylero-title-text";
  let title = data;
  if (!title) {
    try {
      title = item.getDisplayTitle() || "";
    } catch {
      title = "";
    }
  }
  text.textContent = title;
  cell.appendChild(text);

  return cell;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export class TitleColumnFactory {
  /** Tracks whether the column is currently registered (so unregister is safe). */
  private static registered = false;

  /**
   * One-time global registration. Registers the custom stylero-title column
   * with ItemTreeManager. Called once in onStartup (after Zotero.uiReadyPromise).
   * No-op when the master enable pref is false.
   */
  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!pref("titleColumn.enable")) {
      return;
    }
    try {
      await Zotero.ItemTreeManager.registerColumns({
        pluginID: addon.data.config.addonID,
        dataKey: DATA_KEY,
        label: "Title (Stylero)",
        dataProvider,
        renderCell,
      } as any);
      this.registered = true;
    } catch (e) {
      ztoolkit.log("[Stylero] titleColumn register failed", e);
    }
  }

  /**
   * Per-window: injects the feature stylesheet via a <link> and wires tree
   * scroll/refresh listeners that invalidate the heat memo. Idempotent: guarded
   * by the link element id so multiple calls / multiple windows are safe.
   */
  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc) {
      return;
    }

    if (!doc.getElementById(CSS_LINK_ID)) {
      const link = ztoolkit.UI.createElement(doc, "link", {
        id: CSS_LINK_ID,
        properties: {
          type: "text/css",
          rel: "stylesheet",
          href: `chrome://${addon.data.config.addonRef}/content/titleColumn.css`,
        },
      });
      (doc.documentElement || doc.head || doc.body)?.appendChild(link);
    }

    // Invalidate the per-paint heat memo when the user scrolls the item tree,
    // so rows scrolled into view normalize against the new visible set. Guard
    // against double-binding via a flag on the document.
    try {
      const flagged = (doc as any).__styleroTitleHeatBound;
      if (!flagged) {
        const handler = () => invalidateHeatMemo(doc);
        const tree = doc.getElementById("item-tree-main-default");
        const target: EventTarget | null = tree || doc;
        target.addEventListener("scroll", handler, true);
        (doc as any).__styleroTitleHeatBound = handler;
      }
    } catch {
      /* non-fatal: memo still expires every animation frame */
    }
  }

  /**
   * Removes the injected stylesheet and the scroll listener for a window.
   */
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc) {
      return;
    }
    doc.getElementById(CSS_LINK_ID)?.remove();

    try {
      const handler = (doc as any).__styleroTitleHeatBound;
      if (handler) {
        const tree = doc.getElementById("item-tree-main-default");
        const target: EventTarget = tree || doc;
        target.removeEventListener("scroll", handler, true);
        delete (doc as any).__styleroTitleHeatBound;
      }
    } catch {
      /* ignore */
    }

    heatMemoByDoc.delete(doc);
  }

  /**
   * Unregisters the custom column. ztoolkit.unregisterAll() covers
   * toolkit-tracked registrations, but this column is registered directly via
   * the native Zotero.ItemTreeManager and must be removed explicitly.
   */
  static async unregister(): Promise<void> {
    if (!this.registered) {
      return;
    }
    try {
      await Zotero.ItemTreeManager.unregisterColumns(DATA_KEY);
    } catch (e) {
      ztoolkit.log("[Stylero] titleColumn unregister failed", e);
    } finally {
      this.registered = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Pref defaults (appended to addon/prefs.js by integration)
// ---------------------------------------------------------------------------

/**
 * Default values for every `titleColumn.*` preference. Integration appends
 * these to addon/prefs.js (the scaffold prepends the prefs prefix).
 */
export const PREFS: Record<string, string | number | boolean> = {
  "titleColumn.enable": true,
  "titleColumn.heat.enable": true,
  "titleColumn.heat.hue": 12,
  "titleColumn.heat.maxAlpha": "0.45",
  "titleColumn.heat.scale": "sqrt",
  "titleColumn.icon.enable": true,
  "titleColumn.striping.enable": true,
  "titleColumn.tagSwatches.enable": true,
  "titleColumn.tagSwatches.max": 5,
  "titleColumn.bold.scope": "feeds",
};
