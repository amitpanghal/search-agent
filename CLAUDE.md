<!-- GSD:project-start source:PROJECT.md -->

## Project

**Intent Resolver**

A natural-language **intent resolver** over a Kambi sports-betting catalog. It turns a messy NL search query — e.g. *"Portugal vs Brazil quarterfinal with Bruno Fernandes corner markets, Vitinha shots on target over 0.5, and team total goals over 1.5"* — into a grounded, structured **query plan** (`{sport, event_scope, selectors[]}`) against the sportsbook catalog. Two stages: a Claude **Haiku** LLM **extracts** the query into a text-valued `QueryPlan`, then retrieval **grounds** the text facets to concrete catalog ids. A separate executor (out of scope) runs the plan. Built for a real sportsbook search box where precision matters because money is on the line.

**Current focus (this milestone):** stand up a runnable **structural eval harness** — wire the extractor on Haiku and build a scorer that runs queries through `extractor-prompt.md` and grades the *no-grounding* axes (everything gradeable on raw extractor output, before grounding exists).

**Core Value:** High-precision resolution of fuzzy NL betting queries to the *correct* catalog markets and entities — showing the wrong market or wrong player is costly, so determinism and auditability beat coverage. Corollary that drives sequencing: **you cannot ship precision you cannot measure**, which is why the eval harness comes before grounding.

### Constraints

- **Extraction model**: Claude **Haiku**, temperature 0, structured output. — Cheapest tier is sufficient *because* all hard work is deterministic; do not compensate for the small model by stuffing the prompt.
- **Bounded prompt** (decision 16): only universal, sport-agnostic reasoning in `extractor-prompt.md`. — Do **not** "fix" failing eval queries by piling rules/examples into the prompt; new rule-instances go to the eval set, sport facts to the catalog. This is the hard constraint the eval exists to protect.
- **Off-corpus prompt examples**: a prompt example must never reuse an eval query/entity/market. — Reusing one leaks the graded answer and blinds that eval row.
- **Precision ≫ recall** (money on the line): a wrong answer is weighed worse than a missing one. — Never surface a hallucinated or semantically-fuzzed player/market.
- **Structural scope only**: grade the no-grounding axes; no ids, no grounding, no live layer this milestone. — Keeps the milestone shippable ahead of grounding.
- **Reproducibility** (E10): temp 0, run each query 5×, pass only if all 5 pass. — Consistency *is* correctness; a 1-in-5 wrong bet is unshippable. Cadence: 1 run/change, 5 before release.
- **Tiered ship gate** (E12): critical behaviors must be 100%; soft behaviors sit on a ~90% aggregate. — Percentages are calibratable; the principle (critical = 100, soft = aggregate) is fixed.
- **Only the FOOTBALL partition is built.**

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript (.ts) — Present in `resolver/` and `eval/` directories; used for the extractor schema (`resolver/schema.ts`), evaluation infrastructure (`eval/gold-record.ts`, `eval/behavior-tags.ts`), and type definitions
- JSON — Kambi catalog data and configuration files: `football/football_criterions.json`, `football/football_participants.json`, `football/football_categories.json`, `football/football_betoffertypes.json`, `football/groups.json`
- Markdown — Architecture and specification documents (`revisiting_Arch.md`, `resolver/extractor-prompt.md`, `eval/scorer.spec.md`, `football/refactor_participants.md`)
- Python — Data refactor scripts in `football/`: `refactor_participants.py`, `merge_worldcup.py` — used for preprocessing Kambi catalog feeds

## Runtime

- Node.js (version unspecified; will be set during bootstrap)
- Python 3 (for football data refactoring scripts)
- npm or yarn (not yet set up; the architecture doc notes "next step is to bootstrap" `package.json` + build setup)
- No `package.json`, `package-lock.json`, or `yarn.lock` currently present

## Frameworks & Libraries

