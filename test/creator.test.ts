import { assert } from "chai";
import { config } from "../package.json";

/**
 * Creator column formatting. Creates a temp item with 3 authors and exercises
 * the registered "stylero-creator" column's dataProvider under the default
 * template plus custom template / join / slice prefs. All prefs are restored
 * after the suite.
 */

const ADDON_ID = config.addonID;
const PREFIX = config.prefsPrefix;

function prefKey(k: string): string {
  return `${PREFIX}.${k}`;
}

function getPref(k: string): any {
  return Zotero.Prefs.get(prefKey(k), true);
}

function setPref(k: string, v: any): void {
  Zotero.Prefs.set(prefKey(k), v, true);
}

interface StoredColumn {
  dataKey: string;
  pluginID?: string;
  dataProvider?: (item: Zotero.Item, dataKey: string) => string;
}

function creatorColumn(): StoredColumn {
  const all = (Zotero.ItemTreeManager as any)._customColumns || {};
  const col = (Object.values(all) as StoredColumn[]).find(
    (c) => c && c.pluginID === ADDON_ID && c.dataKey.includes("stylero-creator"),
  );
  assert.ok(col, "stylero-creator column must be registered");
  return col!;
}

describe("creator column formatting", function () {
  let item: Zotero.Item;
  let col: StoredColumn;

  // Pref keys we mutate, captured for restore.
  const KEYS = [
    "creatorColumn.template",
    "creatorColumn.join",
    "creatorColumn.slice",
    "creatorColumn.ellipsis",
  ];
  const saved: Record<string, any> = {};

  before(async function () {
    for (const k of KEYS) {
      saved[k] = getPref(k);
    }

    item = new Zotero.Item("journalArticle");
    item.setField("title", "Stylero Creator Test");
    item.setCreators([
      { firstName: "Ada", lastName: "Lovelace", creatorType: "author" } as any,
      { firstName: "Alan", lastName: "Turing", creatorType: "author" } as any,
      { firstName: "Grace", lastName: "Hopper", creatorType: "author" } as any,
    ]);
    await item.saveTx();

    col = creatorColumn();
  });

  after(async function () {
    for (const k of KEYS) {
      setPref(k, saved[k]);
    }
    if (item) {
      await item.eraseTx();
    }
  });

  function value(): string {
    return col.dataProvider!(item, col.dataKey);
  }

  it("default template '${lastName}, ${firstName}' joined with '; '", function () {
    setPref("creatorColumn.template", "${lastName}, ${firstName}");
    setPref("creatorColumn.join", "; ");
    setPref("creatorColumn.slice", "0");
    setPref("creatorColumn.ellipsis", " et al.");

    assert.strictEqual(
      value(),
      "Lovelace, Ada; Turing, Alan; Hopper, Grace",
    );
  });

  it("custom template '${firstName} ${lastName}' joined with ' & '", function () {
    setPref("creatorColumn.template", "${firstName} ${lastName}");
    setPref("creatorColumn.join", " & ");
    setPref("creatorColumn.slice", "0");

    assert.strictEqual(value(), "Ada Lovelace & Alan Turing & Grace Hopper");
  });

  it("positive slice truncates and appends the ellipsis", function () {
    setPref("creatorColumn.template", "${lastName}");
    setPref("creatorColumn.join", ", ");
    setPref("creatorColumn.slice", "1");
    setPref("creatorColumn.ellipsis", " et al.");

    assert.strictEqual(value(), "Lovelace et al.");
  });

  it("negative slice keeps the last N creators", function () {
    setPref("creatorColumn.template", "${lastName}");
    setPref("creatorColumn.join", ", ");
    setPref("creatorColumn.slice", "-1");
    setPref("creatorColumn.ellipsis", " et al.");

    assert.strictEqual(value(), "Hopper et al.");
  });

  it("collapses dangling separators for an empty firstName", async function () {
    // A single-field (institutional) creator: firstName resolves to '' so the
    // trailing ", " from the template must be collapsed away.
    const inst = new Zotero.Item("journalArticle");
    inst.setField("title", "Institutional Author Item");
    inst.setCreators([
      { name: "World Health Organization", creatorType: "author" } as any,
    ]);
    await inst.saveTx();
    try {
      setPref("creatorColumn.template", "${lastName}, ${firstName}");
      setPref("creatorColumn.join", "; ");
      setPref("creatorColumn.slice", "0");
      const out = col.dataProvider!(inst, col.dataKey);
      assert.strictEqual(out, "World Health Organization");
    } finally {
      await inst.eraseTx();
    }
  });
});
