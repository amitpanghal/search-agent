# Coding Conventions

**Analysis Date:** 2026-06-01

## TypeScript Schema Patterns

### Zod Schema Organization

**Discriminated unions for mutually-exclusive variants:**
- Use `z.discriminatedUnion('discriminantField', [...variants])` when a field completely determines the shape.
- Example: `Subject` in `resolver/schema.ts` uses the `kind` discriminant to branch into `player`, `team`, `either_match_team`, or `event` — each with exclusive fields.
- The `QueryPlan` itself is status-discriminated: `resolved` carries `event_scope` + `selectors`; `ambiguous`/`unsupported` are bare sentinels with no nested plan.

**Flat objects with `.refine()` guards for orthogonal, co-occurring fields:**
- Use when multiple independent optional fields must be validated together (none null, bounds enforcement, etc.).
- Examples:
  - `Odds`: `{ min?, max? }` with `.refine()` guards: ≥1 bound present, `min ≤ max`.
  - `AttrFilter`: `{ position?, region?, ageMin?, ageMax? }` with `.refine()`: ≥1 predicate present, `ageMin ≤ ageMax`.
  - `Stage`: `{ round?, ordinal?, conditional }` with `.refine()`: ≥1 of `round`/`ordinal` must be non-null when stage is present.
  - `Time`: `{ date_window?, kickoff_time_of_day? }` with `.refine()`: ≥1 must be non-null.

**Text vs. enum fields:**
- **Data values** (groundable to catalog ids or external sources) stay as `z.string()`: `market_concept`, entity names, `competition`, `position`, `region`, stage `round`, time `value`/`kickoff_time_of_day`.
- **Structural classifications** (universal rules, never sport-specific) are fixed enums: `status`, `sport`, `subject.kind`, `line.kind`/`direction`, `level`, player `role`, `ordinal`, `date_window.anchor`.
- This boundary ensures the schema is portable across sports — only the text/data layer grows with new catalog entries.

**Line-vs-odds numeric typing:**
- Line = threshold on a counted stat: `{ kind: "numeric", value: number, direction: "over"|"under" }` or `{ kind: "binary", direction: "yes"|"no" }`.
- Odds = price bound: `{ min?: number, max?: number }`.
- Both can co-occur on one selector (e.g., `over 2.5 priced above 1.80`).
- Line is omitted entirely (not `null`) to mean "all offered lines" — distinguishes "no line specified" from "line with a number".

### Gold Record Schema

**`gold-record.ts` mirrors `schema.ts` with `Grounded` wrappers:**
- Every groundable leaf carries `Grounded = { id: number | number[], accept: string[] }`.
- `id` is a single catalog id **or an id set** (e.g., `either_match_team` + team-total grounds to `{ home_criteria_id, away_criteria_id }`; an `attrFilter` like "strikers" grounds to a player id set).
- `accept[]` is diagnostic-only for triage (surface-form variants like "corner markets" / "corners" / "total corners"); the `id` is the grading source of truth.
- Text/enum/structural fields (stage `round`, time `value`, `role`, `subject.kind`) stay literal — no wrapping.

## Naming Patterns

**Files:**
- TypeScript schema files: descriptive noun + `.ts` (e.g., `schema.ts`, `gold-record.ts`, `behavior-tags.ts`).
- Markdown specs: descriptive noun + `.md` (e.g., `extractor-prompt.md`, `scorer.spec.md`).
- Python refactor scripts: verb + noun + `.py` (e.g., `refactor_participants.py`, `merge_worldcup.py`).

**Functions and variables:**
- Camel case: `normalise_player_name()`, `find_sport_root_id()`, `compute_allowed_groups()` in Python; TypeScript factories and utilities follow standard camelCase.
- Descriptive prefixes for related sets: `CRITICAL_TAGS`, `SOFT_TAGS`, `BEHAVIOR_TAGS` (enum-like constants in UPPERCASE).
- Private/internal utilities use leading underscore: `_remove_noise()`, `_BETTING_EXPR`, `_PLACEHOLDER_TAIL` in Python.

**Types:**
- Exported Zod types use PascalCase: `QueryPlan`, `GoldRecord`, `Grounded`, `Subject`, `Selector`, `EventScope`.
- Type unions and constants use semantic names tied to the domain: `BUILT_SPORTS` (the set of partition keys), `BEHAVIOR_TAG_IDS` (the exhaustive tag list).

## Extractor Prompt Conventions (Decision 16 — Bounded Prompt)

**The prompt (`resolver/extractor-prompt.md`) is a **specification document** and an authored artifact with strict rules:**

**What goes in:**
- **Universal, sport-agnostic reasoning only**: subject binding (nearest preceding name owns the market), coreference resolution (pronouns → concrete entity names, "his team" → national team in WC context), the line-vs-odds structural rule, age normalization, and the sport-inference rule.
- A **3-step procedure** (explicit order for Haiku): Step 1 = decide sport + status; Step 2 = scope the event; Step 3 = extract selectors.
- **Fixed, off-corpus rule illustrations**: one canonical example per rule *per language*, chosen to illustrate the rule **without reusing any eval query, entity, or market**. E.g., rule examples use off-catalog markets like "tackles", "interceptions", "win-to-nil" — never "shots on target over 0.5" (that's g001's Vitinha selector, so seeding it would blind the eval).

