# Sprint 7 — Outcome-family gate: a same-level meaning-tightness cut so the executor's live-menu collapse is safe

> Full design context: `docs/architecture.md` (**proposed decision 28** is this sprint; supporting:
> decision 20 grounding chain/tiers + subject pre-filter, **decision 23** level-awareness + "scope
> enforcement deferred to the executor / re-ground within the offered betoffer menu" — that is Stage 2 here,
> decision 25 alias discipline; eval **E5** precision-bias/abstain, **E13** containment + tier). Builds on
> the Sprint 5 offer-registry ([sprint-5.md](sprint-5.md); ceiling 194/2486 ever-offered → Stage 2 must be a
> per-competition LIVE fetch, not a cached registry). Designed via a full grill (Q1–Q7), 2026-06-09.

## The problem (plain English)

The grounder compares a query's `market_concept` against all ~2486 markets and keeps the single closest by
meaning. To the embedding, **win** and **qualify** look similar, so **"to win the world cup"** grounds to a
**qualify** market instead of the **winner** market. The user's catalog is also full of near-synonyms, which
makes any single nearest-neighbour pick fragile.

The intended cure is two stages doing **two different jobs**:

1. **Stage 1 — the family gate (this sprint; grounder; offline; uses only the complete catalog).** Make the
   returned candidate group *tight*: it should contain only markets of the **same outcome-type** as the query,
   so "win the title" neighbours are `{Winner, To Win The Trophy, Tournament Winner…}` and **never**
   `To qualify from Group Stage`.
