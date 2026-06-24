import { assert } from "chai";
import { config } from "../package.json";
import { ReadStateFactory } from "../src/modules/readState";

/**
 * Read / Unread emphasis.
 *
 * The unread decision (ReadStateFactory.isUnread) and the row-renderer patch are
 * private/DOM-bound, so the hermetic surface we assert here is the public
 * markRead() side-store: marking a regular item read/unread adds/removes its key
 * from the `readState.readKeys` JSON store (this is what isUnread reads when
 * boldAllItems is on). The whole-row bold itself is covered by the live MCP
 * harness (test/live/harness.js), which toggles boldAllItems and checks the
 * computed font-weight of unread rows.
 *
 * Prefs touched here (readState.readKeys) are restored after the suite.
 */

const PREFIX = config.prefsPrefix;

function getPref(k: string): any {
  return Zotero.Prefs.get(`${PREFIX}.${k}`, true);
}
function setPref(k: string, v: any): void {
  Zotero.Prefs.set(`${PREFIX}.${k}`, v, true);
}

function readKeys(): string[] {
  const raw = String(getPref("readState.readKeys") || "");
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

describe("read state (markRead side-store)", function () {
  let item: Zotero.Item;
  let key: string;
  const saved: Record<string, any> = {};

  before(async function () {
    saved["readState.readKeys"] = getPref("readState.readKeys");

    item = new Zotero.Item("journalArticle");
    item.setField("title", "Stylero Read State Test");
    await item.saveTx();
    key = (item as any).key;
  });

  after(async function () {
    ReadStateFactory.markRead(item, false);
    setPref("readState.readKeys", saved["readState.readKeys"]);
    if (item) {
      await item.eraseTx();
    }
  });

  it("markRead(item, true) adds the item key to the read side-store", function () {
    ReadStateFactory.markRead(item, true);
    assert.include(readKeys(), key, "key should be present after marking read");
  });

  it("markRead(item, false) removes the item key from the side-store", function () {
    ReadStateFactory.markRead(item, true);
    assert.include(readKeys(), key);
    ReadStateFactory.markRead(item, false);
    assert.notInclude(
      readKeys(),
      key,
      "key should be gone after marking unread",
    );
  });

  it("markRead is idempotent (no duplicate keys)", function () {
    ReadStateFactory.markRead(item, true);
    ReadStateFactory.markRead(item, true);
    const occurrences = readKeys().filter((k) => k === key).length;
    assert.strictEqual(occurrences, 1, "key should appear exactly once");
  });
});
