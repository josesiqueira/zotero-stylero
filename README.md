# Zotero Stylero

[![Zotero 9](https://img.shields.io/badge/Zotero-9-CC2936?style=flat-square&logo=zotero&logoColor=white)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg?style=flat-square)](LICENSE)

A clean, modern Zotero 9 plugin that brings styled item-table columns, reading-time
heat, progress bars, star ratings, collection counts, a knowledge graph, and
read/unread emphasis to your library.

Built from scratch on the [windingwind zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
(zotero-plugin-scaffold + zotero-plugin-toolkit v5), targeting Zotero 9 from day one.
It is an independent, clean-room reimplementation inspired by the behavior of the
original "Zotero Style" plugin — no code from that project is used.

## Features

| Feature | Default | What it does |
|---|---|---|
| **Read / unread emphasis** | on, visible | A narrow indicator column; unread items are shown **bold across the whole row**. Mirrors Zotero feed read state, with an option to extend to all items. |
| **Collection item counts** | on | Count badges on every collection-tree row (collections, My Library, group libraries, saved searches, Unfiled, Duplicates, Bin, etc.). Collection modes: child / offspring (recursive, deduped) / both / both-reversed. Toggle via **View → Show item counts**. |
| **Colored tag swatches** | on | Item tags shown as colored dots before the title (part of the Title column). |
| **Title column** | available (opt-in) | A decorated title column: reading-time **heat background**, file-type icon, odd/even striping, colored tags. Add it from the column picker (it complements the native Title column). |
| **Creator column** | available (opt-in) | Author list reformatted with a template (`${lastName}`, `${firstName}`, `${firstCreator}`), slicing, custom join, and ellipsis. |
| **Progress column** | available (opt-in, off) | Per-page annotation / reading distribution drawn as a bar / line / opacity / stack chart. |
| **Reading-time tracking** | on | Focus-gated sampler that accrues per-page dwell time while you read a PDF; feeds the Title heat background and the Progress column. Persisted locally. |
| **Graph view** | on | An Obsidian-style force-directed knowledge graph (related / author / tag / default modes) in its own tab. Open via **View → Stylero: Graph View** or `Ctrl/Cmd+Alt+G`. Dependency-free (no PIXI/d3 bundle). |

### A note on columns
Zotero registers custom columns hidden by default; Stylero ships the Read-state
column visible out of the box. Title, Creator and Progress are opt-in:
enable them from the item-table column picker (right-click the column header). The
whole-row unread bold depends on the Read-state indicator column being visible; if
you hide it, bolding turns off.

## Settings
Open **Zotero → Settings → Stylero**. Every feature has a toggle, plus options for
the creator template, count mode, progress style, graph mode/theme, and the
whole-row / all-items bold behavior.

## Install
Download `zotero-stylero.xpi` from the [latest release](../../releases/latest), then
in Zotero: **Tools → Plugins → gear icon → Install Plugin From File…** and pick the
`.xpi`. Requires Zotero 9.

## Development
```bash
npm install
npm run build        # build + typecheck -> .scaffold/build/zotero-stylero.xpi
npx tsc --noEmit     # typecheck only
npm test             # mocha unit/integration suite (needs a local .env, see .env.example)
```
- Feature modules live in `src/modules/`; lifecycle wiring is in `src/hooks.ts`.
- Design notes and the per-feature specs are under `doc/` (`PLAN.md`, `plan/`).
- A live smoke/UI test harness for a running Zotero is in `test/live/harness.js`,
  and the `stylero-test` skill (`.claude/skills/stylero-test/`) automates the
  build → install → live-test loop via the introfini Zotero dev MCP.
- CI (`.github/workflows/ci.yml`) runs typecheck + build on every push/PR.

## License
[AGPL-3.0-or-later](LICENSE). Inspired by MuiseDestiny/zotero-style (AGPL) and built
on windingwind/zotero-plugin-template (AGPL); this is an independent implementation.