- **Zod** (TypeScript validation) — schema is written (`resolver/schema.ts` imports zod line 13; `eval/gold-record.ts` imports zod line 12) but the library is not yet available without `package.json`
- **Anthropic SDK** (Claude Haiku extraction) — designed to be integrated; the extractor prompt (`resolver/extractor-prompt.md`) is authored against Haiku's structured output capability, and decision 19 pins extraction to run on Haiku. No integration code exists yet
- **SQLite3** (static store) — planned as a build artifact and inspection format (revisiting_Arch.md, decision 10); in-memory store loaded at boot; FTS5 for alias/lexical search; precomputed embedding blobs. Not yet wired
- No ORM or query builder currently present (build step 2 will create the SQLite schema)
- Raw JSON file I/O for Kambi catalog data
- No test framework installed (project is greenfield; eval infrastructure is designed but scorer implementation deferred until grounding exists)
- **Gold record JSONL** (`eval/gold.seed.jsonl`) is the **eval harness data format**; scorer spec is documented (`eval/scorer.spec.md`) but scorer code doesn't exist yet

## Key Dependencies

- `zod` — Runtime schema validation for the extractor output `QueryPlan` and gold records
- `@anthropic-ai/sdk` — Single extraction call to Claude Haiku (temperature 0, structured output mode)
- `better-sqlite3` or `sqlite3` — Load and query the static store at runtime (decision 10; no ANN index needed)
- **Embedding model** — local ONNX (e.g., bge-small / gte-small) vs API-based; decision deferred. Same model must be used at build time and query time. Used for market semantic search via exact brute-force cosine (no vector DB required; data is tiny — a few thousand vectors are sub-millisecond at query time)

## Configuration

- No `.env` file currently present
- No environment variables currently wired
- Will require (on bootstrap): Anthropic API key for Claude Haiku extraction
- No build config files present (`tsconfig.json`, `webpack.config.js`, `vite.config.ts`, etc.)
- No linting or formatting config (`eslint.json`, `.prettierrc`, `biome.json`)
- Will be bootstrapped as part of plan step 2

## Data Formats

- `football/football_criterions.json` — 607 criterion records per sport; each carries `{id, sport, name, categoryNames[], boTypeNames[], shownInLive, shownInPreMatch}`
- `football/football_participants.json` — Refactored Kambi participant feed; clubs (1,784) and players (32,587) with `{id, kind, sport, name, clubId|countryTeamId, competitionIds[], groupIds[]}`
- `football/football_categories.json` — BetOfferCategory records; per-sport groupings of criterion↔betOfferType mappings
- `football/football_betoffertypes.json` — ~28 universal betOfferType records
- `football/groups.json` — Hierarchical group tree; sports are top-level nodes; used to generate the `BUILT_SPORTS` enum at runtime (decision 17)
- `football/aliases.json`, `football/derived-aliases.json` — Hand-curated and derived market aliases for matching
- `eval/gold.seed.jsonl` — One gold record per line (decision E9); mirrors the `QueryPlan` shape with every groundable leaf wrapped as `Grounded { id, accept[] }`. Seed currently has 3 records (g001, g002, g003); design targets ~50–70 with behavior tags.
- `eval/gold.meta.json` — Metadata stamp: schemaVersion, catalogVersion, record counts, validation note (E11)
- `resolver/schema.ts` — Zod schema for the text-valued `QueryPlan` emitted by Haiku; status-discriminated union; four-way subject discriminator; line numeric-vs-binary union; guarded `odds`/`attrFilter`; decision 18
- `eval/gold-record.ts` — Zod schema mirroring `QueryPlan` with `Grounded` cells for id-graded facets; decision E9
- `eval/behavior-tags.ts` — Enum of 17 behavior tags and their tier (critical vs soft); used to tag eval queries and report pass-rate per behavior; decisions E7 and E12
- `resolver/extractor-prompt.md` — Bounded prompt for Claude Haiku (decision 16 & 19); three-step procedure; universal, sport-agnostic reasoning only; off-corpus examples; ~230 lines
- `football/refactor_participants.py` — CLI tool; filters Kambi feed by sport/league and outputs normalized participant JSON with resolved groupIds
- `football/merge_worldcup.py` — Merges World Cup fixture data

## Architecture Decisions (Stackwise)

- **Single long-lived service** (not serverless); loads static SQLite artifact into RAM at boot (decision 10)
- **Extraction only on Haiku** (smallest structured-output tier; cost-effective because all hard reasoning is deterministic) — decision 19
- **No vector DB, graph DB, or server DB** — data is tiny (few MB total); exact brute-force cosine search on precomputed embeddings is sub-millisecond (decision 10)
- **No build artifacts versioning yet** — SQLite and embedding blobs are generated fresh; a `catalogVersion` stamp will be added to gold records (E11)

