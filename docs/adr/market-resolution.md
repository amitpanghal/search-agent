# ADR: Market resolution

Status: current — built
Date: 2026-09-30
Component record: [components/market-resolution.md](../components/market-resolution.md)

## Context
For each leg, keep only the markets that price the subject, then let the model pick one market from that
live menu by label and grade the fit. The model may always abstain. This is where the user's words
("both teams to score", "draw no bet") meet the feed's real market names.

## Decisions
- **Labels only, no odds.** The label is the market's identity, and prices would bias the pick.
- **Three grades, `none` always allowed.** `exact` wins in exactly the described scenarios; `close` is a
  same-direction near-synonym or a wider or narrower version; `none` beats a wrong-direction or
  different-bet pick.
- **The prompt's fixed rules.** Sub-part twins (first half, group) are different markets; a plain winner is
  settled only by the head-to-head result market, never a handicap, spread, margin, total or special; a
  margin bet is the opposite case and uses the handicap family; variants are part of identity; a
  `(for <name>)` hint says whose bet it is; an over/under threshold uses the ladder, an inclusive band uses
  the "N+" twin; a sub-unit winner uses the sub-unit twin; a family ask picks one member and lists the rest
  as related.
- **The raw query as context.** The short phrase drops details (the side, the threshold, the sub-unit);
  the request's own wording restores them. The model is told never to pick a market for the request itself.
- **A hallucinated ref can never become a confident wrong answer.** Unknown refs collapse to `none`.
- **Side codes are never outcome labels.** "1" and "2" only mark the result market; the side is chosen by
  the selection stage's subject gate.
- **Batched per group.** The menu is the expensive part of the prompt; it is sent once per group.

## Related
- Superseded 2026-10-03 by [one-market-call](one-market-call.md): the menu is sent once per query, not per group.
- Related: recall, selection, llm-providers, evaluation.
