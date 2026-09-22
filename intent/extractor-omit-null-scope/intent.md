# Intent: Extractor stops emitting null scope fields

- **Date:** 2026-09-22
- **Source:** human
- **Status:** superseded
- **Jira:** none

## Problem / observed signal

The extractor is the slowest and most expensive stage of the pipeline: 2.8 to 4.1 s and about $0.0013
per query on today's model, and its time is decode-bound — a fit over 1,635 captured extractor calls
gives roughly 0.5 to 0.7 s fixed plus 12 to 14 ms per output token (about 75 tokens per second). Output
length is the lever, and about 41% of the output on a four-leg query is null or empty scope fields
(`competition`, `region`, `stage`, `squad`, `time`, `play_state`, `players`), repeated once per leg.

Three facts conflict. Prompt rule 3 (`src/resolver/extractor-prompt-v2.md:239`) tells the model to emit
only fields that carry a value. `src/resolver/normalize-plan.ts:51` already backfills omitted scope fields
deterministically. But `src/resolver/schema.ts:80` onwards marks those fields `.nullable()` without
`.optional()`, so the tool schema sent to Bedrock lists all of them as `required`, and the model obeys the
schema over the prompt.

Evidence: the Andorra (3 legs, 162 output tokens, 2.85 s) and Baltimore (4 legs, 223 output tokens,
4.11 s) probe traces of 2026-09-21, and the latency fit over the August captures in `.sweep/` — all local
files, gitignored, not committed.

## Desired outcome

The extractor's answer carries only the fields that have a value. The normalized plan the rest of the
pipeline receives is unchanged, and multi-leg queries answer about a second sooner and proportionally
cheaper.

## Non-goals

- No change to the prompt's wording or rules.
- No model change.
- No redesign of per-leg scope, and no change to how a query is split into legs.

## Constraints known up front

- `schema.ts` is shipped resolver code: plan and approval before the edit (the **Human-gated resolver
  code** rule).
- There is no extract cache: every eval row and probe pays for a fresh extraction, and a capture taken before
  the change reflects the old schema, so any grading after the change needs fresh extractions.
- The ship gate `npm run eval` and a proving probe are paid runs: one of each, with an explicit OK (the
  **Ask before paid runs** rule).

## Success signal

On the Baltimore query the extractor's output falls from 223 to about 130 tokens and its latency from
4.1 s to about 3 s (one paid probe). The extractor gate in `npm run eval` shows no regression against the
current baseline (one paid run), and the normalized plans for the gold set are identical before and after.

## Decisions

- 2026-09-22 — Constraint corrected: no extract cache exists (`extract.ts` calls Bedrock on every run; the
  eval's only reuse is `--from` replay of a saved capture). The consequence — grade on fresh extractions after the
  change — stands. Fact, fixed by the engineer in the spec pull request.
- 2026-09-22 — Superseded: measured, premise falsified. (1) A before capture of the 290 gold queries on the shipped
  schema: 0 of 311 scopes omitted any of the eight value-or-null keys (7.05 emitted empty per scope). (2) With the
  fields optional in the tool schema (`scope.required = ["level"]`, zod defaults, input-mode JSON schema; branch
  `feature/extractor-omit-null-scope`, last commit 54b9b00, deleted unmerged): 61 matched rows, still 0 omitted,
  output tokens 5,151 → 5,135, raw output byte-identical in 47 of 61. (3) The Baltimore probe on the new schema:
  239 output tokens (was 223), every empty still emitted. (4) A prompt variant turning every field-level "else
  null" into "omit", plus the `competition` description: 5 queries, 0 omitted, two queries lost a leg.
  Qwen3-Next-80B fills every property the tool schema lists whatever `required`, the prompt or the field
  description says, so the desired outcome is not reachable by a schema or prompt change. Spend about $0.47.
  The remaining levers — a model that honours optional fields, a no-LLM path for simple queries, prefetch during
  extract — are a new intent. Captures: local, gitignored, `scripts/.trace-out/omit-null-scope/`. Decided by:
  product owner.
