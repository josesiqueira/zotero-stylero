/**
 * Shared item-tree row decorator.
 *
 * Several features need to post-process each rendered item-tree row (read-state
 * whole-row bold, stripping the star rating tag from the title, ...). Rather than
 * each one separately wrapping the tree's row renderer (which would chain/conflict
 * on teardown), they register a decorator callback here and this module owns the
 * single patch.
 *
 * Patch technique (verified on Zotero 9.0.4): the durable anchor is the ItemTree
 * instance method `_renderItem`; `tree.props.renderItem` is re-assigned from it on
 * every re-render, so we wrap BOTH — the instance method (future renders) and the
 * current props (this frame).
 */

const PATCH_FLAG = "__styleroRowDecorated";

type RenderItemFn = ((...args: any[]) => any) & { [PATCH_FLAG]?: boolean };
export type RowDecorator = (
  view: ItemsViewLike,
  index: number,
  node: any,
) => void;

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

export class ItemRowDecorator {
  private static readonly decorators = new Set<RowDecorator>();
  private static readonly patched = new WeakMap<
    _ZoteroTypes.MainWindow,
    { view: ItemsViewLike; original: RenderItemFn; props: any }
  >();

  /** Register a decorator (global). Triggers a repaint so it applies at once. */
  static add(fn: RowDecorator): void {
    this.decorators.add(fn);
    this.repaintAll();
  }

  static remove(fn: RowDecorator): void {
    this.decorators.delete(fn);
    this.repaintAll();
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    this.ensurePatchedWithRetry(win);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    this.unpatch(win);
  }

  // --- patching ---

  private static getItemsView(
    win: _ZoteroTypes.MainWindow,
  ): ItemsViewLike | undefined {
    try {
      return (win as any).ZoteroPane?.itemsView as ItemsViewLike | undefined;
    } catch {
      return undefined;
    }
  }

  private static ensurePatched(win: _ZoteroTypes.MainWindow): boolean {
    const view = this.getItemsView(win);
    const props = view?.tree?.props;
    if (
      !view ||
      !props ||
      typeof view._renderItem !== "function" ||
      typeof props.renderItem !== "function"
    ) {
      return false;
    }
    if ((view._renderItem as RenderItemFn)[PATCH_FLAG]) {
      if (!(props.renderItem as RenderItemFn)[PATCH_FLAG]) {
        props.renderItem = view._renderItem;
      }
      return true;
    }
    const original = view._renderItem as RenderItemFn;
    const wrapper = function (this: any, ...args: any[]) {
      // Call the original bound to the ItemTree instance (`view`); it uses
      // `this._getRowData` etc., and our unbound wrapper would otherwise lose the
      // ItemTree `this` when invoked via props.renderItem.
      const node = original.apply(view, args);
      const index = args[0] as number;
      for (const fn of ItemRowDecorator.decorators) {
        try {
          fn(view, index, node);
        } catch (e) {
          ztoolkit.log("[stylero] row decorator failed", e);
        }
      }
      return node;
    } as RenderItemFn;
    wrapper[PATCH_FLAG] = true;
    view._renderItem = wrapper;
    props.renderItem = wrapper;
    this.patched.set(win, { view, original, props });
    return true;
  }

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
      ztoolkit.log("[stylero] row decorator retry scheduling failed", e);
    }
  }

  private static unpatch(win: _ZoteroTypes.MainWindow): void {
    const saved = this.patched.get(win);
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
      ztoolkit.log("[stylero] row decorator unpatch failed", e);
    }
    this.patched.delete(win);
    this.repaint(win);
  }

  // --- repaint ---

  static repaint(win: _ZoteroTypes.MainWindow): void {
    // Re-assert the patch in case React recreated the tree props since last paint.
    this.ensurePatched(win);
    const view = this.getItemsView(win);
    const tree = view?.tree;
    const rowCount = typeof view?.rowCount === "number" ? view.rowCount : 0;
    try {
      if (tree && typeof tree.invalidateRange === "function" && rowCount > 0) {
        tree.invalidateRange(0, rowCount - 1);
      } else if (tree && typeof tree.invalidate === "function") {
        tree.invalidate();
      }
    } catch (e) {
      ztoolkit.log("[stylero] row decorator repaint failed", e);
    }
  }

  static repaintAll(): void {
    if (!addon?.data.alive) {
      return;
    }
    for (const win of Zotero.getMainWindows()) {
      this.repaint(win as _ZoteroTypes.MainWindow);
    }
  }
}
