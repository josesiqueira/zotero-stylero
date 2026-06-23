/**
 * graphView.ts - Stylero "Graph View" feature module.
 *
 * Renders an Obsidian-style force-directed knowledge graph of the user's items
 * into a dedicated main-area tab (created via win.Zotero_Tabs). Supports three
 * real modes (related / author / tag) plus a help splash ("default"), a
 * light/dark theme that follows Zotero/OS, two-way selection sync with the
 * library tree, a scope control (view / selection / library), interactive
 * pan/zoom/drag, hover tooltips, double-click-to-open, and performance
 * guardrails (node cap, alpha cooling, parked rAF loop when hidden).
 *
 * Placement rationale (see bucket spec): Zotero 9's center pane is the
 * Zotero_Tabs deck. A custom tab is the only contract-compliant full-size
 * mount point (no patching private tree internals, no editing shared files).
 *
 * Manual resources (notifier observer, per-window rAF handle, ResizeObserver,
 * matchMedia listener, injected canvas DOM) are torn down in unregister/
 * unregisterWindow. The View-menu command and keyboard shortcut are registered
 * through ztoolkit and auto-cleaned by ztoolkit.unregisterAll().
 *
 * Clean-room original implementation: behaviour mirrors the original Graph View
 * feature, no source is copied.
 */

import { getPref, setPref } from "../utils/prefs";
import { GraphData, GraphMode, GraphModel } from "./graphView/graphData";
import { ForceSim } from "./graphView/forceSim";
import { GraphRenderer, ViewTransform } from "./graphView/renderer";

export { GraphData } from "./graphView/graphData";
export { ForceSim } from "./graphView/forceSim";
export { GraphRenderer } from "./graphView/renderer";
export type {
  GraphNode,
  GraphEdge,
  GraphModel,
  GraphMode,
} from "./graphView/graphData";

/** Per-window graph state. Created lazily on first tab open. */
interface WinState {
  win: _ZoteroTypes.MainWindow;
  tabId: string | null;
  container: HTMLElement | null;
  root: HTMLElement | null;
  host: HTMLElement | null;
  help: HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  tooltip: HTMLElement | null;
  badge: HTMLElement | null;
  segButtons: Map<GraphMode, HTMLButtonElement>;
  renderer: GraphRenderer | null;
  sim: ForceSim | null;
  model: GraphModel;
  view: ViewTransform;
  selection: Set<number>;
  hover: number | null;
  rafHandle: number | null;
  resizeObs: ResizeObserver | null;
  mediaQuery: MediaQueryList | null;
  mediaListener: ((e: MediaQueryListEvent) => void) | null;
  buildToken: number;
  rebuildTimer: number | null;
  // Interaction transient state.
  dragNode: number | null;
  panning: boolean;
  panStart: { x: number; y: number; tx: number; ty: number } | null;
  dragMoved: boolean;
  destroyed: boolean;
}

const EMPTY_MODEL: GraphModel = {
  nodes: [],
  edges: [],
  truncated: false,
  total: 0,
  mode: "default",
};

const REBUILD_DEBOUNCE_MS = 250;

export class GraphViewFactory {
  static PREFS: Record<string, string | number | boolean> = {
    "graphView.enable": true,
    "graphView.mode": "default",
    "graphView.scope": "view",
    "graphView.theme": "auto",
    "graphView.nodeCap": 400,
    "graphView.showLabels": true,
    "graphView.charge": -220,
    "graphView.linkDistance": 60,
  };

  private static notifierID: string | null = null;
  /** Guard so the View-menu item + shortcut register only once, not per window. */
  private static commandRegistered = false;
  /** Stored keyboard callback so it can be unregistered on plugin exit. */
  private static keyboardCallback:
    | ((ev: KeyboardEvent, opts: any) => void)
    | null = null;
  private static states = new Map<_ZoteroTypes.MainWindow, WinState>();
  /** Re-entrancy guard so programmatic selection does not loop. */
  private static syncing = false;

  // ---- Lifecycle ------------------------------------------------------

  static async register(): Promise<void> {
    if (!GraphViewFactory.enabled()) return;
    if (GraphViewFactory.notifierID) return;

    const callback = {
      notify: (
        event: string,
        type: string,
        ids: (number | string)[],
        _extra: { [key: string]: any },
      ) => {
        try {
          GraphViewFactory.onNotify(event, type, ids);
        } catch (e) {
          ztoolkit.log("[Stylero GraphView] notify error", e);
        }
      },
    };
    GraphViewFactory.notifierID = Zotero.Notifier.registerObserver(
      callback,
      ["item", "collection", "tab"],
      "stylero-graphview",
    );
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!GraphViewFactory.enabled()) return;
    if (GraphViewFactory.states.has(win)) return;

    GraphViewFactory.injectCSS(win);
    // Register the View-menu item + shortcut once, not per window. The
    // handlers resolve the focused main window at call time.
    GraphViewFactory.registerCommand();

