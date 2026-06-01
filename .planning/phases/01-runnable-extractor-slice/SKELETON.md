# Walking Skeleton — Intent Resolver (Extractor Slice)

**Phase:** 1
**Generated:** 2026-06-01

> Domain note: this project is a Node CLI + library that calls an LLM. It has NO web routing, NO database, and NO UI. The web-app-oriented skeleton checklist is adapted to this domain (see the mapping in "Stack Touched in Phase 1"). DB / UI / web-routing / cloud-deploy are explicitly Out of Scope so later phases do not re-litigate Phase 1's minimalism.

## Capability Proven End-to-End

Running `npm run extract "<query>"` sends the query to Claude Haiku (model `claude-haiku-4-5-20251001`, temperature 0, forced single-tool use) and prints a Zod-validated `QueryPlan` to stdout, with the response cached so an identical re-run makes zero API calls.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime / language | Node 20+ (verified v24.3.0), TypeScript strict, ESM (`"type": "module"`), run via `tsx` | D-05. `tsx` runs `.ts` directly with zero build step and lenient ESM resolution; strict TS matches the house schema-first style. |
| Structured output | Forced single tool `emit_query_plan` via `tool_choice: { type: "tool", name }`; read `tool_use.input.plan` | D-01. Most reliable structured-output path on the Anthropic SDK; JSON-prefill / free-text-then-parse rejected. |
| Schema source of truth | `resolver/schema.ts` Zod `QueryPlan`; tool `input_schema` auto-generated via `zod-to-json-schema` from `z.object({ plan: QueryPlan })` (the union must be wrapped); Zod `.safeParse` ALWAYS re-validates after the call | D-02/D-04. JSON Schema is best-effort (cannot express `.refine()` rules); Zod is the single gate. RESEARCH verified the wrap is mandatory (a bare top-level discriminated union is rejected). |
| Zod major | Zod 3.25.x + `zod-to-json-schema` (NOT Zod 4) | RESEARCH verified `zod-to-json-schema@3.25.2` is broken under Zod 4 (returns an empty schema). Pinning Zod 3 honors D-05's dep list verbatim. |
| Model | `claude-haiku-4-5-20251001`, temperature 0 | D-03. Cheapest tier is sufficient because all hard work is deterministic; model id is part of the cache key. |
| "Data layer" (persistent I/O) | Local gitignored JSON cache at `.cache/extract.json`, keyed `sha256(query + prompt-contents + model)` | D-07. The repo has no DB; the cache is the only persistent read+write the skeleton proves. Hashing prompt CONTENTS (not path) makes a prompt/model change invalidate naturally. |
| "Entry point" | The CLI `npm run extract "<query>"` -> `tsx resolver/cli.ts`; core in `resolver/extract.ts` kept importable | D-06. There is no web route. Core stays side-effect-light so the Phase 2 scorer imports it directly instead of shelling out. |
| Failure handling | Typed `ExtractResult`: `api_error` / `no_tool_use` / `schema_validation` to stderr (exit 1), valid plan to stdout (exit 0); `config_error` env-guard before any call | D-09/D-10. Precision >> recall: never silently accept a malformed plan; retain raw input on `schema_validation` (E4). No retry at temp 0. |
| Directory layout | Flat `resolver/` module: `schema.ts` (existing), `extractor-prompt.md` (existing), `tool-schema.ts`, `extract.ts`, `cache.ts`, `cli.ts` | PATTERNS. I/O shell (`cli.ts`) separated from the importable core (`extract.ts`) and the deterministic transforms (`tool-schema.ts`, `cache.ts`). |
| Install / registry | Project `.npmrc` pins `registry=https://registry.npmjs.org/` | RESEARCH Pitfall 1: a stale global `.npmrc` 401s on public packages; the project override (verified) keeps `npm install` (BOOT-01) green. |

## Stack Touched in Phase 1

(Adapted to this CLI+LLM domain — see the domain note above.)

- [x] **Project scaffold** — `package.json` (ESM, scripts `extract` + `typecheck`), `tsconfig.json` (strict, NodeNext), `.npmrc`, `.gitignore`, deps installed; `npm install` + `tsc --noEmit` pass (BOOT-01).
- [x] **Entry point** (replaces "routing") — `npm run extract "<query>"` -> `resolver/cli.ts`, the single real entry point. No web routing.
- [x] **Persistent I/O** (replaces "database read AND write") — one real WRITE (a cache miss persists the response to `.cache/extract.json`) and one real READ (an identical re-run returns the cached response with zero API calls) (EXT-03).
- [x] **External interaction** (replaces "UI interactive element") — the live Claude Haiku API call via forced tool-use returns a structured plan, validated and printed to stdout (EXT-01/EXT-02).
- [x] **Deployment** (replaces "deploy") — documented local full-stack run command: `npm run extract "<query>"` runs the whole slice end-to-end locally; `npm run extract -- --fresh "<query>"` runs the release-grade 5x reproducibility check (EXT-04).

## Out of Scope (Deferred to Later Slices)

> Explicit so later phases do not re-litigate Phase 1's minimalism.

- A web server / HTTP routing / any deployed cloud service — this is a local CLI + importable library. (Out of scope entirely for the project per the architecture; the runtime target is a single long-lived service that loads a static artifact, not a per-request web app.)
- A database / ORM / SQLite store / FTS5 / embeddings — the static store is a later build-pipeline concern; the only persistence now is the local response cache. (REQUIREMENTS "Out of Scope".)
- Any UI / front end — the surface is stdout/stderr JSON.
- The scorer, the report, the tiered-gate verdict, 5x-all-PASS aggregation, storing all 5 responses — Phase 2.
- Gold-corpus expansion (~2/tag, ~35 records) — Phase 3.
- Grounding (text facets -> catalog ids), id-graded eval axes, the live/executor layer — next milestone (explicitly out of scope).
- Editing `resolver/extractor-prompt.md` to make any query pass — forbidden by the bounded-prompt constraint (decision 16); it is an input only and is hashed into the cache key.

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton WITHOUT altering its architectural decisions (model, forced-tool-use, Zod-as-gate, cache shape, importable core):

- **Phase 2 — Scorer + Report, Validated on Seeds:** import `extractOnce` directly (the D-06 forward seam), grade the no-grounding axes on raw extractor output, emit per-axis/per-tag/tiered-gate report, and prove the whole pipeline correct on the 3 seed records via `npm test`.
- **Phase 3 — Corpus Expansion + Baseline Report:** widen the gold corpus to ~2 records per behavior tag (~35), run the full corpus through the same harness, and emit the trustworthy baseline report.
- **Next milestone (deferred):** grounding (text -> catalog ids), id-graded axes, the full ~5/tag corpus, and prompt-tuning to a green ship gate.
