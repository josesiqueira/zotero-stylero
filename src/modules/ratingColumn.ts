import { getPref } from "../utils/prefs";
import { ItemRowDecorator, RowDecorator } from "./itemRowDecorator";

/**
 * Rating column - tag-driven, interactive.
 *
 * The rating is a single all-stars tag on the item (`⭐` = 1 ... `⭐⭐⭐⭐⭐` = 5);
 * the tag IS the source of truth (no Extra field, no side-store). The column shows
 * a normalized 5-slot display (★ filled / ☆ empty) and is sortable by star count.
 *
 * Interactive: clicking the Nth star rewrites the star tag to N stars; clicking the
 * star equal to the current rating clears it. All edits go through the item's tags
 * via saveTx, so the column always reflects reality.
 *
 * It also registers a row decorator that strips the star tag's swatch from the
 * title cell (when `ratingColumn.hideFromTitle` is on), so the rating lives only
 * in this column.
 */

const DATA_KEY = "stylero-rating";
const FILLED = "★"; // ★
const EMPTY = "☆"; // ☆
const STAR = "⭐"; // ⭐
const STAR_TAG_RE = /^⭐+$/u; // a tag made only of ⭐

export class RatingColumnFactory {
  private static columnKey: string | false | null = null;
  private static registered = false;
  private static readonly injectedLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();
  private static readonly clickHandlers = new WeakMap<
    _ZoteroTypes.MainWindow,
    EventListener
  >();

  /** Strips the all-stars tag swatch from the title cell (pref-gated). */
  private static readonly titleDecorator: RowDecorator = (_view, _i, node) => {
    if (!node || typeof node.querySelector !== "function") {
      return;
    }
    if (!getPref("ratingColumn.hideFromTitle")) {
      return;
    }
    const primary = node.querySelector(".cell.primary") || node;
    primary
      .querySelectorAll(".tag-swatch")
      .forEach((sw: Element) => {
        const txt = (sw.textContent || "").replace(/[️\s]/g, "");
        if (txt && STAR_TAG_RE.test(txt)) {
          sw.remove();
        }
      });
  };

