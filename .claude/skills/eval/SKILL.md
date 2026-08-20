---
name: eval
description: >-
  How to run and read `npm run eval` — the ship gate that grades the extractor on the gold deck plus the
  deterministic entity gate and the live market-resolution gate — and how to edit the gold set itself
  (gold.seed.jsonl, the compact gold-expect.jsonl → `npm run gold` expansion, behavior tags, critical vs soft).
  Use when measuring a prompt/schema/model change, judging whether a change shipped a regression, adding or
  fixing a gold row, re-scoring a baseline for free with --from, or reading a per-tag report. Covers the paid
  discipline and which flags cost money. Pair with the probe skill (single-query root-causing).
---

# eval

`npm run eval` (src/eval/run.ts) is the ship gate. One run grades THREE independent things and exits non-zero
if any fails (CI-usable):

1. **Extractor gate** (LLM, paid) — each gold row's query through the real `extract()` (+ the production
   `recoverSport` correction), scored structurally by TEXT: the extractor's job is the concept *wording*,
   never a criterion id. Throttles are retried (8×) so a rate limit costs time, not a data point.
2. **Entity gate** (deterministic, free) — the scope grounder on the gold's own scope text; graded on the
   pinned catalog ids and expected tier.
3. **Market-resolution gate** (LLM, paid) — resolve-market picks from the CAPTURED snapshot menu
   (src/eval/live-menu.snapshot.json) by each gold market cell's concept phrase; pass = `exact` on a gold
   criterion id. Market-TYPE only, subject-agnostic (the snapshot is one fixture + the WC26 outrights).

## Cost — every run is paid, so:

- **Ask before running.** Default `npm run eval` = 1× per row: the routine gate. `--runs 3` is the measuring
  default when comparing prompt deltas. `--release` (5×) is final sign-off only — always ask first.
- **The extractor is noisy run-to-run** (two identical 1× runs once scored 6/11 vs 5/11). A 1× delta between
  two prompts is a coin flip; measure with `--runs 3` (a row passes only if ALL runs pass).
- **`--from cap.jsonl` re-scores for FREE.** It replays extractions captured by
  `npm run probe -- --file queries.txt --until=extract --out cap.jsonl` — no model calls, market gate
  skipped. After a gold/scorer change, replay the existing capture; only a prompt/schema/model change needs
  fresh extractions (there is no cache — every non-replay run pays per row).

## Flags

| flag | effect |
|---|---|
| `--runs N` / `--release` | repeats per row (default 1 / release 5); pass = all N pass |
| `--id g001` / `--last N` | one row / the last N rows |
| `--from cap.jsonl` | FREE replay of captured plans; grades only the rows the capture covers |
| `--query "..."` | ad-hoc extraction, no grading (eyeball the extractor; 1 paid call) |
| `--ground "..." [--grain competition]` | ad-hoc market resolve vs the snapshot menu (1 paid call) |
| `--jobs N` | concurrency (default 4) |
| `--unservable` | also grade rows whose anchors no catalog carries (normally reported + excluded — that's catalog coverage, not extraction) |

## Reading the report

Rows are multi-tagged by the BEHAVIOR they stress (behavior-tags.ts). The gate: **critical tags must be
100%** (wrong entity/market/side, or fabricating where it should abstain); **soft tags** (scoping/wording/
optional-facet recall) pass at ≥90% aggregate. A red tag names the failure class — go root-cause it with the
probe skill, not by rerunning the eval.

## Editing the gold set

Two decks, edited differently:
- `src/eval/gold.seed.jsonl` — hand-authored rows with pinned catalog/criterion ids (they drive gates 2+3).
  Edit directly.
- `src/eval/gold.corpus.jsonl` — **generated, never hand-edit.** Author compactly in
  `planning/corpus/gold-expect.jsonl` (one line per query, only what differs from defaults; query/tags/sport
  join from `planning/corpus/corpus.jsonl`), then `npm run gold` expands it. The compact format is documented
  at the top of scripts/expand-gold.ts.
- Schema for both: gold-record.ts (`Grounded` cells; market cells are `id` / `offer` / `main` / `none`).
  Market accept-phrases are graded by lenient containment — include the DISTINGUISHING noun ("winning
  margin", not "margin").
- Gold fixes change the measure, not the system — after one, re-score the existing capture with `--from`
  (free) rather than paying for a fresh run.
