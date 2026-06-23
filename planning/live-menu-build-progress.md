# Live-menu build — progress tracker

Tracks the build of the live-menu resolution pipeline (plan:
[live-menu-build-plan.md](./live-menu-build-plan.md); theory:
[live-menu-resolution-theory.md](./live-menu-resolution-theory.md)).
Status key: `[ ]` not started · `[~]` in progress · `[x]` done.

Approach: **option (B)** — build the new post-fetch half first (Phases 0–5), then remove the old market half
and rewire in one cut (Phase 6). No shim, no back-compat.

## Build sequence

- [x] **0. Lock the new types** — `SettledEntities`, `Menu` (`criterion + variant` labels), `MarketPick`
      (`exact|close|none`), `Selection`, new executor input. Pure, typechecks. Landed in new module
      [`src/resolver/live-menu-types.ts`](../src/resolver/live-menu-types.ts) (wired to nothing). One deviation
      from the sketch: tier field named `match` (not `label`) to avoid clashing with `MenuItem.label`.
- [x] **1. RECALL in-tree (+ owns ALL fetching)** — [`recall.ts`](../src/resolver/recall.ts) is now the home
      of data fetching. The proven fetch engine (`runTask`/`runTasks`/`fanOutGroup`/`fetchEventOffers`/
      `resolveExecutionWindow`/2000-cap detection) **moved out of executor.ts** into recall; executor no longer
      fetches and re-exports the engine for existing probes (cleanup: Phase 9). New `recall()` entry: endpoint by
      Model P (named participant → participant endpoint, else group), grain → `onlyCompetitions` + fan-out level,
      `playState` → exclude flags; **no criterion `type=` bound** (market deferred), so group calls fetch broad
      and lean on the fan-out. Menu deduped by `criterion + variant`, labels only.
      *Tested:* tsc 0 errors; [`.recall-probe.ts`](../scripts/.recall-probe.ts) both grains live; old path intact
      (`probe-phase1 --live` all pass: group 148 offers, participant 1688; `probe-phase3 --live` cap+fan-out pass).
      **Plan note:** this shifts the Phase 1/4 boundary — the fetch core is recall's, Phase-4 execute consumes
      pre-fetched data.
- [x] **2. FILTER + RESOLVE(market)** — **coverage audit done** ([`.coverage-audit.ts`](../scripts/.coverage-audit.ts)):
      subject lives in 4 homes — (P) outcome participant, (Q) outcome label, (M) market label/per-team variant,
      (E) fixture event name. Key catch: **matching MUST be diacritic-folded** — feed stores "Kylian Mbappé", a
      plain "Mbappe" substring false-dropped all 4 of his markets. [`filter.ts`](../src/resolver/filter.ts)
      (deterministic, `fold()`, P/Q/M/E homes, no-subject passthrough) + [`resolve-market.ts`](../src/resolver/resolve-market.ts)
      + [prompt](../src/resolver/resolve-market-prompt.md) (LLM picks ref → `criterionId+variant`, labels
      `exact|close|none`, injectable decider for replay). `variantOf`/`marketLabelOf` exported from recall (DRY).
      *Tested:* tsc 0 errors; [`.phase2-probe.ts`](../scripts/.phase2-probe.ts) 8/8 deterministic — filter coverage
      live (Spain→6, **Mbappe accent-fold→4**, USA match→Full Time+BTTS) + resolve mapping (exact/none/bad-ref→none/empty→none).
      **Live model `--live` scored contract deck: 6/6, 0 confident-wrong** — variants (Winner vs Top 4), twin/accent
      (golden boot→"most goals"), abstain-danger (Japan QF→none), non-lexical (home team to win→Full Time, BTTS).
- [x] **3. SELECT** — [`select.ts`](../src/resolver/select.ts): deterministic line + subject vs real outcomes,
      nearest-line + not-offered fallbacks. Zero LLM. Outputs the Phase-0 `Selection`. Subject in 3 homes
      (participant / market label / 1X2 home-away); participant match diacritic-folded (same lesson as filter).
      *Tested:* tsc 0 errors; [`.phase3-probe.ts`](../scripts/.phase3-probe.ts) **9/9 live** — exact, nearest
      (2.25→2.5), per-team variant (USA/Turkey), player prop, **accent (Çalhanoglu)**, signed handicap (-0.5),
      1X2 home win, honest subject-absent (Messi).
- [x] **4. EXECUTE path in-tree** — [`execute.ts`](../src/resolver/execute.ts): consumes an `ExecuteInput`
      (resolved legs + the live data) and assembles a `LiveAnswer` (exact→answer, close→labelled suggestion,
      none→clarify). No fetch, no market decision — thin, as RECALL owns the fetch. Wired to nothing.
      *Tested:* tsc 0 errors; [`.phase4-probe.ts`](../scripts/.phase4-probe.ts) **5/5 live** — exact (Full Time
      "1" @3.45), nearest-line note, subject-absent honest note, none→clarify, multi-leg + union caveat.
