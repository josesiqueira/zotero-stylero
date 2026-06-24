import { getPref, setPref } from "../utils/prefs";

/**
 * Feature 19 + whole-row enhancement - Read / Unread emphasis.
 *
 * Mirrors Zotero's feed read state (item.isRead): unread feed items are rendered
 * bold, read items normal. The USER ENHANCEMENT bolds EVERY cell in an unread row.
 *
 * Implementation: instead of a dedicated column (which Zotero pins as an awkward
 * sliver at the far-right edge), we patch the item tree's per-row renderer
 * (`itemsView.tree.props.renderItem`, verified wrappable on Zotero 9.0.4) and
 * toggle `.stylero-unread` / `.stylero-unread-wholerow` classes on the `.row`
 * element. A CSS rule then bolds the primary cell or the whole row. No column,
 * nothing hidden off-screen.
 *
 * With `readState.boldAllItems` on, the emphasis extends to all regular items: an
 * item is treated as unread (bold) unless explicitly marked read. Regular items
 * have no native read state, so "read" is tracked in a minimal JSON side-store of
 * item keys (writes guarded by item.library.editable). Defaults off.
 */

const PATCH_FLAG = "__styleroReadStatePatched";

type RenderItemFn = ((...args: any[]) => any) & { [PATCH_FLAG]?: boolean };

interface ItemsViewLike {
  rowCount?: number;
  getRow?: (index: number) => { ref?: any } | undefined;
  _renderItem?: RenderItemFn;
  tree?: {
    props?: { renderItem?: RenderItemFn };
    invalidate?: () => void;
    invalidateRange?: (start: number, end: number) => void;
  };
}

export class ReadStateFactory {
  private static registered = false;
  private static notifierID: string | null = null;

  /** Per-window injected <link> nodes. */
  private static readonly injectedLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();

  /** Per-window patch record, for restoration on teardown. */
  private static readonly originals = new WeakMap<
    _ZoteroTypes.MainWindow,
    { view: ItemsViewLike; original: RenderItemFn; props: any }
  >();

  /** In-memory cache of the regular-item "read" side-store (Set of item keys). */
  private static readSet: Set<string> | null = null;

