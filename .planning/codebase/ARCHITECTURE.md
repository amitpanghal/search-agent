# Architecture

**Analysis Date:** 2026-06-01

## System Overview

The resolver is a **two-stage pipeline** that converts a messy natural-language sports-betting query into a grounded, structured query plan against a Kambi sports-betting catalog. The core insight: fuzzy NL→catalog-id matching is hard (an entity-grounding problem), not a storage problem.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                    RAW QUERY (natural language)                             │
└────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│              EXTRACTION (LLM — Haiku + Structured Output)                  │
│            `resolver/extractor-prompt.md` → `resolver/schema.ts`           │
│                 Emit: text-valued QueryPlan (sport inference,               │
│                 subject binding, line/odds typing, coreference)             │
└────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│    GROUNDING (deterministic retrieval — planned, not yet built)            │
│    Catalog: `football/` (criterions, participants, categories, etc.)       │
│    Outputs: QueryPlan with real catalog ids (ids in place of text facets)  │
└────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│    EVALUATION HARNESS (golden eval set)                                    │
│    `eval/gold.seed.jsonl` + `eval/scorer.spec.md` (planned)               │
│    Grade through grounding to real ids; behavior-tag coverage; tiered gate  │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│  EXECUTOR + LIVE LAYER (explicitly out of current scope — separate service)│
│  Resolves events via fixtures/round/kickoff/lineup metadata at query time  │
│  Fetches betoffers; applies selectors + filters + attrFilter predicates    │
└────────────────────────────────────────────────────────────────────────────┘
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

The **status-discriminated union** that flows through the pipeline. Extraction emits it as text-valued; grounding maps text→ids in place.

```typescript
// EXTRACTION OUTPUT (text-valued, from resolver/schema.ts)
QueryPlan =
  | { status: "resolved",
      sport: "FOOTBALL",  // enum of BUILT_SPORTS
      event_scope: {
        teams: ["Team Name", ...],                    // named teams
        players: [{ name: "Player", role: "plays"|"starts"|"captain" }, ...],
        competition: "World Cup 2026" | null,         // tournament name
        level: "fixture" | "competition",             // scope: single match vs tournament-wide
        stage: { round: "quarterfinal" | null,        // round as text
                 ordinal: "first" | "last" | null,    // opener / finale
                 conditional: boolean },              // "if they get there"
             | null,
        time: { date_window: { value: "first week", anchor: "tournament" | "now" } | null,
                kickoff_time_of_day: "late kick-offs" | null }
            | null,
      },
      selectors: [
        { subject: {kind: "player"|"team"|"either_match_team"|"event", name?: "..."},
          market_concept: "shots on target",
          line?: { kind: "numeric", value: 0.5, direction: "over"|"under" }
               | { kind: "binary", direction: "yes"|"no" },
          odds?: { min?: 1.8, max?: 3.0 },
          attrFilter?: { position?: "striker", region?: "Europe", ageMin?: 23, ageMax?: 30 } }
        , ...
      ]
    }
  | { status: "ambiguous", candidates: ["FOOTBALL", ...] }  // multi-sport (future)
  | { status: "unsupported", recognizedAs: "tennis" | null }
```

**Key design points:**
- **text-valued extraction**: `market_concept`, entity names, competition, stage/time, attrFilter.position/region are **plain text** close to query wording. Grounding maps them to ids downstream.
- **subject-bound selectors**: Each market is attached to its owner (player/team/either_match_team/event), decided **inside LLM extraction** because binding is language understanding.
- **discriminated unions** for mutual-exclusion variants: `status` (3 branches), `subject.kind` (4 branches), `line.kind` (2 branches); flat objects for orthogonal fields (`odds`, `attrFilter`, `stage`, `time`).
- **sport enum** is the BUILT_SPORTS constant, generated from group-tree top-level nodes; today `["FOOTBALL"]` only.

## Pattern Overview

**Overall:** Intent resolver = extraction (LLM) + grounding (retrieval).

