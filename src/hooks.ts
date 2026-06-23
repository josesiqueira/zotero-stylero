import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { ReadingTimeFactory } from "./modules/readingTime";
import { TitleColumnFactory } from "./modules/titleColumn";
import { CreatorColumnFactory } from "./modules/creatorColumn";
import { RatingColumnFactory } from "./modules/ratingColumn";
import { CollectionCountsFactory } from "./modules/collectionCounts";
import { ProgressColumnFactory } from "./modules/progressColumn";
import { ReadStateFactory } from "./modules/readState";
import { GraphViewFactory } from "./modules/graphView";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Reading-time sampler must initialize its store BEFORE the columns that read
  // it (Title heat, Progress) register, since their cell renderers read the
  // in-memory cache synchronously.
  await ReadingTimeFactory.register();

  // Item-tree columns.
  await TitleColumnFactory.register();
  await CreatorColumnFactory.register();
  await RatingColumnFactory.register();
  await ProgressColumnFactory.register();

  // Tree / state decorations.
  CollectionCountsFactory.register();
  await ReadStateFactory.register();

  // Knowledge graph.
  await GraphViewFactory.register();

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

  ReadingTimeFactory.registerWindow(win);
  TitleColumnFactory.registerWindow(win);
  RatingColumnFactory.registerWindow(win);
  ProgressColumnFactory.registerWindow(win);
  CollectionCountsFactory.registerWindow(win);
  ReadStateFactory.registerWindow(win);
  GraphViewFactory.registerWindow(win);
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Per-window teardown for things ztoolkit.unregisterAll() does not cover
  // (manual intervals, observers, patched tree renderers, injected DOM).
  // CollectionCounts must restore the patched renderItem BEFORE unregisterAll.
  CollectionCountsFactory.unregisterWindow(win);
  ReadingTimeFactory.unregisterWindow(win);
  TitleColumnFactory.unregisterWindow(win);
  RatingColumnFactory.unregisterWindow(win);
  ProgressColumnFactory.unregisterWindow(win);
  ReadStateFactory.unregisterWindow(win);
  GraphViewFactory.unregisterWindow(win);

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
    } catch (e) {
      ztoolkit.log("CollectionCounts.unregisterWindow failed", e);
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
  void TitleColumnFactory.unregister();
  CreatorColumnFactory.unregister();
  RatingColumnFactory.unregister();
  ProgressColumnFactory.unregister();
  CollectionCountsFactory.unregister();
  ReadStateFactory.unregister();
  GraphViewFactory.unregister();

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

function onShortcuts(_type: string) {
  // Shortcuts are registered directly by feature modules (e.g. Graph View).
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
  onShortcuts,
  onDialogEvents,
};