  /** One-time global registration: the read-state-change notifier. */
  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("readState.enable")) {
      return;
    }

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
    this.registered = true;
  }

  /** Per-window: inject CSS and patch the item-tree row renderer. */
  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("readState.enable")) {
      return;
    }
    this.injectCss(win);
    this.ensurePatchedWithRetry(win);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    this.unpatch(win);
    const link = this.injectedLinks.get(win);
    if (link) {
      link.remove();
      this.injectedLinks.delete(win);
    }
    // Drop any lingering classes, then repaint with the original renderer.
    try {
      win.document
        ?.querySelectorAll(".row.stylero-unread, .row.stylero-unread-wholerow")
        .forEach((r: Element) => {
          r.classList.remove("stylero-unread", "stylero-unread-wholerow");
        });
    } catch (e) {
      ztoolkit.log("[stylero] readState class cleanup failed", e);
    }
  }

  static unregister(): void {
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

  // --------------------------------------------------------------------------
  // Item-tree row-renderer patch
  // --------------------------------------------------------------------------

  private static getItemsView(
    win: _ZoteroTypes.MainWindow,
  ): ItemsViewLike | undefined {
    try {
      return (win as any).ZoteroPane?.itemsView as ItemsViewLike | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Patch the row renderer if not already patched. Returns true when our wrapper
   * is in place (newly applied or already present from this/a prior generation),
   * false when the item tree is not ready yet. React may recreate props, so this
   * is also used to re-assert the patch.
   */
  private static ensurePatched(win: _ZoteroTypes.MainWindow): boolean {
    const view = this.getItemsView(win);
    const props = view?.tree?.props;
    // The instance method `_renderItem` is the durable anchor: on every ItemTree
    // re-render, `props.renderItem` is re-assigned from `this._renderItem`, so a
    // props-only wrap is dropped. We wrap the instance method (future renders)
    // AND the current props.renderItem (this frame).
    if (
      !view ||
      !props ||
      typeof view._renderItem !== "function" ||
      typeof props.renderItem !== "function"
    ) {
      return false; // tree not ready yet
    }
    if ((view._renderItem as RenderItemFn)[PATCH_FLAG]) {
      // Already wrapped at the instance level; make sure the current props frame
      // points at it too (it will after the next render regardless).
      if (!(props.renderItem as RenderItemFn)[PATCH_FLAG]) {
        props.renderItem = view._renderItem;
      }
      return true;
    }

    const original = view._renderItem as RenderItemFn;
    const wrapper = function (this: any, ...args: any[]) {
      const node = original.apply(this, args);
      try {
        ReadStateFactory.decorateRow(view, args[0] as number, node);
      } catch (e) {
        ztoolkit.log("[stylero] readState decorateRow failed", e);
      }
      return node;
    } as RenderItemFn;
    wrapper[PATCH_FLAG] = true;

    view._renderItem = wrapper;
    props.renderItem = wrapper;
    this.originals.set(win, { view, original, props });
    return true;
  }

  /**
   * Patch now; if the item tree is not yet constructed (startup race), retry a
   * few times before giving up.
   */
  private static ensurePatchedWithRetry(
    win: _ZoteroTypes.MainWindow,
    attempts = 6,
  ): void {
    if (this.ensurePatched(win)) {
      this.repaint(win);
      return;
    }
    if (attempts <= 0) {
      return;
    }
    try {
      win.setTimeout(() => {
        if (addon?.data.alive) {
          this.ensurePatchedWithRetry(win, attempts - 1);
        }
      }, 300);
    } catch (e) {
      ztoolkit.log("[stylero] readState patch retry scheduling failed", e);
    }
  }

  private static prefObserverIDs: symbol[] = [];

  private static registerPrefObserver(): void {
    if (this.prefObserverIDs.length) {
      return;
    }
    const prefix = addon.data.config.prefsPrefix;
    const handler = () => {
      if (!addon?.data.alive) {
        return;
      }
      for (const win of Zotero.getMainWindows()) {
        this.ensurePatched(win as _ZoteroTypes.MainWindow);
        this.repaint(win as _ZoteroTypes.MainWindow);
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

  private static unpatch(win: _ZoteroTypes.MainWindow): void {
    const saved = this.originals.get(win);
    if (!saved) {
      return;
    }
    try {
      if ((saved.view._renderItem as RenderItemFn)?.[PATCH_FLAG]) {
        saved.view._renderItem = saved.original;
      }
      if (saved.props && (saved.props.renderItem as RenderItemFn)?.[PATCH_FLAG]) {
        saved.props.renderItem = saved.original;
      }
    } catch (e) {
      ztoolkit.log("[stylero] readState unpatch failed", e);
    }
    this.originals.delete(win);
    this.repaint(win);
  }

  private static decorateRow(
    view: ItemsViewLike,
    index: number,
    node: any,
  ): void {
    if (!node || !node.classList || typeof view.getRow !== "function") {
      return;
    }
    const item = view.getRow(index)?.ref as Zotero.Item | undefined;
    const unread = item ? ReadStateFactory.isUnread(item) : false;
    const wholeRow = unread && !!getPref("readState.wholeRow");
    // Idempotent: recycled rows get corrected on every paint.
    node.classList.toggle("stylero-unread", unread);
    node.classList.toggle("stylero-unread-wholerow", wholeRow);
  }

  private static repaint(win: _ZoteroTypes.MainWindow): void {
    const view = this.getItemsView(win);
    const tree = view?.tree;
    const rowCount = typeof view?.rowCount === "number" ? view.rowCount : 0;
    try {
      // invalidateRange re-runs renderItem (plain invalidate only repaints DOM).
      if (tree && typeof tree.invalidateRange === "function" && rowCount > 0) {
        tree.invalidateRange(0, rowCount - 1);
      } else if (tree && typeof tree.invalidate === "function") {
        tree.invalidate();
      }
    } catch (e) {
      ztoolkit.log("[stylero] readState repaint failed", e);
    }
  }

  // --------------------------------------------------------------------------
  // Notifier handling -> re-assert patch + repaint
  // --------------------------------------------------------------------------

  private static onReadStateNotify(
    event: string,
    _type: string,
    _ids: Array<number | string>,
  ): void {
    if (event !== "modify" && event !== "add" && event !== "refresh") {
      return;
    }
    for (const win of Zotero.getMainWindows()) {
      // Re-assert in case React recreated the tree props since last paint.
      this.ensurePatched(win as _ZoteroTypes.MainWindow);
      this.repaint(win as _ZoteroTypes.MainWindow);
    }
  }

  // --------------------------------------------------------------------------
  // Read-state logic
  // --------------------------------------------------------------------------

  /**
   * Whether an item should carry the unread (bold) emphasis.
   * - Feed items: native item.isRead (false => unread => bold).
   * - Regular items: only when boldAllItems is on; unread unless explicitly marked
   *   read in the side-store.
   */
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

  // --------------------------------------------------------------------------
  // Marking regular items read/unread (boldAllItems mode)
  // --------------------------------------------------------------------------

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
