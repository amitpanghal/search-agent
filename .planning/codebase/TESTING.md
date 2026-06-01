# Testing Patterns

**Analysis Date:** 2026-06-01

## Golden Eval Set — Design & Approach

The **golden eval set** is the dominant testing approach for this resolver. Testing happens **through grounding to real catalog ids**, not on the extractor's text output in isolation — because "right market" is only meaningful post-grounding.

**Current state:**
- **Spec + seed data exist** (`eval/scorer.spec.md`, `eval/gold.seed.jsonl`, `eval/gold.meta.json`, schema in `eval/gold-record.ts`).
- **Scorer is specified but NOT YET BUILT** — the algorithm is pinned in `eval/scorer.spec.md` but the runnable implementation doesn't exist.
- **Test runner / framework is NOT YET INSTALLED** — no `package.json`, no test harness.
- **Structural eval (pre-grounding axes)** is authorable now against raw extractor output; full post-grounding eval waits for step 3 (grounding implementation).

## Test File Organization

**Locations:**
- Specs + designs: `eval/scorer.spec.md` (algorithm), `eval/behavior-tags.ts` (tag definitions).
- Schema definitions: `eval/gold-record.ts` (gold record Zod schema + type), `resolver/schema.ts` (runtime extractor schema).
- Seed data: `eval/gold.seed.jsonl` (one gold record per line, JSONL format), `eval/gold.meta.json` (schema version + catalog version stamp).

**Naming:**
- `*.spec.md`: specification document (algorithm + grading rules).
- `gold.seed.jsonl`: the test corpus (one record per line, each a `GoldRecord`).
- `gold.meta.json`: metadata stamp (versioning, validation, statistics).

## Gold Record Structure

**Schema:** `eval/gold-record.ts` exports `GoldRecord`:

```typescript
export const GoldRecord = z.object({
  id: z.string().min(1),                    // gold row id, e.g. "g001"
  query: z.string().min(1),                 // raw natural-language query under test
  tags: z.array(z.enum(BEHAVIOR_TAG_IDS)).min(1), // behaviors this query stresses
  expect: GoldPlan,                         // the grounded plan it must produce
  notes: z.string().optional(),             // authoring rationale, edge cases
});
```

**Every groundable cell is a `Grounded` object:**
```typescript
export const Grounded = z.object({
  id: z.union([z.number(), z.array(z.number()).min(1)]), // single id or id set
  accept: z.array(z.string()).default([]), // diagnostic surface-form variants
});
```

The `id` is the **source of truth** for grading; `accept[]` is diagnostic-only (for triage + a future text-fidelity layer). An id **set** occurs when a groundable cell has multiple valid resolutions:
- `either_match_team` + team-total market → home+away split criteria id set.
- `attrFilter.position` like "strikers" → participant id set.

**Seed data example (g001):**
```json
{
  "id": "g001",
  "query": "Portugal vs Brazil quarterfinal with Bruno Fernandes corner markets...",
  "tags": ["binding", "either-team", "stage"],
  "expect": {
    "status": "resolved",
    "sport": "FOOTBALL",
    "event_scope": {
      "teams": [
        { "id": 1000000147, "accept": ["Portugal"] },
        { "id": 1000003189, "accept": ["Brazil"] }
      ],
      "players": [],
      "competition": null,
      "level": "fixture",
      "stage": { "round": "quarterfinal", "ordinal": null, "conditional": false },
      "time": null
    },
    "selectors": [
      {
        "subject": { "kind": "player", "name": { "id": 1001699381, "accept": ["Bruno Fernandes"] } },
        "market_concept": { "id": 1001159897, "accept": ["corners", "corner markets"] }
      },
      ...
    ]
  },
  "notes": "Homonym disambiguation by context..."
}
```

## Behavior Tags

**Tag system (`eval/behavior-tags.ts`):**

Covers ~17 behaviors split into **critical** (100% ship gate) and **soft** (~90% aggregate):

