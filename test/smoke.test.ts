import { assert } from "chai";
import { config } from "../package.json";

/**
 * Smoke tests: the plugin loaded into the live Zotero test instance, its global
 * instance exists, and the addon marked itself initialized + alive with the
 * correct config baked in. These run inside a real Zotero 9 instance with the
 * plugin already loaded (see zotero-plugin.config.ts test.waitForPlugin).
 */
// The plugin instance is exposed under a dynamic key (config.addonInstance);
// index through `any` since the Zotero type has no string index signature.
function getAddon(): any {
  return (Zotero as any)[config.addonInstance];
}

describe("smoke", function () {
  it("exposes the plugin instance on Zotero", function () {
    assert.isNotEmpty(getAddon());
  });

  it("has finished onStartup (data.initialized === true)", function () {
    const addon = getAddon();
    assert.isObject(addon.data, "addon.data should be an object");
    assert.strictEqual(addon.data.initialized, true);
  });

  it("is alive (data.alive === true)", function () {
    const addon = getAddon();
    assert.strictEqual(addon.data.alive, true);
  });

  it("carries the expected config (addonID / ref / instance)", function () {
    const addon = getAddon();
    assert.strictEqual(addon.data.config.addonID, config.addonID);
    assert.strictEqual(addon.data.config.addonID, "zotero-stylero@jose.local");
    assert.strictEqual(addon.data.config.addonRef, config.addonRef);
    assert.strictEqual(addon.data.config.addonInstance, config.addonInstance);
  });
});
