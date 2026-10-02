# ADR: Market resolution

Status: current
Last verified: 2026-09-30 against eb4aae8

## Purpose
For each leg, keep only the markets that price the subject, then let the model pick one market from that
live menu by label and grade the fit. The model may always abstain. This is where the user's words
("both teams to score", "draw no bet") meet the feed's real market names.

## Input and output
- Filter: scoped offers and events, the subject (name and grounded id, optional side) to
  `FilterResult { offers, menu }`.
- Resolve: the phrases of one leg group, the filtered `Menu`, and the raw query to one `MarketPick` per
  phrase: `{ label?, match: exact | close | none, outcomeLabel?, related? }`.

## How it works
1. `filterBySubject` keeps a market when the subject hits any of four homes: the outcome participant (by id
   when grounded, else the folded name), the outcome label, the market label, or the event name. No subject
   means pass-through. All text matching is diacritic-folded.
2. The menu goes to the model as numbered lines, `ref: label`, with `[outcomes: A | B]` only on items whose
   outcomes disambiguate. The bets go as numbered phrases. The raw query is attached as context. No odds.
3. One call per leg group (`resolve-market-prompt.md`, tool `pick`), so a shared menu is sent once. The
   token budget scales with the number of bets.
4. Picks map back by their `leg` index; a pick with no index falls back to position only when the model
   returned exactly one pick per bet.
5. `toPick` turns a raw pick into a `MarketPick`. `none`, an unknown ref, or a missing pick becomes an
   abstain with no market identity. `outcomeLabel` is kept only when it appears verbatim in the item's
   outcomes and is not a bare 1X2 side code ("1", "2"). `related` is deduped, drops the pick itself, and
   is capped at 3; the envelope later keeps only those that exist on the pick's own event.
6. A `main` leg never reaches this stage; the orchestrator fans it out into the main-tagged markets.

## Key decisions and why
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

## Invariants
- The filter can never drop the right answer: a market stays if the subject hits any home. Over-keeping is
  safe (`filter.ts`).
- A leg-less pick binds by position only when picks match bets one to one; a 1X2 side code is never an
  `outcomeLabel`, "Draw" still is (`src/resolver/invariants.test.ts`).
- `npm run gate:live-menu` (free) replays captured picks through filter, select and execute against the
  snapshot menu. `npm run eval` (paid) checks that a gold concept phrase resolves `exact` to a gold criterion.

## Limits
- The market gate's snapshot is one fixture plus the World Cup 2026 outrights, so it grades market type
  only, not subject binding.
- A family ask returns at most 3 related members.

## Where to look
- `src/resolver/market/filter.ts`, `resolve-market.ts`, `resolve-market-prompt.md`; menu identity in `recall.ts`.
- Probe stages `filter` and `market`. Gates: `src/eval/live-menu-gate.ts`, `market-resolve-gate.ts`.
- Related: recall, selection, llm-providers, evaluation.
