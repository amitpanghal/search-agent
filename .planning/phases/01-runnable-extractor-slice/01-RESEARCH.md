# Phase 1: Runnable Extractor Slice - Research

**Researched:** 2026-06-01
**Domain:** Anthropic SDK forced tool-use (structured output) on Claude Haiku 4.5 + Zod schema → JSON Schema bridge, run via tsx/ESM, with a sha256-keyed JSON cache.
**Confidence:** HIGH (all integration points verified by live install + execution against the real `resolver/schema.ts`)

## Summary

This phase wires the first runnable slice: `npm run extract "<query>"` → Haiku → Zod-valid `QueryPlan`. The stack (`@anthropic-ai/sdk`, `zod`, `zod-to-json-schema`, `tsx`, `typescript`) is mainstream and verified to install and run together. Three integration points carry all the risk, and I verified each by executing real code against the actual `resolver/schema.ts`:

1. **Top-level discriminated-union → `input_schema` mismatch (highest risk).** `QueryPlan` is a `z.discriminatedUnion("status", …)`, which emits a top-level `oneOf`/`anyOf` — **not** `type:"object"`. Anthropic's tool `input_schema` *requires* `type:"object"` [CITED: platform.claude.com/docs/.../define-tools]. **Fix (verified):** wrap as `z.object({ plan: QueryPlan })` before converting; read `tool_use.input.plan` and validate `.plan` against the bare `QueryPlan` schema.
2. **Zod 3 vs Zod 4 changes which converter you use (sharp edge).** `zod` latest is **4.4.3**; `zod-to-json-schema@3.25.2` is **broken under Zod 4** (it returns just `{$schema}` — empty — for a Zod-4 discriminated union; verified live). Under **Zod 4 you must use the built-in `z.toJSONSchema()`** instead. Under **Zod 3.25.x** the `zod-to-json-schema` package works as D-05 assumes. Both paths produce a valid wrapped `type:"object"` schema. **Recommendation:** pin **Zod 3.25.x + `zod-to-json-schema`** to honor D-05's dep list verbatim and avoid the Zod-4 converter swap; an equally-valid alternative is **Zod 4 + native `z.toJSONSchema` (drop the package)**.
3. **`.refine()` rules are dropped from JSON Schema (by design, and fine).** The `Odds`/`AttrFilter`/`Stage`/`Time` refinements cannot be expressed in JSON Schema and are silently omitted by both converters. This is exactly what D-02 anticipates: the JSON Schema is best-effort; the real Zod schema **re-validates** `tool_use.input.plan` after the call and *that* enforces refinements. Verified: `QueryPlan.safeParse({…odds:{min:5,max:1}})` → `success:false` post-call.

The model id `claude-haiku-4-5-20251001` is correct and confirmed to support forced tool use.

