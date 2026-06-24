import { getPref } from "../utils/prefs";

/**
 * Theme toggle.
 *
 * A sun / crescent-moon button in the top tab toolbar (left of the "List all
 * tabs" menu button) that flips Zotero between light and dark. It drives the same
 * preference Zotero's own Settings > General > Appearance radio group writes:
 *
 *   browser.theme.toolbar-theme   0 = dark, 1 = light, 2 = auto (follow system)
 *
 * so it is a genuine app-wide toggle, not a plugin-only restyle. A two-state
 * button always lands on an explicit light/dark value; if Zotero is currently on
 * "auto" we resolve the live system value and flip to its opposite. A pref
 * observer (plus a per-window matchMedia listener for the auto case) keeps every
 * window's icon in sync when the theme changes here, from Settings, or elsewhere.
 *
 * The icon shows what a click will do: a moon while light (click to go dark) and
 * a sun while dark (click to go light).
 */

const THEME_PREF = "browser.theme.toolbar-theme";
const ENABLE_PREF = "themeToggle.enable" as const;
const BUTTON_ID = "stylero-theme-toggle";

// Feather-style icons, stroked with context-stroke so -moz-context-properties
// recolours them to currentColor (adapts to whichever theme is active).
const SUN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="context-stroke" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/>' +
  '<line x1="12" y1="1.6" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.4"/>' +
  '<line x1="1.6" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.4" y2="12"/>' +
  '<line x1="4.6" y1="4.6" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.4" y2="19.4"/>' +
  '<line x1="4.6" y1="19.4" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.4" y2="4.6"/></svg>';

const MOON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="context-stroke" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';

