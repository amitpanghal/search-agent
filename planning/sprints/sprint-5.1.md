# Sprint 5.1 — Facet soft-demote (period-led) for the shallow grounding band: feed the penalties from the LLM and fix the shortlist ordering so they reach the top-3

> Design context: decision 20 grounding chain (subject pre-filter → cosine + IDF-lexical cover → soft
> line→boType / period / specificity / scope penalties → tier; the recall-floor `shortlist`). Builds on the
> already-deployed `periodOf`/`PERIOD_PENALTY` (period facet) and decision-23 `scopeOf`/`SCOPE_PENALTY` (scope
> facet, fed by `event_scope.level`). Partner to **Sprint 6** (doc-views — the near-synonym tail) and **Sprint
> 7** (outcome-family gate + Stage-2 combined-market recombination): this sprint is the **facet** lever, those
> are the **vocabulary / family / combined** levers — different misses (see the data finding). Root-caused +
> offline-validated 2026-06-10 on the 273 reachable misses (`tightening/shallow_candidates.md`,
> `tightening/deep_candidates.md`).

## The problem (plain English)

A paraphrased query carries a period/side the grounder should honour — "exact scoreline **at the break**" means
first half, "**the visitors** to score" means the away side. Two facts conspire so the grounder ignores it:

1. **The casual words reach the grounder verbatim.** The extractor LLM *does* understand the facet (a reasoning
   probe on "exact scoreline at the break" knew "at the break" = first half), but a prompt rule — *"do not
   paraphrase slang… keep the query's own term; the per-sport lexicon maps it downstream"*
   (`extractor-prompt.md:187`) — makes it pass "at the break" through as text. The grounder then re-infers the
   period from that text with the brittle `periodOf` regex (`ground-market.ts:190`).
2. **Even when the penalty fires, it never reaches the top-3.** `PERIOD_PENALTY`/`SCOPE_PENALTY`/specificity all
   live on `adj` (`ground-market.ts:460`), which orders **survivors**. But the misses we care about are
   sub-threshold (cosine ~0.4–0.5 < the 0.55 confident bar) → they go down the **`shortlist`** path, and that
   path orders the lexical-"strong" group **by BM25, not `adj`** (`ground-market.ts:494`). So a
   facet-mismatched-but-lexically-strong candidate leads the clarify set and the facet-matched gold never
   surfaces. This is why the already-deployed `periodOf` idiom-expansion recovered only **1/26** period misses.

The fix is three small moves: (a) **feed** the facets from the LLM instead of the regex, (b) add the **missing
side** penalty (validate-first — see below), and (c) **fix the shortlist ordering** so the penalties actually
reach the top-3 — the piece that made the earlier period fix inert. Keep `market_concept` **rich** (validated
below: stripping it craters recall). **Demote, don't drop** — touch `adj` only, never `raw`/`THRESHOLD`, so
**0 golds drop** by construction (the existing fail-safe envelope).

## The data finding (the 273 reachable misses, 2026-06-10)

A miss is *reachable* if the gold market sits in its subject bucket but below the live top-8 pool cut. 273 of
the 355-query probe are reachable. Tagged by cause:

**Shallow band — gold at rank 9–32 (132 queries):**

| reason | n | lever |
| --- | --- | --- |
| Near-synonym crowding (most/total, conceded/won, win/qualify, first/next) | 29 | Sprint 6 doc-views / Sprint 7 family gate — *not this sprint* |
| **Different PERIOD on top** (full vs 1st-half/extra-time) | 26 | **this sprint (period facet)** |
| Gold name literally matches, cosine buried it, BM25 missed it | 18 | the BM25 recall channel (depth / cover floor) — *not this sprint* |
| Combined market (extractor split the legs) | 15 | Sprint 7 Stage-2 recombination — *not this sprint* |
| Vocabulary gap (concept words ≠ gold name) | 7 | lexicon alias / extractor normalization — *not this sprint* |
| **Different SIDE on top** (home vs away vs match-total) | 6 | **this sprint (side facet) — validate-first** |

