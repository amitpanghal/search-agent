# Extraction

Component record: how this component works today. The decisions behind it: [adr/extraction.md](../adr/extraction.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
One model call turns the raw query into a `QueryPlan`: what the user wants to bet on, as text, with no ids.
The plan is the contract every later stage reads. The extractor classifies and copies. It never looks
anything up, never judges whether a number is realistic, and never guesses which markets exist.

## Input and output
- In: the query string, in any language.
- Out: `QueryPlan` (`src/resolver/extractor/schema.ts`): `sport` (an enum of the built sports plus `other`),
  `language` (only when not English), `combined_odds`, and `selectors[]`, at least one. A selector is one
  bet: `subject`, `market_concept` (the user's words, in English), optional `line`, `direction`, `odds`,
  `odds_sort`, `line_sort`, `count`, and its own `scope`: `teams`, `players`, `competition`, `region`,
  `level` (fixture or competition), `stage`, `squad`, `time`, `play_state`.

## How it works
1. The system prompt is `extractor-prompt-v2.md` with `{{SUPPORTED_SPORTS}}` replaced by the list of built
   catalogs, so the model can only name a sport the runtime knows.
2. The tool schema is the zod `QueryPlan` compiled to JSON Schema and wrapped in `{ plan }`. Null defaults
   and null branches are stripped from what the model sees; the zod side still accepts and fills null.
3. One forced tool call through the shared LLM transport (Bedrock Converse, or DeepSeek when
   `LLM_PROVIDER=deepseek`).
4. Decode leniently: the plan may arrive as a JSON string, or without the `{ plan }` wrapper. Both are read.
5. `normalizePlan` repairs known unusable shapes at the parse boundary: an all-null `time` or `stage`
   becomes null, an absent `region` or `play_state` becomes null, a blank line or odds is dropped, a
   nameless team subject becomes the bare event subject.
6. Validate with zod. On failure, retry once with the validation error appended to the query. A second
   failure throws.
7. Right after, in the orchestrator: the incomplete gate (`check-complete.ts`) and sport recovery
   (`recover-sport.ts`).

## Invariants
- A plan always has `sport` and at least one selector, and every selector has its own `scope` (schema).
- The extractor gate in `npm run eval`: critical behavior tags at 100%, soft tags at 90% or more.
- Every call is paid; there is no extraction cache. `npm run eval -- --from` replays captured plans for free.

## Limits
- `direction` is under-emitted on some queries; a schema description did not help (measured, `schema.ts`).
- One sport per query (`planning/limitations.md`).
- The extractor is noisy run to run; measure a prompt change with `--runs 3`, never one run.

## Where to look
- `src/resolver/extractor/extract.ts`, `extractor-prompt-v2.md`, `schema.ts`, `normalize-plan.ts`,
  `check-complete.ts`, `recover-sport.ts`.
- Graded by `src/eval/run.ts` with `structural-scorer.ts` and `behavior-tags.ts`. Probe stage `extract`.
- Related: pipeline, grounding, llm-providers, evaluation.
