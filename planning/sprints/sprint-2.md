# Sprint 2 — Market grounding (the criterion star) + id-graded market axis

> Full architecture context: `docs/architecture.md` (decisions 4–5, 10; eval E1/E3/E8).
> Builds directly on Sprint 1 ([sprint-1.md](sprint-1.md)). Progress in [STATUS.md](STATUS.md).
> Embedding model decision: Voyage `voyage-3` (paid; same model build + query side).

## End goal (plain English)

Turn the **market words** in a query into the **real market in the catalog** (its criterion
id), and upgrade the eval to grade on that id instead of on text.

Worked example — `"...Vitinha shots on target over 0.5..."`:
- **Before:** the plan's market is the literal text `"shots on target"`; the eval only checks
  the text looks like an acceptable phrasing.
- **After:** the resolver maps `"shots on target"` → criterion **`2100015085` "Player Shots on
  Target"**, and the eval passes only if it lands on that exact id.

Why it matters (text can't do this): `"shots on target"` is in **39** criterion names (incl.
`"Beto shots on target"`, `"Allsvenskan: Most Shots on Target"`); `"team total goals"` must
resolve to the **side-split pair** `{1001159967, 1001159633}`, **not** `1001159926 "Total
Goals"` (the match total). These distinctions are invisible on surface text — only ids catch them.

## Context

