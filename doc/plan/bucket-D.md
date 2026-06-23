# Bucket D - implementation spec

## Features
- Feature 8: Progress column - per-page annotation distribution for an item's PDF attachments, drawn in renderCell as a compact inline bar chart by default, with optional line / opacity-heat / stacked styles selectable via a style pref. Bars are normalized per-item (default) or globally across the visible view.
- Feature 8 (data source 2): the same column can reflect ReadingStore dwell distribution per page instead of (or blended with) annotation counts, selected by a source pref (annotations | reading | both).
- Feature 19: Read/Unread emphasis mirroring Zotero feed read state (item.isRead). Unread feed items are rendered bold; read items normal.
- USER ENHANCEMENT: whole-row bold for unread items - every column in an unread row is bold, not just the title, implemented via a single marker cell that sets a row-level data attribute plus a CSS :has() rule (with a JS class-toggle fallback).
- Pref to extend bolding to ALL regular items (not only feeds): when on, an item is treated as unread/bold unless explicitly marked read, so any regular item can carry the bold emphasis.
- Right-click column-header visibility and native column ordering work because both columns register through Zotero.ItemTreeManager (they appear in the column picker automatically).

## Files to create (use these EXACT relative paths)
- `src/modules/progressColumn.ts`: Feature 8. Exports class ProgressColumnFactory with static register()/unregister() and PREFS. Registers the 'stylero-progress' item-tree column via Zotero.ItemTreeManager.registerColumns; computes per-page annotation distribution (and/or ReadingStore dwell) for the item's PDF attachments and draws a bar/line/opacity/stack mini chart in renderCell. Read-only import of ReadingStore from readingStore.ts.
- `src/modules/readState.ts`: Feature 19 + enhancement. Exports class ReadStateFactory with static register()/registerWindow()/unregisterWindow() and PREFS. Registers a hidden zero-width 'stylero-readstate' marker column whose renderCell tags the owning row with data-stylero-unread, injects readState.css per window, and registers a Zotero.Notifier observer so toggling read/unread repaints rows.
- `addon/content/progressColumn.css`: Styles for the Progress column mini chart (bar/line/opacity/stack track, bar fill color via CSS var, empty-state). Injected per-window by ProgressColumnFactory.registerWindow via a <link> created with ztoolkit.UI.createElement.
- `addon/content/readState.css`: Whole-row bold rule. Primary rule uses :has() on the marker cell so every cell in an unread row is bold; fallback rule keys off a class on the .row element. Injected per-window by ReadStateFactory.registerWindow.

## Public API
```ts
// src/modules/progressColumn.ts
export type ProgressStyle = "bar" | "line" | "opacity" | "stack";
export type ProgressSource = "annotations" | "reading" | "both";
export class ProgressColumnFactory {
  static readonly DATA_KEY = "stylero-progress";
  // one-time: registers the item-tree column (no-op if progressColumn.enable is false)
  static async register(): Promise<void>;
  // per-window: injects progressColumn.css
  static registerWindow(win: _ZoteroTypes.MainWindow): void;
  // manual cleanup of injected DOM (column itself is freed by ztoolkit.unregisterAll)
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void;
  static unregister(): void;
}
export const PREFS: Record<string, string | number | boolean>;

// src/modules/readState.ts
export class ReadStateFactory {
  static readonly DATA_KEY = "stylero-readstate";
  // one-time: registers the hidden marker column + a Zotero.Notifier observer
  static async register(): Promise<void>;
  // per-window: injects readState.css
  static registerWindow(win: _ZoteroTypes.MainWindow): void;
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void;
  static unregister(): void; // unregisters the notifier observer
}
export const PREFS: Record<string, string | number | boolean>;
```