2. **Stage 2 — the live-menu collapse (executor; per query; already decision 23's deferred direction).**
   Intersect that tight group against the **one competition's live betoffer menu** and keep only what's
   actually offered → collapses near-synonyms to the single instantiated spelling.

### Why Stage 1 is required — the data finding (WC group 2010133908)

Validated on the real World Cup menu: `To Win The Trophy` (1001159600) IS offered (9 comp-events), and the
canonical `Winner` (1001221607) is **not offered at all** in the WC. **But** `To qualify from Group Stage`
(1001241028), `To reach the Final/Semi/Quarter` (1001232823 / 1001241010 / 1001370411) are **also live — at
48 comp-events each, more than the 9 of the winner market.** So:

- **Stage 2 alone cannot fix it** — a demoted/leaked qualify market is genuinely on sale, so live-presence
  can't reject it. A *soft* family penalty fails for the same reason: it leaves qualify in the `ambiguous`
  tie-set, which Stage 2 then can't collapse. **The wrong family must be REMOVED upstream, not demoted.**
- **Stage 1 alone cannot fix it** — inside the winner family, `Winner` vs `To Win The Trophy` vs
  `Winner – Including Play Offs` are separated only by which spelling the competition sells (Stage 2's job).

So: **Stage 1 separates win from qualify (tightness); Stage 2 separates the winner-spellings (live presence).
Different jobs, both required.** Stage 2's incompleteness (Sprint 5: only 194/2486 ever-cached) is a non-issue
because it fetches the *one* competition on demand.

## The design (the settled grill, Q1–Q7)

**Q1 — what a family is.** A `family` is the **outcome-type** axis, defined by substitutability: two markets
are the same family iff a user who asked for one would accept the other *when it's the one the competition
offers* (Stage 2's job); different families iff one would be a *wrong answer*. It is **orthogonal** to the
period / subject / side / scope facets the grounder already models — **period is NOT a family** (`periodOf`,
`PERIOD_PENALTY`, period-collapse already own it; folding it in would explode `15 × 4 × 2 × 3` labels and
duplicate that code). Identity = `family × period × subject × side × scope`, independent facets. Tag coarsely
(~12–15 outcome-types) but **activate the gate first ONLY on the competition-outcome cluster** where the bug
lives: `win-title`, `reach-stage`, `qualify-group`, `finish-position`, `score-most/top-scorer`, `award`.
Everything else stays **uncommitted** (gate inert) — fixture-stat markets already have line→boType / period /
stat-core and aren't what's broken.

**Q2 — hard gate, conditional.** Drop a candidate **iff `queryFamily` is committed AND `candidate.family` is
committed AND they differ.** Uncertain on either side → **keep** (leak), same shape as the subject bucket
(hard when sure, both-buckets for a bare `event`) and the soft boType gate's empty-boType leak. Hard (not
soft) because Stage 2 can't reject a live wrong-family market, and a soft penalty leaves it in the tie-set.
Conditional (not blanket) so a missing/ambiguous tag never deletes a true market (the KE-5 lesson).

**Q3 — query family is derived in the grounder** from `market_concept` by the **same shared tagger** that
labels the catalog (agreement by construction — the load-bearing property for a hard cut). The **extractor
stays untouched / sport-agnostic** (no family enum in the prompt; families are betting vocabulary). The
shared tagger must be runnable on both a catalog name and a query string → it is **lexical**. An offline
LLM-tail label (Q4) that can't be reproduced per-query simply **stays uncommitted on the query side → never
gates** — consistent with Q2.

**Q4 — precise, precision-biased lexical rules.** The tagger commits a family **only when keywords are
unambiguous, else returns `uncertain`** (uncertain is always safe → today's behaviour). Evidence it must be
precise, not naive: "win/winner" in the team bucket spans win-title (`To Win The Trophy`), win-a-match
(`Home Team to Win to Nil`, `…Win Both Halves`), counts (`Number of Trophies Won`), group/specials
(`Group to feature Tournament Winner`) and intervals — a naive `contains "winner"` rule would mis-tag ~20
rows, and a hard gate would then **delete** them. Tag at **build time in `build-catalog.ts`**, next to the
existing `subject`/`side` tags; add `family` to the `Criterion` type. Validate by **eyeballing a no-LLM
listing** of what each family captures (the committed cluster is small). The LLM pass is a **deferred offline
AUDITOR only** (diff vs lexical labels, cached to disk, never re-run, **never drives the gate**) — used when
we widen beyond the clean-keyword families. (The subject bucket already removes the `Golden X Winner` player
awards before family runs, so the tagger only disambiguates *within* one bucket.)

**Q5 — per-selector, combos stay uncertain.** The extractor decomposes a combo into **one selector per
market** (schema `selectors[]`, prompt Step 3: "each thing the user asks for becomes one selector"), and
`groundMarket` runs per-selector — so the gate is applied **subject-wise (per-selector)**, the same
granularity as the subject bucket. There is no whole-query family. Query-side combos therefore need **no**
family handling (already split into single-family legs). Catalog-side single-row combos
(`Exact combination of Winner & Top Goalscorer`) and ambiguous singles (`To win Group`) → **`uncertain`**:
never dropped, never used to drop, and demoted by the existing specificity penalty (~0.15, 5× `EPSILON`) so
they can't beat a clean answer. **No family-SET machinery now.** (A genuine `&`-combo MAY earn a complete
family set later — and only then, because the conjunction makes the set complete by construction — *if* data
shows a combo out-ranking the true single-family answer. Ambiguous singles never get a set.)

**Q6 — the slot: filter at pool construction.** Apply the family filter right after the subject bucket,
**before** either channel reads the pool:
`pool = idx.bySubject[bucket].filter(e => keepByFamily(queryFamily, e.family))`.
Both `allScored` (cosine) and `nominees` (BM25 recall) derive from `pool`, so **one filter covers both** and a
BM25 nominee **cannot dodge the hard cut** — e.g. query "to win the group" must not let BM25 resurrect
`To qualify from Group Stage` on the shared token "group". The gate enforces an invariant on the group handed
to Stage 2, so it belongs upstream of all channels, not bolted onto cosine. `keepByFamily` is the Q2 rule.

**Q7 — validation, cheapest first.**
1. **No-LLM WC-oracle collapse check, run BEFORE building (validate-early):** family-tag the 69 competition-
   level WC markets, group by family, confirm each committed family **collapses to a single live member**
   under the menu (win-title→`To Win The Trophy`, qualify→`To qualify from Group Stage`, top-scorer→
   `…most goals in the Competition`). Pre-flags the only hard spot: **reach-stage has 3 live members
   separated by *stage*, not family** — handled by the existing `stage`/specificity machinery, not the gate.
2. **Catalog-sweep round-trip (existing, no-LLM, all 2486) = the regression guard.** Same-string queries →
   symmetric tagger → **0 self-drops**; any lost round-trip = a tagger-asymmetry bug, caught automatically.
   The **paraphrase batch** is the asymmetry stress (paraphrase may derive a different family).
3. **Ship gate (g001–g003) + 32-case grounding snapshot = release guard** (1× per standing policy).

## Worked example — "to win the world cup", end to end

- Stage 1: query family `win-title`. Pool filtered to win-title (within team bucket) → `To qualify from Group
  Stage`, `To reach the Final/Semi/Quarter` are **removed before scoring**. Group = `{Winner, To Win The
  Trophy, Winner – Including Play Offs, …}`.
- Stage 2: WC live menu → only `To Win The Trophy` (1001159600) is offered → **collapse → answer.**
- Contrast that proves the scope is right: **`Mexico to win`** (fixture) → the decision-23 `to win`→Match Odds
  alias fires, gate silent; **`to win the world cup`** (competition) → alias doesn't fire → vector → gate
  drops qualify. Same verb, gate fires only where the embedding actually melts.

## Not this sprint (deferred / out of scope)

- **Combined-market reachability** — investigated 2026-06-09; written up as a **Stage-2 sub-feature** (the
  section below). Not in this sprint's family-gate scope; gated on Stage 2.
- **Family-SETS for explicit `&`-combos** — only if validation shows a combo mis-grounding (Q5).
- **Widening the gate** beyond the competition-outcome cluster to fixture-stat families — after the first
  slice is proven (Q1).
- **The offline LLM auditor** — only when widening makes the committed cluster too big to eyeball (Q4).

## Stage-2 sub-feature — combined-market recombination (deferred; gated on Stage 2)

**The gap (investigated 2026-06-09).** The extractor is catalog-blind by design, so a top-level "X and Y" is
split into one selector per leg (prompt Step 3) — **even when the user types a verbatim combined-market name.**
Probes: "Home Team to Win and Both Teams To Score" → 2 selectors (`Home Team to win` + `BTTS`), the combined
row `1001957106` never reached; "draw and both teams to score" → 2 selectors, the real `1002363220` sitting at
cosine 0.372, outranked by the split. Unit-named combos with no conjunction stay together ("scorecast" → 1
selector → Scorecast rows). **Size:** 306/2486 combined rows in the catalog, but only **~4–6 ever live** (WC:
`Home/Away Team to Win and BTTS`, `Draw and BTTS`, `Exact Combination of Winner & Top Goalscorer`); the other
~300 are the off-season/legacy player/team-special tail (Sprint 5). So it is **not an extractor bug** — it's
the architectural cost of a sport-agnostic extractor, and any fix lives **downstream**.

**Product decision: augment, not replace** — return all three (`to win`, `BTTS`, **and** the combined market),
so the user sees the individual legs *and* the ready-made correlated market.

**Design: live-menu-driven recombination (NOT re-grounded concatenation).** Re-joining the legs' concepts and
re-embedding the string is rejected — lossy + a second paid embed, a leg-subset explosion (which legs to
concatenate?), and a cross-subject bucket problem (player+team combos like `To score & player's team to win`).
Instead:

- **Build time — a combo index (no LLM for the clean rows):** parse each combined row's name on "and / &" into
  its component outcomes, recording each component's standalone criterion/family.
  e.g. `1001957106 "Home Team to Win and Both Teams To Score"` → `[ win(home-side), BTTS(1001642858) ]`.
- **Runtime — drive from the LIVE combos, not the leg power-set.** After per-selector grounding, in the
  executor (post Stage-2 fetch), for **each combined market in the live menu** check: are *all* its components
  present among the query's grounded legs? If yes, surface it. O(live-combos × legs) (~4–6 combos), no
  re-embedding, no subset search; it answers "which selectors to combine?" for free, and the live-menu filter
  keeps the ~300 legacy combo rows out.

**Side-binding rides the existing per-side divert — no new side logic.** A per-side combined market is emitted
as its home/away **twin pair** (`{1001957106, 1001957108}`), unbound, exactly like decision-20's per-side
divert ("return the twins as `variants`; the executor filters against the live betoffer response"). The
executor binds it from the **live event** (`OFFERING_API.md`: Event `homeName`/`awayName`,
`EventParticipant.home`) in the **same** pass that binds the win leg. Worked example — fixture **USA vs
Mexico**, query "Mexico to win and BTTS": the event says Mexico = away → pick `1001957108 "Away Team to Win and
Both Teams To Score"`; return `{ Mexico to win, BTTS, Away…Win and BTTS }`. Side-null combos (`Draw and BTTS`
1002363220, `Either team to win and BTTS` 2100111422) are returned directly. **No fixture in scope → no
home/away → return both twins** and narrow when the fixture is known (today's per-side fallback). The grounder
never invents a side.

**Open details / dependencies.** (1) Component matching is by **criterion id** for clean parts (BTTS) and by
**family/concept** for per-side parts (the win leg grounds to Match Odds, not "Home Team to Win") — so it leans
on this sprint's family notion. (2) A cheap adjacent win, independent of all this: **unit-named combo aliases**
(scorecast/wincast) since they stay un-split (decision-25 alias discipline). (3) Gated on the **Stage-2 live
fetch + competition/fixture entity resolution** (`catalog.ts`: groups not loaded yet) — ships with Stage 2.

## Open dependency

Stage 2 needs to resolve the query's competition → a Kambi group/event id to fetch the live menu;
`catalog.ts` notes groups/competitions aren't loaded yet (Sprint 2 scope). Stage 1 (this sprint) ships
independently — it tightens the group regardless; Stage 2 consumes it when the entity resolver lands.
