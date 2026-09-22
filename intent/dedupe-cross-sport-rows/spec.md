# Spec: Dedupe cross-sport candidate rows

- **Intent:** ./intent.md
- **Date:** 2026-09-22
- **Status:** accepted

## Summary

The entity disambiguator's candidate lists (`Cell.candidates`, `src/resolver/resolve-entities.ts:57`) will
carry each id once. Today cross-sport widening (`crossSportRows`, `resolve-entities.ts:122`) runs the team
and the player grounder against every other sport and pushes every hit (`rows.push`, line 142); a row both
grounders match is listed twice. Replayed offline against the committed catalogs, the football plan
`{ subject: team "Tottenham Hotspur" }` grounds to a `shortlist` of 5 own rows and widening adds trotting id
1003385961 "Tottenham" twice: 7 rows, 6 distinct entities. The fix is a dedupe by id where the rows meet;
order and caps are otherwise untouched. No new module, no data shape change.

## Acceptance criteria

1. **Each id once per cell.** Every candidate list the disambiguator hands to its decider (`DecideFn`,
   `resolve-entities.ts:63`) holds each `id` exactly once. When the grounders produce the same id more than
   once, the first occurrence keeps its position and the later ones are dropped. For the football plan with
   team `"Tottenham Hotspur"`, `resolveEntities` hands the decider one `team:0` cell whose candidates are
   6 rows with 6 distinct ids (today: 7 and 6).
   - *How (guidance for plan mode, not checked by review):* dedupe where own and foreign rows are joined in
     `buildEntityCell` (`resolve-entities.ts:160`) or inside `crossSportRows` per call; never via the shared
     `ForeignIds` map (`resolve-entities.ts:120`), which spans every cell of the query and would wrongly
     suppress a legitimate candidate on a second cell.
2. **Order of the survivors is unchanged.** For the same plan the 6 surviving rows are, in order:
   `Tottenham Hotspur (Jekos)`, `Tottenham Hotspur (MakcwellLm)`, `Tottenham Hotspur (Nicolas_Rage)`,
   `Tottenham Hotspur FC (votizlove)`, `Tottenham Hotspur FC (toni)`, `Tottenham` — today's list minus its
   duplicate, nothing re-ranked (the resolve-entities contract: the first row is the grounder's top pick and
   order decides which rows survive the caps, `resolve-entities.ts:239` comment).
3. **The clarification shown to the user is built from the deduped list.** When the decider settles nothing
   for that cell, the clarification `resolveEntities` returns (`clarifyFor`, `resolve-entities.ts:283`) has
   distinct `suggest` ids and its question names each suggested entity once. For the Tottenham plan the five
   suggestions are the five own rows (the cap of 5, `SUGGEST_CAP`, falls before the foreign row), so the
   proof is the dedupe sitting upstream of `clarifyFor` plus the assertions that `suggest` holds 5 distinct
   ids and the question names 5 distinct entities.
4. **The failing test is shown before the fix.** The pull request body pastes the new invariant's failing
   output as run against the code before the change (the assertion message naming 7 rows / 6 distinct), then
   the passing run after it. Review checks the paste is present; the test itself is criterion 1's proof.

## Affected surfaces

- `src/resolver/resolve-entities.ts` — `crossSportRows` (lines 122–147) and/or `buildEntityCell`
  (lines 150–166). No other stage.
- `src/resolver/invariants.test.ts` — one `NEW` test for criteria 1–3, using `groundScope` on the plan above
  (the committed football and trotting catalogs, zero network) and an injected decider, in the shape of the
  existing "entity gate" test at line 451.

## Policy constraints

- **code-conventions, the smallest-diff rule.** One guard where the rows meet plus one test. No refactor of
  widening, no change to `XS_PER_SPORT` / `XS_CAP` (`resolve-entities.ts:107–108`), `ENTITY_CAP` or
  `SUGGEST_CAP` (lines 37–38).
- **code-conventions, Human-gated resolver code.** `resolve-entities.ts` is a pipeline stage: the plan is
  written and approved (`/plan-spec`) before the edit; `/build-plan` commits the test step and the code step
  separately.
