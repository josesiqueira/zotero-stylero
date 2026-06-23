import { getPref, setPref } from "../utils/prefs";

/**
 * Feature 19 + whole-row enhancement - Read / Unread emphasis.
 *
 * Mirrors Zotero's feed read state (item.isRead): unread feed items are rendered
 * bold, read items normal. The USER ENHANCEMENT bolds EVERY cell in an unread row,
 * not just the title, by registering a hidden zero-width marker column whose
 * renderCell tags the owning row (and the cell itself) with `data-stylero-unread`.
 * A CSS `:has()` rule then bolds all cells of that row, with a JS class-toggle
 * fallback on the `.row` element for robustness against DOM changes.
 *
 * With `readState.boldAllItems` on, the emphasis is extended to all regular items:
 * an item is treated as unread (bold) unless explicitly marked read. Regular items
 * have no native read state, so "read" is tracked in a minimal JSON side-store of
 * item keys (writes guarded by item.library.editable). This is intentionally NOT
 * synced native state; it defaults off.
 */

export class ReadStateFactory {
  static readonly DATA_KEY = "stylero-readstate";

  private static registered = false;
  private static notifierID: string | null = null;
  /** Exact key returned by registerColumns; used for a guarded unregister. */
  private static columnKey: string | false | null = null;

  /** Per-window injected <link> nodes. */
  private static readonly injectedLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();

  /** In-memory cache of the regular-item "read" side-store (Set of item keys). */
  private static readSet: Set<string> | null = null;

