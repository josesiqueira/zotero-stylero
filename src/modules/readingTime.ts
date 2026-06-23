/**
 * readingTime.ts — Feature 16: focus-gated reading-time sampler (Zotero Stylero,
 * bucket A).
 *
 * While a reader tab is the active, focused tab, this sampler ticks every
 * ~10s and accrues per-page dwell seconds for the reader's attachment item via
 * the shared ReadingStore. It owns the focus gate, the 60s hang guard, the
 * page-change crediting rule, and the shutdown flush. It renders NO UI of its
 * own; the heat/progress visuals belong to the column buckets.
 *
 * Design notes (see bucket-A spec):
 * - Per main window AND per standalone reader window, we arm a single
 *   win.setInterval and track { activeReader, activeItemKey, lastPageIndex,
 *   lastTickTs } in a per-window WindowState.
 * - On each tick we (1) GATE on enable+focus+reader-tab+idle, (2) RESOLVE the
 *   reader and its item key, (3) RESOLVE the current page index defensively,
 *   (4) CREDIT the elapsed slice to the page that was showing during that
 *   slice (the previous page), applying the hang guard / clock-jump clamp, then
 *   (5) ADVANCE the baseline.
 * - Gating always drops the baseline (lastTickTs = undefined) so we never
 *   credit across a gate transition (blur, tab switch, idle, sleep).
 * - All private reader internals are accessed with optional chaining + layered
 *   fallbacks so a missing field degrades to "skip this tick" rather than throw.
 */

import { getPref } from "../utils/prefs";
import { ReadingStore } from "./readingStore";

/** Pref defaults for this feature; integration appends these to addon/prefs.js. */
export const PREFS: Record<string, string | number | boolean> = {
  "readingTime.enable": true,
  "readingTime.sampleIntervalMs": 10000,
  "readingTime.hangGuardMs": 60000,
  "readingTime.idleResetMs": 0,
  "readingTime.persistDebounceMs": 5000,
};

/** Per-window sampler state. */
interface WindowState {
  win: any;
  intervalID: number | undefined;
  /** Bound DOM listeners we attach, so we can remove exactly these on teardown. */
  listeners: Array<{ target: any; type: string; handler: EventListener }>;
  /** Item key of the reader credited in the previous tick (attribution guard). */
  activeItemKey: string | undefined;
  /** Page index shown during the slice that the next tick will credit. */
  lastPageIndex: number;
  /** Timestamp (ms) of the previous credited tick; undefined drops the baseline. */
  lastTickTs: number | undefined;
}

/**
 * Reader-instance shape we read from. All fields are optional/private Zotero
 * internals accessed defensively.
 */
interface ReaderLike {
  _item?: { key?: string; id?: number };
  itemID?: number;
  tabID?: string;
  type?: string;
  _window?: any;
  _isReaderInitialized?: boolean;
  state?: { pageIndex?: number };
  _internalReader?: {
    _state?: {
      primaryViewStats?: {
        pageIndex?: number;
        pageLabel?: string;
        pagesCount?: number;
      };
    };
  };
}

export class ReadingTimeFactory {
  /** All windows we have armed, keyed by the window object. */
  private static windowStates = new Map<any, WindowState>();
  /** Notifier observer id for tab-select events (reset baseline on tab switch). */
  private static notifierID: string | undefined;
  /** Whether register() has completed (so registerWindow can no-op safely). */
  private static registered = false;

  /**
   * onStartup: initialize the shared ReadingStore and register the global
   * tab-select notifier. Must be awaited BEFORE the column buckets register, so
   * their synchronous getItemData reads see a populated cache.
   */
  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    await ReadingStore.init();