**Deep band — gold at rank 33+ (141 queries):** vocabulary gap 36, combined 32, near-synonym 19, BM25-recall
13, side 4, period 4 — i.e. **only 8/141 are facet misses.** A small reorder cannot reach rank 33+; the deep
band needs the *other* levers. **This sprint deliberately targets the shallow band only.**

**Honest scope.** Period + side are **32/132 ≈ 24%** of the shallow band by cause-tag. The validated
soft-demote lifts the *whole* shallow band's recall@3 **25→33% (.05) / 37% (.08)** and recall@10 **54→68%** —
more than the 32 facet rows, because reordering by a correct period/side also breaks some adjacent
near-synonym/recall ties — but **it does not solve the shallow band**; ~⅔ remains, owned by doc-views (Sprint
6) and the family gate (Sprint 7). This sprint's claim is scoped to the **period-led facet slice**, not "the
shallow band."

**Validation arms run offline this session:**

- **LLM facets from words alone ≈ 90% accurate** (side near-perfect; period ~1 miss/30; scope/shape good) — so
  feeding facets from the LLM is sound.
- **Rejected** — strip qualifiers to a clean stat + **hard** filter: recall@3 **73→40%** (the qualifier words
  carry embedding signal; the hard filter also dropped 2/30 golds). → keep `market_concept` rich; demote, don't
  filter.
- **Winning** — keep rich `market_concept`, add facets as a **soft demote** on the cosine pool: shallow
  recall@3 **25→33–37%**, recall@10 **54→68%**, **0 golds dropped**; deep **+2 only**; combined recall@10
  **26→33%**.

## The design (for the build — no code this pass)

**Thesis:** the grounder already models period & scope as soft penalties; this sprint feeds them from the LLM,
adds side, and — the load-bearing piece — makes the penalty participate in the **shortlist** ordering it
currently bypasses. Keep `market_concept` rich. Demote-don't-drop (`adj` only).

### Steps

1. **Schema** — `src/resolver/schema.ts:55` `Selector`: add optional normalized facets `period?:
   enum(full|first_half|second_half|extra_time)`, `side?: enum(match|home|away|each)`. Scope is already deployed
   (`scopeOf` + `SCOPE_PENALTY`, fed by `event_scope.level`, `schema.ts:84`) — reuse it; richer scope
   (matchday/season) is a stretch goal. Player-side is implicit from `subject.kind === "player"`. Mirror the two
   optional fields into the eval's `gold-record.ts` `GoldSelector` (kept in lock-step with `Selector` by the
   schema-header contract) so a gold record may *optionally* assert a facet for the accuracy harness; absent =
   unconstrained.
   *Worked example:* "scoreline at the break" → `{ market_concept: "exact scoreline at the break", period:
   "first_half" }`.
2. **Extractor prompt** — `src/resolver/extractor-prompt.md`: add **sport-agnostic** rules to emit period/side
   as general concepts ("which match-period the query refers to"; "whose stat — host/home, visitor/away,
   both/each, or the match total"). **No idiom lists in the rules** (honours
   `feedback_sport_agnostic_prompt`; the football idioms stay in `periodOf`/the lexicon). **Keep
   `market_concept` rich.** Likely **no `extract.ts` change** — `INPUT_SCHEMA` auto-derives from the zod schema
   (`extract.ts:26`), verified.
3. **Thread facets** — `GroundOpts` (`ground-market.ts:67`) gains `period?`, `side?`. Pass `sel.period`/
   `sel.side` at **both** live call sites: `src/eval/run.ts:87` and the **acceptance-gate probe**
   `scripts/extractor-ground-probe.ts:122`. (`scripts/ground-snapshot.ts` grounds from a static case table with
   no per-query facet — its optional opts fall back to `periodOf`, so it needs no change unless we add facet
   columns to exercise them.)
4. **Grounder demote** — `ground-market.ts`: query period = `opts.period ?? periodOf(text)` (LLM first, regex
   fallback); same shape for scope. Fold a `SIDE_PENALTY` const alongside `PERIOD_PENALTY`/`SCOPE_PENALTY`/
   `specificityPenalty` on the `adj` line (`ground-market.ts:460`). Keep the period-collapse. **Gate the SIDE
   arm on the validate-first check below** before adding the const.
