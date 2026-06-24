import { getPref, setPref } from "../utils/prefs";

/**
 * Bucket C - Feature 12: Collection item-count badges.
 *
 * Non-destructively decorates rows in the collection tree with a muted pill
 * showing how many items they hold.
 *
 * - Real collections use four counting modes (child / offspring / both /
 *   bothReverse), computed synchronously from getChildItems.
 * - Every other countable row (My Library + group library roots, saved searches,
 *   My Publications, Duplicate Items, Unfiled Items, Bin/Trash, Recently Read,
 *   etc.) shows a single count of the items it contains, computed asynchronously
 *   via the row's own getItems() and cached by the row's stable string id.
 * - Headers ("Group Libraries") and separators get no badge.
 *
 * Implementation: wrap the CollectionTree instance's per-row `renderItem`
 * function (verified on Zotero 9.0.4: it returns a `div.row` and is held both on
 * the instance and in `tree.props.renderItem`). The wrapper is idempotent and
 * reversible. A Notifier observer clears the caches and repaints on changes.
 *
 * A "Show item counts" checkbox in the View menu and a preferences toggle both
 * flip `collectionCounts.enable`; a pref observer repaints live and keeps the
 * menu checkbox in sync. The tree is always patched (cheap when disabled) so the
 * toggle works without a reload; drawing is gated on the pref in decorateRow.
 */

export const PREFS: Record<string, string | number | boolean> = {
  "collectionCounts.enable": true,
  "collectionCounts.mode": "child",
};

const BADGE_CLASS = "stylero-collection-count";
const PATCH_FLAG = "__styleroCountsPatched";
const ORIGINAL_KEY = "__styleroCountsOriginal";
const TOGGLE_ID = "stylero-counts-toggle";
const ENABLE_PREF = "collectionCounts.enable";

type CountMode = "child" | "offspring" | "both" | "bothReverse";

interface PatchableTree {
  rowCount?: number;
  renderItem?: ((...args: any[]) => any) & { [PATCH_FLAG]?: boolean };
  [ORIGINAL_KEY]?: (...args: any[]) => any;
  tree?: {
    props?: { renderItem?: (...args: any[]) => any };
    invalidate?: () => void;
    invalidateRange?: (start: number, end: number) => void;
  };
  getRow?: (index: number) => any;
  refresh?: () => void;
}

export class CollectionCountsFactory {
  private static notifierID: string | null = null;
  /** Per-collection-id cached counts; invalidated on notify. */
  private static cache = new Map<number, { child: number; offspring: number }>();
  /** Per-row-id cached counts for non-collection rows (library/search/...). */
  private static genericCache = new Map<string, number>();
  /** Row ids whose async count is in flight, so we compute each only once. */
  private static pendingGeneric = new Set<string>();
  /** Windows we have patched, so unregister can restore them. */
  private static patchedWindows = new Set<_ZoteroTypes.MainWindow>();
  /** Debounce timer for cache clear + tree invalidation on notify. */
  private static invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce timer for repaints triggered by async generic counts resolving. */
  private static genericRepaintTimer: ReturnType<typeof setTimeout> | null =
    null;
  private static viewMenuRegistered = false;
  private static prefObserverIDs: symbol[] = [];

  // ---- global registration ----

  static register(): void {
    // Always wire up (even when disabled) so the View-menu toggle works live;
    // drawing is gated on the pref inside decorateRow.
    if (!this.notifierID) {
      const observer = {
        notify: (
          _event: string,
          _type: string,
          _ids: Array<string | number>,
          _extraData: { [key: string]: any },
        ) => {
          if (!addon?.data.alive) {
            return;
          }
          if (this.invalidateTimer !== null) {
            clearTimeout(this.invalidateTimer);
          }
          this.invalidateTimer = setTimeout(() => {
            this.invalidateTimer = null;
            if (!addon?.data.alive) {
              return;
            }
            this.cache.clear();
            this.genericCache.clear();
            this.invalidateAllWindows();
          }, 250);
        },
      };
      this.notifierID = Zotero.Notifier.registerObserver(observer, [
        "collection",
        "item",
        "collection-item",
        "search",
      ]);
    }

    this.registerViewMenuToggle();
    this.registerPrefObserver();
  }