## Platform Requirements

- Node.js (LTS recommended, version TBD at bootstrap)
- Python 3.8+ (for football data refactoring)
- Zod (validation library, not yet installed)
- Node.js runtime
- Single SQLite file (few MB)
- Anthropic API access (Claude Haiku, structured output)
- Embedding model (local ONNX or API; TBD)

## Open / TBD

- **Which embedding model:** local ONNX vs API; decision deferred
- **Which embedding sync cadence:** nightly rebuild vs webhook-triggered
- **SQLite as pure build artifact vs runtime store:** current lean is load-into-RAM at boot
- **Position + age roster provider:** which external data source and how to match Kambi player ids; single genuinely expensive external dependency

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## TypeScript Schema Patterns

### Zod Schema Organization

- Use `z.discriminatedUnion('discriminantField', [...variants])` when a field completely determines the shape.
- Example: `Subject` in `resolver/schema.ts` uses the `kind` discriminant to branch into `player`, `team`, `either_match_team`, or `event` — each with exclusive fields.
- The `QueryPlan` itself is status-discriminated: `resolved` carries `event_scope` + `selectors`; `ambiguous`/`unsupported` are bare sentinels with no nested plan.
- Use when multiple independent optional fields must be validated together (none null, bounds enforcement, etc.).
- Examples:
- **Data values** (groundable to catalog ids or external sources) stay as `z.string()`: `market_concept`, entity names, `competition`, `position`, `region`, stage `round`, time `value`/`kickoff_time_of_day`.
- **Structural classifications** (universal rules, never sport-specific) are fixed enums: `status`, `sport`, `subject.kind`, `line.kind`/`direction`, `level`, player `role`, `ordinal`, `date_window.anchor`.
- This boundary ensures the schema is portable across sports — only the text/data layer grows with new catalog entries.
- Line = threshold on a counted stat: `{ kind: "numeric", value: number, direction: "over"|"under" }` or `{ kind: "binary", direction: "yes"|"no" }`.
- Odds = price bound: `{ min?: number, max?: number }`.
- Both can co-occur on one selector (e.g., `over 2.5 priced above 1.80`).
- Line is omitted entirely (not `null`) to mean "all offered lines" — distinguishes "no line specified" from "line with a number".

### Gold Record Schema

- Every groundable leaf carries `Grounded = { id: number | number[], accept: string[] }`.
- `id` is a single catalog id **or an id set** (e.g., `either_match_team` + team-total grounds to `{ home_criteria_id, away_criteria_id }`; an `attrFilter` like "strikers" grounds to a player id set).
- `accept[]` is diagnostic-only for triage (surface-form variants like "corner markets" / "corners" / "total corners"); the `id` is the grading source of truth.
- Text/enum/structural fields (stage `round`, time `value`, `role`, `subject.kind`) stay literal — no wrapping.

## Naming Patterns

- TypeScript schema files: descriptive noun + `.ts` (e.g., `schema.ts`, `gold-record.ts`, `behavior-tags.ts`).
- Markdown specs: descriptive noun + `.md` (e.g., `extractor-prompt.md`, `scorer.spec.md`).
- Python refactor scripts: verb + noun + `.py` (e.g., `refactor_participants.py`, `merge_worldcup.py`).
- Camel case: `normalise_player_name()`, `find_sport_root_id()`, `compute_allowed_groups()` in Python; TypeScript factories and utilities follow standard camelCase.
- Descriptive prefixes for related sets: `CRITICAL_TAGS`, `SOFT_TAGS`, `BEHAVIOR_TAGS` (enum-like constants in UPPERCASE).
- Private/internal utilities use leading underscore: `_remove_noise()`, `_BETTING_EXPR`, `_PLACEHOLDER_TAIL` in Python.
- Exported Zod types use PascalCase: `QueryPlan`, `GoldRecord`, `Grounded`, `Subject`, `Selector`, `EventScope`.
- Type unions and constants use semantic names tied to the domain: `BUILT_SPORTS` (the set of partition keys), `BEHAVIOR_TAG_IDS` (the exhaustive tag list).

