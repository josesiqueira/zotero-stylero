import { getPref } from "../utils/prefs";

/**
 * Bucket C - Feature 12: Collection item-count badges.
 *
 * Non-destructively decorates each collection row in the collection tree with a
 * muted pill showing how many items it holds. Four counting modes:
 *   - 'child'       : direct items only
 *   - 'offspring'   : this collection + all descendants, item ids deduped
 *   - 'both'        : "child / offspring"
 *   - 'bothReverse' : "offspring / child"
 *
 * Implementation: wrap the CollectionTree instance's per-row `renderItem`
 * function (verified against Zotero 9.0.4: it returns a `div.row` and is held
 * both on the instance and in `tree.props.renderItem`). The wrapper is stamped
 * idempotent and reversible. A Notifier observer clears the count cache and
 * invalidates the tree on collection/item changes.
 */

export const PREFS: Record<string, string | number | boolean> = {
  "collectionCounts.enable": true,
  "collectionCounts.mode": "child",
  "collectionCounts.includeSubcollectionItems": false,
};

const BADGE_CLASS = "stylero-collection-count";
const PATCH_FLAG = "__styleroCountsPatched";
const ORIGINAL_KEY = "__styleroCountsOriginal";

type CountMode = "child" | "offspring" | "both" | "bothReverse";

interface PatchableTree {
  renderItem?: ((...args: any[]) => any) & { [PATCH_FLAG]?: boolean };
  [ORIGINAL_KEY]?: (...args: any[]) => any;
  tree?: {
    props?: { renderItem?: (...args: any[]) => any };
    invalidate?: () => void;
  };
  getRow?: (index: number) => { ref?: any } | undefined;
  refresh?: () => void;
}

export class CollectionCountsFactory {
  private static notifierID: string | null = null;
  /** Per-collection-id cached counts; invalidated on notify. */
  private static cache = new Map<number, { child: number; offspring: number }>();
  /** Windows we have patched, so unregister can restore them. */
  private static patchedWindows = new Set<_ZoteroTypes.MainWindow>();

  // ---- global registration (notifier) ----

  static register(): void {
    if (!getPref("collectionCounts.enable")) {
      return;
    }
    if (this.notifierID) {
      return;
    }
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
        this.cache.clear();
        this.invalidateAllWindows();
      },
    };
    this.notifierID = Zotero.Notifier.registerObserver(observer, [
      "collection",
      "item",
      "collection-item",
    ]);
  }

  static unregister(): void {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    this.cache.clear();
  }

  // ---- per-window patching ----

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref("collectionCounts.enable")) {
      return;
    }
    this.injectCss(win);

    const tree = this.getCollectionTree(win);
    if (!tree) {
      return;
    }

    try {
      this.patchTree(tree);
      this.patchedWindows.add(win);
      this.repaint(tree);
    } catch (e) {
      ztoolkit.log("[Stylero] collectionCounts patch failed", e);
    }
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const tree = this.getCollectionTree(win) as PatchableTree | undefined;
    if (tree) {
      this.unpatchTree(tree);
      this.removeBadges(win);
      this.repaint(tree);
    }
    this.patchedWindows.delete(win);
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
   * Append/update a single count badge on a collection row node. Idempotent:
   * removes any pre-existing badge first so recycled DOM never doubles up.
   */
  private static decorateRow(
    tree: PatchableTree,
    index: number,
    node: any,
  ): void {
    if (!node || typeof node.querySelector !== "function") {
      return;
    }

    // Remove any stale badge from a recycled row.
    const stale = node.querySelector(`.${BADGE_CLASS}`);
    if (stale) {
      stale.remove();
    }

    const row = tree.getRow ? tree.getRow(index) : undefined;
    const ref = row?.ref;
    if (!ref || !(ref instanceof Zotero.Collection)) {
      return; // My Library, Trash, Unfiled, groups, separators, etc.
    }

    const mode = this.getMode();
    const counts = this.getCounts(ref as Zotero.Collection);
    const label = this.formatLabel(mode, counts);
    const isZero =
      mode === "offspring"
        ? counts.offspring === 0
        : counts.child === 0 && counts.offspring === 0;

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

    const mode = this.getMode();
    let offspring = child;
    if (mode !== "child") {
      offspring = this.computeOffspring(collection);
    }

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
      if (tree.tree && typeof tree.tree.invalidate === "function") {
        tree.tree.invalidate();
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
