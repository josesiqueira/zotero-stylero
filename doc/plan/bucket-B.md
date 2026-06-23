# Bucket B - implementation spec

## Features
- Custom registered item-tree column (dataKey stylero-title) that mirrors the native Title content but adds decorations, registered via Zotero.ItemTreeManager.registerColumns in static register()
- Reading-time HEAT background painted behind the title text, intensity derived from ReadingStore total dwell normalized against the max total among currently visible rows
- File-type icon prepended to the cell using item.getImageSrc() (item-type/attachment icon), kept in sync via idempotent re-render
- Odd/even row striping applied as a CSS class toggled from the row parity (renderCell receives the row index), backed by a stylesheet
- Colored tag swatches (small dots) rendered BEFORE the title text from item.getColoredTags(), each using the tag's stored color
- Read/unread bold support: bold the whole cell for unread feed items (or all items per pref) by toggling a CSS class in renderCell
- Per-feature enable pref and sub-toggles (heat, icon, striping, tag swatches, scope of bold) with sensible defaults
- Heat color ramp and intensity are pref-driven (base hue + max opacity), normalization mode selectable (linear vs sqrt for perceptual scaling)

## Files to create (use these EXACT relative paths)
- `src/modules/titleColumn.ts`: TitleColumnFactory class: static async register() registers the custom stylero-title column with dataProvider + renderCell; static registerWindow() injects the feature stylesheet link; static unregister()/unregisterWindow() remove the column and link; exports PREFS. Contains heat normalization (visible-row max lookup with per-paint memoization), tag-swatch builder, icon builder, striping/bold class toggles. Read-only consumer of ReadingStore.
- `addon/content/titleColumn.css`: Feature-owned stylesheet: .stylero-title-cell layout (flex row, icon + swatches + heat layer + text), .stylero-heat absolutely-positioned background layer, .stylero-row-odd/.stylero-row-even striping, .stylero-unread bold rule, .stylero-tag-dot swatch styling, ellipsis/overflow for the title text. Injected by registerWindow via a <link>.

## Public API
```ts
export interface TitleColumnPrefs { /* documented in PREFS */ }

export class TitleColumnFactory {
  /** One-time global registration. Registers the custom column with ItemTreeManager. Called once in onStartup. */
  static async register(): Promise<void>;

  /** Per-window: injects addon/content/titleColumn.css via a <link>. Called in onMainWindowLoad. Idempotent. */
  static registerWindow(win: _ZoteroTypes.MainWindow): void;

  /** Removes the injected stylesheet for a window. */
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void;

  /** Unregisters the column (ztoolkit.unregisterAll also covers toolkit-tracked registrations). */
  static unregister(): Promise<void>;
}

/** Pref defaults appended to addon/prefs.js by integration. Keys are namespaced under titleColumn.* */
export const PREFS: Record<string, string | number | boolean>;

// Internal (not exported) helper signatures used inside renderCell:
// dataProvider(item: Zotero.Item, dataKey: string): string  // returns getDisplayTitle() for native sort
// renderCell(index: number, data: string, column: any, isFirstColumn: boolean, doc: Document): HTMLElement
// computeHeatRatio(itemKey: string, doc: Document): number   // 0..1 normalized vs visible max
// getVisibleMaxTotal(doc: Document): number                  // queries live ItemTree, memoized per paint tick
// buildTagDots(item: Zotero.Item, doc: Document): HTMLElement // colored swatches before title
```

## Prefs (export as PREFS; integration adds defaults to addon/prefs.js)
- `titleColumn.enable` (boolean, default true): Master toggle. When false, register() does not register the column.
- `titleColumn.heat.enable` (boolean, default true): Show the reading-time heat background behind the title.
- `titleColumn.heat.hue` (int, default 12): Base hue (HSL degrees) for the heat color ramp. 12 = warm orange/red.
- `titleColumn.heat.maxAlpha` (string, default 0.45): Maximum background opacity (0..1) for the hottest visible row. Stored as string to allow fractional default in prefs.js; parsed with parseFloat.
- `titleColumn.heat.scale` (string, default sqrt): Normalization curve: 'linear' or 'sqrt' (perceptual). Applied to ratio = total / visibleMax.
- `titleColumn.icon.enable` (boolean, default true): Prepend the file-type icon from item.getImageSrc().
- `titleColumn.striping.enable` (boolean, default true): Apply odd/even row striping class based on row index parity.
- `titleColumn.tagSwatches.enable` (boolean, default true): Render colored tag dots before the title for tags that have an assigned color.
- `titleColumn.tagSwatches.max` (int, default 5): Maximum number of colored tag dots to render per row.
- `titleColumn.bold.scope` (string, default feeds): Unread-bold scope: 'feeds' (only feed items via item.isRead), 'all', or 'off'.