## Prefs (export as PREFS; integration adds defaults to addon/prefs.js)
- `progressColumn.enable` (boolean, default false): Master toggle for the Progress column (off by default, matching the original). When false, register() does not register the column.
- `progressColumn.style` (string, default bar): Chart style: bar | line | opacity | stack. Controls how the per-page distribution is drawn in renderCell.
- `progressColumn.source` (string, default annotations): Data source for the distribution: annotations (count per page from item annotations), reading (per-page dwell seconds from ReadingStore), or both (annotations as bars + reading as opacity heat).
- `progressColumn.normalize` (string, default item): Bar height normalization basis: item (scale to the item's own max page value) or view (scale to the max across visible rows for cross-item comparison).
- `progressColumn.color` (string, default #e8694a): Base fill color of the chart, exposed to the CSS via a custom property so the stylesheet controls the exact rendering.
- `progressColumn.maxBuckets` (number, default 40): Maximum number of page buckets drawn; pages beyond this are aggregated so very long PDFs stay cheap to paint.
- `readState.enable` (boolean, default true): Master toggle for read/unread emphasis. When false, no marker column or stylesheet is registered.
- `readState.boldAllItems` (boolean, default false): When true, extend bold emphasis to all regular items (treat any item as unread/bold unless explicitly marked read), not only RSS feed items.
- `readState.wholeRow` (boolean, default true): When true, bold every cell in an unread row (the user enhancement). When false, only the title/primary cell is bolded.

## Rendering / data-flow
SEE_DETAIL

## Zotero 9 APIs
- Zotero.ItemTreeManager.registerColumns({ pluginID, dataKey, label, dataProvider, renderCell, fixedWidth?, width? }) - native Zotero 9 column registration (per examples.ts and contract)
- Zotero.ItemTreeManager.unregisterColumns(dataKey) - explicit column removal (also covered by ztoolkit.unregisterAll via pluginID)
- renderCell(index, data, column, isFirstColumn, doc) => HTMLElement - return a freshly built DOM node; column.className gives the per-column class
- dataProvider(item, dataKey) => string - sortable cell value
- item.getAttachments() => number[] (attachment item ids); Zotero.Items.get(id) to resolve
- attachment.attachmentContentType (=== 'application/pdf') and attachment.isPDFAttachment() to filter PDF attachments
- attachment.getAnnotations() => Zotero.Item[] annotation items
- annotationItem.annotationPosition (JSON string; JSON.parse(...).pageIndex gives 0-based page) and annotationItem.annotationPageLabel (display label fallback)
- item.isFeedItem and item.isRead - native feed read-state getters mirrored for Feature 19
- item.isRegularItem() - gate the boldAllItems path
- Zotero.Notifier.registerObserver(callback, ['item','feedItem']) / Zotero.Notifier.unregisterObserver(id) - live repaint on read-state change
- ZoteroPane.itemsView (the ItemTree instance) with .getRow(index).ref to resolve the Zotero.Item, and .tree.invalidate()/.invalidateRow(index) to force repaint
- doc.createElement / doc.createElementNS('http://www.w3.org/2000/svg', ...) for native SVG line charts (no Raphael)
- Element.closest('.row') and Element.toggleAttribute for the whole-row marker
- ztoolkit.UI.createElement(doc, 'link', { properties: { rel:'stylesheet', href } }) for per-window CSS injection
- IOUtils / PathUtils (globals) only indirectly, via the shared ReadingStore for the 'reading' source

## Edge cases
- Item has no PDF attachments or no annotations: Progress column renders an empty muted track (and dataProvider returns '0' so it sorts to the bottom).
- Annotation lacks annotationPosition JSON (e.g. ink/image edge cases): fall back to annotationPageLabel parsed to an integer; if neither parses, skip the annotation.
- Very long PDFs / thousands of annotations: cap rendering at progressColumn.maxBuckets buckets and aggregate, and keep dataProvider O(annotations) without parsing positions to stay cheap on sort.
- Virtualized row recycling: renderCell must fully rebuild its subtree every call and never append to existing content; the read-state marker must use toggleAttribute (idempotent) not append.
- renderCell cannot reach the attached .row synchronously (cell not yet in the DOM): set the data attribute on the cell itself for the :has() selector AND schedule a requestAnimationFrame closest('.row') toggle as fallback.
- Non-feed items when readState.boldAllItems is false: isUnread stays false so no bolding, matching native behavior.
- boldAllItems = true needs a 'read' flag store for regular items (which have no native isRead); default everything unread - document that marking-read persistence is a small per-item flag, not native state.
- Multiple main windows: CSS injected per window in registerWindow; unregisterWindow removes the injected <link> to avoid duplicates on reload.
- Group libraries / read-only items: progress is render-only and never writes, so it is safe; read-state boldAllItems flag writes (if any) must be guarded by item.library.editable.
- Column picker / reordering: both columns appear in the native header context menu automatically; the read-state marker column is intentionally minimal width and labeled clearly so users can hide it.

## Risks
- Whole-row bold via :has() depends on the exact Zotero 9 item-tree DOM (.row > .cell structure) and on the marker cell being a direct child of .row; if Zotero changes the row/cell class names or nesting, the selector breaks - mitigated by the rAF class-toggle fallback and by keying off column.className.
- There is no public Zotero 9 per-row render hook, so whole-row styling is necessarily achieved through a per-cell marker + CSS rather than a true row callback; this is the cleanest non-patching approach but is CSS-structure-dependent.
- Resolving the Zotero.Item inside renderCell relies on ZoteroPane.itemsView.getRow(index).ref; if the active itemsView differs per window this must use the cell's owner window's ZoteroPane, not the global one.
- annotationPosition pageIndex is 0-based and PDF.js page labels may differ from physical indices; mixing label-based fallback with index-based counts could misplace a few bars (documented, low impact for a distribution sparkline).
- boldAllItems read-tracking for regular items has no native backing store; choosing Extra field vs a JSON side-store is a design decision with sync implications - kept minimal and defaulted off.
- Live repaint via itemsView.tree.invalidate() on every read-state notify could be heavy on large libraries; should invalidate only affected rows where possible.
- Progress column off by default per spec; if integration enables it broadly, the per-row annotation gathering (getAttachments/getAnnotations) on every paint could be noticeable - consider a small per-item memo cache keyed by item.id + item version if performance is an issue.

## Integration notes
Both columns register through Zotero.ItemTreeManager.registerColumns with pluginID = addon.data.config.addonID, so they are torn down by ztoolkit.unregisterAll() on shutdown/window-unload; the only manual teardown is the ReadState Zotero.Notifier observer (unregister via Zotero.Notifier.unregisterObserver in ReadStateFactory.unregister) and the injected <link> nodes (removed in unregisterWindow). onMainWindowUnload already calls ztoolkit.unregisterAll(); add ReadStateFactory.unregister() to onShutdown. addon/prefs.js gets the eight pref() lines from the two PREFS exports (scaffold prepends extensions.zotero.zoterostylero). No shared files are edited by the modules themselves; integration wires hooks.ts/addon/prefs.js centrally. CSS files live under addon/content next to the existing zoteroPane.css and are served at chrome://zoterostylero/content/. Firefox 140 supports CSS :has(), which is what makes the single-marker whole-row bold possible.

### Wiring
- onStartup: await ProgressColumnFactory.register();; await ReadStateFactory.register();
- onMainWindowLoad: ProgressColumnFactory.registerWindow(win);; ReadStateFactory.registerWindow(win);
- CSS: chrome://zoterostylero/content/progressColumn.css (injected by ProgressColumnFactory.registerWindow via ztoolkit.UI.createElement <link>); chrome://zoterostylero/content/readState.css (injected by ReadStateFactory.registerWindow via ztoolkit.UI.createElement <link>)
