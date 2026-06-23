# Executor — fetch & filter the offering from a SettledScope's FetchPlan

## Context

The stage AFTER `planFetch`. It takes the `FetchPlan` (`src/resolver/plan-fetch.ts`) — endpoint,
ids, and `postFilters` — calls the Kambi Offering API, filters the returned events/offers down to the
query, and returns the answer (plus a related-market shelf). No LLM in this stage; it acts only on what
the plan supplies.

All numbers below are from live probes against `eu.offering-api.kambicdn.com/offering/v2018/kambi`
(`lang=en_GB&market=GB`) on the WC-2026 group `2010133908`, 2026-06-18. They are evidence, not assumptions.

## The core constraint (verified)

The **2000 cap is on the `BetOfferResponse` itself**, so it applies to EVERY bet-offer endpoint, not just
group:

| Call | returned | `range.total` (real size) |
| --- | --- | --- |
| `/betoffer/group/{WC26}` (unfiltered) | 2000 | 33,072 |
| `/betoffer/event/{15 match events}` | 2000 | 11,350 |
| `/betoffer/participant/{1 team}` | 2000 | 2,166 |

A capped response is **silent** — it just has fewer events and `range.total > returned`. So the executor
must read `range.total` on every bet-offer call and treat `total > returned` as truncated.

## Architecture — one executor, not two plans

`FetchPlan` is already ONE type with an `endpoint: "group" | "participant"` field and a shared
`postFilters`. Every bet-offer endpoint returns the SAME shape (`{ betOffers, events, range }`), so once
the bytes arrive nothing downstream cares where they came from. That uniform response is the seam:

```
selectTasks(plan)  →  runTasks(tasks)  →  postFilter(offers, events, pf)  →  relatedShelf() + format
   (the only fork)       (shared)              (shared, biggest piece)            (shared)
```

The unifying abstraction is a **list of fetch tasks** `{ endpoint, ids, serverParams }`. A simple fixture
emits one task; a mixed-level player query still emits ONE task carrying both ids (Phase 0 decision — the
per-criterion split is applied client-side in `postFilter`, not by fanning into two tasks); a capped group
expands into many (batched events). `runTasks` doesn't care which.

## Phasing / rollout

Build in dependency order; **review-gate each phase** — build a phase, review it against its check below,
and only then start the next. Phases 2 and 4 are pure/offline (deterministic asserts over captured offers);
1 and 3 touch the API but reuse the live-probe style already in `scripts/probe-offers.ts`. Each phase ends
with something that works end-to-end up to that point (after Phase 2 a simple fixture query answers for real;
later phases add robustness and polish).

| Phase | Scope | Review gate (concrete check) |
| --- | --- | --- |
| **0 — Prerequisites** | The 3 `[BLOCKING]` items: `planFetch` mixed-level fix, catalog `boTypeIdByName`, shared `offering-client.ts` | *"Mbappé top scorer WC26 + to score next match"* → plan carries BOTH France team id and Mbappé player id, whichever level won; `boTypeIdByName.get("overunder") === 6`; `eventsByGroup(WC26)` returns events. |
| **1 — Fetch spine** | `selectTasks` fork + `runTasks` (single call per task, no cap logic) + the thin tools | *"England vs Ghana full-time result"* → one call, right endpoint + `type=`, bytes arrive. *Mbappé query* → participant endpoint, player id. (Filtering not trusted yet.) |
| **2 — postFilter engine** | Offline filter: criterion, level, playState, opponent, `playerOutcomeIds`, region/comp, MAIN-for-marketless, per-criterion `outcomes[]`, role-tag, combo grouping | Pure/offline over captured offers: *"longest-odds scorer + over 2.5 goals"* → `odds_sort` hits ONLY the scorer offers; *"Musiala to start and score"* → role dropped, answer tagged. |
| **3 — Cap handling + fan-out** | `range.total` truncation detection, group fan-out (events-first → filter → batched `betOffersByEvents`, parallel), participant tripwire | Group query with `range.total > 2000` (e.g. all WC26 player shots) → fan-out returns the complete set; participant truncation → partial + "may be incomplete" note. |
| **4 — Time resolution** | resolve-then-filter, `now`/`tournament` anchors, `kickoff_time_of_day`, the two filter points, tournament-anchor-ignored-on-participant | Offline phrase tests: *"next two days"* → `[now, now+48h]`; *"opening weekend"* → first Sat–Sun from earliest `event.start`; participant + tournament anchor → window ignored. |
| **5 — Clarify gates** | Broad-query gate (`ids:[]`, unbounded player fan-out), region/team ambiguity | *"player shots tomorrow"* (no player, big group) → broad-query clarify with narrowing chips; *"Italy to win"* → clarify with both team + region ids. |
| **6 — Related shelf + answer format** | Wire `relatedMarkets()` (already built) into output; player-fixture comp-id call doubles as shelf odds; final answer shape | Confident *"Total Corners"* → shelf shows Team Corners / Asian Corners; Wincast combo → legs grouped via `covers`. |

