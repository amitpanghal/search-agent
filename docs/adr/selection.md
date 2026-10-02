# ADR: Selection

Status: current — built
Date: 2026-09-30
Component record: [components/selection.md](../components/selection.md)

## Context
Once a market is picked, pull the concrete outcome from that market's real betoffers: the line, the
subject's side, a relational role, or a combo such as a correct score. Deterministic, no model. Nothing is
asserted blind; a missing subject, side or line degrades to a named fallback.

## Decisions
- **Read the market, never guess it.** The offered rungs and sides are the truth; the selector only chooses
  among them.
- **`type` over the localized label.** Labels are localized and reversible; the type enum is stable.
- **The `englishLabel` fallback is load-bearing.** A gate that ignored untyped outcomes would silently drop
  half the feed.
- **Honest fallback, never a blind pick.** A wrong outcome is a wrong bet; "not offered" is recoverable.
- **One pick per fixture on multi-fixture legs.** "Home teams to win in the next 2 games" is two outcomes
  in two event blocks, flagged separately.
- **Odds and lines pass through raw.** Integer millis, exactly as the feed sends them.

## Related
- Related: market-resolution, envelope, offering-feed.
