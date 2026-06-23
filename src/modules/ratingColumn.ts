import { getPref } from "../utils/prefs";

/**
 * Bucket C - Feature 9: EndNote-style 5-star Rating column.
 *
 * Registers a sortable item-tree column ("stylero-rating"). The rating value
 * (0..max) is stored in the item's Extra field on a line "rate: N". Clicking a
 * star writes the new value back into Extra (preserving every other line) via
 * saveTx; the Notifier 'modify' event repaints the row. Supports hover preview
 * and clear-on-click-same-star.
 */

export const PREFS: Record<string, string | number | boolean> = {
  "ratingColumn.enable": true,
  "ratingColumn.max": 5,
  "ratingColumn.extraKey": "rate",
  "ratingColumn.allowClear": true,
};

const COLUMN_DATA_KEY = "stylero-rating";

const STAR_FILLED = "★"; // ★
const STAR_EMPTY = "☆"; // ☆

// Cached prefs. These are read once in register() (see [18]); pref changes
// therefore apply only after the column is re-registered (plugin reload /
// disable+enable). Re-reading on every renderCell/dataProvider is a hot-path
// cost we deliberately avoid.
let cachedMax = 5;
let cachedExtraKey = "rate";
let cachedAllowClear = true;

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMax(): number {
  const raw = Number(getPref("ratingColumn.max"));
  const n = Number.isFinite(raw) ? Math.floor(raw) : 5;
  return Math.min(9, Math.max(1, n));
}

function getExtraKey(): string {
  const raw = String(getPref("ratingColumn.extraKey") ?? "rate").trim();
  return raw || "rate";
}

/**
 * Read the current rating from an item's Extra field, clamped to [0, max].
 */
function getRating(item: Zotero.Item): number {
  if (!item || !item.getField) {
    return 0;
  }
  const max = cachedMax;
  const key = cachedExtraKey;
  const extra = String(item.getField("extra") ?? "");
  if (!extra) {
    return 0;
  }
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(\\d+)`, "i");
  for (const line of extra.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v)) {
        return Math.min(max, Math.max(0, v));
      }
      return 0;
    }
  }
  return 0;
}

/**
 * Write a rating into the item's Extra field, preserving all non-rate lines,
 * then persist with saveTx. Re-reads fresh Extra so rapid concurrent clicks
 * serialize correctly.
 */
async function setRating(item: Zotero.Item, value: number): Promise<void> {
  if (!item || !item.isRegularItem || !item.isRegularItem()) {
    return;
  }
  const max = cachedMax;
  const key = cachedExtraKey;
  const clamped = Math.min(max, Math.max(0, Math.floor(value)));

  const extra = String(item.getField("extra") ?? "");

  // [17] Short-circuit when the already-parsed rating equals the request. This
  // avoids a saveTx when only trailing newlines (or nothing) would change.
  if (getRating(item) === clamped) {
    return;
  }

  const lines = extra.length ? extra.split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*\\d+`, "i");

  const kept: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (re.test(line)) {
      if (!replaced && clamped > 0) {
        kept.push(`${key}: ${clamped}`);
        replaced = true;
      }
      // when clearing (clamped === 0) or already replaced: drop the rate line
      continue;
    }
    kept.push(line);
  }
  if (!replaced && clamped > 0) {
    kept.push(`${key}: ${clamped}`);
  }

  const newExtra = kept.join("\n").replace(/\n+$/g, "");
  // [17] Compare against the existing Extra with trailing newlines trimmed, so
  // a value that only differs by trailing blank lines does not trigger saveTx.
  if (newExtra === extra.replace(/\n+$/g, "")) {
    return;
  }
  item.setField("extra", newExtra);
  await item.saveTx();
}

