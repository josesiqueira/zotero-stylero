# Zotero Stylero — as-built feature & preference reference

This is the authoritative description of what the shipped plugin actually does,
verified against the source. Where the older `doc/plan/bucket-*.md` design specs
disagree, this file wins. Target: Zotero 9 (9.0.4 and later).

The plugin registers nine user-facing features plus one shared internal helper.
Each feature is a `XxxFactory` class under `src/modules/`, wired in `src/hooks.ts`.

## Features

### Reading-time tracking (`readingTime.ts`, `readingStore.ts`)
On by default; no UI of its own. A focus-gated sampler arms a per-window interval
(default 10s) that credits per-page dwell seconds to the PDF you are reading, only
while that reader is the focused, visible tab. Idle reset is off by default. Data is
written atomically and debounced to `<Zotero data dir>/zoterostylero/reading-time.json`
as `{ version, items: { key: { pages, total } } }`. Corrupt files are backed up, not
overwritten. It feeds the Progress column only when that column's source is set to
`reading` or `both`.

> Note: there is no "title heat" or row-background heat. An earlier design had a
> Title column that tinted rows by reading time; it was dropped. Only the Progress
> column visualizes reading time.

### Creator column (`creatorColumn.ts`)
On by default, but the column is hidden until you add it from the column picker.
Sortable plain-text column ("Creators (Stylero)") that reformats each item's creator
list with a template. Placeholders: `${firstName}`, `${lastName}`, `${firstCreator}`.
Supports first-N / last-N slicing, a custom join separator, and an ellipsis suffix
when truncated. Using `${firstCreator}` short-circuits to Zotero's computed field and
ignores slice/join.

### Unread column (`unreadColumn.ts`)
On and visible by default. A fixed-width sortable column showing a dot for items that
carry the `.unread` tag (configurable). The tag is the source of truth; the column is
read-only (clicking the dot does nothing). Toggle unread by adding/removing the tag.

### Rating column (`ratingColumn.ts`)
On and visible by default. An interactive star column whose value is stored as a
single all-star tag (a tag of N `⭐` characters). Click a star to set the rating; click
the current rating to clear it. Default max is 5 (1 to 9 supported). With
`ratingColumn.hideFromTitle` on, the star tag's swatch is stripped from the title cell
via the shared row decorator. Source of truth is the tag, not the Extra field.

### Collection counts (`collectionCounts.ts`)
On by default. Appends a muted count badge to collection-tree rows: real collections,
My Library, group-library roots, saved searches, My Publications, Duplicate Items,
Unfiled Items, and Trash. Counts are top-level items only (child attachments/notes
excluded). Collection modes: `child` (direct items), `offspring` (recursive, deduped),
`both` (`child / offspring`), `bothReverse` (`offspring / child`). Controlled by a
View-menu checkbox ("Show item counts") and a settings menulist; repaints live on pref
and library changes.

### Progress column (`progressColumn.ts`)
Off by default (fully opt-in: nothing registers until enabled). A compact per-page
mini-chart over an item's PDF attachments. Source: `annotations` (default), `reading`
(dwell from the reading store), or `both`. Styles: `bar`, `line`, `opacity`, `stack`.
Normalization: per `item` or across the visible `view`. Pages are aggregated into at
most `maxBuckets` buckets. Render-only; never writes (safe in read-only libraries).

### Read / unread emphasis (`readState.ts`)
On by default. Adds a row decorator that bolds unread items. Out of the box only
unread feed items are bolded (`isRead === false`), whole-row by default. An option
(`boldAllItems`) extends the notion of "unread" to regular items, using an internal
read-set keyed by item key.

> Known limitation: there is no command/UI to mark a regular item as "read", so with
> `boldAllItems` on, regular items effectively stay bold. The feature is reliable for
> feed read-state; the all-items mode is best treated as experimental.

