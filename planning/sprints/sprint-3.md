# Sprint 3 — Collision handling: catalog rebuild + subject-filtered, tiered grounding

> Full design context: `docs/architecture.md` (**decision 20** is this sprint; supporting: 4 criterion
> hub, 5 hybrid, 8 entity-lexical, 9 resolver/executor split, 12 subject union; eval **E13**, E5, E8, E11).
> Builds directly on Sprint 2 ([sprint-2.md](sprint-2.md)). Progress in [STATUS.md](STATUS.md).
> Embedding model unchanged: Voyage `voyage-3` (same model build + query side).

## End goal (plain English)

Sprint 2 grounds a market phrase to **one** criterion id by raw cosine. That breaks on
**same-vocabulary collisions** — one phrase, many near-identical criterion names. This sprint makes
grounding **collision-safe**: filter candidates by the query's **subject** first, boost on **facets**,
and **tier** the answer (one winner / a variant-set / ambiguous) instead of forcing a single guess.

Worked example — `"...Vitinha shots on target over 0.5..."`:
- **Before (Sprint 2):** `"shots on target"` cosines against **all** criterion names; the phrase is in
  **38** of them, and the true id `2100015085` **isn't even in the index** (the committed snapshot is
  trimmed — see Context), so it grounds wrong or abstains.
- **After:** the rebuild puts `2100015085` back; the `subject.kind = player` pre-filter drops every
  team/match "shots on target"; cosine within the player bucket lands `2100015085`; one clear winner →
  tier **`confident`**. The over/under line hard-gates to an over/under boType.

## Context

Sprint 2 shipped the hybrid grounder (`ground-market.ts`: alias head + voyage-3 cosine tail, threshold
0.55) and the id-graded market axis. Two gaps surfaced when designing for the real catalog:

1. **The committed criterions snapshot is trimmed (measured 2026-06-03).** `football_criterions.json` has
   **598** criterions, but `football_categories.json` mappings reference **1151 distinct** criterion ids —
   **553 are missing from the list**, including g001's `2100015085`, and **315 of the 553 are `Player*`
   markets**. The catalog loader and the vector index are built from the *list*, so those 553 are
   **ungroundable today**. Grounding cannot be correct until the catalog is rebuilt from the full feed.
2. **Raw cosine can't tell name-twins apart.** "shots on target" ×38, "team total goals" must be the
   side-split pair `{1001159967,1001159633}` (not match-total `1001159926`), and per-player pre-baked rows
   ("*Mbappé* shots on target") flood the tail. Decision 20 resolves all three deterministically:
   **subject pre-filter → cosine → facet-boost → tier**, with the executor clarifying genuine ambiguity.

This sprint is **market axis only** (as Sprint 2). No entity/competition grounding, no executor, no SQLite.

## Scope (confirmed with user)

- **Rebuild the catalog** from the raw criterion feed ⋈ category feed with full multi-category membership
  (recovering `2100015085`), a **subject tag** per criterion, **participant quarantine**, and a version
  stamp (E11).
- **Upgrade grounding** to the decision-20 chain: hard subject pre-filter, `line→boType` gate + period
  penalty, and a **`tier`** on the result (`confident | variants | ambiguous`).
- **Upgrade the scorer** to **E13** (containment + tier-aware): pass iff gold id(s) ⊆ returned ids **and**
  tier is clean; `ambiguous` is tracked, never a hard pass. Gold cells stay single ids (g001's side-split
  stays the one natively-set cell).
- **Everything else stays as Sprint 2** — alias head, memoization, text grading on the non-market axes,
  precision bias (E5), alias neutrality (E8).

## End-state demo
`npm run eval -- --ground "shots on target" --subject player` → `2100015085` tier `confident`;
`--ground "team total goals" --subject either_match_team` → `{1001159967,1001159633}` tier `variants`;
a bare `--ground "corners"` that finds both a full-match and a 1st-half criterion → tier `ambiguous`
(clarify). `npm run eval -- --id g001` passes all three selectors **by id** under E13.

