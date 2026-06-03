# Sprint Status Log

Progress log for sprints under `planning/sprints/`. Each sprint gets timestamped entries,
newest on top. A sprint's plan lives in its own `sprint-N.md`.

---

## Sprint 3 — Collision handling: catalog rebuild + subject-filtered, tiered grounding

Plan: [sprint-3.md](sprint-3.md)

### 2026-06-03 — Stage B complete; Stage C code-complete (E13 scorer + tier threading); paid verification pending

**Stage B landed** (the older entry below saying "B not started" is now stale). `ground-market.ts` runs the
full decision-20 chain: hard **subject pre-filter** (`bySubject[kind]`), **`line→boType` gate** + **period
SOFT penalty**, and a **`tier`** on `GroundResult` (`confident | variants | ambiguous`; below threshold →
`none`, E5). Added a **named-team per-side divert** (a query naming one team that lands on a match-level
market diverts to that team's side-split). Seed-probed green.

**Two collision refinements beyond the plan.** (1) **Grounder-side exact-name canonicalization** — the
exact-name step now tries the bare text, then a **settlement-suffix-stripped** index ("… (Settled using
Opta data)"), then the catalog's **"Player X"/"Player's X"** registers; bare-first. (2) **Extractor
canonical phrasing** (`extractor-prompt.md`) — a bare count noun emits `"total <noun>"` ("Over 2.5 goals" →
"total goals"), and a player yes/no achievement emits the infinitive ("anytime goalscorer" → "to score",
"clean sheet" → "to keep a clean sheet"). Both push the market into the catalog's own register so the
deterministic exact-name path fires instead of a fuzzy collision — fixes "shots on target" → `2100015085`
(was grounding to the narrower "Headed Shots on Target"). Probes logged in
[EvaledQueries.md](../queries/EvaledQueries.md).

**Stage C steps 9 + 8 (this change).** *Step 9 (threading):* `groundSelectors` now returns the full
`(GroundResult | null)[]` (ids **+ tier**) instead of bare id-arrays; `scoreRun` takes `grounded[]` (a
**type-only** import of `GroundResult` — runtime stays acyclic, since `ground-market` imports `normalize`
the other way); banner → `Mode: GROUNDED (market axis by id; tiered, subject-filtered)`. *Step 8 (E13
grading):* the market axis moved from id **set-equality** → **containment + tier** — `idsContainGold`
replaces `idSetEqual`; a pair needs the gold id(s) **⊆** the returned ids AND `tier ∈ {confident,
variants}`; a containing-but-`ambiguous` selector becomes a recorded **failure** ("ask the user", never a
green cell — the doc's rejected "containment alone" case). `npm run typecheck` clean; a 6-case offline unit
check (no API) passes — incl. the key upgrade *variants-containing-single-gold now PASSES* (set-equality
failed it) and *ambiguous-containing-gold FAILS*.

**Remaining for Stage C.** Only the **paid-Haiku verification suite** is left (awaiting go-ahead before
spending): `--id g001` under E13, full `npm run eval` ship gate (g002 untouched, g003 BTTS → `1001642858`),
and `--release` 5×. Three knobs (threshold+ε, suffix strip-list, quarantine guard) stay uncalibrated by
design.

### 2026-06-03 — Stage A: full category feed decorated + catalog re-joined (FULL union)

Pulled the **full** offering-api category feed and added `src/resolver/build-categories.ts` (npm
`build:categories`, pure local transform — no API). It collapses the **28 UI `categoryGroups`** (retail /
digital-signage / player_props / *_us / list_view…) into the flat shape `build-catalog.ts` joins against:
dedupe categories by id (a category id is one logical category regardless of UI group — `categoryGroupName`
ignored, per the feed owner), union each id's mappings (deduped by `criterionId|boType`), and resolve numeric
`boType → boTypeName` via the inverted `football_betoffertypes.json`. Committed the raw response as
`football_categories.raw.json` (mirrors the criterions raw snapshot) so the build is reproducible/cron-ready.
Result: **395 categories, 11927 mappings, 8550 distinct criterions**.

**Two decisions worth recording.** (1) Category NAME = the feed's `name` (lang=en_GB display label), **not
`englishName`** — `englishName` is sometimes an internal slug or a different label ("Total Goals"→"totals",
"Full Time"→"Match"), and subject tagging keys off the display name, so a wrong name silently mis-buckets a
whole category. (2) boType ids **5 (9 mappings) and 15 (7 mappings)** aren't in `football_betoffertypes.json`
(scattered across Other Bets / Penalty Shootout / Team Progress) — `boTypeName` is **omitted** (numeric
`boType` kept) rather than guessed; `build-catalog.ts` already guards `if (m.boTypeName)`, so the criterion
still joins its category, just with no boType-gate signal.

**Re-ran `build:catalog` against the full feed (version `0f2aac930df9`).** Referenced **8550** →
**kept 2486 + quarantined 2437 + 3627 dropped** (referenced by categories but absent from the criterion
feed). Partition is exact (2486+2437+3627=8550) and the **groundable 4923 / missing 3627** split matches the
pre-build coverage estimate to the unit. Subject **player 705 / team_or_match 1781**; g001's `2100015085`
present, tagged player, boTypes `[head, overunder, playeroccurrenceline]`. Quarantine eyeball: 514 generic
scorer markets kept ("To Score", "Next Goalscorer", g001); every quarantined "generic-looking" row is a real
per-player combo ("Total Shots on Target by Alexander Isak & Marcus Berg"). Typecheck clean.

**The 3627 gap is the criterion feed, not the join.** `football_criterions.raw.json` simply doesn't contain
those ids — the categories reference markets the criterion snapshot lacks. Closing it fully needs a richer
criterion feed; the build reports the gap loudly (the `⚠ … no en_GB name` line) rather than hiding it.

**Index rebuilt to match** (paid Voyage `npm run build:index`, user go-ahead 2026-06-03):
`criterion-vectors.voyage-3.json` — **2486 vectors, dim 1024, catalogVersion `0f2aac930df9`**. Verified
1:1 against the kept set (no missing/extra ids), every entry carries `subject` + `boTypeNames` for the
query-time gates, and g001 `2100015085` is present (player, 1024-dim). Stage A is now end-to-end complete
(categories → catalog → index). Stages B (subject-filtered/tiered grounding) and C (E13 scorer) not started.

### 2026-06-03 — Stage A (catalog rebuild) code-complete; index re-embed pending

Built the rebuild prerequisite. New `src/resolver/build-catalog.ts` (npm `build:catalog`, pure local
join — no API) joins the **full** raw criterion feed ⋈ category feed, subject-tags each criterion,
quarantines per-player pre-baked rows, and stamps a content **version**. Verified output:
**referenced 1151 → kept 1093 + quarantined 58**; subject **player 372 / team_or_match 721**; g001's
`2100015085` "Player Shots on Target" is back, tagged **player**, and `byName` resolves it; typecheck
clean; the loader reads the new artifact. `catalog.ts` now exposes `subject`/`bySubject`/`version`;
`build-market-index.ts` carries `subject`+`boTypeNames` per entry and stamps `catalogVersion` (code only).

**Subject-tag refined (deviates from the literal plan; user-confirmed).** The written `Player*`-prefix
rule mislabels **13 real player markets** (Goal Scorer "To Score"/first/last, Either Player ×5, Man of
the Match ×2). Rule is now **curated player-category set** (10 `Player*` + {Goal Scorer, Either Player,
Man of the Match, Goalkeeper Saves}) **minus explicit team-side rows** ("- Home/Away Team", the 2 mixed
GK-saves rows) → all 15 edge cases correct. Decision 20 updated. Quarantine needed **diacritic folding**
(NFD) — en_GB names ASCII-flatten player names ("Muller") while the participant feed keeps diacritics
("Müller"); without folding only 8 matched, with it **58** (all real full names; common-word guard holds).

**Remaining for Stage A:** `npm run build:index` — a **paid Voyage** re-embed of the 1093 post-quarantine
names into a version-stamped index. The current index is **stale** (600 ids, no version stamp, missing
`2100015085`), so vector grounding can't hit the target until it's rebuilt. **Awaiting go-ahead** before
spending. Stages B (subject-filtered/tiered grounding) and C (E13 scorer) not started.

### 2026-06-03 — Plan drafted (not started)

Designed the same-vocabulary collision fix (architecture **decision 20** + eval **E13**): deterministic
**subject pre-filter → cosine → facet-boost → tier**, replacing Sprint 2's single-id raw cosine. Staged
A (catalog rebuild — full criterion⋈category join, subject tag, participant quarantine, version stamp) →
B (`ground-market.ts`: hard subject filter, `line→boType` gate + period penalty, `tier` on `GroundResult`)
→ C (`structural-scorer.ts` E13: containment + tier-aware grading). Verified prerequisite: the committed
criterions snapshot is **trimmed** — 598 listed vs **1151** category-referenced ids; **553 missing incl.
g001's `2100015085`** (315 of them `Player*`), so the target is ungroundable until the rebuild. Three knobs
left uncalibrated (threshold+ε, non-semantic suffix strip-list, quarantine common-word guard), each
fails-safe. Rejected: categories as a 2nd filter (redundant post-subject), cross-encoder (deferred),
suffix-penalty / LLM market-disambiguation (E8 gold-fitting / superseded). Implementation pending approval.

---

## Sprint 2 — Market grounding (criterion star) + id-graded market axis

Plan: [sprint-2.md](sprint-2.md)

### 2026-06-01 — Plan drafted (not started)

Drafted the Sprint 2 plan: ground `selector.market_concept` text → criterion id(s) via curated
alias (head) + voyage-3 cosine over criterion-name vectors (tail), then swap the scorer's market
axis from text (`accept[]`) to catalog id (doc E3). Staged A (catalog + alias + scorer id-swap) →
B (voyage-3 vectors + `build:index`) → C (subject-aware side-split for `team total goals`). SQLite
deferred (decision 10). Scope: market axis only — entities/competition/attrFilter stay text.
Implementation pending approval.

---

## Sprint 1 — Bootstrap a runnable structural eval

Plan: [sprint-1.md](sprint-1.md)

### 2026-06-01 13:05 CEST — Prompt refinements from ad-hoc probing (2 fixes)

Probed the extractor with 5 messy WC-26-style queries (Mbappé / Bellingham / Modrić /
Yamal / Bruno Fernandes) via `--query`. Two real issues found and fixed in
`resolver/extractor-prompt.md`; eval still 3/3, ship gate PASS (no regression).

1. **Empty-odds crash.** "…odds/price" with no number made Haiku emit `odds: {}`, which
   fails schema validation (`need >=1 bound`). Added an odds-section rule mirroring the
   existing line-no-number rule: a number-less price mention → omit `odds`, never emit `{}`.
   Confirmed: "team to score first odds" now omits odds instead of crashing.
2. **Self-correction miss.** "Haaland-less Norway out — sorry, with Modrić in the lineup"
   kept the retracted `Norway`. Rule 5 already covered the pattern; reinforced it with a
   matching worked example. Confirmed: `teams` now `[]`, only Modrić retained.

Note: these 5 probes are good candidates for gold records — they exercise the still-uncovered
tags `coref-his`, `coref-his-team`, `self-correction`, `player-role`, `line-no-number`.

---

### 2026-06-01 12:35 CEST — Sprint 1 COMPLETE — eval passes 3/3, ship gate PASS

**Status:** Done. The loop runs end-to-end against Haiku; `npm run eval` and
`npm run eval -- --release` both green. Typecheck clean.

**Live run results**
- `npm run eval` (1×): g001 / g002 / g003 all PASS. Ship gate PASS, exit 0.
- `npm run eval -- --release` (5×): 5/5 on all three — reproducible at temp 0 (E10).
- Critical tags binding / abstain / either-team / sport-default = 100%; soft stage /
  odds-only-bounds = 100%.

**Two fixes made during verification**
1. `eval/run.ts` `loadDotEnv` — was skipping a `.env` key when the shell already exported
   it as an **empty** string (`key in process.env` is true even for `""`). Changed the guard
   to skip only when the existing value is non-empty (`process.env[key]`).
2. `resolver/extract.ts` — Haiku serializes the `plan` tool field as a **JSON string**
   (not a nested object) because the wrapped field's schema is an `anyOf` (the status
   discriminated union — the doc's open question). Added a boundary decode: if `plan` comes
   back as a string, `JSON.parse` it before `QueryPlan` validation.

**First prompt-quality signal (resolved with user)**
- g003 ("Both teams to score markets priced over 1.90") initially failed: Haiku emitted
  `line {binary, yes}` + `odds {min:1.90}`, faithfully following the prompt's "named yes/no
  market defaults to yes" rule — but gold expects **odds-only** (price filter, no side).
- User ruled gold canonical. Added a **price-only exception** to the binary-line rule in
  `resolver/extractor-prompt.md`: a yes/no market named with only a price bound and no side
  word → omit `line`, emit only `odds`. g003 now passes 5/5.

**Removed** unused `zod-to-json-schema` dep (switched to zod v4 native `z.toJSONSchema`).

**Remaining (fast-follow, out of Sprint 1 scope)**
- [ ] Corpus expansion to ~5/tag, incl. the 11 currently-uncovered tags (coref-his,
      line-vs-price, attrFilter, player-role, level, time, self-correction, age-normalize, …).
- [ ] Grounding + the id-based scorer; catalog build pipeline; executor/live layer.

---

### 2026-06-01 12:10 CEST — Implementation code-complete (live run pending API key)

**Status:** All code written and statically verified. The live Haiku eval on the 3 seeds is
the one remaining step, blocked only on `ANTHROPIC_API_KEY` not being set in this environment.

**Completed**
- Project setup — `package.json`, `tsconfig.json` (strict + `noUncheckedIndexedAccess`),
  `.gitignore`, `.env.example`.
- Extractor runner — `resolver/extract.ts` (Haiku, `temperature: 0`, forced tool use via
  `emit_query_plan`, ~11 KB system prompt with `cache_control: ephemeral`).
- Structural scorer — `eval/structural-scorer.ts` (`normalize`/`looseMatch`, status gate,
  sport, market pairing vs `accept[]`, binding, line/odds, soft `event_scope`).
- Harness CLI — `eval/run.ts` (manual `.env` load, `--query`/`--id`/`--release`, per-tag
  pass-rate, ship gate, non-zero exit on critical miss).
- Switched to **zod v4 native** `z.toJSONSchema()`; uninstalled unused `zod-to-json-schema`.
- Verification done so far:
  - `npm run typecheck` — clean (no type errors).
  - `resolver/extract.ts` imports cleanly → `z.toJSONSchema` builds the input schema at load.
  - All 3 gold seeds validate against `GoldRecord`; scorer status-gate confirmed pass/fail
    offline (g002 unsupported-vs-unsupported → pass; unsupported-vs-resolved → fail).
  - Missing-key path exits cleanly with a clear message (exit 2).

**Remaining**
- [ ] Set `ANTHROPIC_API_KEY` (export or copy `.env.example` → `.env`), then run
      `npm run eval` on g001 / g002 / g003 and confirm per-record verdicts + ship gate.
- [ ] `npm run eval -- --release` (5×) to confirm temp-0 reproducibility.
- [ ] (fast-follow, out of scope) corpus expansion to ~5/tag + the id-based grounding scorer.

---

### 2026-06-01 11:33 CEST — Sprint kicked off

**Status:** Scaffolding only — implementation not started.

**Completed**
- `planning/sprints/` folder created.
- Plan captured in `sprint-1.md` (approved).

**Remaining**
- [ ] Project setup — `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`.
- [ ] Extractor runner — `resolver/extract.ts` (Haiku + forced tool use + prompt caching).
- [ ] Structural scorer — `eval/structural-scorer.ts` (+ `normalize`/`looseMatch` helper).
- [ ] Harness CLI — `eval/run.ts` (load gold, run N×, per-tag pass-rate, ship gate).
- [ ] Install deps + verify `npm run eval` on the 3 seeds (g001 / g002 / g003).
