# Sprint 1 — Bootstrap a runnable structural eval

> Source: approved plan `~/.claude/plans/users-amipan-documents-search-agent-rev-quirky-meteor.md`.
> Full architecture context lives in `revisiting_Arch.md` (decisions, E1–E12, plan steps 1–8).
> Progress is tracked in [STATUS.md](STATUS.md).

## Context

The Kambi intent-resolver design (`revisiting_Arch.md`) is settled, and the extractor's
inputs are already authored: the text-valued `QueryPlan` schema (`resolver/schema.ts`), the
bounded Haiku prompt (`resolver/extractor-prompt.md`), the gold-record schema
(`eval/gold-record.ts`), behavior tags (`eval/behavior-tags.ts`), the scorer algorithm spec
(`eval/scorer.spec.md`), and 3 seed gold records (`eval/gold.seed.jsonl`). **None of it runs**
— there is no `package.json`, no installed deps, no extractor runner, and no scorer code.

The doc's immediate next step is to **bootstrap a structural eval**. The insight (resume
prompt + plan-step-1 update, 2026-06-01): the no-grounding axes — `status`, `sport`,
`subject.kind`, line-vs-odds typing+values, `level`, `role`, `attrFilter`, plus **binding &
market matched by *text* against `accept[]`** — are gradeable on the **raw extractor output
now**, before grounding (and the catalog build pipeline) exists. That lets us iterate the
prompt against a real pass/fail signal immediately. This also matches the prior (now-deleted)
phase name `01-runnable-extractor-slice`.

**Outcome:** `npm run eval` runs each seed query through Haiku, validates the returned plan,
grades the costly structural facets, and prints per-record verdicts + per-tag pass-rates + a
ship-gate result — proving the loop end-to-end and giving the first signal on prompt quality.

## Scope (confirmed with user)

- **Harness only.** Build the runnable loop and validate on the existing 3 seeds. Corpus
  expansion (~50–70 records, ~5/tag, incl. missing abstain buckets) is a **fast-follow**, not
  this phase — much easier once a record can be run the moment it's written.
- **Text match = lenient containment.** Normalize (lowercase, trim, collapse whitespace) then
  match if the extractor string equals OR is contained-in/contains an `accept[]` entry.
- **Deferred (needs grounding, out of this phase):** the id-based scorer, the catalog build
  pipeline, `attrFilter`→id-set / region-table resolution, and the executor/live layer.

## Approach

### 1. Project setup (repo root — all new)
- **`package.json`** — deps: `zod`, `@anthropic-ai/sdk`, `zod-to-json-schema`; devDeps:
  `typescript`, `tsx`, `@types/node`. Scripts:
  - `"eval": "tsx eval/run.ts"` (default 1× per query while iterating).
  - `--release` flag → 5× per query (E10); `--id g001` → single record; `--query "..."` →
    ad-hoc one-off extraction (no grading) to eyeball the extractor.
- **`tsconfig.json`** — `strict`, `module`/`moduleResolution` for ESM + Node, `resolveJsonModule`,
  `esModuleInterop`. Matches the existing `import { z } from "zod"` style.
- **`.gitignore`** — `node_modules/`, `.env`, `.DS_Store` (repo currently has none).
- **`.env.example`** — `ANTHROPIC_API_KEY=`. Runner reads `process.env.ANTHROPIC_API_KEY`;
  load via Node's `--env-file=.env` in the npm script (no extra dep).

### 2. Extractor runner — `resolver/extract.ts` (new)
`extract(query: string): Promise<QueryPlan>`
- Read `extractor-prompt.md` once at module load → system prompt.
- Anthropic TS SDK `messages.create`:
  - model `claude-haiku-4-5-20251001`, `temperature: 0` (E10).
  - **system** = prompt as a text block with `cache_control: { type: "ephemeral" }` — the
    ~11 KB prompt is constant across every call, so caching is a real cost/latency win over a
    50–70-query × 5-run eval.
  - **structured output via forced tool use:** one tool `emit_query_plan` whose `input_schema`
    is the JSON Schema of `QueryPlan` (from `resolver/schema.ts`) via `zodToJsonSchema`;
    `tool_choice: { type: "tool", name: "emit_query_plan" }`. (Assumes the direct Anthropic API
    — flag if on Bedrock/Vertex.)
  - **messages** = the raw query as the user turn.
- Pull the `tool_use` block's `input`, validate with `QueryPlan.parse(...)` (reuse the existing
  schema). A parse failure surfaces as a run error (hard fail), not a silent pass.
- Note: zod discriminated unions compile to `anyOf` (doc open question) — `status` has 3
  branches today; watch branch adherence in the report.

### 3. Structural scorer — `eval/structural-scorer.ts` (new)
Implements the **text-mode subset** of `eval/scorer.spec.md` (id checks replaced by
`accept[]` text-match). Reuse `GoldRecord` (`eval/gold-record.ts`) and `QueryPlan`
(`resolver/schema.ts`). A small `normalize()` + `looseMatch(text, accept[])` helper (lenient
containment) is shared across checks.

