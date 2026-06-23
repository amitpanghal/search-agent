# Plan: event-subject market grain (deterministic relevel) + cross-match ranking

## Context (why this change)

Query that exposed the gap: **"which World Cup 26 match has the highest draw odds."**

The query is a **competition-wide sweep over a per-match market**: scope = the whole tournament, but the
market wanted (the 1X2 draw price) is a **fixture**-level market (`Full Time`, id 1001159858). Today this
fails at three layers:

1. **Grounder** hard-filters market candidates by the scope's `level` *before* scoring
   (`src/resolver/ground-market.ts:271`, `levelOk` at :142). At a `competition` scope, the fixture-level
   `Full Time` is dropped up front, and the fixture-scoped `"match result"→Full Time` alias never fires → junk
   shortlist → the disambiguator can only **clarify**.
2. **Executor** `onlyCompetitions` (`src/resolver/executor.ts:74`) keys off `pf.level=competition` and tells
   the server to drop all per-match offers → **0 offers** fetched even if the market grounds. (Proven live: 0
   vs 40 offers.)
3. **Ranking**: `odds_sort` (`src/resolver/executor.ts:357`, inside `applyOutcomeConstraints` :320) only ranks
   outcomes *within one offer*, so "highest" never ranks the matches against each other.

**A naive fix is wrong.** Forcing `event` subjects to fixture grain regressed the replay case
`wc36-29-reach-qf` ("can they make the last eight" → `To reach the Quarter Final`, a **competition**-level
market with an `event` subject). So `subject.kind` does **not** determine grain — the grounder must try both
and keep the solid hit, without widening the candidate pool (noise) and without the model drifting.

Intended outcome: competition-scoped per-match queries answer end-to-end (top-3 matches by the asked price),
with tournament-level queries (reach-QF, World Cup winner) unchanged and no model drift.

## Approach (4 changes, by layer)

### G1 — Grounder/disambiguator: deterministic try-both level
- Add a **shared helper** that wraps `groundMarket`, used by both `groundScopeMarkets`
  (`src/resolver/disambiguate.ts:218`) and the disambiguator's `buildMarketCell` / `reground` closure
  (`src/resolver/disambiguate.ts:151,163`), so both grounding entry points share one behavior. `marketOpts`
  (`disambiguate.ts:121`) is **not** changed to force a level (that was the failed fix).
- **Trigger (narrow):** only `event` / `either_match_team` subjects, and only when pass-1 (at scope level) is
  **weak** (read `GroundResult.method`/`.tier`). Define the solid/weak split ONCE — used by both the trigger
  and the acceptance gate below:
  - **solid = `method ∈ {alias, name}` OR `tier ∈ {confident, variants}`**
  - **weak = everything else** (`tier ∈ {shortlist, ambiguous}`, or `method = none`)

  `variants` (a confident twin pair, e.g. Home/Away Win-to-Nil) is **solid**. The earlier "alias/exact/confident"
  wording was wrong on two counts: `exact` is not a real value (it means `method = name`), and dropping
  `variants` would both mis-fire the trigger on an already-solid pair AND reject a good flipped pair.
- **Action:** re-ground once at the flipped level. The query embedding is **reused from cache** (same phrase)
  via `embedQuery` (`ground-market.ts:249`) — no extra Voyage call; `memoKey` already includes level
  (`ground-market.ts:554`) so the two passes are distinct cache entries.
- **Acceptance gate (anti-drift core):** keep the flipped result **only if it is solid** (the predicate
  above). If both levels are weak → keep pass-1 and let the disambiguator clarify, as today. A
  marginally-higher *weak* cosine never wins. (Verified: the live draw-odds case clears this — the flip
  re-grounds via the `level: fixture` alias `match result → Full Time` (aliases.json:23) → `method = alias`
  → solid. Pass-1 at competition level is `vector`/`shortlist` = weak, so the trigger fires correctly.)
- **Untouched:** `team`/`player` subjects (level = breadth there); the per-side twin divert (default = no
  flip); the LLM reword (`reexpress`) stays as the fallback after G1.