## Extractor Prompt Conventions (Decision 16 — Bounded Prompt)

- **Universal, sport-agnostic reasoning only**: subject binding (nearest preceding name owns the market), coreference resolution (pronouns → concrete entity names, "his team" → national team in WC context), the line-vs-odds structural rule, age normalization, and the sport-inference rule.
- A **3-step procedure** (explicit order for Haiku): Step 1 = decide sport + status; Step 2 = scope the event; Step 3 = extract selectors.
- **Fixed, off-corpus rule illustrations**: one canonical example per rule *per language*, chosen to illustrate the rule **without reusing any eval query, entity, or market**. E.g., rule examples use off-catalog markets like "tackles", "interceptions", "win-to-nil" — never "shots on target over 0.5" (that's g001's Vitinha selector, so seeding it would blind the eval).
- **Sport facts / plausibility ranges**: "assists in football typically range 0–5" belongs in the catalog or in the live layer, never the prompt.
- **Reactive per-query patches**: if a new market type fails, add a **behavior-tagged eval record**, not a prompt example.
- **Per-sport fragments** are a documented escape hatch, not built until an eval failure proves a universal rule can't be reformulated as an eval instance.
- Output only the structured plan; no prose, no ids, no catalog names.
- Never judge whether a line value or price is plausible — that resolves later against real markets.
- Never expand a squad from world knowledge; only use entities the query names (pronouns allowed).
- Record what the query says, as stated text; never fabricate a market, stage, time, or id.

## Error Handling & Validation

- Use for **multi-field invariants** that can't be expressed as single-field validators.
- Always include a descriptive error message: `.refine(check, "human-readable error")`.
- Examples:
- The `QueryPlan` discriminant is `status`: only `resolved` plans carry `event_scope` + `selectors`, ensuring **no grounding runs on an unconfirmed sport**.
- A discriminator's branches are **mutually exclusive and exhaustive** — all three (`resolved`, `ambiguous`, `unsupported`) are distinct outcomes, never overlap.
- `nullable()` is used for fields that are **present but could be null**: `competition: z.string().min(1).nullable()` (a query may name no tournament).
- `.optional()` is used for fields that **may not appear** (not present in the output at all).
- The distinction is semantic: `stage: Stage.nullable()` means "stage field exists but may be null"; omitting `stage` entirely is invalid.

## Module Design

- `schema.ts` exports the **runtime extractor schema** (`QueryPlan`, `BUILT_SPORTS`); it's the contract for the Haiku call.
- `gold-record.ts` exports the **evaluation schema** (`GoldRecord`, `Grounded`, and re-exported `BEHAVIOR_TAG_IDS` for type-safety in tests).
- `behavior-tags.ts` exports **tag definitions** and derives `CRITICAL_TAGS` + `SOFT_TAGS` for the ship gate.
- Python scripts use selective imports: `from refactor_participants import (build_country_map, split_group_ids, ...)` — each function is listed, not wildcard.
- This makes dependencies explicit and allows `refactor_participants.py` to be a shared library (as `merge_worldcup.py` does).

## Python Data Transformation Conventions

- Module-level docstring describes the script's purpose, inputs, outputs, and usage (e.g., `refactor_participants.py` opens with a full spec of input shapes, outputs, and two usage examples).
- Minimal function docstrings; the code is self-documenting via descriptive names and inline comments.
- All-caps names for regex patterns, whitelists, and mappings: `EN_FALLBACK`, `MARKET_NAMES_LITERAL`, `LOCALE_ALIAS_SUBTREE_ROOTS`, `NT_SUFFIX_TO_VARIANT`.
- Organized near the top of the file, grouped by purpose.
- Descriptive compound names with underscores: `normalise_player_name()`, `pick_en_name()`, `build_country_map()`, `_remove_noise()`.
- Snake_case throughout (Python convention).
- Rules are applied in **strict order** as stated in comments/docstrings (e.g., `refactor_participants.md` lists rules 1–6 in sequence).
- Rules are **idempotent or explicitly non-idempotent** — documented when a second pass would produce different output.

## Comments and Documentation

