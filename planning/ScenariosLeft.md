# Scenarios Left (intentionally deferred)

Things we have seen come up but are **intentionally out of scope for now**. They are noted here so they
aren't lost — each will be addressed later.

## 1. Result-across-stages query split into two separate bets (e.g. HT/FT)

A single **result-across-stages** selection — a verdict at half time *and* at full time, e.g.
"half time draw then Australia to win" — should resolve to **one** Half Time/Full Time market
(outcome "Draw / Australia"). But the extractor sometimes **splits it into two selectors**: a
half-time result leg ("half time draw") and a separate winner leg ("Australia to win"). The query
then returns the **two component markets** (Half Time Result + Full Time/Match Result) instead of the
combined HT/FT — and the half-time leg often isn't even narrowed to the draw (no line on that selector).

Why it can't be recovered downstream today:

- **Disambiguator is per-cell.** It picks/re-expresses/clarifies each cell independently; it cannot
  **re-merge** two selectors into one. Cross-cell merging needs multi-unit, which is deferred.
- **Combo-assembly only catches "A and B" combos.** Grounding's `assembleCombos`
  ([`ground-market.ts`](../src/resolver/ground-market.ts)) surfaces a combined market only when its
  catalog **name** joins outcomes with "and"/"&" ("Home Team to Win **and** BTTS"), matched by lexical
  token-cover. **HT/FT is named by its STAGES** ("Half Time/Full Time"), not its results, so it is never
  in the eligible-combo set, and the split legs ("…draw", "…win") share no tokens with the market name —
  the cover never fires. The combo pass is structurally blind to a sequential, stage-named combined market.

- **Later:** either (a) get the extractor to recognize the result-across-stages construction and emit a
  **single** HT/FT selector (it already does when both stages are explicitly marked — "…then X to win
  **at full time**" — but not when the second stage is only implied), or (b) add a **semantic** combo
  signal (not lexical token-cover) that maps "a result at one stage + a result at a later stage" onto the
  stage-named combined market. Both are the same recognition problem, just in different layers.

## 2. Extractor drops a market qualifier / team-binding on a complex multi-leg query

The extractor (Haiku, temp 0) keeps a market's qualifying words on simple/medium queries but **drops
them on long, multi-constraint queries** (several selectors + combo + odds bounds). Two instances seen
(verified 2026-06-19):

- **Bet-type qualifier dropped (Draw No Bet).** "USA to win **on draw no bet**" *in isolation* keeps
  `market_concept: "to win on draw no bet"` → grounds **confidently to Draw No Bet** (cos 0.554)
  end-to-end. But inside the complex query "Antonee Robinson to be booked **and** USA to win on draw no
  bet — combo, combined odds > 2.5", the win leg flattens to `market_concept: "to win"` → grounds to
  **Full Time (1X2)**, the wrong market.
- **Perspective team not bound (HT/FT).** "Australia level at half, USA to win full time" → the
  extractor emits the right value `selection: "draw/win"` but leaves `subject: event` (it never binds
  the directional team, USA). The executor then shows all three "Draw / *" picks instead of just
  **Draw / USA**. (Distinct from #1: here it is ONE selector, just unbound — not a split.)

Why it can't be recovered downstream today:

- **The grounder & lexicon are already correct.** When the phrase survives, "Draw No Bet" resolves
  confidently; when the subject team is set, the executor binds full-time to that side. The loss happens
  at extraction, upstream of both.
- **No fact left to recover from.** Once "draw no bet" is gone the plan only says "to win"; once
  `subject: event` is set the plan never says whose win it is. Nothing downstream sees the original query,
  so the dropped intent can't be re-derived.
- **A prompt rule rewrite didn't help (tried 2026-06-19).** The rule "keep the user's own market words"
  is correct and is followed in isolation; adding a clause to bind the directional HT/FT team left
  `subject: event` unchanged. The failure is model adherence under load, not a missing/wrong rule — so a
  strip-list / clause edit risks regressing the simple case for no gain on the hard one.

- **Later:** bump the extractor model **Haiku → Sonnet** for complex queries (one-line model-constant
  swap in [`extract.ts`](../src/resolver/extract.ts)) and **measure** on the combo / HT/FT variants
  before committing. Both candidate fixes looked right on paper but failed against real data, so validate
  first. (Mirrored in memory: `project_extractor_flattens_complex_queries`.)
