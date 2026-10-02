# ADR: Recall

Status: current — built
Date: 2026-09-30
Component record: [components/recall.md](../components/recall.md)

## Context
Turn the settled entity ids into the live data every leg will be resolved against, without knowing the
market. Recall fetches broad, once, and then narrows the data to each leg's own scope and builds that leg's
menu. It is the only network call in the main path.

## Decisions
- **Fetch by entity, broad, then narrow per leg.** The market is unknown before the fetch, so nothing
  market-shaped can drive the endpoint.
- **A named participant uses the participant endpoint.** Its id is stable across groups; it reaches a
  player's competition-grain markets too.
- **Market identity is the English label plus variant.** It is locale-stable, and it separates markets that
  share a criterion id across variants. Menu, pick and re-slice all key on this one string.
- **Time is client-side.** The offering API ignores `from` and `to` on every endpoint (verified).
- **Calendar in the user's zone, instants in UTC.** "Tonight after 8pm" for a UTC+2 user must keep the
  20:00 local game and drop the one that is already tomorrow for them. An absent `tz` means UTC.
- **Lenient filters.** A row with missing data is kept. Over-keeping is safe; over-dropping loses the answer.
- **Degrade, do not throw.** A failed or capped fetch is flagged on the result and noted in the envelope.
- **Locale only localizes labels.** `language` maps to a Kambi locale for the fetch; `market=GB` stays fixed.

## Related
- Related: offering-feed, grounding, market-resolution, pipeline.
