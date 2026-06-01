# External Integrations

**Analysis Date:** 2026-06-01

## APIs & External Services

**Anthropic Claude Haiku (Extraction):**
- **Purpose:** Single LLM extraction call to convert raw NL query → typed `QueryPlan`
- **Status:** Designed (decision 19); prompt drafted in `resolver/extractor-prompt.md`; schema written in `resolver/schema.ts`; NOT YET INTEGRATED
- **SDK/Client:** `@anthropic-ai/sdk` (not yet installed; will be added at bootstrap)
- **API Auth:** Anthropic API key (env var `ANTHROPIC_API_KEY`, TBD)
- **Model:** `claude-3-5-haiku-20241022` (or latest Haiku; selected for cost + adequacy for bounded, universal-reasoning-only extraction)
- **Feature:** Structured output mode (discriminated unions; status-based branching)
- **Call pattern:** Temperature 0, single call per query, repeated 5× for reproducibility in eval (decision E10)

**Kambi Sports-Betting Catalog (Data Source):**
- **Purpose:** Static market taxonomy (criterions, categories, betOffertypes, participants); the ground-truth domain vocabulary
- **Status:** Data currently sourced from Kambi feeds; stored locally in `football/` as JSON files
- **Data Files:**
  - `football/football_criterions.json` — 607 markets per sport (criterion is the hub)
  - `football/football_participants.json` — 1,784 clubs + 32,587 players; carries `clubId`, `countryTeamId`, `competitionIds`
  - `football/football_categories.json` — Criterion↔betOfferType mappings
  - `football/football_betoffertypes.json` — ~28 universal market types
  - `football/groups.json` — Competition tree; sports are top-level nodes
  - `football/aliases.json`, `derived-aliases.json` — Hand-curated + derived market name aliases
- **Refresh:** Built once and committed; schema includes a `catalogVersion` stamp (decision E11); will be updated nightly or on webhook (decision TBD)
- **Grounding:** The resolver grounds extracted text facets to real catalog ids using lexical/fuzzy/semantic matching against this store

**Live Fixtures & Event Layer (Planned):**
- **Purpose:** Dynamic query-time resolution of stage/time/kickoff/lineup predicates
- **Status:** Designed (decision 6); NOT YET BUILT; executor contract defined but no integration code
- **Contract:** Input = `event_scope { teams, players[role], competition, stage, time }`; output = matched fixture ids + metadata
- **Live facets it must resolve:**
  - **Stage:** round name, subject-relative openers ("Spain opener"), conditional slots ("if they reach it")
  - **Time:** date windows (tournament- vs now-relative: "first week" vs "next 48 hours"), kickoff time of day ("late kick-offs")
  - **Lineup roles:** `starts` / `captain` (degrade to `plays` + caveat if team sheet not published)
  - **Conditional matching:** only resolve fixture slots that exist; return tournament futures even when participants TBD
- **Placeholder implementation:** Will call out to a live fixture feed (source TBD; likely Kambi live-events or third-party sports data API)

**External Roster / Positions Feed (Planned):**
- **Purpose:** Player position and age/DOB; only these are missing from the Kambi catalog
- **Status:** Designed (decision 7); NOT YET SELECTED OR INTEGRATED
- **Scope:** Position (forward, midfielder, defender, goalkeeper) + age/DOB per player
- **Integration challenge:** Kambi player id ↔ external source player id matching; the single genuinely expensive enrichment dependency
- **Current notes from arch doc:**
  - Region is NOT an external feed — it's a hand-kept static ~48-row table (NT id → confederation) — decision 7 resolved region derivability is impossible from catalog alone
  - Position + age require external data; decision on source deferred
  - Both live in the executor layer (separate from the static store) as they're live/roster-dependent
- **When needed:** grounding `attrFilter { position, region, age }` to participant id sets

## Data Storage

**Databases:**
- **Static Store (Build Artifact):** SQLite file (few MB total)
  - **Status:** Designed (decision 10); NOT YET BUILT (plan step 2)
  - **Location:** TBD (likely `./store.db` or similar)
  - **Schema:** Relation tables (criterions, categories, betoffertypes, clubs, players, groups); FTS5 indices for alias/lexical search; precomputed embedding blobs (criterion names, category names)
  - **Load pattern:** Loaded into in-memory maps at boot; vector search via exact brute-force cosine (no ANN index needed; <1ms at a few thousand vectors)
  - **Client:** `better-sqlite3` or `sqlite3` npm package (TBD at bootstrap)
  - **Locking:** Single long-lived service; no concurrent writers