## The thin tools (primitives)

Mirror the endpoints; no end-to-end composites (the decision logic stays in one orchestrator). Most of these
ALREADY exist in `scripts/probe-offers.ts` — `getJson`, `batches()`, the events-first `/betoffer/event`
batching under the cap, `levelOf()` (MATCH/COMPETITION tag), prematch filtering. Lift those into a shared
`src/resolver/offering-client.ts` that both the probe and the executor import; don't rewrite. Only the
participant endpoint and `range.total` cap-detection are genuinely new.

- `eventsByGroup(groupId)` → events only, never capped (planning / fan-out source).
- `betOffersByGroup(groupId, { type?, onlyMain?, onlyCompetitions?, excludeLive?, excludePrematch?, maxNumberEvents? })`
- `betOffersByEvents(eventIds[], { type?, onlyMain?, excludePrePacks:true })`
- `betOffersByParticipants(ids[], { type? })`

## `selectTasks` — the only group-vs-participant fork

| | Group | Participant |
| --- | --- | --- |
| ids | the competition group id | team id(s) and/or player id |
| market filter | `type=` from criterion→boType; market-less → `type=2` (1X2) | `type=` from criterion→boType; market-less → `type=2` (1X2) — `onlyMain` is ignored on this endpoint, and `type=2` bounds the call so it doesn't cap |
| level filter | comp-level criteria → `onlyCompetitions`; else none | **per-criterion split** (below) |
| playState | `excludeLive` / `excludePrematch` (server) | client-side on `event.state` (no server flag on this endpoint) |
| tasks emitted | 1 | 1 (both ids in one call; per-criterion split is client-side in `postFilter`) |

**Criterion → boType** (`type=`): each criterion carries `boTypeNames` (`src/resolver/catalog.ts` exposes
them, names only). Map those names → boType **ids** via `data/football/football_betoffertypes.json`
(`outright=4, overunder=6, yesno=18, head=13, playeroccurrenceline=127, …`) — NOT the categories feed, whose
ids are a different space. Cleanest wiring: add a `boTypeIdByName` map to the catalog loader (it already reads
that folder). `type=` accepts a COMMA-SEPARATED list of ids, so a multi-boType query (e.g. a player's "to
score" yesno + "top scorer" outright) is still ONE call. This over-fetches (boType is coarser than
criterion); the exact criterion is re-applied in `postFilter`.

**Participant per-criterion level split** (verified): a TEAM id returns both fixture and competition offers
in one call; a PLAYER id returns ONLY competition outrights (Mbappé player id = 8 comp offers, 0 fixture). So
a player subject whose criteria span BOTH levels needs both ids. The endpoint takes a LIST of ids, so this is
ONE task / ONE call — `betOffersByParticipants([teamId, playerId])` returns the union. `planFetch` carries
both ids (`ids = [team id(s), player id]`, the player still in `playerOutcomeIds`) **only when the player
subject has mixed-level criteria**; a single-level player query keeps its current shape. The executor then
routes each settled criterion by its catalog `level`:

- `level: fixture` → keep offers from the **team id**'s `MATCH` events, filtered to the player via
  `playerOutcomeIds`.
- `level: competition` → keep the **player id**'s `COMPETITION` outrights.
- `level: undefined` (criterion never seen in offers, so the catalog tag is absent — `catalog.ts`) → fall
  back to the query's event-scope `level` (`postFilters.level`).

Proven on the mixed query *"Mbappé to score in his next match and his top scorer in WC26"*: "To Score"
(81 offers, Mbappé present) came back via the France team id; "top scorer in Competition" came back ONLY via
Mbappé's player id (0 from either team id). Carrying both ids in one call serves both legs regardless of
which `level` the extractor picked for the unit; routing per-criterion (not per-plan) keeps each leg correct.
(Needs the `planFetch` change — see Build prerequisites.)

**Named fixture (both teams)**: one task on ONE team id + `opponentTeamIds` filter (England alone = 1488
complete; both ids together capped at 2000). If no `MATCH` event contains both named teams → clarify
("those teams don't meet"); do not fall back to dumping tournament outrights.

## `runTasks` — shared run + cap handling

Run tasks on a small parallel pool (~5–6). For each task: call the primitive, read `range.total`.

- **Group task truncated** → fan out events-first: `eventsByGroup` (never capped) → filter the event list by
  `level / playState` (the useful server filters — `onlyCompetitions`, `excludeLive/Prematch` — are ALREADY on
  the first call from `selectTasks`; `maxNumberEvents` does NOT complete a dense group, verified: 3 events
  still capped at 2274) → batched `betOffersByEvents` (batch 3 typed / 2 untyped, ~740 offers/match verified,
  to stay under 2000), parallel. `time`/`stage` narrowing of the event list lands with Phases 4/5; a
  `maxFanoutEvents` backstop bounds an un-narrowed fan-out and marks the result incomplete.
- **Participant task truncated** → **tripwire**: return what came back + a "results may be incomplete"
  note. No fan-out (there is no events-by-participant endpoint). [Decided]

Verified fan-out sizing:

- one big match ≈ 810 offers unfiltered, ≈ 518 with `type=127` → ~3 matches/call.
- a 7-day WC window = 30 matches ≈ 15,540 `type=127` offers → ~10 batched calls. The group endpoint
  **cannot** time-scope server-side (`from`/`to` are listView-only), so player markets over a window are
  always events-first.
- Latency: `eventsByGroup` ~116 ms; 6 sequential event batches ~1.9 s; same batches parallel ≈ slowest
  call (~0.5 s). Parallelize the fan-out.

## `postFilter` — shared engine over `BetOffer[]` / `Event[]`

One engine, endpoint-agnostic. From `postFilters` it applies: exact `criterion`, `time`, `stage`, `level`
(event `MATCH`/`COMPETITION` tag), `playState` (event `state`), `opponentTeamIds` (event participants),
`playerOutcomeIds` (outcome `participantId`), `region` / `competition` (event `path` / `groupId`).

The executable outcome constraints (`line`, `odds`, `odds_sort`) are NOT plan-wide — they live in
`postFilters.outcomes[]`, each entry pairing a `criterion: number[]` with its own constraints. Apply each
entry's constraints ONLY to offers whose criterion id is in that entry's `criterion[]`; never across the
whole result (else a two-leg query like "longest-odds scorer + over 2.5 goals" would wrongly sort the goals
leg by price too). Outcome fields used (verified live): over/under carry `type` OT_OVER/OT_UNDER + millis
`line`; yes/no carry OT_YES/OT_NO; `odds` are millis (1800 = 1.80); a selection matches on normalized `label`.