**Key Characteristics:**
- **LLM does universal reasoning only** (subject binding, coreference, line/odds typing, sport inference); sport facts & plausibility live in the catalog & live layer.
- **Extraction is text-output, grounding is text→id** — keeps concerns split, eases testing (can grade extraction on structure/enum before grounding exists).
- **Criterion is the join hub** — the catalog is a star: criterion (market descriptors) at center, with category + betoffertype labels hanging off.
- **Two enrichment tiers**: region is a static ~48-row table (NT id → confederation); position + age need an external roster feed.
- **Sole sport per plan** — a multi-sport query routes to `ambiguous` (future, when ≥2 sports built).

## Layers

**Extraction (LLM):**
- **Purpose:** Parse raw NL query → typed, subject-bound text facets + inferred sport.
- **Location:** `resolver/extractor-prompt.md` (prompt, decision 19 — 3-step procedure), `resolver/schema.ts` (Zod schema, decision 18).
- **Model:** Claude Haiku, structured output (decision 19 — cheapest tier sufficient because hard work is deterministic).
- **Depends on:** Zod (external dep, in a future package.json).
- **Used by:** Grounding stage (takes text facets, maps to ids).
- **Output:** text-valued QueryPlan (status-discriminated).

**Grounding (deterministic, planned):**
- **Purpose:** Map text facets to catalog ids — the real entity/market resolution.
- **Location:** Planned — step 3.
- **Axes** (from `revisiting_Arch.md`, line 526–536):
  1. **Market semantics** (criterion/category/betoffertype) → alias table + semantic vectors (brute-force cosine at query time, no ANN needed).
  2. **Teams & players** → trigram/alias + context disambiguation (high-cardinality, semi-static).
  3. **Competitions** → tree navigation (hierarchical).
  4. **Event structure & time** → **live layer** (fixtures/bracket/kickoff at query time; dynamic).
  5. **Numeric predicates** (lines, odds) → downstream filters (no store).
  6. **Participant attributes** (position, age, region) → enrichment (static table for region; external feed for position/age).
- **Depends on:** Static store (SQLite loaded into RAM), live event layer (fixtures/lineup), enrichment tables.
- **Produces:** QueryPlan with real catalog ids in place of text.

**Static Store (planned, step 2):**
- **Purpose:** Hold all market/entity/competition/enrichment data; loaded into RAM at boot.
- **Format:** SQLite (build artifact), but used via in-memory maps at runtime.
- **Contains:** Relations (criterions, categories, betoffertypes, participants, groups); FTS5 indexes (lexical/alias); precomputed embedding vectors.
- **Reason SQLite:** Offline-built, auditable format; vectors as blobs; no server DB needed (data is tiny, all-in-RAM is sub-millisecond).
- **Per sport:** Partitioned (criterion, category, participants are per-sport); betoffertype is universal.

**Live Event Layer (planned, step 7, separate service):**
- **Purpose:** Query-time access to fixtures, bracket structure, kickoff times, lineup metadata.
- **Scope:** Resolves `stage` (GROUP_STAGE … FINAL, subject-relative openers, conditional slots), `time` (date_windows, kickoff_time_of_day), lineup `role` (starts/captain degrade to plays + caveat when no team sheet).
- **Not in scope:** Static catalog; executor owns the filtering.
- **Boundary:** Executor calls live layer to resolve `event_scope`, then fetches betoffers, applies selectors.

**Executor (planned, step 7, separate service):**
- **Purpose:** Run a grounded plan: resolve events, fetch betoffers, apply filters.
- **Input:** Grounded QueryPlan (sport, event_scope, selectors with real ids).
- **Steps:** (1) Scope events via live layer + stage/time/lineup predicates; (2) Fetch betoffers; (3) Apply selectors + attrFilter outcome filters + line/odds numeric filters.
- **Out of scope:** Resolver never executes.

**Evaluation (planned, steps 1 + 3):**
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

