# Sprint 4 — Self-improving test loop: Tier-1 catalog grounding sweep (+ Tier-2 behavior corpus)

> Full design context: `docs/architecture.md` (**decision 25** is this sprint; supporting: eval **E1–E13**,
> esp. E7 behavior tags, E8 neutral grader, E12 ship gate, E13 containment; decision 16 bounded prompt,
> decision 20 tiers, decision 23 result-family aliases). Builds on Sprint 3 ([sprint-3.md](sprint-3.md)).
> Progress in [STATUS.md](STATUS.md). Embedding model unchanged: Voyage `voyage-3`.

## End goal (plain English)

Rigorously test the two built stages (extractor + market grounder) and make the test *self-improving*:
generate broad queries, list shortcomings in plain English, fix at the right layer, retest. Split into
**two tiers** so each is graded by an honest, independent answer-key (E8):

- **Tier 1 — catalog breadth (grounding, cheap, no LLM).** Round-trip every groundable criterion: feed a
  concept *built from* a known criterion and assert it grounds back to that id. Key = the catalog row, not
  the grounder → E8-clean and automatic. Near-exhaustive over the 2486 kept criterions; the misses are the
  shortcomings list. **This is "maximum coverage of our catalog."**
- **Tier 2 — reasoning (extraction, expensive, human-labeled).** A *big* model proposes messy/casual
  queries; a **human** labels via neutral search; behavior tags stay the gated spine, the 10 query shapes a
  tracked diversity axis.

**First iteration = Tier 1 only** — cheapest, delivers the catalog-coverage headline, zero LLM, and every
failure is by definition a grounding miss (no extraction-vs-grounding attribution needed yet).

## Worked example — Tier-1 round-trip

Criterion `1001642858` "Both Teams to Score" (player-agnostic / `event` bucket):
- **Verbatim floor:** feed `"both teams to score"` → expect `1001642858` ∈ ids, tier `confident|variants`.
  Cheap, deterministic; catches index gaps / quarantine errors / catastrophic collisions.
- **Paraphrase (vector tail):** feed `"will both sides find the net"` → still expect `1001642858`. Tests the
  voyage-3 layer — the one that regresses (Winner v1, stoppage v2). Label is by-construction (a paraphrase
  *of* `1001642858`), so it stays E8-clean.

A criterion that **doesn't** round-trip (grounds to nothing / wrong bucket / a wrong id / an `ambiguous` tie
that isn't a real variant set) is a **shortcoming** — reported with a suggested fix-target.

## Scope (confirmed with user)

- **Tier 1 (this iteration):** a catalog round-trip sweep over the **2486 groundable** criterions (verbatim
  floor + a focused paraphrase batch over head markets), a **plain-English shortcomings report** (an example
  + suggested fix-target per item), and **one disciplined fix-round**, then retest.
- **Market grounder only.** No entity/competition/attrFilter grounding (text-graded; a build task).
- **Filters = capture + pin live.** odds/time/stage tested as extractor *capture* only; **live/in-play
  pinned** as a tracked abstain case (no executor/live layer — decisions 9, 22).
- **Tier 2 (next iteration, gated):** behavior×shape corpus toward ≥5/tag for the 10 uncovered tags, a locked
  held-out slice, the big-model→human authoring flow, and the semi-auto loop automation. **Not built until
  Tier 1 proves the loop.**

## End-state demo (Tier 1)
`npx tsx scripts/catalog-sweep.ts` (extends `ground-snapshot.ts`) →
`Catalog round-trip: 2xxx/2486 clean (yy%) | ceilings: 3627 absent, 2437 quarantined (0 leaks)` then a
grouped shortcomings list, e.g.
`✗ "win to nil" (team) → none (below 0.55). GROUNDING / disjoint → propose alias (bridges a gap vectors
can't). Example: the catalog name "Win to Nil" shares no words with that phrasing.`

## Approach (staged; Tier 1 only this iteration)

### Stage A — the catalog round-trip sweep (no LLM, extends ground-snapshot.ts)
1. **Enumerate** the kept criterions from `catalog.ts` (`bySubject` → per-criterion subjectKind: `player →
   player`; `team_or_match → event` for the agnostic bucket). Reuse `ground-snapshot.ts`'s dotenv loader +
   `groundMarket` wiring; reuse the scorer's `idsContainGold` (E13) — **no new harness, no duplicated logic.**
