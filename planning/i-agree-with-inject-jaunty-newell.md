# Plan: offline UI-snapshot suite for resolver envelopes

## Context

We want a **reusable automation suite** that shows how the real frontend
(`bc-micro-frontend-app-ai-search`) renders the resolver's output, without the live
backend, the LLM API, or the live odds feed.

The key enabler: the object the offline harness produces and the object the frontend
renders are the **same `ResponseEnvelope`**. The harness already computes it per query
(`runPipeline` with `HARNESS_DEPS`, cached LLM + cached menu, no API key) and currently
just grades and discards it. We capture that envelope, replay it into the unchanged
panel, screenshot it, and assemble a markdown report.

Queries are **server-generated** (the existing Sonnet batch flow → `batch-00X.jsonl`).
The frontend never originates a query and never calls our backend.

### Decisions locked (from discussion)
- Reusable, committed suite (not a one-off).
- First run = `batch-002`, all 11 queries.
- Render via **offline harness mount** + **inject-the-query / stub-the-network** (Playwright).
- Report = markdown, per query: **raw query + screenshot + PASS/FAIL verdict** (+ envelope summary line).
- Playwright as a local dev dependency (Apache-2.0, no account, chromium only; one-time binary download, offline at runtime).

## How it works (the seam)

Normal flow: user types → frontend POSTs `/query` → backend streams stage events + a
`done` event carrying the envelope → panel renders.

Suite flow:
1. Server query generator → queries (`batch-002.jsonl`).
2. Offline harness runs `runPipeline(q, HARNESS_DEPS)` → captures each envelope + grade.
3. Playwright loads the offline harness page, types the query (just the render trigger),
   intercepts the panel's `POST **/query`, and fulfils it with an SSE body built from the
   captured envelope (`event: done\ndata: <envelope JSON>\n\n`). Backend never called.
4. Wait for the rendered result, screenshot, write report.

## Work items

### A. Capture (search-agent) — `src/harness-loop/harness-run.ts`
Add a `--capture <dir>` flag. The runner already drains the `done` envelope and grades it
(`drain()` + `grade()` at `harness-run.ts:31-39`). When the flag is set, write one record
per query to `<dir>/<id>.json`:
```
{ id, query, category, grade: { pass, reasons }, envelope }
```
This single pass gives the generator everything it needs (query text, verdict, envelope).
Reuse existing `loadBatch`, `drain`, `grade`; no pipeline duplication.

Prerequisite: `batch-002` must run green first (no pending LLM cache misses), so all 11
yield envelopes. Fulfil any `pending-llm.json` misses via the normal harness-loop flow
before capturing.

### B. Offline harness mount (frontend) — dev-only, gated behind `?harness=1`
The existing dev page (`src/index.ts` → `src/App.tsx`) wraps the panel in federated
Kambi providers (`kambi-host/ThemeProvider`, `SharedDataProvider`) + a `loadSessionApi`
call — all over the network, so it is **not offline**. The panel and cards themselves use
no store/context/federation (verified: `ResultList` + cards render purely from the
envelope + CSS). So:

- `src/index.ts`: when `window._kc.harness` is set, **skip** `loadSessionApi`/`createStore`/
  config fetch and go straight to `import('./bootstrap')`. (`_kc` already merges URL params,
  so `?harness=1` is visible here.)
- `src/App.tsx`: when `_kc.harness` is set, render `<AISearchPanel>` directly inside a plain
  `data-betty-theme` container (the existing styled wrapper div), **without** the federated
  providers; import the token CSS below.
- New `src/styles/betty-tokens.css`: define the **24 no-fallback player-card tokens**
  (`--B-playerCard__*` in `PlayerCard/PlayerCardHeader/PlayerCardPlayerName/DateTime/
  PlayerCardEventInfo`) with sensible Betty-like values. The other 73 `--B-*` refs already
  carry inline fallbacks, so the rest of the panel themes itself. (Values can later be
  replaced by a one-time dump of computed `--B-*` from a themed render for pixel accuracy.)

This reuses the existing entry/html/dev-server (port **3010**); production `exposes` is
untouched. Playwright target: `http://localhost:3010/?harness=1`.

### C. Generator + screenshots (search-agent) — `src/harness-loop/report/generate.ts` (new)
A `tsx` + Playwright (chromium, headless) script:
- Read capture records for the batch (from A).
- Ensure the frontend dev server is up at `http://localhost:3010/?harness=1`; if not, spawn
  `npm start` in the frontend dir (path via env `AI_SEARCH_FRONTEND_DIR`, default
  `/Users/amipan/Documents/Workspace/bc-micro-frontend-app-ai-search`), wait for ready,
  tear down after. `--attach` skips spawn.
- Per query:
  - `page.route('**/query', ...)` → `fulfill({ status: 200, headers: { 'content-type':
    'text/event-stream' }, body: 'event: done\ndata: ' + JSON.stringify(envelope) + '\n\n' })`.
  - Fill `input.ai-search-input__field` (aria-label "Search query"), press `Enter`
    (submits via the `onKeyDown` handler in `SearchInput.tsx:36`).
  - Wait for the terminal container — results `.ai-search-result-list` (`ResultList.tsx`),
    or the clarification/error panel for non-result states (e.g. q010) — then `screenshot`
    to `report/<batch>/<id>.png`.
- Add npm scripts, e.g. `"report:capture": "tsx src/harness-loop/harness-run.ts --batch 002 --capture src/harness-loop/report/002"` and `"report:shots": "tsx src/harness-loop/report/generate.ts --batch 002"`.

### D. Markdown report — `src/harness-loop/report/<batch>/report.md`
Written by `generate.ts`. One numbered entry per query, in batch order:
```
### 3. who finishes as WC26 leading scorer
**PASS** — <envelope.summary>
![q002](./q002.png)
```

## Critical files
- search-agent: `src/harness-loop/harness-run.ts` (capture flag), new `src/harness-loop/report/generate.ts`, `package.json` (scripts + playwright devDep).
- frontend: `src/index.ts`, `src/App.tsx`, new `src/styles/betty-tokens.css`.
- Reused as-is: `src/resolver/resolve.ts` (`runPipeline`), `src/harness-loop/pipeline-doubles.ts` (`HARNESS_DEPS`), `src/harness-loop/grader.ts` (`grade`), envelope shape `src/resolver/execute.ts`; frontend `useAgentStream`/`agent-client` (SSE contract), `ResultList`/`SearchInput` selectors.

## Verification (end-to-end)
1. `npm run report:capture` → 11 files in `src/harness-loop/report/002/` each with envelope + grade.
2. `npm run report:shots` → 11 PNGs + `report.md` in the same dir.
3. Open `report.md`: every query shows raw text, PASS/FAIL, and a screenshot.
4. Spot-check player-card queries (q008, q009) — cards render themed (boxed, not bare).
5. Re-run offline (no network/VPN) to confirm determinism: same screenshots, no Kambi calls.