`scoreRun(gold, plan): RunResult` —
1. **Status gate** — `plan.status === gold.expect.status`; mismatch = hard fail. If
   `unsupported`, loose-check `recognizedAs` (diagnostic only); `unsupported`/`ambiguous` end
   grading here. `resolved` → continue.
2. **Sport** — exact equality; wrong = hard fail.
3. **Selector pairing by market text** — pair each predicted selector to a gold selector when
   `market_concept` looseMatches that gold selector's market `accept[]` (greedy one-to-one,
   order-independent; report collisions). Compute markets-found recall + false positives.
4. **Per aligned pair, 3 axes (E3):** (a) market found (by pairing); (b) **binding** —
   `subject.kind` equal AND, for `player`/`team`, predicted `subject.name` looseMatches the
   gold subject's `name.accept[]`; bare for `either_match_team`/`event`; (c) **line/odds** —
   `line` exact (kind+direction+value), `odds` exact (min/max).
5. **event_scope (soft, tracked, non-blocking per spec)** — teams/competition text-match,
   `level`/`players[].role` enums, `players[].name` text, `stage`/`time` lenient. Diagnostics
   only — these do **not** gate a run pass.
- **Verdict (E5 costly facets):** run passes iff status + sport + markets-found recall 100%
  with 0 false-positive markets + binding on every pair + line/odds on every pair are all
  exact. Soft facets are tracked ("how close") but never earn/deny a pass — matching the doc's
  precision bias.

### 4. Harness CLI — `eval/run.ts` (new)
- Load `gold.meta.json`; validate every line of `gold.seed.jsonl` against `GoldRecord` (zod).
  (Structural mode skips E11 id-existence — no ids are used; ids stay in the file for the
  future grounding scorer.)
- For each record: call `extract()` N times (1 default / 5 `--release`); score each run;
  query passes iff **all N** runs pass; report pass-rate (e.g. `5/5`).
- Aggregate **per behavior tag** (a query contributes to every tag it carries); apply the
  ship gate using `CRITICAL_TAGS`/`SOFT_TAGS` from `behavior-tags.ts` (critical = 100%, soft
  ~90% aggregate — calibratable). **Exit non-zero** if any critical tag < 100% (CI-usable).
- On any fail, print the raw plan beside the gold for triage (E4).

## Key design decisions / consequences
- **`accept[]` becomes load-bearing** in structural mode (it's "diagnostic-only" for the
  future id scorer). The 3 seeds already populate it; future authoring must too. This is the
  text-fidelity layer the doc (E9) anticipated.
- **Costly vs soft gating mirrors `scorer.spec.md` exactly** — only status/sport/market/
  binding/line-odds block a pass; event_scope (incl. `level`, `stage`, `time`, `attrFilter`,
  player roles) is tracked. A soft-tagged query can still pass on costly facets — intended.
- **Structured output = forced tool use + prompt caching** (most portable; proven on Haiku).
  Structured-outputs `response_format` is a possible later swap, not needed now.
- The structural scorer is written so the **full id-based scorer later extends it** (swap
  `looseMatch(text, accept[])` for id-equality) — but no abstraction is built ahead of need.

## Critical files
- **Reuse:** `resolver/schema.ts` (`QueryPlan`), `resolver/extractor-prompt.md` (system prompt),
  `eval/gold-record.ts` (`GoldRecord`/`Grounded`), `eval/behavior-tags.ts`
  (`CRITICAL_TAGS`/`SOFT_TAGS`), `eval/gold.seed.jsonl`, `eval/gold.meta.json`,
  `eval/scorer.spec.md` (algorithm source of truth).
- **New:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `resolver/extract.ts`,
  `eval/structural-scorer.ts`, `eval/run.ts` (+ a tiny shared `normalize/looseMatch` helper).

## Verification (end-to-end)
1. `npm install`.
2. `export ANTHROPIC_API_KEY=...` (or copy `.env.example` → `.env`).
3. `npm run eval` — runs the 3 seeds × 1 through Haiku; prints per-record verdict, per-tag
   pass-rate, ship-gate result, and (on fail) the raw plan.
   - **Expected:** g002 (`unsupported`/tennis) and g003 (`sport-default` + odds-only) should
     pass cleanly; g001 (binding + `either_match_team` + numeric lines) is the real binding
     test. Any fail localizes to status / sport / markets-found / binding / line-odds.
4. `npm run eval -- --release` — 5× per query; confirms reproducibility at temp 0 (E10);
   pass only if 5/5.
5. `npm run eval -- --query "Spain opener with Lamine Yamal shots over 1.5"` — ad-hoc extraction
   sanity check (no grading).

Cost is trivial (~3 calls default, ~15 on release).

## Out of scope (explicit)
Grounding + the id-based scorer; the catalog build pipeline (SQLite artifact, embeddings,
alias/region tables); `attrFilter`/region id resolution; the executor & live event layer;
corpus expansion to ~5/tag. All tracked in `revisiting_Arch.md` plan steps 2–8.
