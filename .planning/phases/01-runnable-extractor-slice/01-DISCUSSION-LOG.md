# Phase 1: Runnable Extractor Slice - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-01
**Phase:** 1-Runnable Extractor Slice
**Areas discussed:** Structured-output mechanism + model

---

## Structured-output mechanism + model

### Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Forced tool-use | Define one tool, force it via `tool_choice`, read `tool_use.input` | ✓ |
| JSON prefill | Prefill assistant turn with `{` and parse the completion | |
| Free-text + parse | Ask for JSON in prose, then `JSON.parse` the reply | |

**User's choice:** Forced tool-use
**Notes:** Most reliable structured-output path on the Anthropic SDK; avoids brittle text parsing.

### Tool schema source

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-gen from Zod, Zod re-validates | Generate tool `input_schema` from `schema.ts` via `zod-to-json-schema`; real Zod schema re-validates output | ✓ |
| Hand-write JSON Schema | Maintain a separate hand-authored tool schema | |
| Trust tool output | Accept `tool_use.input` without re-validation | |

**User's choice:** Auto-gen from Zod, Zod re-validates
**Notes:** Single source of truth = `schema.ts`. Zod `.refine()` rules can't be expressed in JSON Schema, so post-call Zod validation is mandatory.

### Model

| Option | Description | Selected |
|--------|-------------|----------|
| Latest Haiku 4.5 | `claude-haiku-4-5-20251001` | ✓ |
| Arch-doc Haiku 3.5 | `claude-3-5-haiku-20241022` (as written in revisiting_Arch.md) | |

**User's choice:** Latest Haiku 4.5
**Notes:** Supersedes the arch doc id; model id is part of the cache key so the choice is captured in invalidation.

### Schema strictness

| Option | Description | Selected |
|--------|-------------|----------|
| Full strict union, Zod is source of truth | Send full strict discriminated-union schema; surface any Zod failure | ✓ |
| Relaxed/flattened schema | Send a looser schema to ease the model | |

**User's choice:** Full strict union, Zod is source of truth
**Notes:** No silent patching/coercion. Relaxed schema kept as a deferred fallback only if strict underperforms.

---

## Claude's Discretion

The user selected only the "Structured-output mechanism + model" area to discuss and accepted recommended defaults for the rest:
- **TypeScript tooling & layout:** `tsx` + ESM + strict TS, Node 20+; core in `resolver/extract.ts`, CLI in `resolver/cli.ts`.
- **Cache:** single gitignored `.cache/extract.json` map; key = `sha256(query ⊕ promptFileHash ⊕ modelId)`; `--fresh` bypasses read and runs 5×.
- **Failure handling & output:** validated plan → stdout/exit 0; typed failures (`api_error`/`no_tool_use`/`schema_validation`) → JSON on stderr/exit 1, retaining raw plan on schema failure (E4); fail fast on missing API key; no retry at temp 0.

## Deferred Ideas

- 5×-all-pass aggregation & storing all 5 responses → Phase 2.
- Relaxed/flattened tool schema fallback → only if strict underperforms.
- Scorer, report, tiered-gate verdict → Phase 2.
- Gold-corpus expansion (~2/tag) → Phase 3.
- Grounding, id-graded axes, live/executor layer → next milestone.
