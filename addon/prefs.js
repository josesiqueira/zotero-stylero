/* eslint-disable no-undef */
// Default preferences for Zotero Stylero.
// The scaffold prepends the prefs prefix (extensions.zotero.zoterostylero.) to each key.

// Reading-time sampler (feature 16) — data source for title heat + progress.
pref("readingTime.enable", true);
pref("readingTime.sampleIntervalMs", 10000);
pref("readingTime.hangGuardMs", 60000);
pref("readingTime.idleResetMs", 0);
pref("readingTime.persistDebounceMs", 5000);

// Title column (feature 1).
pref("titleColumn.enable", true);
pref("titleColumn.heat.enable", true);
pref("titleColumn.heat.hue", 12);
pref("titleColumn.heat.maxAlpha", "0.45");
pref("titleColumn.heat.scale", "sqrt");
pref("titleColumn.icon.enable", true);
pref("titleColumn.striping.enable", true);
pref("titleColumn.tagSwatches.enable", true);
pref("titleColumn.tagSwatches.max", 5);
pref("titleColumn.bold.scope", "feeds");

// Creator column (feature 2).
pref("creatorColumn.enable", true);
pref("creatorColumn.template", "${lastName}, ${firstName}");
pref("creatorColumn.join", "; ");
pref("creatorColumn.slice", "0");
pref("creatorColumn.ellipsis", " et al.");

// Rating column (feature 9).
pref("ratingColumn.enable", true);
pref("ratingColumn.max", 5);
pref("ratingColumn.extraKey", "rate");
pref("ratingColumn.allowClear", true);

// Collection item counts (feature 12).
pref("collectionCounts.enable", true);
pref("collectionCounts.mode", "child");
pref("collectionCounts.includeSubcollectionItems", false);

// Progress column (feature 8) — off by default.
pref("progressColumn.enable", false);
pref("progressColumn.style", "bar");
pref("progressColumn.source", "annotations");
pref("progressColumn.normalize", "item");
pref("progressColumn.color", "#e8694a");
pref("progressColumn.maxBuckets", 40);

// Read/Unread emphasis (feature 19) — whole-row bold for unread.
pref("readState.enable", true);
pref("readState.boldAllItems", false);
pref("readState.wholeRow", true);
pref("readState.readKeys", "");

// Graph view (feature 18).
pref("graphView.enable", true);
pref("graphView.mode", "default");
pref("graphView.scope", "view");
pref("graphView.theme", "auto");
pref("graphView.nodeCap", 400);
pref("graphView.showLabels", true);
pref("graphView.charge", -220);
pref("graphView.linkDistance", 60);
