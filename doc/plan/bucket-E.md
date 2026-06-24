# Bucket E - implementation spec

> **As-built note:** Shipped as designed (dependency-free Canvas2D graph). See
> [`doc/FEATURES.md`](../FEATURES.md) for the user-facing summary.


## Features
- Graph View (feature 18): Obsidian-style force-directed knowledge graph rendered to a 2D canvas with a hand-rolled velocity-Verlet force simulation (no PIXI, no d3-force, zero new runtime deps).
- Four modes via a header dropdown/segmented control: 'related' (Zotero relateditem links), 'author' (co-authorship edges), 'tag' (shared-tag edges), and 'default' (a help/splash panel explaining the modes and showing a quick-start).
- Light/dark theme that follows Zotero's active theme (window matchMedia('(prefers-color-scheme: dark)') plus a manual override pref).
- Two-way selection sync: clicking a node selects that item in the active ZoteroPane itemsView; selecting item(s) in the tree highlights/centres the matching node(s) and dims the rest.
- Scope control: build the graph from the current collection/view (default), the current selection plus neighbours, or the whole library (capped). Re-builds reactively on collection/item/select notifier events (debounced).
- Interactive canvas: drag nodes (pins them, fixed during sim), pan (drag background), zoom (wheel), hover tooltip with item title/type, double-click a node to open the item, node radius scaled by degree, edge thickness/opacity by weight.
- Performance guardrails: node cap pref with a 'too many nodes' notice, simulation auto-cools (alpha decay) and stops when settled, requestAnimationFrame render loop that parks itself when the tab/panel is hidden.

## Files to create (use these EXACT relative paths)
- `src/modules/graphView.ts`: The feature module. Exports class GraphViewFactory with static register()/registerWindow()/unregisterWindow()/unregister() and a PREFS export. Owns: registering the custom 'Graph' tab via Zotero_Tabs (per window), mounting the canvas host DOM, wiring the mode selector + scope control, the notifier observer for two-way sync, the rAF render loop, and the CSS <link> injection. Delegates simulation to ForceSim and data assembly to GraphData.
- `src/modules/graphView/forceSim.ts`: Dependency-free force-directed layout engine. Pure TS class ForceSim implementing many-body repulsion (Barnes-Hut quadtree approximation), spring/link force, centering gravity, and velocity-Verlet integration with alpha cooling. No DOM, no Zotero references, fully unit-testable. Exposes tick(), setGraph(), pin()/unpin(), and reheat().
- `src/modules/graphView/graphData.ts`: Builds {nodes, edges} from Zotero APIs for each mode (related/author/tag). Pure data layer; takes an array of Zotero.Item and a mode, returns a normalized GraphModel. Handles weighting, de-duplication, degree computation, and the node cap. No rendering.
- `src/modules/graphView/renderer.ts`: Canvas2D renderer. Class GraphRenderer draws edges then nodes then labels using a Theme palette, applies the pan/zoom transform, hit-tests pointer coords to a node, and paints selection/hover/dim states. No simulation logic; consumes positions from ForceSim.
- `addon/content/graphView.css`: Own CSS file (per contract) for the tab chrome: the toolbar/segmented control, mode dropdown, scope dropdown, the help splash layout, tooltip bubble, and the canvas host sizing. Injected via a <link> created with ztoolkit.UI.createElement in registerWindow.