> The library knowledge graph that used to live here has moved to its own plugin,
> [Zotero Bibliometero](https://github.com/josesiqueira/zotero-bibliometero). Stylero
> no longer ships any graph code.

### Light / dark toggle (`themeToggle.ts`)
On by default. A sun / crescent-moon `toolbarbutton` in the tab toolbar, left of the
"List all tabs" button. It flips `browser.theme.toolbar-theme` (0 dark, 1 light, 2
auto), the same preference Zotero's Settings, General, Appearance radio writes, so it
changes the whole app. The icon shows the action a click performs (moon while light,
sun while dark) and stays in sync via pref and system-theme listeners.

### Reader selection overlay (`readerSelection.ts`)
On by default (toggle via `readerSelection.enable`). Replaces Zotero's native
light-blue text-selection band in the PDF reader with a snug, Mendeley-style colored
band. The native selection mechanics (copy, annotate, right-click) are preserved; only
the visual appearance changes.

Visual anatomy: the band sits tightly around the selected text rather than spanning the
full line height. Optional end-handle bars (`readerSelection.handles`) add a filled
circle at the top of the selection start and at the bottom of the selection end, in the
handle color (`readerSelection.handleColor`), echoing Mendeley's selection handles.

The feature manages PDF reader windows itself and does not participate in the
`registerWindow` / `unregisterWindow` main-window lifecycle. It hooks into reader
events on `register()` and cleans up fully on `unregister()`. There is no
`onMainWindowLoad` / `onMainWindowUnload` involvement.

> Note: this styles the live text selection only. Saved highlight annotations are
> unaffected and continue to use Zotero's annotation rendering.

### Shared row decorator (`itemRowDecorator.ts`) — internal
Not a user feature. A single monkey-patch of the item-tree row renderer that lets
features post-process each row. Currently used by the rating column (title-swatch
strip) and read-state (bolding). Zotero 9 specific.

## Preferences

All keys are under `extensions.zotero.zoterostylero.`. Only some are exposed in the
settings pane; the rest are tunable via the config editor.

| Pref key | Default | Feature |
|---|---|---|
| `readingTime.enable` | `true` | Reading-time |
| `readingTime.sampleIntervalMs` | `10000` | Reading-time |
| `readingTime.hangGuardMs` | `60000` | Reading-time |
| `readingTime.idleResetMs` | `0` | Reading-time |
| `readingTime.persistDebounceMs` | `5000` | Reading-time |
| `creatorColumn.enable` | `true` | Creator column |
| `creatorColumn.template` | `${lastName}, ${firstName}` | Creator column |
| `creatorColumn.join` | `; ` | Creator column |
| `creatorColumn.slice` | `0` | Creator column |
| `creatorColumn.ellipsis` | ` et al.` | Creator column |
| `unreadColumn.enable` | `true` | Unread column |
| `unreadColumn.tag` | `.unread` | Unread column |
| `ratingColumn.enable` | `true` | Rating column |
| `ratingColumn.max` | `5` | Rating column |
| `ratingColumn.hideFromTitle` | `true` | Rating column |
| `collectionCounts.enable` | `true` | Collection counts |
| `collectionCounts.mode` | `child` | Collection counts |
| `progressColumn.enable` | `false` | Progress column |
| `progressColumn.style` | `bar` | Progress column |
| `progressColumn.source` | `annotations` | Progress column |
| `progressColumn.normalize` | `item` | Progress column |
| `progressColumn.color` | `#e8694a` | Progress column |
| `progressColumn.maxBuckets` | `40` | Progress column |
| `readState.enable` | `true` | Read/unread emphasis |
| `readState.boldAllItems` | `false` | Read/unread emphasis |
| `readState.wholeRow` | `true` | Read/unread emphasis |
| `readState.readKeys` | `""` | Read/unread emphasis (internal) |
| `themeToggle.enable` | `true` | Light/dark toggle |
| `readerSelection.enable` | `true` | Reader selection overlay |
| `readerSelection.color` | `#8C6FE6` | Reader selection overlay (band color) |
| `readerSelection.opacity` | `40` | Reader selection overlay (band opacity, percent 0-100) |
| `readerSelection.tightness` | `72` | Reader selection overlay (band height as percent of line height; 100 = full height) |
| `readerSelection.handles` | `true` | Reader selection overlay (ball end-handles) |
| `readerSelection.handleColor` | `#2F6BE0` | Reader selection overlay (handle bar/ball color) |

## Settings pane groups
Item-table columns (Creator + template, Progress + style, Unread, Rating + hide),
Collections & state (Collection counts + mode, Read/unread emphasis + whole-row +
all-items), Reading time (enable), Appearance
(light/dark toggle).

## Build & compatibility
- `npm start` (serve), `npm run build` (build + `tsc --noEmit`), `npx tsc --noEmit`,
  `npm test` (mocha, needs a real Zotero binary, run locally), `npm run lint:check`.
- Build output: `.scaffold/build/zotero-stylero.xpi`.
- CI runs `tsc --noEmit` + build on every push and PR (no test, the runner has no
  Zotero binary).
- Only runtime dependency: `zotero-plugin-toolkit`.
- Zotero 9 only. The manifest range (`6.999` to `10.*`) is the template default, not a
  tested support claim.
