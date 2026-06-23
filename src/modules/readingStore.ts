/**
 * readingStore.ts — Shared, feature-agnostic persistence layer for per-item
 * per-page reading dwell seconds (Zotero Stylero, bucket A).
 *
 * This module owns the on-disk JSON model and an in-memory cache. It has NO
 * knowledge of the Zotero reader, focus gating, or sampling: that logic lives
 * in readingTime.ts. The Title-heat and Progress column buckets import the
 * exported `ReadingStore` object READ-ONLY (getItemData / getMaxTotalInView)
 * from their cell renderers, so this file must stay cheap and synchronous on
 * the read path (no disk I/O, no Zotero.Items lookups in the hot path).
 *
 * Persistence uses the Zotero 9 globals IOUtils / PathUtils (the removed
 * OS.File API is NOT used). Writes are debounced and atomic (tmp file + move)
 * to coalesce many addDwell calls and avoid partial files on crash.
 */

/** Map of 0-based page index → accrued dwell seconds. */
export interface PageDwell {
  [page: number]: number /* seconds */;
}

/** Per-item reading data: page breakdown plus a running total (sum of pages). */
interface ItemReadingData {
  pages: PageDwell;
  total: number;
}

/** On-disk file shape. `version` lets us migrate the schema in future passes. */
interface ReadingStoreFile {
  version: number;
  items: { [itemKey: string]: ItemReadingData };
}

const STORE_VERSION = 1;
const STORE_SUBDIR = "zoterostylero";
const STORE_FILENAME = "reading-time.json";

/** Round to 1 decimal place; keeps the JSON compact and the heat approximate. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Internal singleton state. Kept in a closure-like module object so the public
 * `ReadingStore` stays a stable, importable surface.
 */
const state: {
  cache: Map<string, ItemReadingData>;
  initialized: boolean;
  initPromise: Promise<void> | undefined;
  dirty: boolean;
  saveTimer: number | undefined;
  debounceMs: number;
  /** Absolute path to the JSON file (resolved once in init). */
  filePath: string | undefined;
  /** Absolute path to the containing directory (resolved once in init). */
  dirPath: string | undefined;
  /** Guards against overlapping atomic writes. */
  writing: Promise<void> | undefined;
} = {
  cache: new Map(),
  initialized: false,
  initPromise: undefined,
  dirty: false,
  saveTimer: undefined,
  debounceMs: 5000,
  filePath: undefined,
  dirPath: undefined,
  writing: undefined,
};

function resolvePaths(): void {
  // Always build absolute paths via PathUtils.join over Zotero.DataDirectory.dir.
  // IOUtils.exists throws on non-absolute paths, so we never pass a relative one.
  const dataDir = Zotero.DataDirectory.dir;
  state.dirPath = PathUtils.join(dataDir, STORE_SUBDIR);
  state.filePath = PathUtils.join(dataDir, STORE_SUBDIR, STORE_FILENAME);
}

/** Read the debounce window from prefs (falls back to the 5000ms default). */
function readDebounceMs(): number {
  try {
    const v = Zotero.Prefs.get(
      "extensions.zotero.zoterostylero.readingTime.persistDebounceMs",
      true,
    );
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  } catch {
    // Prefs may not be initialized yet; use the default.
  }
  return 5000;
}

/** Validate and adopt a parsed file payload into the in-memory cache. */
function adoptFile(parsed: unknown): void {
  state.cache.clear();
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const file = parsed as Partial<ReadingStoreFile>;
  const items = file.items;
  if (!items || typeof items !== "object") {
    return;
  }
  for (const key of Object.keys(items)) {
    const raw = (items as { [k: string]: unknown })[key];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const rawData = raw as Partial<ItemReadingData>;
    const pages: PageDwell = {};
    let total = 0;
    if (rawData.pages && typeof rawData.pages === "object") {
      for (const pk of Object.keys(rawData.pages)) {
        const pageIndex = parseInt(pk, 10);
        const seconds = Number((rawData.pages as PageDwell)[pageIndex as number]);
        if (Number.isFinite(pageIndex) && pageIndex >= 0 && Number.isFinite(seconds) && seconds > 0) {
          pages[pageIndex] = round1(seconds);
          total += pages[pageIndex];
        }
      }
    }
    // Prefer recomputed total from pages for consistency; fall back to stored.
    const storedTotal = Number(rawData.total);
    if (total === 0 && Number.isFinite(storedTotal) && storedTotal > 0) {
      total = round1(storedTotal);
    } else {
      total = round1(total);
    }
    if (total > 0 || Object.keys(pages).length > 0) {
      state.cache.set(key, { pages, total });
    }
  }
}

/**
 * Back up a corrupt JSON file rather than overwriting it blindly, so a parse
 * failure does not silently destroy recoverable data.
 */
async function backupCorruptFile(): Promise<void> {
  if (!state.filePath) {
    return;
  }
  try {
    const backupPath = `${state.filePath}.corrupt-${Date.now()}`;
    await IOUtils.move(state.filePath, backupPath, { noOverwrite: false });
    ztoolkit.log(
      `[ReadingStore] Backed up corrupt store to ${backupPath}`,
    );
  } catch (e) {
    ztoolkit.log("[ReadingStore] Failed to back up corrupt store", e);
  }
}

/** Serialize the cache into the on-disk file shape. */
function serialize(): ReadingStoreFile {
  const items: { [itemKey: string]: ItemReadingData } = {};
  for (const [key, data] of state.cache) {
    if (data.total <= 0 && Object.keys(data.pages).length === 0) {
      continue;
    }
    items[key] = { pages: { ...data.pages }, total: round1(data.total) };
  }
  return { version: STORE_VERSION, items };
}

