---
name: resolver-pipeline
description: >-
  Map of the resolver pipeline in src/resolver — the stages in order (extract, checkComplete, recoverSport,
  groundScope, resolveEntities, planRecall, recall, scopeMenu, filterBySubject, resolveMarkets, select,
  buildBetslip, execute), which folder and file owns each (extractor/, grounding/, market/, result/, plus
  shared/, llm/, catalog/), their contracts, shared types, the injection points the gates replay through, and
  the load-bearing invariants. Use when working anywhere in src/resolver: tracing how a query becomes a
  ResponseEnvelope, deciding which stage owns a bug or behaviour, adding/changing a stage, or reasoning about
  per-leg scope, the market-deferred fetch, grounding tiers, or the entity/market LLM steps. Read this BEFORE
  editing pipeline code; pair it with the probe skill to actually run a query through it and read the trace.
---

# resolver-pipeline

The resolver turns one free-text query into a `ResponseEnvelope` (results grouped by event, plus notes and a
clarification). `runPipeline(query, opts)` in `src/resolver/resolve.ts` is the single orchestrator; everything
below is chained from there. `resolveQuery(query)` drains the generator to the final envelope for non-streaming
callers (eval, probes). The long-form why of every component lives in `docs/adr/` (index: `docs/ARCHITECTURE.md`).

## The one mental model: market is decided AFTER the fetch
Recall fetches by **entity** ids broadly (teams/players/competitions), never by market. Each leg then narrows
that broad data to its **own** scope (`scopeMenu`) and resolves its market against the narrowed menu. Two
consequences that explain most of the design:
- **Per-leg scope.** Every `Selector` carries its own `scope` (grain/competition/teams/region/stage/time/
  play_state). There is no query-level scope and no inheritance — the extractor repeats shared values on each
  leg. So grounding, narrowing, filtering and market-resolve all run **per leg** (grouped, see below).
- **Precision bias / abstain over wrong.** Deterministic stages never force a guess. The grounder returns a
  tier + candidates (LLM settles or clarifies); `resolveMarkets` may always return `none`; `select` degrades to
  an honest `fallback`, never a blind pick.

## Layout
`src/resolver/` holds the orchestrator and the test file at the top, and one folder per stage group, in
pipeline order, plus three support folders. A stage's prompt (`.md`) sits next to the stage that loads it.

| Folder | Holds |
|--------|-------|
| `extractor/` | extract.ts, extractor-prompt-v2.md, schema.ts (QueryPlan), normalize-plan.ts, check-complete.ts |
| `grounding/` | ground-scope.ts, resolve-entities.ts, disambiguator-prompt.md, recover-sport.ts, plan-recall.ts, recall.ts, time-window.ts |
| `market/` | filter.ts, resolve-market.ts, resolve-market-prompt.md |
| `result/` | select.ts, combinations.ts, execute.ts |
| `shared/` | live-menu-types.ts (pipeline contracts), lexical.ts (fold/tokens/BM25), offering-client.ts (feed client + raw shapes), trace.ts |
| `llm/` | bedrock-call.ts, openai-call.ts, cost.ts |
| `catalog/` | scope-catalog.ts (load + derived indexes), sports.ts (configs, SPORT_OVERRIDES), build-scope-index.ts (build time only) |

## Stages (in pipeline order)
Order and chaining live in `runPipeline` (`resolve.ts`). LLM = one forced-tool call through `llm/bedrock-call.ts`
(Bedrock Converse, temp 0), or through `llm/openai-call.ts` when `LLM_PROVIDER=openai`. The model id is
env-driven (`BEDROCK_MODEL` / `OPENAI_MODEL`, per-stage `BEDROCK_MODEL_<TOOL>` overrides); never hard-code one.
Everything not marked LLM is deterministic and zero-LLM.

