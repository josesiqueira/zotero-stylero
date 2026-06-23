# Bucket A - implementation spec

## Features
- Focus-gated reading-time sampler (feature 16): while a reader tab is the active, focused tab, sample the current page every ~10s and accrue per-page dwell seconds for the reader's attachment item.
- 60s hang guard: if more than ~60s elapses between two consecutive sample ticks (machine sleep, debugger pause, long stall), discard that interval instead of crediting a huge dwell to the current page.
- Per-page dwell accounting keyed by 0-based pageIndex, accrued in real (fractional rounded) seconds, with a running per-item total kept in sync.
- Page-change detection: when the sampled pageIndex changes between ticks, credit the elapsed slice to the page that was showing during that slice (the previous page), not the new one.
- Tab focus/blur handling: pause sampling on window blur, tab switch away from the reader, or app minimize; resume cleanly with a fresh baseline timestamp (no retroactive credit for the unfocused gap).
- Multiple readers: track whichever reader instance corresponds to the currently selected reader tab in the focused window; standalone reader windows are also supported via their own focus state.
- Plugin reload / Zotero restart safe: state is loaded from a JSON file on init and any in-flight slice is flushed on shutdown/window-unload; the interval and listeners are torn down so reload does not double-count.
- Shared ReadingStore module: durable per-item page-dwell map persisted to a JSON file in the Zotero data dir via IOUtils with debounced atomic writes, exposing a stable read API consumed by the Title-heat and Progress columns.
- View-scoped heat normalization: getMaxTotalInView computes the max total dwell across a set of item keys so the Title column can normalize the heat background per visible page of rows.

## Files to create (use these EXACT relative paths)
- `src/modules/readingStore.ts`: Shared, feature-agnostic persistence layer. Owns the on-disk JSON model of per-item per-page dwell seconds. Exposes the exact ReadingStore interface from the contract (init/getItemData/addDwell/getMaxTotalInView) plus a couple of internal helpers. Handles IOUtils load, debounced atomic save, in-memory cache, and a dirty flush. No Zotero reader logic lives here; it is a pure store so the column buckets can import it read-only without pulling in sampler code.
- `src/modules/readingTime.ts`: Feature 16 sampler. Exports class ReadingTimeFactory with static register()/registerWindow()/unregisterWindow()/unregister(). register() initializes ReadingStore and registers the global tab-select notifier + Zotero.Reader hooks; registerWindow() attaches focus/blur/visibility listeners to each main window and to standalone reader windows, starts the 10s interval, and wires the page sampler. All dwell writes go through ReadingStore.addDwell. Owns the focus gate, hang guard, page-change crediting, and shutdown flush.
- `src/modules/readingTime.css`: Optional/none for this bucket. The sampler renders no UI of its own (heat/progress visuals belong to the column buckets). Listed only so integration knows no CSS link is required for bucket A; the file can be omitted entirely.

## Public API
```ts
// src/modules/readingStore.ts
export interface PageDwell { [page: number]: number /* seconds */ }
interface ItemReadingData { pages: PageDwell; total: number }
export const ReadingStore: {
  /** Load JSON from disk into the in-memory cache. Idempotent; safe to call once in onStartup. */
  init(): Promise<void>;
  /** Read-only accessor used by Title-heat + Progress columns. itemKey is Zotero.Item.key (libraryID-stable string). */
  getItemData(itemKey: string): ItemReadingData | undefined;
  /** Accrue dwell seconds for a page (0-based index). Updates cache + total and schedules a debounced write. */
  addDwell(itemKey: string, page: number, seconds: number): void;
  /** Max total dwell across the given item keys; used by the Title column for per-view heat normalization. Returns 0 if none. */
  getMaxTotalInView(itemKeys: string[]): number;
  /** Force an immediate flush of pending writes (called on shutdown). Optional helper. */
  flush(): Promise<void>;
};

// src/modules/readingTime.ts
export const PREFS: Record<string, string | number | boolean>;
export class ReadingTimeFactory {
  static register(): Promise<void>;            // onStartup: ReadingStore.init() + notifier/Reader hooks
  static registerWindow(win: _ZoteroTypes.MainWindow): void; // onMainWindowLoad: focus listeners + start sampler
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void; // remove that window's listeners, flush slice
  static unregister(): void;                   // clear interval, unregister notifier, ReadingStore.flush()
}
```

## Prefs (export as PREFS; integration adds defaults to addon/prefs.js)
- `readingTime.enable` (boolean, default true): Master switch for the reading-time sampler. When false, register() still runs but the interval/listeners are not armed, so no dwell is accrued (columns then show zero/empty heat).
- `readingTime.sampleIntervalMs` (int, default 10000): Sampler tick interval in milliseconds (~10s). Each tick credits the elapsed wall-clock slice to the page that was visible during that slice.
- `readingTime.hangGuardMs` (int, default 60000): Hang guard threshold in milliseconds (~60s). If the gap between two consecutive ticks exceeds this, the slice is discarded (treats sleep/stall as not-reading).
- `readingTime.idleResetMs` (int, default 0): Optional user-idle timeout. If >0 and Zotero reports the user idle for this long, sampling pauses without crediting. 0 disables idle detection (focus gating only).
- `readingTime.persistDebounceMs` (int, default 5000): Debounce window for writing the dwell JSON to disk. Coalesces many addDwell calls into one atomic write to limit disk churn.