## Public API
```ts
export interface GraphNode { id: number; key: string; label: string; itemType: string; degree: number; x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null; }
export interface GraphEdge { source: number; target: number; weight: number; }
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; }
export type GraphMode = "default" | "related" | "author" | "tag";

export class GraphViewFactory {
  static async register(): Promise<void>;            // one-time: notifier observer, pref read; no global UI
  static registerWindow(win: _ZoteroTypes.MainWindow): void;   // per-window: inject CSS, add tab-open command (menu/keyboard), prepare lazy mount
  static unregisterWindow(win: _ZoteroTypes.MainWindow): void; // close our tab, stop rAF loop for this win, remove listeners
  static unregister(): void;                          // unregister notifier observer
  static PREFS: Record<string, string | number | boolean>;
  // internal (not part of contract): static openTab(win), static rebuild(win), static onSelectSync(ids)
}

export class GraphData {
  static build(items: Zotero.Item[], mode: GraphMode, cap: number): Promise<GraphModel>;
}

export class ForceSim {
  constructor(opts?: { charge?: number; linkDistance?: number; gravity?: number; alphaDecay?: number; });
  setGraph(model: GraphModel): void;
  tick(): boolean;            // advances one step; returns false when cooled/settled
  reheat(): void;             // restore alpha (after rebuild or drag)
  pin(id: number, x: number, y: number): void;
  unpin(id: number): void;
}

export class GraphRenderer {
  constructor(canvas: HTMLCanvasElement, theme: "light" | "dark");
  setTheme(theme: "light" | "dark"): void;
  draw(model: GraphModel, view: { scale: number; tx: number; ty: number }, sel: Set<number>, hover: number | null): void;
  hitTest(px: number, py: number, model: GraphModel, view: { scale: number; tx: number; ty: number }): GraphNode | null;
}
```

## Prefs (export as PREFS; integration adds defaults to addon/prefs.js)
- `graphView.enable` (boolean, default true): Master toggle for the Graph View feature. When false, register()/registerWindow() do nothing and no tab/command is added.
- `graphView.mode` (string, default default): Last-used graph mode: one of default | related | author | tag. Restored when the tab is reopened.
- `graphView.scope` (string, default view): Data scope for graph building: view (current collection/saved-search items) | selection (selected items + neighbours) | library (whole library, capped).
- `graphView.theme` (string, default auto): Theme override: auto (follow Zotero/OS) | light | dark.
- `graphView.nodeCap` (number, default 400): Maximum number of nodes to render. Beyond this the graph is truncated and a notice is shown to keep the canvas responsive.
- `graphView.showLabels` (boolean, default true): Whether to draw node text labels (titles/author names/tag names). Disabling improves perf on large graphs.
- `graphView.charge` (number, default -220): Many-body repulsion strength for the force simulation (more negative = nodes spread further apart).
- `graphView.linkDistance` (number, default 60): Target spring rest length (px) for edges in the force simulation.

## Rendering / data-flow
Placement decision: a custom main-area TAB via win.Zotero_Tabs, NOT a panel under the item tree and NOT an item-pane section. Rationale: (1) Zotero 9's center pane is the Zotero_Tabs deck; the library and each reader are tabs. There is no supported, stable insertion point 'below the item tree' in Z9 without patching private collectionsView/itemsView splitter internals, which the contract forbids (no editing shared files, no patching private tree internals). (2) Zotero_Tabs.add({type:'<addon>-graph', title, data, select, onClose}) returns {id, container} and gives us a full-size, owned container element to mount a <canvas> into, with lifecycle callbacks and free show/hide we can hook for parking the rAF loop. (3) An item-pane section (Zotero.ItemPaneManager.registerSection) is too narrow/short for a force graph and is item-scoped, which fights the multi-item graph concept. So: a dedicated 'Graph' tab, opened from a View-menu item and a keyboard shortcut, is the feasible, contract-compliant choice.

Mount + DOM: in registerWindow we lazily create the tab only on first open (openTab). The tab container gets a flex column: a toolbar row (mode segmented control, scope dropdown, theme toggle, rebuild button, node-count badge) and a position:relative canvas host filling the rest. We append a single <canvas> sized to the host via a ResizeObserver and devicePixelRatio scaling (canvas.width = cssW*dpr; ctx.scale(dpr,dpr)) for crisp lines. A tooltip <div> overlays the canvas.

Data flow per frame: GraphData.build(items, mode, cap) -> GraphModel; ForceSim.setGraph(model) seeds positions on a circle/grid and reheats; a requestAnimationFrame loop calls ForceSim.tick() then GraphRenderer.draw(model, view, selection, hover). tick() returns false once alpha falls below threshold; the loop then stops calling tick() but still redraws on interaction. When the tab is hidden (Zotero_Tabs select away) or the window is minimized, we cancelAnimationFrame and resume on re-show. All heavy work (build) is debounced ~250ms and guarded by the node cap.