**Critical behaviors (must be 100%):**
- `binding`: Attach each market to the subject that owns it (nearest preceding named subject).
- `coref-his`: Resolve pronouns (his/their) to the concrete player.
- `coref-his-team`: Resolve "his team" to the national team (in World Cup context), not the club.
- `line-vs-price`: Distinguish a stat threshold (line) from a price bound (odds).
- `abstain`: Emit a sentinel status (`unsupported`/`ambiguous`) instead of fabricating a plan.
- `either-team`: A generic team market with ≥2 match teams and no side named → `subject.kind === "either_match_team"`.
- `yes/no-line`: A binary market's side (getting it wrong is the opposite bet).
- `self-correction`: In-query retraction; record the final intent only, drop the retracted entity.
- `sport-default`: No sport named → resolve to the sole built sport (FOOTBALL today).

**Soft behaviors (~90% aggregate):**
- `line-no-number`: A market named with no explicit number → omit the line (means all offered lines).
- `attrFilter`: Outcome attribute filter (position/region/age) applied within a market.
- `player-role`: Event-scoping player role (plays | starts | captain).
- `level`: Fixture-level vs competition-level (tournament-wide future).
- `stage`: Tournament round (including subject-relative openers + conditional slots).
- `time`: Time facet (date_window vs kickoff_time_of_day, tournament- vs now-relative anchor).
- `odds-only-bounds`: Only a price bound with no line.
- `age-normalize`: Convert age phrasing to inclusive integer bounds (e.g., "under 23" → `ageMax: 22`).

**Coverage target:** ~5 queries per behavior, ~50–70 total queries. Each query is **multi-tagged** (stresses multiple behaviors); pass-rate is reported per tag so blind spots are visible.

**Current state:** Seed set has 3 records (g001–g003); abstain cases missing (unbuilt-sport, no-sport-default, and mixed-sport buckets incomplete). Expanding toward full coverage is part of plan step 1.

## Scoring Algorithm

**Specification:** `eval/scorer.spec.md` (not yet runnable; algorithm is pinned).

### Inputs & Load (E11)

```typescript
score(gold: GoldRecord, runs: ResolverRun[]): QueryResult
// ResolverRun = { grounded: GroundedPlan; rawText: ExtractorPlan }
```

