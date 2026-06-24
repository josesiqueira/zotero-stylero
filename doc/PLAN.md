# Zotero Stylero — implementation plan

Clean-room Zotero 9 reimplementation of selected "Zotero Style" features, on the
windingwind template v3.1.0 (scaffold + toolkit v5). Behavior-mimicking only.
Per-bucket specs: `doc/plan/bucket-{A..E}.md`. Build contract: `doc/STYLERO_CONTRACT.md`.

## Feature → file map
| Bucket | Features | Files |
|---|---|---|
| A | Reading-time tracking (16) + shared store | `src/modules/readingStore.ts`, `src/modules/readingTime.ts` |
| B | Title column (1): heat bg, file-type icon, striping, colored tags | `src/modules/titleColumn.ts`, `addon/content/titleColumn.css` |
| C | Creator (2), Collection counts (12) | `src/modules/creatorColumn.ts`, `src/modules/collectionCounts.ts` + CSS |
| D | Progress column (8), Read/Unread whole-row bold (19) | `src/modules/progressColumn.ts`, `src/modules/readState.ts` + CSS |
| E | Graph View (18): lightweight, no PIXI vendor | `src/modules/graphView.ts`, `src/modules/graphView/*.ts`, `addon/content/graphView.css` |

## Cross-bucket dependency
`readingStore.ts` (A) is imported read-only by B (title heat) and D (progress, when source=reading|both). Coded against the contract interface; integration validates at build.

## Module contract (enforced)
Each feature = `XxxFactory` with static `register()` / `registerWindow(win)` / optional `unregister*`, plus an exported `PREFS` map. Cleanup via `ztoolkit.unregisterAll()` except manual intervals/observers/DOM (A's sampler, tree decorations) which provide explicit unregister. Coding agents create ONLY their own files; integration owns `src/hooks.ts`, `addon/prefs.js`, and stylesheet wiring.

## Integration order (onStartup)
1. `await ReadingTimeFactory.register()` (must precede heat/progress columns)
2. column registrations: Title, Creator, Progress
3. `CollectionCountsFactory.register()`, `ReadStateFactory.register()`, `GraphViewFactory.register()`
Then per window: each factory's `registerWindow(win)`.

## Phases after coding
Integration (wire hooks/prefs/CSS, strip examples, build+install+live-fix) → test suite + testing skill (smoke/unit/UI/live) → multi-agent review → GitHub repo `zotero-stylero` + 0.0.1 release.