  /**
   * One-time global registration. No-op when `readState.enable` is false (no marker
   * column, no observer, no stylesheet).
   */
  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("readState.enable")) {
      return;
    }

    this.columnKey = await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: ReadStateFactory.DATA_KEY,
      label: "Read state",
      // Narrow unread indicator column. Shown by default (hidden: false) so its
      // renderCell paints on every row, which is what drives the :has() whole-row
      // bold; users can still hide it via the column picker.
      hidden: false,
      showInColumnPicker: true,
      fixedWidth: true,
      width: "28",
      dataProvider: (item: Zotero.Item) => {
        return ReadStateFactory.isUnread(item) ? "1" : "0";
      },
      renderCell: (
        index: number,
        data: string,
        column: any,
        isFirstColumn: boolean,
        doc: Document,
      ) => {
        return ReadStateFactory.renderMarkerCell(data, column, doc);
      },
    } as any);

    // Live repaint on read-state change (RSS feed toggles + our own toggles).
    const callback = {
      notify: (
        event: string,
        type: string,
        ids: Array<number | string>,
        _extraData: { [key: string]: any },
      ) => {
        if (!addon?.data.alive) {
          return;
        }
        ReadStateFactory.onReadStateNotify(event, type, ids);
      },
    };
    try {
      this.notifierID = Zotero.Notifier.registerObserver(
        callback as any,
        ["item", "feedItem"],
        "stylero-readstate",
      );
    } catch (e) {
      // Some builds may not expose the 'feedItem' type; fall back to 'item' only.
      try {
        this.notifierID = Zotero.Notifier.registerObserver(
          callback as any,
          ["item"],
          "stylero-readstate",
        );
      } catch (e2) {
        ztoolkit.log("[stylero] readState notifier registration failed", e2);
      }
    }

    this.registered = true;
  }

  /** Per-window CSS injection. */
  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("readState.enable")) {
      return;
    }
    const doc = win.document;
    if (!doc) {
      return;
    }
    if (this.injectedLinks.has(win)) {
      return;
    }
    const href = `chrome://${addon.data.config.addonRef}/content/readState.css`;
    const link = ztoolkit.UI.createElement(doc, "link", {
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href,
      },
      attributes: {
        "data-stylero": "readState",
      },
    }) as HTMLLinkElement;
    doc.documentElement?.appendChild(link);
    this.injectedLinks.set(win, link);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const link = this.injectedLinks.get(win);
    if (link) {
      link.remove();
      this.injectedLinks.delete(win);
    }
  }

  /** Unregisters the notifier observer and the column. */
  static unregister(): void {
    if (this.notifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.notifierID);
      } catch (e) {
        ztoolkit.log("[stylero] readState notifier unregister failed", e);
      }
      this.notifierID = null;
    }
    if (this.registered) {
      try {
        // Use the exact key returned by registerColumns; removing an unknown
        // option throws ("Can't remove unknown option").
        const key = this.columnKey || ReadStateFactory.DATA_KEY;
        Zotero.ItemTreeManager.unregisterColumns(key as string);
      } catch (e) {
        ztoolkit.log("[stylero] readState column unregister failed", e);
      }
      this.columnKey = null;
      this.registered = false;
    }
  }

  // --------------------------------------------------------------------------
  // Read-state logic
  // --------------------------------------------------------------------------

  /**
   * Decide whether an item should carry the unread (bold) emphasis.
   * - Feed items: native item.isRead (false => unread => bold).
   * - Regular items: only when boldAllItems is on; treated as unread unless explicitly
   *   marked read in the side-store.
   */
  private static isUnread(item: Zotero.Item): boolean {
    if (!item) {
      return false;
    }
    // Native feed read state.
    if ((item as any).isFeedItem) {
      try {
        return (item as any).isRead === false;
      } catch (e) {
        return false;
      }
    }
    // Regular items only when the extend-to-all pref is on.
    if (getPref("readState.boldAllItems")) {
      if (typeof item.isRegularItem === "function" && !item.isRegularItem()) {
        return false;
      }
      const key = (item as any).key as string | undefined;
      if (!key) {
        return false;
      }
      return !ReadStateFactory.getReadSet().has(key);
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Marker cell
  // --------------------------------------------------------------------------

  private static renderMarkerCell(
    data: string,
    column: any,
    doc: Document,
  ): HTMLElement {
    const span = doc.createElement("span");
    span.className = `cell ${column?.className ?? ""} stylero-readstate-cell`;

    // The dataProvider already returns '1' for unread and '0' for read; use it
    // directly rather than re-resolving the item via a fragile index/getRow lookup.
    const unread = data === "1";
    const wholeRow = !!getPref("readState.wholeRow");

    // Idempotent attribute toggles (renderCell may run on recycled DOM).
    span.toggleAttribute("data-stylero-unread", unread);
    span.toggleAttribute("data-stylero-wholerow", unread && wholeRow);

    // Centered dot glyph for unread, empty for read.
    span.textContent = unread ? "●" : "";

    // Primary mechanism: the :has() CSS rule keys off this cell's attribute.
    // Fallback: toggle row-level classes synchronously (no rAF, which would
    // accumulate closures on every cell paint) for robustness against Zotero
    // changing the row/cell nesting.
    const row = span.closest(".row");
    if (row) {
      row.classList.toggle("stylero-unread", unread);
      row.classList.toggle("stylero-unread-wholerow", unread && wholeRow);
    }

    return span;
  }

  // --------------------------------------------------------------------------
  // Notifier handling -> targeted repaint
  // --------------------------------------------------------------------------

  private static onReadStateNotify(
    event: string,
    _type: string,
    ids: Array<number | string>,
  ): void {
    if (event !== "modify" && event !== "add" && event !== "refresh") {
      return;
    }
    const numericIds = new Set<number>();
    for (const id of ids) {
      const n = typeof id === "number" ? id : parseInt(String(id), 10);
      if (Number.isFinite(n)) {
        numericIds.add(n);
      }
    }
    for (const win of Zotero.getMainWindows()) {
      const pane = (win as any).ZoteroPane;
      const view = pane?.itemsView;
      if (!view || typeof view.getRow !== "function") {
        continue;
      }
      // Invalidate only the affected rows where possible.
      let invalidatedAny = false;
      const rowCount: number =
        typeof view.rowCount === "number"
          ? view.rowCount
          : view._rows?.length || 0;
      if (rowCount > 0 && numericIds.size > 0) {
        for (let i = 0; i < rowCount; i++) {
          const ref = view.getRow(i)?.ref as Zotero.Item | undefined;
          if (ref && numericIds.has(ref.id)) {
            try {
              view.tree?.invalidateRow?.(i);
              invalidatedAny = true;
            } catch (e) {
              // ignore per-row failure
            }
          }
        }
      }
      if (!invalidatedAny) {
        try {
          view.tree?.invalidate?.();
        } catch (e) {
          // ignore
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Public-ish helpers for marking regular items read/unread (boldAllItems mode)
  // --------------------------------------------------------------------------

  /**
   * Mark a regular item as read (boldAllItems mode). Guarded by library.editable.
   * No-op for feed items (use native read-state APIs for those).
   */
  static markRead(item: Zotero.Item, read: boolean): void {
    if (!item || (item as any).isFeedItem) {
      return;
    }
    const lib = (item as any).library;
    if (lib && lib.editable === false) {
      return;
    }
    const key = (item as any).key as string | undefined;
    if (!key) {
      return;
    }
    const set = ReadStateFactory.getReadSet();
    if (read) {
      set.add(key);
    } else {
      set.delete(key);
    }
    ReadStateFactory.persistReadSet();
  }

  // --------------------------------------------------------------------------
  // Side-store for regular-item read flags (pref-backed JSON, minimal)
  // --------------------------------------------------------------------------

  private static getReadSet(): Set<string> {
    if (this.readSet) {
      return this.readSet;
    }
    const raw = String(getPref("readState.readKeys") || "");
    const set = new Set<string>();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const k of parsed) {
            if (typeof k === "string") {
              set.add(k);
            }
          }
        }
      } catch (e) {
        // corrupt store -> start empty
      }
    }
    this.readSet = set;
    return set;
  }

  private static persistReadSet(): void {
    if (!this.readSet) {
      return;
    }
    try {
      setPref(
        "readState.readKeys" as any,
        JSON.stringify(Array.from(this.readSet)),
      );
    } catch (e) {
      ztoolkit.log("[stylero] readState persist failed", e);
    }
  }

}

export const PREFS: Record<string, string | number | boolean> = {
  "readState.enable": true,
  "readState.boldAllItems": false,
  "readState.wholeRow": true,
  // Internal side-store for regular-item read flags (JSON array of item keys).
  "readState.readKeys": "",
};
