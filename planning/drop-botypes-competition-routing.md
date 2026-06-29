# Drop `bo_types`; keep the participant route; trim the competition-leg squad

## Decision

`bo_types` (the extractor's coarse bet-offer-type tag) is a **blind LLM guess** off the query words, but the
real bet-offer type is a feed-schema fact the LLM can't see — "who goes further, A or B" is `outright` (type 4)
in a team league and `head` (type 13) in tennis. When the guess is wrong on the fetch (`type=`) it hard-prunes
the market off the data → empty or wrong answer. So: **drop `bo_types` entirely, and keep fetching on the
participant route.**

The only thing `type=` was buying on the participant route was a **fetch shrink** that kept the squad-injection
call under the 2000 cap. We remove the need for that shrink by **trimming the injected squad** instead — one
player already pulls the team's competition markets through (see Evidence), so we don't need the whole roster.

> A group-route reroute (`group + onlyCompetitions`) was investigated and **rejected** — see "Why not the
> group route" below. Keep the participant route.

## Approach

| Leg | Fetch (after change) |
|---|---|
| **competition-grain, names a team** | participant endpoint, untyped, with a **trimmed** squad (first ~5 roster ids, not the whole roster) |
| **competition-grain, names a player** (e.g. tennis "Alcaraz to win Wimbledon") | participant endpoint, untyped — 1 player, never caps |
| **fixture-grain, names a participant** | participant endpoint, untyped — 1–few participants, never caps |
| **bare competition** | group fan-out (existing path), untyped |

No `type=` anywhere. No group reroute. No participant fan-out.

## Files & changes

### `src/resolver/plan-recall.ts`

1. **Trim the squad injection** in `legParticipants` (the `leg.level === "competition"` roster block, lines
   ~29–31): inject only the first **N** (≈5) of `cat.roster.get(tid)`, not the whole roster. N≈5 keeps the
   fetch under cap even in an offer-dense competition (5 × ~331 dense offers ≈ 1655 < 2000), and a handful of
   players still guarantees coverage (any one that's in the team's container event pulls the competition markets
   through; a single pick was the original fragility worry, a few removes it). The exact N is validated against
   the cap (Verification).
2. **Remove the `bo_types` → `type=` computation entirely** (the `YESNO_ID` / `effectiveBoTypes` / `everyTyped`
   / `boTypes` block, lines ~56–69, and `boTypes` from the returned `RecallInput`). The competition-leg
   `yesno`-strip special-case goes with it.

### `src/resolver/recall.ts`

Drop `boTypes` from `RecallInput` and the `typeP = { type: ... }` server param ([recall.ts:152](../src/resolver/recall.ts:152),
[:245](../src/resolver/recall.ts:245)). All endpoints become untyped. `onlyCompetitions` / `onlyMain` / `playState` logic is
untouched.

### `src/resolver/filter.ts` + `src/resolver/resolve.ts` — drop the menu prune

The post-fetch `bo_types` prune ([filter.ts:70–75](../src/resolver/filter.ts:70), fed by `keepTypes` at [resolve.ts:200](../src/resolver/resolve.ts:200)) is the
second consumer. It is soft (empty-guarded) but can still prune to a wrong non-empty subset and mislead the
pick. Remove it: drop the `keepTypes` arg from `filterBySubject` and the `boTypeIdSet(...)` call. `resolveMarkets`
then picks from the full subject-scoped menu — the live-menu-resolution thesis.

### `src/resolver/schema.ts` + `src/resolver/normalize-plan.ts` + `extractor-prompt.md` — cleanup (staged, separate turn)

Once nothing consumes `bo_types`, sweep EVERY remaining reference (not just the schema):

- **`schema.ts`** — drop the `bo_types` field ([schema.ts:94](../src/resolver/schema.ts:94)) and the now-dead `BO_TYPE_KEYS` import ([:10](../src/resolver/schema.ts:10)).
- **`normalize-plan.ts`** — drop `sanitizeBoTypes` (lines ~42–49) and its call site, plus the `BO_TYPE_KEYS` import and `KNOWN_BO_TYPES` set ([normalize-plan.ts:17–19](../src/resolver/normalize-plan.ts:17)).
- **`extractor-prompt.md`** — remove the prompt's market `bo_types` section. **Prompt edit** → show the exact old→new diff and get sign-off first.
- **Delete last**, once the above leave them unreferenced: `src/resolver/bo-types.ts` (the home of `BO_TYPE_KEYS`) + `data/betoffertypes.json`.

(`select.ts` reads `betOfferType` off the live offer, not the bucket table — keep that.)

## Evidence (live offering API, 2026-06-29)

- **Dropping `type=` would cap the FULL squad.** An untyped participant call hits the silent 2000 cap at ~18
  roster ids in an offer-dense league / ~30 in a light one — and the participant endpoint **cannot fan out**
  ([recall.ts:119](../src/resolver/recall.ts:119)). Per-participant offers are mostly *fixture props*, which is the volume. → trim
  the squad rather than keep `type=`.
- **One player is enough for the competition markets.** A team's competition markets hang off a per-team
  **container event** ("Argentina Markets 2026") that lists all the team's players as participants; querying any
  of those players returns that container's betoffers. So a few roster ids (not 25) pull the competition markets
  through, well under the cap.
- **Tennis: no cap risk.** No teams / tiny rosters → 1–2 participants per leg → never approaches the cap.

## Why not the group route (rejected)

`group + onlyCompetitions` returns the same competition markets bounded and untyped, which looked cleaner. But
per-team markets like "Tournament progress by the team" are **one betoffer per team with the team named nowhere
on the betoffer** (generic criterion, generic stage outcomes, `participantId` = the stage). The only handle is
the per-team container event, and **id-based attribution breaks on twins**: the container's team id ≠ the
scope-index id for twin nodes (Argentina feed `1003359223` vs scope-index `1000000153`; France/Brazil/Germany
matched). Name-substring matching was ruled out (must be id-based). The participant route avoids this entirely —
it queries by *player* ids (which match the index) and lets the feed link the container through, so there's no
team-id reconciliation to get wrong.

## Risks

- **Menu-prune removal** widens the menu `resolveMarkets` sees — the precision lever.
- **Squad-trim N** must stay under the cap in the densest competition while still guaranteeing coverage —
  validate the number, don't guess it.

## Verification

1. `npm run typecheck`.
2. **Harness-loop batch** (offline, no API): the existing batch covers the competition team legs (Golden Boot /
   reach-the-final / elimination).
3. **Fetch check** (script, no LLM): for a few competition team legs, assert the trimmed squad participant call
   returns the competition markets AND stays under the 2000 cap; pin N from the densest case observed.
4. End-to-end once tennis exists: "Will Alcaraz or Sinner go further at Wimbledon?" resolves the head-to-head
   competition market that `type=4` used to prune.