| # | Stage | File | LLM? | In → Out |
|---|-------|------|------|----------|
| 1 | extract | `extractor/extract.ts` + prompt | LLM | `query` → `QueryPlan` (text-valued, ≥1 selector, each with its own scope) |
| 2 | checkComplete | `extractor/check-complete.ts` | no | gate: no team/player/competition/region anchor → clarify and STOP (no fetch) |
| 3 | recoverSport | `grounding/recover-sport.ts` | no | the extractor's sport is a prior: switch when it is blind to an anchor confident in exactly one other sport; clarify when several. Under `other`: the one sport that places EVERY anchor (read with its squad) switches; 2+ is a tie that `breakSportTie` settles with ONE participant fetch (biggest in-window match by `nonLiveBoCount`, the rest named in a note) |
| 4 | groundScope | `grounding/ground-scope.ts` | no | `QueryPlan` → `ResolvedScope` (per-leg entity candidates + tier; lexical, no embeddings) |
| 5 | resolveEntities | `grounding/resolve-entities.ts` + prompt | LLM | `ResolvedScope` → `SettledEntities` (ONE call: pick / reexpress per doubtful cell; clarify is deterministic) |
| 6 | planRecall | `grounding/plan-recall.ts` | no | `SettledEntities` + plan → `RecallInput` (BROAD union across legs; no market) |
| 7 | recall | `grounding/recall.ts` | network | `RecallInput` → `RecallResult` (broad live data + menu; the main network call — the only other is recoverSport's tie fetch) |
| 8 | scopeMenu | `grounding/recall.ts` (`scopeMenu`) | no | broad data + one leg → that leg's narrowed offers/events/menu (grain, comp, teams, time via `time-window.ts`, state) |
| 9 | filterBySubject | `market/filter.ts` | no | scoped offers → only markets that PRICE the subject (P/Q/M/E homes; diacritic-folded) |
| 10 | resolveMarkets | `market/resolve-market.ts` + prompt | LLM | phrases + filtered menu (+ raw query) → one `MarketPick` per phrase (exact/close/none); BATCHED per group |
| 11 | select | `result/select.ts` | no | picked market's real betoffers + spec → concrete `Selection` (outcome(s), or `fallback`) |
| 12 | buildBetslip | `result/combinations.ts` | network | fixture-level picks → ONE `Combination`, a part per match (same-event parts priced by `onDemandPricing`) |
| 13 | execute | `result/execute.ts` | no | resolved legs + referenced data → `ResponseEnvelope` (grouped by event; thin, no fetch) |

## Grouping & "main" (the orchestrator's two non-obvious moves)
In `resolve.ts`, selectors are grouped by a **signature** = filter-subject (+ side) + grounded subject id +
level + competition id + confident team ids + time + stage + playState (built from GROUNDED ids, so surface
variants collapse). Each group gets ONE `scopeMenu` + ONE `filterBySubject` + ONE batched `resolveMarkets` call.

A `market_concept === "main"` selector is a sentinel: it skips the LLM market pick entirely and fans out into
**every** main-tagged market for its matched fixtures (line/subject/odds still apply via `select`).

## Shared types — read these first
`shared/live-menu-types.ts` is the spine: `Menu`/`MenuItem`, `MarketPick`, `Selection`, `ResolvedLeg`,
`ExecuteInput`, `SettledEntities`, `Clarification`, `CellRef`. `extractor/schema.ts` is the extractor output
(`QueryPlan`, `Selector`, `Scope`, `Subject`, `Line`). `grounding/ground-scope.ts` owns `ResolvedScope` /
`ResolvedLegScope` / `EntityResolution` / `ScopeTier`. `shared/offering-client.ts` owns the raw feed shapes
(`BetOffer`, `KEvent`, `KOutcome`). `result/combinations.ts` owns `Combination` / `CombinationPart`.

**Market identity** is one string everywhere: `marketLabelOf(b)` (in `recall.ts`) = criterion `englishLabel` +
variant (`description`). The menu, the pick, and the re-slice all key on it — keep them in lockstep or picks
silently miss.

## Grounding tiers (stage 4 → 5 handoff)
`groundScope` tags each entity `confident | variants | ambiguous | shortlist | none`. Only
`ambiguous | shortlist | none` are sent to the entity LLM; `confident`/`variants` pass through settled. The
resolution is joint and order-free (seed by name → constrain per leg to a fixpoint → merge across legs); a
constraint that would empty a set is skipped, never applied. A memo cache means a value repeated across legs
is grounded once and shares one `EntityResolution` reference — that identity is what the entity gate dedups on
(one cell per distinct entity, fanned back to every leg).

## Injection points (how the gates replay without a model or a network)
`runPipeline` takes no dependency object; the doubles go in at the stage boundary, as defaulted parameters:
- `resolveEntities(query, scope, decideFn = decide)` — the entity LLM step.
- `resolveMarkets(phrases, menu, decideFn = callModel, query)` and the singular `resolveMarket` — the market pick.
- `buildBetslip(…, priceCombo)` — the same-event pricing call.
Production passes nothing. `src/eval/live-menu-gate.ts` and `market-resolve-gate.ts` pass captured decisions;
`invariants.test.ts` passes stubs. The trace (`shared/trace.ts`) and the cost store (`llm/cost.ts`) are
`AsyncLocalStorage` stores: with no store active (prod SSE, eval) their emits are no-ops.

**What you can run for free:** `npm test` (the deterministic invariants) and `npm run gate:live-menu` (replays
filter → select → execute against a captured menu snapshot). Both are zero-cost and zero-network. Anything
that exercises a real LLM decision costs money — use the **probe** skill, and get an OK first.

## Invariants you must not break
- **Never drop on missing data.** Time / co-occurrence / level / groupId filters KEEP rows with absent data
  (lenient) — under-dropping is the only real danger.
- **Diacritic-fold both sides** of any name match (`fold()`), in filter and select — the feed stores accents.
- **Subject id over name.** Prefer the grounded `participantId` (id-keyed, diacritic-immune); fall back to the
  folded name only when there's no confident id.
- **Filter can never drop the right answer** — it keeps a market if the subject hits ANY of the four homes
  (participant / outcome label / market label / event name). Over-keeping is safe.
- **Honest degrade, never a blind pick.** `select` returns a `fallback` (`subject-absent` / `side-absent` /
  `line-absent` / `odds-absent`); a `none` pick carries `unavailable` (`no-fixture` / `no-market` /
  `subject-absent`); execute renders each.
- **Pass odds/line RAW** (integer millis) out of execute; formatting is the consumer's job.

## Changing pipeline code
Shipped resolver code (grounder, prompts, schema, calibration, any stage) is **human-gated**: plan the change in
plain English with a worked example, then stop and ask before editing. When you do touch a stage, keep its
contract (the In→Out above) and the market-identity string stable across menu/pick/slice. After edits, run the
free gates (`npm test`, `npm run gate:live-menu`, `npm run typecheck`); only then consider a paid
`npm run eval` / `npm run probe` run, with permission. Code conventions: the **code-standards** skill.

## Probe stage names → owner
`extract` → extractor/extract.ts · `ground` → grounding/ground-scope.ts · `entities` → grounding/resolve-entities.ts
· `recall` / `scopeMenu` → grounding/recall.ts · `filter` → market/filter.ts · `market` → market/resolve-market.ts
· `select` → result/select.ts · `execute` → result/execute.ts. `[llm …]` rows are the transport (`llm/`), `[kambi]`
rows the feed client (`shared/offering-client.ts`). The betslip pricing call is not traced.
