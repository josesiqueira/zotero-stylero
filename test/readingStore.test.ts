import { assert } from "chai";
import { ReadingStore } from "../src/modules/readingStore";

/**
 * Exercises the shared ReadingStore data layer with synthetic throwaway item
 * keys (no real reading session needed). Asserts that:
 *   - init() is safe to call,
 *   - addDwell accumulates per-page and into a running total,
 *   - getItemData returns a defensive copy,
 *   - getMaxTotalInView returns the max total across keys,
 *   - invalid inputs (non-positive seconds, negative page) are ignored.
 *
 * Keys are uniquified per-run so leftover persisted data never affects results.
 */

const PREFIX = `STYLERO_TEST_${Date.now()}_`;
const KEY_A = `${PREFIX}A`;
const KEY_B = `${PREFIX}B`;
const KEY_C = `${PREFIX}C`;

describe("ReadingStore", function () {
  before(async function () {
    await ReadingStore.init();
  });

  it("init() is idempotent", async function () {
    await ReadingStore.init();
    await ReadingStore.init();
    assert.isUndefined(ReadingStore.getItemData(KEY_A));
  });

  it("returns undefined for unknown keys", function () {
    assert.isUndefined(ReadingStore.getItemData(`${PREFIX}UNKNOWN`));
  });

  it("accumulates dwell per page and into the total", function () {
    ReadingStore.addDwell(KEY_A, 0, 10);
    ReadingStore.addDwell(KEY_A, 0, 5); // same page accrues
    ReadingStore.addDwell(KEY_A, 1, 20);

    const data = ReadingStore.getItemData(KEY_A);
    assert.ok(data, "data should exist after addDwell");
    assert.strictEqual(data!.pages[0], 15);
    assert.strictEqual(data!.pages[1], 20);
    assert.strictEqual(data!.total, 35);
  });

  it("getItemData returns a defensive copy (mutation does not leak)", function () {
    const data = ReadingStore.getItemData(KEY_A)!;
    data.total = 99999;
    data.pages[0] = 99999;
    const fresh = ReadingStore.getItemData(KEY_A)!;
    assert.strictEqual(fresh.total, 35);
    assert.strictEqual(fresh.pages[0], 15);
  });

  it("ignores non-positive seconds and negative page indices", function () {
    ReadingStore.addDwell(KEY_C, 0, 0); // zero seconds -> ignored
    ReadingStore.addDwell(KEY_C, 0, -5); // negative seconds -> ignored
    ReadingStore.addDwell(KEY_C, -1, 10); // negative page -> ignored
    assert.isUndefined(
      ReadingStore.getItemData(KEY_C),
      "no entry should be created from invalid inputs",
    );
  });

  it("getMaxTotalInView returns the max total across the given keys", function () {
    ReadingStore.addDwell(KEY_B, 0, 100); // B total = 100 > A total = 35
    const max = ReadingStore.getMaxTotalInView([KEY_A, KEY_B]);
    assert.strictEqual(max, 100);
  });

  it("getMaxTotalInView returns 0 for an empty or all-unknown view", function () {
    assert.strictEqual(ReadingStore.getMaxTotalInView([]), 0);
    assert.strictEqual(
      ReadingStore.getMaxTotalInView([`${PREFIX}NOPE`]),
      0,
    );
  });
});
