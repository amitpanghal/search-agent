# Sprint 7 — Combined markets: grounder-owned recombination of split legs

> Context: `docs/architecture.md` (decision 20 grounding chain/tiers + per-side divert; decision 25 alias
> discipline). Builds on the Sprint 5 offer-registry (`offer-registry.json`, ever-offered ⇒ real) and the
> 2026-06-11 WC26 experiment, which isolated combined markets as a distinct residual miss.
> **This supersedes the original Sprint 7** (an outcome-family gate Stage-1 + a live-menu-driven Stage-2
> recombination) — both dropped; see STATUS 2026-06-11.

## The problem (plain English)

The extractor is catalog-blind by design and splits a top-level "X and Y" into **one selector per leg**
(prompt Step 3) — even when the user names a real combined market. So a combined catalog row like
`1001957106 "Home Team to Win and Both Teams To Score"` is **never reached**: the grounder only ever sees
"to win" and "both teams to score" separately. (Validated in the 36-query WC26 experiment — misses #3/#4.)

## The data

- **293** combined rows in the catalog (name joins outcomes with "and" / "&"), but only **5 are ever offered**
  (offer-registry): `1001957106`/`1001957108` (Home/Away Win + BTTS), `1002363220` (Draw + BTTS),
  `1001241014` (Exact Finishing Order), `1002731614` (Winner & Top Goalscorer). The other 288 are the
  off-season/legacy tail (Sprint 5).
- Two shapes: **compositional** (Win + BTTS — assembled from independently-named legs) and **atomic**
  (Exact Finishing Order — a single market that merely has "&" in its name; reached by ordinary leg
  grounding, needs no assembly).
- The registry cleanly separates the 5 live from the 288 dead — so the "is this combo real?" filter needs
  **no live-menu fetch** (the job the old design handed to the executor).

## The design — grounder-owned, additive, no extractor change, no live-layer dependency

After per-leg grounding, a **query-level post-pass** re-surfaces the combined market from the catalog:

1. **Eligible-combo set** — `src/resolver/combos.ts` `eligibleCombos()`: combined catalog rows ∩ ever-offered
   registry → the 5. Registry-filtered so the 288 legacy combos can't leak. Depends only on the catalog +
   registry (acyclic — no `ground-market` import).
2. **Combo index** — `ground-market.ts` `comboIndex()`: each eligible combo reduced to its **side-stripped
   core tokens** (`baseStatCore` → `contentTokens`) + its outcome ids. Per-side combos collapse to one entry
   holding the home/away **twin pair**, paired via the existing `perSideIndex` — no new side logic.
3. **Assembly** — `assembleCombos(legConcepts)`: pool the **content tokens of all leg concepts**; surface any
   eligible combo whose core is covered ≥ `LEX_COVER_FLOOR` (0.8 IDF cover — the existing near-full-cover
   bar). Gated to **≥2 legs**; a **negated leg** ("no draw") is dropped from the pool so it can't seed a
   positive combo. Per-side combos return their twin pair as `variants`.
4. **Query entry** — `groundPlan(legs, level)`: grounds each selector as today, then runs `assembleCombos`.
   `combos` is **additive** — per-selector grounding is byte-identical — so a caller sees the legs **and** the
   ready-made combined market (product decision: **augment, not replace**).

Side binding stays deferred: the twins are returned unbound, exactly like decision-20's per-side divert; the
executor confirms availability and binds the side against the live event. The grounder never invents a side.

## Why this works where the old design didn't

- **No re-embed, no concatenation, no leg power-set, cross-subject-safe** — pure token cover over ~5 rows
  (reusing the surviving IDF lexical channel). The old "re-ground a concatenated string" was rejected for
  exactly those costs.
- **Ships without the executor / live layer.** The registry supplies the "ever-offered" filter the live menu
  used to; the live menu becomes a final *availability* check, not the thing that *discovers* the combo.
- **Reaches combos the leg-driven live-menu design couldn't:** the cover test needs only the legs' **text
  tokens**, not that each leg independently grounds to a standalone criterion.

## Validation (offline; `scripts/combo-probe.ts` — no LLM, no Voyage)

Runs off the cached extractor plans. Over 50 multi-leg tier1 queries:
- Both real split combos surface: "home team to win with goals at both ends" → `{1001957106, 1001957108}`,
  "away side wins it but both find the net" → same — **cover 1.00**, best single leg **0.74** (< 0.8, so the
  combo genuinely needs both legs).
- **0** of the 288 legacy combos leak; **0** false positives (the lone negation case, "no draw and both teams
  get a goal", is suppressed by the negation guard).
- `npm run typecheck` clean; `npm run eval` ship gate **PASS 8/8** (per-selector path unchanged).

## Edge cases & limitations

- **Atomic combos** (Exact Finishing Order, Winner & Top Goalscorer) are reached by ordinary leg grounding,
  not this pass — no special handling needed.
- **Single-concept combos the extractor does NOT split** ("score draw" → one selector `correct score`) are
  out of scope here — a direct-grounding problem, not a split-combo one.
- **Negation beyond a leading "no/not/without"** is not modeled (token cover is polarity-blind); the
  leading-negation guard covers the one observed case.

## Out of scope / later

- **Eval-scorer grading of combos** — `scoreRun` still grades only the per-selector groundings; the combo is
  computed and threaded (`groundPlan.combos`) but not yet graded. Probe-first; grade once the pass is proven.
- **Executor live-menu confirmation + side binding** — when the executor / live layer lands.
- **Unit-named combo aliases** (scorecast/wincast) — they stay un-split; a cheap adjacent alias win
  (decision 25), independent of this pass.
