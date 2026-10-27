# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the MCP server over stdio (meant to be launched by an MCP client, not used interactively)
- `npm run dev` — same, with `node --watch`
- `npm test` — run every `test/**/*.test.js` with Node's built-in test runner (`node --test`)
- `node --test test/<file>.test.js` — run one test file
- `node evals/run-offline.js` — run the offline tool-selection eval (**run from the repo root**: it reads `evals/tool-selection.json` relative to the cwd)
- `ANTHROPIC_MODEL=<id> node agent/run-agent.js "<question>"` — one-shot CLI agent over the read-only tools (**calls the real DB and Anthropic API**). Loop logic lives in `agent/agentCore.js` (no SDK/Supabase/tracing imports) so `test/agent.test.js` can drive it with fake clients. Tracing is added from outside by `agent/agentTracing.js`, which wraps the Anthropic and MCP clients passed to `runAgent()` (tested in `test/agentTracing.test.js` with an in-memory exporter). Keep tracing out of `agentCore.js`. Metrics (`agent/agentMetrics.js`, tested in `test/agentMetrics.test.js`) are off unless `OTEL_METRICS_EXPORTER=console`. Instruments must be created after `initTracing()`, because the metrics API has no proxy meter.
- No lint, typecheck, or build step.

Env vars (from `.env`, loaded by `src/env.js` via an absolute path — see `.env.example`):
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — required; `src/supabaseClient.js` **throws at import time** without them
- `OTEL_EXPORTER_OTLP_ENDPOINT` — optional, defaults to `http://localhost:4318/v1/traces` (Jaeger)
- `OTEL_METRICS_EXPORTER` — agent CLI only: `otlp` sends delta metrics to the Collector in `observability/` (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, default `http://localhost:4319/v1/metrics`; port 4318 is Jaeger's); `console` prints them to stderr at exit; unset/`none` disables them. Metrics use their own MeterProvider with a `service.name`-only resource, so per-process attributes never become labels.
- `TCGPLAYER_COOKIE` — only read when `print_packing_slip` runs
- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` — only read when `find_ebay_deals` runs (production eBay keyset; `EBAY_APP_ID`/`EBAY_CERT_ID` are accepted as fallbacks, matching the Supabase Edge Function's names)
- `npm run test:deals` (`scripts/test-deals.js`) — live smoke test of `find_ebay_deals` against real eBay + Supabase; prints totals, top deals, lots and sample ambiguous/unmatched titles. Doesn't record seen deals unless `--record` is passed. Not part of `npm test`.

### find_ebay_deals

`src/tools/ebayDeals.js` (I/O) + `src/tools/ebayDealsCore.js` (pure matching/profit logic, unit-tested in `test/ebayDeals.test.js`) + `src/ebayClient.js` (Browse API search and a cached client-credentials token). Unlike the other tools it isn't a view wrapper: it loads Sorcery cards from `v_latest_prices`, scans eBay, and writes returned deals to `ebay_deal_seen` (migration in the app repo: `supabase/migrations/20261027_ebay_deal_seen.sql`). Matching notes:
- Only standard printings are matchable: card rows whose name, minus a trailing ` (Foil)`, has no other `(...)` suffix. Promo/Box Topper/Misprint rows are ignored, and titles with variant words are reported as ambiguous instead of being valued at the regular card's price.
- The card name is matched first, then every keyword check (skip words, sealed, lot, set, foil, quantity) runs on the title with the card name cut out, so a card name can't trip a keyword.
- Foil comes from the ` (Foil)` name suffix as well as `cards.foil`, because a few rows disagree.

## Architecture

ESM Node project (`"type": "module"`). `src/index.js` imports `./env.js` first and then `./tracing.js` (import order matters; see the comments in both files). It registers `ListTools`/`CallTool` handlers on a low-level MCP `Server` and connects a `StdioServerTransport`. Every tool call is wrapped in a `tool.<name>` OpenTelemetry span, and each Supabase query inside it gets a `db.query` child span via `withDbSpan()` (`src/dbSpan.js`).

`src/tools/index.js` is the single list of registered tools. Each tool is `{ name, description, inputSchema, handler }` and is a thin wrapper around a Postgres view in the SatornTCG Supabase project (schema lives in the sibling `sorcery-tcg-app` repo). The low-level `Server` does **not** enforce `inputSchema`, so tools validate their own arguments and throw. `index.js` turns a throw into an `isError` tool result.

### Keep pure logic out of modules that import Supabase

Importing anything that transitively loads `src/supabaseClient.js` requires real credentials. Argument parsing and other pure logic therefore live in separate modules with no service imports, so tests can load them directly. Example: `src/tools/inventoryArgs.js` holds `parseInventorySummaryArgs()` plus `SORT_FIELDS`, `PRICE_SORTS`, `MAX_LIMIT` and `DEFAULT_LIMIT`. `inventory.js` imports and re-exports the parser. When adding validation for another tool, follow the same split, and never add Supabase, tracing or dotenv imports to these `*Args.js` modules.

## Testing and evals

This repo has three layers, each answering a different question. Keep them separate.

| Layer | Location | Question it answers | Touches DB/LLM? |
|---|---|---|---|
| Unit tests | `test/inventory.test.js` | Does the argument parser accept/reject the right inputs? | No |
| Integration test | `test/mcp.test.js` | Does the real server start and advertise its tools over MCP? | No |
| Evals | `evals/` | Given a user question, does the model pick the right tool + args? | Simulated today |

### Unit tests (`test/inventory.test.js`)

These import `src/tools/inventoryArgs.js` directly, never `inventory.js`, because that would load Supabase. They cover rejection above `MAX_LIMIT`, acceptance of valid args, and the limit boundaries (99/100 pass; 101 and -100 throw). Assert on errors with a regex (`/limit/i`) rather than the exact message.

### Integration test (`test/mcp.test.js`)

This spawns `src/index.js` as a child process through the SDK's `StdioClientTransport` and calls `client.listTools()`. It checks that `get_inventory_summary` is listed with a non-empty description and has `sort_by`/`limit` in its `inputSchema`. It is **discovery-only**: it never calls a tool.
- The child gets **placeholder** env vars (`SUPABASE_URL=http://127.0.0.1:9`, fake key and cookie, `OTEL_SDK_DISABLED=true`). `src/env.js` still loads the real `.env`, but dotenv doesn't override variables that are already set, so the placeholders win. If you add a new env var to the server, add a placeholder for it here too, or the child will pick up the real value from `.env`.
- The SDK forwards only a minimal default environment (PATH etc.) plus the `env` you pass it, so parent-shell credentials don't leak into the child.
- `stderr: 'pipe'` keeps server logs out of test output, and `t.after(() => client.close())` shuts the child down.
- Never add a `callTool()` to this file. With placeholder credentials it would fail, and with real ones it would hit the production DB. Tool behavior belongs in unit tests that pass a fake `client` (`getInventorySummary(args, client)` already accepts one as its second parameter).

### Evals (`evals/`)

- `tool-selection.json` holds the eval cases: `{ question, expected_tool, expected_args }`.
- `run-offline.js` scores a hard-coded `simulatedResponses` array against those cases. No LLM is called yet; it's a first exercise in eval scoring.
  - Responses are matched to cases **by array index**, so keep both lists in the same order and the same length.
  - `expected_args` is a **subset** check with strict `===`: extra args in the response are ignored, and only keys listed in the case are compared.
  - The third simulated response is a **deliberate mistake** (`market_price` instead of `unrealized_pnl` for "most profitable"), so the expected output is `2/3 passed (67%)`. Don't "fix" it.
  - It always exits 0, even when cases fail. It reports a score and is not a pass/fail gate, so it isn't wired into `npm test`.
- A likely next step is to replace `simulatedResponses` with real model calls that pass the `tools/list` output as the tool definitions. Keep the same case file and scoring so results stay comparable.

### Conventions

- Use only `node:test` and `node:assert/strict`. Don't add Jest, Vitest, or other test dependencies.
- Tests and evals must never need real Supabase credentials or network access.
- New test files go in `test/` with a `.test.js` suffix so `npm test` picks them up.