**Primary recommendation:** Pin Zod **3.25.x** + `zod-to-json-schema`; generate the tool `input_schema` from `z.object({ plan: QueryPlan })` (strip `$schema`); force `tool_choice:{type:"tool", name:"emit_query_plan"}`; read `tool_use.input.plan`; **always** `QueryPlan.safeParse` it; emit typed failures on `api_error`/`no_tool_use`/`schema_validation`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BOOT-01 | Repo runnable; `package.json` w/ TS+Zod+Anthropic SDK; `npm install` succeeds; `schema.ts` type-checks | Verified dep set + versions (Standard Stack); `schema.ts` compiles & runs under Zod 4 via tsx (and trivially under Zod 3). `tsconfig.json` settings below. **Registry gotcha discovered — see Environment Availability.** |
| BOOT-02 | API key from env; missing key fails fast with clear error before any query | SDK auto-reads `process.env.ANTHROPIC_API_KEY`; recommend an explicit pre-flight `if (!process.env.ANTHROPIC_API_KEY)` check in `cli.ts` so the error is *actionable* and fires before the call (Code Examples §Env guard). |
| EXT-01 | Send query to Haiku (temp 0, structured output) using prompt + schema → `QueryPlan` | Full verified `messages.create` shape (Code Examples §Extract call). Model `claude-haiku-4-5-20251001`, `temperature:0`, forced tool-use. |
| EXT-02 | Validate against Zod; malformed output → typed failure, never silently accepted | `QueryPlan.safeParse(tool_use.input.plan)`; on `!success` emit `schema_validation` failure retaining raw input (D-10/E4). Refinements enforced here (verified). |
| EXT-03 | Cache keyed by (query + prompt-hash + model) → re-run = zero API calls | `node:crypto` sha256 over `query ⊕ promptFileHash ⊕ modelId`; single JSON map at `.cache/extract.json` (Code Examples §Cache). |
| EXT-04 | `--fresh` bypasses cache, runs 5× at temp 0 (reproducibility, E10) | `--fresh` skips read, loops 5×, prints 5 blocks + "all 5 identical: yes/no", writes one back (D-08/D-11). Determinism caveat below (Key Q4). |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| NL → text `QueryPlan` (reasoning) | LLM (Haiku) | — | Subject binding/coref is language understanding; the only place it belongs. |
| Tool `input_schema` generation | Build/runtime (Node, `zod-to-json-schema`) | — | Deterministic transform of the single-source Zod schema; no model involvement. |
| Output validation (incl. refinements) | Node (Zod `safeParse`) | — | JSON Schema is lossy; Zod is the source of truth and the gate (D-02/D-04). |
| Caching | Node FS (`.cache/extract.json`) | — | Pure I/O; single-process CLI, no concurrency. |
| Env/secret read | Node (`process.env`) | — | Key never committed; fail-fast pre-flight (BOOT-02). |
| Arg parsing / exit codes / printing | CLI shell (`resolver/cli.ts`) | — | Kept separate from core (`extract.ts`) so Phase 2's scorer imports the core directly (D-06). |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | `0.100.1` [VERIFIED: npm registry] | The one external call (`messages.create`) | Official Anthropic TS SDK; 24.4M downloads/wk; repo `anthropics/anthropic-sdk-typescript`. |
| `zod` | **`3.25.x`** recommended (latest is `4.4.3`) [VERIFIED: npm registry] | Single-source schema + post-call validation | Already the codebase convention (`schema.ts`); 179M downloads/wk. See Key Q2 for the 3-vs-4 decision. |
| `zod-to-json-schema` | `3.25.2` [VERIFIED: npm registry] | Zod → JSON Schema for tool `input_schema` | Listed in D-05; 40.8M downloads/wk. **Works under Zod 3, broken under Zod 4 (verified).** |
| `tsx` | `4.22.4` [VERIFIED: npm registry] | Run `.ts` directly (`tsx resolver/cli.ts`) | D-05; 62M downloads/wk; runs ESM TS importing zod + SDK cleanly (verified). |
| `typescript` | `5.9.2` (latest tag is `6.0.3`) [VERIFIED: npm registry] | Type-checking (`tsc --noEmit`) for the BOOT-01 type-check criterion | D-05; 195M downloads/wk. Pin `^5.9` for stable strict behavior unless you intend TS 6. |

> Version-pin note: the npm `latest` for TypeScript is `6.0.3` and for Zod is `4.4.3`. I recommend deliberately pinning **TS `^5.9`** and **Zod `^3.25`** for this phase (see Key Q2). Both `latest` values are otherwise installable.

