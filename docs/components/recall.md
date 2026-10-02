# Recall

Component record: how this component works today. The decisions behind it: [adr/recall.md](../adr/recall.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
Turn the settled entity ids into the live data every leg will be resolved against, without knowing the
market. Recall fetches broad, once, and then narrows the data to each leg's own scope and builds that leg's
menu. It is the only network call in the main path.

## Input and output
- In: `SettledEntities` plus the plan, planned into `RecallInput`: `levels` (union of leg levels),
  `groupIds`, `participantIds`, `eventIds`, `playState` (only when every leg agrees), `lang`, `onlyMain`
  (only when every leg is `main`).
- Out: `RecallResult` `{ endpoint, menu, data: { betOffers, events }, truncated, failed }`.
- Per leg: `scopeMenu(broad, leg)` gives `ScopedMenu` `{ menu, offers, events, eventIds, timeUnresolved,
  timeApplied }`.

## How it works
1. `planRecall` unions the legs. A player fetches the player id and the player's team ids in one participant
   call, so a fixture-level player market is reachable without knowing the criterion. Nothing leg-specific
   (window, single grain, head-to-head) is bound here.
2. `recall` picks endpoints by what it has. Explicit `eventIds` go to the event endpoint. `participantIds`
   go to the participant endpoint, even for competition-grain markets such as a Golden Boot. `groupIds`
   become one group task each, run in parallel; `onlyCompetitions` only when every leg is competition-grain.
   A mixed query runs both and unions the results, deduped by event id and by betoffer id.
3. A group response caps at 2000 betoffers, silently. Truncation is read from `range.total`, or from hitting
   the cap exactly when `range` is absent. A capped group fans out: filter its event list by level and play
   state, then fetch by event batches with a small pool.
4. A fetch that errors comes back empty and flagged (`failedTask`), never thrown. The query still answers.
5. `buildMenu` makes one `MenuItem` per market identity. The identity is `marketLabelOf`: the criterion's
   `englishLabel` plus the variant (`description`). Outcome labels are attached only when they disambiguate.
6. `scopeMenu` narrows per leg: grain by the event's level tag, competition by `event.groupId`, a live or
   prematch cut, head-to-head co-occurrence, then the time window. A missing level or groupId keeps the row.
7. Time (`time-window.ts`): the phrase becomes a `[from, to]` window and a kickoff band. The calendar (day
   boundaries, weekday, hours) is read in the user's zone; the instants stay UTC. Weekend runs Friday 18:00
   to the end of Sunday, a named weekday is its next occurrence, "late" and "early" are relative to that
   day's other kickoffs, a "next N games" pick floors the window at now. An unparseable phrase is flagged
   unresolved for the clarify path.

## Invariants
- An event with no start survives every window; a live match survives a now-floored window but not a
  future-day one; the kickoff band reads in the user's zone; a day boundary is the user's midnight; an
  unparseable phrase is flagged, not ignored (`src/resolver/invariants.test.ts`).
- A fixture pick orders by kickoff, floors at now, and drops events it cannot order (`invariants.test.ts`).

## Limits
- The participant endpoint ignores `onlyMain`; the MAIN-tag filter for that case runs client-side downstream.
- One sport per query (`planning/limitations.md`).

## Where to look
- `src/resolver/grounding/plan-recall.ts`, `recall.ts`, `time-window.ts`; the client in `offering-client.ts`.
- Probe stages `recall` and `scopeMenu`; `[kambi]` rows are the feed boundary.
- Related: offering-feed, grounding, market-resolution, pipeline.
