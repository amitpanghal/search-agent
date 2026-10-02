# ADR: Combinations

Status: current — built
Date: 2026-09-30
Component record: [components/combinations.md](../components/combinations.md)

## Context
Combine the user's own resolved legs into one priced bet, the betslip. Two or more legs on the same match
form a Bet Builder part priced by the feed's correlated pricing call; a leg alone on its match is a single at
its own odds. Parts are different matches, so they multiply.

## Decisions
- **Same-event legs are priced by the feed, never multiplied.** A same-event joint price is not the product
  of the leg prices (verified live: two legs priced at 41.00 where the product was 19.68).
- **One combination per query.** The betslip is a single card with a section per part, separate from the
  result cards; the frontend adds it with the leg `outcomeId`s.
- **Pricing is injected.** `buildBetslip` stays pure and testable without the network.
- **Top-down subset search.** Combinability is monotone: a failing set never combines by adding legs, so
  trying the largest sets first never misses a bigger win.
- **Query-level `combined_odds`** is checked once against the priced betslip; a miss is reported, never a
  silent leg drop.

## Related
- Related: selection, envelope, offering-feed.