- [x] **5. Post-fetch market gate (before the cut)** — [`src/eval/live-menu-gate.ts`](../src/eval/live-menu-gate.ts)
      replays FILTER → RESOLVE-mapping → SELECT → EXECUTE against a **captured snapshot**
      ([`live-menu.snapshot.json`](../src/eval/live-menu.snapshot.json), written by
      [`scripts/capture-live-menu.ts`](../scripts/capture-live-menu.ts)). Resolve uses the **replay decider**
      (captured decisions, no model) — mirrors `disambig-replay.ts`. **24/24, fully OFFLINE** (passes in-sandbox =
      no network, no LLM). Folds in the Phase 1–4 checks. Run: `npx tsx src/eval/live-menu-gate.ts`.
      **Update:** added section (E) — SELECT by `subjectId` (the preferred id-path, `select.ts:46`) across its four
      branches (outright by id, 1X2 by id, owner-bound→Yes, subject-absent by id), so the id-path is locked offline
      and no longer relies on the live smoke alone (+4 cases, 20→24).
- [x] **6. THE CUT** — landed. `disambiguate.ts` → entity-only [`resolve-entities.ts`](../src/resolver/resolve-entities.ts);
      `ground-market.ts` / `combos.ts` / `related-markets.ts` deleted (BM25/lexical salvaged into
      [`lexical.ts`](../src/resolver/lexical.ts)); `plan-fetch.ts` → [`plan-recall.ts`](../src/resolver/plan-recall.ts);
      orchestrator rewired in [`resolve.ts`](../src/resolver/resolve.ts) (extract → groundScope → resolveEntities →
      planRecall → recall → filter → resolveMarket → select → execute); `disambiguator-prompt.md` trimmed to entity rules.
      *Verified:* `src/resolver` typechecks clean. **Not yet run:** the full live smoke
      [`.phase6-smoke.ts`](../scripts/.phase6-smoke.ts) (needs network + LLM end-to-end).
- [x] **7. Re-home eval gate** — the four old-path eval files broke the project typecheck (imported the deleted
      `ground-market` / `disambiguate` / `plan-fetch`). Fixed: deleted the dead market-pick replay
      (`disambig-replay.ts` + `disambig-fixtures.ts` — the disambiguator they replayed is gone); `GroundResult`
      relocated into [`structural-scorer.ts`](../src/eval/structural-scorer.ts) (ID-mode kept, latent); the extractor
      gate now grades the market axis in **TEXT** mode (extraction), and criterion-id **resolution** is graded by a
      new LIVE sibling gate [`market-resolve-gate.ts`](../src/eval/market-resolve-gate.ts) — resolves each gold `id`
      cell against the captured snapshot menu via resolve-market, subject-aware phrasing (player → "player X";
      team/either_team → "<fixture team> X"; event → bare), pass iff any phrasing resolves EXACT to a gold id.
      `loadGold` factored into [`gold-record.ts`](../src/eval/gold-record.ts) (shared by run.ts + the gate).
      *Tested:* `npx tsc --noEmit` 0 errors; standalone gate **6/6 live**; full `npm run eval` 1× — SHIP GATE PASS
      (critical 100%), ENTITY GATE PASS, market gate 6/6; Phase 5 gate still 20/20 offline. The entity-resolution
      gate stays the deterministic `scope-scorer` (`gradeAll`), green.