- Load `gold.meta.json`; record `schemaVersion` + `catalogVersion`.
- Validate every gold record against `GoldRecord` (Zod).
- For every `Grounded.id` (including id **sets**), check it exists in the loaded catalog. Missing id → **"stale gold — re-author"**: that **cell is skipped**, the query is flagged, and the cell is **never counted as an AI failure**. (A catalog rebuild can't mask a regression.)

### Run Protocol (E10)

- Run each query **5 times** at temperature 0.
- Query passes only if **all 5 runs pass** — a market right 4/5 times is a **fail** (1-in-5 wrong bet is unshippable).
- Report per-query pass-rate (e.g., `4/5`) so residual nondeterminism is visible even at temp 0.
- Cadence: **1 run per change** while iterating; **5 before release** (~300 calls/full run — cheap).

### Scoring One Run (E3–E5)

**Step 1: Status gate (E6)**
- `grounded.status` must equal `gold.expect.status`.
- Mismatch → **hard fail** (worst error: fabricating a plan when we expected `unsupported`, or vice versa).
- For `unsupported`/`ambiguous`, scoring finished; loose text check on `recognizedAs` is diagnostic-only.
- For `resolved`, continue.

**Step 2: Sport (costly)**
- `grounded.sport` must equal `gold.expect.sport` exactly.
- Wrong sport → hard fail.

**Step 3: Selector alignment — pair by market, never positionally (E3)**
- Match each predicted selector to the gold selector with the **same `market_concept` id** (for an id set, match if id sets are equal as sets).
- Alignment is order-independent.
- Report:
  - **markets-found** — precision & recall over market ids (unmatched predicted = false positive; unmatched gold = miss).

**Step 4: Three axes per aligned pair (E3)**

For each gold↔predicted pair sharing a market id, score three **separate** numbers:

| Axis | Check |
|------|-------|
| **(a) market found** | Already true by pairing |
| **(b) binding** | `subject.kind` matches AND, for `player`/`team`, the grounded subject id matches. For `either_match_team`/`event`, kind alone. |
| **(c) line / odds** | Line exact (`kind` + `direction` + `value`); odds exact (`min`/`max` present and equal). |

**Key insight:** A subject↔market **swap** scores markets-found = 100% but **binding = fail** — reads as *"found the markets, mis-bound them"*, keeping the make-or-break (binding) legible.

**Step 5: event_scope**
- `teams` — id-set match (order-independent).
- `competition` — id match (or both null).
- `level` — exact enum.
- `players[]` — each `name` id + `role` enum.
- `stage`/`time` — **text/label** facets (soft, leniently compared, never block a pass).

### Verdict — Strict Pass (E5)

A run **passes** if **every costly facet is exact**:
- `status` (+ correct abstain bucket),
- `sport`,
- every market id (markets-found recall = 100%, no false-positive market),
- **binding** on every selector,
- **line side + value** and **odds bounds** on every selector.

**Soft facets** (stage/time wording, optional-facet recall) are **tracked** but **never earn a pass**. A **wrong answer is weighed worse than a missing one** (precision ≫ recall — money on the line).

### Aggregation & Coverage (E7)

- Group queries by **behavior tag**; report **pass-rate per tag**.
- A query contributes to every tag it carries (multi-tagged).
- Thin tags are coverage gaps to fill.

### Ship Gate (E12)

- **Critical tags** (`CRITICAL_TAGS` from `behavior-tags.ts`) must be **100%**.
- **Soft tags** sit on an **aggregate ~90%** bar.
- One critical miss **blocks release**; soft misses are tracked.
- The exact percentages are calibratable against a baseline; the principle (critical = 100, soft = aggregate) is fixed.

## Failure Triage (E4)

On any fail, emit:
- Per-axis diagnostics (which facet failed: status, sport, market ids, binding, line/odds, stage/time).
- The **`rawText` plan** (extractor's pre-grounding text output) **beside the grounded output**.

This allows human localization:
- Gold words present in `rawText`, wrong id in `grounded` → **grounding bug**.
- Gold words absent from `rawText` → **extraction bug**.

Automating this attribution is deferred (open question in `revisiting_Arch.md`).

## Worked Example — Grading g001 with a Binding Swap

**Gold g001 (abbreviated):**
- Selectors: `[Bruno→corners(1001159897)`, `Vitinha→SOT(2100015085) over 0.5`, `either_match_team→team-goals({1001159967,1001159633}) over 1.5]`.

**Predicted output (hypothetical):**
- Markets right but Bruno and Vitinha swapped: `[Bruno→SOT over 0.5`, `Vitinha→corners`, `either_match_team→team-goals over 1.5]`.

**Scoring:**

| Step | Result |
|------|--------|
| Status gate | `resolved` == `resolved` ✓ |
| Sport | `FOOTBALL` ✓ |
| Align by market id | All 3 market ids pair → **markets-found = 3/3 (100%)** |
| Axis (b) binding — corners pair | Gold owner Bruno (1001699381), predicted Vitinha (1001982735) → **fail** |
| Axis (b) binding — SOT pair | Gold owner Vitinha, predicted Bruno → **fail** |
| Axis (b) binding — team-goals pair | Both `either_match_team` ✓ |
| Axis (c) line/odds | over 0.5 ✓, over 1.5 ✓ |
| **Verdict** | Binding is a **costly facet** and failed → **query FAILS** despite 100% markets-found |
| **Reads as** | *"Found all 3 markets, mis-bound 2 of them"* — `binding` is a critical tag, so this **blocks the ship gate** |

This design (E3/E5) ensures a swap can't hide behind a high markets-found score.

## Reproducibility Rules

**Temperature 0:**
- All LLM calls run at `temperature: 0` (no randomness at the model level).
- Residual nondeterminism can still occur (e.g., tie-breaking in search, hardware floating-point variance), so **5× repetition is mandatory**.

**Consistency = correctness:**
- A market right 4/5 times is a **fail** — a 1-in-5 wrong bet on a sports betting platform is unshippable.
- Per-query pass-rate is reported so flakiness is visible (e.g., "g001: 5/5 PASS", "g002: 4/5 FAIL").

**Determinism validation:**
- Even at temp 0, running 5× surfaces whether the extractor, grounder, or retrieval has residual nondeterminism.
- If all 5 runs differ, the blocker is in one of those layers; if 4 agree and 1 differs, it's latency/resource-dependent.

## Validation & Staleness (E11)

**Stamp and validate on load:**
- Gold file carries `schemaVersion` (format version, e.g. `gold-record/v1`) and `catalogVersion` (Kambi catalog snapshot it was authored against).
- At eval start, every `Grounded.id` is checked against the loaded catalog.
- Missing id → **"stale gold — re-author"**: that **cell is skipped, flagged, and never counted as an AI failure**.
- A catalog rebuild (e.g., adding new criterions, renaming teams) can't make a stale key masquerade as a regression.

**Current metadata** (`eval/gold.meta.json`):
```json
{
  "schemaVersion": "gold-record/v1",
  "catalogVersion": "football@unversioned-2026-05-28",
  "catalogCounts": { "criterions": 607, "clubs": 1784, "players": 32587 },
  "sports": ["FOOTBALL"],
  "generatedFrom": [
    "football/football_criterions.json",
    "football/football_participants.json"
  ]
}
```

## Findings from Authoring the Seed Records

Pressure-testing the design against g001–g003 surfaced:

1. **Groundable cells can be an id SET.** `g001`'s "team total goals" (`either_match_team`) grounds to `{home_criteria, away_criteria}` because the catalog splits team totals by side. `AttrFilter` predicates also ground to id sets. E9 specified single-id cells; widened here to `id: number | number[]`.

2. **Player-bound team market.** `g001`'s "Bruno corners" binds a `player` subject to a team-level market (no player-corner criterion exists). Gold keeps the **stated binding** (faithful to "Bruno↔corners" in the query); the executor decides whether it can filter. Pin whether this is always the rule or whether some markets should **reject** a player owner.

3. **Tier calibration.** `behavior-tags.ts` assigns critical/soft per tag with a rationale, but E12 only fixed the facets (status, sport, market ids, binding, line/odds). The tag→tier split is a **judgement call** — calibrate against a real baseline before trusting the gate.

4. **Corpus still lacks abstain cases.** g002 (tennis) and g003 (no-sport) are the first two; the **football+unbuilt-mix bucket** and more coverage of `abstain`/`sport-default` behaviors still need authoring. Target ~50–70 total.

## Current Implementation Status

**Built:**
- ✓ Schema: `resolver/schema.ts` (runtime extractor `QueryPlan`), `eval/gold-record.ts` (gold record + `Grounded` cell).
- ✓ Behavior tags: `eval/behavior-tags.ts` (tag definitions, critical/soft tier split).
- ✓ Seed data: `eval/gold.seed.jsonl` (g001–g003), `eval/gold.meta.json` (metadata stamp).
- ✓ Scoring spec: `eval/scorer.spec.md` (algorithm pinned, not runnable).

**Not yet built:**
- ✗ Scorer implementation (runnable code that ingests `gold.seed.jsonl` and runs the scoring algorithm).
- ✗ Test runner / framework (no `package.json`, no test harness installed).
- ✗ Grounding implementation (plan step 3) — only the id-graded axes can run once grounding exists.

**Ahead of grounding (runnable now with bootstrapped `package.json` + Zod + SDK):**
- Structural eval on raw extractor output: `status`, `sport`, `subject.kind`, line-vs-odds typing+values, `level`, `role`, `attrFilter` routing, and binding (market matched by text against `accept[]`).
- The full post-grounding eval waits for plan step 3.

---

*Testing analysis: 2026-06-01*