5. **Shortlist ordering (load-bearing)** — `ground-market.ts:494`: make the facet-adjusted score participate so
   a facet-**matched** gold isn't buried under lexically-strong facet-**mismatches** — gate the "strong"-group
   lead on facet-match, or fold the facet penalty into the strong/weak sort. This is the move that converts the
   penalty from inert-in-`adj` (the 1/26 result) to effective; it is the lever the validation depended on.
   **Regression-prone** — the strong-by-BM25 ordering exists to keep the "to score first" family leading its own
   shortlist (`ground-market.ts:488`) — so it's guarded by the catalog-sweep round-trip + the full probe.

### The SIDE arm is validate-first, not a co-equal pillar

Side is **6 shallow + 4 deep = 10/273** misses, and the existing `Criterion.side` build-catalog tag is non-null
**only** for explicit "by Home/Away Team" per-side twins (`build-catalog.ts:54`). So a `SIDE_PENALTY` keyed on
that tag demotes a *wrong-side twin* but cannot promote a side-specific gold above the side-**neutral** false
friends that actually outrank it ("the visitors to score" → gold "Away Team To Score" is buried under "Correct
Score"/"Winner"/"To Score", all `side=null` → unpenalised). Named-team side is **already** handled by the
per-side divert; player-side is implicit. **So before building the SIDE penalty, run a no-LLM check that it
recovers ≥3 of the 10 side misses; if it doesn't, ship period-only and leave side to the doc-views/divert
levers.** Period is the real payload of this sprint.

## Validation / acceptance (the go/no-go, documented)

- **Re-baseline first.** STATUS records the doc-views-OFF extractor-in-loop baseline as **54/355** (the plan's
  "57" predates that entry). Re-extract with the new facet prompt (refresh `tier1-extractor-cache.json`), then
  run the full **355 extractor→ground probe** (`extractor-ground-probe.ts`). State the target as a **delta on
  the re-measured baseline** — a lift concentrated on the period facet rows — with **clean/twin not regressed**.
- **Verbatim/exact-name floor maintained**; **ship gate g001–g003** + the 32-case `ground-snapshot.ts` (1×, per
  `feedback_skip_5x_eval`).
- **Zero-drop invariant** asserted (the demote touches `adj` only — no candidate leaves the pool or drops below
  `THRESHOLD`).
- **Facet-accuracy harness** — no-LLM check of LLM-emitted facets vs gold-name-derived facets (reuse this
  session's validation script); plus the SIDE validate-first check above.
- Log any extractor probes to `planning/queries/EvaledQueries.md` per `feedback_evaled_queries_log`.

## Reused machinery (so the build doesn't reinvent)

`periodOf`/`periodCore`/`scopeOf`, the `PERIOD_PENALTY`/`SCOPE_PENALTY`/`SPEC_PENALTY` pattern + the `adj` fold,
the period-collapse, `Criterion.side` + `perSideIndex` (`build-catalog.ts`), `candidatePool` (read-only recall
probe), the `extract.ts` forced-tool + zod `input_schema` auto-derive, and the
`extractor-ground-probe.ts`/`ground-snapshot.ts`/`catalog-sweep.ts` harnesses.

## Not this sprint (out of scope)

- **The 141 deep misses (rank 33+)** — vocabulary/lexicon normalization, BM25 recall depth, Stage-2
  recombination (separate workstream; a reorder can't reach them).
- **Near-synonym crowding (29 shallow / 19 deep)** — Sprint 6 doc-views + Sprint 7 family gate.
- **Combined markets (15 shallow / 32 deep)** — Sprint 7 Stage-2 live-menu recombination.
- **Vocabulary gaps (7 shallow / 36 deep)** — lexicon aliases (per `feedback_alias_discipline`) / extractor
  normalization.
- **Richer scope (matchday/season)** and the Sprint-7 family gate itself.
