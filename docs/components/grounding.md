# Grounding

Component record: how this component works today. The decisions behind it: [adr/grounding.md](../adr/grounding.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
Map the plan's free-text scope (region, competition, teams, players) to real Kambi ids from the sport's
catalog. The grounder returns candidates plus a confidence tier per entity and never forces a guess. One
model call settles only the doubtful cells. A genuine collision becomes a question to the user.

## Input and output
- In: `QueryPlan`.
- Middle: `ResolvedScope`, one `ResolvedLegScope` per selector; each entity is an `EntityResolution`
  `{ text, tier, candidates }` with tier `confident | variants | ambiguous | shortlist | none`.
- Out: `SettledEntities`: the scope with doubtful cells settled to ids, the final sport, and clarifications.

## How it works
1. Load the sport's `ScopeCatalog`: the scope index plus the alias file, with folded-name maps and the roster
   inversion built at load and memoized per sport.
2. Seed: every mention grounds by name alone against its own index. Region against the branches,
   competition against the group whitelist, teams and players against the participant index. Matching is
   lexical: `fold()` for accents, tokens, IDF and BM25 cover (`lexical.ts`). Aliases bridge acronyms.
3. Constrain, per leg, to a fixpoint: prune each mention's candidates to those linked to some candidate of
   every other mention. A strong link (direct membership) is tried first, then a weak one (shared league).
   A constraint that would empty a set is skipped, never applied.
4. Merge across legs: for a repeated mention, the smallest surviving set wins.
5. Tier each entity. The same (slot, text) is grounded once; legs share the `EntityResolution` reference, and
   the entity gate dedups on that identity.
6. The entity gate (`resolve-entities.ts`): cells tiered `ambiguous`, `shortlist` or `none` go to one model
   call (`disambiguator-prompt.md`, tool `settle_cells`). Per cell the model returns `pick` (the id must be a
   listed candidate) or `reexpress` (a cleaner phrase, re-grounded deterministically). It has no clarify action.
7. A cell still doubtful after re-grounding is asked back to the user, deterministically. A name that is
   confident only in another sport's catalog can move the query to that sport, unless the home sport already
   has confident evidence.
8. A squad qualifier ("women") grounds to the women's twin. Doubles pairs ground by surname set.

## Invariants
- A stated sport word locks widening; a guessed sport does not (`invariants.test.ts`).
- A lone foreign pick cannot flip the sport against home-settled evidence (`invariants.test.ts`).
- Under `other`, a league only one sport knows switches the plan to it; a league several sports know abstains,
  and no league overrides a named sport (`invariants.test.ts`).
- A linked candidate beyond the shortlist cap survives the cross-check; weak shortlists rank by live
  prominence; a weak-shortlist pick ships with a "could also be" note (`invariants.test.ts`).
- Entity gate in `npm run eval` (free): gold ids recalled, and a clean tier must contain the gold id
  (`src/eval/scope-scorer.ts`).

## Limits
- A doubles query naming one partner misses; no fuzzy layer for typos; tennis has no region layer;
  basketball national teams are missing; no US super-region (`planning/limitations.md`).

## Where to look
- `src/resolver/grounding/ground-scope.ts`, `resolve-entities.ts`, `disambiguator-prompt.md`, `recover-sport.ts`,
  `lexical.ts`, `scope-catalog.ts`. Probe stages `ground` and `entities`.
- Related: catalogs, extraction, pipeline.