function svgDataUri(svg: string): string {
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

export class ThemeToggleFactory {
  private static readonly buttons = new WeakMap<
    _ZoteroTypes.MainWindow,
    any
  >();
  private static readonly cssLinks = new WeakMap<
    _ZoteroTypes.MainWindow,
    HTMLLinkElement
  >();
  private static readonly mqlListeners = new WeakMap<
    _ZoteroTypes.MainWindow,
    { mql: MediaQueryList; fn: () => void }
  >();
  private static prefObserverIDs: symbol[] = [];

  /** Global: observe the theme pref + our enable pref so all windows stay in sync. */
  static register(): void {
    if (this.prefObserverIDs.length) {
      return;
    }
    const prefix = addon.data.config.prefsPrefix;
    const onTheme = () => {
      if (addon?.data.alive) {
        this.syncAll();
      }
    };
    const onEnable = () => {
      if (!addon?.data.alive) {
        return;
      }
      const on = !!getPref(ENABLE_PREF);
      for (const win of Zotero.getMainWindows()) {
        if (on) {
          this.addButton(win);
        } else {
          this.removeButton(win);
        }
      }
    };
    try {
      this.prefObserverIDs.push(
        Zotero.Prefs.registerObserver(THEME_PREF, onTheme, true),
      );
      this.prefObserverIDs.push(
        Zotero.Prefs.registerObserver(
          `${prefix}.${ENABLE_PREF}`,
          onEnable,
          true,
        ),
      );
    } catch (e) {
      ztoolkit.log("[Stylero] theme-toggle observer registration failed", e);
    }
  }

  static registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (!getPref(ENABLE_PREF)) {
      return;
    }
    this.addButton(win);
  }

  static unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    this.removeButton(win);
  }

  static unregister(): void {
    for (const id of this.prefObserverIDs) {
      try {
        Zotero.Prefs.unregisterObserver(id);
      } catch (e) {
        ztoolkit.log("[Stylero] theme-toggle observer unregister failed", e);
      }
    }
    this.prefObserverIDs = [];
    for (const win of Zotero.getMainWindows()) {
      this.removeButton(win);
    }
  }

  // ---- button lifecycle ----------------------------------------------------

  private static addButton(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc || this.buttons.has(win)) {
      return;
    }
    const toolbar = doc.getElementById("zotero-tabs-toolbar");
    if (!toolbar) {
      return;
    }

    // Stylesheet (context-fill recolouring + icon sizing).
    if (!this.cssLinks.has(win)) {
      const link = doc.createElement("link") as unknown as HTMLLinkElement;
      link.setAttribute("type", "text/css");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute(
        "href",
        `chrome://${addon.data.config.addonRef}/content/themeToggle.css`,
      );
      doc.documentElement?.appendChild(link);
      this.cssLinks.set(win, link);
    }

    const btn = doc.createXULElement("toolbarbutton") as any;
    btn.id = BUTTON_ID;
    btn.setAttribute("class", "zotero-tb-button stylero-theme-toggle");
    btn.addEventListener("command", () => this.onClick(win));

    // Insert just left of the "List all tabs" menu button; fall back to prepend.
    const anchor = doc.getElementById("zotero-tb-tabs-menu");
    if (anchor && anchor.parentElement === toolbar) {
      toolbar.insertBefore(btn, anchor);
    } else {
      toolbar.insertBefore(btn, toolbar.firstChild);
    }
    this.buttons.set(win, btn);

    // Live auto-mode follow: when on "auto", a system theme change must repaint.
    try {
      const mql = win.matchMedia("(prefers-color-scheme: dark)");
      if (mql) {
        const fn = () => this.syncWindow(win);
        mql.addEventListener("change", fn);
        this.mqlListeners.set(win, { mql, fn });
      }
    } catch {
      /* matchMedia unavailable; pref observer still covers explicit changes */
    }

    this.syncWindow(win);
  }

  private static removeButton(win: _ZoteroTypes.MainWindow): void {
    const btn = this.buttons.get(win);
    if (btn) {
      btn.remove();
      this.buttons.delete(win);
    }
    const ml = this.mqlListeners.get(win);
    if (ml) {
      try {
        ml.mql.removeEventListener("change", ml.fn);
      } catch {
        /* window already gone */
      }
      this.mqlListeners.delete(win);
    }
    const link = this.cssLinks.get(win);
    if (link) {
      link.remove();
      this.cssLinks.delete(win);
    }
  }

  // ---- state ---------------------------------------------------------------

  private static getToolbarTheme(): number {
    const v = Number(Zotero.Prefs.get(THEME_PREF, true));
    return v === 0 || v === 1 || v === 2 ? v : 2;
  }

  /** True when the effective (resolved) theme is dark. */
  private static isDark(win: _ZoteroTypes.MainWindow): boolean {
    const v = this.getToolbarTheme();
    if (v === 0) return true;
    if (v === 1) return false;
    try {
      const mql = win.matchMedia("(prefers-color-scheme: dark)");
      return !!mql && mql.matches;
    } catch {
      return false;
    }
  }

  private static onClick(win: _ZoteroTypes.MainWindow): void {
    // Flip to the explicit opposite of the current effective theme.
    const next = this.isDark(win) ? 1 : 0; // dark -> light(1), light -> dark(0)
    try {
      Zotero.Prefs.set(THEME_PREF, next, true);
    } catch (e) {
      ztoolkit.log("[Stylero] theme-toggle set failed", e);
    }
    // Observer normally repaints, but sync immediately for snappiness.
    this.syncAll();
  }

  private static syncAll(): void {
    for (const win of Zotero.getMainWindows()) {
      this.syncWindow(win);
    }
  }

  private static syncWindow(win: _ZoteroTypes.MainWindow): void {
    const btn = this.buttons.get(win);
    if (!btn) {
      return;
    }
    const dark = this.isDark(win);
    // Show the icon for the action a click performs.
    btn.style.listStyleImage = svgDataUri(dark ? SUN_SVG : MOON_SVG);
    const tip = dark ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("tooltiptext", tip);
    btn.setAttribute("aria-label", tip);
  }
}
