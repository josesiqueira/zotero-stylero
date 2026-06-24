# Bucket C - implementation spec

> **As-built note:** The Rating column shipped **tag-driven** (an all-`⭐` tag is the
> source of truth), not Extra-field `rate: N` as described below, and there is no
> hover preview. An **Unread column** (`.unread` tag dot) was also added (not in this
> spec). Creator column and Collection counts match. Source of truth for the shipped
> behavior: [`doc/FEATURES.md`](../FEATURES.md).


## Features
- Creator column (feature 2): a custom item-tree column that reformats the author/creator list of each item using a configurable template string supporting ${firstName} ${lastName} ${firstCreator} placeholders, with optional slicing (first N / last N creators) and a custom join separator, all driven by prefs.
- Rating column (feature 9): a custom item-tree column rendering an EndNote-style 5-star rating. The value (0 to 5) is parsed from the item's Extra field under the line 'rate: N'. Clicking a star in the cell writes the new rating back into Extra (preserving other Extra lines) via saveTx, then the cell repaints. Hover preview and clear-on-click-same-star.
- Collection item counts (feature 12): non-destructive count badges appended to each collection row in the collection tree. Four counting modes (child-only, offspring recursive, both with child first, both with offspring first) selected by a pref. Badges are (re)painted for all visible rows at startup and refreshed on collection/item notifier events.

## Files to create (use these EXACT relative paths)
- `src/modules/creatorColumn.ts`: CreatorColumnFactory: registers the 'stylero-creator' item-tree column. dataProvider builds the formatted creator string from a template + slice + join prefs. No renderCell needed (plain text, sortable). Exports PREFS and register()/unregister().
- `src/modules/ratingColumn.ts`: RatingColumnFactory: registers the 'stylero-rating' column with a renderCell that draws 5 star glyphs, reads/writes the 'rate' key in the item's Extra field, handles click/hover, and refreshes the row. Exports PREFS and register()/unregister(). Has its own CSS file.
- `addon/content/ratingColumn.css`: Styles for the rating stars (filled/empty/hover states, sizing, cursor). Injected via <link> in RatingColumnFactory.registerWindow.
- `src/modules/collectionCounts.ts`: CollectionCountsFactory: registerWindow decorates the collection tree by patching the row renderer non-destructively to append a count badge span, computes counts per mode, repaints all rows at startup, and registers a notifier to refresh on changes. Exports PREFS and register()/registerWindow()/unregisterWindow(). Has its own CSS file.
- `addon/content/collectionCounts.css`: Styles for the collection-row count badge (muted pill at row end, dimmed when zero). Injected via <link> in CollectionCountsFactory.registerWindow.

## Public API
```ts
// src/modules/creatorColumn.ts
export const PREFS: Record<string, string | number | boolean>;
export class CreatorColumnFactory {
  static async register(): Promise<void>;   // registers column; called in onStartup
  static unregister(): void;                 // unregisterColumns (belt-and-suspenders; toolkit also clears)
}

// src/modules/ratingColumn.ts
export const PREFS: Record<string, string | number | boolean>;
export class RatingColumnFactory {
  static async register(): Promise<void>;                       // registers column in onStartup
  static registerWindow(win: _ZoteroTypes.MainWindow): void;    // injects ratingColumn.css link
  static unregister(): void;                                    // unregisterColumns
}

// src/modules/collectionCounts.ts
export const PREFS: Record<string, string | number | boolean>;
export class CollectionCountsFactory {
  static register(): void;                                      // registers Zotero.Notifier observer in onStartup
  static registerWindow(win: _ZoteroTypes.MainWindow): void;    // injects css, patches row renderer, paints all rows
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void;  // restores patched method, removes injected nodes
  static unregister(): void;                                    // unregisters notifier
}
```