/**
 * Atomically write the current cache to disk: write to a tmp file then move it
 * over the target so a crash mid-write never leaves a partial JSON file.
 */
async function saveToDisk(): Promise<void> {
  if (!state.filePath || !state.dirPath) {
    return;
  }
  // Serialize a snapshot before any await so concurrent addDwell calls during
  // the write are not lost (they re-set the dirty flag and re-arm the timer).
  state.dirty = false;
  const payload = serialize();
  const finalPath = state.filePath;
  const tmpPath = `${finalPath}.tmp`;

  const doWrite = async () => {
    try {
      await IOUtils.makeDirectory(state.dirPath as string, {
        createAncestors: true,
        ignoreExisting: true,
      });
      // writeJSON to a tmp file, then atomic move over the real file.
      await IOUtils.writeJSON(tmpPath, payload);
      await IOUtils.move(tmpPath, finalPath, { noOverwrite: false });
    } catch (e) {
      // Writing failed; keep data dirty so a later flush retries.
      state.dirty = true;
      ztoolkit.log("[ReadingStore] Failed to persist reading-time store", e);
      // Best-effort cleanup of a stray tmp file.
      try {
        await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      } catch {
        /* ignore */
      }
    }
  };

  // Chain writes so two overlapping saves never race on the same tmp/move.
  state.writing = (state.writing ?? Promise.resolve()).then(doWrite);
  await state.writing;
}

/** (Re)arm the debounced save timer. */
function scheduleSave(): void {
  if (state.saveTimer !== undefined) {
    try {
      _globalThis.clearTimeout(state.saveTimer);
    } catch {
      /* ignore */
    }
    state.saveTimer = undefined;
  }
  state.saveTimer = _globalThis.setTimeout(() => {
    state.saveTimer = undefined;
    if (state.dirty) {
      void saveToDisk();
    }
  }, state.debounceMs) as unknown as number;
}

export const ReadingStore = {
  /**
   * Load JSON from disk into the in-memory cache. Idempotent: a second call is
   * a no-op once initialized. Safe to call once in onStartup. On corrupt or
   * missing data it starts with an empty store (and backs up corrupt files).
   */
  async init(): Promise<void> {
    if (state.initialized) {
      return;
    }
    if (state.initPromise) {
      return state.initPromise;
    }
    state.initPromise = (async () => {
      resolvePaths();
      state.debounceMs = readDebounceMs();
      const filePath = state.filePath as string;
      const dirPath = state.dirPath as string;
      try {
        await IOUtils.makeDirectory(dirPath, {
          createAncestors: true,
          ignoreExisting: true,
        });
      } catch (e) {
        ztoolkit.log("[ReadingStore] Failed to ensure data directory", e);
      }
      let exists = false;
      try {
        exists = await IOUtils.exists(filePath);
      } catch (e) {
        ztoolkit.log("[ReadingStore] exists() check failed", e);
        exists = false;
      }
      if (exists) {
        try {
          const parsed = await IOUtils.readJSON(filePath);
          adoptFile(parsed);
        } catch (e) {
          ztoolkit.log(
            "[ReadingStore] Corrupt/unreadable store; starting empty",
            e,
          );
          await backupCorruptFile();
          state.cache.clear();
        }
      } else {
        state.cache.clear();
      }
      state.initialized = true;
    })();
    try {
      await state.initPromise;
    } finally {
      state.initPromise = undefined;
    }
  },

  /**
   * Read-only accessor used by the Title-heat + Progress columns. `itemKey` is
   * Zotero.Item.key. Returns undefined for unknown keys. Returns a defensive
   * shallow copy so callers cannot mutate the cache.
   */
  getItemData(itemKey: string): ItemReadingData | undefined {
    const data = state.cache.get(itemKey);
    if (!data) {
      return undefined;
    }
    return { pages: { ...data.pages }, total: data.total };
  },

  /**
   * Accrue dwell seconds for a 0-based page index. Updates cache + running
   * total and schedules a debounced atomic write. Non-positive or non-finite
   * seconds, and negative page indices, are ignored.
   */
  addDwell(itemKey: string, page: number, seconds: number): void {
    if (!itemKey) {
      return;
    }
    if (!Number.isFinite(page) || page < 0) {
      return;
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    const pageIndex = Math.floor(page);
    let data = state.cache.get(itemKey);
    if (!data) {
      data = { pages: {}, total: 0 };
      state.cache.set(itemKey, data);
    }
    const prev = data.pages[pageIndex] ?? 0;
    data.pages[pageIndex] = round1(prev + seconds);
    let sum = 0;
    for (const key in data.pages) {
      sum += data.pages[key];
    }
    data.total = round1(sum);
    state.dirty = true;
    scheduleSave();
  },

  /**
   * Max total dwell across the given item keys; used by the Title column for
   * per-view heat normalization. O(n) over the passed keys, reads only the
   * in-memory cache. Returns 0 if none have data.
   */
  getMaxTotalInView(itemKeys: string[]): number {
    let max = 0;
    if (!itemKeys || itemKeys.length === 0) {
      return 0;
    }
    for (const key of itemKeys) {
      const data = state.cache.get(key);
      if (data && data.total > max) {
        max = data.total;
      }
    }
    return max;
  },

  /**
   * Force an immediate flush of pending writes (called on shutdown). Cancels
   * the debounce timer and writes synchronously-awaited if dirty.
   */
  async flush(): Promise<void> {
    if (state.saveTimer !== undefined) {
      try {
        _globalThis.clearTimeout(state.saveTimer);
      } catch {
        /* ignore */
      }
      state.saveTimer = undefined;
    }
    if (state.dirty) {
      await saveToDisk();
    }
    // Wait for any in-flight chained write to settle.
    if (state.writing) {
      try {
        await state.writing;
      } catch {
        /* ignore */
      }
    }
  },
};
