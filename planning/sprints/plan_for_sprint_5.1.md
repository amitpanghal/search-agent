# Plan — Log "Sprint 5.1: facet soft-demote for the shallow band" as a sprint doc

## Context

**Why:** This session probed the 273 reachable grounding misses (`tightening/shallow_candidates.md` 132 +
`tightening/deep_candidates.md` 141). We root-caused the *shallow* band (gold reachable in its subject bucket
at rank 9–32, but below the live top-3 shortlist) and validated a fix offline. We want to record that fix as
an improvement sprint **5.1** before building it.

**Root cause (validated this session):**
- The extractor LLM *understands* the query's period/side/scope (the reasoning probe on "exact scoreline at the
  break" showed it knows "at the break" = first half) but a prompt rule — *"do not paraphrase slang… keep the
  query's own term; the per-sport lexicon maps it downstream"* (`extractor-prompt.md:187`) — makes it pass the
  casual words through.
- The grounder then re-infers period from text via the brittle `periodOf` regex and applies `PERIOD_PENALTY`
  (0.05) to `adj` **only**.
- The shortlist (`ground-market.ts` ~lines 493–496) orders lexical-cover-**"strong"** candidates first (by
  BM25), then by `adj`. So the period penalty (which lives in `adj`) **never reaches the top-3** — a
  facet-mismatched but lexically-strong candidate leads. This is why the already-deployed `periodOf` expansion
  recovered only 1/26 period misses.

**Validation already done (offline, cite in the doc):**
- LLM facets from words alone ≈ **90% accurate** (side near-perfect; period ~1 miss/30; scope/shape good).
- **Rejected** arm — strip qualifiers to a clean stat + hard filter: recall@3 **73→40%** (the qualifier words
  carry embedding signal; hard filter also dropped 2/30 golds).
- **Winning** arm — keep rich `market_concept`, add facets as a **soft demote** on the cosine pool:
  - shallow (132): recall@3 **25→33%** (.05) / **37%** (.08); recall@10 **54→68%**; **0 golds dropped**.
  - deep (141): **+2 only** — rank 33+ is unreachable by a small reorder (different levers needed).
  - combined (273): recall@3 12→16–19%, recall@10 26→33%.

**Intended outcome of this pass:** a logged sprint plan, nothing built.

## Deliverable (this approved pass — DOC ONLY, no code)

1. Create `planning/sprints/sprint-5.1.md` in house style (mirrors `sprint-5/6/7.md`: title, a `>` design-
   context blockquote, "The problem (plain English)", "The data finding", "The design", numbered "Steps",
   "Validation / acceptance", "Not this sprint").
2. Add a `## Sprint 5.1 …` section to `planning/sprints/STATUS.md` **at the top** (newest-on-top convention),
   with `Plan: [sprint-5.1.md](sprint-5.1.md)` and one dated entry `### 2026-06-10 — Designed + offline-
   validated; doc recorded, no code`.

## The design the sprint doc will specify (for the future build)

**Thesis:** the grounder already has period & scope soft-penalties; this sprint (a) **feeds them from the LLM**
instead of the brittle regex, (b) adds the **missing SIDE penalty**, and (c) **fixes the shortlist ordering**
so the penalties actually reach the top-3 — the piece that made the earlier period fix fail. Keep
`market_concept` **rich** (validated: stripping it craters recall). **Demote-don't-drop** (touch `adj` only,
never `raw`/`THRESHOLD` — the existing fail-safe envelope; 0 golds dropped by construction).

**Steps (documented for the build, not executed now):**
1. **Schema** — `src/resolver/schema.ts:55` `Selector`: add optional normalized facets
   `period?: enum(full|first_half|second_half|extra_time)`, `side?: enum(match|home|away|each)`. Scope reuses
   the already-deployed `scopeOf` + `SCOPE_PENALTY` (driven by `event_scope.level`, `schema.ts:84`); richer
   scope (matchday/season) is a stretch goal. Player-side is implicit from `subject.kind === "player"`.
