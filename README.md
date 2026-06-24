# Zotero Stylero

[![Zotero 9](https://img.shields.io/badge/Zotero-9-CC2936?style=flat-square&logo=zotero&logoColor=white)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg?style=flat-square)](LICENSE)

A Zotero 9 plugin that adds styled item-table columns, reading-time tracking, a star
rating, collection counts, read/unread emphasis, and a knowledge-graph view.

Independent, clean-room implementation inspired by the original "Zotero Style" plugin
(no code reused), built on the [windingwind plugin template](https://github.com/windingwind/zotero-plugin-template).

## Features

| Feature | Default | What it does |
|---|---|---|
| Read / unread emphasis | on | Unread rows shown bold across the whole row (no column). |
| Unread column | on | A dot for items carrying the `.unread` tag. Sortable. |
| Rating column | on | Interactive 5-star rating backed by a star tag. Click to set, click current to clear. |
| Collection counts | on | Item-count badges on every collection-tree row. Toggle via View, Show item counts. |
| Creator column | opt-in | Author list reformatted via a template, with slicing and the item-type icon. |
| Progress column | opt-in | Per-page reading distribution as a bar / line / opacity / stack chart. |
| Reading-time tracking | on | Focus-gated sampler that accrues per-page dwell time while reading a PDF. |
| Graph view | on | Force-directed knowledge graph in its own tab. View menu or `Ctrl/Cmd+Alt+G`. |

Custom columns can be shown or hidden from the item-table column picker (right-click the
header). Per-feature toggles and options live in Zotero, Settings, Stylero.

## Install

Download `zotero-stylero.xpi` from the [latest release](../../releases/latest), then in
Zotero: Tools, Plugins, gear icon, Install Plugin From File. Requires Zotero 9.

## Development

```bash
npm install
npm run build      # build + typecheck -> .scaffold/build/zotero-stylero.xpi
npx tsc --noEmit   # typecheck only
npm test           # mocha suite (needs a local .env, see .env.example)
```

Feature modules live in `src/modules/`; lifecycle wiring is in `src/hooks.ts`. Design
notes are under `doc/`. CI runs typecheck and build on every push and PR.

## License

[AGPL-3.0-or-later](LICENSE). Inspired by MuiseDestiny/zotero-style (AGPL) and built on
windingwind/zotero-plugin-template (AGPL); an independent implementation.
