---
name: stylero-test
description: Build, install, and test the Zotero Stylero plugin against a running Zotero 9 (via the introfini MCP bridge). Runs the live smoke/UI harness and documents the mocha unit/integration suite. Use when asked to test Stylero, verify a change, or check the plugin still works.
---

# Testing Zotero Stylero

This skill runs the full test flow for the `zotero-stylero` plugin. There are two
layers:

1. **Live smoke / UI tests** (executable here) — run against the real running
   Zotero via the introfini MCP bridge. This is the primary, always-runnable path.
2. **Mocha unit/integration suite** (`test/*.test.ts`) — run by the scaffold test
   runner inside a dedicated Zotero test instance. Documented below; needs a local
   `.env`.

## Prerequisites
- Zotero 9 running with the **MCP Bridge for Zotero** plugin (RDP on port 6100).
- The `@introfini/mcp-server-zotero-dev` MCP server connected to this session
  (declared in the project `.mcp.json`). Verify with `zotero_ping`.

## Procedure (live)

Run these steps in order, serially (one bridge — never run bridge calls in
parallel):

1. **Typecheck**: `npx tsc --noEmit` (from the `zotero-stylero` dir). Must be 0 errors.
2. **Build**: `npx zotero-plugin build`. Produces `.scaffold/build/zotero-stylero.xpi`.
3. **Install**: call `zotero_plugin_install` with the absolute path to that xpi.
   (A "received undefined result" message is cosmetic; confirm via step 4.)
4. **Settle**: the install may reload/restart Zotero. Poll until port 6100 is back
   and `zotero_ping` succeeds, then wait ~2.5s for `uiReadyPromise`.
5. **Clear console**: `zotero_clear_logs`.
6. **Run the live harness**: read `test/live/harness.js` and pass its entire
   contents to `zotero_execute_js`. It returns
   `{ passed, failed, checks, summary }`. Re-run returning
   `JSON.stringify(report.checks, null, 2)` to see per-check detail.
   **All checks must pass (failed === 0).**
7. **Error scan**: `zotero_read_errors` (lines: 30). Treat as a regression any
   error whose stack references `zotero-stylero@jose.local` and is NOT one of:
   - the dev-reinstall artifact `ItemTreeColumnManager: Can't remove unknown option 'stylero-*'`
     (only appears on in-place reinstall, never on a clean restart),
   - `*deprecated*` warnings.
8. **Optional visual check**: `zotero_screenshot` to eyeball colored tag swatches,
   collection-count badges, and (after enabling them in the column picker) the
   Title/Creator columns; open View → "Stylero: Graph View" to verify the
   graph tab renders.

Report a concise pass/fail summary with any failing check names and error lines.

## Procedure (mocha unit/integration suite)

The canonical suite lives in `test/*.test.ts` (smoke, columns, creator,
collectionCounts, readingStore, graphData, readState). It runs in a dedicated
Zotero test instance:

1. Copy `.env.example` to `.env` and set the Zotero binary path
   (e.g. `/opt/zotero/zotero`).
2. `npm test` (alias for `zotero-plugin test`).

CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` + `zotero-plugin build` on
every push/PR. It does not run `zotero-plugin test` because GitHub runners have no
Zotero/Firefox binary.

## Notes
- Keep all bridge calls serial and self-driven; the bridge is single-flight.
- A full Zotero restart gives the cleanest baseline; an in-place reinstall stacks
  some state and can surface the benign "Can't remove unknown option" warnings.
