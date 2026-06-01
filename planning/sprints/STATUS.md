# Sprint Status Log

Progress log for sprints under `planning/sprints/`. Each sprint gets timestamped entries,
newest on top. A sprint's plan lives in its own `sprint-N.md`.

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
