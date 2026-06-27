---
name: resolver-pipeline
description: >-
  Map of the resolver pipeline in src/resolver — the stages (extract, ground-scope, resolve-entities,
  plan-recall, recall, scope-menu, filter, resolve-market, select, execute), their contracts, shared types,
  and the load-bearing invariants. Use when working anywhere in src/resolver: tracing how a query becomes a
  ResponseEnvelope, deciding which stage owns a bug or behaviour, adding/changing a stage, or reasoning about
  per-leg scope, the market-deferred fetch, grounding tiers, or the entity/market LLM steps. Read this BEFORE
  editing pipeline code; pair it with the harness-loop skill to actually run/triage queries offline.
---

# resolver-pipeline

The resolver turns one free-text query into a `ResponseEnvelope` (results grouped by event, plus notes and a
clarification). `runPipeline(query, deps)` in `src/resolver/resolve.ts` is the single orchestrator; everything
below is chained from there. `resolveQuery(query)` drains the generator to the final envelope for non-streaming
callers (eval, probes).

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

## Stages (in pipeline order)
Order and chaining live in `runPipeline` (`resolve.ts`). LLM = one Haiku call (temp 0, forced tool use);
everything else is deterministic and zero-LLM.

| # | Stage | File | LLM? | In → Out |
|---|-------|------|------|----------|
| 1 | extract | `extract.ts` + `extractor-prompt.md` | LLM | `query` → `QueryPlan` (text-valued, ≥1 selector, each with its own scope) |
| 2 | checkComplete | `check-complete.ts` | no | gate: no team/player/competition/region anchor → clarify and STOP (no fetch) |
| 3 | groundScope | `ground-scope.ts` | no | `QueryPlan` → `ResolvedScope` (per-leg entity candidates + tier; lexical, no embeddings) |
| 4 | resolveEntities | `resolve-entities.ts` + `disambiguator-prompt.md` | LLM | `ResolvedScope` → `SettledEntities` (pick / reexpress / clarify per cell; 2 passes) |
| 5 | planRecall | `plan-recall.ts` | no | `SettledEntities` + plan → `RecallInput` (BROAD union across legs; no market) |
| 6 | recall | `recall.ts` | network | `RecallInput` → `RecallResult` (broad live data + menu; the only network in the rig) |
| 7 | scopeMenu | `recall.ts` (`scopeMenu`) | no | broad data + one leg → that leg's narrowed offers/events/menu (grain, comp, teams, time, state) |
| 8 | filterBySubject | `filter.ts` | no | scoped offers → only markets that PRICE the subject (P/Q/M/E homes; diacritic-folded) |
| 9 | resolveMarkets | `resolve-market.ts` + `resolve-market-prompt.md` | LLM | phrases + filtered menu → one `MarketPick` per phrase (exact/close/none); BATCHED per group |
| 10 | select | `select.ts` | no | picked market's real betoffers + spec → concrete `Selection` (outcome(s), or `fallback`) |
| 11 | execute | `execute.ts` | no | resolved legs + referenced data → `ResponseEnvelope` (grouped by event; thin, no fetch) |

## Grouping & "main" (the orchestrator's two non-obvious moves)
In `resolve.ts`, selectors are grouped by a **signature** = filter-subject + grounded subject id + level +
competition id + team ids + time + stage + playState (built from GROUNDED ids, so surface variants collapse).
Each group gets ONE `scopeMenu` + ONE `filterBySubject` + ONE batched `resolveMarkets` call.

A `market_concept === "main"` selector is a sentinel: it skips the LLM market pick entirely and fans out into
**every** main-tagged market for its matched fixtures (line/subject/odds still apply via `select`).

## Shared types — read these first
`live-menu-types.ts` is the spine: `Menu`/`MenuItem`, `MarketPick`, `Selection`, `ResolvedLeg`, `ExecuteInput`,
`SettledEntities`, `Clarification`, `CellRef`. `schema.ts` is the extractor output (`QueryPlan`, `Selector`,
`Scope`, `Subject`, `Line`). `ground-scope.ts` owns `ResolvedScope` / `ResolvedLegScope` / `EntityResolution` /
`ScopeTier`. `offering-client.ts` owns the raw feed shapes (`BetOffer`, `KEvent`, `KOutcome`).

**Market identity** is one string everywhere: `marketLabelOf(b)` = criterion `englishLabel` + variant
(`description`). The menu, the pick, and the re-slice (`offersForPick`) all key on it — keep them in lockstep
or picks silently miss.

## Grounding tiers (stage 3 → 4 handoff)
`groundScope` tags each entity `confident | variants | ambiguous | shortlist | none`. Only
`ambiguous | shortlist | none` are sent to the entity LLM (`SENT_TIERS`); `confident`/`variants` pass through
settled. The cascade is adaptive: a confident region hard-scopes competition candidates; a confident
competition/team hard-scopes the player pool (the homonym cut). A memo cache means a value repeated across legs
is grounded once and shares one `EntityResolution` reference — that identity is what the entity gate dedups on
(one cell per distinct entity, fanned back to every leg).

## Injectable boundaries (why the harness can run offline)
`PipelineDeps = { extract, recall, resolveEntities, resolveMarkets }`. Production passes nothing (gets
`REAL_DEPS`); the harness-loop rig injects cached/subagent doubles for the three LLM steps and a live-cached
recall, running the WHOLE real pipeline with no LLM API. To run or triage queries, use the **harness-loop**
skill — do not call the LLM API directly.

## Invariants you must not break
- **Never drop on missing data.** Time / co-occurrence / level / groupId filters KEEP rows with absent data
  (lenient) — under-dropping is the only real danger.
- **Diacritic-fold both sides** of any name match (`fold()`), in filter and select — the feed stores accents.
- **Subject id over name.** Prefer the grounded `participantId` (id-keyed, diacritic-immune); fall back to the
  folded name only when there's no confident id.
- **Filter can never drop the right answer** — it keeps a market if the subject hits ANY of the four homes
  (participant / outcome label / market label / event name). Over-keeping is safe.
- **Honest degrade, never a blind pick.** `select` returns a `fallback` (`subject-absent` / `line-absent` /
  `odds-absent`); a `none` pick carries `unavailable` (`no-fixture` vs `no-market`); execute renders each.
- **Pass odds/line RAW** (integer millis) out of execute; formatting is the consumer's job.

## Changing pipeline code
Shipped resolver code (grounder, prompts, schema, calibration, any stage) is **human-gated**: plan the change in
plain English with a worked example, then stop and ask before editing. When you do touch a stage, keep its
contract (the In→Out above) and the market-identity string stable across menu/pick/slice. After edits, run a
batch through the harness-loop skill to confirm nothing regressed.

## Files
- `resolve.ts` — orchestrator (`runPipeline`, grouping, "main" fan-out, `PipelineDeps`).
- per-stage files as listed in the table above.
- prompts: `extractor-prompt.md`, `disambiguator-prompt.md`, `resolve-market-prompt.md`.
- `live-menu-types.ts`, `schema.ts`, `ground-scope.ts`, `offering-client.ts` — the shared types.
