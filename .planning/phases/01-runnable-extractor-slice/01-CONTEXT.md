# Phase 1: Runnable Extractor Slice - Context

**Gathered:** 2026-06-01
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase makes the repo runnable for the first time and delivers a single end-to-end slice: **a NL query becomes a Zod-validated `QueryPlan` via Claude Haiku**. Concretely — `npm run extract "<query>"` reads `ANTHROPIC_API_KEY` from env, sends the query to Haiku (temp 0, structured output) using `resolver/extractor-prompt.md` + `resolver/schema.ts`, validates the result against the Zod schema, and prints it. Response caching (keyed by query + prompt-hash + model) and a release-grade `--fresh` 5× mode are included.

**NOT in this phase:** the scorer, the report, gold-corpus authoring, grounding, ids, the live/executor layer. Those are Phases 2–3 and the next milestone. The output here is a *validated plan printed to stdout* — nothing grades it yet.

</domain>

<decisions>
## Implementation Decisions

### Structured Output & Model (discussed, LOCKED)
- **D-01 — Forced tool-use:** Structured output is obtained by defining a single tool (e.g. `emit_query_plan`) and forcing it via `tool_choice: { type: "tool", name: "emit_query_plan" }`. The plan is read from `tool_use.input`. JSON-prefill and free-text-then-parse were considered and rejected — forced tool-use is the most reliable structured-output path on the Anthropic SDK.
- **D-02 — Schema is auto-generated from Zod; Zod always re-validates:** The tool's `input_schema` is generated from the `QueryPlan` Zod schema via `zod-to-json-schema` (single source of truth = `resolver/schema.ts`). The JSON Schema is **best-effort** — Zod `.refine()` rules (Odds `min<=max` / need ≥1 bound; AttrFilter need ≥1 predicate / `ageMin<=ageMax`; Stage needs round-or-ordinal; Time needs window-or-kickoff) cannot be expressed in JSON Schema. Therefore the real Zod schema **always** re-validates `tool_use.input` after the call. Refinements live only in Zod.
- **D-03 — Model:** `claude-haiku-4-5-20251001` (latest Haiku). This supersedes the arch doc's `claude-3-5-haiku-20241022`. Model id is part of the cache key, so this choice is captured in cache invalidation automatically.
- **D-04 — Full strict schema, no silent patching:** The full strict discriminated-union schema is sent to the model. Any Zod validation failure is surfaced as a typed failure (see Failure Handling) — never silently coerced, patched, or accepted. A relaxed/flattened schema is a deferred fallback (see Deferred Ideas), used only if the strict schema underperforms.

### TypeScript Tooling & Layout (Claude's discretion, user-confirmed)
- **D-05 — Runtime/tooling:** `tsx` for running TS directly, ESM (`"type": "module"` in package.json), `strict: true` TS, Node 20+. Deps: `typescript`, `tsx`, `zod`, `@anthropic-ai/sdk`, `zod-to-json-schema`.
- **D-06 — Layout:** Core extraction logic in `resolver/extract.ts` (a pure-ish async function: query → result), CLI entry in `resolver/cli.ts` (arg parsing, env check, printing, exit codes). `npm run extract "<q>"` maps to `tsx resolver/cli.ts`. Keeps the testable core separable from the I/O shell for Phase 2's scorer.

### Cache (Claude's discretion, user-confirmed)
- **D-07 — Shape:** A single gitignored JSON map file at `.cache/extract.json`. Key = `sha256(query ⊕ promptFileHash ⊕ modelId)` where `promptFileHash` is a hash of `resolver/extractor-prompt.md`'s contents. Value = one cached raw response. Editing the prompt or changing the model id naturally invalidates (new key). `.cache/` is gitignored.
- **D-08 — `--fresh` behavior:** `--fresh` bypasses the cache read, runs the query **5×** at temp 0, and writes one representative response back to the cache. (The 5×-all-pass *aggregation/scoring* is Phase 2; this phase only surfaces the 5 raw results — see D-10.)