### Supporting
None required. Arg parsing for one `--fresh` flag is a 3-line `process.argv` check — do not add a CLI framework (see Don't Hand-Roll).

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `zod-to-json-schema` (+ Zod 3) | Zod 4 native `z.toJSONSchema()` (drop the package) | Fewer deps, future-proof; but changes D-05's dep list and uses a newer converter. Equally valid — see Key Q2. Either path needs the `{plan:…}` wrapper. |
| `tsx` for the CLI | `ts-node --esm` / compiled `tsc` + node | `tsx` is faster, zero-config, handles ESM `.ts` imports without extension friction (verified). D-05 already chose it. |
| Custom arg parse | `yargs`/`commander` | Overkill for one flag + one positional; adds install weight. |

**Installation:**
```bash
# Recommended (Zod 3 path, honors D-05 dep list exactly)
npm install zod@^3.25 @anthropic-ai/sdk@^0.100
npm install -D typescript@^5.9 tsx@^4 zod-to-json-schema@^3.25

# Alternative (Zod 4 path — drop zod-to-json-schema, use z.toJSONSchema)
# npm install zod@^4 @anthropic-ai/sdk@^0.100
# npm install -D typescript@^5.9 tsx@^4
```

**Version verification (done this session, public registry):** `@anthropic-ai/sdk` 0.100.1 (pub 2026-05-29), `zod` 4.4.3 (2026-05-04, latest 3.x line is 3.25.x), `zod-to-json-schema` 3.25.2 (2026-03-27, peerDeps `zod: "^3.25.28 || ^4"`), `tsx` 4.22.4, `typescript` 6.0.3 (pin 5.9.x recommended).

## Package Legitimacy Audit

slopcheck was not installable in this environment; substituted with download-count + official-repo verification (all five are canonical, multi-million-download packages with first-party GitHub repos). No suspicious postinstall scripts expected for these well-known packages; planner may optionally re-run slopcheck if available.

| Package | Registry | Age | Downloads/wk | Source Repo | slopcheck | Disposition |
|---------|----------|-----|--------------|-------------|-----------|-------------|
| `@anthropic-ai/sdk` | npm | est. (official) | 24.4M | github.com/anthropics/anthropic-sdk-typescript | n/a | Approved |
| `zod` | npm | est. (years) | 179.6M | github.com/colinhacks/zod | n/a | Approved |
| `zod-to-json-schema` | npm | est. (years) | 40.8M | github.com/StefanTerdell/zod-to-json-schema | n/a | Approved |
| `tsx` | npm | est. (years) | 62.2M | github.com/privatenumber/tsx | n/a | Approved |
| `typescript` | npm | est. (years) | 195.4M | github.com/microsoft/TypeScript | n/a | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Project Constraints (from CLAUDE.md)

- **Bounded prompt (decision 16/19):** NEVER edit `resolver/extractor-prompt.md` to make a query pass. It is an input only, and is hashed into the cache key — editing it silently invalidates the cache. Off-corpus examples only; new rule-instances go to the eval set (Phase 3), not the prompt.
- **Precision ≫ recall:** never silently accept a malformed plan; a typed failure is correct, a coerced wrong answer is not (D-04/D-10).
- **Extraction on Haiku, temp 0, structured output** (decision 19). Cheapest tier; do not compensate by stuffing the prompt.
- **Reproducibility (E10):** temp 0, 5× via `--fresh`; this phase only *surfaces* the 5 results — pass/fail aggregation is Phase 2.
- **Structural scope only:** no ids, no grounding, no live layer, no scorer this phase.
- **TypeScript + Zod, schema-first, strict** convention; new files (`extract.ts`, `cli.ts`) follow the strict-typed style. Discriminated unions are the schema idiom.
- **GSD workflow enforcement:** file edits go through a GSD command, not ad-hoc.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01 — Forced tool-use:** single tool (`emit_query_plan`), `tool_choice:{type:"tool", name:"emit_query_plan"}`, read plan from `tool_use.input`. JSON-prefill / free-text-then-parse rejected.
- **D-02 — Schema auto-generated from Zod; Zod always re-validates:** tool `input_schema` from the `QueryPlan` Zod schema via `zod-to-json-schema` (single source = `resolver/schema.ts`). JSON Schema is best-effort (refinements unexpressible); the real Zod schema **always** re-validates `tool_use.input` after the call. Refinements live only in Zod.
- **D-03 — Model:** `claude-haiku-4-5-20251001`. Part of the cache key.
- **D-04 — Full strict schema, no silent patching:** full strict discriminated-union sent; any Zod failure → typed failure, never coerced/patched. Relaxed schema is a deferred fallback.
- **D-05 — Runtime/tooling:** `tsx`, ESM (`"type":"module"`), `strict:true` TS, Node 20+. Deps: `typescript`, `tsx`, `zod`, `@anthropic-ai/sdk`, `zod-to-json-schema`.
- **D-06 — Layout:** core in `resolver/extract.ts` (pure-ish async: query → result), CLI in `resolver/cli.ts` (args, env check, printing, exit codes). `npm run extract "<q>"` → `tsx resolver/cli.ts`.
- **D-07 — Cache shape:** single gitignored JSON map `.cache/extract.json`. Key = `sha256(query ⊕ promptFileHash ⊕ modelId)`, `promptFileHash` = hash of `resolver/extractor-prompt.md` contents. Value = one cached raw response. `.cache/` gitignored.
- **D-08 — `--fresh`:** bypass cache read, run 5× at temp 0, write one representative response back.
- **D-09 — Success:** validated `QueryPlan` pretty-printed JSON to stdout, exit 0.
- **D-10 — Failure (typed, never silent):** `api_error` / `no_tool_use` / `schema_validation` printed as JSON to **stderr**, exit 1. On `schema_validation`, retain raw `tool_use.input` in the error payload (E4). No retry at temp 0. Missing `ANTHROPIC_API_KEY` fails fast before any query, clear actionable message.
- **D-11 — `--fresh` output:** 5 numbered result blocks + a final line stating whether all 5 were identical.

### Claude's Discretion
D-05..D-11 shapes were recommended defaults confirmed by the user. Downstream planning may refine exact file names, cache serialization details, and CLI flag parsing, as long as the LOCKED structured-output/model decisions (D-01..D-04) and the success criteria hold.

### Deferred Ideas (OUT OF SCOPE)
- 5×-all-pass aggregation & storing all 5 responses → Phase 2.
- Relaxed/flattened tool schema fallback → only if strict underperforms (default strict, D-04).
- Scorer, report, tiered-gate verdict → Phase 2.
- Gold-corpus expansion (~2/tag, ~35) → Phase 3.
- Grounding (text→ids), id-graded axes, live/executor layer → next milestone.
</user_constraints>

## Architecture Patterns

### System Architecture Diagram

```
                 npm run extract ["--fresh"] "<query>"
                              │
                              ▼
                   ┌──────────────────────┐
                   │   resolver/cli.ts     │  arg parse, env guard,
                   │   (I/O shell, D-06)   │  print, exit codes (D-09..D-11)
                   └──────────┬───────────┘
                              │ calls core fn (importable for Phase 2 scorer)
                              ▼
                   ┌──────────────────────┐
   ANTHROPIC_API_KEY (env) → │ resolver/extract.ts │ ← resolver/schema.ts  (QueryPlan)
   fail-fast if missing  │   (pure-ish core)    │ ← resolver/extractor-prompt.md (system + hashed)
                   └───┬──────────────┬────┘
        cache hit?     │              │  (build once) z.object({plan:QueryPlan}) → JSON Schema
       ┌───────────────┘              │  → strip $schema → tool.input_schema
       ▼                              ▼
 .cache/extract.json          ┌──────────────────────────┐
 sha256(query⊕promptHash⊕     │ Anthropic messages.create │  model=claude-haiku-4-5-20251001
 model) → cached raw          │ system=prompt, temp=0,    │  tool_choice={type:"tool",
 response (skip API)          │ tools=[emit_query_plan],  │  name:"emit_query_plan"}
                              │ max_tokens=…              │
                              └────────────┬─────────────┘
                                           │ response.content: ContentBlock[]
                                           ▼
                            find block.type==="tool_use" ──► none? → no_tool_use failure
                                           │ .input.plan
                                           ▼
                            QueryPlan.safeParse(input.plan)
                              success → QueryPlan (stdout, exit 0)
                              failure → schema_validation (stderr+raw input, exit 1)
                            (API throw anywhere → api_error, exit 1)
       --fresh: bypass cache read, loop 5×, print 5 blocks + "all 5 identical: y/n", write 1 back
```

### Recommended Project Structure
```
package.json            # "type":"module", scripts.extract = "tsx resolver/cli.ts"
tsconfig.json           # strict, NodeNext, noEmit for the type-check criterion
.gitignore              # add: node_modules/, .cache/
.cache/                 # gitignored; extract.json created at runtime
resolver/
├── schema.ts           # EXISTING — do not modify (the QueryPlan contract)
├── extractor-prompt.md # EXISTING — do not modify (system prompt; hashed)
├── extract.ts          # NEW core: async extract(query, {fresh}) → ExtractResult
├── tool-schema.ts      # NEW (optional): build the input_schema once from {plan: QueryPlan}
├── cache.ts            # NEW (optional): read/write .cache/extract.json, key()
└── cli.ts              # NEW I/O shell: argv, env guard, print, exit codes
```

### Pattern 1: Wrap the discriminated union for `input_schema`
**What:** Anthropic `input_schema` must be a JSON Schema *object* (`type:"object"`). A top-level `z.discriminatedUnion` emits `oneOf`/`anyOf` and is rejected. Wrap it.
**When to use:** Always, for this schema.
**Example:**
```ts
// Source: verified live this session against resolver/schema.ts
// Zod 3 path (recommended, honors D-05):
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { QueryPlan } from "./schema.js"; // tsx accepts ./schema, ./schema.ts, or ./schema.js

const wrapped = zodToJsonSchema(z.object({ plan: QueryPlan }), { $refStrategy: "none" });
delete (wrapped as any).$schema;        // Anthropic does not want the $schema meta key
// wrapped === { type:"object", properties:{ plan:{ oneOf:[…] } }, required:["plan"], additionalProperties:false }
const inputSchema = wrapped;            // pass straight to tool.input_schema
```
```ts
// Zod 4 ALTERNATIVE (drop zod-to-json-schema):
const wrapped = z.toJSONSchema(z.object({ plan: QueryPlan }), { unrepresentable: "any" });
delete (wrapped as any).$schema;
```

### Pattern 2: Single-tool forced structured output
**What:** Define one tool, force it, read `input.plan`, re-validate with Zod.
**Example:** see Code Examples §Extract call (full, verified-shape).

### Anti-Patterns to Avoid
- **Passing the bare discriminated-union JSON Schema to `input_schema`** → 400 / silent emptiness. Always wrap (Pattern 1).
- **`zod-to-json-schema` with Zod 4** → returns `{$schema}` only (empty). Either pin Zod 3 or switch to `z.toJSONSchema`.
- **Trusting JSON Schema to enforce refinements** → it can't; always `safeParse` the result (D-02).
- **Editing `extractor-prompt.md` to fix a query** → forbidden (bounded prompt) and invalidates the cache key.
- **Retrying on temp 0** → a deterministic call won't change; D-10 says no retry.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Zod → JSON Schema | A manual schema walker | `zod-to-json-schema` (Zod 3) or `z.toJSONSchema` (Zod 4) | Discriminated unions, enums, nullable, nested objects handled correctly; manual = drift from `schema.ts`. |
| Output validation | Ad-hoc `if (typeof …)` checks | `QueryPlan.safeParse` | The schema (incl. refinements) is the single source of truth (D-02/D-04). |
| API client / retries / errors | `fetch` to the REST endpoint | `@anthropic-ai/sdk` | Typed `Message`/`ToolUseBlock`, env key handling, error classes. |
| Hashing | A custom hash | `node:crypto` `createHash("sha256")` | Built-in, stable, no dep. |
| Arg parsing (one flag) | A CLI framework | `process.argv` slice + `.includes("--fresh")` | One flag + one positional doesn't justify a dep. |

**Key insight:** the whole phase is "wire verified primitives together correctly." The only real engineering is the schema-wrap + re-validate seam — everything else is library defaults.

## Common Pitfalls

### Pitfall 1: Private npm registry 401 blocks `npm install` (BOOT-01 blocker, FOUND in this environment)
**What goes wrong:** This machine's npm config points at a private registry with stale auth — `npm view`/`npm install` against it returns `E401 Incorrect or missing password`, so a plain `npm install` can fail before any code runs.
**Why it happens:** A user-level `.npmrc` with `//…/:_authToken` (or `//always-auth`/`//email` legacy keys, which I saw warned about) overrides the public registry.
**How to avoid:** Install with the public registry explicitly: `npm install --registry=https://registry.npmjs.org/`, or add a project `.npmrc` with `registry=https://registry.npmjs.org/`. (Verified: this exact override let all five packages install cleanly.) The planner should include a registry-aware install step so success criterion 1 doesn't fail on a stale global config.
**Warning signs:** `E401`, `npm warn Unknown user config "//always-auth"`.

### Pitfall 2: Top-level discriminated union rejected by `input_schema`
**What goes wrong:** Tool registration emits `oneOf`/`anyOf` at top level; Anthropic wants `type:"object"`.
**How to avoid:** Wrap `z.object({ plan: QueryPlan })` (Pattern 1); read `tool_use.input.plan`. Maps directly to success criterion 2.

### Pitfall 3: Zod 4 + `zod-to-json-schema` silently produces an empty schema
**What goes wrong:** `zodToJsonSchema(QueryPlan)` under Zod 4 returns `{$schema}` — no properties — so the tool has no schema and Haiku emits garbage; then Zod validation fails confusingly.
**How to avoid:** Pin Zod 3.25.x (package works), or use Zod 4's native `z.toJSONSchema`. Decide once at bootstrap (Key Q2).

### Pitfall 4: `$schema` key left on the JSON Schema
**What goes wrong:** Both converters add a `$schema` meta key; some tool-schema validators dislike extra top-level keys.
**How to avoid:** `delete wrapped.$schema` before assigning to `input_schema` (shown in Pattern 1).

### Pitfall 5: Missing key not caught before the call (BOOT-02)
**What goes wrong:** The SDK auto-reads `ANTHROPIC_API_KEY`; if absent, the failure surfaces as an opaque SDK auth error *after* attempting a call — not "fail fast, clear message."
**How to avoid:** Explicit pre-flight guard in `cli.ts`: `if (!process.env.ANTHROPIC_API_KEY) { print actionable message to stderr; exit 1 }` *before* constructing the client / sending. Maps to success criterion 3.

### Pitfall 6: Cache key not stable across runs
**What goes wrong:** Hashing a JS object with nondeterministic key order, or hashing the prompt *path* instead of its *contents*, produces unstable keys → false cache misses (fails criterion 4) or stale hits after a prompt edit.
**How to avoid:** Hash the concatenation of the raw `query` string, the **file contents** of `extractor-prompt.md`, and the literal model id (D-07). Read the prompt file once, hash its bytes.

### Pitfall 7: ESM/`"type":"module"` import friction
**What goes wrong:** Under `"type":"module"`, Node normally requires explicit extensions in import specifiers; people import `node:fs` as `fs`, or forget `node:` prefix.
**How to avoid:** `tsx` is lenient — `./schema`, `./schema.ts`, and `./schema.js` all resolve (verified). Use `node:fs`, `node:crypto`, `node:path` prefixes for built-ins. No top-level `require`.

## Code Examples

### Extract call (verified API shape; model + tool_choice confirmed)
```ts
// resolver/extract.ts (core; Source: SDK README + define-tools docs, types verified under tsx)
import Anthropic from "@anthropic-ai/sdk";
import { QueryPlan } from "./schema.js";
import { z } from "zod";

const MODEL = "claude-haiku-4-5-20251001"; // D-03, confirmed pinned id

export type ExtractResult =
  | { ok: true; plan: z.infer<typeof QueryPlan> }
  | { ok: false; kind: "api_error" | "no_tool_use" | "schema_validation"; error: unknown; rawInput?: unknown };

const client = new Anthropic(); // auto-reads process.env.ANTHROPIC_API_KEY

export async function extractOnce(
  query: string,
  systemPrompt: string,
  inputSchema: Record<string, unknown>, // built once via Pattern 1, $schema stripped
): Promise<ExtractResult> {
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,                  // 64k cap on Haiku 4.5; 2k is ample for a plan
      temperature: 0,                    // EXT-01 / E10
      system: systemPrompt,              // contents of extractor-prompt.md
      tools: [{
        name: "emit_query_plan",
        description: "Emit the single structured query plan for the user's betting search query. Always call this tool exactly once with the full plan under the 'plan' property.",
        input_schema: inputSchema as Anthropic.Messages.Tool.InputSchema,
        // optional: strict: true  (hard schema conformance; see define-tools §strict)
      }],
      tool_choice: { type: "tool", name: "emit_query_plan" }, // D-01 forced
      messages: [{ role: "user", content: query }],
    });
  } catch (err) {
    return { ok: false, kind: "api_error", error: err }; // D-10
  }

  const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) return { ok: false, kind: "no_tool_use", error: "model returned no tool_use block" };

  const raw = (block.input as { plan?: unknown }).plan; // wrapped under "plan" (Pattern 1)
  const parsed = QueryPlan.safeParse(raw);               // D-02/D-04 — refinements enforced here
  if (!parsed.success) {
    return { ok: false, kind: "schema_validation", error: parsed.error.issues, rawInput: raw }; // E4: retain raw
  }
  return { ok: true, plan: parsed.data };
}
```

### Env guard (BOOT-02)
```ts
// resolver/cli.ts (top, before any client/call)
if (!process.env.ANTHROPIC_API_KEY) {
  process.stderr.write(JSON.stringify({
    kind: "config_error",
    error: "ANTHROPIC_API_KEY is not set. Export it before running: export ANTHROPIC_API_KEY=sk-...",
  }) + "\n");
  process.exit(1);
}
```

### Cache (EXT-03 / D-07)
```ts
// resolver/cache.ts (Source: Node built-ins)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CACHE_PATH = ".cache/extract.json";

export function cacheKey(query: string, promptContents: string, modelId: string): string {
  return createHash("sha256")
    .update(query).update(" ")
    .update(promptContents).update(" ")  // file CONTENTS, not path
    .update(modelId)
    .digest("hex");
}

function load(): Record<string, unknown> {
  return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
}
export function cacheGet(key: string): unknown | undefined { return load()[key]; }
export function cacheSet(key: string, value: unknown): void {
  const map = load(); map[key] = value;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(map, null, 2));
}
```

### `--fresh` reproducibility (EXT-04 / D-08 / D-11)
```ts
// In cli.ts: bypass read, run 5×, surface all 5, write one back.
const results = [];
for (let i = 0; i < 5; i++) results.push(await extractOnce(query, prompt, inputSchema));
results.forEach((r, i) => { console.log(`--- result ${i + 1} ---`); console.log(JSON.stringify(r, null, 2)); });
const norm = (r: any) => JSON.stringify(r.ok ? r.plan : { kind: r.kind }); // structural compare (see Key Q4)
const allIdentical = results.every(r => norm(r) === norm(results[0]));
console.log(`all 5 identical: ${allIdentical ? "yes" : "no"}`);
if (results[0].ok) cacheSet(cacheKey(query, prompt, MODEL), results[0].plan); // one representative
```

### package.json (BOOT-01)
```jsonc
{
  "name": "intent-resolver",
  "private": true,
  "type": "module",
  "scripts": {
    "extract": "tsx resolver/cli.ts",
    "typecheck": "tsc --noEmit"      // satisfies the "schema.ts type-checks" criterion
  }
  // deps/devDeps per Installation block above
}
```
> `npm run extract -- --fresh "<q>"` — note the `--` so npm passes the flag through to the script.

### tsconfig.json (BOOT-01; strict, NodeNext, Node 20+; verified shape)
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["resolver/**/*.ts", "eval/**/*.ts"]
}
```
> Add `@types/node` (devDep) so `node:*` built-ins and `process` type-check under `tsc`. With `module:NodeNext`, `tsc` wants `.js` extensions in relative imports (e.g. `./schema.js`); `tsx` runs all forms. Pick `.js`-extension imports to keep `tsc --noEmit` and `tsx` both happy.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `claude-3-5-haiku-20241022` (arch doc) | `claude-haiku-4-5-20251001` | per D-03 | Latest Haiku; better tool-use; same forced-tool API. |
| JSON-mode / prefill for structured output | Forced single-tool use (`tool_choice:{type:"tool"}`) + optional `strict:true` | current Anthropic guidance | Most reliable structured output; D-01. |
| `zod-to-json-schema` (Zod 3) | Zod 4 built-in `z.toJSONSchema()` | Zod 4 (2025) | The external package is **broken** under Zod 4; native is the path if you adopt Zod 4. |

**Deprecated/outdated:**
- The arch doc's `claude-3-5-haiku-20241022` — superseded by D-03.
- Relying on `zod-to-json-schema` *with Zod 4* — silently empty output (verified).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `max_tokens: 2048` is ample for any single QueryPlan | Code Examples | Low — a very large multi-selector plan could truncate; bump if `stop_reason:"max_tokens"` observed. Planner may set higher (e.g. 4096). |
| A2 | The existing `schema.ts` `import { z } from "zod"` works on whichever Zod major you pin | Standard Stack | Low — verified to compile/run under Zod 4; Zod 3 `z.discriminatedUnion` API is identical for these constructs. If pinning Zod 3, re-run `tsc --noEmit` once at bootstrap. |
| A3 | `strict: true` on the tool is optional, not required, for Haiku 4.5 | Code Examples | Low — works without it; `strict:true` only adds hard conformance. Recommend leaving it off initially since Zod re-validates anyway (D-04). |

## Open Questions

1. **Pin Zod 3 (keep `zod-to-json-schema`) vs Zod 4 (native `z.toJSONSchema`)?**
   - What we know: Both produce a valid wrapped `type:"object"` schema; D-05 lists `zod-to-json-schema`.
   - What's unclear: Whether the team wants to move to Zod 4 now.
   - Recommendation: **Pin Zod 3.25.x + `zod-to-json-schema`** to honor D-05 verbatim and minimize change surface; revisit Zod 4 in a later phase. (This is Claude's-discretion territory under the CONTEXT note; either is correct.)

2. **`strict: true` on the tool?**
   - Recommendation: Leave off for v1 (Zod re-validates regardless, D-04). Add only if you observe schema drift in `--fresh` runs.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All (D-05 Node 20+) | ✓ | v24.3.0 | — (well above 20) |
| npm | BOOT-01 install | ✓ | 11.4.2 | — |
| Public npm registry | BOOT-01 install | ⚠ | — | **Global `.npmrc` points at a private registry that 401s.** Install via `--registry=https://registry.npmjs.org/` or a project `.npmrc`. Verified working. |
| `ANTHROPIC_API_KEY` | EXT-01 live call | ✗ (not set here) | — | Required for a real call; BOOT-02 fail-fast guard covers the missing case. No fallback for the live smoke test (success criterion 2). |
| Anthropic API reachability | EXT-01 | unverified (no key) | — | None — needed for criterion 2's live call. |

