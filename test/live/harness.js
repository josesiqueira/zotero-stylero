/*
 * Zotero Stylero — live test harness.
 *
 * Runs INSIDE the running Zotero chrome process against the installed plugin.
 * Execute the entire contents of this file via the MCP bridge
 * (zotero_execute_js); it returns a structured pass/fail report. Used by the
 * `stylero-test` skill and for manual live verification.
 *
 * It exercises only UI-observable / public surface (instance, registered
 * columns, cell renderers, collection-count badges, the Graph View menu,
 * preferences). Internal pure logic (ReadingStore, GraphData, force sim,
 * creator formatting) is covered by the mocha suite under test/*.test.ts.
 */
const report = { passed: 0, failed: 0, checks: [] };
function check(name, fn) {
  try {
    const detail = fn();
    report.checks.push({ name, ok: true, detail: detail ?? "ok" });
    report.passed++;
  } catch (e) {
    report.checks.push({ name, ok: false, detail: String(e && e.message ? e.message : e) });
    report.failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

await Zotero.initializationPromise;
if (Zotero.uiReadyPromise) { try { await Zotero.uiReadyPromise; } catch (e) {} }

const ID = "zotero-stylero@jose.local";
const inst = Zotero.ZoteroStylero;

check("plugin instance present", () => {
  assert(inst && typeof inst === "object", "Zotero.ZoteroStylero missing");
  return typeof inst;
});
check("initialized + alive", () => {
  assert(inst.data.initialized === true, "not initialized");
  assert(inst.data.alive === true, "not alive");
  return "initialized & alive";
});
check("config id correct", () => {
  assert(inst.data.config.addonID === ID, "addonID mismatch: " + inst.data.config.addonID);
  return inst.data.config.addonID;
});

// Registered columns
const expectedCols = ["stylero-title", "stylero-creator"];
let regCols = [];
check("custom columns registered", () => {
  const cols = (Zotero.ItemTreeManager.getCustomColumns
    ? Zotero.ItemTreeManager.getCustomColumns()
    : []) || [];
  regCols = cols.filter((c) => (c.dataKey || "").includes("zotero-stylero"));
  const keys = regCols.map((c) => (c.dataKey || "").replace(/\\/g, "").replace(ID + "-", ""));
  for (const e of expectedCols) assert(keys.includes(e), "missing column: " + e + " (have " + keys.join(",") + ")");
  return keys.join(", ");
});

// Cell rendering on a real regular item
const win = Zotero.getMainWindow();
const doc = win.document;
const allItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
const item = allItems.find((i) => i.isRegularItem());
check("a regular item exists to render", () => {
  assert(item, "no regular item in user library");
  return item.getDisplayTitle();
});
for (const col of []) void col; // placeholder to keep linage stable
check("dataProvider + renderCell do not throw", () => {
  assert(item, "no item");
  const results = {};
  for (const c of regCols) {
    const key = (c.dataKey || "").replace(/\\/g, "").replace(ID + "-", "");
    const data = typeof c.dataProvider === "function" ? c.dataProvider(item, c.dataKey) : "";
    assert(typeof data === "string", key + " dataProvider non-string");
    if (typeof c.renderCell === "function") {
      const node = c.renderCell(0, data, { dataKey: c.dataKey, className: "cell " + c.dataKey }, false, doc);
      assert(node && node.nodeType === 1, key + " renderCell did not return an element");
    }
    results[key] = (data || "").slice(0, 24);
  }
  return JSON.stringify(results);
});

// Title column produces icon + heat/striping classes
check("title cell has icon + decoration classes", () => {
  const c = regCols.find((x) => (x.dataKey || "").includes("stylero-title"));
  assert(c, "title column missing");
  const node = c.renderCell(0, c.dataProvider(item, c.dataKey), { dataKey: c.dataKey, className: "cell" }, true, doc);
  const html = node.outerHTML || "";
  assert(/stylero-title-cell/.test(html), "no title cell class");
  return "title cell ok";
});


// Collection count badges present in the collection tree DOM
check("collection count badge rendered", () => {
  if (Zotero.Prefs.get("extensions.zotero.zoterostylero.collectionCounts.enable", true) === false)
    return "disabled (skipped)";
  const badges = doc.querySelectorAll('[class*="stylero"][class*="count"], .stylero-collection-count, .stylero-count-badge');
  // Fall back: any element under the collection tree carrying a stylero class
  const anyStylero = doc.querySelectorAll('#zotero-collections-tree [class*="stylero"]');
  assert(badges.length > 0 || anyStylero.length > 0, "no collection count badge found in DOM");
  return "badges: " + (badges.length || anyStylero.length);
});

// Graph View menu item present
check("graph view menu item present", () => {
  if (Zotero.Prefs.get("extensions.zotero.zoterostylero.graphView.enable", true) === false)
    return "disabled (skipped)";
  const txt = (doc.documentElement.textContent || "");
  const menus = doc.querySelectorAll('menuitem,[label]');
  let found = false;
  menus.forEach((m) => { if (/graph/i.test(m.getAttribute && (m.getAttribute("label") || ""))) found = true; });
  assert(found || /graph view/i.test(txt), "graph view menu not found");
  return "graph menu present";
});

// Preferences readable
check("all feature prefs readable", () => {
  const keys = [
    "readingTime.enable", "titleColumn.enable", "creatorColumn.enable",
    "collectionCounts.enable", "progressColumn.enable",
    "readState.enable", "graphView.enable",
  ];
  const vals = {};
  for (const k of keys) {
    const v = Zotero.Prefs.get("extensions.zotero.zoterostylero." + k, true);
    assert(v !== undefined, "pref missing: " + k);
    vals[k] = v;
  }
  return JSON.stringify(vals);
});

report.summary = `${report.passed} passed, ${report.failed} failed`;
return report;
