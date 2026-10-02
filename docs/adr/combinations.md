# ADR: Combinations

Status: current
Last verified: 2026-09-30 against eb4aae8

## Purpose
Combine the user's own resolved legs into one priced bet, the betslip. Two or more legs on the same match
form a Bet Builder part priced by the feed's correlated pricing call; a leg alone on its match is a single at
its own odds. Parts are different matches, so they multiply.

## Input and output
- In: the resolved legs, the live data, and an injected `priceCombo(eventId, outcomeIds)` that returns the
  joint price or null when the feed refuses the set.
- Out: `Combination` `{ odds, oddsLabel, tag: "EXACT", parts[] }`, each part `{ eventId, odds, legs[] }`,
  each leg `{ market, outcome, participant?, line?, matched?, outcomeId }`. Omitted when fewer than two legs
  combine. Odds are raw millis; `oddsLabel` is the display string.

## How it works
1. Fixture-level picks only. Competition and outright picks have no match event to price against.
2. Each leg contributes at most one pick. A multi-fixture leg is one intent, never an accumulator of itself.
3. Legs are assigned to events greedily: the event covering the most legs first, soonest kickoff as the
   tie-break. Co-occurring legs therefore land in one correlated group.
4. A same-event group is priced by `priceLargest`: all ids in one call, then on refusal every subset one
   size smaller in parallel, stopping at the first size where anything prices. Capped at three rounds.
5. A leg that cannot combine drops out of the betslip and keeps its result card. An event where nothing
   prices is banned; its legs re-assign to their other fixtures. A leg re-assigned onto an already-priced
   event re-prices that group correlated; it never multiplies.
6. `odds` is the product of the parts. `oddsLabel` follows Kambi's own display rule: two decimals below 100,
   one below 1000, none above, applied once at the end.
7. Parts, and legs inside a part, keep query order.

## Key decisions and why
- **Same-event legs are priced by the feed, never multiplied.** A same-event joint price is not the product
  of the leg prices (verified live: two legs priced at 41.00 where the product was 19.68).
- **One combination per query.** The betslip is a single card with a section per part, separate from the
  result cards; the frontend adds it with the leg `outcomeId`s.
- **Pricing is injected.** `buildBetslip` stays pure and testable without the network.
- **Top-down subset search.** Combinability is monotone: a failing set never combines by adding legs, so
  trying the largest sets first never misses a bigger win.
- **Query-level `combined_odds`** is checked once against the priced betslip; a miss is reported, never a
  silent leg drop.

## Invariants
- One toxic leg falls out and the biggest combo prices in two rounds; same-size ties keep the
  earliest-mentioned legs; two fan-out legs collapse to one correlated pair on the soonest shared fixture;
  a refused shared event re-assigns its legs; a re-assigned leg re-prices correlated; disjoint events
  multiply; two Bet Builders and a single make one combination; `oddsLabel` matches the Kambi betslip
  (`src/resolver/invariants.test.ts`).

## Limits
- Three pricing rounds: a five-leg group where no triple combines returns no part (pairs never tested).
- The pricing call is not traced by the probe.

## Where to look
- `src/resolver/result/combinations.ts`; the pricing call `onDemandPricing` in `offering-client.ts`.
- Related: selection, envelope, offering-feed.
