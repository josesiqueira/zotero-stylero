/**
 * Called when the Stylero preference pane loads.
 *
 * All controls in preferences.xhtml bind directly to their prefs via the
 * `preference="<key>"` attribute (the scaffold prefixes the keys found in
 * prefs.js), so Zotero persists changes automatically. Feature modules read
 * those prefs live on the next render, so there is nothing to wire here beyond
 * keeping a reference to the window.
 */
export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = { window: _window } as NonNullable<
    typeof addon.data.prefs
  >;
}