## Rendering / data-flow
Data-flow only (no cell rendering in this bucket; that is owned by the column buckets). SAMPLER LOOP: registerWindow arms a single win.setInterval(tick, sampleIntervalMs) per main window plus per standalone reader window. State per window: { activeReader, activeItemKey, lastPageIndex, lastTickTs }. On each tick: (1) GATE: if readingTime.enable is false, or the window is not focused (track via 'focus'/'blur' listeners on the window and document.hasFocus()), or the selected tab is not a reader tab (Zotero_Tabs.selectedType !== 'reader'), or (idleResetMs>0 and idle), then set lastTickTs=undefined (drop baseline) and return without crediting. (2) RESOLVE READER: get the reader for the selected reader tab via Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID); for a standalone reader window match by win against reader._window. Read item key from reader._item.key (fallback Zotero.Items.get(reader.itemID).key). (3) RESOLVE PAGE: read current page index from reader._internalReader._state.primaryViewStats.pageIndex, falling back to reader.state.pageIndex; default 0. This works for pdf/epub/snapshot (epub/snapshot also populate pageIndex via the page mapping). (4) CREDIT: if lastTickTs is set and same reader item as last tick, compute elapsedSec=(now-lastTickTs)/1000. If elapsedSec > hangGuardMs/1000 -> DISCARD (hang guard). Else credit elapsedSec to the page that was showing during the slice = lastPageIndex (the page BEFORE any change this tick), via ReadingStore.addDwell(activeItemKey, lastPageIndex, elapsedSec). (5) ADVANCE: set lastPageIndex=currentPageIndex, lastTickTs=now, activeItemKey=currentKey. On page change WITHIN a tick gap we still attribute the whole slice to the previous page (10s granularity is acceptable per spec). PUSH SIGNAL: to make page changes more responsive than the 10s grid, also register Zotero.Reader.registerEventListener for view events (e.g. renderToolbar / a navigate hook) OR simpler: read pageIndex fresh every tick and let the next tick credit; the 10s sampler is the source of truth, event listeners are only an optional refinement. STORE INTERNALS: ReadingStore keeps cache: Map<itemKey, {pages:PageDwell,total:number}>. addDwell rounds to 1 decimal, adds to pages[page] and total, marks dirty, and (re)arms a persistDebounceMs timer that calls saveToDisk(). saveToDisk serializes {version:1, items:{[key]:{pages,total}}} and does an atomic write: IOUtils.writeJSON(tmpPath, data) then IOUtils.move(tmpPath, finalPath) (or IOUtils.write with {tmpPath} option) to avoid partial files. init() resolves path = PathUtils.join(Zotero.DataDirectory.dir, 'zoterostylero', 'reading-time.json'), ensures the dir via IOUtils.makeDirectory({createAncestors:true,ignoreExisting:true}), checks IOUtils.exists(absPath), and IOUtils.readJSON on the absolute path (guarding the documented 'exists throws on non-absolute path' gotcha by always using the joined absolute path). getMaxTotalInView iterates the passed keys, reads cache totals, returns the max (0 if empty)."

## Zotero 9 APIs
- Zotero.Reader (global _ZoteroTypes.Reader): Zotero.Reader._readers array of reader instances, Zotero.Reader.getByTabID(tabID) -> ReaderInstance, Zotero.Reader.registerEventListener/unregisterEventListener for reader view hooks
- ReaderInstance fields: reader._item (Zotero.Item) and reader.itemID (number) for the attachment; reader.tabID; reader.type ('pdf'|'epub'|'snapshot'); reader._window (standalone window) for window matching
- Current page: reader._internalReader._state.primaryViewStats.pageIndex / .pageLabel / .pagesCount (live view stats), with fallback reader.state.pageIndex (_ZoteroTypes.Reader.State persisted state)
- win.Zotero_Tabs: selectedID, selectedType ('reader' vs 'library'), getTabIDByItemID(itemID) for mapping the active tab to a reader
- Zotero.Notifier.registerObserver(callback, ['tab']) listening for {event:'select', type:'tab'} to react to tab switches (same pattern as hooks.ts onNotify), unregister via Zotero.Notifier.unregisterObserver; deregister on Zotero.Plugins shutdown observer
- Zotero.Items.get(itemID) / item.key for the stable per-item store key
- Window focus state: win 'focus'/'blur'/'visibilitychange' DOM events + win.document.hasFocus(); optional Zotero.Idle / win-level idle for idleResetMs
- Persistence globals (Zotero 9): IOUtils.readJSON, IOUtils.writeJSON/IOUtils.write, IOUtils.move, IOUtils.exists, IOUtils.makeDirectory; PathUtils.join; Zotero.DataDirectory.dir for the profile/data directory (NOT removed OS.File)
- win.setInterval/clearInterval for the 10s sampler (per-window so it is torn down on window unload)
- zotero-plugin-toolkit ReaderTool (optional convenience: getReader(timeout)/getWindowReader()) as an alternative to raw Zotero.Reader access