## Rendering / data-flow
DECISION: implement as a REGISTERED custom column (dataKey 'stylero-title') via Zotero.ItemTreeManager.registerColumns, NOT by decorating/patching the native Title cell. Justification for Zotero 9: the native primary cell is produced by the item tree's private _renderPrimaryCell/_renderCell path and the tree is virtualized with recycled row DOM; monkey-patching those internals is exactly the 'fragile, patches private tree internals' risk called out in the spec and contract. registerColumns is the supported, stable API: Zotero owns the lifecycle, calls our renderCell on every (re)paint of a visible row, and recycles the returned node for us. We return a fresh, self-contained <span class='cell stylero-title-cell'> each call, so recycling is safe and we never clear or mutate native content.

DATA FLOW per renderCell(index, data, column, isFirstColumn, doc):
1. Resolve the item for this row. We do NOT trust 'data' for the item ref; we get the live ItemTree via doc.defaultView.ZoteroPane.itemsView (the ItemTree instance) and call itemsView.getRow(index).ref to get the Zotero.Item, then item.key as the ReadingStore key. dataProvider separately returns item.getDisplayTitle() so native sorting/quicksearch on this column works on the plain title string.
2. Build the cell structure: [icon img?] [tag dots?] [heat layer (absolute, behind)] [title text span]. The heat layer is a position:absolute child with inset:0 and z-index below the text; the cell is position:relative. Text uses ellipsis overflow.
3. ICON: if titleColumn.icon.enable, create an <img class='stylero-title-icon'> with src=item.getImageSrc(). getImageSrc returns the item-type/attachment icon URL synchronously.
4. TAG DOTS: if enabled, item.getColoredTags() returns tags carrying a stored color; render up to tagSwatches.max <span class='stylero-tag-dot'> with style.background=tag.color, title=tag.tag, placed BEFORE the title text.
5. HEAT: if enabled, ratio = readingStore total for item.key normalized by the visible-row max (see normalization below), shaped by heat.scale (sqrt or linear), then alpha = ratio*maxAlpha; set heat layer background to hsla(hue, 85%, 50%, alpha). When total is 0 or store not ready, no heat layer (or alpha 0).
6. STRIPING: toggle classList 'stylero-row-odd'/'stylero-row-even' from (index % 2). Class-based so the stylesheet controls colors and it is theme-friendly (uses CSS color-mix / currentColor). Idempotent because we rebuild the node.
7. BOLD: per titleColumn.bold.scope: 'off' -> nothing; 'feeds' -> if item.isFeedItem && !item.isRead add class 'stylero-unread'; 'all' -> if (item.isRead === false) add class. CSS makes the whole cell bold.
8. Set the title text via textContent (never innerHTML) to avoid injection.

All work is synchronous and cheap (string formatting, a few DOM nodes, one map lookup), satisfying the 'runs on every row paint' constraint. No async, no item.getTags() DB hits in the hot path: getColoredTags()/getImageSrc()/getDisplayTitle() read already-loaded item state.

## Zotero 9 APIs
- Zotero.ItemTreeManager.registerColumns({ pluginID, dataKey, label, dataProvider, renderCell, htmlLabel? })
- Zotero.ItemTreeManager.unregisterColumns(dataKey)
- renderCell(index, data, column, isFirstColumn, doc) => HTMLElement (column.className used on the cell span)
- doc.defaultView.ZoteroPane.itemsView (the ItemTree instance for the active window)
- itemsView.getRow(index).ref => Zotero.Item (row -> item resolution; itemsView.rowCount for visible-range scan)
- itemsView._treebox.getFirstVisibleRow()/getLastVisibleRow() or itemsView.tree._topDiv scroll range for the on-screen window (used to bound the heat-max scan to visible rows)
- Zotero.Item.prototype.getDisplayTitle()
- Zotero.Item.prototype.getImageSrc()
- Zotero.Item.prototype.getColoredTags() (tags with stored colors: { tag, color, position })
- Zotero.Item.prototype.isFeedItem / isRead (feed read state for unread-bold)
- Zotero.Item.prototype.key (ReadingStore lookup key)
- IOUtils / PathUtils globals (only indirectly, via ReadingStore in bucket A; this module does no IO)
- ztoolkit.UI.createElement(doc, 'link', {...}) for stylesheet injection in registerWindow
- getPref/setPref from src/utils/prefs.ts for all titleColumn.* prefs
- ReadingStore.getItemData(itemKey) and ReadingStore.getMaxTotalInView(itemKeys) from src/modules/readingStore.ts (read-only)