  static unregister(): void {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    if (this.invalidateTimer !== null) {
      clearTimeout(this.invalidateTimer);
      this.invalidateTimer = null;
    }
    if (this.genericRepaintTimer !== null) {
      clearTimeout(this.genericRepaintTimer);
      this.genericRepaintTimer = null;
    }
    for (const id of this.prefObserverIDs) {
      try {
        Zotero.Prefs.unregisterObserver(id);
      } catch (e) {
        ztoolkit.log("[Stylero] counts pref observer unregister failed", e);
      }
    }
    this.prefObserverIDs = [];
    this.cache.clear();
    this.genericCache.clear();
    this.pendingGeneric.clear();
  }

  // ---- per-window patching ----

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    this.injectCss(win);

    const tree = this.getCollectionTree(win);
    if (tree) {
      try {
        this.patchTree(tree);
        this.patchedWindows.add(win);
        this.repaint(tree);
      } catch (e) {
        ztoolkit.log("[Stylero] collectionCounts patch failed", e);
      }
    }
    // Ensure this window's View-menu checkbox reflects the current pref.
    this.syncToggleUI(win);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const tree = this.getCollectionTree(win) as PatchableTree | undefined;
    if (tree) {
      this.unpatchTree(tree);
      this.removeBadges(win);
      this.repaint(tree);
    }
    win.document.getElementById("stylero-collectionCounts-css")?.remove();
    this.patchedWindows.delete(win);
  }

  // ---- View-menu checkbox + pref observer ----

  private static registerViewMenuToggle(): void {
    if (this.viewMenuRegistered) {
      return;
    }
    this.viewMenuRegistered = true;
    try {
      ztoolkit.Menu.register("menuView", {
        tag: "menuitem",
        id: TOGGLE_ID,
        label: "Show item counts",
        commandListener: () => {
          // Flip the pref; the pref observer repaints and re-syncs the checkbox.
          setPref(ENABLE_PREF, !getPref(ENABLE_PREF));
        },
      });
    } catch (e) {
      ztoolkit.log("[Stylero] view-menu toggle registration failed", e);
    }
  }

  private static registerPrefObserver(): void {
    if (this.prefObserverIDs.length) {
      return;
    }
    const prefix = addon.data.config.prefsPrefix;
    // Zotero pref observers are exact-name match, so observe each concrete key
    // (the full path with global=true), not the parent branch.
    const handler = () => {
      if (!addon?.data.alive) {
        return;
      }
      this.cache.clear();
      this.genericCache.clear();
      this.invalidateAllWindows();
      this.syncToggleUI();
    };
    for (const key of [
      `${prefix}.collectionCounts.enable`,
      `${prefix}.collectionCounts.mode`,
    ]) {
      try {
        this.prefObserverIDs.push(
          Zotero.Prefs.registerObserver(key, handler, true),
        );
      } catch (e) {
        ztoolkit.log("[Stylero] counts pref observer registration failed", e);
      }
    }
  }

  /** Make the View-menu checkbox a real checkbox and reflect the current pref. */
  private static syncToggleUI(win?: _ZoteroTypes.MainWindow): void {
    const enabled = !!getPref(ENABLE_PREF);
    const wins = win ? [win] : Zotero.getMainWindows();
    for (const w of wins) {
      try {
        const item = w.document?.getElementById(TOGGLE_ID);
        if (!item) {
          continue;
        }
        if (item.getAttribute("type") !== "checkbox") {
          item.setAttribute("type", "checkbox");
        }
        item.setAttribute("checked", enabled ? "true" : "false");
      } catch (e) {
        ztoolkit.log("[Stylero] syncToggleUI failed", e);
      }
    }
  }

  // ---- internals ----

  private static getCollectionTree(
    win: _ZoteroTypes.MainWindow,
  ): PatchableTree | undefined {
    try {
      return (win as any).ZoteroPane?.collectionsView as
        | PatchableTree
        | undefined;
    } catch {
      return undefined;
    }
  }

  private static patchTree(tree: PatchableTree): void {
    const current = tree.renderItem;
    if (!current || typeof current !== "function") {
      return;
    }
    if ((current as any)[PATCH_FLAG]) {
      return; // already patched
    }

    const original = current;
    const self = this;

    const wrapper = function (this: any, ...args: any[]) {
      const node = original.apply(this, args);
      try {
        const index = args[0] as number;
        self.decorateRow(tree, index, node);
      } catch (e) {
        // Degrade to "no badge" rather than breaking the tree.
        ztoolkit.log("[Stylero] decorateRow failed", e);
      }
      return node;
    } as ((...args: any[]) => any) & { [PATCH_FLAG]?: boolean };

    wrapper[PATCH_FLAG] = true;

    // Store original for restore, then swap both the instance method and the
    // React props reference (verified: both held the same function).
    tree[ORIGINAL_KEY] = original;
    tree.renderItem = wrapper;
    if (tree.tree?.props && tree.tree.props.renderItem === original) {
      tree.tree.props.renderItem = wrapper;
    }
  }

  private static unpatchTree(tree: PatchableTree): void {
    const original = tree[ORIGINAL_KEY];
    if (!original) {
      return;
    }
    const wrapper = tree.renderItem;
    tree.renderItem = original;
    if (tree.tree?.props && tree.tree.props.renderItem === wrapper) {
      tree.tree.props.renderItem = original;
    }
    delete tree[ORIGINAL_KEY];
  }

  /**
   * Append/update a single count badge on a row node. Idempotent: removes any
   * pre-existing badge first so recycled DOM never doubles up.
   */
  private static decorateRow(
    tree: PatchableTree,
    index: number,
    node: any,
  ): void {
    if (!node || typeof node.querySelector !== "function") {
      return;
    }

    // Remove any stale badge from a recycled row (also clears badges when the
    // feature is toggled off and the tree repaints).
    const stale = node.querySelector(`.${BADGE_CLASS}`);
    if (stale) {
      stale.remove();
    }

    if (!getPref(ENABLE_PREF)) {
      return;
    }

    const row = tree.getRow ? tree.getRow(index) : undefined;
    if (!row) {
      return;
    }
    const ref = row.ref;

    if (ref instanceof Zotero.Collection) {
      const mode = this.getMode();
      const counts = this.getCounts(ref as Zotero.Collection);
      const isZero =
        mode === "offspring"
          ? counts.offspring === 0
          : counts.child === 0 && counts.offspring === 0;
      this.paintBadge(node, this.formatLabel(mode, counts), isZero);
      return;
    }

    // Non-collection rows: skip headers/separators, count everything else via
    // the row's own getItems() (async, cached by stable row id).
    if (
      (typeof row.isHeader === "function" && row.isHeader()) ||
      (typeof row.isSeparator === "function" && row.isSeparator()) ||
      typeof row.getItems !== "function"
    ) {
      return;
    }
    const key = row.id != null ? String(row.id) : "";
    if (!key) {
      return;
    }

    const cached = this.genericCache.get(key);
    if (cached !== undefined) {
      this.paintBadge(node, String(cached), cached === 0);
      return;
    }
    // Not computed yet: kick off one async count, paint on the next repaint.
    this.computeGenericCount(row, key);
  }

  private static paintBadge(node: any, label: string, isZero: boolean): void {
    const doc: Document = node.ownerDocument;
    const primary = node.querySelector(".cell.primary") || node;
    const badge = doc.createElement("span");
    badge.className = BADGE_CLASS;
    if (isZero) {
      badge.classList.add("zero");
    }
    badge.textContent = label;
    primary.appendChild(badge);
  }

  /** Asynchronously count a non-collection row's items and cache by id. */
  private static computeGenericCount(row: any, key: string): void {
    if (this.pendingGeneric.has(key)) {
      return;
    }
    this.pendingGeneric.add(key);
    Promise.resolve()
      .then(() => row.getItems())
      .then((items: unknown[]) => {
        this.genericCache.set(key, Array.isArray(items) ? items.length : 0);
      })
      .catch((e: unknown) => {
        ztoolkit.log("[Stylero] generic getItems failed for " + key, e);
        this.genericCache.set(key, 0);
      })
      .finally(() => {
        this.pendingGeneric.delete(key);
        this.scheduleGenericRepaint();
      });
  }

  /** Coalesce repaints from many async counts resolving at once. */
  private static scheduleGenericRepaint(): void {
    if (this.genericRepaintTimer !== null) {
      return;
    }
    this.genericRepaintTimer = setTimeout(() => {
      this.genericRepaintTimer = null;
      if (!addon?.data.alive) {
        return;
      }
      this.invalidateAllWindows();
    }, 120);
  }

  private static getMode(): CountMode {
    const raw = String(getPref("collectionCounts.mode") ?? "child");
    if (
      raw === "child" ||
      raw === "offspring" ||
      raw === "both" ||
      raw === "bothReverse"
    ) {
      return raw;
    }
    return "child";
  }

  private static formatLabel(
    mode: CountMode,
    counts: { child: number; offspring: number },
  ): string {
    switch (mode) {
      case "child":
        return String(counts.child);
      case "offspring":
        return String(counts.offspring);
      case "both":
        return `${counts.child} / ${counts.offspring}`;
      case "bothReverse":
        return `${counts.offspring} / ${counts.child}`;
      default:
        return String(counts.child);
    }
  }

  /**
   * Compute (and cache) the child + offspring counts for a collection.
   */
  private static getCounts(collection: Zotero.Collection): {
    child: number;
    offspring: number;
  } {
    const id = collection.id;
    const cached = this.cache.get(id);
    if (cached) {
      return cached;
    }

    let child = 0;
    try {
      child = (collection.getChildItems(false, false) || []).length;
    } catch (e) {
      ztoolkit.log("[Stylero] getChildItems failed", e);
    }

    const offspring = this.computeOffspring(collection);

    const result = { child, offspring };
    this.cache.set(id, result);
    return result;
  }

  /**
   * Recursively gather all item ids in this collection and every descendant,
   * deduped via a Set.
   */
  private static computeOffspring(root: Zotero.Collection): number {
    const itemIds = new Set<number>();
    const visited = new Set<number>();
    const stack: Zotero.Collection[] = [root];

    while (stack.length) {
      const coll = stack.pop()!;
      if (visited.has(coll.id)) {
        continue;
      }
      visited.add(coll.id);

      try {
        const items = coll.getChildItems(false, false) || [];
        for (const it of items) {
          itemIds.add(it.id);
        }
      } catch (e) {
        ztoolkit.log("[Stylero] offspring getChildItems failed", e);
      }

      try {
        const subs = coll.getChildCollections() || [];
        for (const sub of subs) {
          if (!visited.has(sub.id)) {
            stack.push(sub);
          }
        }
      } catch (e) {
        ztoolkit.log("[Stylero] offspring getChildCollections failed", e);
      }
    }

    return itemIds.size;
  }

  private static repaint(tree: PatchableTree): void {
    try {
      const inner = tree.tree;
      const rowCount = typeof tree.rowCount === "number" ? tree.rowCount : 0;
      // invalidateRange re-runs the per-row renderItem hook (plain invalidate
      // only repaints existing DOM and would not re-decorate).
      if (inner && typeof inner.invalidateRange === "function" && rowCount > 0) {
        inner.invalidateRange(0, rowCount - 1);
      } else if (inner && typeof inner.invalidate === "function") {
        inner.invalidate();
      } else if (typeof tree.refresh === "function") {
        void tree.refresh();
      }
    } catch (e) {
      ztoolkit.log("[Stylero] repaint failed", e);
    }
  }

  private static invalidateAllWindows(): void {
    for (const win of Zotero.getMainWindows()) {
      const tree = this.getCollectionTree(win as _ZoteroTypes.MainWindow);
      if (tree) {
        this.repaint(tree);
      }
    }
  }

  private static injectCss(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    const id = "stylero-collectionCounts-css";
    if (doc.getElementById(id)) {
      return;
    }
    const link = ztoolkit.UI.createElement(doc, "link", {
      id,
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/collectionCounts.css`,
      },
    });
    doc.documentElement?.appendChild(link);
  }

  private static removeBadges(win: _ZoteroTypes.MainWindow): void {
    try {
      const badges = win.document.querySelectorAll(`.${BADGE_CLASS}`);
      badges.forEach((b: Element) => b.remove());
    } catch (e) {
      ztoolkit.log("[Stylero] removeBadges failed", e);
    }
  }
}
