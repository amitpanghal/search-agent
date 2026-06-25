---
name: harness-loop
description: >-
  Drive the offline resolver test rig in src/harness-loop. Use this whenever the
  user wants to run the harness, run a batch, fulfil LLM cache misses / pending-llm.json,
  generate a new batch of test queries, or triage resolver pipeline failures (extract,
  entities, markets, odds/time filters) — even if they just say "run the rig", "score the
  batch", or "why did query X fail". The rig runs the REAL runPipeline against cached LLM
  steps and a cached live menu, so it never needs ANTHROPIC_API_KEY and never calls the LLM API.
---

# harness-loop

An offline test rig for the resolver pipeline. It runs the real `runPipeline(query, HARNESS_DEPS)`
but swaps the LLM boundaries for a content-addressed cache and serves recall from a per-input cache.
Grading reads only the final `ResponseEnvelope`. See `src/harness-loop/README.md` for the design.

## Hard constraint: never call the LLM API
The three LLM steps (extract, entities, markets) are served from `src/harness-loop/llm-cache/`.
On a miss the run records the request and aborts that query — **you (the orchestrator) fulfil it with a
subagent**, not an API call. Never set or use `ANTHROPIC_API_KEY` here. (Recall does fetch the live feed
once per input and caches it; that is the only network the rig uses.)

## Run a batch
```
tsx src/harness-loop/harness-run.ts --batch 001 [--limit N]
```
Exit codes:
- **0** — every scored query passed.
- **1** — at least one graded FAIL (a real result to triage).
- **3** — one or more LLM cache misses; misses written to `src/harness-loop/pending-llm.json`. Fulfil them, then re-run.

Read the per-line scoreboard: `[PASS] / [FAIL] / [PEND]` per query, then the totals line.

## Fulfil cache misses (the core loop)
On exit 3, read `src/harness-loop/pending-llm.json`. It is an array of `{ key, kind, input }`.
For each entry, spawn a **temperature-0 Haiku subagent** using the real prompt for that `kind`, and
write its output to `src/harness-loop/llm-cache/<key>.json`. Match production exactly: Haiku, temp 0,
output the shape below and nothing else (no prose, no markdown fence).

| kind       | prompt (system)                          | input                      | write this shape                                   |
|------------|------------------------------------------|----------------------------|----------------------------------------------------|
| `extract`  | `src/resolver/extractor-prompt.md`       | `{ query }`                | one QueryPlan object (`status`, `sport`, `selectors[]`) |
| `entities` | `src/resolver/disambiguator-prompt.md`   | `{ query, cells, pass }`   | `Decision[]` — one per cell, `ref` echoed back     |
| `markets`  | `src/resolver/resolve-market-prompt.md`  | `{ phrases, menu }`        | `RawPick[]` — one per phrase, in phrase order      |

Shape notes:
- **Decision** — `{ ref, action: "pick", id }` | `{ ref, action: "reexpress", phrase }` (pass 1 only) |
  `{ ref, action: "clarify", question, suggest? }` (pass 2 only). A `pick` id must be one of that cell's `candidates`.
- **RawPick** — `{ ref: <menu index> | null, match: "exact" | "close" | "none", reason }`. `null` ref = abstain.

After writing every miss, **re-run the same batch**. Because the cache key is `hash(kind + exact input)`,
unchanged inputs stay hits — re-runs are free and deterministic. Only a layer whose input you changed re-misses.

## Triage every failure before touching code
Put each FAIL in exactly one bucket:
- **code bug** → fix the deterministic layer. Show the diff and get approval one change at a time, then re-run (free).
- **LLM variance** → delete the stale cache file so it re-captures; don't change code.
- **bad target / gold** → fix or drop the query in the batch file.

Fixes to shipped resolver code (grounder, prompts, schema, calibration) are human-gated: plan it in plain
English with a worked example, then stop and ask before editing. Rig/test code (harness-loop itself) can proceed.

## Generate a new batch
Spawn a **Sonnet** generator subagent with the system prompt `src/harness-loop/batch-gen-prompt.md` to
produce 10–15 queries against real snapshot ids, written to `src/harness-loop/batches/batch-NNN.jsonl`
(one `BatchQuery` JSON per line). Feed it, per target market, its `{id, label, category, subject, scope}`
**plus the sibling market labels from the same fixture/competition** (so the query can be pinned to the
exact gold, not a twin). Each line carries its by-construction answer key:
```
{"id":"q001","category":"competition-level","q":"who wins the World Cup 2026","grade":{"targets":[[1001159600]]}}
```
`grade.targets` is an array of legs; each leg is an any-of list of acceptable criterion ids. A pure-filter
query uses `targets: []`. Optional: `oddsMin` / `oddsMax` (post-resolve price bounds), `timebound: true`
(soft — slate must be non-empty). Shapes live in `src/harness-loop/types.ts`.

## Files
- `harness-run.ts` — the runner (run a batch, print scoreboard, flush misses).
- `pipeline-doubles.ts` — `HARNESS_DEPS`: cached extract/entities/markets + live-cached recall.
- `llm-cache.ts` — content-addressed cache + `pending-llm.json` ledger + `CacheMiss`.
- `grader.ts` — envelope → pass/fail on market targets, odds bounds, time-soft.
- `llm-cache/` — captured LLM outputs (keyed). `batches/` — generated query batches.
