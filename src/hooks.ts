import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { ReadingTimeFactory } from "./modules/readingTime";
import { CreatorColumnFactory } from "./modules/creatorColumn";
import { CollectionCountsFactory } from "./modules/collectionCounts";
import { ProgressColumnFactory } from "./modules/progressColumn";
import { ReadStateFactory } from "./modules/readState";
import { UnreadColumnFactory } from "./modules/unreadColumn";
import { RatingColumnFactory } from "./modules/ratingColumn";
import { ItemRowDecorator } from "./modules/itemRowDecorator";
import { ThemeToggleFactory } from "./modules/themeToggle";
import { ColumnManagerFactory } from "./modules/columnManager";
import { ReaderSelectionFactory } from "./modules/readerSelection";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Reading-time sampler must initialize its store BEFORE the Progress column
  // that reads it, since its cell renderer reads the in-memory cache synchronously.
  await ReadingTimeFactory.register();

  // Item-tree columns.
  await CreatorColumnFactory.register();
  await ProgressColumnFactory.register();
  await UnreadColumnFactory.register();
  await RatingColumnFactory.register();

  // Tree / state decorations.
  CollectionCountsFactory.register();
  await ReadStateFactory.register();

  // Light/dark toolbar toggle.
  ThemeToggleFactory.register();

  // Column Manager (toolbar button + View menu + header-menu entry points).
  ColumnManagerFactory.register();

  // Mendeley-style PDF selection overlay.
  ReaderSelectionFactory.register();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // Shared item-row renderer patch (used by read-state bold + rating title-strip).
  ItemRowDecorator.registerWindow(win);

  ReadingTimeFactory.registerWindow(win);
  ProgressColumnFactory.registerWindow(win);
  CollectionCountsFactory.registerWindow(win);
  ReadStateFactory.registerWindow(win);
  UnreadColumnFactory.registerWindow(win);
  RatingColumnFactory.registerWindow(win);
  ThemeToggleFactory.registerWindow(win);
  ColumnManagerFactory.registerWindow(win);
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Per-window teardown for things ztoolkit.unregisterAll() does not cover
  // (manual intervals, observers, patched tree renderers, injected DOM).
  // CollectionCounts must restore the patched renderItem BEFORE unregisterAll.
  CollectionCountsFactory.unregisterWindow(win);
  ReadingTimeFactory.unregisterWindow(win);
  ProgressColumnFactory.unregisterWindow(win);
  ReadStateFactory.unregisterWindow(win);
  UnreadColumnFactory.unregisterWindow(win);
  RatingColumnFactory.unregisterWindow(win);
  ThemeToggleFactory.unregisterWindow(win);
  ColumnManagerFactory.unregisterWindow(win);
  ItemRowDecorator.unregisterWindow(win);

  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

async function onShutdown(): Promise<void> {
  // Restore per-window patches/decorations on every open window first
  // (CollectionCounts patches the collection-tree renderItem; leaving it in
  // place would strand a dead closure). Do this before the global unregisters.
  for (const win of Zotero.getMainWindows()) {
    try {
      CollectionCountsFactory.unregisterWindow(win);
      // Restore the shared row-renderer patch so an upgrade/reload doesn't strand
      // a previous-generation wrapper (onMainWindowUnload doesn't fire on reload).
      ItemRowDecorator.unregisterWindow(win);
      RatingColumnFactory.unregisterWindow(win);
      // Restore the patched buildColumnPickerMenu + remove the toolbar button.
      ColumnManagerFactory.unregisterWindow(win);
    } catch (e) {
      ztoolkit.log("per-window shutdown cleanup failed", e);
    }
  }

  // Tear down everything that lives outside ztoolkit's registry.
  try {
    // Awaited so the debounced reading-time data is flushed to disk before the
    // JS context is torn down (plugin disable/uninstall/upgrade).
    await ReadingTimeFactory.unregister();
  } catch (e) {
    ztoolkit.log("ReadingTimeFactory.unregister failed", e);
  }
  CreatorColumnFactory.unregister();
  ProgressColumnFactory.unregister();
  UnreadColumnFactory.unregister();
  RatingColumnFactory.unregister();
  CollectionCountsFactory.unregister();
  ReadStateFactory.unregister();
  ThemeToggleFactory.unregister();
  ColumnManagerFactory.unregister();
  ReaderSelectionFactory.unregister();

  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Notify events. Feature modules register their own targeted
 * Zotero.Notifier observers, so this stays minimal.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * Dispatcher for Preference UI events.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

/**
 * Dispatcher for Column Manager dialog events (called from columnManager.xhtml).
 */
async function onColumnManagerEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      ColumnManagerFactory.onDialogLoad(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {
  // Shortcuts are registered directly by feature modules.
}

function onDialogEvents(_type: string) {
  // No dialog events in this build.
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onColumnManagerEvent,
  onShortcuts,
  onDialogEvents,
};
