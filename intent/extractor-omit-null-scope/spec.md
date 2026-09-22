# Spec: Extractor stops emitting null scope fields

- **Intent:** ./intent.md
- **Date:** 2026-09-22
- **Status:** superseded

## Summary

The tool schema the extractor sends to Bedrock (`INPUT_SCHEMA`, `src/resolver/extract.ts:38`, passed as the
`emit_query_plan` tool's `inputSchema` at `src/resolver/bedrock-call.ts:44`) will stop listing the value-or-null
scope fields as required. Today `z.toJSONSchema(PlanEnvelope)` (`extract.ts:39`) emits, for every selector's
`scope`, `required: [teams, players, competition, region, level, stage, squad, time, play_state]` and, inside
`time`, `required: [date_window, kickoff_time_of_day, fixture_pick]` (generated this session from the shipped
`schema.ts`). Prompt rule 3 (`src/resolver/extractor-prompt-v2.md:239`) tells the model to omit exactly those
keys when empty, and `normalizeScope` (`src/resolver/normalize-plan.ts:49`) already backfills them, so the
model's nulls are dead weight the schema forces on it. After the change only `level` stays required inside
`scope`, nothing inside `time`; the parsed `QueryPlan` and the `Scope` TypeScript type (`schema.ts:118`) are
unchanged, so nothing downstream moves. On the 21 Sep Baltimore trace (4 legs) the model's plan is 995
characters, of which 587 remain once every null and empty-array key is dropped: the tokens the intent wants back.

Two corrections to the intent's prose, both factual: the relaxed set is the eight scope fields plus the three
`time` sub-fields (the intent names seven; see Decisions), and there is no extract cache in the code (see
Decisions; `intent.md` is corrected in this pull request).

## Acceptance criteria

1. **The tool schema requires only `level` inside a scope.** In the JSON schema `extract.ts` hands to
   `bedrockToolCall` for `emit_query_plan`, each selector's `scope` object lists exactly `["level"]` as
   `required`, and the object inside `scope.time` lists no required key. The rest of the schema is as today:
   plan `required` `["sport","selectors"]`, selector `required` `["subject","market_concept","scope"]`, the
   same property set and enums, and the same `description` on `competition` (`schema.ts:93–100`).
   - *Observation:* `npm run probe -- "<any query>" --until=extract --log=full` prints the `[llm
     emit_query_plan]` request whose `schema` field is this object (`bedrock-call.ts:36`); one extract call.
   - *How (guidance for plan mode, not checked by review):* `.default(null)` on the six nullable scope fields
     and the three `Time` fields, `.default([])` on `teams` and `players`, and `z.toJSONSchema(…, { io:
     "input" })` was measured this session to produce exactly these `required` lists while keeping the parsed
     type (`z.string().nullable().default(null)` parses to `string | null`, `tsc --strict` checked). Input
     mode also drops `additionalProperties: false` from the objects; `z.object` strips unknown keys at parse,
     so this is harmless, but plan mode may instead keep output mode and remove the keys from `required`
     after generation. Either way the schema must be reachable from a test (export it, or the builder).
2. **A plan with the fields omitted parses to the same plan as one with them present.** Take the raw
   extractor output of the 21 Sep Baltimore trace (below); remove from every selector's `scope` each key
   whose value is `null` or `[]`; run `normalizePlan` (`normalize-plan.ts:71`) then `QueryPlan.parse`
   (`schema.ts:161`) on both versions: the two results are deep-equal. A scope reduced to
   `{ "level": "fixture" }` (prompt rule 3's own example, `extractor-prompt-v2.md:241`) parses to
   `teams: [], players: []` and `competition`, `region`, `stage`, `squad`, `time`, `play_state` all `null`.
   `npm run typecheck` passes, and no file that imports `Scope` or `QueryPlan` is in the diff
   (`ground-scope.ts:31`, `time-window.ts:14`, `check-complete.ts:10`, `plan-recall.ts:12`,
   `recover-sport.ts:19`, `src/eval/*`).
3. **The Baltimore query answers with a shorter output and the same plan.** After the change, one paid probe
   `npm run probe -- "baltimore to win and Kazuma to score a HR, Shane Bazz to have atleast 3 strikeouts and
   total runs over 7.5" --until=extract --log=full --out <trace.jsonl>` shows, on the `emit_query_plan`
   response row, `outputTokens` of at most 160 (21 Sep: 7,086 in, 223 out), and its `extract` stage output,
   after normalization, deep-equals the 21 Sep plan: four selectors, `sport: baseball`, subjects team
   `Baltimore` / player `Kazuma` / player `Shane Bazz` (line 3, `at_least`) / `event` (line 7.5, `over`), every
   scope `level: fixture`, `teams: ["Baltimore"]`, everything else empty. The call's latency (response `t`
   minus request `t`; 4,110 ms on 21 Sep) is reported beside the before number, not gated.
4. **The extractor gate does not regress.** Before any code change, the gold deck's queries
   (`src/eval/gold.seed.jsonl`, 12 rows, and `src/eval/gold.corpus.jsonl`, 279 rows) are captured once with
   `npm run probe -- --file <queries.txt> --until=extract --out cap-before.jsonl`; after the change the same
   command writes `cap-after.jsonl`. Both are graded free with `npm run eval -- --from <cap>` (`loadReplay`,
   `src/eval/run.ts:66`, reads each row's `extract` stage output). On the after replay every critical tag
   scores at least what it scores on the before replay, and the soft aggregate is not lower. The rows whose
   normalized plan differs between the two captures are listed by id with a one-line diff each.
5. **Evidence in the pull request body.** The body pastes: the new test's failing output on today's code
   (the nine-entry `required` list) and its passing output after; the probe's token count, latency and
   plan-equal result next to the 21 Sep numbers; the two replay summaries (queries passed, soft aggregate,
   critical tags) and the differing-row list; and the paths of the saved probe trace and both captures.

## Affected surfaces

- `src/resolver/schema.ts` — `Time` (lines 60–73) and `Scope` (lines 80–117): defaults on the relaxed fields.
  No field added, removed or renamed; `level` stays a required enum.
- `src/resolver/extract.ts` — the `INPUT_SCHEMA` build (lines 37–42); the schema or its builder exported for
  the test.
- `src/resolver/invariants.test.ts` — `NEW` test(s) for criteria 1 and 2, zero network, zero model.
- `intent/extractor-omit-null-scope/intent.md` — the extract-cache constraint corrected (fact, see Decisions).
- Not touched: `extractor-prompt-v2.md` (intent non-goal; rule 3 already says omit), `normalize-plan.ts` (its
  backfill stays, see Decisions), `src/eval/gold-record.ts` (`GoldScope` already carries `.default(null)` on
  `region`, `play_state`, `squad`, lines 128–132, and grades the parsed plan, which does not change), every
  consumer of `Scope` / `QueryPlan`.

## Policy constraints

- **code-conventions, the smallest-diff rule.** Defaults on eleven fields, one line in the schema build, one
  test. No prompt edit, no rewrite of `normalizeScope`, no change to `level`, no new module.
- **code-conventions, Human-gated resolver code.** `schema.ts` and `extract.ts` are pipeline files: the plan
  is written and approved (`/plan-spec`) before either is edited; `/build-plan` commits the test step and the
  code step separately, and the pull request links the plan step.
- **code-conventions, Ask before paid runs.** Three paid runs, each with an explicit OK in the chat before the
  command: the before capture (criterion 4, about 291 extract calls, roughly $0.38 at the intent's $0.0013 per
  query), the after capture (same), and the Baltimore probe (criterion 3, one extract call). `--until=extract`
  on all three so nothing past the extractor is paid for; every trace saved with `--out` and named in the pull
  request (criterion 5); the 21 Sep Baltimore trace is reused as the before, never re-run.
- **code-conventions, Fix at the right layer.** The extractor already returns every value; the dead nulls are
  a schema artefact, so the fix is in the schema, not the prompt (which already says omit) and not downstream
  (which already backfills).
- **code-conventions, Never drop a row on missing data.** Not in conflict, stated so nobody reads it as one: an
  omitted scope key is backfilled to `null` or `[]` before any filter sees it (criterion 2), so no filter
  receives a row it did not receive before.
- **code-conventions, Never branch on phrasing / Sport-agnostic prompts / Fold diacritics.** Not applicable:
  no query-text logic, no prompt text, no name comparison is added.
- **resolver-pipeline, the extract stage contract.** `query → QueryPlan` (text-valued, ≥1 selector, each with
  its own scope) is unchanged; `Scope` is a shared type (`ground-scope.ts`, `time-window.ts` import it), so
  its inferred type may not change (criterion 2). After the edit the free gates run: `npm test`,
  `npm run gate:live-menu`, `npm run typecheck`.
- **eval, the paid discipline and the noise.** The `--from` replay is free and deterministic and skips the
  market gate, which this change cannot reach (extraction only). The extractor is noisy run to run at 1×
  (the skill: a 1× delta is a coin flip; tags under n=20 are noise), so criterion 4 is judged on the critical
  tags and the soft aggregate (n=344), and the per-row differences are reported for reading, not gated. A
  dip that looks like noise is settled by one more capture, with a fresh OK, never by re-running until green.
  No gold row is edited.
- **probe, reuse captured data.** The 21 Sep Baltimore trace (local, gitignored, one line of JSONL with the
  request's `schema`, the response's `outputTokens` and both `t` stamps) is the before for criterion 3 and the
  fixture for criterion 2; `--log=full` is the manual observation for criterion 1.
- `catalog` was not read: no grounding result and no catalog data changes.

## Data / API contracts

The `emit_query_plan` tool's `inputSchema` changes as criterion 1 states (the `required` lists of `scope` and
`time`; optionally a `default` marker per relaxed field). `QueryPlan`, `Scope`, `Selector` (TypeScript) and the
`ResponseEnvelope` are unchanged.

## Test plan

- **Unit, criteria 1–2:** new invariant(s) in `src/resolver/invariants.test.ts`: (a) import the exported tool
  schema, walk to `properties.plan.properties.selectors.items.properties.scope`, assert `required` deep-equals
  `["level"]` and the object under `time` has no `required`; (b) the Baltimore raw plan as a literal, stripped
  of null/empty scope keys, through `normalizePlan` + `QueryPlan.parse`, deep-equal to the unstripped parse;
  (c) `{ level: "fixture" }` parses to the backfilled scope. Red on today's code (the nine-entry list), green
  after.
- **Type check:** `npm run typecheck`.
- **Existing gates:** `npm test` and `npm run gate:live-menu` stay green.
- **By hand, one paid call (criterion 3):** the probe command in criterion 3; read the `[llm emit_query_plan]`
  rows for `outputTokens` and the two `t` stamps, and the `extract` stage for the plan.
- **Paid captures + free replay (criterion 4):** build `<queries.txt>` from the `query` field of the two gold
  files (a one-liner in the scratchpad, not committed); run the probe capture before the code change and
  again after; `npm run eval -- --from cap-before.jsonl` and `-- --from cap-after.jsonl`; diff the two
  captures' `extract` outputs per query for the differing-row list.
- **Criterion 5:** the pastes in the pull request body.

## Out of scope

- The prompt's wording (rule 3 is already right) and any model change: the intent's non-goals.
- Making `level` optional: it is the grain, has no null reading, and `normalizeScope` already defaults an
  absent one (`normalize-plan.ts:66`); the schema keeps asking the model to state it.
- Removing the now-redundant backfill in `normalizeScope`, and the other latency levers named in the intent's
  evidence (a faster model, a no-LLM path for simple queries, prefetch during extract).
- The market-resolution gate and the entity gate: neither reads anything this change touches.

## Decisions

- 2026-09-22 — The relaxed set is every scope key the model may omit under prompt rule 3 and `normalizeScope`
  backfills: the intent's seven (`competition`, `region`, `stage`, `squad`, `time`, `play_state`, `players`)
  plus `teams` (rule 3's own example omits it: `scope: { "level": "fixture" }`) and the three `time`
  sub-fields (`date_window`, `kickoff_time_of_day`, `fixture_pick`, backfilled at `normalize-plan.ts:59`).
  Decided by: engineer. Product owner to confirm.
- 2026-09-22 — The intent's "current baseline" does not exist in the repository: `planning/corpus/baseline.md`
  is the 13 Aug pre-rewrite run (gate FAIL, 45%) and no later report is saved. Criterion 4 therefore takes a
  before capture on the current schema and an after capture, both replayed free, instead of the intent's one
  `npm run eval`: two paid extraction passes of about $0.38 each, and the full eval's paid market gate is not
  run because the change cannot reach it. Decided by: engineer. Product owner to confirm.
- 2026-09-22 — Criterion 3's bars: `outputTokens` at most 160 is hard (the intent's "about 130" plus room for
  the model's run-to-run variation; today 223); plan identity with the 21 Sep trace is hard (it is the point
  of the change); latency is reported, not gated, because it also depends on the network and Bedrock's load
  at the time. Decided by: engineer. Product owner to confirm.
- 2026-09-22 — Fact: there is no extract cache. `extract.ts` calls Bedrock on every run; the eval's only reuse
  is `--from` replay of a saved capture (`run.ts:66`), and a capture taken before the change reflects the old
  schema. The intent's constraint is corrected in `intent.md` in this pull request; its consequence (grade on
  fresh extractions after the change) stands. Decided by: engineer (factual).
- 2026-09-22 — `normalizeScope`'s backfill stays although the schema defaults make it redundant: it also
  guards a model that emits a blank string or garbage (`normalize-plan.ts:54`, `:62`), and removing it is a
  refactor the intent did not ask for (the smallest-diff rule). Decided by: engineer (factual).
- 2026-09-22 — Accepted in the chat by the product owner, who also acts as engineer and tester on this
  initiative; committed directly on the integration branch `sdlc-jev` at their instruction, so there is no spec
  pull request with reader boxes for this feature. That acceptance confirms the three decisions above marked
  `Product owner to confirm.` (the relaxed set, the two captures as baseline, the criterion 3 bars). Decided by:
  product owner.
- 2026-09-22 — Superseded with the intent. On the branch, criteria 1 and 2 were met (tests green, typecheck
  green) and criteria 3 and 4 were not: the model's output did not change. See `intent.md` Decisions for the four
  measurements. Nothing merged. Decided by: product owner.
