# Pre-rewrite baseline

What the **current** extractor scores against the Phase 5 gold, so Phase 6 has something to beat.

Captured from `.sweep/gold-extract.jsonl` (the Phase 4 sweep) and re-scored offline — no model call:

```bash
npm run eval -- --from .sweep/gold-extract.jsonl
```

288 of the 289 gold rows (`z001` crashed in the sweep on an off-enum `sport`, so it has no captured plan).

```
Queries passed: 127/288  (44%)
Soft aggregate: 150/335  (45%)   bar ~90%
SHIP GATE: FAIL
```

## Critical tags (bar: 100%)

| tag | rate | |
|---|---|---|
| price-fractional | 0/20 | 0% |
| named-over-side | 1/11 | 9% |
| score-combo | 2/14 | 14% |
| yes/no-line | 4/17 | 24% |
| margin-market | 2/8 | 25% |
| binding | 3/9 | 33% |
| sport-default | 1/3 | 33% |
| multi-leg | 6/18 | 33% |
| league-modifier | 24/69 | 35% |
| self-correction | 2/5 | 40% |
| fixture-lookup | 21/44 | 48% |
| price-not-a-leg | 1/2 | 50% |
| coref-his-team | 1/2 | 50% |
| player-prop | 13/23 | 57% |
| either-team | 2/3 | 67% |
| outright | 41/61 | 67% |
| over-under-side | 16/23 | 70% |
| line-vs-price | 22/26 | 85% |
| coref-his | 0/2 | 0% |

## Soft tags (bar: ~90% aggregate)

| tag | rate | | tag | rate | |
|---|---|---|---|---|---|
| line-range | 0/12 | 0% | scope-competition | 18/26 | 69% |
| line-sort | 0/12 | 0% | scope-team | 12/20 | 60% |
| combined-odds | 0/6 | 0% | line-no-number | 13/23 | 57% |
| scope-player | 1/16 | 6% | stage | 1/2 | 50% |
| play-state | 2/9 | 22% | scope-region | 1/2 | 50% |
| odds-only-bounds | 10/36 | 28% | player-role | 1/2 | 50% |
| time | 21/60 | 35% | family-ask | 7/10 | 70% |
| odds-sort | 21/44 | 48% | level | 37/50 | 74% |
| | | | scope-mononym / scope-nt-variant / age-normalize | 2/2, 2/2, 1/1 | 100% |

## The failures, by shape

Every distinct failure message, collapsed and counted:

```
42  sport: expected ~"X", got "Y"
40  competition: expected ~[...], got null
32  binding kind: expected "X", got "Y"
23  unexpected market
17  market not found
17  direction: expected undefined, got "X"      <- a filter clause read as a side
12  odds_sort: expected undefined, got "X"      \  "biggest handicap" ranked by
12  line_sort:  expected "X", got undefined     /  PRICE instead of LINE
11  odds: wrong value                              (fractional odds, mostly)
11  line: expected {min:N}, got N                  (a bound read as a rung)
10  direction: expected "X", got undefined
 7  odds_sort / odds: dropped
 6  combined_odds: expected {...}, got undefined
 6  odds/line: invented where the query stated none
```

The three Phase 3 fields (`line-range`, `line-sort`, `combined-odds`) sit at a flat **0%** — expected, and the
cleanest measure of the rewrite: the schema can carry them, the prompt has never taught them.

`competition: got null` at 40 is the single biggest block, and the one that hurts most downstream —
`check-complete` hard-stops a query with no anchor before any fetch, so a dropped league is not a degraded
answer but no answer at all.

## Not the extractor

- **Entity gate** fails on one pre-existing seed row (`g013` "Premier League" → ambiguous). Unrelated to the
  corpus rows, which carry no ids and are skipped by that gate.
- **Market-resolution gate** is skipped under `--from` (it resolves live against the snapshot menu).