export class RatingColumnFactory {
  private static registered = false;
  // [19] registerColumns returns a pluginID-prefixed key; we must pass THAT
  // exact string back to unregisterColumns, not the raw COLUMN_DATA_KEY.
  private static columnKey: string | false = false;
  // [15] One delegated click/hover handler per window, tracked so it can be
  // removed in unregisterWindow.
  private static delegatedByDoc = new WeakMap<
    Document,
    {
      target: EventTarget;
      onMove: (ev: Event) => void;
      onLeave: (ev: Event) => void;
      onClick: (ev: Event) => void;
    }
  >();

  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("ratingColumn.enable")) {
      return;
    }

    // [18] Read prefs ONCE at registration. Hot-path code (dataProvider /
    // renderCell) uses the cached values. Pref changes apply after the column
    // is re-registered (plugin reload).
    cachedMax = getMax();
    cachedExtraKey = getExtraKey();
    cachedAllowClear = !!getPref("ratingColumn.allowClear");

    const key = await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: COLUMN_DATA_KEY,
      label: "Rating (Stylero)",
      // [default-visible] shown by default, but users can hide it.
      hidden: false,
      showInColumnPicker: true,
      dataProvider: (item: Zotero.Item) => {
        if (!item || !item.isRegularItem || !item.isRegularItem()) {
          return "0";
        }
        return String(getRating(item));
      },
      renderCell: (
        index: number,
        data: string,
        column: any,
        isFirstColumn: boolean,
        doc: Document,
      ) => this.renderCell(doc, column, data, index),
    } as any);

    // [19] Store the prefixed key returned by registerColumns for unregister.
    this.columnKey = (key as unknown as string) || COLUMN_DATA_KEY;
    this.registered = true;
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("ratingColumn.enable")) {
      return;
    }
    const doc = win.document;
    const id = "stylero-ratingColumn-css";
    if (doc.getElementById(id)) {
      return;
    }
    const link = ztoolkit.UI.createElement(doc, "link", {
      id,
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/ratingColumn.css`,
      },
    });
    doc.documentElement?.appendChild(link);

    // [15] Install ONE delegated listener set per window on the item-tree
    // container. renderCell only builds DOM; all interactivity lives here so
    // recycled cells never accumulate listeners.
    this.installDelegatedListeners(doc);
  }

  /**
   * Per-window teardown: remove the injected stylesheet and the delegated
   * item-tree listeners installed in registerWindow.
   */
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc) {
      return;
    }
    doc.getElementById("stylero-ratingColumn-css")?.remove();

    const entry = this.delegatedByDoc.get(doc);
    if (entry) {
      entry.target.removeEventListener("mousemove", entry.onMove, true);
      entry.target.removeEventListener("mouseleave", entry.onLeave, true);
      entry.target.removeEventListener("click", entry.onClick, true);
      this.delegatedByDoc.delete(doc);
    }
  }

  static unregister(): void {
    if (!this.registered) {
      return;
    }
    try {
      // [19] Use the exact key returned by registerColumns.
      Zotero.ItemTreeManager.unregisterColumns(
        (this.columnKey || COLUMN_DATA_KEY) as any,
      );
    } catch (e) {
      ztoolkit.log("[Stylero] ratingColumn unregister failed", e);
    }
    this.columnKey = false;
    this.registered = false;
  }

  /**
   * [15] Attach a single delegated listener set to the item-tree container for
   * a window. Idempotent via delegatedByDoc. Hover/click are resolved through
   * event.target.closest('.stylero-rating-star'); the owning item is resolved
   * from the row at interaction time.
   */
  private static installDelegatedListeners(doc: Document): void {
    if (this.delegatedByDoc.has(doc)) {
      return;
    }
    const target: EventTarget =
      doc.getElementById("item-tree-main-default") || doc;

    const paint = (container: HTMLElement, fill: number, hover: boolean) => {
      const stars = container.querySelectorAll(
        ".stylero-rating-star",
      ) as NodeListOf<HTMLElement>;
      for (let i = 0; i < stars.length; i++) {
        const on = i < fill;
        stars[i].textContent = on ? STAR_FILLED : STAR_EMPTY;
        stars[i].classList.toggle("filled", on && !hover);
        stars[i].classList.toggle("hover", on && hover);
      }
    };
    const baseValue = (container: HTMLElement) =>
      parseInt(container.getAttribute("data-stylero-rating") || "0", 10) || 0;

    const onMove = (ev: Event) => {
      const star = (ev.target as HTMLElement)?.closest?.(
        ".stylero-rating-star",
      ) as HTMLElement | null;
      if (!star) {
        return;
      }
      const container = star.closest(
        ".stylero-rating-stars",
      ) as HTMLElement | null;
      if (!container) {
        return;
      }
      const idx = parseInt(star.getAttribute("data-index") || "-1", 10);
      if (idx >= 0) {
        container.classList.add("stylero-hovering");
        paint(container, idx + 1, true);
      }
    };

    const onLeave = (ev: Event) => {
      const container = (ev.target as HTMLElement)?.closest?.(
        ".stylero-rating-stars",
      ) as HTMLElement | null;
      if (!container) {
        return;
      }
      container.classList.remove("stylero-hovering");
      paint(container, baseValue(container), false);
    };

    const onClick = (ev: Event) => {
      const star = (ev.target as HTMLElement)?.closest?.(
        ".stylero-rating-star",
      ) as HTMLElement | null;
      if (!star) {
        return;
      }
      const container = star.closest(
        ".stylero-rating-stars",
      ) as HTMLElement | null;
      if (!container) {
        return;
      }
      ev.stopPropagation();
      ev.preventDefault();

      const item = this.resolveItem(star);
      if (!item) {
        return;
      }

      const idx = parseInt(star.getAttribute("data-index") || "-1", 10);
      if (idx < 0) {
        return;
      }
      let newValue = idx + 1;
      const current = getRating(item);
      if (cachedAllowClear && newValue === current) {
        newValue = 0;
      }
      // Optimistic local paint; the notifier 'modify' repaint reconciles.
      container.setAttribute("data-stylero-rating", String(newValue));
      paint(container, newValue, false);

      void setRating(item, newValue).catch((e) =>
        ztoolkit.log("[Stylero] setRating failed", e),
      );
    };

    target.addEventListener("mousemove", onMove, true);
    target.addEventListener("mouseleave", onLeave, true);
    target.addEventListener("click", onClick, true);

    this.delegatedByDoc.set(doc, { target, onMove, onLeave, onClick });
  }

  /**
   * [15] Build a fresh cell DOM on every paint. No listeners are attached here;
   * interactivity is handled by the per-window delegated listeners installed in
   * registerWindow. The row index is stamped on the container so the delegated
   * handlers can resolve the owning item robustly (see [16]).
   */
  private static renderCell(
    doc: Document,
    column: any,
    data: string,
    index: number,
  ): HTMLSpanElement {
    const max = cachedMax;

    const cell = doc.createElement("span");
    cell.className = `cell ${column?.className ?? ""} stylero-rating-cell`;

    // The rendered value comes from dataProvider (already clamped string).
    let current = parseInt(data, 10);
    if (!Number.isFinite(current)) {
      current = 0;
    }
    current = Math.min(max, Math.max(0, current));

    const container = doc.createElement("span");
    container.className = "stylero-rating-stars";
    container.setAttribute("data-stylero-rating", String(current));
    // [16] Stamp the row index renderCell was given so the delegated click
    // handler can resolve the item via itemsView.getRow(index) without parsing
    // a brittle row-id regex.
    container.setAttribute("data-row-index", String(index));

    for (let i = 0; i < max; i++) {
      const star = doc.createElement("span");
      star.className = "stylero-rating-star";
      star.setAttribute("data-index", String(i));
      star.textContent = i < current ? STAR_FILLED : STAR_EMPTY;
      if (i < current) {
        star.classList.add("filled");
      }
      container.appendChild(star);
    }

    cell.appendChild(container);
    return cell;
  }

  /**
   * [16] Resolve the Zotero.Item owning a given rendered star node.
   * Prefers the row index stamped on the cell container by renderCell; falls
   * back to parsing the row element's id only if the stamp is absent. Logs when
   * resolution fails instead of silently no-op'ing.
   */
  private static resolveItem(node: HTMLElement): Zotero.Item | undefined {
    const doc = node.ownerDocument;
    const win = doc?.defaultView as any;
    if (!win) {
      ztoolkit.log("[Stylero] ratingColumn resolveItem: no window");
      return undefined;
    }

    const container = node.closest(
      ".stylero-rating-stars",
    ) as HTMLElement | null;

    let rowIndex = NaN;
    const stamped = container?.getAttribute("data-row-index");
    if (stamped != null) {
      rowIndex = parseInt(stamped, 10);
    } else {
      // Fallback: read the row element's index from its id/position.
      const row = node.closest(".row") as HTMLElement | null;
      const idAttr = row?.id || "";
      const m = idAttr.match(/-row-(\d+)$/);
      if (m) {
        rowIndex = parseInt(m[1], 10);
      }
    }

    if (!Number.isFinite(rowIndex)) {
      ztoolkit.log("[Stylero] ratingColumn resolveItem: no row index");
      return undefined;
    }

    const itemsView = win.ZoteroPane?.itemsView;
    if (!itemsView || typeof itemsView.getRow !== "function") {
      ztoolkit.log("[Stylero] ratingColumn resolveItem: no itemsView");
      return undefined;
    }
    try {
      const treeRow = itemsView.getRow(rowIndex);
      const ref = treeRow?.ref;
      if (ref && ref.isRegularItem && ref.isRegularItem()) {
        return ref as Zotero.Item;
      }
      ztoolkit.log(
        `[Stylero] ratingColumn resolveItem: row ${rowIndex} is not a regular item`,
      );
    } catch (e) {
      ztoolkit.log("[Stylero] ratingColumn resolveItem failed", e);
    }
    return undefined;
  }
}
