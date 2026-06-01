# Codebase Concerns

**Analysis Date:** 2026-06-01

## Early-Stage Build Gaps (Not Yet Implemented)

These are intentional deferrals in the greenfield design — no existing code exists for these layers. They are architectural gaps, not bugs.

### Missing Runtime Bootstrap

**Impact:** The resolver is not runnable today. The entire package cannot be installed or tested.

- **Missing `package.json`** at repo root: no dependency declarations for `zod`, `@anthropic-ai/sdk`, or any test runner.
- **No `tsconfig.json`**: TypeScript is not configured; the `.ts` files in `resolver/` and `eval/` cannot be compiled.
- **No lockfile** (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`): no pinned transitive versions.
- **No build script or entry point:** no `src/index.ts`, `src/main.ts`, or bundler config (Vite, esbuild, tsc).
- **No test runner:** `jest`, `vitest`, `tsx`, or equivalent is not declared; the scorer cannot run.

**Consequence:** The structural/enum eval axes (status, sport, subject.kind, line-vs-odds typing, level, role, attrFilter) are **gradeable on raw extractor output now** (`revisiting_Arch.md`, session update), but the harness to run them does not exist. The scorer `eval/scorer.spec.md` is a **specification only** — no runnable implementation.

**Files affected:**
- Missing `package.json` (project root)
- Missing `tsconfig.json` (project root)

**Fix approach:** Plan step 2 (in `revisiting_Arch.md`) is "Finalise the extractor schema + bounded prompt + eval set" — the blocked step. Once `package.json` is written with zod + Anthropic SDK + vitest, the structural eval can begin immediately, before grounding exists. This unblocks the golden eval set expansion and prompt iteration.

---

### No Scorer Implementation

**Impact:** Gold records cannot be evaluated even structurally. Test harness is completely absent.

- `eval/scorer.spec.md` is **specification only** — a complete algorithm for grading gold records against resolver output, but no TypeScript implementation.
- **No test runner invocation:** no `npm test`, no CI step, no way to measure pass-rates.
- **No failure reporter:** diagnostics (extraction vs grounding failure attribution, per-tag pass-rate aggregation, ship-gate check) exist as documented spec, not code.

**Consequence:** The "~1 run per change while iterating, ~5 before release" (E10 cadence) is planned but unexecutable.

**Files affected:**
- `eval/scorer.spec.md` — spec only, no implementation at `eval/scorer.ts` or similar

**Fix approach:** Once bootstrap (package.json + vitest) is in place, the scorer is a straightforward traversal of gold records (zod-validated) against AI output, following the 5-step grading logic in `scorer.spec.md`. Implementation is mechanical from spec.

---

### Incomplete Golden Eval Corpus — Abstain Cases Missing

**Impact:** Coverage testing cannot measure correctness on sentinel status paths (`unsupported`, sole-built sport default). The ship gate (E12) cannot be enforced.

- **Corpus is all resolvable football** (`g001` — multi-market, binding, either-team, stage; `g002` — tennis unsupported; `g003` — no-sport default).
- **Missing abstain buckets (E6):**
  - (i) ✓ **No sport named** — `g003` covers this (Both teams to score → FOOTBALL default)
  - (ii) ✓ **Named unbuilt sport** — `g002` covers this (tennis)
  - (iii) **Missing: Football + unbuilt sport mixed** (e.g. "Mbappé penalty shots over 1.5 and Djokovic total games over 22.5") — should emit `status: "unsupported"` and drop the football half gracefully.
- **Target ~50–70 queries, ~5 per behavior tag** (`revisiting_Arch.md`, E7). Current: 3 records. Thin coverage on all 17 behavior tags; several tags untested (coref-his, coref-his-team, line-vs-price, player-role, level, time, attrFilter, etc.). **Critical tags** (`binding`, `coref-his`, `coref-his-team`, `line-vs-price`, `abstain`, `either-team`, `yes/no-line`, `self-correction`, `sport-default`) cannot be properly gated.

**Consequence:** The exact corpus design (E1–E12) is settled, but the **behavior-tagged seed records** are the "remaining work" flagged in the prompt resume at `revisiting_Arch.md` line 691. The corpus cannot serve as a release gate until it grows to ~50–70 records with balanced behavior coverage.

**Files affected:**
- `eval/gold.seed.jsonl` — only 3 records (g001, g002, g003); needs ~47–67 more
- `eval/gold.meta.json` — catalogVersion is `unversioned-2026-05-28` (placeholder)

**Fix approach:** Plan step 1 continuation: author behavior-tagged gold records, including the football+unbuilt-mix abstain bucket and coverage for all 17 tags (~5 queries each). The "Representative queries" section in `revisiting_Arch.md` (lines 539–602) provides the seed material; convert each to a gold record using the authoring rules (coreference → concrete subject, self-correction → final intent, etc.).

---

## Deferred Architectural Decisions (Open Questions)

These are documented trade-offs or unknowns that block later stages.

### Embedding Model Choice (Local vs API)

**Impact:** No embedding layer exists yet. Market-grounding vector search is unimplemented.

- **Question:** Use a local ONNX model (e.g., bge-small, gte-small) vs an API service?
- **Trade-off:** Local = no network hop, self-contained; API = simpler integration, external vendor dependency.
- **Constraint:** The **same model must be used at build time and query time** (so pre-computed embeddings remain valid).

**Files affected:**
- `resolver/schema.ts`, `resolver/extractor-prompt.md` — embedding choice is transparent to extraction; affects grounding step (not yet written)
- Missing `football/embeddings.json` or equivalent artifact

**Fix approach:** Make a deliberate choice (local ONNX recommended for a long-lived service) and document it in the build pipeline (plan step 2). The grounding layer (plan step 3) depends on this.

---

### External Roster Provider — Position + Age Matching

**Impact:** Player position and age filtering cannot function without this feed. Attrfilter on position/age is structurally extracted but ungrounded.

- **Question:** Which external data source provides per-player position and age/DOB, and how to match Kambi player ids to that provider's ids?
- **This is the single genuinely expensive dependency** in the system (`revisiting_Arch.md`, #7 and #73–77).
- **Current state:** Region (confederation) is solved via a static ~48-row table (NT id → confederation); only position + age remain external.

**Files affected:**
- `resolver/schema.ts` line 42: `position: z.string().min(1).optional()` — extracted as text, ungrounded
- `eval/gold-record.ts` line 49: `position: z.string().min(1).optional()` — marked as text (E2), "roster feed, out of strict scope"
- Missing enrichment join code in the grounding layer (plan step 3)

**Fix approach:** Plan step 4 — "Decide + integrate the position + age roster provider." Once decided, the grounding layer can resolve `attrFilter.position` and `attrFilter.ageMin/ageMax` to participant **id sets** that drive outcome filtering in the executor.

---

### Live-Layer Semantics Specification

**Impact:** Stage (round, ordinal, conditional), time (date_window, kickoff_time_of_day), and lineup-role degrade rules are documented but not formally specified or implemented.

- The extractor emits these as **text** (e.g., stage.round = "group stage", time.date_window.value = "first week"); resolving them to real dates/brackets/fixtures is the **executor's job** (a separate component), not the resolver's.
- **Needed detail:**
  - Subject-relative stages ("Spain opener" = that team's first match) — how are `teams[]` in event_scope used to scope the correct fixture?
  - Conditional slots ("whoever's in it", "if they get there") — when should a plan be rejected (TBD participant) vs accepted as a tournament future?
  - Date_window vs kickoff_time_of_day — clearer resolution rules.
  - Lineup role degrade — when to downgrade `starts`/`captain` to `plays` + caveat (if team sheet not published yet).

**Files affected:**
- `resolver/schema.ts` lines 205–216: Stage, Time, EventScope structure — defined; semantics are in `revisiting_Arch.md` lines 50–66 (informally).
- Missing executor implementation

**Fix approach:** Plan step 6 ("Build the executor + the live-event-layer contract") requires formalizing and documenting these rules. The extractor's output carries the text; the executor interprets it.

---

### Line-vs-Odds Ambiguity Resolution Stage

**Impact:** When a number can be either a line or odds (e.g., "over 2.5"), the final decision is deferred to runtime.

- **Extraction rule (decision 15):** a number tied to a counted thing is a **line**; a bare number or one with "priced/odds" is **odds**. One universal rule, but genuinely ambiguous cases exist.
- **Open question:** Is ambiguity resolved at **catalog fetch time** (does this criterion support over/under?) or at **betoffer fetch time** (is line *N* actually offered?)?

**Consequence:** The extractor may emit a `line` that grounding then must re-interpret or reject if no matching catalog criterion exists.

**Files affected:**
- `resolver/extractor-prompt.md` lines 114–132: universal rule stated; deferred resolution not documented in extractor
- Grounding layer (not yet written) — plan step 3

**Fix approach:** Pin the resolution stage in grounding and executor. The doc comments this as an open question; it does not block extraction/eval structural testing.

---

### Fixable Correctness/Faithfulness Risks (From Architecture Doc Open Questions)

These are real design edges identified during the architecture session. They may require careful handling.

#### 1. Player Subject Bound to Team-Only Market

**What it is:** A query like "Bruno Fernandes corner markets" binds a `player` subject to **Total Corners**, which is a team/match market — there is no player-corner criterion in the catalog.

**Gold record approach:** `g001` (in `eval/gold.seed.jsonl`) keeps the **stated binding** (Bruno ↔ corners), faithful to the canonical "Bruno corners" intent. Whether the executor can filter to Bruno's corners within the team-total market is the executor's concern.

**Open question:** Is faithful-keep always the rule, or should some markets reject a player owner and emit a caveat or `unsupported`?

**Files affected:**
- `eval/gold.seed.jsonl` line 1: g001 selector[0] has `subject.kind: player, name: Bruno Fernandes` bound to criterion 1001159897 (Total Corners)
- `eval/scorer.spec.md` lines 156–158: "Player-bound team market" flagged as a pressure-test finding

**Fix approach:** Clarify the binding rule in the extraction prompt or the executor. The current approach (keep the stated binding, leave filtering to the executor) is reasonable for an early system; document it explicitly.

---

#### 2. Groundable Cells Can Resolve to an ID Set, Not a Single ID

**What it is:** Some markets resolve to multiple catalog ids:
- "team total goals" (`either_match_team`) grounds to `{home_criteria_id, away_criteria_id}` because the catalog splits team-totals by side.
- "strikers" in an attrFilter grounds to a **participant id set** (all striker outcomes in that market).

**Current representation:** `eval/gold-record.ts` line 21 widens `Grounded.id` to `z.union([z.number(), z.array(z.number()).min(1)])`.

**Open question:** Is `id: number | number[]` the right representation, or should there be a separate `ids[]` field?

**Files affected:**
- `eval/gold-record.ts` lines 20–23: `Grounded` type defined with `id: number | number[]`
- `eval/scorer.spec.md` lines 149–153: "Groundable cells can be an id SET, not one id" flagged as finding 1

**Fix approach:** The current union type is clean. The scorer (when implemented) must handle id-set matching as order-independent set equality (lines 66 of scorer.spec.md already specify this). No blocker; design is sound.

---

#### 3. Age Normalization Edge Case

**What it is:** Age phrases like "under 23", "U21", "over 30" must be normalized to **inclusive** integer bounds per decision 15 / rule 6 in `revisiting_Arch.md`.

- "under 23" → `ageMax: 22` (inclusive upper bound)
- "U21" → `ageMax: 20`
- "over 30" → `ageMin: 31` (inclusive lower bound)

**Current state:** The extraction prompt (`resolver/extractor-prompt.md` lines 148–149) and schema (`resolver/schema.ts` lines 44–45) document the rule. The `age-normalize` behavior tag is defined in `eval/behavior-tags.ts` line 27 and marked soft.

**No blocker:** This is a well-defined rule, not an open question. The corpus must include age-normalize cases to test it.

**Files affected:**
- `resolver/extractor-prompt.md` lines 148–149
- `eval/behavior-tags.ts` line 27 (soft tier)

---

## Data Quality & Freshness Concerns

### Stale Catalog Artifact

**What it is:** The football catalog data is hand-collected and point-in-time. Data rot occurs when Kambi adds/removes markets or participants mid-tournament.

- **Data captured:** 2026-05-28 (per `eval/gold.meta.json` line 4)
- **Catalog version:** `football@unversioned-2026-05-28` (placeholder; real versioning lives in plan step 2's build pipeline)

**Current mitigation:** The gold record validator (E11 / `scorer.spec.md` lines 30–37) checks every Grounded.id at eval start. A missing id → `"stale gold — re-author"`, that cell is **skipped and never counted as an AI failure**. Catalog rebuild cannot make stale keys masquerade as regressions.

**Risk:** If the resolver is run against an older catalog snapshot mid-tournament, queries may ground to ids that no longer exist. Conversely, if the catalog is rebuilt mid-tournament, eval gold records become stale until re-authored.

**Consequence:** This is **accepted design** (Constraints section of `revisiting_Arch.md` lines 474–475 and E11 lines 343–350) — sport ids are stable for entities that exist; the rot risk is add/remove. The nightly rebuild cadence (open question in `revisiting_Arch.md` line 381) will address this once the build pipeline (plan step 2) is implemented.

**Files affected:**
- `eval/gold.meta.json` — catalogVersion is a placeholder
- `football/football_criterions.json`, `football/football_participants.json`, etc. — point-in-time snapshots

**Fix approach:** Implement the build pipeline (plan step 2) with a real versioning scheme and sync cadence. For now, manual re-validation before eval runs is the mitigation.

---

### Football Data Only — No Multi-Sport Routing

**What it is:** The entire resolver is architected for multi-sport, but only **FOOTBALL is built**. The `ambiguous` status (torn between ≥2 built sports) cannot occur — its candidates array needs ≥2 built sports.

**Consequence:**
- `sport` enum in `resolver/schema.ts` line 89 is single-valued: `z.enum(BUILT_SPORTS)` where `BUILT_SPORTS = ["FOOTBALL"]`.
- Sport inference robustness (decision 17 / "trust-but-verify" tie-breaker using grounding hit-rate) is designed but untestable with one sport.
- The "ambiguous" test case is documented as not-run in the architecture (line 309: "can't occur with one partition... → documented, not run").

**Consequence:** Once a second sport partition is built, the `ambiguous` case (and the re-route logic for low-hit-rate queries) becomes testable and fully exercised.

**No immediate risk:** This is expected in a greenfield system. The architecture and schema are sport-agnostic.

**Files affected:**
- `resolver/schema.ts` line 15: `BUILT_SPORTS = ["FOOTBALL"]`
- `resolver/schema.ts` line 89: `sport: z.enum(BUILT_SPORTS)` — currently single-valued
- `eval/gold-record.ts` line 102: `sport: z.string().min(1)` — allows any sport string at record time, validated against runtime BUILT_SPORTS on load (E11)

**Fix approach:** None needed until a second sport is built. Multi-sport routing will be tested once two partitions exist.

---

## Housekeeping & Minor Data Issues

### Compiled Python Artifacts Checked In

**What it is:** The `football/__pycache__/` directory contains compiled Python bytecode (`.pyc` files). These are build artifacts that should not be version-controlled.

**Impact:** Minimal. Bytecode is regenerated on next Python run; presence/absence doesn't affect functionality.

**Files affected:**
- `football/__pycache__/` — directory with compiled bytecode from `merge_worldcup.py` and `refactor_participants.py`

**Fix approach:** Add `__pycache__/` to `.gitignore` and remove the tracked directory from git history (optional cleanup).

---

### Duplicate/Stale Data Files

**What it is:** `football/groups_old.json` is a backup or prior version of `football/groups.json`.

**Impact:** Minimal. No code references the `_old` file; it's dormant.

**Files affected:**
- `football/groups_old.json` — stale backup

**Fix approach:** Delete or move to a `_archive/` directory. If it's a safety reference, document why it's kept.

---

## Security & Credentials Scan

**Result:** No API keys, tokens, or credentials found in project code.

- `resolver/schema.ts`, `resolver/extractor-prompt.md`, `eval/` files — no embedded credentials.
- `football/*.py` scripts — no API key strings detected.
- Football JSON data files — no inline secrets.
- Anthropic API key is expected to come from `ANTHROPIC_API_KEY` environment variable (best practice; not in code).

**Files scanned:** `resolver/`, `eval/`, `football/` (excluding .git and .claude).

**Conclusion:** Security posture is clean for early-stage code. The constraint that "Anthropic key should come from env, not code" is being followed.

---

## Test Coverage Gaps (by Behavior Tag)

The golden eval corpus (3 records) covers only a subset of the 17 defined behavior tags. Expansion to ~50–70 records with ~5 per tag is the priority.

**Covered (≥1 record):**
- `binding` — g001 (critical)
- `either-team` — g001 (critical)
- `stage` — g001 (soft)
- `abstain` — g002 (critical)
- `sport-default` — g003 (critical)
- `odds-only-bounds` — g003 (soft)

**Uncovered (0 records):**
- `coref-his` (critical) — "his shots" resolving to a player's id
- `coref-his-team` (critical) — "his team" resolving to national team, not club
- `line-vs-price` (critical) — distinguishing "over 2.5" (line) from "over 1.80" (odds)
- `line-no-number` (soft) — "aerial duels won markets" with no line
- `attrFilter` (soft) — position/region/age outcome filters
- `player-role` (soft) — `plays / starts / captain` roles on event_scope.players
- `level` (soft) — fixture vs competition (tournament-wide)
- `time` (soft) — date_window and kickoff_time_of_day
- `yes/no-line` (critical) — binary market sides ("clean sheet" → yes)
- `self-correction` (critical) — in-query retractions
- `age-normalize` (soft) — "under 23" → ageMax 22

**Gap size:** 11 of 17 tags have zero records. **Critical gaps:** 6 tags (coref-his, coref-his-team, line-vs-price, yes/no-line, self-correction) with critical tier must reach 100% pass-rate to clear the ship gate (E12).

**Fix approach:** Expand the corpus following the "Representative queries" groupings in `revisiting_Arch.md` (lines 539–602). Each query becomes a behavior-tagged gold record. Prioritize coverage of all critical tags before expanding soft tags.

---

## Summary of Blocking Items (By Plan Step)

**Plan Step 1** (`revisiting_Arch.md` line 421): "Finalise the extractor schema + bounded prompt + eval set"
- ✓ Zod schema written (`resolver/schema.ts`, `eval/gold-record.ts`)
- ✓ Bounded prompt drafted (`resolver/extractor-prompt.md`)
- ⏳ **Golden eval-set expansion** — needs ~47–67 more records (3 exist) with behavior-tag coverage

**Plan Step 2** (line 441): "Build the static-store build pipeline"
- ❌ **No `package.json`** — cannot install zod, Anthropic SDK, test runner
- ❌ **No build script** — no way to compile TypeScript, generate BUILT_SPORTS enum, emit versioned SQLite artifact
- ❌ Region table not created (~48-row NT id → confederation)
- ❌ Position + age roster feed not integrated

**Plan Step 3** (line 448): "Implement grounding"
- ❌ **Blocks on plan step 2** — no build artifact, no in-memory store
- ❌ Requires embedding model choice (local vs API)
- ❌ Requires roster provider decision

**Plan Step 4–8:** All depend on earlier steps.

---

## Recommended Immediate Actions

1. **Create `package.json`** with `zod`, `@anthropic-ai/sdk`, `vitest`, `typescript`. This unblocks everything.
2. **Expand gold.seed.jsonl** to ~5 queries per critical tag. Use `revisiting_Arch.md` lines 539–602 as material.
3. **Implement the scorer** (`eval/scorer.ts`) following `eval/scorer.spec.md` (mechanical).
4. **Bootstrap the structural eval** (enum/status/sport/line-vs-odds/subject.kind, plus binding & market text-match) against the expanded corpus. This runs before grounding.
5. **Iterate the bounded prompt** (`resolver/extractor-prompt.md`) and the extractor call (plan step 1 final) using the structural eval as feedback.

These can happen in parallel while the expensive decisions (roster provider, embedding model, live-layer semantics) are finalized.

---

*Concerns audit: 2026-06-01*