### Failure Handling & Output (Claude's discretion, user-confirmed)
- **D-09 — Success path:** A validated `QueryPlan` is pretty-printed as JSON to stdout, exit 0.
- **D-10 — Failure path (typed, never silent):** Distinct failure kinds — `api_error`, `no_tool_use`, `schema_validation` — are printed as JSON to **stderr** with exit 1. On `schema_validation`, the **raw `tool_use.input`** is retained in the error payload for triage (satisfies E4: keep the raw plan on failure). No retry on temp 0 (a retry can't change a deterministic result). Missing `ANTHROPIC_API_KEY` fails fast **before** any query is sent, with a clear, actionable message.
- **D-11 — `--fresh` output:** Prints 5 numbered result blocks plus a final line stating whether all 5 were identical (a cheap reproducibility signal; formal all-5-pass gating is Phase 2).

### Claude's Discretion
Tooling/layout/cache/failure-output shapes above (D-05..D-11) were taken as recommended defaults and confirmed by the user — downstream planning may refine exact file names, the cache serialization details, and CLI flag parsing, as long as the LOCKED structured-output/model decisions (D-01..D-04) and the success criteria hold.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Decisions
- `revisiting_Arch.md` — settled greenfield design. Relevant: decision 16 (bounded prompt — never add eval instances to the prompt), decision 18 (the QueryPlan schema shape), decision 19 (Haiku temp-0 structured output), E4 (retain raw plan on failure), E10 (temp-0 ×5 reproducibility).
- `.planning/PROJECT.md` — core value (precision ≫ recall), constraints, out-of-scope boundaries.
- `.planning/REQUIREMENTS.md` — this phase implements BOOT-01, BOOT-02, EXT-01, EXT-02, EXT-03, EXT-04.
- `.planning/ROADMAP.md` §"Phase 1" — the 5 success criteria this phase must satisfy.

### Contracts (the code this phase wires up)
- `resolver/schema.ts` — the `QueryPlan` Zod schema. This is the single source of truth: it drives the auto-generated tool `input_schema` AND is the post-call validation gate. Note the `.refine()` rules that JSON Schema cannot express.
- `resolver/extractor-prompt.md` — the Haiku system prompt (3-step procedure). Its file contents are hashed into the cache key. **Do not edit it to make any query pass** (bounded-prompt constraint).

### Downstream (read for forward-compatibility, not built here)
- `eval/gold.seed.jsonl` — the 3 seed records (g001 football, g002 tennis→unsupported, g003 no-sport→FOOTBALL default). Phase 2 validates the harness against these; useful here only to sanity-check that real queries produce plausibly-shaped plans.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolver/schema.ts`: Already defines the complete `QueryPlan` contract — no schema authoring needed. Import it directly for both tool-schema generation (`zod-to-json-schema`) and post-call validation (`.safeParse`).
- `resolver/extractor-prompt.md`: Ready-to-use system prompt — load its contents at runtime as the `system` parameter and hash the same contents for the cache key.

### Established Patterns
- The codebase is TypeScript + Zod by convention (schema.ts is strict Zod). New files follow the same strict-typed, schema-first style.
- Discriminated unions on a literal tag (`status`, `kind`) are the schema idiom; the extractor just returns whatever the model emits and lets Zod discriminate.

### Integration Points
- **Anthropic SDK** (`@anthropic-ai/sdk`, to be installed): the one external call. `messages.create` with `system` = prompt file, `tools` = [generated schema], `tool_choice` = forced, `temperature: 0`, `model` = `claude-haiku-4-5-20251001`.
- **Env**: `ANTHROPIC_API_KEY` read from `process.env`, checked before any call.
- **Filesystem**: `.cache/extract.json` (read/write), `resolver/extractor-prompt.md` (read + hash).
- **Forward seam for Phase 2**: keep `extract.ts`'s core function importable and side-effect-light so the scorer can call it directly instead of shelling out to the CLI.

</code_context>

<specifics>
## Specific Ideas

- Canonical smoke query (from ROADMAP success criterion 2): `npm run extract "Both teams to score markets priced over 1.90"` must produce a Zod-valid `QueryPlan`. Use it as the manual acceptance check.
- Reproducibility signal in `--fresh` should be a literal "all 5 identical: yes/no" line — concrete, not a stats dump (full aggregation is Phase 2).
- Error payloads are JSON (machine-greppable) on stderr, not prose — so Phase 2 / CI can branch on `kind`.

</specifics>

<deferred>
## Deferred Ideas

- **5×-all-pass aggregation & storing all 5 responses** → Phase 2 (the scorer decides pass/fail across the 5; this phase only displays them).
- **Relaxed/flattened tool schema fallback** → only if the full strict discriminated-union schema underperforms in practice. Default is strict (D-04).
- **Scorer, report, tiered-gate verdict** → Phase 2.
- **Gold-corpus expansion (~2/tag, ~35 records)** → Phase 3.
- **Grounding (text facets → catalog ids), id-graded axes, live/executor layer** → next milestone (explicitly out of scope).

None — discussion stayed within phase scope otherwise.

</deferred>

---

*Phase: 1-Runnable Extractor Slice*
*Context gathered: 2026-06-01*