**Missing dependencies with no fallback:**
- A valid `ANTHROPIC_API_KEY` + network egress to api.anthropic.com is required to execute success criterion 2 (the live smoke query). The planner should make the live-call task explicitly require the key in the environment.

**Missing dependencies with fallback:**
- npm registry auth: use the public-registry override / project `.npmrc` (verified). This should be an explicit bootstrap step so `npm install` doesn't fail on the stale global config.

## Security Domain

> `security_enforcement: true`, ASVS level 1. Scope is small (one CLI, one outbound API call, a local cache).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No app auth surface. |
| V3 Session Management | no | Stateless CLI. |
| V4 Access Control | no | Local CLI, single user. |
| V5 Input Validation | yes | Zod `safeParse` validates all model output; arbitrary query text is sent only to Anthropic (no shell/eval). |
| V6 Cryptography | partial | sha256 via `node:crypto` for cache keys only (not a security control — collision-irrelevant, integrity of a local cache). Do not hand-roll hashing. |
| V7 Secrets (API key) | yes | `ANTHROPIC_API_KEY` from env only, never committed; `.cache/` gitignored; do not log the key. |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Secret committed to git | Information disclosure | Key from `process.env`; ensure `.gitignore` covers `.cache/` and no `.env` is committed. |
| Untrusted model output treated as trusted | Tampering | `QueryPlan.safeParse` gate (D-02/D-04); never `eval`/exec the plan. |
| Supply-chain (slopsquat) on install | Tampering | All 5 deps are canonical, multi-million-download, first-party repos (Audit table). |
| Logging sensitive data | Information disclosure | Error payloads print failure `kind` + raw model input only — never the API key. |

