# Zotero Stylero — build contract (read before planning/coding)

Clean-room reimplementation of selected "Zotero Style" features for **Zotero 9.0.4
(Firefox 140)**, built on the **windingwind zotero-plugin-template v3.1.0**
(zotero-plugin-scaffold + zotero-plugin-toolkit **v5**). License AGPL-3.0-or-later.

## Hard rule: mimic BEHAVIOR, not code
Do NOT copy any source from the original AGPL `zotero-style` plugin. Work from the
behavior spec in `/home/jose/Documents/Zotero Plugin Project Final/zotero-style-FEATURES.md`.
Design and write original implementations.

## Project facts
- Plugin id: `zotero-stylero@jose.local`; ref: `zoterostylero`; instance global: `Zotero.ZoteroStylero`.
- Prefs prefix: `extensions.zotero.zoterostylero`. Access via `getPref("<key>")` / `setPref("<key>", v)` from `src/utils/prefs.ts`. Defaults live in `addon/prefs.js` as `pref("<key>", <default>)` (scaffold prepends the prefix).
- `addon.data.ztoolkit` is a toolkit v5 instance; `ztoolkit.unregisterAll()` runs on shutdown/window-unload.
- Build: `npx zotero-plugin build` → `.scaffold/build/zotero-stylero.xpi`. Type-check: `npx tsc --noEmit`.

## Module contract (every feature)
Create files ONLY under your assigned paths. Do NOT edit shared files
(`src/hooks.ts`, `src/addon.ts`, `addon/prefs.js`, `addon/content/zoteroPane.css`,
`addon/content/preferences.xhtml`). Integration wires those centrally.

Each feature = `src/modules/<feature>.ts` exporting a class `XxxFactory` with static methods:
- `static async register(): Promise<void>` — one-time global registration (columns, notifiers). Called once in `onStartup`.
- `static registerWindow(win: _ZoteroTypes.MainWindow): void` — per-window UI/decoration (collection-tree badges, graph panel, stylesheet). Called in `onMainWindowLoad`. Optional.
- `static unregisterWindow(win): void` / `static unregister(): void` — only for things NOT covered by `ztoolkit.unregisterAll()` (manual observers, intervals, injected DOM). Optional.
- Export a `const PREFS: Record<string, string|number|boolean>` of this feature's pref defaults (key → default), so integration can append them to `addon/prefs.js`. Keys namespaced like `titleColumn.enable`.

Feature CSS (if any): put in `addon/content/<feature>.css` (your own file) and inject via a `<link>` in `registerWindow` using `ztoolkit.UI.createElement`. Document it.

## Column registration pattern (Zotero 9 native API)
```ts
await Zotero.ItemTreeManager.registerColumns({
  pluginID: addon.data.config.addonID,
  dataKey: "stylero-rating",
  label: "Rating",
  dataProvider: (item, dataKey) => String(/* sortable value */),
  renderCell(index, data, column, isFirstColumn, doc) {
    const span = doc.createElement("span");
    span.className = `cell ${column.className}`;
    // build DOM (stars, bars, pills, heat background) here
    return span;
  },
});
```
`renderCell` returns a DOM node. Use it for: star ratings, progress bars, colored
tag swatches/pills, and reading-heat backgrounds. Keep cell rendering non-destructive
and cheap (it runs on every row paint and DOM is recycled/virtualized).

## Shared reading-time store (cross-feature dependency)
`src/modules/readingStore.ts` is owned by the reading-time bucket. It exposes a stable
interface consumed by the Title-heat and Progress columns:
```ts
export interface PageDwell { [page: number]: number /* seconds */ }
export const ReadingStore = {
  async init(): Promise<void>,
  getItemData(itemKey: string): { pages: PageDwell; total: number } | undefined,
  addDwell(itemKey: string, page: number, seconds: number): void, // persists (debounced)
  getMaxTotalInView(itemKeys: string[]): number, // for heat normalization
};
```
Persist to a JSON file in the Zotero profile dir via global `IOUtils`/`PathUtils`
(NOT the removed `OS.File`). Consumers import `ReadingStore` read-only.

## Zotero 9 gotchas (from prior porting work)
- `OS.File`/`OS.Path` removed → use `IOUtils`/`PathUtils` (globals). `IOUtils.exists` throws on non-absolute paths.
- `Zotero.Promise.coroutine` removed → use native `async`/`await`.
- `ChromeUtils.import(...jsm)` removed → `Services` is a global; use `ChromeUtils.importESModule` for real modules.
- Item/collection trees are virtualized and recycle row DOM — decorate idempotently, never clear native content.
- `item.getImageSrc()` gives the item-type icon URL for the file-type icon swap.
- Read/unread mirrors Zotero RSS read state: `item.isRead` exists for feed items; for the "bold whole line" requirement, bold every cell in unread rows via the row/cell render hook + CSS class, scoped to feeds (or all items per pref).
```
