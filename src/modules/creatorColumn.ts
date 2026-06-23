import { getPref } from "../utils/prefs";

/**
 * Bucket C - Feature 2: Creator (reformatted authors) column.
 *
 * Registers a sortable plain-text item-tree column ("stylero-creator") that
 * reformats each item's creator list using a configurable template string.
 *
 * Template placeholders:
 *   ${firstName}  - creator first/given name (empty for single-field names)
 *   ${lastName}   - creator last/family name (or the full single-field name)
 *   ${firstCreator} - Zotero's computed firstCreator for the WHOLE item; when
 *                     present in the template it short-circuits per-creator
 *                     iteration (slice/join are ignored).
 *
 * Prefs drive template, join separator, slice (first/last N) and the
 * truncation ellipsis suffix.
 */

export const PREFS: Record<string, string | number | boolean> = {
  "creatorColumn.enable": true,
  "creatorColumn.template": "${lastName}, ${firstName}",
  "creatorColumn.join": "; ",
  "creatorColumn.slice": "0",
  "creatorColumn.ellipsis": " et al.",
};

const COLUMN_DATA_KEY = "stylero-creator";

interface CreatorLike {
  firstName?: string;
  lastName?: string;
  fieldMode?: number;
}

/**
 * Parse the slice pref into an integer. Blank / non-numeric => 0 (all).
 */
function parseSlice(raw: string): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return 0;
  }
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apply the slice spec to a creator list.
 * Returns the (possibly truncated) list and whether truncation occurred.
 */
function applySlice<T>(list: T[], slice: number): { items: T[]; truncated: boolean } {
  if (slice === 0 || list.length === 0) {
    return { items: list, truncated: false };
  }
  if (slice > 0) {
    if (slice >= list.length) {
      return { items: list, truncated: false };
    }
    return { items: list.slice(0, slice), truncated: true };
  }
  // slice < 0: last |slice| creators
  const count = Math.abs(slice);
  if (count >= list.length) {
    return { items: list, truncated: false };
  }
  return { items: list.slice(list.length - count), truncated: true };
}

/**
 * Format a single creator through the template.
 * For single-field creators (fieldMode === 1) firstName resolves to '' and any
 * dangling separators left behind by the empty placeholder are collapsed.
 */
function formatCreator(template: string, creator: CreatorLike): string {
  const firstName =
    creator.fieldMode === 1 ? "" : (creator.firstName ?? "").trim();
  const lastName = (creator.lastName ?? "").trim();

  let out = template
    .replace(/\$\{firstName\}/g, firstName)
    .replace(/\$\{lastName\}/g, lastName);

  // Collapse separators left dangling by an empty firstName/lastName, e.g.
  // "Doe, " or ", John" or " , ".
  out = out
    .replace(/\s*,\s*,\s*/g, ", ") // double commas from two empties
    .replace(/^\s*[,;]\s*/, "") // leading separator
    .replace(/\s*[,;]\s*$/, "") // trailing separator
    .trim();

  return out;
}

export class CreatorColumnFactory {
  private static registered = false;

  static async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    if (!getPref("creatorColumn.enable")) {
      return;
    }

    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: COLUMN_DATA_KEY,
      label: "Creators (Stylero)",
      dataProvider: (item: Zotero.Item) => this.buildValue(item),
    });

    this.registered = true;
  }

  static unregister(): void {
    if (!this.registered) {
      return;
    }
    try {
      Zotero.ItemTreeManager.unregisterColumns(COLUMN_DATA_KEY);
    } catch (e) {
      ztoolkit.log("[Stylero] creatorColumn unregister failed", e);
    }
    this.registered = false;
  }

  /**
   * Compute the formatted creator string for an item.
   */
  private static buildValue(item: Zotero.Item): string {
    if (!item || !item.isRegularItem || !item.isRegularItem()) {
      return "";
    }

    const template = String(getPref("creatorColumn.template") ?? "");
    const join = String(getPref("creatorColumn.join") ?? "");
    const ellipsis = String(getPref("creatorColumn.ellipsis") ?? "");
    const slice = parseSlice(String(getPref("creatorColumn.slice") ?? "0"));

    // ${firstCreator} short-circuits whole-item formatting.
    if (template.indexOf("${firstCreator}") !== -1) {
      const firstCreator = String(item.getField("firstCreator") ?? "");
      return template
        .replace(/\$\{firstCreator\}/g, firstCreator)
        .replace(/\$\{firstName\}/g, "")
        .replace(/\$\{lastName\}/g, "")
        .trim();
    }

    let creators: CreatorLike[] = [];
    try {
      creators = (item.getCreators() as CreatorLike[]) || [];
    } catch (e) {
      ztoolkit.log("[Stylero] getCreators failed", e);
      return "";
    }

    if (creators.length === 0) {
      return "";
    }

    const { items: sliced, truncated } = applySlice(creators, slice);

    const fragments = sliced
      .map((c) => formatCreator(template, c))
      .filter((s) => s.length > 0);

    if (fragments.length === 0) {
      return "";
    }

    let result = fragments.join(join);
    if (truncated && ellipsis) {
      result += ellipsis;
    }
    return result;
  }
}
