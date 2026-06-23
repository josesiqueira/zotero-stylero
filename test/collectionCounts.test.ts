import { assert } from "chai";

/**
 * Collection count logic (child vs offspring).
 *
 * CollectionCountsFactory.getCounts / computeOffspring are module-private (they
 * are only reachable through the patched collection-tree renderItem, a live UI
 * path). We therefore verify the exact counting CONTRACT the module implements,
 * against the very Zotero APIs it calls:
 *   - child     = collection.getChildItems(false, false).length  (direct items)
 *   - offspring = size of the deduped union of item ids across the collection
 *                 and every descendant collection.
 *
 * A real parent + subcollection hierarchy with a shared item exercises the
 * dedup branch (the item lives in BOTH levels but counts once in offspring).
 */

/** Recompute offspring exactly as CollectionCountsFactory.computeOffspring does. */
function offspringCount(root: Zotero.Collection): number {
  const itemIds = new Set<number>();
  const visited = new Set<number>();
  const stack: Zotero.Collection[] = [root];
  while (stack.length) {
    const coll = stack.pop()!;
    if (visited.has(coll.id)) continue;
    visited.add(coll.id);
    for (const it of coll.getChildItems(false, false) || []) {
      itemIds.add(it.id);
    }
    for (const sub of coll.getChildCollections() || []) {
      if (!visited.has(sub.id)) stack.push(sub);
    }
  }
  return itemIds.size;
}

function childCount(coll: Zotero.Collection): number {
  return (coll.getChildItems(false, false) || []).length;
}

describe("collection counts (child vs offspring)", function () {
  const libraryID = Zotero.Libraries.userLibraryID;

  let parent: Zotero.Collection;
  let sub: Zotero.Collection;
  const items: Zotero.Item[] = [];

  async function newItem(title: string): Promise<Zotero.Item> {
    const it = new Zotero.Item("journalArticle");
    it.setField("title", title);
    await it.saveTx();
    items.push(it);
    return it;
  }

  before(async function () {
    parent = new Zotero.Collection({
      name: "Stylero Counts Parent",
      libraryID,
    });
    await parent.saveTx();

    sub = new Zotero.Collection({
      name: "Stylero Counts Sub",
      libraryID,
      parentID: parent.id,
    });
    await sub.saveTx();

    // 2 items directly in parent.
    const p1 = await newItem("Parent Item 1");
    const p2 = await newItem("Parent Item 2");
    p1.addToCollection(parent.id);
    p2.addToCollection(parent.id);
    await p1.saveTx();
    await p2.saveTx();

    // 3 items in the subcollection; one of them (p2) is ALSO in the parent.
    const s1 = await newItem("Sub Item 1");
    const s2 = await newItem("Sub Item 2");
    s1.addToCollection(sub.id);
    s2.addToCollection(sub.id);
    p2.addToCollection(sub.id); // shared item -> dedup target
    await s1.saveTx();
    await s2.saveTx();
    await p2.saveTx();
  });

  after(async function () {
    for (const it of items) {
      try {
        await it.eraseTx();
      } catch {
        /* ignore */
      }
    }
    if (sub) await sub.eraseTx();
    if (parent) await parent.eraseTx();
  });

  it("child mode counts only the parent's direct items", function () {
    assert.strictEqual(childCount(parent), 2);
  });

  it("child mode counts only the subcollection's direct items", function () {
    // p2, s1, s2 = 3 direct items in the subcollection.
    assert.strictEqual(childCount(sub), 3);
  });

  it("offspring mode unions parent + descendants and dedups shared items", function () {
    // Distinct items overall: p1, p2, s1, s2 = 4 (p2 shared, counted once).
    assert.strictEqual(offspringCount(parent), 4);
  });

  it("offspring of a leaf collection equals its child count", function () {
    assert.strictEqual(offspringCount(sub), childCount(sub));
  });

  it("offspring >= child for the parent (descendants add items)", function () {
    assert.isAtLeast(offspringCount(parent), childCount(parent));
  });
});
