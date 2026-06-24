import { getPref } from "../utils/prefs";

/**
 * Unread column.
 *
 * Shows a dot when the item carries the `.unread` tag, empty otherwise. Purely
 * tag-driven (the tag is the source of truth); the column reflects it and updates
 * automatically when the tag is added/removed (Zotero re-renders the row on item
 * modify). Sortable: dataProvider returns "1"/"0".
 */

const DATA_KEY = "stylero-unread";

export class UnreadColumnFactory {
  private static columnKey: string | false | null = null;
  private static registered = false;
  private static readonly injectedLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();

  static async register(): Promise<void> {
    if (this.registered || !getPref("unreadColumn.enable")) {
      return;
    }
    const tag = String(getPref("unreadColumn.tag") || ".unread");
    this.columnKey = await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: DATA_KEY,
      label: "Unread",
      hidden: false,
      showInColumnPicker: true,
      fixedWidth: true,
      width: "40",
      dataProvider: (item: Zotero.Item) =>
        UnreadColumnFactory.hasTag(item, tag) ? "1" : "0",
      renderCell: (
        _index: number,
        data: string,
        column: any,
        _isFirst: boolean,
        doc: Document,
      ) => {
        const span = doc.createElement("span");
        span.className = `cell ${column?.className ?? ""} stylero-unread-cell`;
        span.textContent = data === "1" ? "●" : ""; // ●
        return span;
      },
    } as any);
    this.registered = true;
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("unreadColumn.enable")) {
      return;
    }
    const doc = win.document;
    if (!doc || this.injectedLinks.has(win)) {
      return;
    }
    const link = ztoolkit.UI.createElement(doc, "link", {
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/unreadColumn.css`,
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

  static unregister(): void {
    if (this.registered) {
      try {
        Zotero.ItemTreeManager.unregisterColumns(
          (this.columnKey as string) || DATA_KEY,
        );
      } catch (e) {
        ztoolkit.log("[stylero] unread column unregister failed", e);
      }
      this.columnKey = null;
      this.registered = false;
    }
  }

  private static hasTag(item: Zotero.Item, tag: string): boolean {
    try {
      return (item.getTags() || []).some((t) => t.tag === tag);
    } catch (e) {
      return false;
    }
  }
}

export const PREFS: Record<string, string | number | boolean> = {
  "unreadColumn.enable": true,
  "unreadColumn.tag": ".unread",
};