    // Tab-select notifier: when the user switches tabs, reset the baseline of
    // the affected window so we never credit a slice across the switch.
    try {
      const callback = {
        notify: (
          event: string,
          type: string,
          _ids: number[] | string[],
          _extraData: { [key: string]: any },
        ) => {
          if (!addon?.data.alive) {
            return;
          }
          if (type === "tab" && event === "select") {
            // Drop the baseline of every window; the next tick re-establishes a
            // fresh one for whichever window is focused on a reader tab.
            for (const st of ReadingTimeFactory.windowStates.values()) {
              st.lastTickTs = undefined;
            }
          }
        },
      };
      this.notifierID = Zotero.Notifier.registerObserver(callback, ["tab"]);
    } catch (e) {
      ztoolkit.log("[ReadingTime] Failed to register tab notifier", e);
    }

    this.registered = true;
  }

  /**
   * onMainWindowLoad (and applicable to standalone reader windows): attach
   * focus/blur/visibility listeners and arm the 10s sampler interval for this
   * window. The interval is per-window so it is torn down on window unload.
   */
  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!win) {
      return;
    }
    // Avoid double-arming the same window (e.g. re-entrant load).
    if (this.windowStates.has(win)) {
      return;
    }

    const st: WindowState = {
      win,
      intervalID: undefined,
      listeners: [],
      activeItemKey: undefined,
      lastPageIndex: 0,
      lastTickTs: undefined,
    };
    this.windowStates.set(win, st);

    // On blur: flush the partial slice up to now (to the current page) then drop
    // the baseline so the unfocused period is never credited.
    const onBlur: EventListener = () => {
      this.flushSlice(st);
      st.lastTickTs = undefined;
    };
    // On focus: restart with a fresh baseline (no retroactive credit).
    const onFocus: EventListener = () => {
      st.lastTickTs = undefined;
    };
    // On visibility change (minimize / restore): treat hidden like blur.
    const onVisibility: EventListener = () => {
      try {
        if ((win as any).document?.hidden) {
          this.flushSlice(st);
        }
      } catch {
        /* ignore */
      }
      st.lastTickTs = undefined;
    };

    const add = (target: any, type: string, handler: EventListener) => {
      try {
        target.addEventListener(type, handler);
        st.listeners.push({ target, type, handler });
      } catch (e) {
        ztoolkit.log(`[ReadingTime] Failed to add ${type} listener`, e);
      }
    };

    add(win, "blur", onBlur);
    add(win, "focus", onFocus);
    try {
      if ((win as any).document) {
        add((win as any).document, "visibilitychange", onVisibility);
      }
    } catch {
      /* ignore */
    }

    // Arm the sampler interval. We read the interval length once at arm time;
    // changing the pref takes effect on the next window load (acceptable).
    const intervalMs = this.getIntervalMs();
    try {
      st.intervalID = (win as any).setInterval(() => {
        this.tick(st);
      }, intervalMs) as unknown as number;
    } catch (e) {
      ztoolkit.log("[ReadingTime] Failed to arm sampler interval", e);
    }
  }

  /**
   * onMainWindowUnload: remove that window's listeners, flush its in-flight
   * slice, and clear its interval. ztoolkit.unregisterAll() does NOT cover the
   * manual setInterval/listeners, so integration must call this.
   */
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const st = this.windowStates.get(win);
    if (!st) {
      return;
    }
    // Flush any in-flight slice before tearing down (if the window still focused).
    this.flushSlice(st);
    st.lastTickTs = undefined;

    if (st.intervalID !== undefined) {
      try {
        (win as any).clearInterval(st.intervalID);
      } catch {
        /* ignore */
      }
      st.intervalID = undefined;
    }
    for (const l of st.listeners) {
      try {
        l.target.removeEventListener(l.type, l.handler);
      } catch {
        /* ignore */
      }
    }
    st.listeners = [];
    this.windowStates.delete(win);
  }

  /**
   * onShutdown: clear all intervals/listeners, unregister the notifier, flush
   * every in-flight slice, and flush the ReadingStore to disk.
   */
  static unregister(): void {
    // Tear down every window (flushes slices + clears intervals/listeners).
    for (const win of Array.from(this.windowStates.keys())) {
      this.unregisterWindow(win as _ZoteroTypes.MainWindow);
    }
    this.windowStates.clear();

    if (this.notifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.notifierID);
      } catch {
        /* ignore */
      }
      this.notifierID = undefined;
    }

    this.registered = false;

    // Persist whatever is pending. Fire-and-forget; the store awaits internally.
    void ReadingStore.flush();
  }

  // ---- internals -----------------------------------------------------------

  private static getIntervalMs(): number {
    let v = 10000;
    try {
      const pref = getPref("readingTime.sampleIntervalMs" as any) as unknown;
      const n = typeof pref === "number" ? pref : parseInt(String(pref), 10);
      if (Number.isFinite(n) && n >= 1000) {
        v = n;
      }
    } catch {
      /* use default */
    }
    return v;
  }

  private static getHangGuardMs(): number {
    let v = 60000;
    try {
      const pref = getPref("readingTime.hangGuardMs" as any) as unknown;
      const n = typeof pref === "number" ? pref : parseInt(String(pref), 10);
      if (Number.isFinite(n) && n > 0) {
        v = n;
      }
    } catch {
      /* use default */
    }
    return v;
  }

  private static getIdleResetMs(): number {
    let v = 0;
    try {
      const pref = getPref("readingTime.idleResetMs" as any) as unknown;
      const n = typeof pref === "number" ? pref : parseInt(String(pref), 10);
      if (Number.isFinite(n) && n >= 0) {
        v = n;
      }
    } catch {
      /* use default */
    }
    return v;
  }

  private static isEnabled(): boolean {
    try {
      return getPref("readingTime.enable" as any) !== false;
    } catch {
      return true;
    }
  }

  /**
   * Resolve the reader instance that this window is currently showing, or
   * undefined if the gate should fail. For a main window, that is the reader of
   * the selected reader tab; for a standalone reader window, the reader whose
   * _window matches this window.
   */
  private static resolveReader(st: WindowState): ReaderLike | undefined {
    const win = st.win;
    const reader: any = Zotero.Reader;
    if (!reader) {
      return undefined;
    }

    // Standalone reader window: match by reader._window === win.
    try {
      const readers: ReaderLike[] = reader._readers || [];
      for (const r of readers) {
        if (r && r._window && r._window === win) {
          return r;
        }
      }
    } catch {
      /* fall through to tab-based resolution */
    }

    // Main window: only credit when the selected tab is a reader tab.
    try {
      const tabs = (win as any).Zotero_Tabs;
      if (!tabs) {
        return undefined;
      }
      if (tabs.selectedType !== "reader") {
        return undefined;
      }
      const selectedID = tabs.selectedID;
      if (!selectedID) {
        return undefined;
      }
      const r = reader.getByTabID
        ? (reader.getByTabID(selectedID) as ReaderLike | undefined)
        : undefined;
      return r || undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve the stable per-item store key for a reader's attachment. */
  private static resolveItemKey(r: ReaderLike): string | undefined {
    try {
      if (r._item && r._item.key) {
        return r._item.key;
      }
      if (typeof r.itemID === "number") {
        const item = Zotero.Items.get(r.itemID);
        if (item && (item as any).key) {
          return (item as any).key as string;
        }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /**
   * Resolve the current 0-based page index defensively. Returns undefined if
   * the reader is not yet initialized / stats are unavailable, so the caller
   * skips crediting (rather than spuriously crediting page 0).
   */
  private static resolvePageIndex(r: ReaderLike): number | undefined {
    // If the reader explicitly reports it is not initialized, skip.
    if (r._isReaderInitialized === false) {
      return undefined;
    }
    // Preferred: live primary view stats.
    const stats = r._internalReader?._state?.primaryViewStats;
    if (stats && typeof stats.pageIndex === "number" && Number.isFinite(stats.pageIndex)) {
      return stats.pageIndex >= 0 ? stats.pageIndex : 0;
    }
    // Fallback: persisted reader state.
    if (r.state && typeof r.state.pageIndex === "number" && Number.isFinite(r.state.pageIndex)) {
      return r.state.pageIndex >= 0 ? r.state.pageIndex : 0;
    }
    // If the internalReader exists but has no stats yet, treat as not-ready.
    if (r._internalReader && !stats) {
      return undefined;
    }
    return undefined;
  }

  /** Whether the user has been idle longer than the configured threshold. */
  private static isIdle(): boolean {
    const idleMs = this.getIdleResetMs();
    if (idleMs <= 0) {
      return false;
    }
    try {
      // Zotero exposes an idle service; idleService.idleTime is in milliseconds.
      const idleService = (Zotero as any).idleService;
      if (idleService && typeof idleService.idleTime === "number") {
        return idleService.idleTime >= idleMs;
      }
    } catch {
      /* ignore: treat as not idle */
    }
    return false;
  }

  /** Whether this window currently holds focus (OS + document level). */
  private static isFocused(st: WindowState): boolean {
    const win = st.win;
    try {
      const doc = (win as any).document;
      if (doc) {
        if (doc.hidden) {
          return false;
        }
        if (typeof doc.hasFocus === "function") {
          return !!doc.hasFocus();
        }
      }
    } catch {
      /* fall through */
    }
    return true;
  }

  /**
   * Main sampler tick for one window. See module header for the 5-step flow.
   */
  private static tick(st: WindowState): void {
    const now = Date.now();

    // (1) GATE.
    if (!addon?.data.alive) {
      st.lastTickTs = undefined;
      return;
    }
    if (!this.isEnabled()) {
      st.lastTickTs = undefined;
      return;
    }
    if (!this.isFocused(st)) {
      st.lastTickTs = undefined;
      return;
    }
    if (this.isIdle()) {
      st.lastTickTs = undefined;
      return;
    }

    // (2) RESOLVE READER.
    const reader = this.resolveReader(st);
    if (!reader) {
      st.lastTickTs = undefined;
      return;
    }
    const itemKey = this.resolveItemKey(reader);
    if (!itemKey) {
      st.lastTickTs = undefined;
      return;
    }

    // (3) RESOLVE PAGE.
    const pageIndex = this.resolvePageIndex(reader);
    if (pageIndex === undefined) {
      // Reader not ready: skip crediting and reset baseline so the first real
      // tick after init does not back-credit init time.
      st.lastTickTs = undefined;
      return;
    }

    // (4) CREDIT (only if we have a baseline AND the same item as last tick).
    if (st.lastTickTs !== undefined && st.activeItemKey === itemKey) {
      const hangGuardMs = this.getHangGuardMs();
      let elapsedMs = now - st.lastTickTs;
      // Clamp clock jumps (NTP/timezone) to a sane range before deciding.
      if (elapsedMs > 0 && elapsedMs <= hangGuardMs) {
        const elapsedSec = elapsedMs / 1000;
        // Credit to the page shown DURING the slice = the previous page index.
        ReadingStore.addDwell(itemKey, st.lastPageIndex, elapsedSec);
      }
      // elapsedMs <= 0 (clock went backwards) or > hangGuardMs (sleep/stall):
      // discard the slice (hang guard / clock-jump protection).
    }

    // (5) ADVANCE baseline.
    st.lastPageIndex = pageIndex;
    st.lastTickTs = now;
    st.activeItemKey = itemKey;
  }

  /**
   * Flush the partial slice from the last baseline up to now to the page that
   * was showing (lastPageIndex), applying the same hang-guard clamp. Used on
   * blur/visibility/teardown so a clean transition credits up to that instant.
   * Does NOT advance the baseline (caller drops it afterwards).
   */
  private static flushSlice(st: WindowState): void {
    if (st.lastTickTs === undefined || !st.activeItemKey) {
      return;
    }
    const now = Date.now();
    const hangGuardMs = this.getHangGuardMs();
    const elapsedMs = now - st.lastTickTs;
    if (elapsedMs > 0 && elapsedMs <= hangGuardMs) {
      ReadingStore.addDwell(st.activeItemKey, st.lastPageIndex, elapsedMs / 1000);
    }
    // Mark as consumed so a subsequent teardown does not double-credit.
    st.lastTickTs = undefined;
  }
}
