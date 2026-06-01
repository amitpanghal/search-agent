# Intent Resolver

## What This Is

A natural-language **intent resolver** over a Kambi sports-betting catalog. It turns a messy NL search query — e.g. *"Portugal vs Brazil quarterfinal with Bruno Fernandes corner markets, Vitinha shots on target over 0.5, and team total goals over 1.5"* — into a grounded, structured **query plan** (`{sport, event_scope, selectors[]}`) against the sportsbook catalog. Two stages: a Claude **Haiku** LLM **extracts** the query into a text-valued `QueryPlan`, then retrieval **grounds** the text facets to concrete catalog ids. A separate executor (out of scope) runs the plan. Built for a real sportsbook search box where precision matters because money is on the line.

**Current focus (this milestone):** stand up a runnable **structural eval harness** — wire the extractor on Haiku and build a scorer that runs queries through `extractor-prompt.md` and grades the *no-grounding* axes (everything gradeable on raw extractor output, before grounding exists).

## Core Value

High-precision resolution of fuzzy NL betting queries to the *correct* catalog markets and entities — showing the wrong market or wrong player is costly, so determinism and auditability beat coverage. Corollary that drives sequencing: **you cannot ship precision you cannot measure**, which is why the eval harness comes before grounding.

## Requirements

### Validated

<!-- Already built — inferred from the existing codebase + revisiting_Arch.md. -->

- ✓ Text-valued extractor schema (`resolver/schema.ts`) — status-discriminated `QueryPlan` (resolved/ambiguous/unsupported), four-way subject union, line numeric-vs-binary union, guarded `odds`/`attrFilter`, `event_scope` with player roles / level / stage / time — existing
- ✓ Bounded Haiku extraction prompt (`resolver/extractor-prompt.md`) — 3-step procedure, universal sport-agnostic reasoning, off-corpus examples — existing
- ✓ Golden eval-set design settled (decisions E1–E12 in `revisiting_Arch.md`) — grade-through-grounding, hybrid id/text coverage, per-market selector scoring with binding as its own axis, strict pass on costly facets, behavior-tag coverage, temp-0 ×5, tiered ship gate — existing (design)
- ✓ Eval scaffolding — gold-record type (`eval/gold-record.ts`), 17 behavior tags (`eval/behavior-tags.ts`), scorer spec (`eval/scorer.spec.md`), 3-record seed (`eval/gold.seed.jsonl`: g001 football, g002 tennis-unsupported, g003 sport-default), version stamp (`eval/gold.meta.json`) — existing
- ✓ Kambi football catalog data (`football/`) — criterions, categories, betoffertypes, participants, groups, aliases + Python refactor scripts — existing

### Active

<!-- This milestone: bootstrap a runnable structural eval harness. -->

- [ ] Project bootstrap — `package.json` + TypeScript + Zod + Anthropic SDK so the repo is runnable (nothing is today)
- [ ] Extractor runner — send a query to Claude Haiku (temp 0, structured output) against `extractor-prompt.md` + `schema.ts`, return a Zod-validated `QueryPlan`
- [ ] Response cache keyed by (query + prompt-hash + model), with a `--fresh` flag that forces a true 5× temp-0 release run
- [ ] Structural scorer — grade the no-grounding axes: `status`, `sport`, `subject.kind` + binding (text vs `accept[]`), market (text vs `accept[]`), line-vs-odds typing + values, `level`, player `role`, age-normalize, `attrFilter` routing; selectors paired by market (order-independent); wrong weighed worse than missing
- [ ] Reporting — per-axis + per-tag pass-rates + tiered-gate verdict (critical 100% / soft ~90%), retaining the raw text plan on failure for triage (E4)
- [ ] Harness validated end-to-end against the 3 seed records (known answers) before bulk authoring
- [ ] Corpus expanded to **~2 per behavior tag (~35 records)** — encode the arch doc's representative queries into structural gold records (text plan + tags + `accept[]` + `expect.status`, no ids), including the abstain/sentinel cases (no-sport → FOOTBALL default, named-unbuilt-sport → `unsupported`)
- [ ] `npm test` runs the corpus and emits the baseline report

### Out of Scope

<!-- Explicit boundaries with reasoning, to prevent re-adding. -->

