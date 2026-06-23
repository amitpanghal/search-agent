# Plan — return a team-and-player combo where each leg lives on a different page

## The query

*"England to win the World Cup and Kane to be top scorer."* Two legs, each owned by a
different subject:

- **England → "To Win The Trophy"** (a team outright).
- **Kane → "To score most goals in the Competition"** (id `1001304945`, the tournament
  Golden Boot, Kane priced ≈ 4.0). This market lives on the **player's** page.

Expected answer: both prices. Today only the England leg comes back; the Kane leg is empty.

## What the investigation found (live, full-pipeline)

The failure was three separate things at three layers. One is already fixed; two small
changes remain.

1. **Grounding picked the wrong market.** The disambiguator chooses a market from a 10-item
   menu. That menu was being rebuilt by re-running a fresh candidate search that **dropped
   the tournament-vs-single-match (level) filter** the grounder otherwise applies. So
   single-match markets ("First Goal Scorer", "Correct Score", …) flooded the menu and
   pushed the real Golden Boot to #11 — one past the cut. The disambiguator never saw it and
   settled the leg on a generic per-match market instead.
   **FIXED** in `disambiguate.ts`: the menu now reuses the grounder's own, level-filtered
   shortlist (`gr.candidates`), where the Golden Boot ranks #3. Verified: the leg now settles
   to `1001304945`. Pending: the 1× ship gate (this changes the candidate menu for every
   vector-grounded market, so it needs a regression check).

2. **The player's outright isn't narrowed to the asked player.** With both legs at
   competition level, planFetch keys the fetch on the player (`ids=[Kane]`) but does **not**
   set `playerOutcomeIds`. So the Golden Boot offer keeps **all ~82 players'** outcomes
   instead of just Kane's.

3. **A spurious yes/no line deletes the player's pick.** The extractor turns "top scorer"
   into a `binary` `yes` line. But the Golden Boot's outcomes are **named participants**
   (`type=OT_UNTYPED`, label `"Harry Kane"`), not Yes/No. The executor's line filter
   (`matchesLine`) sees no `OT_YES`, drops every outcome, and the leg goes empty.

(The England leg already works: "To Win The Trophy" is a genuine Yes/No market, its `Yes`
outcome rides along on the player's page, and the `binary` `yes` line keeps it. No routing
change is needed for it.)

## Changes needed

### Step 1 — `disambiguate.ts` (DONE; verify in the ship gate)

`marketCandidates` now builds the disambiguator's menu from `gr.ids` + the grounder's own
`gr.candidates` (already level-filtered and recall-ranked), capped at `MARKET_CAP`, instead
of re-running an unfiltered `candidatePool`. Same rules on both sides, one list, no lost
filter. The `candidatePool` import is gone and the function is now synchronous.

*Worked example — "top scorer" menu:* before = `[combo, To Score, Correct Score, First Goal
Scorer, …, Total Goals]` (Golden Boot at #11, off-menu). after = `[combo, …for the Team,
**To score most goals in the Competition (#3)**, …]` — the disambiguator picks `1001304945`.

### Step 2 — `plan-fetch.ts`: narrow a player outright to the asked player

In `playerPlan`, set `playerOutcomeIds` to the driving/subject players in **every** routing,
not only the fixture (`wantTeam`) routing. The competition-only routing currently skips it,
which is why the whole board comes back.

```
// today
...(wantTeam ? { playerOutcomeIds: outcomeIds } : {}),
// change to
...(outcomeIds.length ? { playerOutcomeIds: outcomeIds } : {}),
```

`opponentTeamIds` stays gated on `wantTeam` (opponent narrowing is a fixture concept). The
executor's `playerOutcomeIds` stage already bites only player-subject markets, so the England
trophy leg (a team-subject market) passes through untouched.

*Worked example:* "Kane to be top scorer" → `playerOutcomeIds=[Kane]` → the Golden Boot offer
is pruned from ~82 outcomes down to Kane's one. The generic "who will be top scorer" (no named
player) → `outcomeIds=[]` → no pruning → full board, as it should.

### Step 3 — `executor.ts`: keep a named-participant outright under a spurious yes line

In `applyOutcomeConstraints`, when the leg's line is `binary` `yes` and the offer's surviving
outcomes are **named participants** (each has a `participantId` and is not `OT_YES`/`OT_NO`),
skip the line filter. The participant selection *is* the affirmative; Step 2 has already
isolated it to the asked player.

```
const participantOutright =
  c.line?.kind === "binary" && c.line.direction === "yes" && outs.length > 0 &&
  outs.every((x) => x.participantId != null && x.type !== "OT_YES" && x.type !== "OT_NO");
// then gate the existing line branch:
} else if (c.line && !participantOutright) {
  outs = outs.filter((x) => matchesLine(x, c.line!));
}
```

This leaves a real player Yes/No market alone: "Kane to score anytime" has `OT_YES`/`OT_NO`
outcomes, so `participantOutright` is false and the line filters normally. A non-`yes`
direction also filters normally (a "no" on an outright has no matching pick, which correctly
reports "not offered").

*Worked example:* Golden Boot offer, isolated to `{participantId: Kane, type: OT_UNTYPED,
label: "Harry Kane", odds: 4000}` → `participantOutright` true → the `binary yes` line is
skipped → Kane @ 4.0 survives.

## Verification

1. **End-to-end** — `npx tsx scripts/probe-app.ts "England to win the World Cup and Kane to be
   top scorer"`
   - Stage 4 criterion = `[To Win The Trophy, To score most goals in the Competition]`.
   - Stage 5 returns **both** legs: England → Trophy `Yes` (≈ 7.0); Kane → Golden Boot,
     **Kane's outcome only** (≈ 4.0), not the whole board.
2. **Single-subject isolation** — `npx tsx scripts/probe-app.ts "Kane to be top scorer in the
   World Cup"` → only Kane's price (≈ 4.0), not all ~82 players.
3. **Guardrail (fixture yes/no unchanged)** — `npx tsx scripts/probe-app.ts "Germany to win and
   Musiala to score anytime"` → Musiala's anytime Yes/No still filters normally.
4. **Ship gate** — `npm run eval` (1×): SHIP GATE + ENTITY GATE PASS, disambiguator replay
   green, no regressions. This also covers the Step-1 menu change.

## Files

- `src/resolver/disambiguate.ts` — Step 1 (done).
- `src/resolver/plan-fetch.ts` — Step 2 (`playerPlan` `playerOutcomeIds`).
- `src/resolver/executor.ts` — Step 3 (`applyOutcomeConstraints` named-participant guard).

## Known limitation (out of scope)

This query works without an extra fetch because England's trophy outright happens to ride
along on the player's page. A team+player combo where the team's leg is **only** on the
team's own page would need that page fetched too. No such query is confirmed today; revisit
if one appears.