1. **User submits raw query** (natural language, blend of team/player/market/line/price/time).
2. **Extraction (LLM → `resolver/schema.ts`):** Claude Haiku + structured output converts query to text-valued QueryPlan.
   - Input: raw text.
   - Decisions: infer `sport` (or default to FOOTBALL, or emit `unsupported`/`ambiguous`); scope `event_scope` (teams, players+roles, competition, level, stage, time); extract `selectors[]` with subject binding, market concepts, line/odds/attrFilter.
   - Output: QueryPlan with `status`, `sport`, `event_scope`, `selectors[]` (all text-valued where appropriate).
3. **Grounding (planned, step 3):** Deterministic retrieval maps text → catalog ids.
   - Input: text-valued QueryPlan, inferred sport (scopes grounding to one partition).
   - Steps: (a) ground entities (player/team) via trigram+alias+context; (b) ground markets (criterion/boType) via alias+vectors; (c) resolve competition via tree; (d) ground attrFilter participants; (e) verify line/odds against real markets.
   - Output: QueryPlan with real ids in place of text.
4. **Executor + Live Layer (planned, step 7):** Separate service runs the plan.
   - Input: grounded QueryPlan.
   - Steps: resolve `event_scope` via live layer (fixtures, bracket, kickoff, lineup); fetch betoffers; apply selectors + filters.
   - Output: concrete market results + outcomes.

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

**Subject (subject binding):**
- `{ kind: "player", name: "X" }` — player owns a market ("X shots on target").
- `{ kind: "team", name: "X" }` — team owns a market ("X to win").
- `{ kind: "either_match_team" }` — generic team-specific market (≥2 match teams, no side named) → "team total tackles" (bare, no name; executor fans out per side).
- `{ kind: "event" }` — whole-match market ("winning margin", time of first goal).
- **Binding rule:** nearest preceding named subject owns the market; no owner → event; team-generic + ≥2 teams + no side → either_match_team.
- **Coreference:** "his shots" → concrete player name; "his team" → national team (in WC context), not club.

**Selector:**
- One `{ subject, market_concept, line?, odds?, attrFilter? }` per market in the query.
- `market_concept` is text ("shots on target", "tackles") before grounding; maps to criterion id(s) at grounding.
- `line` is a **threshold on a counted stat** (`{ kind: "numeric"|"binary", value?, direction }`); omitted = all offered lines.
- `odds` is a **price bound** (`{ min?, max? }`); a bare number or "priced N" is odds, not a line.
- **line vs odds:** one universal rule (E5, decision 15): a number tied to a counted thing is a line; a bare number is odds. Ambiguity resolved post-fetch against real markets, never in the prompt.
- `attrFilter` is outcome-level participant filtering (position, region, age) — **not a subject**, so "strikers" / "European nations" stays as `event` + `attrFilter`.

**Criterion (join hub):**
- The market definition; the **central entity** of the catalog's star schema.
- Shape (from `revisiting_Arch.md`, data facts): `{ id, sport, name, categoryNames[], boTypeNames[] }`.
- ~607 per sport (football measured).
- Examples: `"3-Way Handicap - 1st Half"` (encodes period + occurrence), `"Shots On Target"`.
- Maps from `market_concept` text at grounding.

**attrFilter (outcome filter, not subject):**
- Applied to participant **outcomes within a market** (e.g., Golden Boot for wingers, anytime scorer for strikers under 23).
- Distinct from a subject-kind — `"strikers"` is not a `participant_set` subject; it's `event` or named owner + `{ position: "striker" }`.
- Fields: `position` (text, singularized), `region` (text, maps to region-table id at grounding), `ageMin` / `ageMax` (inclusive integers, normalized).
- Grounding resolves `position`/`region` to participant id *sets* that filter outcomes.

**event_scope (fixture scoping):**
- **Teams:** named teams that scope the fixture(s).
- **Players:** players that scope **which fixtures** (`role: plays | starts | captain`), distinct from market subjects. "Featuring Mbappé" = `plays`; "Bellingham starting" = `starts`; "Bruno captain" = `captain`.
  - Extraction records role faithfully; executor degrades `starts`/`captain` → `plays` + caveat when no team sheet.
