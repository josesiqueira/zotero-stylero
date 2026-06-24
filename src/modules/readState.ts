import { getPref, setPref } from "../utils/prefs";
import { ItemRowDecorator, RowDecorator } from "./itemRowDecorator";

/**
 * Feature 19 + whole-row enhancement - Read / Unread emphasis.
 *
 * Unread feed items (item.isRead === false) are rendered bold; with
 * `readState.boldAllItems` on, all regular items are bold unless marked read in a
 * minimal JSON side-store of item keys. The bold is applied by toggling
 * `.stylero-unread` / `.stylero-unread-wholerow` classes on the row via the shared
 * ItemRowDecorator (no column, nothing pinned to the far-right edge); a CSS rule
 * then bolds the primary cell or the whole row.
 */

export class ReadStateFactory {
  private static registered = false;
  private static notifierID: string | null = null;
  private static prefObserverIDs: symbol[] = [];
  private static readSet: Set<string> | null = null;

  /** Stable decorator reference so we can add/remove it. */
  private static readonly decorator: RowDecorator = (view, index, node) => {
    if (!node || !node.classList || typeof view.getRow !== "function") {
      return;
    }
    const item = view.getRow(index)?.ref as Zotero.Item | undefined;
    const unread = item ? ReadStateFactory.isUnread(item) : false;
    const wholeRow = unread && !!getPref("readState.wholeRow");
    node.classList.toggle("stylero-unread", unread);
    node.classList.toggle("stylero-unread-wholerow", wholeRow);
  };

  private static readonly injectedLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();

  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("readState.enable")) {
      return;
    }

    const callback = {
      notify: (event: string) => {
        if (!addon?.data.alive) {
          return;
        }
        if (event === "modify" || event === "add" || event === "refresh") {
          ItemRowDecorator.repaintAll();
        }
      },
    };
    try {
      this.notifierID = Zotero.Notifier.registerObserver(
        callback as any,
        ["item", "feedItem"],
        "stylero-readstate",
      );
    } catch (e) {
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

    this.registerPrefObserver();
    ItemRowDecorator.add(this.decorator);
    this.registered = true;
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("readState.enable")) {
      return;
    }
    this.injectCss(win);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const link = this.injectedLinks.get(win);
    if (link) {
      link.remove();
      this.injectedLinks.delete(win);
    }
    try {
      win.document
        ?.querySelectorAll(".row.stylero-unread, .row.stylero-unread-wholerow")
        .forEach((r: Element) =>
          r.classList.remove("stylero-unread", "stylero-unread-wholerow"),
        );
    } catch (e) {
      ztoolkit.log("[stylero] readState class cleanup failed", e);
    }
  }

  static unregister(): void {
    ItemRowDecorator.remove(this.decorator);
    if (this.notifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.notifierID);
      } catch (e) {
        ztoolkit.log("[stylero] readState notifier unregister failed", e);
      }
      this.notifierID = null;
    }
    for (const id of this.prefObserverIDs) {
      try {
        Zotero.Prefs.unregisterObserver(id);
      } catch (e) {
        ztoolkit.log("[stylero] readState pref observer unregister failed", e);
      }
    }
    this.prefObserverIDs = [];
    this.registered = false;
  }

  private static registerPrefObserver(): void {
    if (this.prefObserverIDs.length) {
      return;
    }
    const prefix = addon.data.config.prefsPrefix;
    const handler = () => {
      if (addon?.data.alive) {
        ItemRowDecorator.repaintAll();
      }
    };
    for (const key of [
      `${prefix}.readState.enable`,
      `${prefix}.readState.boldAllItems`,
      `${prefix}.readState.wholeRow`,
    ]) {
      try {
        this.prefObserverIDs.push(
          Zotero.Prefs.registerObserver(key, handler, true),
        );
      } catch (e) {
        ztoolkit.log("[stylero] readState pref observer registration failed", e);
      }
    }
  }

  private static isUnread(item: Zotero.Item): boolean {
    if (!item) {
      return false;
    }
    if ((item as any).isFeedItem) {
      try {
        return (item as any).isRead === false;
      } catch (e) {
        return false;
      }
    }
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

  private static injectCss(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc || this.injectedLinks.has(win)) {
      return;
    }
    const href = `chrome://${addon.data.config.addonRef}/content/readState.css`;
    const link = ztoolkit.UI.createElement(doc, "link", {
      properties: { type: "text/css", rel: "stylesheet", href },
      attributes: { "data-stylero": "readState" },
    }) as HTMLLinkElement;
    doc.documentElement?.appendChild(link);
    this.injectedLinks.set(win, link);
  }
}

export const PREFS: Record<string, string | number | boolean> = {
  "readState.enable": true,
  "readState.boldAllItems": false,
  "readState.wholeRow": true,
  // Internal side-store for regular-item read flags (JSON array of item keys).
  "readState.readKeys": "",
};
