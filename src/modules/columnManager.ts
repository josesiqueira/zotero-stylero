import { getPref } from "../utils/prefs";

// LEGACY (migration-only). Older builds stored one layout PER item-tree id
// ({ [treeId]: { [dataKey]: prefEntry } }). That is exactly what caused the
// cross-view divergence bug (a layout applied while on "Recently Read" never
// touched the "default" tree that backs My Library / collections / searches).
// Kept solely so loadCanonical() can migrate an old install once. The
// authoritative store is now CANON_PREF below.
const LAYOUT_PREF = "extensions.zotero.zoterostylero.columnLayouts";

// AUTHORITATIVE store: ONE canonical layout, independent of tree id — an
// ordered list of columns. This is the single place the user's column choice
// lives; it is projected onto every target tree id so the layout looks
// identical in every view and survives a full restart.
const CANON_PREF = "extensions.zotero.zoterostylero.canonicalLayout";

// The item-tree ids the canonical layout is written to. `item-tree-main-default`
// backs My Library, EVERY collection and EVERY saved search (incl. "Categories");
// `item-tree-main-recentlyRead` is the separate "Recently Read" view. Both are
// in the `main` family where the stylero columns are enabled. Advanced-search /
// feeds are intentionally out of scope (stylero columns are not enabled there).
const TARGET_TREE_IDS = [
  "item-tree-main-default",
  "item-tree-main-recentlyRead",
] as const;

/** One column in the tree-id-independent canonical layout. */
interface CanonEntry {
  dataKey: string;
  hidden: boolean;
  /** Only set when the user deliberately chose a width (drives all views). */
  width?: number;
}

/**
 * Column Manager.
 *
 * A small dialog that lets the user reorder, show/hide, resize and clean up the
 * item-table columns, wired to Zotero's live column store (NOT the treePrefs.json
 * file directly): the plugin runs inside Zotero, so it is the live writer and
 * there is no quit-and-edit race.
 *
 * Why this exists: stacking/uninstalling column-injecting plugins leaves "ghost"
 * entries in the per-tree column store. Each entry carries an `ordinal`, and when
 * several columns share an ordinal Zotero's left-to-right order becomes ambiguous,
 * so the layout appears to "reset" on each launch (the order then depends on a
 * plugin startup race, not the user's saved edits). Zotero exposes no native UI
 * for ordinals, collisions or ghosts.
 *
 * The dialog renders a faithful "mockup" preview strip from an in-memory model
 * (add / remove / reorder / width); nothing touches the real tree until Apply.
 * Apply renumbers ordinals 0..n in list order (so collisions become structurally
 * impossible), drops purged ghosts, and persists via the live column API.
 *
 * Ghost rule (safe): a key is a removable ghost iff it is plugin-namespaced
 * (contains "@") AND is not currently registered with Zotero.ItemTreeManager.
 * Bare built-in keys (year, addedBy, feed, ...) are never purged — some built-ins
 * only appear in feeds / group libraries and would otherwise look like ghosts.
 *
 * Three entry points all open the same dialog: a toolbar button left of the
 * quick-search box, a View-menu item, and a "Manage columns…" item appended to
 * the column-header context menu.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

const ENABLE_PREF = "columnManager.enable" as const;
const BUTTON_ID = "stylero-column-manager-button";
const VIEW_MENU_ID = "stylero-column-manager-view";
const PICKER_ENTRY_ID = "stylero-column-picker-entry";
const PICKER_ORIGINAL_KEY = "__styleroColumnPickerOriginal";

export const PREFS: Record<string, string | number | boolean> = {
  "columnManager.enable": true,
};

// A "columns" glyph: three panels, stroked with context-stroke so the CSS
// -moz-context-properties recolours it to the toolbar text colour.
const COLUMNS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="context-stroke" stroke-width="1.8" stroke-linecap="round" ' +
  'stroke-linejoin="round"><rect x="3" y="4" width="5" height="16" rx="1"/>' +
  '<rect x="9.5" y="4" width="5" height="16" rx="1"/>' +
  '<rect x="16" y="4" width="5" height="16" rx="1"/></svg>';

function svgDataUri(svg: string): string {
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

interface ColRow {
  dataKey: string;
  label: string;
  hidden: boolean;
  /** Effective width used for the slider + mockup (number). */
  width: number;
  /** Original width from the prefs file, if any (drives "write only if touched"). */
  origWidth?: number;
  widthTouched: boolean;
  isGhost: boolean;
  ghostSource?: string;
  /** Whether the original ordinal collided with another column's. */
  collision: boolean;
  /** Marked for removal (ghosts only). */
  purge: boolean;
  /** The full original prefs entry, preserved verbatim except ordinal/hidden/width. */
  orig: any;
}

/** itemFields.title -> "Title"; plain custom labels ("Unread") pass through. */
function displayLabel(raw: unknown, fallbackKey: string): string {
  const s = typeof raw === "string" ? raw : "";
  if (s && s.includes(".") && !s.includes(" ")) {
    try {
      const resolved = Zotero.getString(s);
      if (resolved && resolved !== s) {
        return resolved;
      }
    } catch {
      /* not an l10n id */
    }
  }
  return s || fallbackKey;
}