- **Competition:** tournament name (text).
- **Level:** `"fixture"` (single match) vs `"competition"` (tournament-wide future).
- **Stage:** round + ordinal + conditional (all text/enum, resolved by live layer).
- **Time:** date_window + kickoff_time_of_day (text/enum).

**Sport enum (BUILT_SPORTS):**
- Generated at startup from group-tree top-level nodes (`football/groups.json`).
- Today: `["FOOTBALL"]` only.
- Excludes non-sports (`SPECIAL_BETS`, `NON_SPORT`, `NOT-SPECIFIED`).
- Sent **via structured output** (no free string), so LLM must pick from the closed enum.

## Entry Points

**No runnable entry point yet** — extraction/grounding/executor are designed but not wired to a package.json or server entrypoint. The repo is a design artifact + schema/prompt/eval defs + catalog data.

**Planned entry points (step 8, end-to-end wire):**
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

**What happens:** Temptation to add "position is always a string, never an id" or "tackles are a team stat, not a player stat" to the prompt.

**Why it's wrong:** The prompt must stay bounded (decision 16, hard constraint). Sport facts get stale; plausibility changes when markets are added/removed; the LLM second-guesses the query.

**Do this instead:** Sport facts → catalog (the static store has the real markets & positions); plausibility → live fetch (grounding checks "is line 1.5 actually offered?"); coverage → eval set (a new behavior gets a tagged query, not a prompt rule).

### Encoding plausibility in the extraction prompt

**What happens:** "Under 23 in age markets is common, so default uncertain ages to 22" or "corners over 2.5 is rare, so probably the user meant something else."

**Why it's wrong:** The extractor's job is to record what was said, not to judge. Plausibility varies by sport, tournament, and live markets.

**Do this instead:** Record the extracted facets faithfully; grounding & the live layer verify against real markets. The eval set flags systematic misses (if all age-under queries fail, that's a prompt-rule signal).

### Embedding position/age in the catalog

**What happens:** Try to join player rosters to Kambi ids at build time, freezing position/age in the static store.

**Why it's wrong:** Rosters are dynamic (injuries, transfers, lineup changes); caching them makes the resolver stale.

**Do this instead:** Position + age are an external, dynamic feed (decision 7). Build-time: hand-keep the ~48-row region table (static + auditable). Query-time: the executor joins live roster data.

### Splitting `either_match_team` into two selectors at extraction

**What happens:** When "team total tackles" is named generically with 2 match teams, emit two selectors (one per side) in the plan.

**Why it's wrong:** You've lost the ambiguity — the user might have meant a generic market, not site-specific. The executor can't reconstruct which side they meant.

**Do this instead:** Keep it as one `either_match_team` selector (bare tag, no name). The executor fans out to home+away splits when fetching.

## Error Handling

**Strategy:** Extraction aims for high recall (emit a plan rather than abstain); grounding & the live layer verify precision (check the id exists, the line is offered).

**Patterns:**
- **Unrecognized sport** (tennis, cricket) → emit `status: "unsupported"` + `recognizedAs: "tennis"` (decision 17).
- **Grounding miss** (player name not in catalog) → grounding catches it; executor clarifies to the user (not the resolver's problem).
- **Bad line/odds values** (e.g. `min > max`) → Zod validation at parse time; never emitted by extraction.
- **Stale gold ids** (E11, eval-time only) → skip that cell, flag "re-author", never count as AI failure (catalog rebuilds won't masquerade as regressions).

## Cross-Cutting Concerns

**Logging:** Not yet defined (out of current scope).

**Validation:** Zod at extraction (input schema → output schema); grounding validates ids exist in the catalog (E11).

**Authentication/Rate Limiting:** Not in scope; resolver is a backend service, the caller (executor/search box) handles auth.

**Caching:** Grounded plans are cacheable (static sport scoping + deterministic grounding). Event-specific results (betoffers) are not.

---

*Architecture analysis: 2026-06-01*