## Edge cases
- Reader not yet initialized when a reader tab is selected: reader._isReaderInitialized false or primaryViewStats undefined -> skip crediting that tick (treat as no page), reset baseline so the first real tick after init does not back-credit init time.
- pageIndex undefined for epub/snapshot at load: fall back to 0 only after init; before init, skip rather than crediting page 0 spuriously.
- Tab switched between two different reader items between ticks: activeItemKey changed -> do NOT credit the elapsed slice (ambiguous attribution); just reset baseline to current item/page.
- Machine sleep / debugger pause: elapsed slice exceeds hangGuardMs -> discard slice (the core 60s hang guard).
- Window blurred mid-slice (alt-tab, another app): on 'blur' immediately flush the partial slice up to the blur timestamp to the current page, then drop the baseline so the unfocused period is never credited; on 'focus' restart with a fresh baseline.
- Multiple main windows / standalone reader windows open simultaneously: each window has its own interval+state; only the focused window with a selected reader tab accrues, preventing double counting of the same reading session.
- Same attachment open in two windows at once: both could credit if both focused, but only one window can hold OS focus at a time, so realistically only one accrues; documented as acceptable.
- Second (split) view active: primaryViewStats reflects the last-focused view's page via reader._lastViewPrimary; we read primaryViewStats which Zotero keeps pointed at the active view, so split view is handled without extra logic.
- Plugin reload while a reader is open: unregister() flushes the in-flight slice and clears interval; on re-register, init() reloads JSON and a fresh baseline starts, so no double count and no lost data.
- Corrupt/missing JSON on init: IOUtils.readJSON throws -> catch and start with an empty store (log once), and back up the corrupt file rather than overwriting blindly.
- Very fast page flipping (skim): with 10s granularity a page visited <10s may get 0 or a partial slice; acceptable per spec (heat is approximate). Pages are only credited when they were the 'previous' page across a tick boundary.
- Item deleted while data exists: getItemData/getMaxTotalInView tolerate stale keys (columns just won't query them); optionally prune on item 'delete' notifier in a later pass.
- Non-reader attachment (e.g. note) selected: selectedType !== 'reader' gate prevents any accrual.

## Risks
- Reliance on private reader internals (reader._internalReader._state.primaryViewStats, reader._item) which are not part of a stable public API and may shift in a Zotero point release; mitigate with layered fallbacks (primaryViewStats.pageIndex -> reader.state.pageIndex -> 0) and defensive optional chaining so a missing field degrades to skip rather than throw.
- Notifier 'tab' select events and window focus events can race the sampler interval; baseline-reset-on-gate keeps this safe but requires careful ordering (always reset lastTickTs when gating, never credit across a gate transition).
- Debounced disk writes mean up to persistDebounceMs of dwell can be lost on a hard crash; the shutdown/unregister flush covers clean exits but not kill -9. Acceptable for approximate heat data.
- Atomic write via tmp+move must use absolute paths and the correct IOUtils signature on Zotero 9 (Firefox 140); IOUtils.exists throwing on non-absolute paths is a known gotcha, so all paths must come from PathUtils.join(Zotero.DataDirectory.dir, ...).
- Per-window setInterval must be cleared in unregisterWindow or it leaks across window reopen; integration MUST call unregisterWindow in onMainWindowUnload because ztoolkit.unregisterAll() does not track manual intervals/notifiers/Reader listeners.
- Standalone reader window focus detection differs from main-window tab focus; matching reader._window to the focused window adds complexity and is the most likely source of mis-attribution if the reader internals change.
- getMaxTotalInView is called from renderCell (hot path) by the Title column; it must stay O(n) over visible keys and read only the in-memory cache (no disk, no Zotero.Items lookups) to keep row painting cheap.
- Clock changes (NTP/timezone) using Date.now() could produce negative or huge elapsed values; clamp elapsed to [0, hangGuardMs] before crediting.

## Integration notes
register() must be awaited in onStartup BEFORE the Title-heat and Progress column buckets register their columns, because those columns call ReadingStore.getItemData synchronously in dataProvider/renderCell and need the cache populated by ReadingStore.init(). Order: ReadingTimeFactory.register() -> then column buckets' register(). In onMainWindowUnload, integration should call ReadingTimeFactory.unregisterWindow(win) so that window's focus listeners are removed and its in-flight slice is flushed (do this in addition to the existing ztoolkit.unregisterAll(), which does NOT cover the manual setInterval, the Notifier observer, or the Zotero.Reader event listeners). In onShutdown, integration should call ReadingTimeFactory.unregister() to clear the interval, unregister the notifier, and await ReadingStore.flush() so the latest dwell survives restart. No FTL/locale strings required by this bucket. Append the PREFS entries to addon/prefs.js with the 'extensions.zotero.zoterostylero.' prefix prepended by the scaffold.

### Wiring
- onStartup: await ReadingTimeFactory.register();
- onMainWindowLoad: ReadingTimeFactory.registerWindow(win);
- CSS: none