## Approach

Staged so the catalog is solid before the grounding logic, and grounding before the scorer.

### Stage A — catalog rebuild (build-time; the prerequisite)
1. **Refresh the feeds.** Replace the trimmed `data/football/football_criterions.json` with the **full**
   raw criterion feed (`feeds-eu…/criterion/sport/FOOTBALL.json`); keep `football_categories.json` current.
   These are **source** data (not derived), so committing them is fine. *Verify the refreshed list covers
   the 1151 category-referenced ids, incl. `2100015085`.*
2. **`catalog.ts` — join + tag.** Load criterion feed (id → name, `shownInLive/PreMatch`) ⋈ category feed
   (id → `categoryNames[]`, `boTypeNames[]` via mappings) into the existing `Criterion` shape, now with
   **full** membership. Add a **subject tag**: `subject ∈ {player, team_or_match}` = *in any `Player*`
   category → `player`, else `team_or_match`* (player wins on overlap). Expose `bySubject` alongside
   `byId/byName/list`. Add a **catalog version** (hash or feed timestamp) for E11.
3. **Participant quarantine.** At catalog build, drop per-player pre-baked criterions via participant-name
   match against `football_participants.json`, **guarded** (open item): no single-token match, a football
   stop-list, a length/token floor — fail toward *keeping*. Quarantined ids leave both `list` and the
   index. Emit a quarantine report (count + sample) for eyeballing.
4. **`build-market-index.ts` — re-embed.** Embed the rebuilt, **post-quarantine** criterion names with
   voyage-3; the index is already model-pinned in the filename. Stamp the catalog version into the artifact
   so a stale index vs a rebuilt catalog is detectable at load.

### Stage B — subject-filtered, faceted, tiered grounding (query-time)
5. **`ground-market.ts` — subject pre-filter.** `groundMarket(text, subjectKind?)` currently uses
   `subjectKind` only as a memo-key suffix; make it a **hard filter** — restrict the cosine candidate set to
   `cat.bySubject[kind]` before scoring (map plan `subject.kind`: `player → player`; `team |
   either_match_team | event → team_or_match`). The alias/exact-name fast-paths run first as today.
6. **Facet-boost.** On the in-bucket cosine survivors: **`line → boType` HARD gate** (a numeric over/under
   line keeps only criterions offering an over/under boType; a binary yes/no keeps yes/no); **period
   mismatch SOFT penalty**. Presentation/settlement-source suffixes are neither gated nor penalized.
   *(The grounder needs the plan's `line` for the gate — thread it in, or pre-compute the boType constraint
   in the harness and pass it alongside `subjectKind`.)*
7. **Tier + extend `GroundResult`.** Add `tier: "confident" | "variants" | "ambiguous"` beside `method`.
   Compute the **stat-type core** (name − subject prefix − non-semantic suffix strip-list, corroborated by a
   shared stat-type category): one clear winner (top score, gap > ε) → `confident`; survivors sharing a core
   → `variants` (return **all** their ids — this is how the side-split pair is produced); else → `ambiguous`.
   Below threshold still → `none` (E5).

### Stage C — E13 scorer + harness wiring
8. **`structural-scorer.ts` — containment + tier-aware.** The id-mode market axis currently uses **id
   set-equality** vs gold `market_concept.id`. Change to **E13**: pair + "market found" pass iff **gold
   id(s) ⊆ returned ids** AND `tier ∈ {confident, variants}`; `ambiguous` → not a pass, recorded as a soft
   note. For the natively-set gold cell (side-split) containment means **both** ids present (and tier
   `variants`). Pass the tier through — widen the harness payload from `marketIds: (number[]|null)[]` to the
   full `(GroundResult|null)[]` (or a parallel `tiers[]`).
