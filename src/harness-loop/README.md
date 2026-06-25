# harness-loop

An offline, **subagent-driven** test rig for the resolver pipeline. It runs the **real** `runPipeline` against the
captured snapshot (`src/eval/live-menu.snapshot.json`), with every LLM step served from a content cache and the
network fetch replaced by the snapshot. **No `ANTHROPIC_API_KEY`, no network.** Grading reads only the final
`ResponseEnvelope`.

## How the LLM-without-API trick works

The deterministic layers are `tsx` code; subagents can only be spawned by the orchestrator (Claude Code). So they
can't live in one process. Instead:

1. `tsx harness-run.ts --batch 001` runs the pipeline; each LLM step (`extract`, entity `decide`, market pick) reads
   from `llm-cache/`. On a **miss** it records the request to `pending-llm.json` and aborts that one query.
2. The orchestrator reads `pending-llm.json`, spawns a **temp-0 Haiku subagent** per miss using the *real* prompt
   (`extractor-prompt.md` / `resolve-market-prompt.md` / the entity prompt), and writes each answer into `llm-cache/`.
3. Re-run step 1 → every step is now a cache hit → the query completes → the grader scores the envelope.

Because the cache key is `hash(kind + exact input)`, fixing deterministic code keeps inputs unchanged → all hits →
re-runs are **free and deterministic**. Only the layer you edit (and anything downstream whose input shifts) misses
and re-spawns.

## Grading (envelope only)

- **market targets** — each leg's any-of criterion id set must appear among the envelope's picked markets.
- **odds filter** (post-resolve) — every *selected* outcome must respect `oddsMin` / `oddsMax`.
- **time filter** (pre-resolve) — soft for now: a `timebound` query must return a non-empty slate.

Per-layer outcomes are logged for **triage** (where it broke); the verdict is the envelope.

## The loop (measure-only; fixes are human-gated)

1. Generate a fresh batch of 10–15 queries (Haiku generator subagent) targeting real snapshot ids.
2. Run it + re-run the accumulated `frozen` set (regression guard). Log a per-category + per-layer scoreboard.
3. **Triage every failure into one bucket** before any code change:
   - **code bug** → fix (shown as a diff, approved one at a time), then re-run (free).
   - **LLM variance** → re-capture, don't touch code.
   - **bad target / gold** → drop or fix the query.
4. Roll passers into `frozen`. Next fresh batch. Grow the batch size once fresh batches stop finding new bug *classes*.
5. Certify ~95% on a larger frozen set at the end (small batches are too noisy to certify).

## Files

- `types.ts` — `BatchQuery` / `GradeSpec` / `GradeResult`.
- `llm-cache.ts` — content-addressed cache + `pending-llm.json` ledger + `CacheMiss`.
- `pipeline-doubles.ts` — the `runPipeline` dependency-doubles (cached LLM steps; recall fetches the live feed FRESH every run, never cached).
- `grader.ts` — envelope → pass/fail on the three axes.
- `batches/batch-NNN.jsonl` — generated queries + by-construction grade specs.
- `harness-run.ts` — the runner (wired once the `runPipeline(query, deps)` DI seam lands).