**Caching:**
- No caching layer planned. Grounded plans are cacheable and unit-testable (decision 9); caching deferred to executor/service level.

## Authentication & Identity

**Auth Provider:**
- None. System is a query resolver with no user identity. Anthropic API key is the only credential (service-level, not user-level).

## Monitoring & Observability

**Error Tracking:**
- None currently wired. Eval harness (decision E4) retains raw extractor text plan for failure triage (extraction vs grounding attribution).

**Logs:**
- None currently wired. Candidates for future: query latency, grounding hit-rate per sport, embedding model latency.

## CI/CD & Deployment

**Hosting:**
- Single long-lived Node.js service (not serverless)
- Deployment target TBD (likely a containerized app)

**CI Pipeline:**
- None yet. Eval runner will be built (plan step 8); it runs gold queries at temp 0 ×5 (decision E10) and gates on critical-behavior 100% + soft-behavior ~90% (decision E12).

## Environment Configuration

**Required env vars (once wired):**
- `ANTHROPIC_API_KEY` — Claude Haiku API key

**Optional (TBD):**
- `EMBEDDING_MODEL_PATH` — If local ONNX model; ignored if using API
- `LIVE_FIXTURES_API_URL` — Live event layer endpoint
- `ROSTER_FEED_URL` — External position + age feed

**Secrets location:**
- Not yet set up. Will likely be `.env` (local dev) + cloud secret manager (production)

## Webhooks & Callbacks

**Incoming:**
- None. Resolver is request-response only (single query → single plan).

**Outgoing:**
- **Planned (decision TBD):** Nightly rebuild webhook or change-webhook from Kambi to trigger static store rebuild

## Grounding Axes & Integration Points

Per `revisiting_Arch.md`, grounding (plan step 3) will integrate:

| Axis | Data Source | Integration Status |
|---|---|---|
| **Market semantics** (criterion/category/betOfferType) | Static store (vectors + alias FTS) | Designed; not built |
| **Teams & players** | Static store (trigram + alias + context) | Designed; not built |
| **Competitions** | Static store (group tree) | Designed; not built |
| **Event structure & time** | **Live event layer** (fixtures, kickoff, round metadata) | Designed; executor contract pinned; no implementation |
| **Numeric predicates** (lines, odds) | Resolved post-fetch against actual betoffers | Designed; executor responsibility |
| **Participant attributes** (position, age, region) | Region = static table (~48 rows); position/age = external roster feed | Region table written; roster feed TBD |

## Golden Eval Set Integration

**Data Flow:**
1. **Author** gold records (`eval/gold.seed.jsonl`) — 1 per query, with `tags[]`, raw query, expected grounded plan (decision E9)
2. **Validate** on load (decision E11) — every `Grounded.id` checked against loaded catalog; stale ids skipped, flagged "re-author"
3. **Run** resolver 5× per query at temp 0 (decision E10); scorer compares output to gold (decision E3, E4)
4. **Grade** on three axes (markets found, binding, line/odds correctness) plus `event_scope` and `status` (decision E5)
5. **Report** per-behavior pass-rate (decision E7); gate on critical behaviors 100%, soft ~90% (decision E12)

**Current seed (3 records):**
- `g001` — "Portugal vs Brazil quarterfinal…" (multi-market, binding, either_match_team)
- `g002` — "Djokovic vs Alcaraz…" (abstain; unbuilt sport)
- `g003` — "Both teams to score…" (sport default; market-only query)
- Target: ~50–70 with 17 behavior tags, ~5 queries each (decision E7)

## Known Gaps

- **Position + age roster provider:** source not selected; Kambi id matching logic deferred
- **Embedding model selection:** local ONNX vs API; sync/rebuild cadence
- **Live fixtures API:** endpoint and contract with executor not finalized
- **Abstain cases in eval:** `g002` (unbuilt sport) and `g003` (sport default) are present; football+unbuilt-sport mix case (E6 bucket iii) flagged but not yet authored
- **No grounding code:** the integration points above are all designed but not implemented; eval runner is blocked until grounding exists (decision E1)

---

*Integration audit: 2026-06-01*

**Summary:** This is a **design-phase system**. External integrations are all **planned**, not live. The Anthropic API (Haiku extraction), Kambi catalog (static), and live fixture/roster feeds (dynamic) are architected and scoped, but no integration code exists. The static SQLite store and embedding model are still TBD at the bootstrap phase.