Force simulation (forceSim.ts): velocity-Verlet integration. Forces = (a) many-body repulsion via a Barnes-Hut quadtree (theta approx) for O(n log n) instead of O(n^2), strength = graphView.charge; (b) link springs pulling edge endpoints toward graphView.linkDistance scaled by 1/weight so heavier edges sit closer; (c) weak gravity toward the canvas center to keep components on-screen; (d) velocity damping + alpha cooling (alpha *= 1 - alphaDecay each tick). Pinned nodes (dragging, or selection-centred) set fx/fy and are excluded from integration. This reproduces the Obsidian/d3-force feel without the dependency.

Rendering (renderer.ts): clear with theme bg; apply view transform (translate(tx,ty), scale(scale)); draw edges as lines (color = theme edge, alpha/width by weight, dimmed when a selection exists and the edge is not incident to it); draw nodes as filled circles (radius = base + k*sqrt(degree), color by itemType or a stable hash for tags/authors), with a highlight ring for selected and a subtle glow for hover; draw labels (if showLabels and scale above a threshold to avoid clutter). hitTest converts screen px back through the inverse transform and returns the nearest node within its radius for click/hover/drag.

Theme: Theme palette object with light/dark variants for bg, node fill set, edge, label, selection ring. Resolved from graphView.theme; when 'auto', read win.matchMedia('(prefers-color-scheme: dark)') and also listen to Zotero's color-scheme so the graph re-themes live.

Help splash (mode 'default'): when no data is built yet or the user picks 'default', the canvas host is hidden and a styled help div explains the three real modes and how selection sync works, with buttons to switch modes. This mirrors the original's default splash behavior without copying its code.

## Zotero 9 APIs
- win.Zotero_Tabs.add({ type, title, data, select, onClose }) -> { id, container } (create the custom Graph tab and get its mount container)
- win.Zotero_Tabs.select(id) / win.Zotero_Tabs.close(id) / win.Zotero_Tabs.selectedID (show, tear down, and detect active tab for parking the render loop)
- Zotero.Notifier.registerObserver(callback, ['item','collection','tab']) + Zotero.Notifier.unregisterObserver(id) (rebuild on data changes; drive item->node selection sync via the 'select'/'item' events)
- ZoteroPane.getSelectedItems() and ZoteroPane.itemsView (read current selection for selection->node highlight, and for scope='selection' building)
- ZoteroPane.selectItem(itemID) / ZoteroPane.selectItems(ids) and Zotero_Tabs.select('zotero-pane') (node->item: select the clicked item back in the library tab)
- ZoteroPane.getCollectionTreeRow() / collectionTreeRow.getItems() (scope='view': items of the current collection or saved search)
- Zotero.Items.getAll(libraryID) or a Zotero.Search (scope='library', capped)
- item.relatedItems / item.getRelations() and item.key (mode 'related': build edges from Zotero related-item links)
- item.getCreators() (mode 'author': co-authorship edges keyed by normalized lastName+firstInitial; also author-as-node option)
- item.getTags() / item.getColoredTags() (mode 'tag': shared-tag edges; tag color reused for node fill)
- item.getDisplayTitle() and item.itemType / Zotero.ItemTypes (node labels and per-type colors)
- item.getImageSrc() (optional per-type icon for node rendering, matching contract guidance)
- ztoolkit.UI.createElement(doc, 'link'|'canvas'|'div', ...) (inject CSS link and build the tab DOM)
- ztoolkit.Menu.register('menuView', {...}) and ztoolkit.Keyboard.register(...) (add the 'Open Graph View' command + shortcut, auto-unregistered)
- win.matchMedia('(prefers-color-scheme: dark)') (live light/dark theme detection)
- win.requestAnimationFrame / win.cancelAnimationFrame and win.ResizeObserver / win.devicePixelRatio (render loop + crisp canvas sizing)