- Explain **why**, not **what** — the code should be clear on what it does.
- Comments flag non-obvious choices: regex anchoring ("why only trailing parens?"), exception handling ("why skip market labels?"), side effects ("this mutates the teams dict").
- Boundary conditions: constraints on input validity, preconditions for rules.
- Zod schemas include brief inline comments on complex types: `// Who owns a market. player/team carry a text name; either_match_team/event are bare tags.`
- Function signatures are self-documenting via type annotations; no excessive JSDoc bloat.

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File(s) | Status |
|-----------|----------------|---------|--------|
| **Extraction** | Convert raw query → text-valued QueryPlan (sport + subject binding + coref + line/odds typing) via LLM (Haiku, structured output) | `resolver/extractor-prompt.md`, `resolver/schema.ts` | **BUILT** |
| **Grounding** | Map text facets → catalog ids (markets via vectors+alias, entities via trigram+alias, competitions via tree, enrichment for position/age/region) | Planned — step 3 | **DESIGNED** |
| **Static Store** | SQLite artifact: catalog relations + FTS5 (alias/lexical) + embedding blobs, loaded into RAM at boot | Planned — step 2 | **DESIGNED** |
| **Live Event Layer** | Query-time access to fixtures/bracket/kickoff/lineup; resolves stage/time/lineup roles; separate from static store | Planned — step 7 | **DESIGNED** |
| **Executor** | Run grounded plan: resolve events via live layer, fetch betoffers, apply selectors + numeric filters + attrFilter | Planned — step 7 | **DESIGNED** |
| **Eval Harness** | Grade resolver through grounding to real ids; behavior-tag coverage; structural eval (pre-grounding) + full eval (post-grounding) | `eval/gold-record.ts`, `eval/scorer.spec.md`, `eval/behavior-tags.ts` | **DESIGNED** (structural eval ready; full scorer needs grounding) |
| **Catalog Data** | Kambi football dataset: criterions, categories, betoffertypes, participants (clubs/players), groups hierarchy | `football/football_criterions.json`, `football/football_categories.json`, `football/football_participants.json` | **BUILT** |
| **Enrichment Tables** | Region (NT→confederation static table, ~48 rows); Position + age (external roster feed — TBD) | Planned — step 2 | **DESIGNED** |

## Core Data Structure: QueryPlan

```typescript

```

- **text-valued extraction**: `market_concept`, entity names, competition, stage/time, attrFilter.position/region are **plain text** close to query wording. Grounding maps them to ids downstream.
- **subject-bound selectors**: Each market is attached to its owner (player/team/either_match_team/event), decided **inside LLM extraction** because binding is language understanding.
- **discriminated unions** for mutual-exclusion variants: `status` (3 branches), `subject.kind` (4 branches), `line.kind` (2 branches); flat objects for orthogonal fields (`odds`, `attrFilter`, `stage`, `time`).
- **sport enum** is the BUILT_SPORTS constant, generated from group-tree top-level nodes; today `["FOOTBALL"]` only.

## Pattern Overview

- **LLM does universal reasoning only** (subject binding, coreference, line/odds typing, sport inference); sport facts & plausibility live in the catalog & live layer.
- **Extraction is text-output, grounding is text→id** — keeps concerns split, eases testing (can grade extraction on structure/enum before grounding exists).
- **Criterion is the join hub** — the catalog is a star: criterion (market descriptors) at center, with category + betoffertype labels hanging off.
- **Two enrichment tiers**: region is a static ~48-row table (NT id → confederation); position + age need an external roster feed.
- **Sole sport per plan** — a multi-sport query routes to `ambiguous` (future, when ≥2 sports built).

## Layers

