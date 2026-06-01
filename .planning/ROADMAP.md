# Roadmap: Intent Resolver — Structural Eval Harness (v1 milestone)

## Overview

This milestone stands up a runnable structural eval harness for the NL intent resolver. Nothing in the repo is runnable today (no `package.json`, no installed deps), yet the schema, extraction prompt, gold-record types, behavior tags, scorer spec, and 3 seed records all exist. The journey: first make a **query → validated QueryPlan** slice run end-to-end on Claude Haiku (bootstrap + extractor + cache); then build the **structural scorer + report** and prove the whole pipeline correct against the 3 known-answer seed records (the hard ordering gate); finally **widen the corpus to ~2/tag** and emit the trustworthy baseline report. Each phase is an end-to-end vertical slice — a runnable thing you can verify — not a horizontal technical layer. Done is a *trustworthy baseline report*, not a prompt-tuned-to-green gate (that is the next milestone).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Runnable Extractor Slice** - `npm run extract "<query>"` sends a query to Haiku (temp 0) and returns a Zod-validated QueryPlan, with response caching and a `--fresh` 5× release flag.
- [ ] **Phase 2: Scorer + Report, Validated on Seeds** - The structural scorer grades the no-grounding axes and emits a per-axis/per-tag/tiered-gate report; the whole pipeline is proven correct end-to-end on the 3 seed records via `npm test`.
- [ ] **Phase 3: Corpus Expansion + Baseline Report** - The gold corpus is widened to ~2 records per behavior tag (~35 records, incl. abstain/sentinel cases) and `npm test` emits the trustworthy baseline report.

## Phase Details

### Phase 1: Runnable Extractor Slice
**Goal**: A single query becomes a Zod-validated QueryPlan via Claude Haiku, end-to-end, on a now-runnable repo — with response caching and a release-grade `--fresh` 5× mode.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: BOOT-01, BOOT-02, EXT-01, EXT-02, EXT-03, EXT-04
**Success Criteria** (what must be TRUE):
  1. `npm install` succeeds and `resolver/schema.ts` type-checks (the repo is runnable for the first time).
  2. Running `npm run extract "Both teams to score markets priced over 1.90"` sends the query to Claude Haiku at temperature 0 with structured output, using `resolver/extractor-prompt.md` + `resolver/schema.ts`, and prints a `QueryPlan` that passes Zod validation; malformed model output surfaces as a typed failure (e.g. a non-zero exit + error), never silently accepted.
  3. With no `ANTHROPIC_API_KEY` in the environment, the command fails fast with a clear, actionable error before any query is sent (the key is read from env, never committed).
  4. Re-running the same query against an unchanged prompt makes **zero** API calls (a cache keyed by query + prompt-hash + model is hit); changing the prompt or model invalidates the cache.
  5. `npm run extract --fresh "<query>"` bypasses the cache and runs the query 5× at temperature 0, surfacing all 5 raw results for a reproducibility check.
**Plans**: TBD

### Phase 2: Scorer + Report, Validated on Seeds
**Goal**: The structural scorer grades raw extractor output on every no-grounding axis, the report emits per-axis + per-tag pass-rates and a tiered-gate verdict, and the entire query→extract→score→report pipeline is proven correct against the 3 seed records (known answers) via `npm test` — the hard ordering gate before any bulk authoring.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: SCORE-01, SCORE-02, SCORE-03, SCORE-04, RPT-01, RPT-02, RPT-03, RPT-04, CORP-01, HARN-01
**Success Criteria** (what must be TRUE):
  1. `npm test` runs the 3 seed records (`eval/gold.seed.jsonl`) end-to-end — extracts each query, scores it, prints the report — and the harness produces the **expected** verdicts for all three (g001 football resolved, g002 tennis → `unsupported`, g003 no-sport → FOOTBALL default), confirming the pipeline is wired correctly.
  2. The scorer grades the enum/structural axes (`status`, `sport`, `subject.kind`), grades `binding` and `market` by **text** against the gold `accept[]` lists with selectors paired by market (order-independent), and grades line-vs-odds typing + values, `level`, player `role`, age-normalization, and `attrFilter` routing — verifiably exercised by a deliberate binding-swap producing markets-found=100% but binding=fail (per the scorer-spec worked example).
  3. A wrong answer scores worse than a missing one (precision ≫ recall), and this weighting is visible in the per-record outcome (a wrong/false-positive facet fails the record; a missing soft facet is tracked but does not earn a pass).
  4. The report prints per-axis pass-rates, per-behavior-tag pass-rates for all 17 tags in `eval/behavior-tags.ts`, and a tiered-gate verdict (critical tags must be 100%, soft tags against a ~90% aggregate).
  5. On any failure, the raw text `QueryPlan` is retained beside the graded output in the report so a human can localise the break (extraction vs grounding).
**Plans**: TBD

### Phase 3: Corpus Expansion + Baseline Report
**Goal**: The gold corpus is widened from 3 seed records to ~2 per behavior tag (~35 structural records), and `npm test` runs that corpus to emit the milestone's trustworthy baseline report.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: CORP-02
**Success Criteria** (what must be TRUE):
  1. The gold corpus contains ~2 records per behavior tag (~35 records), each a structural record (text plan + tags + `accept[]` + `expect.status`, **no ids**) that validates against the `GoldRecord` Zod schema.
  2. Every one of the 17 behavior tags in `eval/behavior-tags.ts` is exercised by at least 2 records, including the abstain/sentinel cases (no-sport → FOOTBALL default, named-unbuilt-sport → `unsupported`).
  3. The corpus was authored **after** the harness was proven on the seeds (Phase 2), and no eval query/entity/market was added to `resolver/extractor-prompt.md` to make a record pass (the bounded-prompt constraint held).
  4. `npm test` runs the full ~35-record corpus and emits the baseline report — per-axis + per-tag pass-rates and the tiered-gate verdict — as the trustworthy starting number for the follow-on grounding/tuning milestone.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Runnable Extractor Slice | 0/TBD | Not started | - |
| 2. Scorer + Report, Validated on Seeds | 0/TBD | Not started | - |
| 3. Corpus Expansion + Baseline Report | 0/TBD | Not started | - |