Sprint 1 made the extractor runnable and graded its output **structurally** (text vs each gold
cell's `accept[]`). That makes `accept[]` a "shadow alias table" (doc E1): it proves the words,
not the market. The raw catalog already sits in `data/football/` (607 criterions + alias tables);
nothing is built on it yet. This sprint adds the **grounding stage** for the single highest-value
axis — the **market** — and swaps the scorer's market check from text to **catalog id**. Market
id is a *critical* ship-gate facet (must be 100%), so this is the biggest single upgrade to the
eval available now.

Per decision 5 (hybrid) and 10 (in-memory, no SQLite yet): grounding = curated alias (head) +
brute-force cosine over criterion-name vectors (tail). At 607 vectors cosine is sub-ms; SQLite is
**deferred** (it only saves re-embedding at boot — a step-2 build-pipeline concern, not needed
until the embedding model is locked and boot time bites).

## Scope (confirmed with user)

- **Market axis only.** Resolve `selector.market_concept` (text) → criterion id(s), scoped to the
  inferred sport, and grade the eval's market axis by id. Pairing of predicted↔gold selectors
  moves from market *text* to market *id* (doc E3).
- **Everything else stays text.** Player/team/competition names, stage, time, attrFilter all stay
  text and keep their Sprint-1 text grading (binding still matched by text vs `accept[]`). No
  entity/competition grounding, no attrFilter id-sets, no region table.
- **No executor / live layer / SQLite artifact / corpus expansion.** All remain doc steps 2–8.

## End-state demo
`npm run eval -- --id g001` reports the market axis by id — `shots on target → 2100015085 ✓`,
`corners → 1001159897 ✓`, `team total goals → {1001159967,1001159633} ✓` — and **fails loudly**
if the resolver lands on the wrong criterion id (a check Sprint 1 cannot perform).

## Approach

Staged so the pipe is green before the hard part. **Important:** with the *existing* alias tables
(which must NOT be seeded from gold `accept[]` — doc E8 neutrality), alias-only resolves ~none of
the seed markets (`"BTTS"` aliases to a *category* concept, not the criterion; the others have no
criterion-yielding alias). So **vectors are load-bearing from the start** — Stage A is plumbing,
Stage B is what makes the seeds pass.

### Stage A — catalog + alias plumbing + scorer id-swap (no model yet)
1. **`src/resolver/catalog.ts` (new)** — load `data/football/football_criterions.json` →
   `{ byId: Map<number,Criterion>, list: Criterion[] }`; `Criterion = { id, sport, name,
   categoryNames[], boTypeNames[], shownInLive, shownInPreMatch }`. Load `aliases.json` +
   `derived-aliases.json` `markets` into one normalized alias map. Scoped to market grounding —
   players/groups not loaded here.
2. **`src/resolver/ground-market.ts` (new), alias path** — `groundMarket(text, subjectKind?)`:
   normalize → alias lookup. The grounding **target is a criterion id** (the star hub, decision 4).
   An alias that yields a criterion (exact criterion-name / `criterion_concept`) short-circuits; an
   alias that yields a **category/botype** concept is a *scoping hint only* → fall through to Stage B
   (e.g. `"both teams to score"` aliases to a BTTS *category*, but gold wants criterion `1001642858`,
   which the vector path lands). Returns `{ ids: number[], method, score?, candidates? }`.
3. **Scorer id-swap** — `scoreRun` gains an optional `marketIds?: (number[] | null)[]` parallel to
   `plan.selectors`. When present, **selector pairing + "market found"** (step 3,
   [structural-scorer.ts:189](../../src/eval/structural-scorer.ts)) uses **id set-equality** vs gold
   `market_concept.id` (normalize single id → `[id]`, sort, compare) instead of `looseMatch`.
   Binding/line/odds run on the id-aligned pairs (a strict improvement, E3). Text mode stays as the
   fallback when `marketIds` is absent (Sprint 1 preserved).
4. **Harness wiring** — `run.ts`: after `extract`, for a `resolved` plan call `groundMarket` per
   selector (subject-aware) → `(number[]|null)[]`, pass to `scoreRun`. Banner →
   `Mode: GROUNDED (market axis by id)`. Add `--ground "<text>"` to eyeball grounding (mirrors
   `--query`). An ungroundable market → `null` → "market not grounded" failure (precision bias).

### Stage B — voyage-3 vectors (the tail)
5. **`src/resolver/embed.ts` (new)** — Voyage REST client, **zero new deps** (Node global `fetch`):
   `embed(texts, inputType: "document"|"query"): Promise<number[][]>`. `POST
   https://api.voyageai.com/v1/embeddings`, `{ input, model: "voyage-3", input_type }`, bearer
   `VOYAGE_API_KEY` (already in `.env`; `loadDotEnv` picks it up). Chunk to safe batch size.
   *(Verify endpoint/field names + batch/token limits against current Voyage docs when wiring.)*
6. **`src/resolver/build-market-index.ts` (new)** — script: embed all 607 criterion names as
   `"document"` → write `src/resolver/index/criterion-vectors.voyage-3.json` =
   `{ model, dim, builtAt, count, criterions: [{id, name, vec}] }`. npm `"build:index"`. Run once /
   when criterions or model change; model pinned in the filename so a swap = a new file.
   `.gitignore` the index (derived, needs the key to rebuild; committing for offline repro is a
   noted alternative).
7. **`ground-market.ts`, vector path** — load the cache at module init. On alias miss: `embed(text,
   "query")` → cosine vs the 607 cached vectors → top-k. Best ≥ threshold (start ~0.55, calibrate
   on the seeds; below → `none`, never a guess). In-memory cache keyed by `text|subjectKind` so the
   `--release` 5× runs don't re-embed identical (temp-0) text.

### Stage C — subject-aware side-split (the id-SET case)
8. The one narrow pattern: when `subjectKind ∈ {team, either_match_team}` and the resolved concept
   is a side-agnostic total (`"Total Goals"`) that has `"… by Home Team"` / `"… by Away Team"`
   sibling criteria, return the **pair** `{home, away}` (g001's third selector). Keep it a **single
   data-driven pattern** (detect the "by Home/Away Team" sibling naming), **not** a growing table —
   validated by g001, flagged for revisit as more team-total-style markets appear.

## Key design decisions / consequences
- **Vectors are primary; aliases are a fast-path** for known criterion-name phrasings. Proven by
  the seeds: `g003` BTTS is landed by the *vector* path (near-exact name) despite its alias pointing
  at a category — a real test that vectors work even when the alias is the wrong granularity.
- **Alias neutrality (E8) is a hard rule.** Do **not** add gold `accept[]` surface forms to the
  alias tables to force a pass — that makes the grounder a copy of the answer key and blinds the
  test. A head term vectors can't resolve is a threshold/vector issue, not a licence to hand-add it.
- **Grounding is async; scoring stays sync.** The harness pre-grounds; `scoreRun` compares ids — no
  network in the scorer, and the text-mode path is untouched for any future no-key run.
- **SQLite deferred (decision 10).** The in-memory map + JSON vector cache is the same structure
  SQLite would later hydrate; `groundMarket` is the interface SQLite slots under in step 2. Nothing
  here is throwaway.
- **Precision bias (E5).** Below-threshold / unmapped → `none` → fail, never a low-confidence guess.

## Critical files
- **Reuse:** `src/resolver/schema.ts` (`QueryPlan`, subject kinds), `src/eval/gold-record.ts`
  (`Grounded.id: number|number[]`), `src/eval/structural-scorer.ts` (extend `scoreRun`), `src/eval/run.ts`
  (pre-ground + wire), `data/football/football_criterions.json`, `data/football/aliases.json`,
  `data/football/derived-aliases.json`.
- **New:** `src/resolver/catalog.ts`, `src/resolver/embed.ts`, `src/resolver/build-market-index.ts`,
  `src/resolver/ground-market.ts`, `src/resolver/index/criterion-vectors.voyage-3.json` (built artifact).
- **Edit:** `package.json` (`build:index` script), `.env.example` (add `VOYAGE_API_KEY=`),
  `.gitignore` (add `src/resolver/index/`).

## Verification (end-to-end)
1. `npm run build:index` — embeds 607 names via voyage-3, writes the cache (needs `VOYAGE_API_KEY`).
2. `npm run eval -- --ground "shots on target"` → `2100015085`; `"corner markets"` → `1001159897`;
   `"both teams to score"` → `1001642858`. Eyeball a few off-seed probes (`"clean sheet"`,
   `"anytime scorer"`) for sanity.
3. `npm run eval -- --id g001` — market axis by id; the three selectors resolve as in the demo,
   incl. the `team total goals` **side-split pair** (Stage C, the riskiest).
4. `npm run typecheck` clean; `npm run eval` — g001/g002/g003. g002 (`unsupported`) untouched; g003
   BTTS lands `1001642858` by id; ship gate PASS.
5. `npm run eval -- --release` (5×) — confirm temp-0 reproducibility holds with grounding in the loop.

## Out of scope (explicit)
Entity/player/team/competition grounding; `attrFilter`→id-set & the region table; the SQLite build
pipeline / versioned artifact; the executor & live event layer; corpus expansion. Doc steps 2–8.