**What stays out:**
- **Sport facts / plausibility ranges**: "assists in football typically range 0–5" belongs in the catalog or in the live layer, never the prompt.
- **Reactive per-query patches**: if a new market type fails, add a **behavior-tagged eval record**, not a prompt example.
- **Per-sport fragments** are a documented escape hatch, not built until an eval failure proves a universal rule can't be reformulated as an eval instance.

**Boundaries and rules:**
- Output only the structured plan; no prose, no ids, no catalog names.
- Never judge whether a line value or price is plausible — that resolves later against real markets.
- Never expand a squad from world knowledge; only use entities the query names (pronouns allowed).
- Record what the query says, as stated text; never fabricate a market, stage, time, or id.

**Extraction model:** Claude Haiku with structured output. The text-valued schema (all data leaves as strings) and bounded-prompt constraint make Haiku sufficient for universal reasoning; everything hard (plausibility, id resolution, dynamic fixture filtering) is pushed downstream.

## Error Handling & Validation

**Zod `.refine()` patterns:**
- Use for **multi-field invariants** that can't be expressed as single-field validators.
- Always include a descriptive error message: `.refine(check, "human-readable error")`.
- Examples:
  ```typescript
  Odds
    .refine(o => o.min !== undefined || o.max !== undefined, "need >=1 bound")
    .refine(o => o.min === undefined || o.max === undefined || o.min <= o.max, "min <= max")
  ```

**Status discrimination as a safety gate:**
- The `QueryPlan` discriminant is `status`: only `resolved` plans carry `event_scope` + `selectors`, ensuring **no grounding runs on an unconfirmed sport**.
- A discriminator's branches are **mutually exclusive and exhaustive** — all three (`resolved`, `ambiguous`, `unsupported`) are distinct outcomes, never overlap.

**Field nullability patterns:**
- `nullable()` is used for fields that are **present but could be null**: `competition: z.string().min(1).nullable()` (a query may name no tournament).
- `.optional()` is used for fields that **may not appear** (not present in the output at all).
- The distinction is semantic: `stage: Stage.nullable()` means "stage field exists but may be null"; omitting `stage` entirely is invalid.

## Module Design

**Exports:**
- `schema.ts` exports the **runtime extractor schema** (`QueryPlan`, `BUILT_SPORTS`); it's the contract for the Haiku call.
- `gold-record.ts` exports the **evaluation schema** (`GoldRecord`, `Grounded`, and re-exported `BEHAVIOR_TAG_IDS` for type-safety in tests).
- `behavior-tags.ts` exports **tag definitions** and derives `CRITICAL_TAGS` + `SOFT_TAGS` for the ship gate.

**Re-exports and imports:**
- Python scripts use selective imports: `from refactor_participants import (build_country_map, split_group_ids, ...)` — each function is listed, not wildcard.
- This makes dependencies explicit and allows `refactor_participants.py` to be a shared library (as `merge_worldcup.py` does).

## Python Data Transformation Conventions

**Docstring style:**
- Module-level docstring describes the script's purpose, inputs, outputs, and usage (e.g., `refactor_participants.py` opens with a full spec of input shapes, outputs, and two usage examples).
- Minimal function docstrings; the code is self-documenting via descriptive names and inline comments.

**Constants:**
- All-caps names for regex patterns, whitelists, and mappings: `EN_FALLBACK`, `MARKET_NAMES_LITERAL`, `LOCALE_ALIAS_SUBTREE_ROOTS`, `NT_SUFFIX_TO_VARIANT`.
- Organized near the top of the file, grouped by purpose.

**Naming:**
- Descriptive compound names with underscores: `normalise_player_name()`, `pick_en_name()`, `build_country_map()`, `_remove_noise()`.
- Snake_case throughout (Python convention).

**Rule order and applicability:**
- Rules are applied in **strict order** as stated in comments/docstrings (e.g., `refactor_participants.md` lists rules 1–6 in sequence).
- Rules are **idempotent or explicitly non-idempotent** — documented when a second pass would produce different output.

## Comments and Documentation

**When to comment:**
- Explain **why**, not **what** — the code should be clear on what it does.
- Comments flag non-obvious choices: regex anchoring ("why only trailing parens?"), exception handling ("why skip market labels?"), side effects ("this mutates the teams dict").
- Boundary conditions: constraints on input validity, preconditions for rules.

**JSDoc/TSDoc:**
- Zod schemas include brief inline comments on complex types: `// Who owns a market. player/team carry a text name; either_match_team/event are bare tags.`
- Function signatures are self-documenting via type annotations; no excessive JSDoc bloat.

---

*Convention analysis: 2026-06-01*