  static async register(): Promise<void> {
    if (this.registered || !getPref("ratingColumn.enable")) {
      return;
    }
    this.columnKey = await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: DATA_KEY,
      label: "Rating",
      hidden: false,
      showInColumnPicker: true,
      fixedWidth: true,
      width: "84",
      dataProvider: (item: Zotero.Item) =>
        String(RatingColumnFactory.getRating(item)),
      renderCell: (
        index: number,
        data: string,
        column: any,
        _isFirst: boolean,
        doc: Document,
      ) => RatingColumnFactory.renderCell(index, data, column, doc),
    } as any);

    ItemRowDecorator.add(this.titleDecorator);
    this.registered = true;
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("ratingColumn.enable")) {
      return;
    }
    const doc = win.document;
    if (!doc) {
      return;
    }
    if (!this.injectedLinks.has(win)) {
      const link = ztoolkit.UI.createElement(doc, "link", {
        properties: {
          type: "text/css",
          rel: "stylesheet",
          href: `chrome://${addon.data.config.addonRef}/content/ratingColumn.css`,
        },
      }) as HTMLLinkElement;
      doc.documentElement?.appendChild(link);
      this.injectedLinks.set(win, link);
    }
    // One delegated click listener per window (no per-cell listeners).
    if (!this.clickHandlers.has(win)) {
      const handler = ((ev: Event) => {
        const target = ev.target as HTMLElement;
        const star = target?.closest?.(".stylero-rating-star") as HTMLElement | null;
        if (!star) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const cell = star.closest(".stylero-rating-cell") as HTMLElement | null;
        const idx = cell?.getAttribute("data-stylero-row-index");
        const value = parseInt(star.getAttribute("data-rating") || "0", 10);
        if (idx == null || !Number.isFinite(value)) {
          return;
        }
        const item = RatingColumnFactory.itemAtRow(win, parseInt(idx, 10));
        if (item) {
          void RatingColumnFactory.setRating(item, value);
        }
      }) as EventListener;
      const container =
        doc.getElementById("item-tree-main-default") || doc.documentElement;
      container?.addEventListener("click", handler, true);
      this.clickHandlers.set(win, handler);
    }
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const link = this.injectedLinks.get(win);
    if (link) {
      link.remove();
      this.injectedLinks.delete(win);
    }
    const handler = this.clickHandlers.get(win);
    if (handler) {
      const container =
        win.document?.getElementById("item-tree-main-default") ||
        win.document?.documentElement;
      container?.removeEventListener("click", handler, true);
      this.clickHandlers.delete(win);
    }
  }

  static unregister(): void {
    ItemRowDecorator.remove(this.titleDecorator);
    if (this.registered) {
      try {
        Zotero.ItemTreeManager.unregisterColumns(
          (this.columnKey as string) || DATA_KEY,
        );
      } catch (e) {
        ztoolkit.log("[stylero] rating column unregister failed", e);
      }
      this.columnKey = null;
      this.registered = false;
    }
  }

  // --- rating logic (tag-based) ---

  private static maxStars(): number {
    const m = Number(getPref("ratingColumn.max")) || 5;
    return Math.min(Math.max(m, 1), 9);
  }

  /** Count of ⭐ in the item's all-stars tag, capped at max. 0 if none. */
  private static getRating(item: Zotero.Item): number {
    try {
      for (const t of item.getTags() || []) {
        const clean = (t.tag || "").replace(/[️\s]/g, "");
        if (clean && STAR_TAG_RE.test(clean)) {
          return Math.min([...clean].length, this.maxStars());
        }
      }
    } catch (e) {
      // ignore
    }
    return 0;
  }

  /** Rewrite the star tag to `value` stars (0 clears). Toggles off if unchanged. */
  private static async setRating(
    item: Zotero.Item,
    value: number,
  ): Promise<void> {
    try {
      const lib = (item as any).library;
      if (lib && lib.editable === false) {
        return;
      }
      const current = this.getRating(item);
      let target = Math.min(Math.max(value, 0), this.maxStars());
      if (target === current) {
        target = 0; // clicking the current rating clears it
      }
      // Remove any existing all-stars tag(s).
      for (const t of item.getTags() || []) {
        const clean = (t.tag || "").replace(/[️\s]/g, "");
        if (clean && STAR_TAG_RE.test(clean)) {
          item.removeTag(t.tag);
        }
      }
      if (target > 0) {
        item.addTag(STAR.repeat(target));
      }
      await item.saveTx();
    } catch (e) {
      ztoolkit.log("[stylero] setRating failed", e);
    }
  }

  private static renderCell(
    index: number,
    data: string,
    column: any,
    doc: Document,
  ): HTMLElement {
    const rating = parseInt(data || "0", 10) || 0;
    const max = this.maxStars();
    const cell = doc.createElement("span");
    cell.className = `cell ${column?.className ?? ""} stylero-rating-cell`;
    cell.setAttribute("data-stylero-row-index", String(index));
    for (let i = 1; i <= max; i++) {
      const star = doc.createElement("span");
      star.className = "stylero-rating-star";
      star.setAttribute("data-rating", String(i));
      star.textContent = i <= rating ? FILLED : EMPTY;
      cell.appendChild(star);
    }
    return cell;
  }

  private static itemAtRow(
    win: _ZoteroTypes.MainWindow,
    index: number,
  ): Zotero.Item | undefined {
    try {
      const view = (win as any).ZoteroPane?.itemsView;
      const ref = view?.getRow?.(index)?.ref;
      return ref && ref.isRegularItem ? ref : ref;
    } catch (e) {
      return undefined;
    }
  }
}

export const PREFS: Record<string, string | number | boolean> = {
  "ratingColumn.enable": true,
  "ratingColumn.max": 5,
  "ratingColumn.hideFromTitle": true,
};
