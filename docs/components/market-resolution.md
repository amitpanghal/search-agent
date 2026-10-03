# Market resolution

Component record: how this component works today. The decisions behind it: [adr/market-resolution.md](../adr/market-resolution.md) and [adr/one-market-call.md](../adr/one-market-call.md).
Last verified: 2026-10-03 against 4b689e2

## Purpose
For each leg, keep only the markets that price the subject, then let the model pick one market from that
live menu by label and grade the fit. The model may always abstain. This is where the user's words
("both teams to score", "draw no bet") meet the feed's real market names.

## Input and output
- Filter: scoped offers and events, the subject (name and grounded id, optional side) to
  `FilterResult { offers, menu }`.
- Resolve: every bet of the query (`{ phrase, menu }`, each with its own group's filtered `Menu`) and the raw
  query to one `MarketPick` per bet: `{ label?, match: exact | close | none, outcomeLabel?, related? }`.

## How it works
1. `filterBySubject` keeps a market when the subject hits any of four homes: the outcome participant (by id
   when grounded, else the folded name), the outcome label, the market label, or the event name. No subject
   means pass-through. All text matching is diacritic-folded.
2. The bets' menus are unioned by label (outcome lists merged) and go to the model once as numbered lines,
   `ref: label`, with `[outcomes: A | B]` only on items whose outcomes disambiguate. The bets go as numbered
   phrases; a bet whose menu is a strict subset of the union carries `[may pick: 0-5, 9]`, its refs as compact
   ranges. The raw query is attached as context. No odds.
3. One call per query (`resolve-market-prompt.md`, tool `pick`). A bet with an empty menu is `none` without
   being asked. The token budget scales with the number of bets.
4. Picks map back by their `leg` index; a pick with no index falls back to position only when the model
   returned exactly one pick per bet. Each answered ref then maps into the bet's own menu; a ref outside the
   bet's set maps to nothing.
5. `toPick` turns a raw pick into a `MarketPick`. `none`, an unknown ref, or a missing pick becomes an
   abstain with no market identity. `outcomeLabel` is kept only when it appears verbatim in the item's
   outcomes and is not a bare 1X2 side code ("1", "2"). `related` is deduped, drops the pick itself, and
   is capped at 3; the envelope later keeps only those that exist on the pick's own event. A `none` keeps its
   `related` too: the asked market is missing, but the closest live markets are still worth showing.
6. A `main` leg never reaches this stage; the orchestrator fans it out into the main-tagged markets.

## Invariants
- The filter can never drop the right answer: a market stays if the subject hits any home. Over-keeping is
  safe (`filter.ts`).
- A leg-less pick binds by position only when picks match bets one to one; a 1X2 side code is never an
  `outcomeLabel`, "Draw" still is; the union dedupes by label and merges outcomes, tags only strict subsets,
  and a union ref outside a bet's set collapses to `none` (`src/resolver/invariants.test.ts`).
- `npm run gate:live-menu` (free) replays captured picks through filter, select and execute against the
  snapshot menu, including two bets with different menus in one call. `npm run eval` (paid) checks that a gold concept phrase resolves `exact` to a gold criterion.

## Limits
- The market gate's snapshot is one fixture plus the World Cup 2026 outrights, so it grades market type
  only, not subject binding.
- A family ask returns at most 3 related members.

## Where to look
- `src/resolver/market/filter.ts`, `resolve-market.ts`, `resolve-market-prompt.md`; menu identity in `recall.ts`.
- Probe stages `filter` and `market`. Gates: `src/eval/live-menu-gate.ts`, `market-resolve-gate.ts`.
- Related: recall, selection, llm-providers, evaluation.