/** Un-escape Zotero's dataKey escaping (\@ \. ) for display. */
function unescapeKey(k: string): string {
  return k.replace(/\\(.)/g, "$1");
}

/** Split a namespaced ghost key into {source pluginID, column name}. */
function parseGhost(key: string): { source: string; name: string } {
  const u = unescapeKey(key);
  const m = u.match(/^(.+@[A-Za-z0-9.]+)-(.+)$/);
  return m ? { source: m[1], name: m[2] } : { source: "", name: u };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  opts: {
    class?: string;
    text?: string;
    attrs?: Record<string, string>;
    style?: string;
  } = {},
): HTMLElement {
  const node = doc.createElementNS(HTML_NS, tag) as unknown as HTMLElement;
  if (opts.class) node.setAttribute("class", opts.class);
  if (opts.text != null) node.textContent = opts.text;
  if (opts.style) node.setAttribute("style", opts.style);
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  return node;
}

export class ColumnManagerFactory {
  private static readonly buttons = new WeakMap<
    _ZoteroTypes.MainWindow,
    any
  >();
  private static readonly cssLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();
  private static prefObserverIDs: symbol[] = [];
  // Per-window view-change listeners (collectionsView.onSelect), so switching
  // to another collection/search/Recently Read re-asserts the canonical layout.
  private static readonly selectListeners = new WeakMap<
    _ZoteroTypes.MainWindow,
    () => void
  >();

  // --- live dialog state (one dialog at a time) ---
  private static dialogWindow: any = null;
  private static mainWindow: _ZoteroTypes.MainWindow | null = null;
  private static model: ColRow[] = [];
  private static previewEl: HTMLElement | null = null;
  private static listEl: HTMLElement | null = null;
  private static dragIndex: number | null = null;

  // ------------------------------------------------------------------ global