2. **Verbatim floor:** for every kept criterion, feed a user-style concept derived from its name (strip the
   subject prefix, e.g. "Player Shots on Target" → "shots on target") and assert it grounds back (contained +
   clean tier). Classify each: `clean` | `none/below` | `wrong-bucket` | `wrong-id` | `ambiguous`.
   Distinguish a **real variant set** (siblings sharing a stat-core — a pass) from a wrong `ambiguous`
   (distinct cores — a miss).
3. **Paraphrase batch (head markets):** for a focused head set (each category's top markets, a few hundred),
   add 1 mild paraphrase. Source = a **big** model (Opus), proposing `{criterionId, paraphrase}`; a human
   **spot-checks a sample** for drift before acceptance (keeps the by-construction label honest). Same
   round-trip assertion. *(Full 2486-paraphrase generation deferred — head-only keeps turn 1 cheap.)*
4. **Report (plain English + example each).** Headline `clean/2486`; the **ceilings** (3627 absent = a
   data-feed gap, not a bug; 2437 quarantined → assert **0 leak** into results); then shortcomings grouped by
   failure mode, each with the criterion, what it grounded to, and a **routed fix-target**
   (alias-if-disjoint / recalibrate-off-distribution / fix-data / tier-logic).

### Stage B — one disciplined fix-round + retest
5. Human reviews; applies only **routed** fixes (alias *only* for a lexically-disjoint gap; else
   data/calibration). **Track alias-table growth** — a guard metric printed each run. Recalibrate threshold/ε
   off the **sweep's score distribution**, never a single seed (E8).
6. **Retest:** re-run; the verbatim floor doubles as the regression guard (like `ground-snapshot diff`).
   Confirm net coverage up, **0 regressions**, alias count grew minimally.

## Key design decisions / consequences
- **By-construction labels dodge the E8 circularity** — the Tier-1 key is the catalog row the query was built
  from; the grounder never writes its own answer key.
- **Verbatim = floor, paraphrase = the real test.** Verbatim mostly exercises the alias/exact-name head; the
  paraphrase batch proves the vector tail. Reporting them apart is also the overfitting tell (floor-green +
  paraphrase-red = a hand-fit head).
- **Alias discipline is a hard rule (decision 25)** — alias only to bridge a disjoint gap vectors can't,
  never to patch a tuning miss; alias growth is a tracked smell.
- **Tier-1 needs no held-out** — keys are by-construction, nothing to memorize. (Held-out is a Tier-2 device.)
- **Every Tier-1 failure is a grounding miss** (no extraction in the loop) → no attribution machinery for
  turn 1.

## Critical files
- **Add:** `scripts/catalog-sweep.ts` (the round-trip sweep + report; borrows `ground-snapshot.ts`'s shape).
- **Reuse (no change):** `src/resolver/ground-market.ts` (`groundMarket`, `GroundResult.tier`),
  `src/resolver/catalog.ts` (`bySubject`, `byId`, version), `src/eval/structural-scorer.ts` (`idsContainGold`),
  `src/resolver/index/criterion-vectors.voyage-3.json`.
- **Possibly touch (fix-round only, routed):** `data/football/aliases.json` (only a disjoint-gap entry),
  grounding knobs in `ground-market.ts` (threshold/ε, calibrated off the distribution).

## Verification
1. `npx tsx scripts/catalog-sweep.ts` runs (Voyage key only for any new paraphrase embeds), prints the
   coverage headline + ceilings + grouped shortcomings, and asserts **0 quarantine leaks**.
2. The report reads in plain English with a worked example per shortcoming (house style, user-required).
3. After the fix-round: coverage up, **0 regressions** on the verbatim floor, alias-table growth minimal.
4. `npm run typecheck` clean; existing `npm run eval` (g001–g003, gf01–gf05) still **ship-gate PASS** (the
   sweep is additive — no change to the gold path unless a routed fix also helps a seed).

## Out of scope (explicit)
Tier 2 (behavior×shape corpus, held-out, big-model→human authoring, loop automation) — gated on Tier 1.
Entity/competition/attrFilter grounding; the executor + live layer; the live schema axis (pinned, not built);
fixture/price *resolution* of time/odds; fully autonomous patching. The three grounding knobs stay calibrated
**off the sweep distribution**, not hand-fit.
