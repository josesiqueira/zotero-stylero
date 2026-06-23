import { assert } from "chai";
import { config } from "../package.json";

/**
 * Rating column read + clamp behavior. The module stores the rating in the
 * item's Extra field as a "rate: N" line (key configurable). getRating/setRating
 * are module-private, so we drive the public read path (the registered
 * "stylero-rating" column dataProvider) and write Extra exactly the way the
 * module does, asserting:
 *   - the stored rating is read back,
 *   - values are clamped to [0, max],
 *   - other Extra lines are preserved alongside the rate line.
 */

const ADDON_ID = config.addonID;
const PREFIX = config.prefsPrefix;

function getPref(k: string): any {
  return Zotero.Prefs.get(`${PREFIX}.${k}`, true);
}
function setPref(k: string, v: any): void {
  Zotero.Prefs.set(`${PREFIX}.${k}`, v, true);
}

interface StoredColumn {
  dataKey: string;
  pluginID?: string;
  dataProvider?: (item: Zotero.Item, dataKey: string) => string;
}

function ratingColumn(): StoredColumn {
  const all = (Zotero.ItemTreeManager as any)._customColumns || {};
  const col = (Object.values(all) as StoredColumn[]).find(
    (c) => c && c.pluginID === ADDON_ID && c.dataKey.includes("stylero-rating"),
  );
  assert.ok(col, "stylero-rating column must be registered");
  return col!;
}

describe("rating column read + clamp", function () {
  let item: Zotero.Item;
  let col: StoredColumn;

  const KEYS = ["ratingColumn.max", "ratingColumn.extraKey"];
  const saved: Record<string, any> = {};

  before(async function () {
    for (const k of KEYS) {
      saved[k] = getPref(k);
    }
    // Pin a known configuration for deterministic assertions.
    setPref("ratingColumn.max", 5);
    setPref("ratingColumn.extraKey", "rate");

    item = new Zotero.Item("journalArticle");
    item.setField("title", "Stylero Rating Test");
    await item.saveTx();

    col = ratingColumn();
  });

  after(async function () {
    for (const k of KEYS) {
      setPref(k, saved[k]);
    }
    if (item) {
      await item.eraseTx();
    }
  });

  async function setExtra(extra: string): Promise<void> {
    item.setField("extra", extra);
    await item.saveTx();
  }

  function rating(): string {
    return col.dataProvider!(item, col.dataKey);
  }

  it("reads 0 when there is no rate line", async function () {
    await setExtra("");
    assert.strictEqual(rating(), "0");
  });

  it("reads back a written rate value", async function () {
    await setExtra("rate: 3");
    assert.strictEqual(rating(), "3");
  });

  it("clamps a value above max down to max", async function () {
    await setExtra("rate: 99");
    assert.strictEqual(rating(), "5", "should clamp to ratingColumn.max (5)");
  });

  it("preserves other Extra lines while reading the rating", async function () {
    const extra = ["DOI: 10.1234/abc", "rate: 4", "tex.entrytype: article"].join(
      "\n",
    );
    await setExtra(extra);

    assert.strictEqual(rating(), "4", "rate read from a multi-line Extra");

    // The non-rate lines must remain untouched in the item's Extra field.
    const stored = String(item.getField("extra"));
    assert.include(stored, "DOI: 10.1234/abc");
    assert.include(stored, "tex.entrytype: article");
    assert.include(stored, "rate: 4");
  });

  it("honors a custom extraKey pref", async function () {
    setPref("ratingColumn.extraKey", "stars");
    try {
      await setExtra("stars: 2\nrate: 5");
      // With extraKey=stars, the 'stars' line drives the value, not 'rate'.
      assert.strictEqual(rating(), "2");
    } finally {
      setPref("ratingColumn.extraKey", "rate");
    }
  });
});
