import { assert } from "chai";
import { config } from "../package.json";

/**
 * Verifies the custom item-tree columns are registered with
 * Zotero.ItemTreeManager, and that each registered column's dataProvider /
 * renderCell behave (return a value / a DOM node) for a real regular item.
 *
 * The registered dataKey is namespaced with the pluginID, so we match each
 * column by checking the stored option's dataKey CONTAINS the logical suffix
 * (e.g. "stylero-title") and that pluginID is ours.
 */

const ADDON_ID = config.addonID;

/** Always-on columns (progress is off by default, asserted separately). */
const ALWAYS_ON = [
  "stylero-title",
  "stylero-creator",
  "stylero-readstate",
];

interface StoredColumn {
  dataKey: string;
  label: string;
  pluginID?: string;
  dataProvider?: (item: Zotero.Item, dataKey: string) => string;
  renderCell?: (
    index: number,
    data: string,
    column: any,
    isFirstColumn: boolean,
    doc: Document,
  ) => HTMLElement;
}

function ourColumns(): StoredColumn[] {
  const all = (Zotero.ItemTreeManager as any)._customColumns || {};
  return (Object.values(all) as StoredColumn[]).filter(
    (c) => c && c.pluginID === ADDON_ID,
  );
}

function findColumn(suffix: string): StoredColumn | undefined {
  return ourColumns().find((c) => c.dataKey.includes(suffix));
}

describe("columns: registration", function () {
  let tempItem: Zotero.Item;

  before(async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Stylero Columns Test Item");
    item.setCreators([
      { firstName: "Ada", lastName: "Lovelace", creatorType: "author" } as any,
    ]);
    await item.saveTx();
    tempItem = item;
  });

  after(async function () {
    if (tempItem) {
      await tempItem.eraseTx();
    }
  });

  it("registers the four always-on Stylero columns", function () {
    for (const suffix of ALWAYS_ON) {
      const col = findColumn(suffix);
      assert.ok(col, `expected a registered column matching "${suffix}"`);
      assert.strictEqual(
        col!.pluginID,
        ADDON_ID,
        `${suffix} should be owned by ${ADDON_ID}`,
      );
      assert.isString(col!.label);
      assert.isNotEmpty(col!.label);
    }
  });

  it("registers the progress column only when enabled", function () {
    const enabled = Zotero.Prefs.get(
      `${config.prefsPrefix}.progressColumn.enable`,
      true,
    );
    const col = findColumn("stylero-progress");
    if (enabled) {
      assert.ok(col, "progress column should be present when enabled");
    } else {
      assert.isUndefined(
        col,
        "progress column must NOT be registered when disabled (default off)",
      );
    }
  });

  it("each column dataProvider returns a string for a regular item", function () {
    for (const suffix of ALWAYS_ON) {
      const col = findColumn(suffix)!;
      assert.ok(col.dataProvider, `${suffix} should have a dataProvider`);
      const value = col.dataProvider!(tempItem, col.dataKey);
      assert.isString(value, `${suffix} dataProvider should return a string`);
    }
  });

  it("title + creator dataProviders return non-empty content", function () {
    const title = findColumn("stylero-title")!;
    assert.isNotEmpty(
      title.dataProvider!(tempItem, title.dataKey),
      "title dataProvider should mirror the display title",
    );

    const creator = findColumn("stylero-creator")!;
    assert.isNotEmpty(
      creator.dataProvider!(tempItem, creator.dataKey),
      "creator dataProvider should format the single author",
    );
  });

  it("each column renderCell (if present) returns a DOM node without throwing", function () {
    const win = Zotero.getMainWindow();
    assert.ok(win, "a main window is required to build cells");
    const doc = win.document;

    for (const suffix of ALWAYS_ON) {
      const col = findColumn(suffix)!;
      if (typeof col.renderCell !== "function") {
        // title/readstate render cells; creator is plain-text (none).
        continue;
      }
      const data = col.dataProvider
        ? col.dataProvider(tempItem, col.dataKey)
        : "";
      const node = col.renderCell(
        0,
        data,
        { className: "test", dataKey: col.dataKey },
        false,
        doc,
      );
      assert.ok(node, `${suffix} renderCell should return a node`);
      assert.strictEqual(
        node.nodeType,
        1,
        `${suffix} renderCell should return an element node`,
      );
      assert.include(
        node.className,
        "cell",
        `${suffix} cell should carry the 'cell' class`,
      );
    }
  });
});