- **Purpose:** Parse raw NL query → typed, subject-bound text facets + inferred sport.
- **Location:** `resolver/extractor-prompt.md` (prompt, decision 19 — 3-step procedure), `resolver/schema.ts` (Zod schema, decision 18).
- **Model:** Claude Haiku, structured output (decision 19 — cheapest tier sufficient because hard work is deterministic).
- **Depends on:** Zod (external dep, in a future package.json).
- **Used by:** Grounding stage (takes text facets, maps to ids).
- **Output:** text-valued QueryPlan (status-discriminated).
- **Purpose:** Map text facets to catalog ids — the real entity/market resolution.
- **Location:** Planned — step 3.
- **Axes** (from `revisiting_Arch.md`, line 526–536):
- **Depends on:** Static store (SQLite loaded into RAM), live event layer (fixtures/lineup), enrichment tables.
- **Produces:** QueryPlan with real catalog ids in place of text.
- **Purpose:** Hold all market/entity/competition/enrichment data; loaded into RAM at boot.
- **Format:** SQLite (build artifact), but used via in-memory maps at runtime.
- **Contains:** Relations (criterions, categories, betoffertypes, participants, groups); FTS5 indexes (lexical/alias); precomputed embedding vectors.
- **Reason SQLite:** Offline-built, auditable format; vectors as blobs; no server DB needed (data is tiny, all-in-RAM is sub-millisecond).
- **Per sport:** Partitioned (criterion, category, participants are per-sport); betoffertype is universal.
- **Purpose:** Query-time access to fixtures, bracket structure, kickoff times, lineup metadata.
- **Scope:** Resolves `stage` (GROUP_STAGE … FINAL, subject-relative openers, conditional slots), `time` (date_windows, kickoff_time_of_day), lineup `role` (starts/captain degrade to plays + caveat when no team sheet).
- **Not in scope:** Static catalog; executor owns the filtering.
- **Boundary:** Executor calls live layer to resolve `event_scope`, then fetches betoffers, applies selectors.
- **Purpose:** Run a grounded plan: resolve events, fetch betoffers, apply filters.
- **Input:** Grounded QueryPlan (sport, event_scope, selectors with real ids).
- **Steps:** (1) Scope events via live layer + stage/time/lineup predicates; (2) Fetch betoffers; (3) Apply selectors + attrFilter outcome filters + line/odds numeric filters.
- **Out of scope:** Resolver never executes.
- **Design:** `revisiting_Arch.md` decisions E1–E12 (golden eval set design).
- **Harness code:** `eval/gold-record.ts` (schema), `eval/scorer.spec.md` (spec), `eval/behavior-tags.ts` (coverage tags).
- **Seed data:** `eval/gold.seed.jsonl` (to be authored; v1 has 3 records — 2 football, 1 tennis/no-sport).
- **Metadata:** `eval/gold.meta.json` (schema + catalog version, E11).
- **What it grades:** Resolver output **through grounding** to real catalog ids (E1).
- **Axes:** status (E6), sport (E2), markets found (E3), binding (E3), line/odds (E3), event_scope facets (E5).
- **Coverage:** Behavior-tagged queries (~5 per tag, ~15 tags, ~50–70 total); critical behaviors 100%, soft ~90% aggregate (E12).
- **Run protocol:** 5× at temp 0 per query; all 5 must pass (E10).

## Data Flow

### Primary Path: Resolved Query

### Sport Inference Path (decision 17)

- Extraction emits `sport` directly from world knowledge (no pre-pass).
- Grounding verifies via hit-rate over groundable facets present in the query.
- Low hit-rate → abstain now / re-route to another sport once ≥2 partitions exist.
- Sport-silent query → default to FOOTBALL (sole-built-sport default, today only).

### Abstention Path

- **No sport named, FOOTBALL only built:** Emit `status: "resolved", sport: "FOOTBALL"`.
- **Names unbuilt sport (tennis, cricket, etc.):** Emit `status: "unsupported", recognizedAs: "tennis"`.
- **Football mixed with unbuilt sport:** Emit `status: "unsupported"` (do not half-answer).
- **Torn between ≥2 built sports (future):** Emit `status: "ambiguous", candidates: [...]`.

## Key Abstractions