### E1 — Executor: `onlyCompetitions` per-criterion
- In `selectTasks` (`src/resolver/executor.ts:64`, `onlyCompetitions` at :74), fire `onlyCompetitions` only
  when **every** criterion is competition-grain, reusing `levelsOf` (`executor.ts:34`, already used at :77;
  postFilter :444 routes per-criterion the same way via each criterion's own `.level`).
- Behaviour-preserving for competition outrights and market-less plans; only the "fixture criterion under a
  competition scope" case flips from 0 → 40 offers.

### E2 — Executor: `resultType` for 1X2 picks
- In `matchesLine` (`src/resolver/executor.ts:293`), map result words to outcome **type** (`draw→OT_CROSS`,
  `home→OT_ONE`, `away→OT_TWO`); fall back to label only for `OT_UNTYPED` (Correct Score "2-1", outright
  Yes/No). Sibling of the existing `htftTypes` (`executor.ts:269`). Needed because the live extraction reads
  "draw odds" as *match result + draw selection*, and the draw outcome's label is "X", not "draw".

### E3 — Executor: cross-match ranking, top-3
- **Mechanism (one rule, both shapes):** flatten every surviving `(offer, outcome)` pair for the ranked
  selector across ALL offers, sort by the outcome's odds (`low` = favourite first, `high` = longest first),
  take the top **3**. This single rule covers both shapes uniformly:
  - "highest draw odds" → one draw outcome across MANY match offers → 3 winners = draws from 3 different matches.
  - "shortest odds to score first" → MANY player outcomes inside ONE match offer → 3 winners = 3 players, one match.
- **The ranking IS the order of the returned `offers` array — a deliverable, not an internal detail.** There
  is no render layer in this repo; `Answer` is the terminal product a downstream app displays in array order.
  So E3 must (a) emit `offers` sorted by the ranked outcome, (b) cap to 3, and (c) preserve each offer's
  `eventId` so the consumer pairs price → match name (events sit in a separate `Answer.events` array). A
  correct ranking dropped into an unsorted array is silently lost.
- **Where:** lift the sort from the per-offer step (`applyOutcomeConstraints`, `executor.ts:320`, sort at
  :357–359) to a cross-offer step at answer assembly (`assembleAnswer`, `executor.ts:607`).
- Intentionally also caps within-market ranked results to 3 — a behaviour change to the existing "score first"
  case, so **guard it with an eval** confirming no gold expects the full sorted list.
- **Tests:** one per shape — "highest draw odds" (cross-match) AND "shortest odds to score first"
  (within-match) — since E3 changes both.

### E4 — Executor: broad-query gate, grain-aware + `odds_sort` exempt
- In `checkExecutable` (`src/resolver/executor.ts:117`), fire the "too broad, narrow it" clarify when the
  **criterion grain is fixture** (`levelsOf(...).has("fixture")`) AND not narrowed AND **no `odds_sort`** —
  instead of keying on `pf.level==="fixture"`. So an unranked sweep ("draw odds in every WC match") clarifies;
  the ranked, bounded-to-3 query answers.
- **KEEP the `plan.endpoint === "group"` guard** in the condition. The known weakness that `narrowed` ignores
  team filters is harmless ONLY because a team query routes to the **participant** endpoint (plan-fetch fork:
  any participant → participant endpoint) and so never reaches this group-only gate. Probed (2026-06-20): "draw
  odds in Spain's World Cup matches" extracts `teams: ["Spain"]` → participant endpoint → gate skipped. If the
  endpoint guard is dropped while generalising to `levelsOf`, every team+fixture query would wrongly clarify.

## Phasing

| Phase | Work | Validates |
|---|---|---|
| 0. Checks | End-to-end probe assertions for touched cases; extend disambiguator replay with relevel fixtures | Safety net before changing code |
| 1. G1 | Try-both level flip + acceptance gate | Full Time grounds; reach-QF unaffected; replay ≥4/4 |
| 2. E1 | `onlyCompetitions` per-criterion | Fetch returns 40 offers |
| 3. E2+E3+E4 | resultType, top-3 ranking, broad-gate | Top-3 matches by draw price; sweeps clarify |

## Critical files
- `src/resolver/disambiguate.ts` — `marketOpts` (:121), `buildMarketCell`/`reground` (:151/:163),
  `groundScopeMarkets` (:218) — G1 shared helper.
- `src/resolver/ground-market.ts` — `groundMarket`, `levelOk` (:142), `embedQuery` cache (:249),
  `memoKey` (:554), `GroundResult` method/tier — G1 mechanics (reused, mostly unchanged).
- `src/resolver/executor.ts` — `selectTasks` (:64)/`onlyCompetitions` (:74), `levelsOf` (:34), `matchesLine`
  (:293), `htftTypes` (:269), `applyOutcomeConstraints` (:320, per-offer sort :357), `assembleAnswer` (:607),
  `checkExecutable` (:98, fixture gate :117) — E1–E4.
- `scripts/probe-app.ts`, `scripts/probe-pipeline.ts` — end-to-end probes.
- `src/eval/disambig-fixtures.ts`, `src/eval/disambig-replay.ts` — replay fixtures (add relevel cases).

## Verification (end-to-end)
Run `npx tsx scripts/probe-app.ts "<query>"` and check Stage 5 (`execute()`):
- **"which World Cup 26 match has the highest draw odds"** → market `Full Time`, draw pick, **top-3 by odds
  descending** (e.g. Spain–Saudi 11.5, then next two).
- **"can they make the last eight"** → `To reach the Quarter Final`, **competition, no flip** — unchanged.
- **"who wins the World Cup"** → `Winner`, `onlyCompetitions` **still fires** (competition fetch).
- **"draw odds in every WC match"** (no sort) → **broad-gate clarify**.
- A deliberately weak-both-levels query → **clarify** (anti-drift floor holds).
- `npm run typecheck` clean; `npm run eval` ship gate PASS (no critical-tag miss); disambiguator replay
  **4/4+** (with the new relevel fixtures green).

## Out of scope / parked
- Full gold-set rebuild (extraction-only → end-to-end) is its own track; here we add only targeted end-to-end
  checks for the cases we touch. Existing golds (e.g. g018 → Draw No Bet) are **not** treated as truth.
- The extraction *interpretation* ("match result + draw" vs a "draw" market) — proceed with what the
  extractor emits today (match result + draw selection).
