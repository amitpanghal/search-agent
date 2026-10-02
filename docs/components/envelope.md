# Envelope

Component record: how this component works today. The decisions behind it: [adr/envelope.md](../adr/envelope.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
Assemble the answer. By the time `execute` runs, recall has fetched and filter, resolve and select have
decided, so this stage only shapes what was picked into the `ResponseEnvelope`. No fetching, no market
decision. It is deliberately thin.

## Input and output
- In: `ExecuteInput` `{ legs: ResolvedLeg[], data, clarifications?, notes?, truncated?, fetchFailed?,
  betslip? }`.
- Out: `ResponseEnvelope`:
  - `events[]`: every referenced event, stored once (result events and betslip-leg events, deduped by id).
  - `results[]`: one card per event with a pick, each with its highlighted betoffers and selected outcomes.
  - `legs[]`: the "we understood" echo, one per selector in query order, with a `matched` flag.
  - `additional[]`: related-market suggestions, flat, query-scoped, capped at 3.
  - `subjects[]`: grounded player tiles when there is little or nothing to show.
  - `notes[]`, `clarificationNeeded` (one sentence or null), `betslip?`, `cost?`, `summary`.

## How it works
1. Group the picked outcomes by event. Each event with a pick becomes one result card; the card's
   highlighted betoffers each carry the selected outcome(s) flagged. Events with no pick never appear;
   the grouping is the prune.
2. Store every referenced event once in `events[]`; a card joins its event by `eventId`.
3. A leg priced into the betslip drops its standalone card on its part's event only; the combination card
   answers it there. Its other fixtures keep their cards.
4. `additional` keeps a related market only when a betoffer with that label exists on the pick's own
   event, trimmed to the same subject as the pick (outright rows included: an outright card shows the subject's
   own row). A `none` pick's related markets attach to the events its menu came from, and that event block
   then ships in `events[]`: when the asked market is not offered, its live siblings are still shown as
   suggestions ("AIK to win the league" with only Top 2 / Top 4 on offer), never as a result.
5. A `none` pick carries why: `no-fixture` (the scope matched no fixture), `no-market` (a fixture existed
   but nothing fit), or `subject-absent` (the resolved subject is not priced on that menu). The
   clarification sentence is worded from that kind and names the resolved subject or scope.
6. Odds and lines are passed through raw as integer millis (1800 is 1.80, -500 is -0.5). The orchestrator
   attaches the `cost` block last.

## Invariants
- `npm run gate:live-menu` replays execute against the captured snapshot (free).
- A subject-absent clarification names the resolved subject, not a missing market
  (`src/resolver/invariants.test.ts`).
- Odds and lines leave execute raw; nothing in the envelope is formatted.

## Limits
- `additional` holds at most 3 suggestions for the whole query.

## Where to look
- `src/resolver/result/execute.ts`; the input types in `live-menu-types.ts`.
- Probe stage `execute`. The log record's `shown`, `additional` and `betslip` are projections of this.
- Related: selection, combinations, api, logging.