`playerRoles` ("starts"/"captain") AND `attrFilter` (position/region/age) are **NOT executable** — the
offering API exposes no pre-match line-up/role signal, and the participant feed carries no player
position/age/region (only name/club/country/competition, verified `football_participants.json`). So the
executor IGNORES both and returns the market without that condition, TAGGING the answer with a note ("showing
all — can't filter by 'starts'" / "…by player position/region/age") so the dropped condition is visible,
never silent.

Market-less query (no criterion) → the executor FETCHES `type=2` (the 1X2 family — boType 2 = Match Result;
verified 747 group / 48 participant offers, no cap) and `postFilter` keeps the **`MAIN`**-tagged headline (the
"Full Time" 1X2, one per event). `type=2` replaces `onlyMain` because `onlyMain` is ignored on participant and
left a two-team market-less query un-bounded (it capped at 2000 and tripped a false "incomplete" note).
`time` is handled by the resolver below.

## Time resolution (client-side)

`time` arrives as a **raw phrase + `anchor`, never dates** — verified end to end: `ground-scope.ts:286`
passes `time: es.time` verbatim, `plan-fetch` copies it unchanged, and the extractor prompt says "keep
time as the stated words — do not resolve them to real dates." Shapes that reach the executor:
`{ date_window: { value: "next two days", anchor: "now" }, kickoff_time_of_day: null }`;
`{ value: "opening weekend", anchor: "tournament" }`; `kickoff_time_of_day: "after 8pm"`.

Since `from`/`to` are ignored on every betoffer endpoint (verified), time is 100% client-side and the
**executor owns a resolve-then-filter step** (nothing upstream does it):

1. Resolve the phrase → a concrete `[from, to]`, using `anchor`:
   - `anchor: "now"` → relative to current time (e.g. "next two days" → `[now, now+48h]`).
   - `anchor: "tournament"` → relative to the tournament start = earliest `event.start` from
     `eventsByGroup` (e.g. "opening weekend" → first Sat–Sun from start). On the **participant (player/team)
     path there is no full tournament event list**, so a `tournament`-anchored window is IGNORED (the rare
     *"Mbappé, opening weekend"* becomes "any upcoming match" — accepted miss) rather than anchoring to the
     participant's own first game.
   The window is resolved ONCE (`resolveExecutionWindow`) and the SAME concrete dates are applied at both
   filter points below — no re-resolution, so a tournament-anchored window can't drift.
2. Filter events by `event.start` (the populated UTC kickoff; `originalStartDate` is usually absent —
   verified — so it's only a fallback) within `[from, to]`, at TWO points: the event list **before** fan-out
   (so only in-window matches are fetched) and the final offers in `postFilter` (the single-call / participant
   path has no separate event list).
3. `kickoff_time_of_day` → filter on the time-of-day of `event.start`.

Fixed conventions (weekend = Sat–Sun, tournament start = earliest `event.start`, "after 8pm" = kickoff
≥ 20:00, "late kickoff" = last slot of the day); when a phrase is genuinely ambiguous, fall back to the
clarify gate to confirm the window. [Decided]

## Combos

Only the few **pre-packaged** combos that exist as a single catalog criterion are supported — Wincast
(player-scores-&-team-wins) / Scorecast. The catalog has ~3 (`Wincast - Anytime/First/Last Goal`). The
plan's `combos: { ids, covers }` carries them; the executor keeps those ids in `postFilter` (filter by
criterion id) and groups legs via `covers`. Arbitrary multi-leg combos are NOT supported — they exist
only as bet-builder pre-packs, which we drop with `excludePrePacks=true`.

## Related-market shelf

`relatedMarkets()` (`src/resolver/related-markets.ts`) builds the shelf offline (names, no API call). For
a player fixture answer, the comp-level player-id task (the level split above) doubles as the shelf's
odds source — the same 8-offer call. For group answers the shelf is names-only (pricing is an optional
extra call).

## Clarify gates (fire AFTER planning, BEFORE execute)

Reuse the `Clarification { ref, question, suggest? }` shape (same as `check-complete.ts` / `disambiguate`).
Implemented as `checkExecutable(plan, window)` (`executor.ts`) — a pure, no-API gate on the plan SHAPE + the
resolved time window; returns a `Clarification` to ask, or null to execute. It fires three cases: unresolved
time, region-only/sport-level (`ids:[]`), and an unbounded fixture fan-out (group + fixture + market + no
time/stage). The event-count threshold (call `eventsByGroup`, clarify only when matches > N) is a deferred
knob — today the gate is shape-based and conservative (fires on the shape, no API call).

- **Existing no-anchor gate** (`check-complete.ts`) — unchanged.
- **Broad-query gate.** Fire when the plan would fan out unbounded: a generic player market (no named
  player) at fixture level over a large group with no `time/stage/team/competition-leaf` narrowing; OR a
  group plan with `ids: []` (region-only / sport-level). `suggest` carries narrowing chips (a group, a
  stage, a date window, or a team) or the competitions under the region. The user's pick is a scope
  augmentation → re-plan (e.g. pick "knockouts" → add `stage` → fan-out drops from 52 to ~16 matches).
- **Region/team ambiguity.** 55 country names resolve to BOTH a team id and a region branch id (Italy =
  team `1000000146` + region `1000461745`). Default routing is surface-form (noun → team, adjective like
  "Italian" → region), with the market concept as a tiebreaker (league-shaped → region, match-shaped →
  team). When still ambiguous, clarify with both ids in `suggest`. A region reading still can't execute
  alone (`ids: []`), so it routes through the same broad-query gate (which can include "…or the national
  team?").

## What we send + server-side filter support (verified)

Every call sends the path `offering=kambi` + ids, and query `lang=en_GB&market=GB`. On top of that, the
filters we send per endpoint:

- `eventsByGroup` → `GET /event/group/{groupId}` — `includeParticipants` (to name teams). No bet-offer
  filters (events only).
- `betOffersByGroup` → `GET /betoffer/group/{groupId}` — `type`, `onlyMain`, `onlyCompetitions`,
  `excludeLive`/`excludePrematch`, `maxNumberEvents`, `includeParticipants`.
- `betOffersByEvents` → `GET /betoffer/event/{eventIds}` — `type`, `onlyMain`, `excludePrePacks=true`,
  `includeParticipants`.
- `betOffersByParticipants` → `GET /betoffer/participant/{ids}` — `type`, `includeParticipants` (that is
  the ONLY server filter that bites here).

Support matrix — ✅ works, ❌ accepted but ignored, — n/a. Probed 2026-06-18:

| Filter | group | event | participant |
| --- | :--: | :--: | :--: |
| `type` (boType ids) | ✅ | ✅ | ✅ |
| `onlyMain` | ✅ | ✅ | ❌ (resolve `MAIN` client-side) |
| `onlyCompetitions` | ✅ | — | ❌ |
| `excludeLive` / `excludePrematch` | ✅ | — | ❌ (client-side on `event.state`) |
| `maxNumberEvents` | ✅ | — | — |
| `excludePrePacks` | — | ✅ | — |
| `from` / `to` (time) | ❌ | ❌ | ❌ (always client-side) |
| `category` (we don't use) | ✅ | ✅ | ❌ |
| `range_start` / `range_size` | ✅ | ✅ | ✅ |
| `includeParticipants` | ✅ | ✅ | ✅ |

Policy that follows from the matrix:

- `type` is the primary lever and is always applied per the criterion (it's the only server filter on
  participant). It accepts a COMMA-SEPARATED list of boType ids, so a multi-boType query is a single call.
- Market-less query → fetch `type=2` (the MAIN market = 1X2 Match Result) on every endpoint, then keep the
  `MAIN`-tagged headline client-side. (`onlyMain` is unused — ignored on participant; `type=2` bounds the call.)
- `onlyCompetitions` for competition-level group queries; `excludeLive`/`excludePrematch` for `playState`
  on group (client-side on `event.state` for participant).
- `excludePrePacks=true` always on event calls.
- **Time is never a server filter** — `from`/`to` are ignored on every betoffer endpoint, so `time` is
  always applied client-side (this is why time-bounded player queries must go events-first).
- **No `category` server-side** [Decided] — its ids are a separate space (a listView id 404s on the
  betoffer endpoints) and it's ignored on participant; `type` is the robust lever.
- Pagination (`range_start`) — not used; we fan out events-first instead.

## Decided

- One executor + one `FetchPlan` shape (endpoint as a field), not two plans.
- Participant cap → tripwire + return partial with a note (no fan-out).
- No `category` server-side filter.
- Time resolver = executor-owned, fixed conventions + clarify when the phrase is genuinely vague.
- boType ids come from `football_betoffertypes.json` (not the categories feed); `type=` accepts comma-
  separated ids, so a multi-boType query is one call.
- Reuse the fetch primitives already in `scripts/probe-offers.ts` (shared `offering-client.ts`); don't rewrite.
- Outcome constraints (`line`/`odds`/`odds_sort`/`attrFilter`) apply per-criterion (from `outcomes[]`), never
  plan-wide.
- `playerRoles` ("starts"/"captain") AND `attrFilter` (position/region/age) not executable (no line-up data;
  no player position/age/region in the participant feed) → ignored, answer tagged.
- Mixed-level player query: `planFetch` carries both team + player ids in ONE participant task; executor
  routes per-criterion by catalog `level`, falling back to event-scope `level` when the catalog tag is absent.
- `tournament`-anchored time on the participant path is ignored (no full event list to anchor against).
- Market-less = the MAIN market = boType `2` (1X2). Fetch `type=2` on every endpoint (not `onlyMain`, which
  participant ignores and which left two-team queries capping), then keep the `MAIN`-tagged "Full Time" headline.
- Cap detection: `range` is present ONLY when capped (`range.total > returned`); small responses omit it, so
  the fallback signal is "hit 2000 exactly" (verified). A capped group fans out events-first; a capped
  participant call is a tripwire (partial + "incomplete" note); `maxNumberEvents` is not a reliable completer.

## Deferred / out of scope (discussed, not built here)

- **Live queries** (`event/live/open`, `event/livedata`) — a future `selectTasks` branch + tool; current
  scope is prematch.
- **Multi-subject across kinds** (a player AND a team in one query, beyond the pre-packaged combo).
- **Region → competition auto-enumeration** — we clarify instead.

## Build prerequisites (required by the executor, not yet implemented)

These live OUTSIDE the executor's own files, but the executor cannot ship without them — they are part of
THIS plan, not deferred work.

- **`planFetch` mixed-level fix** [BLOCKING] (`src/resolver/plan-fetch.ts`) — today it routes a unit by a
  single `scope.level`. Change: when a player subject has criteria at BOTH levels, carry BOTH the team id(s)
  and the player id in the one participant task (`ids = [team id(s), player id]`, player kept in
  `playerOutcomeIds`); the executor then routes each criterion by its catalog `level`. Without it a mixed-level
  player query works ONLY when the extractor picked `level: fixture` — when it picked `competition` the team
  id is absent from the plan and the fixture leg silently returns nothing.
- **Catalog `boTypeIdByName`** [BLOCKING] (`src/resolver/catalog.ts`) — the loader reads only criterions +
  aliases today. Add a normalized name→id map from `data/football/football_betoffertypes.json` so the executor
  can turn a criterion's `boTypeNames` into the `type=` ids. Without it there is no primary server filter.
- **Shared `offering-client.ts`** [BLOCKING] — the live-fetch primitives (`getJson`, `batches`, events-first
  `/betoffer/event` batching, `levelOf`, prematch filtering) exist only inside `scripts/probe-offers.ts`. Lift
  them into `src/resolver/offering-client.ts` for the executor (and the probe) to import. Without it there is
  no fetch layer.

## Known upstream issues that affect executor inputs (not fixed here)

- *"WC 26"* did not ground as the competition in a live run → team-narrowing couldn't drop the club, so
  the plan fetched an irrelevant club id. Grounding bug; it wastes one fetch.
- *"X and Y matches"* (union) is mis-read by extraction as *"X vs Y"* (head-to-head, via
  `opponentTeamIds`). The executor can't recover the union reading once it's collapsed.

## Knobs (to tune on real data)

- Broad-query fan-out threshold (event count that trips the clarify gate).
- Events-per-`betOffersByEvents` batch (~3, from ~518 offers/match at `type=127`).
- Parallel pool size (~5–6).