  static register(): void {
    if (this.prefObserverIDs.length) {
      return;
    }
    const prefix = addon.data.config.prefsPrefix;
    const onEnable = () => {
      if (!addon?.data.alive) {
        return;
      }
      const on = !!getPref(ENABLE_PREF);
      for (const win of Zotero.getMainWindows()) {
        if (on) {
          this.addEntryPoints(win);
        } else {
          this.removeEntryPoints(win);
        }
      }
    };
    try {
      this.prefObserverIDs.push(
        Zotero.Prefs.registerObserver(
          `${prefix}.${ENABLE_PREF}`,
          onEnable,
          true,
        ),
      );
    } catch (e) {
      ztoolkit.log("[Stylero] columnManager observer registration failed", e);
    }
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref(ENABLE_PREF)) {
      return;
    }
    this.addEntryPoints(win);
    // Re-assert the saved column order after the tree has built (defeats the
    // startup registration race that otherwise scatters custom columns).
    void this.restoreLayout(win);
    // Re-assert on every view change so the layout is identical everywhere.
    void this.attachViewChangeHook(win);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    this.detachViewChangeHook(win);
    this.removeEntryPoints(win);
  }

  static unregister(): void {
    for (const id of this.prefObserverIDs) {
      try {
        Zotero.Prefs.unregisterObserver(id);
      } catch (e) {
        ztoolkit.log("[Stylero] columnManager observer unregister failed", e);
      }
    }
    this.prefObserverIDs = [];
    for (const win of Zotero.getMainWindows()) {
      this.removeEntryPoints(win);
    }
    this.removeViewMenu();
    try {
      this.dialogWindow?.close();
    } catch {
      /* already gone */
    }
    this.dialogWindow = null;
  }

  // ------------------------------------------------------------ entry points

  private static addEntryPoints(win: _ZoteroTypes.MainWindow): void {
    this.injectCss(win);
    this.addToolbarButton(win);
    this.patchColumnPicker(win);
    this.registerViewMenu(win);
  }

  private static removeEntryPoints(win: _ZoteroTypes.MainWindow): void {
    this.removeToolbarButton(win);
    this.unpatchColumnPicker(win);
    // View menu is shared across windows; only fully remove it on unregister().
  }

  private static injectCss(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc || this.cssLinks.has(win)) {
      return;
    }
    const link = doc.createElement("link") as unknown as HTMLLinkElement;
    link.setAttribute("type", "text/css");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute(
      "href",
      `chrome://${addon.data.config.addonRef}/content/columnManager.css`,
    );
    doc.documentElement?.appendChild(link);
    this.cssLinks.set(win, link);
  }

  private static addToolbarButton(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc || this.buttons.has(win)) {
      return;
    }
    const btn = doc.createXULElement("toolbarbutton") as any;
    btn.id = BUTTON_ID;
    btn.setAttribute("class", "zotero-tb-button stylero-column-manager-button");
    btn.setAttribute("tooltiptext", "Manage columns");
    btn.setAttribute("aria-label", "Manage columns");
    btn.style.listStyleImage = svgDataUri(COLUMNS_SVG);
    btn.addEventListener("command", () => this.openDialog(win));

    // Preferred slot: just left of the quick-search box in the items toolbar.
    const itemsToolbar = doc.getElementById("zotero-items-toolbar");
    const search = doc.getElementById("zotero-tb-search");
    if (search && search.parentElement === itemsToolbar) {
      itemsToolbar!.insertBefore(btn, search);
    } else if (itemsToolbar) {
      itemsToolbar.appendChild(btn);
    } else {
      // Fallback: the tabs toolbar (same anchor the theme toggle uses).
      const tabsToolbar = doc.getElementById("zotero-tabs-toolbar");
      const anchor = doc.getElementById("zotero-tb-tabs-menu");
      if (tabsToolbar && anchor && anchor.parentElement === tabsToolbar) {
        tabsToolbar.insertBefore(btn, anchor);
      } else if (tabsToolbar) {
        tabsToolbar.insertBefore(btn, tabsToolbar.firstChild);
      } else {
        return; // nowhere to put it
      }
    }
    this.buttons.set(win, btn);
  }

  private static removeToolbarButton(win: _ZoteroTypes.MainWindow): void {
    const btn = this.buttons.get(win);
    if (btn) {
      btn.remove();
      this.buttons.delete(win);
    }
    const link = this.cssLinks.get(win);
    if (link) {
      link.remove();
      this.cssLinks.delete(win);
    }
  }

  /** Append a "Manage columns…" item to Zotero's column-header context menu. */
  private static patchColumnPicker(win: _ZoteroTypes.MainWindow): void {
    const iv = (win as any).ZoteroPane?.itemsView;
    if (!iv || typeof iv.buildColumnPickerMenu !== "function") {
      return;
    }
    if (iv[PICKER_ORIGINAL_KEY]) {
      return; // already patched
    }
    const original = iv.buildColumnPickerMenu;
    const self = this;
    const wrapper = function (this: any, menupopup: any) {
      const result = original.apply(this, arguments as any);
      try {
        const doc = menupopup.ownerDocument;
        const w = doc.defaultView;
        const sep = doc.createXULElement("menuseparator");
        const item = doc.createXULElement("menuitem");
        item.id = PICKER_ENTRY_ID;
        item.setAttribute("label", "Manage columns…");
        item.addEventListener("command", () => self.openDialog(w));
        menupopup.appendChild(sep);
        menupopup.appendChild(item);
      } catch (e) {
        ztoolkit.log("[Stylero] column-picker patch append failed", e);
      }
      return result;
    };
    iv[PICKER_ORIGINAL_KEY] = original;
    iv.buildColumnPickerMenu = wrapper;
  }

  private static unpatchColumnPicker(win: _ZoteroTypes.MainWindow): void {
    const iv = (win as any).ZoteroPane?.itemsView;
    if (!iv) {
      return;
    }
    const original = iv[PICKER_ORIGINAL_KEY];
    if (original) {
      iv.buildColumnPickerMenu = original;
      delete iv[PICKER_ORIGINAL_KEY];
    }
  }

  private static registerViewMenu(_win: _ZoteroTypes.MainWindow): void {
    // ztoolkit.Menu targets the shared main-window menus; register exactly once.
    if (Zotero.getMainWindows()[0]?.document?.getElementById(VIEW_MENU_ID)) {
      return;
    }
    try {
      ztoolkit.Menu.register("menuView", {
        tag: "menuitem",
        id: VIEW_MENU_ID,
        label: "Manage columns…",
        commandListener: (ev: Event) => {
          const w =
            ((ev?.target as any)?.ownerGlobal as _ZoteroTypes.MainWindow) ||
            Zotero.getMainWindow();
          this.openDialog(w);
        },
      });
    } catch (e) {
      ztoolkit.log("[Stylero] columnManager view-menu registration failed", e);
    }
  }

  private static removeViewMenu(): void {
    try {
      ztoolkit.Menu.unregister(VIEW_MENU_ID);
    } catch {
      /* not in this generation's registry */
    }
    for (const win of Zotero.getMainWindows()) {
      try {
        let el2: Element | null;
        const doc = win.document;
        while (doc && (el2 = doc.getElementById(VIEW_MENU_ID))) {
          el2.remove();
        }
      } catch (e) {
        ztoolkit.log("[Stylero] columnManager view-menu cleanup failed", e);
      }
    }
  }

  // ------------------------------------------------------------------ dialog

  static openDialog(win: _ZoteroTypes.MainWindow): void {
    if (this.dialogWindow && !this.dialogWindow.closed) {
      try {
        this.dialogWindow.focus();
        return;
      } catch {
        this.dialogWindow = null;
      }
    }
    this.mainWindow = win;
    try {
      this.dialogWindow = win.openDialog(
        `chrome://${addon.data.config.addonRef}/content/columnManager.xhtml`,
        "stylero-column-manager",
        "chrome,centerscreen,resizable,dialog=no,width=780,height=620",
        { mainWindow: win },
      );
    } catch (e) {
      ztoolkit.log("[Stylero] columnManager openDialog failed", e);
    }
  }

  /** Called from the dialog's onload (via the onColumnManagerEvent hook). */
  static onDialogLoad(dialogWindow: Window): void {
    this.dialogWindow = dialogWindow;
    const args = (dialogWindow as any).arguments?.[0];
    const main: _ZoteroTypes.MainWindow =
      args?.mainWindow || this.mainWindow || Zotero.getMainWindow();
    this.mainWindow = main;

    dialogWindow.addEventListener("unload", () => {
      if (this.dialogWindow === dialogWindow) {
        this.dialogWindow = null;
      }
      this.previewEl = null;
      this.listEl = null;
      this.model = [];
    });

    const iv = (main as any).ZoteroPane?.itemsView;
    if (!iv) {
      return;
    }
    this.model = this.buildModel(iv);
    this.buildSkeleton(dialogWindow.document);
    this.renderModel(dialogWindow.document);
  }

  private static buildModel(iv: any): ColRow[] {
    const origPrefs = (iv._getColumnPrefs && iv._getColumnPrefs()) || {};
    const liveCols = (iv._getColumns && iv._getColumns()) || [];

    const labelByKey = new Map<string, string>();
    const widthByKey = new Map<string, number>();
    for (const c of liveCols) {
      if (!c || !c.dataKey) continue;
      labelByKey.set(c.dataKey, displayLabel(c.label, c.dataKey));
      const w = Number(c.width);
      if (Number.isFinite(w) && w > 0) widthByKey.set(c.dataKey, w);
    }

    const registered = this.registeredKeys();

    // Detect original ordinal collisions (the actual bug being surfaced).
    const ordinalCounts = new Map<number, number>();
    for (const key of Object.keys(origPrefs)) {
      const o = origPrefs[key]?.ordinal;
      if (typeof o === "number") {
        ordinalCounts.set(o, (ordinalCounts.get(o) || 0) + 1);
      }
    }

    const rows: ColRow[] = [];
    for (const key of Object.keys(origPrefs)) {
      const p = origPrefs[key] || {};
      const namespaced = key.includes("@");
      const isGhost = namespaced && !registered.has(key);

      let label: string;
      let ghostSource: string | undefined;
      if (labelByKey.has(key)) {
        label = labelByKey.get(key)!;
      } else if (isGhost) {
        const g = parseGhost(key);
        ghostSource = g.source;
        label = g.name;
      } else {
        label = displayLabel(undefined, unescapeKey(key));
      }

      const origWidth =
        typeof p.width === "number" && p.width > 0 ? p.width : undefined;
      const width = origWidth ?? widthByKey.get(key) ?? 100;
      const ordinal = typeof p.ordinal === "number" ? p.ordinal : 9999;

      rows.push({
        dataKey: key,
        label,
        hidden: !!p.hidden,
        width,
        origWidth,
        widthTouched: false,
        isGhost,
        ghostSource,
        collision:
          typeof p.ordinal === "number" &&
          (ordinalCounts.get(p.ordinal) || 0) > 1,
        purge: false,
        orig: p,
      });
    }

    rows.sort((a, b) => {
      const ao = typeof a.orig.ordinal === "number" ? a.orig.ordinal : 9999;
      const bo = typeof b.orig.ordinal === "number" ? b.orig.ordinal : 9999;
      return ao - bo;
    });
    return rows;
  }

  // ------------------------------------------------------------------- views

  private static buildSkeleton(doc: Document): void {
    const root = doc.getElementById("stylero-cm-root") as unknown as HTMLElement;
    if (!root) {
      return;
    }
    root.textContent = "";

    // Load-bearing layout applied INLINE (not just via columnManager.css).
    // Reason: Zotero aggressively caches chrome://.../content/*.css, so a
    // reinstall can keep serving an old stylesheet that lacks the flex/height/
    // min-height:0 fix, which silently breaks scrolling (the list grows to full
    // content height and pushes the footer off a clipped window with no
    // scrollbar). Inline styles ride the JS bundle, which DOES reload, so the
    // fix survives a stale CSS cache. The min-height:0 entries are the crux:
    // they defeat the default flex min-height:auto that otherwise refuses to
    // shrink the list below its content height. (CSS keeps the same rules for
    // fresh installs and theming.)
    try {
      (doc.documentElement as unknown as HTMLElement).style.height = "100%";
    } catch {
      /* ignore */
    }
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.height = "100%";
    root.style.minHeight = "0";
    root.style.boxSizing = "border-box";

    const intro = el(doc, "div", {
      class: "cm-intro",
      text:
        "Drag to reorder, toggle visibility, set width, and purge ghost columns " +
        "left behind by uninstalled plugins. Nothing changes until you press Apply.",
    });
    root.appendChild(intro);

    root.appendChild(el(doc, "div", { class: "cm-section-label", text: "Preview (final layout)" }));
    const preview = el(doc, "div", {
      class: "cm-preview",
      style: "flex: 0 0 auto;",
    });
    this.previewEl = preview;
    root.appendChild(preview);

    root.appendChild(el(doc, "div", { class: "cm-section-label", text: "Columns" }));
    const list = el(doc, "div", {
      class: "cm-list",
      style: "flex: 1 1 auto; min-height: 0; overflow-y: auto;",
    });
    this.listEl = list;
    root.appendChild(list);

    const footer = el(doc, "div", { class: "cm-footer", style: "flex: 0 0 auto;" });
    const repair = el(doc, "button", {
      class: "cm-btn cm-repair",
      text: "Repair ordinals + purge ghosts",
    });
    repair.addEventListener("click", () => this.autoRepair(doc));
    const spacer = el(doc, "div", { class: "cm-spacer" });
    const apply = el(doc, "button", {
      class: "cm-btn cm-apply",
      text: "Apply",
    });
    apply.addEventListener("click", () => void this.applyModel(doc));
    const close = el(doc, "button", { class: "cm-btn cm-close", text: "Close" });
    close.addEventListener("click", () => {
      try {
        (doc.defaultView as any)?.close();
      } catch {
        /* ignore */
      }
    });
    footer.append(repair, spacer, apply, close);
    root.appendChild(footer);
  }

  private static renderModel(doc: Document): void {
    this.renderPreview(doc);
    this.renderList(doc);
  }

  private static renderPreview(doc: Document): void {
    const preview = this.previewEl;
    if (!preview) {
      return;
    }
    preview.textContent = "";
    const visible = this.model.filter((r) => !r.hidden && !r.isGhost && !r.purge);
    if (!visible.length) {
      preview.appendChild(
        el(doc, "div", { class: "cm-preview-empty", text: "(no visible columns)" }),
      );
      return;
    }
    for (const row of visible) {
      const chip = el(doc, "div", {
        class: "cm-chip",
        text: row.label,
        style: `flex-basis:${Math.max(28, Math.round(row.width * 0.45))}px`,
      });
      chip.setAttribute("title", `${row.label}, ${Math.round(row.width)}px`);
      preview.appendChild(chip);
    }
  }

  private static renderList(doc: Document): void {
    const list = this.listEl;
    if (!list) {
      return;
    }
    list.textContent = "";

    // Running projected ordinal across kept (non-purged) rows — always unique.
    let projected = 0;
    this.model.forEach((row, index) => {
      const r = el(doc, "div", { class: "cm-row" });
      if (row.purge) r.classList.add("is-purged");
      if (row.isGhost) r.classList.add("is-ghost");
      if (row.collision) r.classList.add("is-collision");
      r.setAttribute("draggable", "true");
      r.setAttribute("data-key", row.dataKey);

      r.addEventListener("dragstart", () => {
        this.dragIndex = index;
      });
      r.addEventListener("dragover", (ev) => ev.preventDefault());
      r.addEventListener("drop", (ev) => {
        ev.preventDefault();
        this.moveRow(this.dragIndex, index);
        this.dragIndex = null;
        this.renderModel(doc);
      });

      const handle = el(doc, "span", { class: "cm-handle", text: "⠿" });
      r.appendChild(handle);

      const ord = el(doc, "span", {
        class: "cm-ord",
        text: row.purge ? "-" : String(projected),
      });
      if (!row.purge) projected++;
      r.appendChild(ord);

      const check = el(doc, "input", {
        class: "cm-visible",
        attrs: { type: "checkbox" },
      }) as HTMLInputElement;
      check.checked = !row.hidden;
      check.disabled = row.purge;
      check.addEventListener("change", () => {
        row.hidden = !check.checked;
        this.renderModel(doc);
      });
      r.appendChild(check);

      const labelWrap = el(doc, "span", { class: "cm-label" });
      labelWrap.appendChild(el(doc, "span", { class: "cm-name", text: row.label }));
      const meta = el(doc, "span", { class: "cm-key", text: row.dataKey });
      labelWrap.appendChild(meta);
      if (row.isGhost) {
        labelWrap.appendChild(
          el(doc, "span", {
            class: "cm-ghost-tag",
            text: row.ghostSource ? `ghost · ${row.ghostSource}` : "ghost",
          }),
        );
      }
      if (row.collision) {
        labelWrap.appendChild(
          el(doc, "span", {
            class: "cm-collision-tag",
            text: `was ordinal ${row.orig.ordinal}`,
          }),
        );
      }
      r.appendChild(labelWrap);

      const widthWrap = el(doc, "span", { class: "cm-width" });
      const slider = el(doc, "input", {
        class: "cm-slider",
        attrs: {
          type: "range",
          min: "40",
          max: String(Math.max(800, Math.round(row.width))),
          value: String(Math.round(row.width)),
        },
      }) as HTMLInputElement;
      slider.disabled = row.purge || row.hidden;
      const widthVal = el(doc, "span", {
        class: "cm-width-val",
        text: `${Math.round(row.width)}px`,
      });
      slider.addEventListener("input", () => {
        row.width = Number(slider.value);
        row.widthTouched = true;
        widthVal.textContent = `${Math.round(row.width)}px`;
        this.renderPreview(doc);
      });
      widthWrap.append(slider, widthVal);
      r.appendChild(widthWrap);

      const up = el(doc, "button", { class: "cm-move cm-up", text: "▲" });
      up.addEventListener("click", () => {
        this.moveRow(index, index - 1);
        this.renderModel(doc);
      });
      const down = el(doc, "button", { class: "cm-move cm-down", text: "▼" });
      down.addEventListener("click", () => {
        this.moveRow(index, index + 1);
        this.renderModel(doc);
      });
      r.append(up, down);

      if (row.isGhost) {
        const purge = el(doc, "button", {
          class: "cm-purge",
          text: row.purge ? "↺" : "🗑",
        });
        purge.setAttribute(
          "title",
          row.purge ? "Keep this column" : "Remove this ghost column",
        );
        purge.addEventListener("click", () => {
          row.purge = !row.purge;
          this.renderModel(doc);
        });
        r.appendChild(purge);
      }

      list.appendChild(r);
    });
  }

  private static moveRow(from: number | null, to: number): void {
    if (from == null || from < 0 || from >= this.model.length) return;
    if (to < 0 || to >= this.model.length || to === from) return;
    const [item] = this.model.splice(from, 1);
    this.model.splice(to, 0, item);
  }

  private static autoRepair(doc: Document): void {
    // Mark every ghost for removal; contiguous ordinals are produced at Apply
    // (the projected-ordinal column already previews the clean result).
    for (const row of this.model) {
      if (row.isGhost) row.purge = true;
    }
    this.renderModel(doc);
  }

  // ---- canonical layout: one authoritative source, projected everywhere ----
  //
  // The bug this replaces: the layout used to be saved and restored PER active
  // tree id, so applying while on one view (e.g. Recently Read) never reached
  // the "default" tree that backs My Library / collections / searches. Now there
  // is ONE canonical layout (CANON_PREF). It is projected onto EVERY target tree
  // id at three moments — Apply, startup, and every view change — so the columns
  // look identical everywhere and survive a full restart.

  /** LEGACY read for one-time migration only. */
  private static loadLayouts(): Record<string, Record<string, any>> {
    try {
      const raw = Zotero.Prefs.get(LAYOUT_PREF, true) as string;
      if (raw) return JSON.parse(raw) || {};
    } catch (e) {
      ztoolkit.log("[Stylero] loadLayouts failed", e);
    }
    return {};
  }

  /** Round a possibly string/float width to a positive int, else undefined. */
  private static normalizeWidth(w: unknown): number | undefined {
    const n = Math.round(Number(w));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /** dataKeys of the plugin columns currently registered with Zotero. */
  private static registeredKeys(): Set<string> {
    const set = new Set<string>();
    try {
      const mgr: any = Zotero.ItemTreeManager;
      const custom = mgr.getCustomColumns ? mgr.getCustomColumns() : [];
      for (const c of custom || []) {
        if (c && c.dataKey) set.add(c.dataKey);
      }
    } catch (e) {
      ztoolkit.log("[Stylero] getCustomColumns failed", e);
    }
    return set;
  }

  /** This plugin's OWN custom-column keys in the canonical layout (for the
   * startup race gate). Excludes other plugins' columns (e.g. open-citations),
   * which may be legitimately absent, so we never wait forever on them. */
  private static ownColumnKeys(canon: CanonEntry[]): string[] {
    const id = addon.data.config.addonID;
    return canon
      .map((e) => e.dataKey)
      .filter((k) => k.includes("@") && unescapeKey(k).startsWith(`${id}-`));
  }

  /**
   * The authoritative, tree-id-independent layout. If CANON_PREF is empty,
   * migrate ONCE from the legacy per-tree store's `item-tree-main-default`
   * (its order was the user's last desired order), then persist + return it.
   */
  private static loadCanonical(): CanonEntry[] {
    try {
      const raw = Zotero.Prefs.get(CANON_PREF, true) as string;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as CanonEntry[];
      }
    } catch (e) {
      ztoolkit.log("[Stylero] loadCanonical failed", e);
    }
    // One-time migration from the legacy per-tree store.
    const legacy = this.loadLayouts()["item-tree-main-default"];
    if (legacy && typeof legacy === "object") {
      const canon = Object.keys(legacy)
        .map((k) => ({ k, e: legacy[k] || {} }))
        .sort(
          (a, b) =>
            (typeof a.e.ordinal === "number" ? a.e.ordinal : 9999) -
            (typeof b.e.ordinal === "number" ? b.e.ordinal : 9999),
        )
        .map(({ k, e }) => {
          const entry: CanonEntry = { dataKey: k, hidden: !!e.hidden };
          const w = this.normalizeWidth(e.width);
          if (w != null) entry.width = w;
          return entry;
        });
      if (canon.length) {
        this.saveCanonical(canon);
        return canon;
      }
    }
    return [];
  }

  private static saveCanonical(canon: CanonEntry[]): void {
    try {
      Zotero.Prefs.set(CANON_PREF, JSON.stringify(canon), true);
    } catch (e) {
      ztoolkit.log("[Stylero] saveCanonical failed", e);
    }
  }

  /**
   * Project the canonical layout onto ONE tree's prefs blob: dense ordinals
   * 0..N-1 (kills duplicate-ordinal scramble), ghosts dropped (namespaced +
   * unregistered, e.g. stylero-title), widths normalized. Columns present in
   * `existing` but absent from the canonical order (a view's own built-in
   * extras) are appended, hidden, after the canonical block. sortDirection is
   * preserved per-view from `existing` (we control order/visibility/width, not
   * the user's live sort).
   */
  private static projectOnto(
    canon: CanonEntry[],
    existing: Record<string, any>,
    registered: Set<string>,
  ): Record<string, any> {
    const isGhost = (key: string) =>
      key.includes("@") && !registered.has(key);
    const out: Record<string, any> = {};
    let ordinal = 0;
    const placed = new Set<string>();

    for (const entry of canon) {
      const key = entry.dataKey;
      if (placed.has(key) || isGhost(key)) continue;
      const prev = existing[key] || {};
      const merged: any = { ...prev, dataKey: key, ordinal: ordinal++ };
      merged.hidden = !!entry.hidden;
      const w = this.normalizeWidth(entry.width ?? prev.width);
      if (w != null) merged.width = w;
      else delete merged.width;
      out[key] = merged;
      placed.add(key);
    }

    // Append any real column this view already had that the canonical layout
    // doesn't mention (keeps view-specific built-ins available, just hidden).
    for (const key of Object.keys(existing)) {
      if (placed.has(key) || isGhost(key)) continue;
      const prev = existing[key] || {};
      const merged: any = {
        ...prev,
        dataKey: key,
        ordinal: ordinal++,
        hidden: true,
      };
      const w = this.normalizeWidth(prev.width);
      if (w != null) merged.width = w;
      else delete merged.width;
      out[key] = merged;
      placed.add(key);
    }
    return out;
  }

  /**
   * Write the canonical layout to the ACTIVE view via the live column API.
   * Order matters: store + re-render FIRST so Zotero settles the ordinals, then
   * cancel any pending debounced (60s) write, then force-flush LAST so the
   * settled order lands on disk and cannot be clobbered.
   */
  private static async applyToActive(iv: any, win: any): Promise<void> {
    if (!iv || !iv.id) return;
    // Only ever touch the scoped target trees. Out-of-scope views (feeds, group
    // libraries, advanced search, My Publications, Trash) keep their own native
    // columns untouched, so we never inject the stylero columns where they
    // aren't wanted.
    if (!(TARGET_TREE_IDS as readonly string[]).includes(iv.id)) return;
    try {
      const canon = this.loadCanonical();
      if (!canon.length) return;
      const existing = (iv._getColumnPrefs && iv._getColumnPrefs()) || {};
      const prefs = this.projectOnto(canon, existing, this.registeredKeys());
      iv._columnPrefs = prefs;
      iv._storeColumnPrefs?.(prefs);
      iv._columnPrefs = prefs;
      iv.forceUpdate?.();
      iv.refreshAndMaintainSelection?.();
      if (iv._writeColumnsTimeout) {
        try {
          win.clearTimeout(iv._writeColumnsTimeout);
        } catch {
          /* ignore */
        }
        iv._writeColumnsTimeout = null;
      }
      if (typeof iv._writeColumnPrefsToFile === "function") {
        await iv._writeColumnPrefsToFile(true);
      }
    } catch (e) {
      ztoolkit.log("[Stylero] applyToActive failed", e);
    }
  }

  /**
   * Seed treePrefs.json for every target tree id that is NOT the active one.
   * Zotero's own writer only ever persists persistSettings[this.id], so the
   * inactive views (e.g. Recently Read while you sit on a collection) can only
   * be fixed by editing the file directly. Read-modify-write, atomically, so
   * other tree ids in the file are preserved.
   */
  private static async seedInactiveTrees(activeId: string): Promise<void> {
    try {
      const canon = this.loadCanonical();
      if (!canon.length) return;
      const registered = this.registeredKeys();
      const path = PathUtils.join(
        (Zotero as any).Profile.dir,
        "treePrefs.json",
      );

      let persist: Record<string, any> = {};
      try {
        persist = ((await IOUtils.readJSON(path)) as Record<string, any>) || {};
      } catch {
        persist = {}; // absent or unreadable: start fresh, preserve nothing lost
      }
      if (typeof persist !== "object" || persist === null) return;

      let changed = false;
      for (const id of TARGET_TREE_IDS) {
        if (id === activeId) continue;
        persist[id] = this.projectOnto(canon, persist[id] || {}, registered);
        changed = true;
      }
      if (!changed) return;

      const tmp = `${path}.stylero.tmp`;
      await IOUtils.writeJSON(tmp, persist);
      await IOUtils.move(tmp, path, { noOverwrite: false });
      ztoolkit.log("[Stylero] seeded inactive tree layouts");
    } catch (e) {
      ztoolkit.log("[Stylero] seedInactiveTrees failed", e);
    }
  }

  /**
   * Startup self-heal. Waits for the items view AND for this plugin's own
   * custom columns to actually register (so an early projection can't mistake a
   * not-yet-registered stylero column for a ghost and drop it — the structural
   * fix for "order lost on restart"). Then applies to the active view, seeds the
   * inactive ones, and schedules two delayed re-asserts to outlast any late
   * async re-derivation. Idempotent.
   */
  static async restoreLayout(win: _ZoteroTypes.MainWindow): Promise<void> {
    try {
      const canon = this.loadCanonical();
      if (!canon.length) return;

      // Wait (up to ~3s) for the items view to exist with a tree id.
      let iv: any = null;
      for (let i = 0; i < 30; i++) {
        iv = (win as any).ZoteroPane?.itemsView;
        if (iv && iv.id && typeof iv._getColumnPrefs === "function") break;
        iv = null;
        await new Promise<void>((r) => win.setTimeout(r, 100));
      }
      if (!iv) return;
      try {
        await iv.waitForLoad?.();
      } catch {
        /* ignore */
      }

      // Wait (up to ~3s) until our own columns are registered.
      const need = this.ownColumnKeys(canon);
      for (let i = 0; i < 30 && need.length; i++) {
        const reg = this.registeredKeys();
        if (need.every((k) => reg.has(k))) break;
        await new Promise<void>((r) => win.setTimeout(r, 100));
      }

      await this.applyToActive(iv, win);
      await this.seedInactiveTrees(iv.id);
      ztoolkit.log(`[Stylero] restored canonical column layout on ${iv.id}`);

      // Outlast any late registration / async refresh cascade.
      const reassert = () => {
        const iv2 = (win as any).ZoteroPane?.itemsView;
        if (iv2?.id && addon?.data.alive) void this.applyToActive(iv2, win);
      };
      win.setTimeout(reassert, 800);
      win.setTimeout(reassert, 2500);
    } catch (e) {
      ztoolkit.log("[Stylero] restoreLayout failed", e);
    }
  }

  /**
   * Re-assert the canonical layout whenever the user switches view. Fires after
   * collectionsView.onSelect, i.e. after changeCollectionTreeRow has swapped in
   * the new tree id and loaded its (possibly scrambled) prefs — the exact moment
   * to override. Only touches the active view (a click must not rewrite the
   * whole file); inactive ids were already seeded at Apply/startup.
   */
  private static async attachViewChangeHook(
    win: _ZoteroTypes.MainWindow,
  ): Promise<void> {
    try {
      if (this.selectListeners.has(win)) return;
      // Wait (up to ~3s) for collectionsView with an onSelect emitter.
      let cv: any = null;
      for (let i = 0; i < 30; i++) {
        cv = (win as any).ZoteroPane?.collectionsView;
        if (cv && typeof cv.onSelect?.addListener === "function") break;
        cv = null;
        await new Promise<void>((r) => win.setTimeout(r, 100));
      }
      if (!cv) return;

      const cb = async () => {
        if (!addon?.data.alive) return;
        // Respect a runtime disable of the feature (the addon stays alive when
        // only the enable pref flips, so this is not covered by the check above).
        if (!getPref(ENABLE_PREF)) return;
        if (!this.loadCanonical().length) return;
        const iv = (win as any).ZoteroPane?.itemsView;
        if (!iv?.id) return;
        try {
          await iv._itemTreeLoadingDeferred?.promise;
        } catch {
          /* ignore */
        }
        const iv2 = (win as any).ZoteroPane?.itemsView;
        if (iv2?.id) void this.applyToActive(iv2, win);
      };
      cv.onSelect.addListener(cb);
      this.selectListeners.set(win, cb);
    } catch (e) {
      ztoolkit.log("[Stylero] attachViewChangeHook failed", e);
    }
  }

  private static detachViewChangeHook(win: _ZoteroTypes.MainWindow): void {
    const cb = this.selectListeners.get(win);
    if (!cb) return;
    try {
      (win as any).ZoteroPane?.collectionsView?.onSelect?.removeListener(cb);
    } catch {
      /* already gone */
    }
    this.selectListeners.delete(win);
  }

  private static async applyModel(doc: Document): Promise<void> {
    const main = this.mainWindow;
    const iv = (main as any)?.ZoteroPane?.itemsView;
    if (!iv) {
      ztoolkit.log("[Stylero] columnManager apply: no itemsView");
      return;
    }

    // The dialog model IS the new canonical layout (order + hidden + width).
    // Ghosts/purged rows are excluded, so ONE Apply purges them from every tree.
    const canon: CanonEntry[] = this.model
      .filter((r) => !r.purge && !r.isGhost)
      .map((r) => {
        const e: CanonEntry = { dataKey: r.dataKey, hidden: !!r.hidden };
        // Only make a width authoritative-everywhere when the user deliberately
        // chose it via the dialog slider. Otherwise leave it undefined so
        // projectOnto keeps each view's existing (incl. native drag-resized)
        // width instead of stamping one canonical value over every view.
        if (r.widthTouched) {
          const w = this.normalizeWidth(r.width);
          if (w != null) e.width = w;
        }
        return e;
      });
    this.saveCanonical(canon);

    await this.applyToActive(iv, main);
    await this.seedInactiveTrees(iv.id);

    // Re-read live state so the dialog reflects exactly what was committed.
    this.model = this.buildModel(iv);
    this.renderModel(doc);
  }
}
