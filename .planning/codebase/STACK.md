# Technology Stack

**Analysis Date:** 2026-06-01

## Languages

**Primary:**
- TypeScript (.ts) — Present in `resolver/` and `eval/` directories; used for the extractor schema (`resolver/schema.ts`), evaluation infrastructure (`eval/gold-record.ts`, `eval/behavior-tags.ts`), and type definitions
- JSON — Kambi catalog data and configuration files: `football/football_criterions.json`, `football/football_participants.json`, `football/football_categories.json`, `football/football_betoffertypes.json`, `football/groups.json`
- Markdown — Architecture and specification documents (`revisiting_Arch.md`, `resolver/extractor-prompt.md`, `eval/scorer.spec.md`, `football/refactor_participants.md`)

**Secondary:**
- Python — Data refactor scripts in `football/`: `refactor_participants.py`, `merge_worldcup.py` — used for preprocessing Kambi catalog feeds

## Runtime

**Environment:**
- Node.js (version unspecified; will be set during bootstrap)
- Python 3 (for football data refactoring scripts)

**Package Manager:**
- npm or yarn (not yet set up; the architecture doc notes "next step is to bootstrap" `package.json` + build setup)
- No `package.json`, `package-lock.json`, or `yarn.lock` currently present

## Frameworks & Libraries

**Critical — Intended but NOT YET INSTALLED (design-phase only):**
- **Zod** (TypeScript validation) — schema is written (`resolver/schema.ts` imports zod line 13; `eval/gold-record.ts` imports zod line 12) but the library is not yet available without `package.json`
- **Anthropic SDK** (Claude Haiku extraction) — designed to be integrated; the extractor prompt (`resolver/extractor-prompt.md`) is authored against Haiku's structured output capability, and decision 19 pins extraction to run on Haiku. No integration code exists yet
- **SQLite3** (static store) — planned as a build artifact and inspection format (revisiting_Arch.md, decision 10); in-memory store loaded at boot; FTS5 for alias/lexical search; precomputed embedding blobs. Not yet wired

**Parsing & Data:**
- No ORM or query builder currently present (build step 2 will create the SQLite schema)
- Raw JSON file I/O for Kambi catalog data

**Testing:**
- No test framework installed (project is greenfield; eval infrastructure is designed but scorer implementation deferred until grounding exists)
- **Gold record JSONL** (`eval/gold.seed.jsonl`) is the **eval harness data format**; scorer spec is documented (`eval/scorer.spec.md`) but scorer code doesn't exist yet

## Key Dependencies

**Critical (once bootstrapped):**
- `zod` — Runtime schema validation for the extractor output `QueryPlan` and gold records
- `@anthropic-ai/sdk` — Single extraction call to Claude Haiku (temperature 0, structured output mode)
- `better-sqlite3` or `sqlite3` — Load and query the static store at runtime (decision 10; no ANN index needed)

**Optional (planned, not yet selected):**
- **Embedding model** — local ONNX (e.g., bge-small / gte-small) vs API-based; decision deferred. Same model must be used at build time and query time. Used for market semantic search via exact brute-force cosine (no vector DB required; data is tiny — a few thousand vectors are sub-millisecond at query time)

## Configuration

**Environment:**
- No `.env` file currently present
- No environment variables currently wired
- Will require (on bootstrap): Anthropic API key for Claude Haiku extraction

**Build:**
- No build config files present (`tsconfig.json`, `webpack.config.js`, `vite.config.ts`, etc.)
- No linting or formatting config (`eslint.json`, `.prettierrc`, `biome.json`)
- Will be bootstrapped as part of plan step 2

## Data Formats

**Kambi Catalog (static):**
- `football/football_criterions.json` — 607 criterion records per sport; each carries `{id, sport, name, categoryNames[], boTypeNames[], shownInLive, shownInPreMatch}`
- `football/football_participants.json` — Refactored Kambi participant feed; clubs (1,784) and players (32,587) with `{id, kind, sport, name, clubId|countryTeamId, competitionIds[], groupIds[]}`
- `football/football_categories.json` — BetOfferCategory records; per-sport groupings of criterion↔betOfferType mappings
- `football/football_betoffertypes.json` — ~28 universal betOfferType records
- `football/groups.json` — Hierarchical group tree; sports are top-level nodes; used to generate the `BUILT_SPORTS` enum at runtime (decision 17)
- `football/aliases.json`, `football/derived-aliases.json` — Hand-curated and derived market aliases for matching

**Golden Eval Set:**
- `eval/gold.seed.jsonl` — One gold record per line (decision E9); mirrors the `QueryPlan` shape with every groundable leaf wrapped as `Grounded { id, accept[] }`. Seed currently has 3 records (g001, g002, g003); design targets ~50–70 with behavior tags.
- `eval/gold.meta.json` — Metadata stamp: schemaVersion, catalogVersion, record counts, validation note (E11)

**Extractor & Schemas:**
- `resolver/schema.ts` — Zod schema for the text-valued `QueryPlan` emitted by Haiku; status-discriminated union; four-way subject discriminator; line numeric-vs-binary union; guarded `odds`/`attrFilter`; decision 18
- `eval/gold-record.ts` — Zod schema mirroring `QueryPlan` with `Grounded` cells for id-graded facets; decision E9
- `eval/behavior-tags.ts` — Enum of 17 behavior tags and their tier (critical vs soft); used to tag eval queries and report pass-rate per behavior; decisions E7 and E12
- `resolver/extractor-prompt.md` — Bounded prompt for Claude Haiku (decision 16 & 19); three-step procedure; universal, sport-agnostic reasoning only; off-corpus examples; ~230 lines

**Refactoring Scripts:**
- `football/refactor_participants.py` — CLI tool; filters Kambi feed by sport/league and outputs normalized participant JSON with resolved groupIds
- `football/merge_worldcup.py` — Merges World Cup fixture data

## Architecture Decisions (Stackwise)

- **Single long-lived service** (not serverless); loads static SQLite artifact into RAM at boot (decision 10)
- **Extraction only on Haiku** (smallest structured-output tier; cost-effective because all hard reasoning is deterministic) — decision 19
- **No vector DB, graph DB, or server DB** — data is tiny (few MB total); exact brute-force cosine search on precomputed embeddings is sub-millisecond (decision 10)
- **No build artifacts versioning yet** — SQLite and embedding blobs are generated fresh; a `catalogVersion` stamp will be added to gold records (E11)

## Platform Requirements

**Development:**
- Node.js (LTS recommended, version TBD at bootstrap)
- Python 3.8+ (for football data refactoring)
- Zod (validation library, not yet installed)

**Production:**
- Node.js runtime
- Single SQLite file (few MB)
- Anthropic API access (Claude Haiku, structured output)
- Embedding model (local ONNX or API; TBD)

## Open / TBD

- **Which embedding model:** local ONNX vs API; decision deferred
- **Which embedding sync cadence:** nightly rebuild vs webhook-triggered
- **SQLite as pure build artifact vs runtime store:** current lean is load-into-RAM at boot
- **Position + age roster provider:** which external data source and how to match Kambi player ids; single genuinely expensive external dependency

---

*Stack analysis: 2026-06-01*

**Note:** This is a **greenfield, design-phase project**. No `package.json`, no build setup, no runtime integration exists yet. The Zod schemas are written and the extractor prompt is drafted, but all external library integrations (Anthropic SDK, Zod, SQLite, embedding) are planned for implementation in the bootstrap phase (plan step 2 onwards).
