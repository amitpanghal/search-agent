# Plan: Dedupe cross-sport candidate rows

- **Intent:** ./intent.md
- **Spec:** ./spec.md (Status: accepted, 2026-09-22)
- **Date:** 2026-09-22
- **Branch:** `feature/dedupe-cross-sport-rows`, cut from `origin/sdlc-jev` (the integration branch, AGENTS.md)

## Context

Cross-sport widening (`crossSportRows`, `src/resolver/resolve-entities.ts:122`) runs the team grounder and
the player grounder against every other sport's catalog and pushes every hit into that sport's `rows`
(line 142). A row both grounders match is pushed twice, and the duplicate then survives the per-sport quota
(`s.rows.slice(0, XS_PER_SPORT)`, line 147), the join in `buildEntityCell` (line 160), the cell cap
(`own.length + XS_CAP`, line 162) and the clarify cap (`SUGGEST_CAP`, line 284). Replayed offline against
the committed catalogs, the football plan with team `"Tottenham Hotspur"` yields 7 rows for 6 entities:
trotting id 1003385961 "Tottenham" twice.

The root cause is the missing dedupe inside `crossSportRows` at the push, so that is where the guard goes:
one line, before every cap and quota, which also satisfies the spec's first Decision (duplicates removed
before the caps). The join in `buildEntityCell` is left alone: own rows come from the home sport's tree and
foreign rows from other trees, and a participant id lives in one tree, so no second guard is needed there
(the smallest-diff rule). Criterion 1's test asserts uniqueness on the whole cell, so if a cross-tree
duplicate ever appears it fails there.

**Spec defect found (fact, engineer's call):** criterion 3 asks the clarify question to list `Tottenham`
once. `clarifyFor` (`resolve-entities.ts:283`) shows only the first `SUGGEST_CAP = 5` candidates and the
5 own rows precede the foreign row, so `Tottenham` appears zero times, today and after the fix. Step 1
amends the criterion to what is observable and records it under the spec's `## Decisions`.

## Steps

1. **Amend `spec.md` criterion 3, commit before any code.**
   - Reword criterion 3 to: *"The clarification shown to the user is built from the deduped list: its
     `suggest` ids are distinct and its question names each suggested entity once. For the Tottenham plan
     the five suggestions are the five own rows (the cap of 5 falls before the foreign row), so the proof is
     the dedupe sitting upstream of `clarifyFor` plus the assertions that `suggest` holds 5 distinct ids and
     the question names 5 distinct entities."*
   - Update the Test plan's criterion 3 sentence to match (assert `suggest` = 5 distinct ids, question names
     5 distinct entities; drop "contains `Tottenham` once").
   - Add under `## Decisions`: *"2026-09-22 — Criterion 3 reworded: `clarifyFor` shows only the first 5
     candidates (`SUGGEST_CAP`, `resolve-entities.ts:38`) and the 5 own rows precede the foreign row, so the
     name `Tottenham` never reaches the question; the criterion now checks distinctness of what is shown.
     Decided by: engineer (factual)."*
   - Files: `intent/dedupe-cross-sport-rows/spec.md`. Commit message: `spec: amend criterion 3 — the
     clarify cap precedes the foreign row`.

2. **The invariant and the guard, red then green, one commit.**
   - In `src/resolver/invariants.test.ts`, after the existing "entity gate" test (line 451), add
     `test("entity gate: cross-sport widening lists each id once when the team and player grounders both hit", …)`:
     build the plan from the spec's Test plan (`sport: "football"`, team `"Tottenham Hotspur"`, fixture
     level, every other scope field null or `[]`, cast `as QueryPlan` like `planFor` at line 152), call
     `groundScope(plan)` (already imported, line 149), then
     `resolveEntities("Tottenham Hotspur to win", scope, decide)` where `decide` records the cells it was
     given and returns `[]` (the query names no sport word, so widening fires — `queryNamesSport`, line 116).
     Assert, in this order:
     - criterion 1: the `team:0` cell's ids are distinct — `assert.equal(new Set(ids).size, ids.length,
       \`rows ${ids.length}, distinct ${new Set(ids).size}\`)` — the message is the paste for criterion 4;
     - criterion 2: `assert.deepEqual(names, ["Tottenham Hotspur (Jekos)", "Tottenham Hotspur (MakcwellLm)",
       "Tottenham Hotspur (Nicolas_Rage)", "Tottenham Hotspur FC (votizlove)", "Tottenham Hotspur FC (toni)",
       "Tottenham"])`;
     - criterion 3 (amended): `settled.clarifications.length === 1`; its `suggest` has 5 entries and
       `new Set(suggest).size === 5`; the names inside the question's trailing parentheses are 5 and distinct.
   - Run `npm test`: the new test is red at the first assert with `rows 7, distinct 6`. Paste that output
     into the pull request body (criterion 4).
   - In `crossSportRows` (`resolve-entities.ts:140–143`), before `out.set(...)` / `rows.push(...)`, skip a
     candidate whose id this sport already produced:
     `if (rows.some((r) => r.id === c.id)) continue; // team+player grounders both hit the same row`.
     Nothing else changes: quotas, caps, sort, `ForeignIds`, `buildEntityCell` untouched.
   - Run `npm test`: green, 33 tests. Paste the passing line into the pull request body too.
   - Files: `src/resolver/invariants.test.ts`, `src/resolver/resolve-entities.ts`. Commit message:
     `build: step 2 — dedupe cross-sport rows at the push`.
   - Note for the future: like the tennis invariants (lines 177–190), this test pins names from the
     committed catalogs; a `npm run catalogs` refresh that renames or drops an esports clone will need the
     expected list in criterion 2 updated, in the same change as the refresh.

3. **Run the checks** (below) and the by-hand replay from the spec's Test plan; confirm
   `git diff sdlc-jev -- src/resolver/resolve-entities.ts` is the one added line.

## Criteria to proof

| Criterion | Files that change | Test that proves it |
|---|---|---|
| 1 — each id once per cell | `src/resolver/resolve-entities.ts` | `invariants.test.ts` → "cross-sport widening lists each id once…", the distinct-ids assert |
| 2 — survivor order unchanged | `src/resolver/resolve-entities.ts` | same test, the `deepEqual` on the six names |
| 3 (amended in step 1) — clarify built from the deduped list | `intent/…/spec.md` (step 1), `src/resolver/resolve-entities.ts` | same test, the `suggest` and question-name asserts |
| 4 — failing output shown before the fix | pull request body | no automated test — the red `rows 7, distinct 6` line and the green `npm test` line pasted in the PR body; review checks the paste |

Criteria 1–3 have a test. Criterion 4 is evidence in the pull request by design (the spec's checkability
pass reworded a process claim into pasted output).

## Checks

- `npm test` — 33 tests, the new one included
- `npm run typecheck`
- `npm run gate:live-menu`
- By hand, zero cost: `npx tsx -e '…'` from the repo root running `groundScope` + `resolveEntities` on the
  plan above with a decider that prints each cell's row and distinct counts — expect `team:0 rows: 6
  distinct: 6` and the six names of criterion 2
- No paid run. A live confirmation (`npm run probe -- "Arsenal or Spurs to win" --until=entities`) is
  optional and needs an explicit OK first (the **Ask before paid runs** rule)
