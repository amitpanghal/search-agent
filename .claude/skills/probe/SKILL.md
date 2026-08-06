---
name: probe
description: >-
  How to run and read scripts/probe.ts (`npm run probe`) — the tool that runs one or many queries through the
  LIVE prod pipeline and dumps a per-stage + per-API trace. Use when investigating WHY a query resolved the way
  it did: which stage produced the wrong leg, what the extractor/grounder/market-picker actually returned, what
  Kambi was fetched, or where a query threw. Covers the flags (log level, per-API filter, --until early-stop,
  --out JSONL), the paid-call discipline, and how to read the trace back to the owning stage. Pair with the
  resolver-pipeline skill (the stage map) — this skill is how you OBSERVE a live run of it.
---

# probe

`scripts/probe.ts` runs queries through the real `runPipeline` and captures an ordered trace of every stage
output + every LLM/Kambi call. It is the go-to tool for **root-cause** probing: read the trace to find which
stage is wrong and *why*, then name the fix layer — not to score final results.

```bash
npm run probe -- "Arsenal to win" "over 2.5 goals"      # 1+ queries, summary log
npm run probe -- --file queries.txt --log=full          # one query per line, raw payloads
npm run probe -- "Kane top scorer" --until=ground       # stop after grounding — no Kambi, no paid market LLM
npm run probe -- "..." --apis=kambi --out run.jsonl      # only feed traffic; also append the full trace
```

## Paid — the discipline
Every full run makes **live Bedrock + Kambi calls** (money). Per the user's standing rule: **get an OK before a
paid run**, and keep spend down:
- **`--until=extract|ground|entities|recall`** stops the pipeline *before* the next paid call. `--until=ground`
  costs one extract call only; `--until=recall` skips the market LLM. Use it whenever the question lives in an
  early stage.
- **`--out run.jsonl`** saves the whole trace (untrimmed). **Reuse the JSONL** to re-inspect a run instead of
  paying to re-run it — re-run only when the *input* (query, prompt, code) actually changed.
- Only the query, prompt, or a code change should send a fresh call. Don't loop paid runs.

## Flags
| flag | default | effect |
|------|---------|--------|
| `queries…` / `--file F` | — | positional queries, or one-per-line from `F` (blank / `#` lines skipped) |
| `--log=silent\|summary\|full` | summary | silent = status line only · summary = one line/stage · full = raw req/resp + payloads |
| `--apis=llm,kambi` | both | which API rows to show; `--apis=kambi` = only feed traffic |
| `--until=extract\|ground\|entities\|recall` | (run all) | stop after that stage — no envelope, no later paid calls |
| `--out F` | — | append `{query, ok, error, trace, envelope}` as one JSONL line for diffing/reuse |
| `--full-payloads` | off | in `--log=full`, dump the giant static system prompt + full menus (else elided to size/count) |
| `--fail-fast` | off | stop the batch on the first throwing query (default: continue, summarise at end) |

Timing (ms since prior event), token counts, cost, and the failure point are always shown.

## Reading the trace
Each `stage` row is one pipeline stage; **its bug lives in that stage's file** (see the resolver-pipeline skill's
stage→file table). Quick map: `extract`→extract.ts+prompt · `ground`→ground-scope.ts · `entities`→resolve-entities.ts+prompt
· `recall`→recall.ts (the fetch) · `scopeMenu`/`filter`→per-leg narrowing (recall.ts/filter.ts) · `market`→resolve-market.ts+prompt
· `select`→select.ts (outcome/fallback) · `execute`→execute.ts (envelope). `[llm …]` rows are the Bedrock
boundary (bedrock-call.ts); `[kambi]` rows the offering boundary (offering-client.ts).

- **Wrong leg?** Walk the rows top-down to the first one that's already wrong — that stage owns it. A leg that's
  right in `market` but missing in `execute` is a select/data-prune issue, not a pick issue.
- **`--log=full`** shows the exact LLM system+user prompt and the picked-menu — the ground truth for a bad
  extract/entities/market decision.
- **Failure:** the run prints `✗ FAILED · <error> (during <last req/stage>)`. A `[llm …]`/`[kambi]` request with
  no matching response = the call that threw. `recall` throwing "need groupIds/participantIds…" means the entity
  gate resolved no ids (look at the `entities` row).

## Invariants
- The trace is **no-op instrumentation**: `src/resolver/trace.ts` + the `emit()` calls in bedrock-call/offering-client/
  resolve only fire when this script sets the ALS store. Prod, eval, and the SSE server pass no store → unchanged.
- `--until` early-stops leave **no envelope** (the generator returns before `done`); that's expected, not a failure.
- Not traced: the `onDemandPricing` betslip fetch (secondary path). Add an `emit` there if you probe betslips.