- **code-conventions, Never drop a row on missing data.** Not in conflict, stated so nobody reads it as one:
  the dropped row is an exact repeat of an id already in the list, removed for being identical, not for
  lacking a field. Two rows with the same *name* but different ids are two entities and both stay
  (`labelCandidates`, `resolve-entities.ts:76`, already tells such twins apart by game).
- **code-conventions, Never branch on phrasing.** The key is the numeric `id`, never the name text or the
  query.
- **code-conventions, Fold diacritics on both sides.** Not applicable: no name comparison is added.
- **resolver-pipeline, the stage contract.** `resolveEntities` keeps `ResolvedScope → SettledEntities`;
  candidate order stays "grounder's top pick first"; one cell per distinct entity is unchanged. After the
  edit the free gates run: `npm test`, `npm run gate:live-menu`, `npm run typecheck`.
- **probe, reuse captured data.** The intent's evidence is a local, gitignored trace; the spec's proof is the
  offline replay below, so no paid run is required. A live confirmation (`npm run probe -- "Arsenal or Spurs
  to win" --until=entities`) costs one extract and one entity call and needs an explicit OK first (the
  **Ask before paid runs** rule); it is optional.
- `catalog` was not read: the change alters no grounding result and no catalog data, only how already
  grounded rows are joined.

## Data / API contracts

None. `Cell.candidates` stays `{ id: number; name: string }[]`; `SettledEntities` and `Clarification`
(`live-menu-types.ts`) are unchanged.

## Test plan

- **Unit, criteria 1–3:** the new invariant in `src/resolver/invariants.test.ts` builds
  `groundScope({ sport: "football", selectors: [{ subject: { kind: "team", name: "Tottenham Hotspur" },
  market_concept: "to win", scope: { level: "fixture", teams: ["Tottenham Hotspur"], players: [],
  competition: null, region: null, stage: null, squad: null, time: null, play_state: null } }] })`, calls
  `resolveEntities("Tottenham Hotspur to win", scope, decide)` with a decider that records the cells and
  returns `[]`, and asserts: ids distinct and 6 long (1); the exact name order (2); one clarification whose
  `suggest` holds 5 distinct ids and whose question names 5 distinct entities (3). Red on today's code, green
  after.
- **Type check:** `npm run typecheck`.
- **Existing gates:** `npm test` (the 32 current invariants) and `npm run gate:live-menu` stay green.
- **By hand, zero cost:** run the same plan through `groundScope` + `resolveEntities` with a decider that
  prints each cell's rows and distinct count (`npx tsx -e '…'` from the repo root; no network, no model).
  Before: `team:0 rows: 7 distinct: 6`. After: `rows: 6 distinct: 6`, names as in criterion 2.
- **Criterion 4:** the failing and passing outputs pasted in the pull request body.

## Out of scope

- Why a trotting horse named "Tottenham" is a candidate for a football team at all (catalog pollution and
  the esports clones: the intent's first non-goal).
- Any change to ranking, per-sport quotas, or caps beyond the decision below.
- The Jev disambiguator work and any commit threshold.

## Decisions

- 2026-09-22 — Duplicates are removed **before** the caps are applied (`own.length + XS_CAP`,
  `resolve-entities.ts:162`; `SUGGEST_CAP` in `clarifyFor`), so a repeated id never spends a slot that a
  distinct entity could have used. For the Tottenham case this changes nothing (7 rows are under the cap);
  for a name with many foreign hits it can surface one more distinct candidate than today. Decided by:
  engineer. Product owner to confirm.
- 2026-09-22 — The dedupe key is the numeric `id`. Two rows with the same display name but different ids are
  different entities and both stay; `labelCandidates` already suffixes such twins with their game. Decided
  by: engineer (factual).
- 2026-09-22 — Accepted in the chat by the product owner, who also acts as engineer and tester on this
  initiative; committed directly on the integration branch `sdlc-jev` at their instruction, so there is no spec
  pull request with reader boxes for this feature. Decided by: product owner.
- 2026-09-22 — Criterion 3 reworded: `clarifyFor` shows only the first 5 candidates (`SUGGEST_CAP`,
  `resolve-entities.ts:38`) and the 5 own rows precede the foreign row, so the name `Tottenham` never reaches
  the question; the criterion now checks distinctness of what is shown. Found in plan mode. Decided by:
  engineer (factual).