## Prefs (export as PREFS; integration adds defaults to addon/prefs.js)
- `creatorColumn.enable` (boolean, default true): Master toggle for the Creator (reformatted authors) column.
- `creatorColumn.template` (string, default ${lastName}, ${firstName}): Per-creator template. Supports ${firstName}, ${lastName}, and ${firstCreator} (the latter expands to Zotero's computed firstCreator for the whole item and short-circuits per-creator iteration).
- `creatorColumn.join` (string, default ; ): Separator used to join formatted creators.
- `creatorColumn.slice` (string, default 0): Slice spec: '0' = all; positive N = first N creators; negative N = last N creators. Stored as string to allow empty/blank meaning all.
- `creatorColumn.ellipsis` (string, default  et al.): Suffix appended when the creator list was truncated by the slice setting (empty = no suffix).
- `ratingColumn.enable` (boolean, default true): Master toggle for the 5-star Rating column.
- `ratingColumn.max` (number, default 5): Number of stars (rating scale). Default EndNote-style 5. Stored as a number pref; keep single-digit so the dataProvider string sorts correctly.
- `ratingColumn.extraKey` (string, default rate): Extra-field line key used to store the rating, e.g. 'rate: 4'.
- `ratingColumn.allowClear` (boolean, default true): If true, clicking the currently-highest filled star clears the rating to 0.
- `collectionCounts.enable` (boolean, default true): Master toggle for collection-tree count badges.
- `collectionCounts.mode` (string, default child): Counting mode: 'child' (direct items only), 'offspring' (this collection + all descendants, deduped), 'both' (child then offspring), 'bothReverse' (offspring then child).
- `collectionCounts.includeSubcollectionItems` (boolean, default false): Reserved tweak: when mode='child', whether to still exclude items that live only in subcollections (kept false to match the literal child-only behavior).

## Rendering / data-flow
CREATOR COLUMN: register a text column dataKey 'stylero-creator' via Zotero.ItemTreeManager.registerColumns. dataProvider(item) returns a formatted string. Logic: if !item.isRegularItem() return ''. Read prefs template/join/slice/ellipsis. If template contains '${firstCreator}', return template with ${firstCreator} replaced by item.getField('firstCreator') (short-circuit; other placeholders blanked). Otherwise call item.getCreators() -> array of {firstName,lastName,fieldMode}. Apply slice: parse int N; N>0 take first N, N<0 take last |N|, else all; record truncated flag. Map each creator through template.replace(/\\${firstName}/g,...).replace(/\\${lastName}/g,...); for fieldMode===1 (single-field name) firstName is '' so collapse leftover ', ' or stray separators; trim each fragment and drop empties. Join with the join pref. Append ellipsis pref if truncated and ellipsis non-empty. Column is plain text so it is sortable and needs no renderCell. RATING COLUMN: register dataKey 'stylero-rating'. dataProvider(item) returns String(getRating(item)) (0..max) for sort. renderCell(index,data,column,isFirstColumn,doc): create span.cell with N child star spans (class star, filled if i<value). Read current value via getRating from Extra. Attach per-star click listener: compute newValue = clicked index+1; if allowClear and newValue===current then newValue=0; call setRating(item,newValue) which re-reads fresh Extra, replaces/inserts the 'rate: N' line preserving all other lines, item.setField('extra',...), await item.saveTx(); the notifier 'modify' event repaints the row. Optional mousemove/mouseleave to add a 'hover' class previewing fill up to the hovered star. Gate interactivity on item.isRegularItem(); non-regular items render dimmed non-clickable stars (or empty). getRating: scan Extra lines for /^\\s*rate\\s*:\\s*(\\d+)/i, clamp to [0,max]. COLLECTION COUNTS: registerWindow(win): if disabled return. Inject collectionCounts.css link. Access const tree = win.ZoteroPane.collectionsView. Feature-detect the per-row cell render method on the instance (verify exact name against Zotero 9.0.4 at build time via dev MCP; candidates: _renderItem / renderItem / the primary-cell builder). Save original, install an idempotent wrapper stamped fn.__styleroPatched: it calls the original to get the row node, then for rows whose getRow(index).ref instanceof Zotero.Collection, computes count(ref, mode) and appends/updates a single span.stylero-collection-count badge (remove any existing one first for recycle-safety). count(): 'child' = ref.getChildItems(false,false).length (direct, excluding deleted); 'offspring' = size of a Set of item IDs gathered recursively over ref + getChildCollections; 'both'/'bothReverse' = both numbers shown in chosen order. Cache counts per collectionID, invalidate on notify. After patching, force a repaint of all rows (tree.invalidate()/refresh) so existing rows get badges immediately. register(): registers a Zotero.Notifier observer on ['collection','item','collection-item'] that clears the count cache and calls tree.invalidate() on each main window to repaint. unregisterWindow restores the original method (delete stamp) and removes injected badge nodes; unregister unregisters the notifier.

## Zotero 9 APIs
- Zotero.ItemTreeManager.registerColumns
- Zotero.ItemTreeManager.unregisterColumns
- Zotero.Item.getCreators
- Zotero.Item.getField (firstCreator, extra)
- Zotero.Item.setField (extra)
- Zotero.Item.saveTx
- Zotero.Item.isRegularItem
- win.ZoteroPane.collectionsView (CollectionTree)
- collectionsView.getRow(index).ref
- collectionsView.tree.invalidate / collectionsView.refresh
- Zotero.Collection.getChildItems
- Zotero.Collection.getChildCollections
- Zotero.Collections.get
- Zotero.Notifier.registerObserver / unregisterObserver
- ztoolkit.UI.createElement
- Zotero.Prefs via getPref/setPref

## Edge cases
- Creator: single-field-mode creators (fieldMode===1, e.g. organizations) have empty firstName; template ${firstName} must resolve to '' and the join must not leave a dangling ', ' (collapse empty placeholder fragments).
- Creator: ${firstCreator} short-circuits whole-item formatting and ignores slice/join/template-of-individual-names; document that mixing ${firstCreator} with ${firstName}/${lastName} just uses firstCreator.
- Creator: items with zero creators return '' (not the join separator).
- Creator: slice pref blank or non-numeric -> treat as 0 (all); negative beyond list length -> whole list, no ellipsis.
- Rating: Extra may contain other plugin keys or unrelated lines -> must preserve all non-rate lines and only touch the single rate line; case-insensitive key match; tolerate extra whitespace.
- Rating: value out of range in Extra (e.g. 'rate: 9') -> clamp to [0,max].
- Rating: clicking on non-regular items / attachments -> dataProvider returns '0' and renderCell renders disabled (no listeners) to avoid writing Extra to notes/attachments; gate on item.isRegularItem().
- Rating: saveTx is async; concurrent rapid clicks -> serialize by reading fresh Extra inside setRating each time; the notify-driven refresh reconciles final state.
- Collection counts: 'My Library' root and special rows (Trash, Unfiled, Duplicates, feeds, group library roots) are not Zotero.Collection refs -> skip badge when getRow(index).ref is not a Collection.
- Collection counts: offspring mode must dedupe items that appear in multiple subcollections via a Set of item IDs; can be expensive for deep trees -> cache per collectionID and invalidate on notify.
- Collection counts: virtualized tree recycles row DOM -> wrapper must remove a previously injected badge before adding a new one (idempotent) to avoid duplicate badges on scroll/recycle.
- Collection counts: collapsing/expanding the tree re-renders rows -> handled because the badge is added inside the row render path, not appended once.
- Collection counts: 'child' mode counts direct items only (getChildItems with recursive=false) to match feature-12 'child-only' wording.

## Risks
- Collection-tree row renderer internals are private and version-fragile: the exact method name (e.g. _renderItem vs renderItem vs the React cell builder) may differ in Zotero 9.0.4. Mitigation: feature-detect the method at runtime, wrap defensively in try/catch so a failure degrades to 'no badges' rather than breaking the tree, and verify the real method via the Zotero dev MCP (zotero_execute_js / zotero_inspect_object on ZoteroPane.collectionsView) before coding.
- Patching an instance method must be reversible and idempotent; if registerWindow runs twice (multiple windows / reload) it could double-wrap. Mitigation: stamp the wrapper (fn.__styleroPatched=true) and skip if already patched; store the original for restore.
- Rating renderCell adds event listeners on every paint; with virtualization this could leak if the recycled node keeps stale closures. Mitigation: rebuild the cell DOM fresh each renderCell call, capture only the item id in closures and re-fetch the item, retain no external references.
- saveTx on the Extra field bumps dateModified, which users may not expect from clicking a star. Mitigation: document this; optionally use item.saveTx({ skipDateModifiedUpdate: true }) if supported in 9.0.4 (verify).
- Sorting the creator/rating columns is lexicographic on the dataProvider string; rating sorts as single digits which is fine for max<=9. Mitigation: keep max single-digit or zero-pad the dataProvider value.
- Offspring counting on very large libraries on every notify could be slow. Mitigation: cache + debounce invalidation, compute counts lazily only for visible rows.
- CSS injected via <link> persists until window unload; ensure unregisterWindow removes injected nodes or rely on ztoolkit.unregisterAll for toolkit-created elements so styles do not linger after disable.

## Integration notes
All three modules guard on their own '<feature>.enable' pref inside register()/registerWindow() and no-op when disabled. Creator column needs no per-window work. onMainWindowUnload should call CollectionCountsFactory.unregisterWindow(win) before ztoolkit.unregisterAll() so the patched collection-tree method is restored and injected badge nodes removed; onShutdown should call the unregister() methods. PREFS exports from each module are concatenated by integration into addon/prefs.js with the 'extensions.zotero.zoterostylero.' prefix applied by scaffold (keys are already namespaced like 'creatorColumn.template'). No shared files are edited by these modules themselves.

### Wiring
- onStartup: await CreatorColumnFactory.register(); await RatingColumnFactory.register(); CollectionCountsFactory.register()
- onMainWindowLoad: RatingColumnFactory.registerWindow(win); CollectionCountsFactory.registerWindow(win)
- CSS: addon/content/ratingColumn.css (injected by RatingColumnFactory.registerWindow); addon/content/collectionCounts.css (injected by CollectionCountsFactory.registerWindow)