## Edge cases
- Empty scope (no items in collection / empty library): show the help splash with an 'add some items' hint instead of a blank canvas.
- Node cap exceeded: GraphData returns truncated:true; render only the top-degree nodes and show a non-blocking 'showing N of M' badge so the canvas stays responsive.
- Single node / no edges (e.g. items with no related links/tags/co-authors in 'related' mode): render isolated nodes with gentle gravity so they don't fly to infinity; avoid divide-by-zero in spring force when distance is 0 (jitter apart).
- Author name collisions/variants: normalize creators (trim, lowercase, lastName + first initial) to merge 'J. Smith' and 'John Smith' reasonably while documenting it is heuristic; skip creators with empty names.
- Tags with same name but different color, or items with hundreds of tags: cap tag edges per item and de-duplicate tag keys; reuse colored-tag color, fall back to a hashed color.
- Rapid collection/selection switching: debounce rebuild (~250ms) and abort/ignore stale async builds (sequence token) so an old build doesn't overwrite a newer graph.
- Two-way sync loops: guard the notifier->select and click->select paths with a re-entrancy flag so selecting an item programmatically doesn't retrigger a rebuild storm.
- Tab hidden or window unloaded mid-simulation: cancelAnimationFrame, detach ResizeObserver/matchMedia listeners, and null the canvas to avoid leaks and ctx errors after teardown.
- HiDPI / window DPI change: recompute devicePixelRatio scaling on resize so lines stay sharp and hit-testing stays aligned.
- Deleted/merged items referenced by an in-flight model: re-validate item ids via Zotero.Items.get before selecting back into the pane; drop missing nodes on next rebuild.
- Pinned/dragged node while sim cools: keep fx/fy until pointerup; on pointerup either unpin or keep pinned per a small UX choice (documented), and reheat so neighbours relax.

## Risks
- Zotero_Tabs is a semi-private global; its add() signature/return shape could shift across Z9 point releases. Mitigation: feature-detect win.Zotero_Tabs.add and fail gracefully to a disabled command if the API differs.
- Custom tab type rendering: Zotero may expect known tab types for some chrome (icons, restore-after-restart). Our tab won't persist across restarts; acceptable since it is on-demand. Document that the tab is ephemeral.
- Barnes-Hut quadtree correctness is the trickiest hand-rolled piece; a bug degrades layout quality or perf. Mitigation: keep a simple O(n^2) repulsion fallback behind the node cap (cap small enough that O(n^2) is fine up to ~400 nodes), and add unit tests on forceSim.ts (pure, no DOM).
- Canvas2D label rendering for large graphs can be slow. Mitigation: skip labels below a zoom threshold and behind showLabels pref.
- Two-way selection sync via the notifier 'select' event: exact event/type payloads for tree selection in Z9 must be verified at implementation time (the spec from toolkit docs is reader-centric). Mitigation: prefer hooking ZoteroPane.itemsView selection (onSelect) where available, fall back to notifier; both behind the re-entrancy guard.
- Author/tag de-duplication is heuristic and may surprise users (over/under-merging). Mitigation: document behavior and keep normalization conservative.
- matchMedia and Zotero's theme switching may not fire a single canonical event; live re-theming could lag. Mitigation: also re-resolve theme on every tab show and on the manual theme toggle pref.
- Performance on very large libraries when scope='library': building edges is O(items * relations/tags). Mitigation: hard node cap + degree-based truncation + debounce, and default scope='view'.

## Integration notes
onMainWindowUnload should call GraphViewFactory.unregisterWindow(win) and onShutdown should call GraphViewFactory.unregister(); both are safe no-ops if graphView.enable is false. The feature does NOT edit shared files: the tab is created dynamically through win.Zotero_Tabs.add and the open command is added via ztoolkit.Menu (View menu) and ztoolkit.Keyboard, both auto-cleaned by ztoolkit.unregisterAll(). The only manually-managed resources (notifier observer id, the per-window rAF handle, the injected canvas DOM inside our own tab deck panel, and the matchMedia listener) are torn down in unregister/unregisterWindow. No new npm dependencies are introduced (clean reimplementation: no PIXI, no d3-force).

### Wiring
- onStartup: await GraphViewFactory.register();
- onMainWindowLoad: GraphViewFactory.registerWindow(win);
- CSS: addon/content/graphView.css (injected at runtime by registerWindow via ztoolkit.UI.createElement('link'); not added to preferences.xhtml)