2. **Extractor prompt** — `src/resolver/extractor-prompt.md`: add **sport-agnostic** rules to emit period/side
   (general concepts: "which match-period the query refers to"; "whose stat — host/home, visitor/away,
   both-each, or match total"). **Keep `market_concept` rich.** No idiom lists in the rules (the LLM
   generalizes; honors the standing sport-agnostic-prompt discipline). Likely **no `extract.ts` change** — the
   tool `input_schema` auto-derives from the zod schema (`extract.ts:26`).
3. **Thread facets** — `GroundOpts` (`ground-market.ts:67`) gains `period?`, `side?`; pass `sel.period` /
   `sel.side` at the call site `src/eval/run.ts:87` (and `ground-snapshot.ts`).
4. **Grounder demote** — `ground-market.ts`: query period = `opts.period ?? periodOf(text)` (LLM first, regex
   fallback); same shape for scope. Add a `SIDE_PENALTY` const (~0.05–0.08, tuned) demoting a candidate whose
   side (from the existing `Criterion.side` build-catalog tag / name) ≠ a definite query side. Fold alongside
   the existing `PERIOD_PENALTY`/`SCOPE_PENALTY`/`specificityPenalty` in the `adj` line (~457–463). Keep
   period-collapse.
5. **Shortlist ordering (load-bearing)** — `ground-market.ts` ~486–497: make the facet-adjusted score
   participate so a facet-**matched** gold is not buried under lexically-strong facet-**mismatches** (gate the
   "strong"-group lead on facet-match, or fold the facet penalty into the strong/weak sort). This is what
   lifted recall@3 73→90 in validation. **Regression-prone** (lexical-cover-first protects the "to score
   first" family) → guarded by the catalog-sweep round-trip + full probe.
6. **Acceptance gate (the real go/no-go, documented):**
   - Re-extract with the new facet prompt (refresh `tier1-extractor-cache.json`), then full **355 extractor→
     ground probe**: target **57 → ~68–76**; **clean/twin not regressed**, narrowed up.
   - **Verbatim floor 100%** maintained; **ship gate g001–g003** + 32-case `ground-snapshot.ts` (1×).
   - **Zero-drop invariant** (fail-safe property) asserted.
   - **Facet-accuracy harness:** no-LLM check of LLM facets vs gold-name-derived facets (reuse this session's
     validation script).

**Reused existing machinery (named in the doc, so the build doesn't reinvent):** `periodOf`/`periodCore`/
`scopeOf`, the `PERIOD_PENALTY`/`SCOPE_PENALTY`/`SPEC_PENALTY` pattern, the `Criterion.side` tag + `perSideIndex`
(`build-catalog.ts`), `candidatePool` (read-only probe), `extractor-ground-probe.ts` / `ground-snapshot.ts` /
`catalog-sweep.ts` (validation harnesses), the `extract.ts` forced-tool + zod `input_schema`.

**Not this sprint (documented as out of scope):** the 141 **deep** misses (rank 33+ — need vocab/lexicon
normalization, BM25 recall depth, Stage-2 recombination — separate workstream); the Sprint-7 family gate; the
Sprint-6 doc-views.

## Files this pass will create / edit
- **Create:** `planning/sprints/sprint-5.1.md`
- **Edit:** `planning/sprints/STATUS.md` (add the Sprint 5.1 section, newest-on-top)

## Verification (of this doc-only pass)
- `sprint-5.1.md` exists and follows the house structure (compare against `sprint-7.md`).
- `STATUS.md` has the new `## Sprint 5.1` section at the top with the `Plan:` link and one dated entry, and
  still renders (no broken table/heading).
- The numbers quoted in the doc match this session's validation table (shallow 25→33–37% @3, 54→68% @10;
  deep +2; combined 26→33% @10).
- Content is design-only — **no `.ts` source changes** in the diff.