import { assert } from "chai";
import { GraphData } from "../src/modules/graphView/graphData";

/**
 * Pure graph-model construction for the related / author / tag modes, plus the
 * default ("help splash") mode which yields an empty model. Builds a small set
 * of temp items wired with related links, shared authors and shared tags and
 * asserts the resulting node/edge structure. All temp items are cleaned up.
 */

describe("GraphData.build", function () {
  const items: Zotero.Item[] = [];

  async function newItem(
    title: string,
    opts: {
      creators?: any[];
      tags?: string[];
    } = {},
  ): Promise<Zotero.Item> {
    const it = new Zotero.Item("journalArticle");
    it.setField("title", title);
    if (opts.creators) {
      it.setCreators(opts.creators);
    }
    if (opts.tags) {
      for (const t of opts.tags) {
        it.addTag(t, 0);
      }
    }
    await it.saveTx();
    items.push(it);
    return it;
  }

  after(async function () {
    for (const it of items) {
      try {
        await it.eraseTx();
      } catch {
        /* ignore */
      }
    }
  });

  it("default mode yields the empty help-splash model", async function () {
    const a = await newItem("Default Mode Item");
    const model = await GraphData.build([a], "default", 0);
    assert.strictEqual(model.mode, "default");
    assert.lengthOf(model.nodes, 0);
    assert.lengthOf(model.edges, 0);
    assert.strictEqual(model.total, 0);
    assert.isFalse(model.truncated);
  });

  it("related mode emits one node per item and an edge per related link", async function () {
    const r1 = await newItem("Related One");
    const r2 = await newItem("Related Two");
    const r3 = await newItem("Related Three (unlinked)");
    r1.addRelatedItem(r2);
    r2.addRelatedItem(r1);
    await r1.saveTx();
    await r2.saveTx();

    const model = await GraphData.build([r1, r2, r3], "related", 0);
    assert.strictEqual(model.mode, "related");
    assert.lengthOf(model.nodes, 3, "one node per regular item");

    // Exactly one undirected edge between r1 and r2; r3 is isolated.
    assert.lengthOf(model.edges, 1);
    const edge = model.edges[0];
    const ids = [edge.source, edge.target].sort((x, y) => x - y);
    assert.deepEqual(ids, [r1.id, r2.id].sort((x, y) => x - y));

    // r1 and r2 have degree 1, r3 has degree 0.
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    assert.strictEqual(byId.get(r1.id)!.degree, 1);
    assert.strictEqual(byId.get(r2.id)!.degree, 1);
    assert.strictEqual(byId.get(r3.id)!.degree, 0);
  });

  it("author mode merges a shared author into one node connecting both items", async function () {
    const shared = { firstName: "Ada", lastName: "Lovelace", creatorType: "author" };
    const a1 = await newItem("Author Paper A", { creators: [shared as any] });
    const a2 = await newItem("Author Paper B", {
      creators: [
        shared as any,
        { firstName: "Alan", lastName: "Turing", creatorType: "author" } as any,
      ],
    });

    const model = await GraphData.build([a1, a2], "author", 0);
    assert.strictEqual(model.mode, "author");

    // 2 item nodes + 2 distinct author nodes (Lovelace shared, Turing solo).
    const itemNodes = model.nodes.filter((n) => n.itemType !== "author");
    const authorNodes = model.nodes.filter((n) => n.itemType === "author");
    assert.lengthOf(itemNodes, 2);
    assert.lengthOf(authorNodes, 2);

    // Author ids are synthetic negatives; item ids are real positives.
    for (const an of authorNodes) {
      assert.isBelow(an.id, 0, "author node ids must be negative synthetic ids");
    }

    // The shared author (Lovelace) connects to BOTH items -> degree 2.
    const lovelace = authorNodes.find((n) => /Lovelace/.test(n.label));
    assert.ok(lovelace, "a Lovelace author node should exist");
    assert.strictEqual(lovelace!.degree, 2);

    // Edges: a1-Lovelace, a2-Lovelace, a2-Turing = 3.
    assert.lengthOf(model.edges, 3);
  });

  it("tag mode merges a shared tag into one node connecting both items", async function () {
    const t1 = await newItem("Tag Paper A", { tags: ["graph", "alpha"] });
    const t2 = await newItem("Tag Paper B", { tags: ["graph", "beta"] });

    const model = await GraphData.build([t1, t2], "tag", 0);
    assert.strictEqual(model.mode, "tag");

    const itemNodes = model.nodes.filter((n) => n.itemType !== "tag");
    const tagNodes = model.nodes.filter((n) => n.itemType === "tag");
    assert.lengthOf(itemNodes, 2);
    // distinct tags: graph, alpha, beta = 3
    assert.lengthOf(tagNodes, 3);

    const graphTag = tagNodes.find((n) => n.label === "graph");
    assert.ok(graphTag, "a 'graph' tag node should exist");
    assert.strictEqual(graphTag!.degree, 2, "shared tag connects both items");
    assert.ok(graphTag!.color, "tag nodes should carry a color");

    // Edges: t1-graph, t1-alpha, t2-graph, t2-beta = 4.
    assert.lengthOf(model.edges, 4);
  });

  it("respects the node cap and marks the model truncated", async function () {
    const c1 = await newItem("Cap One", { tags: ["x"] });
    const c2 = await newItem("Cap Two", { tags: ["x"] });
    const model = await GraphData.build([c1, c2], "tag", 1);
    assert.isTrue(model.truncated);
    assert.lengthOf(model.nodes, 1);
    assert.isAbove(model.total, model.nodes.length);
  });
});
