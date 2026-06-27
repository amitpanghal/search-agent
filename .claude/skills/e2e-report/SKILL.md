---
name: e2e-report
description: >-
  Generate a visual end-to-end report for the resolver: run a harness batch with
  capture, then screenshot each query's result through the real frontend into a
  report.md. Use whenever the user wants to run the e2e/screenshot suite, capture
  envelopes, render queries through the frontend, or produce/refresh a visual batch
  report — even if they just say "run the e2e suite", "screenshot the batch", or
  "generate the report". Builds on harness-loop (which produces the captures).
---

# e2e-report

A two-step visual suite on top of `harness-loop`. Step 1 runs a batch through the
real `runPipeline` and freezes each query's final envelope + verdict to disk. Step 2
replays those frozen envelopes through the **real frontend** (intercepting the agent
POST) and screenshots the rendered result, then writes a `report.md` linking every shot.

The backend/LLM is never called in step 2 — the captured envelope is the exact payload
the frontend would have received, so the report is deterministic given the captures.

## The two-step flow
```
# 1. Run the batch WITH --capture (writes report/<batch>/<id>.json per query)
tsx src/harness-loop/harness-run.ts --batch 003 --capture src/harness-loop/report/003

# 2. Screenshot each captured envelope through the frontend, write report.md
tsx src/harness-loop/report/generate.ts --batch 003 [--attach]
```
Run step 1 first — `generate.ts` errors out if `report/<batch>/` has no `q*.json` records.
Re-running step 1 overwrites the captures; re-running step 2 overwrites the PNGs + `report.md`.

## Step 1 — capture (`harness-run.ts --capture <dir>`)
Same runner as the plain harness, plus `--capture <dir>`. For each query it writes
`<dir>/<id>.json` = `{ id, query, category, grade: { pass, reasons }, envelope }`.
Convention: capture into `src/harness-loop/report/<batch>/` so step 2 finds it by `--batch`.
Exit codes are the harness's own (0 pass / 1 FAIL / 3 LLM cache miss). On exit 3, do **not**
fulfil misses inline — spawn a subagent per the **harness-loop** skill's instructions (Haiku,
temp 0, one entry at a time). This step must never be executed by the orchestrating agent itself.
Re-run step 1 after all misses are fulfilled, then proceed to step 2.

## Step 2 — screenshot (`report/generate.ts`)
- `--batch <NNN>` — reads `report/<batch>/q*.json` (defaults to `002`).
- `--attach` — assume the frontend is already running at `http://localhost:3010`. Without it,
  the script spawns `npm start` in the frontend dir and waits for the server.
- Frontend dir: env `AI_SEARCH_FRONTEND_DIR`, fallback
  `/Users/amipan/Documents/Workspace/bc-micro-frontend-app-ai-search`.
- Per query it intercepts `POST http://localhost:3000/query`, fulfils it with the captured
  SSE `done` envelope, types the query, waits for a terminal render
  (`.ai-search-result-list`, `.ai-search-clarification-panel`, or `.ai-search-error-panel`),
  and screenshots full-page to `report/<batch>/<id>.png`.

## Output
- `report/<batch>/<id>.png` — one full-page screenshot per query.
- `report/<batch>/report.md` — `# Batch <NNN> report` with a `**PASS**/**FAIL**` line, a one-line
  summary (result count, or the FAIL reasons), and the embedded screenshot per query.

Surface the `report.md` path when done. Reading it back inline (the PASS/FAIL lines) is the quickest triage.

## Reading the report
A `**PASS**` with `0 results` is a valid empty slate, not a render error. FAILs carry the grader's
reason verbatim (e.g. `timebound query returned an empty slate`) — triage those through the
**harness-loop** skill's buckets (code bug / LLM variance / bad gold), not here. This suite only
renders and reports; fixing resolver behaviour stays human-gated in harness-loop.

## Files
- `harness-run.ts` — runner; `--capture <dir>` freezes envelopes (lives in `src/harness-loop/`).
- `report/generate.ts` — frontend screenshot driver + `report.md` writer.
- `report/<batch>/` — capture records (`q*.json`), screenshots (`*.png`), and `report.md`.