    // Prepare lazy state; the heavy DOM/tab is created on first open.
    GraphViewFactory.states.set(win, GraphViewFactory.makeState(win));
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const st = GraphViewFactory.states.get(win);
    if (!st) return;
    GraphViewFactory.teardownState(st);
    GraphViewFactory.states.delete(win);
  }

  static unregister(): void {
    if (GraphViewFactory.notifierID) {
      Zotero.Notifier.unregisterObserver(GraphViewFactory.notifierID);
      GraphViewFactory.notifierID = null;
    }
    // Tear down the once-registered View-menu item + shortcut.
    if (GraphViewFactory.commandRegistered) {
      try {
        ztoolkit.Menu.unregister("stylero-graphview-open");
      } catch {
        /* already removed */
      }
      if (GraphViewFactory.keyboardCallback) {
        try {
          ztoolkit.Keyboard.unregister(GraphViewFactory.keyboardCallback);
        } catch {
          /* already removed */
        }
        GraphViewFactory.keyboardCallback = null;
      }
      GraphViewFactory.commandRegistered = false;
    }
    for (const st of GraphViewFactory.states.values()) {
      GraphViewFactory.teardownState(st);
    }
    GraphViewFactory.states.clear();
  }

  // ---- Helpers --------------------------------------------------------

  private static enabled(): boolean {
    try {
      return getPref("graphView.enable" as any) !== false;
    } catch {
      return true;
    }
  }

  private static makeState(win: _ZoteroTypes.MainWindow): WinState {
    return {
      win,
      tabId: null,
      container: null,
      root: null,
      host: null,
      help: null,
      canvas: null,
      tooltip: null,
      badge: null,
      segButtons: new Map(),
      renderer: null,
      sim: null,
      model: EMPTY_MODEL,
      view: { scale: 1, tx: 0, ty: 0 },
      selection: new Set(),
      hover: null,
      rafHandle: null,
      resizeObs: null,
      mediaQuery: null,
      mediaListener: null,
      buildToken: 0,
      rebuildTimer: null,
      dragNode: null,
      panning: false,
      panStart: null,
      dragMoved: false,
      destroyed: false,
    };
  }

  private static injectCSS(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (doc.getElementById("stylero-graphview-css")) return;
    const link = ztoolkit.UI.createElement(doc, "link", {
      id: "stylero-graphview-css",
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/graphView.css`,
      },
    });
    doc.documentElement?.appendChild(link);
  }

  private static registerCommand(): void {
    // Register only once: the menu item and shortcut are global, and the
    // handlers resolve the active main window at call time so they do not
    // leak/duplicate across windows.
    if (GraphViewFactory.commandRegistered) return;
    GraphViewFactory.commandRegistered = true;

    // View-menu item to open the graph tab.
    ztoolkit.Menu.register("menuView", {
      tag: "menuitem",
      id: "stylero-graphview-open",
      label: "Stylero: Graph View",
      commandListener: () => {
        const win = Zotero.getMainWindow();
        if (win) GraphViewFactory.openTab(win);
      },
    });

    // Keyboard shortcut: Ctrl/Cmd+Alt+G to open the graph.
    GraphViewFactory.keyboardCallback = (ev, opts) => {
      const accel = ev.ctrlKey || ev.metaKey;
      if (accel && ev.altKey && (ev.key === "g" || ev.key === "G")) {
        const win = Zotero.getMainWindow();
        if (win) GraphViewFactory.openTab(win);
      }
      void opts;
    };
    ztoolkit.Keyboard.register(GraphViewFactory.keyboardCallback);
  }

  // ---- Tab open / mount ----------------------------------------------

  static openTab(win: _ZoteroTypes.MainWindow): void {
    if (!GraphViewFactory.enabled()) return;
    let st = GraphViewFactory.states.get(win);
    if (!st) {
      st = GraphViewFactory.makeState(win);
      GraphViewFactory.states.set(win, st);
    }

    const Tabs = (win as any).Zotero_Tabs;
    if (!Tabs || typeof Tabs.add !== "function") {
      // Feature-detect: fail gracefully if the semi-private API shifted.
      ztoolkit.log("[Stylero GraphView] Zotero_Tabs.add unavailable");
      try {
        win.alert?.("Graph View is unavailable in this Zotero build.");
      } catch {
        /* ignore */
      }
      return;
    }

    // If the tab already exists, just select it.
    if (st.tabId) {
      try {
        Tabs.select(st.tabId);
        GraphViewFactory.onTabShown(st!);
        return;
      } catch {
        // Tab was closed externally; fall through to recreate.
        st.tabId = null;
      }
    }

    let result: { id: string; container: HTMLElement };
    try {
      result = Tabs.add({
        type: `${addon.data.config.addonRef}-graph`,
        title: "Graph",
        select: true,
        onClose: () => GraphViewFactory.onTabClosed(win),
      });
    } catch (e) {
      ztoolkit.log("[Stylero GraphView] Tabs.add failed", e);
      return;
    }

    st.tabId = result.id;
    st.container = result.container;
    GraphViewFactory.mount(st);
    GraphViewFactory.onTabShown(st);
  }

  private static onTabClosed(win: _ZoteroTypes.MainWindow): void {
    const st = GraphViewFactory.states.get(win);
    if (!st) return;
    GraphViewFactory.stopLoop(st);
    GraphViewFactory.detachInteractions(st);
    st.tabId = null;
    st.container = null;
    st.root = null;
    st.host = null;
    st.help = null;
    st.canvas = null;
    st.renderer = null;
    st.sim = null;
    st.model = EMPTY_MODEL;
  }

  private static mount(st: WinState): void {
    const win = st.win;
    const doc = win.document;
    const container = st.container!;

    // Clear any prior content (defensive).
    container.textContent = "";

    const mode = GraphViewFactory.getMode();

    const root = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-root"],
    });
    st.root = root;
    GraphViewFactory.applyThemeClass(st);

    // Toolbar.
    const toolbar = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-toolbar"],
    });

    // Segmented control for modes.
    const seg = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-segmented"],
    });
    const modes: { id: GraphMode; label: string }[] = [
      { id: "default", label: "Help" },
      { id: "related", label: "Related" },
      { id: "author", label: "Authors" },
      { id: "tag", label: "Tags" },
    ];
    st.segButtons.clear();
    for (const m of modes) {
      const btn = ztoolkit.UI.createElement(doc, "button", {
        namespace: "html",
        properties: { textContent: m.label },
      }) as HTMLButtonElement;
      if (m.id === mode) btn.classList.add("stylero-active");
      btn.addEventListener("click", () => GraphViewFactory.setMode(st, m.id));
      seg.appendChild(btn);
      st.segButtons.set(m.id, btn);
    }
    toolbar.appendChild(seg);

    // Scope dropdown.
    const scopeLabel = ztoolkit.UI.createElement(doc, "label", {
      namespace: "html",
      properties: { textContent: "Scope:" },
    });
    const scopeSel = ztoolkit.UI.createElement(doc, "select", {
      namespace: "html",
    }) as HTMLSelectElement;
    for (const [val, text] of [
      ["view", "Current view"],
      ["selection", "Selection + neighbours"],
      ["library", "Whole library"],
    ]) {
      const opt = doc.createElement("option");
      opt.value = val;
      opt.textContent = text;
      scopeSel.appendChild(opt);
    }
    scopeSel.value = GraphViewFactory.getScope();
    scopeSel.addEventListener("change", () => {
      setPref("graphView.scope" as any, scopeSel.value);
      GraphViewFactory.scheduleRebuild(st, true);
    });
    scopeLabel.appendChild(scopeSel);
    toolbar.appendChild(scopeLabel);

    // Theme dropdown.
    const themeLabel = ztoolkit.UI.createElement(doc, "label", {
      namespace: "html",
      properties: { textContent: "Theme:" },
    });
    const themeSel = ztoolkit.UI.createElement(doc, "select", {
      namespace: "html",
    }) as HTMLSelectElement;
    for (const [val, text] of [
      ["auto", "Auto"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]) {
      const opt = doc.createElement("option");
      opt.value = val;
      opt.textContent = text;
      themeSel.appendChild(opt);
    }
    themeSel.value = GraphViewFactory.getThemePref();
    themeSel.addEventListener("change", () => {
      setPref("graphView.theme" as any, themeSel.value);
      GraphViewFactory.applyTheme(st);
      GraphViewFactory.requestDraw(st);
    });
    themeLabel.appendChild(themeSel);
    toolbar.appendChild(themeLabel);

    // Rebuild button.
    const rebuildBtn = ztoolkit.UI.createElement(doc, "button", {
      namespace: "html",
      classList: ["stylero-graph-btn"],
      properties: { textContent: "Rebuild" },
    }) as HTMLButtonElement;
    rebuildBtn.addEventListener("click", () =>
      GraphViewFactory.scheduleRebuild(st, true),
    );
    toolbar.appendChild(rebuildBtn);

    // Reset view button.
    const fitBtn = ztoolkit.UI.createElement(doc, "button", {
      namespace: "html",
      classList: ["stylero-graph-btn"],
      properties: { textContent: "Fit" },
    }) as HTMLButtonElement;
    fitBtn.addEventListener("click", () => GraphViewFactory.fitView(st));
    toolbar.appendChild(fitBtn);

    const spacer = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-spacer"],
    });
    toolbar.appendChild(spacer);

    const badge = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-badge"],
    });
    st.badge = badge;
    toolbar.appendChild(badge);

    root.appendChild(toolbar);

    // Canvas host.
    const host = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-host"],
    });
    st.host = host;
    const canvas = ztoolkit.UI.createElement(doc, "canvas", {
      namespace: "html",
    }) as HTMLCanvasElement;
    st.canvas = canvas;
    host.appendChild(canvas);

    const tooltip = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-tooltip"],
    });
    st.tooltip = tooltip;
    host.appendChild(tooltip);
    root.appendChild(host);

    // Help splash.
    st.help = GraphViewFactory.buildHelp(st);
    root.appendChild(st.help);

    container.appendChild(root);

    // Engine.
    st.renderer = new GraphRenderer(canvas, GraphViewFactory.resolveTheme(st));
    st.renderer.setShowLabels(GraphViewFactory.getShowLabels());
    st.sim = new ForceSim({
      charge: GraphViewFactory.getCharge(),
      linkDistance: GraphViewFactory.getLinkDistance(),
    });

    GraphViewFactory.attachInteractions(st);
    GraphViewFactory.attachResize(st);
    GraphViewFactory.attachTheme(st);

    // Initial size + view.
    GraphViewFactory.syncCanvasSize(st);
    GraphViewFactory.centerView(st);

    GraphViewFactory.updateModeUI(st);
    if (mode === "default") {
      GraphViewFactory.showHelp(st, true);
    } else {
      GraphViewFactory.showHelp(st, false);
      GraphViewFactory.scheduleRebuild(st, true);
    }
  }

  private static buildHelp(st: WinState): HTMLElement {
    const doc = st.win.document;
    const help = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["stylero-graph-help"],
    });
    const h = doc.createElement("h2");
    h.textContent = "Stylero Graph View";
    help.appendChild(h);

    const p = doc.createElement("p");
    p.textContent =
      "Explore your library as a force-directed graph. Pick a mode below. " +
      "Click a node to select that item in the library; selecting items in " +
      "the tree highlights them here. Drag nodes to pin them, drag the " +
      "background to pan, and scroll to zoom. Double-click a node to open it.";
    help.appendChild(p);

    const modesWrap = doc.createElement("div");
    modesWrap.className = "stylero-help-modes";
    const cards: { id: GraphMode; title: string; desc: string }[] = [
      {
        id: "related",
        title: "Related",
        desc: "Edges from Zotero related-item links.",
      },
      {
        id: "author",
        title: "Authors",
        desc: "Items linked to their (normalized) authors.",
      },
      {
        id: "tag",
        title: "Tags",
        desc: "Items linked to their tags; colored tags reused.",
      },
    ];
    for (const c of cards) {
      const card = doc.createElement("div");
      card.className = "stylero-help-card";
      const strong = doc.createElement("strong");
      strong.textContent = c.title;
      const span = doc.createElement("span");
      span.textContent = c.desc;
      card.appendChild(strong);
      card.appendChild(span);
      card.addEventListener("click", () => GraphViewFactory.setMode(st, c.id));
      modesWrap.appendChild(card);
    }
    help.appendChild(modesWrap);
    return help;
  }

  // ---- Mode / scope / theme prefs ------------------------------------

  private static getMode(): GraphMode {
    const v = GraphViewFactory.safePref("graphView.mode", "default");
    if (v === "related" || v === "author" || v === "tag" || v === "default") {
      return v;
    }
    return "default";
  }

  private static getScope(): string {
    const v = GraphViewFactory.safePref("graphView.scope", "view");
    return v === "selection" || v === "library" ? v : "view";
  }

  private static getThemePref(): string {
    const v = GraphViewFactory.safePref("graphView.theme", "auto");
    return v === "light" || v === "dark" ? v : "auto";
  }

  private static getNodeCap(): number {
    const v = Number(GraphViewFactory.safePref("graphView.nodeCap", 400));
    return isFinite(v) && v > 0 ? Math.floor(v) : 400;
  }

  private static getShowLabels(): boolean {
    return GraphViewFactory.safePref("graphView.showLabels", true) !== false;
  }

  private static getCharge(): number {
    const v = Number(GraphViewFactory.safePref("graphView.charge", -220));
    return isFinite(v) ? v : -220;
  }

  private static getLinkDistance(): number {
    const v = Number(GraphViewFactory.safePref("graphView.linkDistance", 60));
    return isFinite(v) && v > 0 ? v : 60;
  }

  private static safePref(key: string, fallback: any): any {
    try {
      const v = getPref(key as any);
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  private static setMode(st: WinState, mode: GraphMode): void {
    setPref("graphView.mode" as any, mode);
    GraphViewFactory.updateModeUI(st);
    if (mode === "default") {
      GraphViewFactory.stopLoop(st);
      GraphViewFactory.showHelp(st, true);
    } else {
      GraphViewFactory.showHelp(st, false);
      GraphViewFactory.syncCanvasSize(st);
      GraphViewFactory.scheduleRebuild(st, true);
    }
  }

  private static updateModeUI(st: WinState): void {
    const mode = GraphViewFactory.getMode();
    for (const [id, btn] of st.segButtons) {
      btn.classList.toggle("stylero-active", id === mode);
    }
  }

  private static showHelp(st: WinState, show: boolean): void {
    if (st.help) st.help.classList.toggle("stylero-hidden", !show);
    if (st.host) st.host.classList.toggle("stylero-hidden", show);
  }

  // ---- Theme ----------------------------------------------------------

  private static resolveTheme(st: WinState): "light" | "dark" {
    const pref = GraphViewFactory.getThemePref();
    if (pref === "light") return "light";
    if (pref === "dark") return "dark";
    try {
      const mql = st.win.matchMedia("(prefers-color-scheme: dark)");
      return mql && mql.matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  private static applyThemeClass(st: WinState): void {
    if (!st.root) return;
    const theme = GraphViewFactory.resolveTheme(st);
    st.root.classList.toggle("stylero-theme-dark", theme === "dark");
    st.root.classList.toggle("stylero-theme-light", theme === "light");
  }

  private static applyTheme(st: WinState): void {
    GraphViewFactory.applyThemeClass(st);
    if (st.renderer) st.renderer.setTheme(GraphViewFactory.resolveTheme(st));
  }

  private static attachTheme(st: WinState): void {
    try {
      const mql = st.win.matchMedia("(prefers-color-scheme: dark)");
      if (!mql) {
        st.mediaQuery = null;
        st.mediaListener = null;
        return;
      }
      const listener = () => {
        if (GraphViewFactory.getThemePref() === "auto") {
          GraphViewFactory.applyTheme(st);
          GraphViewFactory.requestDraw(st);
        }
      };
      // addEventListener is the modern API; guard for older builds.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", listener);
      } else if (typeof (mql as any).addListener === "function") {
        (mql as any).addListener(listener);
      }
      st.mediaQuery = mql;
      st.mediaListener = listener;
    } catch {
      st.mediaQuery = null;
      st.mediaListener = null;
    }
  }

  // ---- Sizing / view --------------------------------------------------

  private static dpr(st: WinState): number {
    return st.win.devicePixelRatio || 1;
  }

  private static syncCanvasSize(st: WinState): void {
    if (!st.host || !st.canvas || !st.renderer) return;
    const rect = st.host.getBoundingClientRect();
    const w = rect.width || st.host.clientWidth || 600;
    const h = rect.height || st.host.clientHeight || 400;
    st.renderer.resize(w, h, GraphViewFactory.dpr(st));
    if (st.sim) st.sim.setCenter(w / 2, h / 2);
  }

  private static centerView(st: WinState): void {
    st.view = { scale: 1, tx: 0, ty: 0 };
  }

  private static attachResize(st: WinState): void {
    try {
      // ResizeObserver belongs to the target window's global scope; use the
      // window's own constructor so it observes that document's layout.
      const ROCtor = (st.win as any).ResizeObserver as
        | (new (cb: () => void) => ResizeObserver)
        | undefined;
      if (!ROCtor) {
        st.resizeObs = null;
        return;
      }
      const obs = new ROCtor(() => {
        GraphViewFactory.syncCanvasSize(st);
        GraphViewFactory.requestDraw(st);
      });
      if (st.host) obs.observe(st.host);
      st.resizeObs = obs;
    } catch {
      st.resizeObs = null;
    }
  }

  /** Fit the whole graph into the viewport (auto scale + center). */
  private static fitView(st: WinState): void {
    if (!st.renderer || st.model.nodes.length === 0) {
      GraphViewFactory.centerView(st);
      GraphViewFactory.requestDraw(st);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of st.model.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) {
      GraphViewFactory.centerView(st);
      GraphViewFactory.requestDraw(st);
      return;
    }
    const pad = 60;
    const gw = Math.max(1, maxX - minX);
    const gh = Math.max(1, maxY - minY);
    const vw = st.renderer.width;
    const vh = st.renderer.height;
    const scale = Math.min(
      4,
      Math.max(0.1, Math.min((vw - pad) / gw, (vh - pad) / gh)),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    st.view = {
      scale,
      tx: vw / 2 - cx * scale,
      ty: vh / 2 - cy * scale,
    };
    GraphViewFactory.requestDraw(st);
  }

  // ---- Build ----------------------------------------------------------

  private static scheduleRebuild(st: WinState, immediate: boolean): void {
    if (st.destroyed) return;
    if (GraphViewFactory.getMode() === "default") return;
    if (st.rebuildTimer !== null) {
      st.win.clearTimeout(st.rebuildTimer);
      st.rebuildTimer = null;
    }
    const run = () => {
      st.rebuildTimer = null;
      void GraphViewFactory.rebuild(st);
    };
    if (immediate) {
      // Still defer a frame so rapid mode toggles coalesce a little.
      st.rebuildTimer = st.win.setTimeout(run, 16);
    } else {
      st.rebuildTimer = st.win.setTimeout(run, REBUILD_DEBOUNCE_MS);
    }
  }

  static async rebuild(st: WinState): Promise<void> {
    if (st.destroyed || !st.sim || !st.renderer) return;
    const mode = GraphViewFactory.getMode();
    if (mode === "default") return;

    const token = ++st.buildToken;
    let items: Zotero.Item[] = [];
    try {
      items = await GraphViewFactory.collectItems(st);
    } catch (e) {
      ztoolkit.log("[Stylero GraphView] collectItems failed", e);
      items = [];
    }
    if (token !== st.buildToken || st.destroyed) return; // stale

    let model: GraphModel;
    try {
      model = await GraphData.build(
        items,
        mode,
        GraphViewFactory.getNodeCap(),
      );
    } catch (e) {
      ztoolkit.log("[Stylero GraphView] GraphData.build failed", e);
      model = { ...EMPTY_MODEL, mode };
    }
    if (token !== st.buildToken || st.destroyed) return; // stale

    if (model.nodes.length === 0) {
      // Empty scope: show the help splash with a hint instead of blank canvas.
      st.model = model;
      GraphViewFactory.updateBadge(st);
      GraphViewFactory.showEmptyHint(st);
      return;
    }

    GraphViewFactory.showHelp(st, false);
    st.model = model;
    delete (model as any).__byId;
    GraphViewFactory.syncCanvasSize(st);
    st.sim.setParams({
      charge: GraphViewFactory.getCharge(),
      linkDistance: GraphViewFactory.getLinkDistance(),
    });
    st.sim.setGraph(model);
    GraphViewFactory.applySelectionFromPane(st, false);
    GraphViewFactory.updateBadge(st);
    GraphViewFactory.fitAfterSettle(st);
    GraphViewFactory.startLoop(st);
  }

  private static showEmptyHint(st: WinState): void {
    GraphViewFactory.showHelp(st, true);
    if (st.help) {
      const existing = st.help.querySelector(".stylero-empty-hint");
      if (!existing) {
        const hint = st.win.document.createElement("p");
        hint.className = "stylero-empty-hint";
        hint.textContent =
          "No items to graph in this scope. Add items, pick a different " +
          "scope, or select some items, then Rebuild.";
        st.help.appendChild(hint);
      }
    }
  }

  /** Defer a one-time fit until the layout has had a few frames to expand. */
  private static fitAfterSettle(st: WinState): void {
    let frames = 0;
    const tryFit = () => {
      if (st.destroyed) return;
      frames++;
      if (st.sim && (st.sim.settled || frames > 90)) {
        GraphViewFactory.fitView(st);
        return;
      }
      st.win.requestAnimationFrame(tryFit);
    };
    st.win.requestAnimationFrame(tryFit);
  }

  private static async collectItems(st: WinState): Promise<Zotero.Item[]> {
    const win = st.win as any;
    const ZoteroPane = win.ZoteroPane;
    const scope = GraphViewFactory.getScope();

    if (scope === "library") {
      const libID =
        ZoteroPane?.getSelectedLibraryID?.() ??
        Zotero.Libraries.userLibraryID;
      const all = await Zotero.Items.getAll(libID, true);
      return (all || []).filter(
        (it: Zotero.Item) => it.isRegularItem && it.isRegularItem(),
      );
    }

    if (scope === "selection") {
      const sel: Zotero.Item[] =
        ZoteroPane?.getSelectedItems?.()?.filter(
          (it: Zotero.Item) => it.isRegularItem && it.isRegularItem(),
        ) || [];
      // Add related neighbours so an isolated selection still forms a graph.
      const set = new Map<number, Zotero.Item>();
      for (const it of sel) set.set(it.id, it);
      for (const it of sel) {
        let relatedKeys: string[] = [];
        try {
          const rel = (it as any).relatedItems;
          if (Array.isArray(rel)) relatedKeys = rel;
        } catch {
          relatedKeys = [];
        }
        for (const rk of relatedKeys) {
          try {
            const ri = (Zotero.Items as any).getByLibraryAndKey?.(
              it.libraryID,
              rk,
            ) as Zotero.Item | false;
            if (ri && ri.isRegularItem && ri.isRegularItem()) {
              set.set(ri.id, ri);
            }
          } catch {
            /* ignore missing neighbour */
          }
        }
      }
      return Array.from(set.values());
    }

    // scope === "view": items of the current collection / saved search.
    try {
      const row = ZoteroPane?.getCollectionTreeRow?.();
      if (row && typeof row.getItems === "function") {
        const items = await row.getItems();
        return (items || []).filter(
          (it: Zotero.Item) => it.isRegularItem && it.isRegularItem(),
        );
      }
    } catch {
      /* fall through */
    }
    // Fallback: whatever the items view currently holds.
    try {
      const itemsView = ZoteroPane?.itemsView;
      if (itemsView && typeof itemsView.getSortedItems === "function") {
        const items = itemsView.getSortedItems();
        return (items || []).filter(
          (it: Zotero.Item) => it.isRegularItem && it.isRegularItem(),
        );
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  private static updateBadge(st: WinState): void {
    if (!st.badge) return;
    const m = st.model;
    if (m.truncated) {
      st.badge.classList.add("stylero-truncated");
      st.badge.textContent = `Showing ${m.nodes.length} of ${m.total} nodes`;
    } else {
      st.badge.classList.remove("stylero-truncated");
      st.badge.textContent = `${m.nodes.length} nodes, ${m.edges.length} edges`;
    }
  }

  // ---- Render loop ----------------------------------------------------

  private static startLoop(st: WinState): void {
    if (st.rafHandle !== null) return;
    if (!GraphViewFactory.isTabActive(st)) return; // park if hidden
    const step = () => {
      if (st.destroyed) {
        st.rafHandle = null;
        return;
      }
      if (!GraphViewFactory.isTabActive(st)) {
        st.rafHandle = null; // park; resumed on tab show
        return;
      }
      let running = false;
      if (st.sim) running = st.sim.tick();
      GraphViewFactory.drawNow(st);
      if (running) {
        st.rafHandle = st.win.requestAnimationFrame(step);
      } else {
        st.rafHandle = null; // settled; redraw only on interaction
      }
    };
    st.rafHandle = st.win.requestAnimationFrame(step);
  }

  private static stopLoop(st: WinState): void {
    if (st.rafHandle !== null) {
      st.win.cancelAnimationFrame(st.rafHandle);
      st.rafHandle = null;
    }
  }

  /** Request a single redraw without restarting the simulation. */
  private static requestDraw(st: WinState): void {
    if (st.destroyed) return;
    if (st.rafHandle !== null) return; // a frame is already scheduled
    st.rafHandle = st.win.requestAnimationFrame(() => {
      st.rafHandle = null;
      GraphViewFactory.drawNow(st);
    });
  }

  private static drawNow(st: WinState): void {
    if (st.destroyed || !st.renderer) return;
    if (GraphViewFactory.getMode() === "default") return;
    // The renderer frame cache (model.__byId) is rebuilt in rebuild() on
    // model change; do not delete it per frame or the cache is defeated.
    st.renderer.draw(st.model, st.view, st.selection, st.hover);
  }

  private static isTabActive(st: WinState): boolean {
    if (!st.tabId) return false;
    try {
      const Tabs = (st.win as any).Zotero_Tabs;
      return Tabs?.selectedID === st.tabId;
    } catch {
      return false;
    }
  }

  private static onTabShown(st: WinState): void {
    // Re-resolve theme (Zotero theme may have changed while hidden), resize,
    // and resume the loop.
    GraphViewFactory.applyTheme(st);
    GraphViewFactory.syncCanvasSize(st);
    if (GraphViewFactory.getMode() !== "default") {
      if (st.model.nodes.length === 0) {
        GraphViewFactory.scheduleRebuild(st, true);
      } else {
        GraphViewFactory.startLoop(st);
        GraphViewFactory.requestDraw(st);
      }
    }
  }

  // ---- Interaction ----------------------------------------------------

  private static attachInteractions(st: WinState): void {
    const canvas = st.canvas!;
    const onPointerDown = (ev: PointerEvent) => {
      if (st.destroyed || !st.renderer) return;
      const { x, y } = GraphViewFactory.localPoint(st, ev);
      const node = st.renderer.hitTest(x, y, st.model, st.view);
      st.dragMoved = false;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (node) {
        st.dragNode = node.id;
        if (st.sim) {
          const w = st.renderer.screenToWorld(x, y, st.view);
          st.sim.pin(node.id, w.x, w.y);
          st.sim.reheat();
          GraphViewFactory.startLoop(st);
        }
      } else {
        st.panning = true;
        st.panStart = { x, y, tx: st.view.tx, ty: st.view.ty };
        canvas.classList.add("stylero-grabbing");
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (st.destroyed || !st.renderer) return;
      const { x, y } = GraphViewFactory.localPoint(st, ev);
      if (st.dragNode !== null && st.sim) {
        st.dragMoved = true;
        const w = st.renderer.screenToWorld(x, y, st.view);
        st.sim.pin(st.dragNode, w.x, w.y);
        st.sim.reheat();
        GraphViewFactory.startLoop(st);
        GraphViewFactory.hideTooltip(st);
        return;
      }
      if (st.panning && st.panStart) {
        st.dragMoved = true;
        st.view.tx = st.panStart.tx + (x - st.panStart.x);
        st.view.ty = st.panStart.ty + (y - st.panStart.y);
        GraphViewFactory.requestDraw(st);
        return;
      }
      // Hover detection + tooltip.
      const node = st.renderer.hitTest(x, y, st.model, st.view);
      const newHover = node ? node.id : null;
      if (newHover !== st.hover) {
        st.hover = newHover;
        GraphViewFactory.requestDraw(st);
      }
      if (node) {
        GraphViewFactory.showTooltip(st, node.label, node.itemType, x, y);
      } else {
        GraphViewFactory.hideTooltip(st);
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (st.destroyed) return;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      const wasDrag = st.dragNode;
      const moved = st.dragMoved;
      if (st.dragNode !== null && st.sim) {
        // UX choice: a click (no movement) unpins so the node relaxes back;
        // an actual drag keeps the node pinned where the user placed it.
        if (!moved) st.sim.unpin(st.dragNode);
        st.sim.reheat();
      }
      st.dragNode = null;
      st.panning = false;
      st.panStart = null;
      canvas.classList.remove("stylero-grabbing");

      // Treat a non-moving press on a node as a click -> select in pane.
      if (wasDrag !== null && !moved) {
        GraphViewFactory.onNodeClick(st, wasDrag);
      }
    };

    const onDblClick = (ev: MouseEvent) => {
      if (st.destroyed || !st.renderer) return;
      const { x, y } = GraphViewFactory.localPoint(st, ev as any);
      const node = st.renderer.hitTest(x, y, st.model, st.view);
      if (node && node.id > 0) GraphViewFactory.openItem(st, node.id);
    };

    const onWheel = (ev: WheelEvent) => {
      if (st.destroyed) return;
      ev.preventDefault();
      const { x, y } = GraphViewFactory.localPoint(st, ev as any);
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newScale = Math.min(6, Math.max(0.08, st.view.scale * factor));
      // Zoom toward the cursor: keep the world point under the cursor fixed.
      const wx = (x - st.view.tx) / st.view.scale;
      const wy = (y - st.view.ty) / st.view.scale;
      st.view.scale = newScale;
      st.view.tx = x - wx * newScale;
      st.view.ty = y - wy * newScale;
      GraphViewFactory.requestDraw(st);
    };

    const onLeave = () => GraphViewFactory.hideTooltip(st);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerleave", onLeave);

    // Stash so we can detach precisely on teardown.
    (st as any).__listeners = {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onDblClick,
      onWheel,
      onLeave,
    };
  }

  private static detachInteractions(st: WinState): void {
    const canvas = st.canvas;
    const l = (st as any).__listeners;
    if (canvas && l) {
      canvas.removeEventListener("pointerdown", l.onPointerDown);
      canvas.removeEventListener("pointermove", l.onPointerMove);
      canvas.removeEventListener("pointerup", l.onPointerUp);
      canvas.removeEventListener("dblclick", l.onDblClick);
      canvas.removeEventListener("wheel", l.onWheel);
      canvas.removeEventListener("pointerleave", l.onLeave);
    }
    (st as any).__listeners = null;
  }

  private static localPoint(
    st: WinState,
    ev: PointerEvent | WheelEvent | MouseEvent,
  ): { x: number; y: number } {
    const rect = st.canvas!.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private static showTooltip(
    st: WinState,
    label: string,
    itemType: string,
    x: number,
    y: number,
  ): void {
    if (!st.tooltip) return;
    st.tooltip.textContent = "";
    const typeEl = st.win.document.createElement("div");
    typeEl.className = "stylero-tip-type";
    typeEl.textContent = GraphViewFactory.prettyType(itemType);
    const titleEl = st.win.document.createElement("div");
    titleEl.textContent = label;
    st.tooltip.appendChild(typeEl);
    st.tooltip.appendChild(titleEl);
    st.tooltip.classList.add("stylero-show");
    // Position with a small offset, clamped inside the host.
    const hostW = st.host?.clientWidth || 0;
    const tipW = st.tooltip.offsetWidth || 0;
    let left = x + 14;
    if (left + tipW > hostW) left = Math.max(4, x - tipW - 14);
    st.tooltip.style.left = `${left}px`;
    st.tooltip.style.top = `${y + 14}px`;
  }

  private static hideTooltip(st: WinState): void {
    if (st.tooltip) st.tooltip.classList.remove("stylero-show");
  }

  private static prettyType(itemType: string): string {
    if (itemType === "author") return "author";
    if (itemType === "tag") return "tag";
    try {
      const localized = Zotero.ItemTypes?.getLocalizedString?.(itemType);
      if (localized) return localized;
    } catch {
      /* ignore */
    }
    return itemType;
  }

  // ---- Node -> pane sync ---------------------------------------------

  private static onNodeClick(st: WinState, nodeId: number): void {
    // Only real items (positive id) map back to the pane; author/tag nodes
    // (negative id) just highlight locally.
    if (nodeId <= 0) {
      st.selection = new Set([nodeId]);
      GraphViewFactory.requestDraw(st);
      return;
    }
    // Re-validate the item still exists before selecting.
    let item: Zotero.Item | false = false;
    try {
      item = Zotero.Items.get(nodeId) as Zotero.Item | false;
    } catch {
      item = false;
    }
    if (!item) {
      st.selection = new Set();
      GraphViewFactory.scheduleRebuild(st, false);
      return;
    }
    st.selection = new Set([nodeId]);
    GraphViewFactory.requestDraw(st);

    GraphViewFactory.syncing = true;
    try {
      const win = st.win as any;
      win.Zotero_Tabs?.select?.("zotero-pane");
      win.ZoteroPane?.selectItem?.(nodeId);
    } catch (e) {
      ztoolkit.log("[Stylero GraphView] selectItem failed", e);
    } finally {
      // Release the guard on the next tick so the resulting notifier 'select'
      // does not bounce back into a rebuild/centre loop.
      st.win.setTimeout(() => {
        GraphViewFactory.syncing = false;
      }, 0);
    }
  }

  private static openItem(st: WinState, itemID: number): void {
    try {
      const win = st.win as any;
      const item = Zotero.Items.get(itemID) as Zotero.Item | false;
      if (!item) return;
      win.ZoteroPane?.viewItems?.([item]);
    } catch (e) {
      ztoolkit.log("[Stylero GraphView] openItem failed", e);
    }
  }

  // ---- Pane -> node sync ---------------------------------------------

  private static applySelectionFromPane(st: WinState, center: boolean): void {
    if (!st.model.nodes.length) return;
    let selected: Zotero.Item[] = [];
    try {
      const win = st.win as any;
      selected = win.ZoteroPane?.getSelectedItems?.() || [];
    } catch {
      selected = [];
    }
    const ids = new Set<number>();
    const present = new Set(st.model.nodes.map((n) => n.id));
    for (const it of selected) {
      if (present.has(it.id)) ids.add(it.id);
    }
    st.selection = ids;
    if (center && ids.size) GraphViewFactory.centerOnSelection(st);
    GraphViewFactory.requestDraw(st);
  }

  private static centerOnSelection(st: WinState): void {
    if (!st.renderer || st.selection.size === 0) return;
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (const n of st.model.nodes) {
      if (st.selection.has(n.id)) {
        sx += n.x;
        sy += n.y;
        count++;
      }
    }
    if (count === 0) return;
    sx /= count;
    sy /= count;
    const vw = st.renderer.width;
    const vh = st.renderer.height;
    st.view.tx = vw / 2 - sx * st.view.scale;
    st.view.ty = vh / 2 - sy * st.view.scale;
    GraphViewFactory.requestDraw(st);
  }

  // ---- Notifier -------------------------------------------------------

  static onNotify(
    event: string,
    type: string,
    ids: (number | string)[],
  ): void {
    if (!addon?.data?.alive) return;
    if (!GraphViewFactory.enabled()) return;

    for (const st of GraphViewFactory.states.values()) {
      if (!st.tabId || st.destroyed) continue;
      if (GraphViewFactory.getMode() === "default") continue;

      if (type === "tab" && event === "select") {
        // Park/resume our render loop as the active tab changes.
        if (GraphViewFactory.isTabActive(st)) {
          GraphViewFactory.onTabShown(st);
        } else {
          GraphViewFactory.stopLoop(st);
        }
        continue;
      }

      if (type === "collection") {
        // Collection added/removed/modified -> the current view may change.
        if (GraphViewFactory.getScope() === "view") {
          GraphViewFactory.scheduleRebuild(st, false);
        }
        continue;
      }

      if (type === "item") {
        if (event === "select") {
          // Selection changed in the tree -> mirror into the graph, unless we
          // triggered it ourselves (re-entrancy guard).
          if (GraphViewFactory.syncing) continue;
          GraphViewFactory.onSelectSync(st, ids);
        } else if (
          event === "add" ||
          event === "delete" ||
          event === "modify" ||
          event === "trash"
        ) {
          GraphViewFactory.scheduleRebuild(st, false);
        }
      }
    }
  }

  static onSelectSync(st: WinState, _ids: (number | string)[]): void {
    GraphViewFactory.applySelectionFromPane(st, true);
  }

  // ---- Teardown -------------------------------------------------------

  private static teardownState(st: WinState): void {
    st.destroyed = true;
    if (st.rebuildTimer !== null) {
      try {
        st.win.clearTimeout(st.rebuildTimer);
      } catch {
        /* ignore */
      }
      st.rebuildTimer = null;
    }
    GraphViewFactory.stopLoop(st);
    GraphViewFactory.detachInteractions(st);

    if (st.resizeObs) {
      try {
        st.resizeObs.disconnect();
      } catch {
        /* ignore */
      }
      st.resizeObs = null;
    }
    if (st.mediaQuery && st.mediaListener) {
      try {
        if (typeof st.mediaQuery.removeEventListener === "function") {
          st.mediaQuery.removeEventListener("change", st.mediaListener);
        } else if (typeof (st.mediaQuery as any).removeListener === "function") {
          (st.mediaQuery as any).removeListener(st.mediaListener);
        }
      } catch {
        /* ignore */
      }
    }
    st.mediaQuery = null;
    st.mediaListener = null;

    // Close our tab if still open.
    if (st.tabId) {
      try {
        (st.win as any).Zotero_Tabs?.close?.(st.tabId);
      } catch {
        /* ignore */
      }
      st.tabId = null;
    }

    // Remove injected CSS link.
    try {
      st.win.document
        .getElementById("stylero-graphview-css")
        ?.remove();
    } catch {
      /* ignore */
    }

    st.renderer = null;
    st.sim = null;
    st.canvas = null;
    st.container = null;
    st.root = null;
    st.host = null;
    st.help = null;
    st.tooltip = null;
    st.badge = null;
    st.model = EMPTY_MODEL;
  }
}
