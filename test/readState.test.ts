import { assert } from "chai";
import { config } from "../package.json";
import { ReadStateFactory } from "../src/modules/readState";

/**
 * Read / Unread emphasis logic.
 *
 * The unread decision (ReadStateFactory.isUnread) is private; we drive it
 * through the registered "stylero-readstate" column dataProvider, which returns
 * "1" for unread (bold) and "0" for read. We exercise:
 *   - regular items are NOT unread by default (boldAllItems off),
 *   - with boldAllItems on, regular items are unread unless explicitly marked
 *     read via the public ReadStateFactory.markRead side-store path.
 *
 * Note: a genuine RSS feed item (item.isFeedItem) requires a feed library and a
 * sync, which is out of scope for a hermetic unit test. The feed branch of
 * isUnread (native item.isRead) is therefore covered indirectly: regular items
 * never take the feed branch, which we assert via the boldAllItems-off default.
 *
 * Prefs (readState.boldAllItems, readState.readKeys) and the in-memory side
 * store are restored after the suite.
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

function readStateColumn(): StoredColumn {
  const all = (Zotero.ItemTreeManager as any)._customColumns || {};
  const col = (Object.values(all) as StoredColumn[]).find(
    (c) =>
      c && c.pluginID === ADDON_ID && c.dataKey.includes("stylero-readstate"),
  );
  assert.ok(col, "stylero-readstate column must be registered");
  return col!;
}

describe("read state (unread emphasis)", function () {
  let item: Zotero.Item;
  let col: StoredColumn;

  const KEYS = ["readState.boldAllItems", "readState.readKeys"];
  const saved: Record<string, any> = {};

  before(async function () {
    for (const k of KEYS) {
      saved[k] = getPref(k);
    }

    item = new Zotero.Item("journalArticle");
    item.setField("title", "Stylero Read State Test");
    await item.saveTx();

    col = readStateColumn();
  });

  after(async function () {
    // Restore the side-store to a clean read state for our item, then prefs.
    ReadStateFactory.markRead(item, false);
    for (const k of KEYS) {
      setPref(k, saved[k]);
    }
    if (item) {
      await item.eraseTx();
    }
  });

  function state(): string {
    return col.dataProvider!(item, col.dataKey);
  }

  it("regular items are NOT unread when boldAllItems is off", function () {
    setPref("readState.boldAllItems", false);
    assert.strictEqual(state(), "0", "regular item should read as not-unread");
  });

  it("with boldAllItems on, an unmarked regular item is unread", function () {
    setPref("readState.boldAllItems", true);
    ReadStateFactory.markRead(item, false); // ensure not in read side-store
    assert.strictEqual(state(), "1", "unmarked item should be unread (bold)");
  });

  it("markRead(item, true) flips it to read via the side-store", function () {
    setPref("readState.boldAllItems", true);
    ReadStateFactory.markRead(item, true);
    assert.strictEqual(state(), "0", "marked-read item should not be unread");
  });

  it("markRead(item, false) flips it back to unread", function () {
    setPref("readState.boldAllItems", true);
    ReadStateFactory.markRead(item, true);
    assert.strictEqual(state(), "0");
    ReadStateFactory.markRead(item, false);
    assert.strictEqual(state(), "1");
  });

  it("turning boldAllItems off again suppresses emphasis regardless of side-store", function () {
    setPref("readState.boldAllItems", true);
    ReadStateFactory.markRead(item, false); // would be unread...
    assert.strictEqual(state(), "1");
    setPref("readState.boldAllItems", false); // ...but pref gates it off
    assert.strictEqual(state(), "0");
  });
});
