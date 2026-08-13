# Extractor corpus

Phase 4 of [../extractor-rebuild-plan.md](../extractor-rebuild-plan.md). 415 natural-language queries across
37 sports, each tagged with the behaviours it stresses.

```
corpus.jsonl    415  every query, {id, sport, query, tags}
gold.jsonl      289  the TUNING half — measured on every rewrite iteration
holdout.jsonl   126  the VERIFICATION half — run ONCE at the end of an iteration
gold.txt                 queries only, for `npm run probe --file`
holdout.txt
```

## How it was built

Two axes crossed per sport: the **offering types that sport actually carries** (from the Phase 2 sweep —
see [../offering-sweep-findings.md](../offering-sweep-findings.md)) × the **query shapes** that broke in the
58-probe investigation.

Sizing follows real market variety, not a flat number per sport — tennis carries 545 live market families,
chess carries 1:

| tier | sports | rows each |
|---|---|---|
| A | tennis, football, american-football, basketball, baseball, rugby-league, ufc-mma | ~30 |
| B | golf, australian-rules, rugby-union, cricket, esports, table-tennis, ice-hockey, darts, snooker | ~15 |
| C | the remaining 21 with live data | ~3–5 |

Every query names **real entities pulled from the live feed** (`.sweep/<sport>.json` → `sampleFixtures`,
`sampleParticipants`, `feedGroupsSampled`). That matters: if a query named an invented fixture, a failure
would tell us nothing about the extractor.

Deliberately avoided: the 4 dead sports (`padel`, `pesapallo`, `surfing`, `swimming` — their sport root
404s) and the 74 catalog-gap groups, so a row can't fail for a reason that isn't the extractor's fault.

## The split

Stratified per sport, every 3rd eligible row to holdout, with one override: **a tag appearing in fewer
than 3 rows keeps all its rows in gold**, so the tuning half can always see it. Result: 30% holdout, and
all 38 tags plus all 37 sports present in both halves.

The holdout exists to catch overfitting. It is read **once**, at the end of a rewrite iteration — not
during tuning.

## Tag coverage

All 38 behaviour tags are represented. Thin ones to strengthen if they prove load-bearing:
`age-normalize` (1), `coref-his` (2), `coref-his-team` (2), `scope-region` (2), `player-role` (2),
`scope-nt-variant` (2), `scope-mononym` (2).

## Expectations (Phase 5)

`gold-expect.jsonl` holds one compact expectation per gold row; `npm run gold` expands it into
`src/eval/gold.corpus.jsonl`, which `loadGold()` concatenates onto the hand-authored `gold.seed.jsonl`.
The compact format is documented at the top of [../../scripts/expand-gold.ts](../../scripts/expand-gold.ts).
The pre-rewrite score is in [baseline.md](baseline.md).

Corpus rows carry **no catalog ids** — their `Grounded` cells are accept-lists only. That is what makes 289
rows authorable, and it keeps the deterministic entity gate on its own curated deck instead of reddening it
with catalog gaps that are not extractor bugs.

### Authoring conventions

Each of these was a real fork in the road; they are written down so the next batch stays consistent.

1. **Author from the query, not from the extraction.** For a shape known to be broken, decide the answer
   before looking at what the model produced — otherwise today's bug becomes tomorrow's gold.
2. **`sport` may be a list** when the query genuinely admits more than one ("Which team has the longest odds
   to reach the playoffs?" — four leagues say that). Grading a coin flip teaches nothing. Matching is loose,
   so `basketball` already accepts the narrower `esports-basketball`.
3. **A person inside a team is a `player`; a competitor who *is* a side is a `team`.** So Gyökeres and LeBron
   are players, and Giron, Magny, Matsuyama and Selby are teams. Checked against the grounder, not taste:
   `groundTeam` resolves MMA's "Njokuani" *confident* where `groundPlayer` only manages *shortlist* (the team
   list is the smaller, active-participant one), and only `scope.teams` drives head-to-head fixture narrowing
   (`fixtureHasAllTeams`). Both slots reach `participantIds`, so this costs nothing at fetch time.
4. **`either_match_team` only when the query names a side but not the team** ("the home side", "the away
   team"). "The favourite" names no side — it is a property of the match, so the subject is the `event`.
5. **Don't mirror the subject into `scope.teams`** unless the query really names it as a fixture side
   ("A vs B"). `ground-scope` folds a team subject into the leg's teams by itself.
6. **Market accept-lists come from the families** in `expand-gold.ts` (`@WIN`, `@MARGIN`, `@HCP`, …). Grading
   is containment in *either* direction, which cuts both ways: too narrow a list fails a good answer
   ("who wins" vs a gold that only lists "to win"), too broad a one passes a bad answer — which is why
   `@WIN` deliberately excludes a bare "winner" that "outright winner" and "toss winner" would satisfy, and
   why a margin row must never accept a phrase containing "to win".
7. **A price is never a market and never a leg.** Fractional odds normalise to decimal (`4/1` → 5.0,
   `even money` → 2.0).
8. **`line` vs range vs sort.** A rung to select is a number; a bound on which fixtures qualify is
   `{min?, max?}`; ranking fixtures by line size is `line_sort` (never `odds_sort`, which ranks price).
9. **Time is graded on presence, anchor, kickoff band and fixture-pick — not on the window's wording**, so
   the token stays readable (`w:this weekend`) instead of canonicalised.

## Refreshing

Fixtures age out. Re-run `npm run sweep` for current fixtures, then re-check any row naming a specific
match. Rows naming only a league or a player age much more slowly than rows naming a fixture.

```bash
npm run probe -- --file planning/corpus/gold.txt --until=extract --log=silent --out .sweep/gold-extract.jsonl
```

`--until=extract` is one LLM call per query and no Kambi/market call: ~$0.001/query, ~$0.30 for the gold half.