## Sources

### Primary (HIGH confidence)
- platform.claude.com/docs/en/about-claude/models/overview — confirmed `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`), tool use, 64k max output, $1/$5 MTok.
- platform.claude.com/docs/en/build-with-claude/tool-use — tool_choice options (`auto`/`any`/`tool`/`none`), Haiku 4.5 in the tool-use token table (supports `tool`/`any`), `stop_reason:"tool_use"`, `tool_use` blocks, optional `strict`.
- platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools — `input_schema` must be a JSON Schema **object**; forcing tool use prefills the assistant message (no NL preamble); TS example shape.
- github.com/anthropics/anthropic-sdk-typescript (README) — `new Anthropic()` auto-reads `ANTHROPIC_API_KEY`; `messages.create`; `message.content` is `ContentBlock[]`; find `type==="tool_use"`, read `.input`.
- zod.dev/json-schema — `z.toJSONSchema(schema, options)`; `unrepresentable:"any"`; `additionalProperties:false` default for `z.object`; refinements/`.transform` unrepresentable.
- **Live verification this session:** installed `zod@4.4.3`, `zod@3.25.x`, `zod-to-json-schema@3.25.2`, `tsx@4.22.4`, `@anthropic-ai/sdk@0.100.1`; ran the real `resolver/schema.ts` under tsx; confirmed (a) native `z.toJSONSchema(z.object({plan:QueryPlan}))` → `type:"object"`; (b) `zod-to-json-schema` empty under Zod 4 but correct under Zod 3; (c) `.refine` enforced by post-call `safeParse`; (d) SDK + `Anthropic.Messages.ToolChoice` import/typecheck under tsx ESM; (e) `.ts`/`.js`/no-extension imports all resolve under tsx.

### Secondary (MEDIUM confidence)
- github.com/colinhacks/zod issues #4089/#5807 — discriminatedUnion → `oneOf`, union → `anyOf`; LLM tool-schema incompatibilities with top-level non-object schemas.
- github.com/modelcontextprotocol/typescript-sdk #1643 — discriminatedUnion can serialize to empty `properties` in some tool frameworks (corroborates the wrap-it fix).

### Tertiary (LOW confidence)
- npm download counts (api.npmjs.org) used as a legitimacy signal in lieu of slopcheck.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions and interop verified by live install + run.
- Architecture (wrap + force-tool + re-validate): HIGH — executed against the real schema.
- Pitfalls: HIGH — registry 401, Zod-4 converter breakage, and refine-drop were all reproduced live.
- Model id / tool support: HIGH — official models + tool-use docs.

**Research date:** 2026-06-01
**Valid until:** ~2026-06-15 (fast-moving SDK/Zod; re-verify versions if planning is delayed).

## RESEARCH COMPLETE