## Edge cases
- ReadingStore not yet initialized at first paint: treat total as 0, render no heat; the column repaints once data loads (a Zotero.Notifier refresh or itemsView.refresh from bucket A's store-ready signal). renderCell must never throw.
- Visible-row max = 0 (no row has dwell time): skip heat entirely to avoid divide-by-zero; ratio defaults to 0.
- getRow(index) returns null/undefined during fast scroll/recycle: guard and render a minimal cell with just the title.
- Items with no colored tags: render no dots; do not call getTags() (DB) in the hot path.
- Very long titles: text span uses overflow:hidden + text-overflow:ellipsis + white-space:nowrap so icon/dots/heat never push layout.
- Attachment/note/annotation rows: getImageSrc still returns a valid icon; getDisplayTitle returns the proper label.
- Non-feed item with bold.scope='feeds': isFeedItem false -> never bold. item.isRead may be undefined for non-feed items -> guard with === false for 'all' scope.
- maxAlpha stored as string in prefs.js (fractional default): parse with parseFloat and clamp to [0,1].
- Theme (light/dark): striping and heat use CSS color-mix/hsla so they remain readable in both; bold uses font-weight only.
- Recycled DOM: we always return a freshly-built node and set classes explicitly (both odd AND even handled) so stale classes from a recycled node never persist.
- Multiple main windows: registerWindow runs per window and guards the <link> by id; the column registration is global (once).
- Heat max memoization staleness: cache is keyed by a paint-tick token (cleared on next animation frame / on itemsView scroll or refresh) so a row scrolled into view recomputes against the correct visible set.

## Risks
- Visible-row enumeration relies on semi-private ItemTree fields (itemsView._treebox / tree internals). If the exact accessor differs in 9.0.4, fall back to ReadingStore.getMaxTotalInView over ALL loaded row item keys (itemsView.getRow(0..rowCount-1)) instead of strictly on-screen rows; correctness holds, only the normalization window widens.
- Heat normalized against visible rows means the same item changes shade as you scroll. This is intended per spec (relative heat) but can look unstable; sqrt scaling and a per-paint memo reduce flicker. A pref to normalize against the whole loaded view (not just on-screen) is the mitigation.
- renderCell runs on every paint; doing the visible-max scan naively per cell is O(n^2). Mitigated by memoizing the max for the current paint tick (compute once, reuse for all cells until invalidated).
- getColoredTags() availability/shape on 9.0.4 should be verified at implementation time; if absent, fall back to item.getTags() filtered against Zotero.Tags.getColor(libraryID, tagName) (cached).
- Registering a custom column does not replace the native Title column; users may see both. Intended UX is to use this as the title-area column; integrator may hide the native Title via column-prefs, but this module must not edit shared files to do so.
- If bucket A persists ReadingStore keyed by itemID instead of itemKey, the key contract must match; contract specifies itemKey, so this module uses item.key. A mismatch yields all-zero heat (degrades gracefully, no crash).

## Integration notes
register() must be awaited in onStartup AFTER Zotero.uiReadyPromise (already satisfied in template). It should run before the first item-tree paint; ItemTreeManager.registerColumns is the supported async API. registerWindow injects the CSS <link> idempotently (guard by element id 'stylero-titleColumn-css'). On shutdown, ztoolkit.unregisterAll() covers toolkit-registered UI, but the column is registered via the native Zotero.ItemTreeManager and must be removed explicitly in unregister() with Zotero.ItemTreeManager.unregisterColumns(dataKey) (store the returned key). The integration wiring (hooks.ts/addon.ts edits) is the integrator's job per the module contract; this module touches no shared files. Heat depends on ReadingStore.init() having completed in bucket A's startup before first paint; renderCell is defensive if ReadingStore data is not yet loaded (treats total as 0).

### Wiring
- onStartup: await TitleColumnFactory.register();
- onMainWindowLoad: TitleColumnFactory.registerWindow(win);
- CSS: chrome://${addon.data.config.addonRef}/content/titleColumn.css
