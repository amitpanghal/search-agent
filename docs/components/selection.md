# Selection

Component record: how this component works today. The decisions behind it: [adr/selection.md](../adr/selection.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
Once a market is picked, pull the concrete outcome from that market's real betoffers: the line, the
subject's side, a relational role, or a combo such as a correct score. Deterministic, no model. Nothing is
asserted blind; a missing subject, side or line degrades to a named fallback.

## Input and output
- In: a `Slice` `{ events, betOffers }` of the picked market's offers, a `SelectSpec` (subject name and
  id, line, direction, odds bound, count, sort), and the fixture's home and away names.
- Out: `Selection` `{ outcomeId?, outcomeIds?, selectedIds?, line?, subject?, fallback? }`. `outcomeId` is
  the selected outcome, `outcomeIds` the subject's whole pool in this market, `selectedIds` the picks to
  flag (one per fixture on a multi-fixture leg). `fallback` is one of `subject-absent`, `side-absent`,
  `line-absent`, `odds-absent`; absent means a pick.

## How it works
1. Outcomes are keyed by their stable `type` (`OT_OVER`, `OT_UNDER`, `OT_YES`, `OT_NO`, `OT_ONE`,
   `OT_CROSS`, `OT_TWO`, ...). When the type is `OT_UNTYPED` or missing, the un-localized `englishLabel`
   is used instead. That fallback carries about half the feed: outright yes/no rows, Asian handicap sides,
   correct scores.
2. The subject's outcomes are matched by participant id when grounded, else by folded name. A relational
   "home"/"away" binds per fixture. "His team" (an unnamed team with one grounded player in the leg) binds
   per fixture to the side that player plays for, read from the live feed: his own outcomes name his team
   (`eventParticipantId`), the event says if it is home or away (`teamSidesOf`,
   [adr/his-team-binding.md](../adr/his-team-binding.md)). A fixture where he has no outcome is skipped.
3. The line is matched in decimals against the offered rungs. A band ("2+") converts to its ladder rung
   ("over 1.5"). "Win by 2 or more" picks the subject's -1.5 handicap rung. "Not scoring" on an anonymous
   team-total ladder picks Under 0.5. A zero-of-the-stat ask needs the real 0.5 rung; a ladder starting higher
   degrades honestly. No side and no line on an over/under ladder picks the lowest Over.
4. A leg over several fixtures picks that line on each fixture; a fixture without it never stands in.
5. Combos (correct score, half-time/full-time, double chance) match `englishLabel` or the numeric
   `homeScore` and `awayScore`, never the localized label. The token is read from the subject's side and
   the feed writes it home-first, so an away subject's "2-1" is "1-2" and its "win/win" is "2/2"; "his team"
   takes the side from each outcome's own fixture.
6. Anything not found becomes the matching fallback, and the orchestrator carries it into the envelope's
   clarification wording.

## Invariants
- "Win by 2 or more" picks the -1.5 rung; "not scoring" picks Under 0.5; zero-of-the-stat needs the 0.5
  rung; a multi-fixture line leg picks on each fixture; no side and no line picks the lowest Over; "his
  team to win" picks the player's side in each fixture, and no outcome of his is `subject-absent`; a "his
  team" scoreline is read from his side in each fixture (`src/resolver/invariants.test.ts`).
- `npm run gate:live-menu` replays select against the captured snapshot (free).

## Limits
- Most feed scoring markets carry only a Yes row per player, so "X not to score" is `side-absent`.
- Participant matching is by id or folded name; there is no fuzzy layer.
- A leg naming two players gets no "his team" binding.

## Where to look
- `src/resolver/result/select.ts`; the `Selection` and `ResolvedLeg` types in `live-menu-types.ts`.
- Probe stage `select`.
- Related: market-resolution, envelope, offering-feed.