- `{ kind: "player", name: "X" }` — player owns a market ("X shots on target").
- `{ kind: "team", name: "X" }` — team owns a market ("X to win").
- `{ kind: "either_match_team" }` — generic team-specific market (≥2 match teams, no side named) → "team total tackles" (bare, no name; executor fans out per side).
- `{ kind: "event" }` — whole-match market ("winning margin", time of first goal).
- **Binding rule:** nearest preceding named subject owns the market; no owner → event; team-generic + ≥2 teams + no side → either_match_team.
- **Coreference:** "his shots" → concrete player name; "his team" → national team (in WC context), not club.
- One `{ subject, market_concept, line?, odds?, attrFilter? }` per market in the query.
- `market_concept` is text ("shots on target", "tackles") before grounding; maps to criterion id(s) at grounding.
- `line` is a **threshold on a counted stat** (`{ kind: "numeric"|"binary", value?, direction }`); omitted = all offered lines.
- `odds` is a **price bound** (`{ min?, max? }`); a bare number or "priced N" is odds, not a line.
- **line vs odds:** one universal rule (E5, decision 15): a number tied to a counted thing is a line; a bare number is odds. Ambiguity resolved post-fetch against real markets, never in the prompt.
- `attrFilter` is outcome-level participant filtering (position, region, age) — **not a subject**, so "strikers" / "European nations" stays as `event` + `attrFilter`.
- The market definition; the **central entity** of the catalog's star schema.
- Shape (from `revisiting_Arch.md`, data facts): `{ id, sport, name, categoryNames[], boTypeNames[] }`.
- ~607 per sport (football measured).
- Examples: `"3-Way Handicap - 1st Half"` (encodes period + occurrence), `"Shots On Target"`.
- Maps from `market_concept` text at grounding.
- Applied to participant **outcomes within a market** (e.g., Golden Boot for wingers, anytime scorer for strikers under 23).
- Distinct from a subject-kind — `"strikers"` is not a `participant_set` subject; it's `event` or named owner + `{ position: "striker" }`.
- Fields: `position` (text, singularized), `region` (text, maps to region-table id at grounding), `ageMin` / `ageMax` (inclusive integers, normalized).
- Grounding resolves `position`/`region` to participant id *sets* that filter outcomes.
- **Teams:** named teams that scope the fixture(s).
- **Players:** players that scope **which fixtures** (`role: plays | starts | captain`), distinct from market subjects. "Featuring Mbappé" = `plays`; "Bellingham starting" = `starts`; "Bruno captain" = `captain`.
- **Competition:** tournament name (text).
- **Level:** `"fixture"` (single match) vs `"competition"` (tournament-wide future).
- **Stage:** round + ordinal + conditional (all text/enum, resolved by live layer).
- **Time:** date_window + kickoff_time_of_day (text/enum).
- Generated at startup from group-tree top-level nodes (`football/groups.json`).
- Today: `["FOOTBALL"]` only.
- Excludes non-sports (`SPECIAL_BETS`, `NON_SPORT`, `NOT-SPECIFIED`).
- Sent **via structured output** (no free string), so LLM must pick from the closed enum.

## Entry Points

- Single resolver service: `resolveQuery(query: string) → QueryPlan` (grounded).
- Executor service: `executeQuery(plan: GroundedQueryPlan) → MarketResults`.

## Architectural Constraints

- **Single long-lived service** (runtime target), no serverless-per-call design.
- **Single sport per plan** — multi-sport queries → `ambiguous` sentinel (future, when ≥2 sports exist).
- **No server DB** — SQLite is a build artifact; all data loads into RAM at boot.
- **Extraction on Haiku** — bounded prompt (universal reasoning only) + small model → LLM overhead kept low, hard work pushed to deterministic layers.
- **Text-valued extraction** — keeps extraction & grounding decoupled, eases structural eval (pre-grounding).
- **LLM never looks up ids** — extraction is pure text-output, grounding is deterministic; no hallucination surface on entity/market identity.
- **No ANN / vector DB** — brute-force cosine on a few thousand vectors is sub-millisecond; the data is tiny.

## Anti-Patterns

### Putting sport facts in the prompt

### Encoding plausibility in the extraction prompt

### Embedding position/age in the catalog

### Splitting `either_match_team` into two selectors at extraction

## Error Handling

- **Unrecognized sport** (tennis, cricket) → emit `status: "unsupported"` + `recognizedAs: "tennis"` (decision 17).
- **Grounding miss** (player name not in catalog) → grounding catches it; executor clarifies to the user (not the resolver's problem).
- **Bad line/odds values** (e.g. `min > max`) → Zod validation at parse time; never emitted by extraction.
- **Stale gold ids** (E11, eval-time only) → skip that cell, flag "re-author", never count as AI failure (catalog rebuilds won't masquerade as regressions).

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

| Skill | Description | Path |
|-------|-------------|------|
| grill-me | Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me". | `.claude/skills/grill-me/SKILL.md` |
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