9. **`run.ts` — wire + eyeball.** `groundSelectors` returns the tiered results; banner →
   `Mode: GROUNDED (market axis by id; tiered, subject-filtered)`. Extend `--ground` with an optional
   `--subject <kind>` so the grounder can be eyeballed per bucket; print `id(s) + tier + top-k candidates`.

## Key design decisions / consequences
- **Subject is the load-bearing cut, not category.** Once the `subject.kind` pre-filter runs, category does
  no further narrowing (decision 20); it survives only as the subject-tag source and core corroboration.
- **Tier, don't guess (E5/E13).** A collision the deterministic chain can't break becomes `ambiguous` →
  the executor clarifies. We never down-rank to a "canonical" id — that was rejected as **E8 gold-fitting**
  (no recency field exists; `shownInLive` shows the suffixed twin is the *more* featured one).
- **Gold stays single ids.** g001 keeps `{id: 2100015085}`; a `variants` return passes by **containment**.
  The side-split is the *only* natively-set gold cell. No gold edits to "match" multi-candidate output (E8).
- **Rebuild is a prerequisite, not a nicety.** Without Stage A the target id isn't in the index, so Stage B
  cannot pass g001 regardless of logic. Land A (and re-verify the index covers `2100015085`) before B.
- **Three knobs stay uncalibrated** (decision 20 / Open questions) — threshold + ε, the suffix strip-list,
  the quarantine common-word guard. Each fails safe (abstain / over-clarify / keep); calibrate on the
  rebuilt seeds, never by hand-fitting a seed.

## Critical files
- **Edit:** `src/resolver/catalog.ts` (join + subject tag + quarantine + version), `src/resolver/build-market-index.ts`
  (re-embed post-quarantine, stamp version), `src/resolver/ground-market.ts` (subject filter, facet-boost,
  `tier` on `GroundResult`), `src/eval/structural-scorer.ts` (E13 grading), `src/eval/run.ts` (wire tier,
  `--subject`, banner), `data/football/football_criterions.json` (refresh to full feed).
- **Reuse:** `src/resolver/embed.ts` (unchanged), `src/resolver/schema.ts` (`subject.kind`, `line`),
  `src/eval/gold.seed.jsonl` (g001 ids unchanged), `data/football/football_categories.json`,
  `data/football/football_participants.json` (quarantine source).
- **Rebuilt artifact:** `src/resolver/index/criterion-vectors.voyage-3.json` (regenerated, version-stamped).

## Verification (end-to-end)
1. **Catalog rebuild:** after Stage A, assert `byId.has(2100015085)`, the 1151 category-referenced ids
   resolve, and the quarantine report contains only real full player names (common-word guard check).
2. `npm run build:index` — re-embeds the post-quarantine set; index count ≈ catalog list size; version
   stamp matches the catalog.
3. `npm run eval -- --ground "shots on target" --subject player` → `2100015085 confident`;
   `"team total goals" --subject either_match_team` → `{1001159967,1001159633} variants`; eyeball
   `"clean sheet"`, `"anytime scorer"` off-seed for sane tiers.
4. `npm run eval -- --id g001` — all three selectors pass **by id** under E13 (incl. the side-split as a
   `variants` containment pass).
5. `npm run typecheck` clean; `npm run eval` — g001/g002/g003. g002 (`unsupported`) untouched; g003 BTTS
   still lands `1001642858` (now `confident`/`variants` via the player-agnostic bucket); ship gate PASS.
6. `npm run eval -- --release` (5×) — temp-0 reproducibility holds with subject-filter + tier in the loop.

## Out of scope (explicit)
Entity/player/team/competition grounding; `attrFilter` id-sets + region table; cross-encoder rerank
(decision 20 defers it); the executor's clarify/offer UX (decision 9 owns it — this sprint only *emits* the
tier); SQLite build pipeline; the executor & live layer; corpus expansion. Threshold/ε, strip-list, and
common-word-guard **calibration** are flagged but their final values are not gated here. Doc steps 2–8.
