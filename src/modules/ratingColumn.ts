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
  const max = getMax();
  const key = getExtraKey();
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
  const max = getMax();
  const key = getExtraKey();
  const clamped = Math.min(max, Math.max(0, Math.floor(value)));

  const extra = String(item.getField("extra") ?? "");
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
  if (newExtra === extra) {
    return;
  }
  item.setField("extra", newExtra);
  await item.saveTx();
}

export class RatingColumnFactory {
  private static registered = false;

  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("ratingColumn.enable")) {
      return;
    }

    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: COLUMN_DATA_KEY,
      label: "Rating (Stylero)",
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
      ) => this.renderCell(doc, column, data),
    });

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
  }

  static unregister(): void {
    if (!this.registered) {
      return;
    }
    try {
      Zotero.ItemTreeManager.unregisterColumns(COLUMN_DATA_KEY);
    } catch (e) {
      ztoolkit.log("[Stylero] ratingColumn unregister failed", e);
    }
    this.registered = false;
  }

  /**
   * Build a fresh cell DOM on every paint. Closures capture only the item id so
   * recycled rows never retain stale item references.
   */
  private static renderCell(
    doc: Document,
    column: any,
    data: string,
  ): HTMLSpanElement {
    const max = getMax();
    const allowClear = !!getPref("ratingColumn.allowClear");

    const cell = doc.createElement("span");
    cell.className = `cell ${column?.className ?? ""} stylero-rating-cell`;

    // The rendered value comes from dataProvider (already clamped string).
    let current = parseInt(data, 10);
    if (!Number.isFinite(current)) {
      current = 0;
    }
    current = Math.min(max, Math.max(0, current));

    // Resolve the item for this row. dataProvider passed us only the value, so
    // re-fetch via the column's referenced item index is not available here;
    // instead we resolve interactivity lazily through the click target's data.
    // We carry the value via data attributes and look the item up on click by
    // walking up to the row to read its rowID. To keep this robust and avoid
    // relying on private tree internals, we resolve the item from the closest
    // ancestor exposing the item id once the user interacts.

    const container = doc.createElement("span");
    container.className = "stylero-rating-stars";
    container.setAttribute("data-stylero-rating", String(current));

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

    // Interactivity is gated on resolving a regular item from the row at click
    // time. We attach listeners that resolve the item via ZoteroPane.
    this.attachInteractivity(doc, cell, container, max, allowClear);

    return cell;
  }

  /**
   * Resolve the Zotero.Item owning a given rendered row node.
   * Walks up to the row div, reads its row id, and maps it through the active
   * ItemTree. Returns undefined when not resolvable (e.g. non-item rows).
   */
  private static resolveItem(node: HTMLElement): Zotero.Item | undefined {
    const doc = node.ownerDocument;
    const win = doc?.defaultView as any;
    const row = node.closest(".row") as HTMLElement | null;
    if (!row || !win) {
      return undefined;
    }
    // Zotero item-tree rows expose their numeric row index via the id
    // "item-tree-<treeID>-row-<index>".
    const idAttr = row.id || "";
    const m = idAttr.match(/-row-(\d+)$/);
    if (!m) {
      return undefined;
    }
    const rowIndex = parseInt(m[1], 10);
    const itemsView = win.ZoteroPane?.itemsView;
    if (!itemsView || typeof itemsView.getRow !== "function") {
      return undefined;
    }
    try {
      const treeRow = itemsView.getRow(rowIndex);
      const ref = treeRow?.ref;
      if (ref && ref.isRegularItem && ref.isRegularItem()) {
        return ref as Zotero.Item;
      }
    } catch (e) {
      ztoolkit.log("[Stylero] ratingColumn resolveItem failed", e);
    }
    return undefined;
  }

  private static attachInteractivity(
    doc: Document,
    cell: HTMLSpanElement,
    container: HTMLSpanElement,
    max: number,
    allowClear: boolean,
  ): void {
    const stars = Array.from(
      container.querySelectorAll(".stylero-rating-star"),
    ) as HTMLElement[];

    const paint = (fill: number, hover: boolean) => {
      for (let i = 0; i < stars.length; i++) {
        const on = i < fill;
        stars[i].textContent = on ? STAR_FILLED : STAR_EMPTY;
        stars[i].classList.toggle("filled", on && !hover);
        stars[i].classList.toggle("hover", on && hover);
      }
    };

    const baseValue = () =>
      parseInt(container.getAttribute("data-stylero-rating") || "0", 10) || 0;

    container.addEventListener("mousemove", (ev) => {
      const target = (ev.target as HTMLElement)?.closest(
        ".stylero-rating-star",
      ) as HTMLElement | null;
      if (!target) {
        return;
      }
      const idx = parseInt(target.getAttribute("data-index") || "-1", 10);
      if (idx >= 0) {
        container.classList.add("stylero-hovering");
        paint(idx + 1, true);
      }
    });

    container.addEventListener("mouseleave", () => {
      container.classList.remove("stylero-hovering");
      paint(baseValue(), false);
    });

    container.addEventListener("click", (ev) => {
      const target = (ev.target as HTMLElement)?.closest(
        ".stylero-rating-star",
      ) as HTMLElement | null;
      if (!target) {
        return;
      }
      ev.stopPropagation();
      ev.preventDefault();

      const item = this.resolveItem(cell);
      if (!item) {
        return;
      }

      const idx = parseInt(target.getAttribute("data-index") || "-1", 10);
      if (idx < 0) {
        return;
      }
      let newValue = idx + 1;
      const current = getRating(item);
      if (allowClear && newValue === current) {
        newValue = 0;
      }
      // Optimistic local paint; the notifier 'modify' repaint reconciles.
      container.setAttribute("data-stylero-rating", String(newValue));
      paint(newValue, false);

      void setRating(item, newValue).catch((e) =>
        ztoolkit.log("[Stylero] setRating failed", e),
      );
    });
  }
}