- Retrieval **grounding** (text facets → catalog ids) — the next major milestone; the structural eval deliberately precedes it
- **id-graded eval axes** — depend on grounding; structural/enum/text axes only for now
- The **executor** + **live event layer** (fixtures, stage, time, lineup roles) — separate component, explicitly out of scope in the design
- **Static SQLite store** / FTS5 / embeddings — a build-pipeline milestone; not needed to grade raw extractor output
- **Position + age roster feed** + Kambi-id↔provider-id matching — the single genuinely expensive external dependency, deferred
- **Region static table** — grounding-era concern
- **Embedding model selection** (local ONNX vs API) — grounding-era
- **Full ~50–70 gold corpus (~5 per tag)** — deferred; this milestone targets ~2/tag to keep authoring bounded while exercising every behavior
- **Prompt-tuning to a green ship gate** — this milestone establishes the baseline; driving the gate to PASS is a follow-on effort that starts from that number
- **Disambiguation LLM call** (homonym / vector-tie clusters) — grounding-era
- **Multi-sport partitions** — only FOOTBALL is built; the `ambiguous` status (needs ≥2 built sports) cannot occur yet

## Context

- Greenfield design captured in `revisiting_Arch.md` (693 lines; decisions 1–19 + eval E1–E12). The architecture is settled — this milestone executes plan **step 1**'s "bootstrap a structural eval."
- The codebase map (`.planning/codebase/`) documents current state: TS schema + prompt + eval scaffolding + catalog data exist; **nothing is runnable** (no `package.json`, no installed deps).
- Founding insight: the hard problem is fuzzy **NL → catalog-id matching, not storage**; data is tiny (a few MB), so engineering goes to matching *quality*.
- The structural eval is possible **now** because the no-grounding axes (enums + text-matched binding/market against `accept[]`) grade on raw Haiku output, before grounding exists.
- Catalog data is for **WC 26**.

## Constraints

- **Extraction model**: Claude **Haiku**, temperature 0, structured output. — Cheapest tier is sufficient *because* all hard work is deterministic; do not compensate for the small model by stuffing the prompt.
- **Bounded prompt** (decision 16): only universal, sport-agnostic reasoning in `extractor-prompt.md`. — Do **not** "fix" failing eval queries by piling rules/examples into the prompt; new rule-instances go to the eval set, sport facts to the catalog. This is the hard constraint the eval exists to protect.
- **Off-corpus prompt examples**: a prompt example must never reuse an eval query/entity/market. — Reusing one leaks the graded answer and blinds that eval row.
- **Precision ≫ recall** (money on the line): a wrong answer is weighed worse than a missing one. — Never surface a hallucinated or semantically-fuzzed player/market.
- **Structural scope only**: grade the no-grounding axes; no ids, no grounding, no live layer this milestone. — Keeps the milestone shippable ahead of grounding.
- **Reproducibility** (E10): temp 0, run each query 5×, pass only if all 5 pass. — Consistency *is* correctness; a 1-in-5 wrong bet is unshippable. Cadence: 1 run/change, 5 before release.
- **Tiered ship gate** (E12): critical behaviors must be 100%; soft behaviors sit on a ~90% aggregate. — Percentages are calibratable; the principle (critical = 100, soft = aggregate) is fixed.
- **Only the FOOTBALL partition is built.**

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bootstrap the structural eval before grounding | No-grounding axes grade on raw Haiku output now; de-risks prompt + schema before the expensive grounding work | — Pending |
| Corpus target ~2/tag (~35), harness validated on the 3 seed first | Enough coverage to surface blind spots without over-investing in labeling; encode existing doc queries; never blocked on a working engine | — Pending |
| Done = a trustworthy baseline report, not prompt-tuned-to-green | "Build the scorer" ends at a trustworthy report; driving the gate green is open-ended, separate work | — Pending |
| Cache model responses + `--fresh` flag | Iteration harness: free scorer-code iteration (0 calls), honest 5× temp-0 release runs on demand | — Pending |
| (from design) Extraction on Haiku; bounded prompt; grade by text/enum pre-grounding | Decisions 16, 19, E2 — small model is safe only if the prompt stays universal and the eval protects it | ✓ Good (design-validated) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-01 after initialization*
