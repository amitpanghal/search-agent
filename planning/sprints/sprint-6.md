# Sprint 6 — Doc-views: generated paraphrase vectors for the grounding tail (shortlist-capped recall, extractor-in-loop eval)

> Full design context: `docs/architecture.md` (**decision 27** is this sprint; supporting: decision 20
> grounding chain/tiers, decision 25 alias discipline; eval **E5** precision-bias/abstain, **E8** neutral
> grader/by-construction labels, **E11** stale-index guard, **E13** containment + tier). Builds on Sprint 4
> ([sprint-4.md](sprint-4.md), the Tier-1 sweep + extractor→ground probe) and the alias work in Sprint 5
> ([sprint-5.md](sprint-5.md)). Progress in [STATUS.md](STATUS.md). Embedding model: Voyage `voyage-3`
> **(Step 0 probes an upgrade)**.

## End goal (plain English)

The vector tail (decision 20, last resort after alias/exact-name/subset) is **weak on disjoint phrasings** —
golds sit at raw cosine **0.32–0.47**, below the `0.55` THRESHOLD — because a terse catalog name
("To keep a clean sheet") shares no words with how a user asks ("to shut out the opposition").

But that weakness is **over-measured.** Sprint 4 established two numbers on the *same* markets: the
direct-paraphrase batch (paraphrase → grounder, **skipping** the extractor) scored **39%**, while the
extractor→ground probe (query → real Haiku → `market_concept` → grounder) scored **75%**. The extractor
already normalizes ~80% of the phrasing. So we **retire the 39% headline** and optimize the layer that
actually runs in production: the `market_concept` the extractor emits.

The dataset-level fix: give each criterion **extra embedded vectors** — *doc-views*, generated user-language
paraphrases of the market — so the cosine has a **closer door** to match. This is **bulk-generated soft
aliases at the embedding layer**: the scalable successor to the 40 hand-curated disjoint-synonym aliases
(decision 25). Ship them as **recall-only (shortlist-capped)** first so they can never mint a wrong
confident; **measure**; promote to confident only if a clean separation is proven (the test the reranker
**failed** in Sprint 4).

**Not this sprint (rejected/escalation):** the reranker (Sprint 4: net-negative at both stages) and
doc-enrichment-into-a-single-vector (Sprint 3: dilutes good name matches) stay rejected. Training a model on
our data — a linear **adapter** over frozen voyage, then full fine-tune, then an in-house model — is the
**deferred escalation** if doc-views plateau; the same generated dataset feeds it.

## Worked example — a doc-view

Criterion `1003971484` "To keep a clean sheet" (player). Normalized query `"to shut out the opposition"`:
- **Today:** cosine ≈ 0.30 to the name → below FLOOR → **`none`** (it's in Sprint 4's failure list).
- **With doc-views** `["to not concede a goal", "shut out", "win to nil"]`, scored by **max-pool**: the
  "shut out" view scores ≈ 0.95 → `bestRaw` ≈ 0.95 → the market **surfaces in the shortlist** → a
  **`narrowed` pass** (the executor clarifies; nothing is lost).
- **Capped at shortlist (phase 1):** even if a *false-friend* view (say a "Most Corners" view for a
  `"corners in the match"` query) outscores the true market, it can only reach `shortlist`, never a wrong
  `confident`. Precision is preserved by construction.

## Scope

- **Vector tail only (decision 20).** Doc-views are **additive** to the criterion-vector index; the alias /
  exact-name / subset head is untouched and still fires first.