- [x] **8. Guards & hardening** — (Filter coverage audit moved up to gate Phase 2.)
      - [x] **Payload measured (no pruning needed).** Against the captured snapshot: MATCH grain worst case = 746
        raw offers → **99 menu items, ~817 tokens** (labels only; a team filter keeps the whole fixture menu by
        design, a player filter → 14 items/~125 tok). COMPETITION grain = 39 items/~366 tok full; Spain → 14/~112;
        Mbappe → 4/~44. All well within budget → **structural pruning NOT built** (theory §10.3: only prune if the
        numbers say so — they don't).
      - [x] **Inverse-direction guard — resolved as ACCEPT-AS-IS (no code).** The direction rule already lives in
        the prompt at the right layer ([`resolve-market-prompt.md`](../src/resolver/resolve-market-prompt.md):
        `close` = "Same DIRECTION only"; `none` = abstain when candidates win the OPPOSITE scenario, e.g.
        eliminated-at-stage vs reach/top-N). The Japan wobble is the model intermittently not following that rule
        (≈1-in-180, contract probe) and it errs **safe** — a labelled suggestion, never a confident wrong answer.
        A deterministic antonym guard would re-encode that rule as phrasing-patchwork / sport-specific code, so it
        was **not** built; the prompt rule + the safe-error property are the lever.
- [~] **9. Cleanup & freshness**
      - [x] **Scratch probes deleted (15).** Removed the live-menu build scratch whose logic now lives in `src` +
        the committed offline gate: `.recall-probe`, `.phase2/3/4-probe`, `.coverage-audit`, `.contract-probe`,
        `.select-probe`, `.recall-resolve-spike`, `.recall-resolve-comp-spike`, `.participant-filter-test`,
        `.select-debug-probe`, `.select-fix-probe`, `.sel-outcomes`, `.idspace-probe`, `.phase0-baseline`.
        **Kept** `.phase6-smoke.ts` (the end-to-end live smoke is still un-run). The ~28 older cross-sprint scratch
        (`.new16*`/`.new20*`/`.wc36*`/`.htft-*`/`.probe-*`/etc.) were also deleted (user-confirmed) — committed
        `scripts/` is now just `capture-live-menu.ts` + the kept `.phase6-smoke.ts` scratch.
      - [x] **Committed probes swept.** Deleted the old-pipeline phase probes (`probe-phase1..6`) and the old
        eval/grounder probes (`classify-misses`, `miss-reasons`, `probe-noresult`, `probe-period-facet`,
        `probe-relevel`, `probe-scope`) — new ones can be written against the new pipeline if needed. Committed
        `scripts/` is now just **`capture-live-menu.ts`** (the offline-gate snapshot tool). *Verified: tsc CLEAN,
        gate 24/24.*
      - [x] **Old-design catalog sweep (49 files).** With market resolution now against the LIVE feed, the static
        **criterion/category catalog is dead** and was removed in full (user-confirmed full sweep A+B+C+D):
        - **3 src modules:** `catalog.ts`, `build-catalog.ts`, `build-categories.ts` (orphaned — only `build-catalog`
          imported `catalog`; the live orchestrator imports none of it).
        - **15 data files:** the criterion/category feeds (`football_criterions[.raw]`, `football_categories[.raw]`,
          `football_betoffertypes`, `derived-aliases`, `offer-stats`), the WC26 static registry (`WC26_criterions`,
          `wc26-subset`, `offer-registry`, `2010133908_worldcup`), and doc-views/dead-eval data (`criterion-doc-views`,
          `doc-views-gen-cache`, `eval-families`, `eval-target-markets`). All git-tracked → recoverable.
        - **31 scripts:** 21 broken old-design probes (imported deleted `ground-market`/`disambiguate`/`combos`/
          `related-markets`), 3 more importing the deleted `catalog` (`analyze-lever-reach`, `clean-query-set`,
          `probe-family-diagnostic`), the WC26 builders (`build-wc26-criterions`, `refresh-wc26`, `probe-offers`,
          `football/merge_worldcup.py`), doc-view scripts (`ingest-doc-view-batches`, `pilot-doc-views-filter`), and
          `refresh-football-feeds` (it only refreshed the catalog feeds + called the deleted build steps).
        - **5 npm scripts** dropped (`build:catalog`, `build:categories`, `build:wc26`, `refresh:wc26`, `refresh:feeds`);
          two stale code comments fixed (`lexical.ts`, `build-scope-index.ts`). *Verified: tsc CLEAN, gate 24/24, no
          dangling refs.* **Kept** (live path): `scope-index`/`scope-aliases`/`aliases`/`groups`/`football_participants`,
          the eval gates + `capture-live-menu`, and the extractor-eval probes/`tier1-*` query sets.
      - [ ] **scope-index freshness — refresh DEFERRED.** `scope-index.json` (builtAt 2026-06-14) is a **pure local
        join** rebuilt by `npm run build:scope` from `groups.json` ⋈ `football_participants.json` (both committed
        snapshots, dated May 28). Note: the old `refresh:feeds` was **catalog-specific** and was deleted in the sweep;
        it did NOT refresh these entity inputs — those come from a separate (manual / `scripts/football/*.py`) path.
        So scope-rebuild is just `npm run build:scope`; pulling genuinely newer entity data from the feed is a
        separate, network-dependent step to run deliberately (collides with the in-flight uncommitted scope work).

## Verification (to fill as phases land)

- [x] **Typecheck** — `npx tsc --noEmit` clean across new + edited files. *(Phase 0: 0 errors project-wide.)*
- [x] **New-half module tests** — RECALL / FILTER / RESOLVE / SELECT / EXECUTE pass in isolation (Phases 1–4).
      *(RECALL ✓ `.recall-probe`; FILTER ✓ + RESOLVE ✓ (plumbing + live 6/6, 0 confident-wrong) `.phase2-probe`;
      SELECT ✓ 9/9 `.phase3-probe`; EXECUTE ✓ 5/5 `.phase4-probe`.)*
- [x] **Pre-cut market gate** — post-fetch market gate (resolve label + select) green against captured menus
      *before* the cut: **24/24 offline** (`src/eval/live-menu-gate.ts`; includes the id-path SELECT cases).
- [x] **Post-cut eval gate** — project typecheck back to clean after re-homing (was 9 errors, now 0). `npm run eval`
      1× green end-to-end: extractor SHIP GATE PASS (critical 100%), ENTITY GATE PASS, market-resolve gate 6/6 live.
      Phase 5 offline gate unchanged at 20/20.

## Deferred (out of scope — not tracked as todos)

Deep entity-resolution edge cases beyond the §3 gate · time-window / "which fixture" · bracket / half-of-draw
· multi-subject fetch routing.
