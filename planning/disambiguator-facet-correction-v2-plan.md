# Disambiguator facet-correction — level + near-synonym abstain (v2)

> **Status:** design proposal (show-and-ask). Follows
> [`disambiguator-facet-correction-plan.md`](./disambiguator-facet-correction-plan.md) (v1 = line + subject).
> Sequenced **after v1** (shares the resolver prompt). Builds on
> [`recall-resolve-plan.md`](./recall-resolve-plan.md).

## Goal

v1 gave the resolver power to **correct** the line/subject. v2 sharpens the resolver's **pick judgment**
so it stops two silent failures the audit surfaced:

- **Level** — a single-match query lands on a **tournament-aggregate** market (bare "corners over 10.5" →
  *Number of corners in the Tournament*, not match *Total Corners*).
- **Near-synonym / false friend** — the resolver **forces** a lexically-close but wrong market instead of
  picking the genuinely-closest candidate, or abstaining when none fits ("method of victory" → *Method of
  First Goal*; "race to 2 goals" → *Total Goals*).

**Key difference from v1:** these need **no new output shape**. The resolver already has `pick` (a
different candidate) and `clarify`. v2 is **prompt calibration + eval**, plus (for level) one small context
add and a complementary **data-tagging** lever tracked separately.

## The two v2 behaviours (worked examples)

| Query | Candidates the resolver sees | Resolver does | Why |
|---|---|---|---|
| **Level** "corners over 10.5 for Brazil's knockout games" | *Number of corners in the Tournament* (rank 1, aggregate), *Total Corners* (match) | **pick Total Corners** | single-match query → prefer per-match over aggregate |
| **Level (only aggregate)** same, but no match market offered | *…in the Tournament* only | **clarify** | the per-match line isn't offered — ask, don't mis-serve the aggregate |
| **Near-synonym (re-rank)** "method of victory — pens vs ET vs 90 min" | *Method of First Goal* (rank 1, false friend), *Way of Winning* (rank 2, true) | **pick Way of Winning** | re-judge the anchor on a clear semantic mismatch |
| **Near-synonym (abstain)** "race to 2 goals" | *Total Goals* (false friend), … none truly "race to X" | **clarify** | no genuine match exists — abstain, don't force |

## Design decisions

### 1. Level — name-based preference in the resolver + a level-context add
The grounder already hard-filters candidates by level **when the candidate is tagged** (recall-resolve §4).
The slip is **untagged aggregate markets** that pass the filter (recall-resolve §7). So the resolver lever
is **name-based**, not tag-based:
- Prompt rule: *for a single-match query, a market named "…in the Tournament / Competition / League" is the
  wrong level — prefer the per-match candidate; if only the aggregate is offered, clarify.* Sport-agnostic.
- The resolver must **know the query's level intent** (fixture vs competition). Add `level` to the
  resolver's per-call context ([`userMessage`](../src/resolver/disambiguate.ts:247)) — a tiny addition.
- **Complementary lever (separate, not this plan):** tag more aggregate markets with their level so the
  recall filter catches them upstream — the cleaner fix (recall-resolve §7). Tracked as a data task.

### 2. Near-synonym — calibrate anchor/override + abstain, no new output
The resolver already **anchors on the recall top pick and overrides on evidence** (recall-resolve Role 3).
v2 tunes two edges of that one judgment via the prompt:
- **Re-rank on clear mismatch:** when a lower candidate's name fits the intent clearly better than the
  anchor, pick it (Way of Winning over Method of First Goal). Reading names against intent — it already
  can; the calibration is "don't blindly keep rank 1 when it's a false friend."
- **Abstain when none fits:** when **no** candidate genuinely matches the asked concept, **clarify**
  instead of forcing the closest (race-to-2-goals → no "race to X" market → clarify). Re-express first
  (Pass 1), then clarify (Pass 2) — the existing flow; the calibration is the willingness to reach it.

### 3. The central tension — abstain-more vs over-clarify (must measure both)
Pushing the resolver to **catch false friends** pulls toward **more clarifying**; the deferred
**Pass-2 over-clarify** problem (recall-resolve §8 — asking when rank-1 was right) pulls the other way.
v2 is the calibration that balances them, so it is **eval-gated on both metrics moving the right way**:
- **false-friend-forced rate** (a wrong lexical pick where the truth was a candidate or none) — must drop.
- **over-clarify rate** (clarified when the gold was the rank-1 candidate) — must **not** rise.

## Code changes
- **[`disambiguator-prompt.md`](../src/resolver/disambiguator-prompt.md)** — add the level-preference rule
  and the abstain/re-rank calibration; sport-agnostic, mechanics-only examples. **Draft → show → finalise.**
- **[`disambiguate.ts`](../src/resolver/disambiguate.ts)** — add `level` to `userMessage` context. No
  schema/output change (uses existing `pick`/`clarify`).
- **No change** to plan-fetch / executor.
- **Separate data task** — level-tag coverage for aggregate markets (complements, not part of this plan).

## Eval
- New fixtures: level (prefer match; clarify when only aggregate), near-synonym (re-rank to the true
  candidate; abstain on no-fit). Replay through the orchestrator (captured `decide()`, no Haiku).
- **Two tracked metrics** (live probe `probe-disambig.ts`): false-friend-forced ↓ **and** over-clarify
  flat/↓. v2 does not ship if over-clarify regresses.
- Regression: the v1 cases + clean picks unchanged. 1× ship gate (skip 5× unless asked).

## Risks
- **Calibration is the whole ballgame** — too aggressive → over-clarify; too soft → false friends persist.
  Gate on both metrics, tune on real payloads (the probe), not in the abstract.
- **Level without tags** — the name-based rule only catches aggregates whose names say "Tournament/…";
  oddly-named aggregates still need the data-tagging lever. State the resolver's reach honestly.

## Build order
1. Add `level` context to `userMessage`.
2. Prompt: level-preference + near-synonym calibration — **draft, show, finalise**.
3. Fixtures + replay; wire the two metrics into the live probe.
4. Tune against the probe until false-friend ↓ and over-clarify flat.
5. (Parallel, separate owner) level-tag the aggregate markets.