- **Recall-only in phase 1.** Two scores per criterion (decision #5 below); the **`confident` tier is
  byte-identical to today**. Doc-views can only add/reorder `shortlist` entries.
- **Eval reframed to extractor-in-loop**, keeping E8 by-construction id labels. The direct-paraphrase 39%
  is retired as a headline (kept only as a side diagnostic).
- **Clean-room generation:** Opus authors views · GPT-5.5/Sonnet authors queries · real **Haiku** normalizes
  · mutual blindness (see #3).
- **Alias table frozen** (decision 25): new tail gaps → doc-views; opaque abbreviations stay aliases.
- **Phase 2 (promotion to confident) is gated** on a measured separation bar (#9); not built until phase 1
  data justifies it.
- Market grounder only; live/in-play stays a pinned abstain (decisions 9, 22).

## End-state demo (phase 1)
`npx tsx scripts/extractor-ground-probe.ts` over the scaled stratified-blind set →
`Extractor→ground (doc-views ON): clean A + narrowed B / N (xx%) | sub-threshold conversions: +K none/below→narrowed, 0 narrowed→below | confident tier: 0 changes vs OFF`
then a per-case log flagging, for each sub-threshold case, whether a view-match pointed at the **gold** or a
**false friend** (the data that decides phase 2).

## Key design decisions

| # | Decision | Choice |
| - | -------- | ------ |
| 1 | Lever | **Doc-views** — multiple embedded vectors per criterion (name + generated paraphrases), scored by **max-pool**. "Bulk-generated soft aliases." Adapter/fine-tune/own-model = deferred escalation on the *same* dataset. Reranker + single-vector doc-enrichment **stay rejected.** |
| 2 | Eval distribution | **Extractor-in-loop** (query → real Haiku → `market_concept` → ground), **not** raw paraphrases. Keep **E8** by-construction id labels. Retire the 39% headline; keep it as a side diagnostic only. |
| 3 | Clean-room | **Opus** authors views · **GPT-5.5/Sonnet** authors queries · real **Haiku** normalizes — three voices, **mutual blindness** (generator never sees eval, vice-versa). Cross-model guards *phrasing memorization*; the by-construction label guards the *answer key*. **Report the lexical overlap of wins** (genuine generalization vs near-string-match). |
| 4 | Eval input | Run the authored queries through **real Haiku once**, **cache** into `tier1-extractor-cache.json` (LLM-free reruns). Views authored in the **terse `market_concept` register** (what the grounder actually embeds), not chatty user prose. |
| 5 | Precision guard | **Two scores per criterion.** `nameRaw` = cosine to the canonical **name only** → feeds `confident` (unchanged). `bestRaw` = **max over name + views** → feeds **shortlist/recall only**. Phase 1 **cannot change any confident outcome.** |
| 6 | Generation | **Cluster-contrastive** — group near-twins (by category / `statCore` family), feed Opus the whole cluster, ask for views that *distinguish each member from its siblings*. Then a **mechanical collision filter:** embed every view, **drop any closer to a sibling than to its own market.** Discriminate **across** distinct `statCore`s; intended **variants** (Home/Away side-split, settlement twins) keep sharing. ~6–8 generated/market; survivors vary as the filter prunes. |
| 7 | Eval set | **Stratified-by-family, blind, ~300–500 queries.** Fixed quota per market family (result · totals · BTTS · corners · cards/bookings · scorers · player-props · HT/FT · handicap · tournament-outright · …); GPT writes freely **within** each family, blind to the doc-views and the failure list. **Go/kill:** net `none`/`below`→`narrowed` on the sub-threshold slice **> 0**, with **zero `narrowed`→`below`.** |
| 8 | Alias interaction | **Freeze alias growth** (decision 25). New tail gaps → doc-views (shortlist). Opaque abbreviations ("DNB", "1X2", "BTTS") stay alias/abbreviation entries (no semantics to paraphrase). Retire redundant aliases only as a **post-phase-2** cleanup. |
| 9 | Phase-2 bar | Promote view-matches to **`confident`-eligible** iff a score band **cleanly separates** true view-matches from false-friend view-matches (the test the reranker **failed**: "no threshold separates gold from distractors") **and** projected false-confident rate ≈ 0 (**E5**). No clean separation → **stay shortlist-capped** (still worth it for the narrowed passes). |

**Anchoring rule (implementation, #5/#6):** `statCore`, `specificityPenalty`, period facet and `lexicalCover`
stay derived from the **canonical name** — a doc-view contributes **only its vector** (for `bestRaw`), never
its text. A chatty view must not scramble the penalties or the cluster keying.

## Approach (staged)

### Step 0 — probe a model upgrade (~~cheap, first; ~1 hr~~) — **NOT REQUIRED**
~~Swap `EMBED_MODEL` → `voyage-3.5` / `voyage-3-large`, `npm run build:index`, re-run `catalog-sweep` +
`extractor-ground-probe`. If golds at 0.32–0.47 jump on a better space, **fewer doc-views are needed.**
Reversible (the index filename is model-pinned; old file untouched). Confirm Voyage pricing/availability.~~
**Skipped** — proceeding straight to the doc-views build regardless of embedding-space gains.

### Phase 1 — doc-views as a shortlist-capped recall channel
1. **Build the eval set (baseline).** GPT-5.5/Sonnet authors ~300–500 stratified-blind queries with
   by-construction ids → run through **real Haiku once** → extend `tier1-extractor-cache.json` → ground →
   E13 score. This is the **extractor-in-loop baseline** (doc-views OFF).
2. **Generate views.** Cluster near-twins; Opus cluster-contrastive in terse register, blind to the eval,
   ~6–8/market → **collision filter** → write `data/football/criterion-doc-views.json` (committed text).
   Optional: a cheap LLM **drift spot-check** on a ~50-view sample.
3. **Index.** Extend `build-market-index.ts` to embed `[name, ...survivingViews]`; each entry holds
   `vecs: number[][]`. (Index ~6× bigger — a watch-item; the `(id,name)`-only version hash is unchanged by
   views, so note whether a views-change should force a rebuild.)
4. **Match.** In `vectorGround`, keep **`nameRaw`** (name vector → `confident`, unchanged) and
   **`bestRaw` = max over `vecs`** (→ shortlist/recall only). Apply the **anchoring rule**.
5. **Measure + go/kill.** Re-run the eval set ON vs OFF; report production rate + **net sub-threshold
   conversions**; `ground-snapshot` must show **0 confident changes**; log per-case **true-vs-false-friend**
   view-matches (phase-2 fuel). Apply the #7 go/kill bar.

### Phase 2 — promotion (gated on phase-1 data)
6. From the phase-1 logs, test the **#9 separation bar.** If met: allow view-matches into `confident`
   (still subject to the existing `statCore`/ε collision machinery), **recalibrate `THRESHOLD` off the
   distribution** (never a seed, E8), and re-verify precision. If not met: **stay shortlist-capped** — doc-
   views remain a recall-only channel.

## Critical files
- **Add:** `data/football/criterion-doc-views.json` (generated views, committed text); `scripts/gen-doc-views.ts`
  (cluster-contrastive generation + collision filter); the stratified-blind eval-query set
  (`data/football/tier1-extractor-queries.json` extended, or a sibling file).
- **Evolve:** `src/resolver/build-market-index.ts` (single `vec` → `vecs[]`); `src/resolver/ground-market.ts`
  (`nameRaw`/`bestRaw` split, max-pool, shortlist cap, anchoring rule; `IndexEntry`/`VectorIndex` types);
  `scripts/extractor-ground-probe.ts` (scale to ~300–500, stratified, ON/OFF + sub-threshold report).
- **Reuse (no change):** `src/eval/structural-scorer.ts` (`idsContainGold`, E13); `src/resolver/catalog.ts`;
  `scripts/ground-snapshot.ts` (the confident-tier regression guard); `data/football/tier1-extractor-cache.json`
  (extended).
- **Frozen:** `data/football/aliases.json` (no growth; abbreviations only).
- **Derived artifact:** `src/resolver/index/criterion-vectors.<model>.json` (rebuilt, ~6× bigger; model-pinned
  filename, gitignored).
- **Possibly touch (phase 2 only, routed):** `THRESHOLD` in `ground-market.ts`, calibrated **off the eval
  distribution**.

## Verification
1. **`ground-snapshot` shows 0 confident changes** in phase 1 — the cap's core safety assertion (confident =
   `nameRaw` only).
2. `catalog-sweep` **verbatim floor stays 100%** (the change is additive to the index).
3. `npm run eval` **ship gate PASS** throughout (g001–g003, gf01–gf05).
4. Eval set is **stratified-blind** (authored without the doc-views / failure list); the run reports the
   **lexical-overlap split** of wins (generalization vs near-string-match).
5. **Collision filter asserts** no surviving view is closer to a sibling criterion than to its own.
6. **Phase-1 go/kill:** net sub-threshold `none`/`below`→`narrowed` **> 0**, **zero `narrowed`→`below`.**
7. **Alias-table count unchanged** (frozen; a printed guard metric, decision 25).
8. **Phase 2 only:** the #9 separation bar is met *before* promotion; post-promotion false-confident rate
   ≈ 0; `THRESHOLD` recalibrated off the distribution, not a seed.
9. `npm run typecheck` clean throughout.

## Out of scope (explicit)
- **Adapter / fine-tune / in-house embedding model** — the deferred escalation if doc-views plateau (same
  dataset feeds it); not built this sprint.
- **Reranker** (rejected, Sprint 4) and **single-vector doc-enrichment** (rejected, Sprint 3) — stay rejected.
- **Phase-2 promotion build + `THRESHOLD` recalibration** — gated on the measured separation bar (#9).
- **HyDE / query-side expansion** — largely redundant with the extractor's normalization.
- **Real-query-log mining for views** — best signal, but no traffic logs yet; a later enrichment.
- **Index-size optimization** (dim truncation / compact storage) — a watch-item, only if load/memory bites.
- Entity/competition/attrFilter grounding; the executor + live layer (decisions 9, 22).
