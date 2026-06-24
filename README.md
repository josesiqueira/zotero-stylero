# Zotero Stylero

[![Zotero 9](https://img.shields.io/badge/Zotero-9-CC2936?style=flat-square&logo=zotero&logoColor=white)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg?style=flat-square)](LICENSE)

Zotero Stylero adds styled item-table columns, collection counts, reading-time
tracking, read/unread emphasis, a knowledge-graph view, and a one-click light/dark
switch to Zotero 9. It is deliberately lightweight and dependency-free: the only
runtime dependency is the Zotero plugin toolkit, and even the graph is hand-rolled
on a 2D canvas (no PIXI, no d3).

## Features

| Feature | Default | What it does |
|---|---|---|
| Read / unread emphasis | On | Bolds unread items across the whole row, no column needed. Out of the box this applies to unread feed items; an option extends bolding to all items. |
| Unread column | On, shown | A dot for items carrying the `.unread` tag (the tag is configurable and is the source of truth). Sortable. |
| Rating column | On, shown | Interactive 0 to 5 stars stored as an all-star (`⭐`) tag. Click a star to set the rating, click the current rating to clear it. Can hide the star tag from the title. |
| Creator column | On, add from picker | Author list reformatted with a template (`${lastName}`, `${firstName}`, `${firstCreator}`), with first/last-N slicing, a custom separator, and an "et al." ellipsis. Registered but hidden until you add it from the column picker. |
| Collection counts | On | Item-count badges on collection-tree rows: collections, My Library, group libraries, saved searches, Unfiled, Duplicates, and Trash. Modes: child, offspring (recursive), or both. Toggle from View, Show item counts. |
| Progress column | Off (opt-in) | A compact per-page mini-chart of annotation and/or reading-time distribution across a PDF, drawn as a bar, line, opacity, or stacked chart. Enable it in settings. |
| Reading-time tracking | On | A focus-gated sampler that records per-page dwell time while you read a PDF, saved to a local JSON file. It feeds the Progress column when that column's source includes reading. |
| Graph view | On | A force-directed knowledge graph of your library in its own tab. Connect items by related links, shared authors, or shared tags; drag and pin nodes, pan, zoom, and click a node to sync the selection with the item list. Open from View, Stylero: Graph View, or `Ctrl/Cmd+Alt+G`. |
| Light / dark toggle | On | A sun and crescent-moon button in the tab bar that flips Zotero's whole appearance between light and dark. It drives the same setting as Zotero's own Appearance preference, so it is a true app-wide switch. |

### Which columns show by default
The Unread and Rating columns are visible out of the box. The Creator column is
registered but hidden until you add it from the item-list column picker (right-click
the header). The Progress column is off entirely until you enable it in settings.
The read/unread bolding needs no column at all.

## Settings
Open Zotero, Settings, Stylero. Each feature has a toggle, plus options for the
creator template, count mode, progress chart style, graph mode and theme, and the
read/unread bolding behavior. A full as-built list of every preference is in
[`doc/FEATURES.md`](doc/FEATURES.md).

## Install
Download `zotero-stylero.xpi` from the [latest release](../../releases/latest), then
in Zotero: Tools, Plugins, gear icon, Install Plugin From File, and pick the `.xpi`.

## Compatibility
Built and tested for Zotero 9 (9.0.4 and later). The manifest version range is
permissive, but only Zotero 9 is supported.

## Development
```bash
npm install
npm start          # live-reload dev against a running Zotero
npm run build      # build + typecheck -> .scaffold/build/zotero-stylero.xpi
npx tsc --noEmit   # typecheck only
npm test           # mocha suite (launches a real Zotero; run locally)
```
Each feature is a small `XxxFactory` in `src/modules/`; lifecycle wiring is in
`src/hooks.ts`. The only runtime dependency is `zotero-plugin-toolkit`. CI runs
typecheck and build on every push and PR.

## License
[AGPL-3.0-or-later](LICENSE). Built on the
[windingwind zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) (AGPL).
