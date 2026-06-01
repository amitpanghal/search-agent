# Golden eval scorer — spec

How a gold record (`gold-record.ts`, data in `gold.seed.jsonl`) is graded against the
resolver's output. This is a **spec**, not runnable code: the scorer can only *run* once
grounding exists (plan step 3), and the resolver's grounded-output type isn't authored as
code yet. It pins the algorithm so the implementation is mechanical. Decisions referenced
as E1–E12 live in `revisiting_Arch.md`.

## Inputs

```ts
score(gold: GoldRecord, runs: ResolverRun[]): QueryResult
// ResolverRun = { grounded: GroundedPlan; rawText: ExtractorPlan }
//   grounded : the resolver's plan WITH catalog ids (same shape as gold.expect)
//   rawText  : the extractor's pre-grounding text plan, kept for triage only (E4)
```

The resolver is run at **temperature 0** (E10). `rawText` is never graded — it exists so a
failure can be localised to **extraction** (wrong words) vs **grounding** (good words,
wrong id).

## Run protocol (E10)

- Run each query **5×**. The query passes only if **all 5** runs pass — a market that is
  right 4/5 times is a **fail** (a 1-in-5 wrong bet is unshippable).
- Report the per-query pass-rate (e.g. `4/5`) so residual nondeterminism is visible even at
  temp 0.
- Cadence: **1 run per change** while iterating, **5 before release**.

## Load + validation (E11)

1. Read `gold.meta.json`; record `schemaVersion` + `catalogVersion`.
2. Validate every record against `GoldRecord` (zod).
3. For every `Grounded.id` (including each element of an id **set**), check it exists in the
   loaded catalog. A missing id → **`stale gold — re-author`**: that **cell is skipped**, the
   query is flagged, and the cell is **never counted as an AI failure**. A catalog rebuild
   therefore can't make a stale key masquerade as a regression.

## Scoring one run

### 1. Status gate (E6)

`grounded.status` must equal `gold.expect.status`.
- Mismatch → **hard fail** (this is the abstain axis; a fabricated plan where we expected
  `unsupported`, or vice-versa, is the worst error).
- `unsupported` / `ambiguous` → grade is finished here. For `unsupported`, also do a **loose
  text** check of `recognizedAs` (substring / fuzzy, diagnostic — not pass-blocking).
- `resolved` → continue.

### 2. Sport (costly)

`grounded.sport` must equal `gold.expect.sport` exactly. Wrong sport → hard fail.

### 3. Selector alignment — pair by market, never positionally (E3)

Match each predicted selector to the gold selector with the **same `market_concept` id**
(for an id **set**, match if the id sets are equal as sets). Alignment is order-independent.
Report:
- **markets-found** — precision & recall over market ids (unmatched predicted = false
  positive; unmatched gold = miss).

### 4. Three axes per aligned pair (E3)

For each gold↔predicted pair that share a market id, score three **separate** numbers:

| axis | check |
|---|---|
| **(a) market found** | already true by pairing |
| **(b) binding** | `subject.kind` matches AND, for `player`/`team`, the grounded subject id matches. For `either_match_team`/`event`, kind alone. |
| **(c) line / odds** | `line` exact (`kind` + `direction` + `value`); `odds` exact (`min`/`max` present and equal). |

A subject↔market **swap** therefore scores markets-found = 100% but **binding = fail** — it
reads as *"found the markets, mis-bound them"*, keeping the make-or-break (binding) legible.

### 5. event_scope

- `teams` — id-set match (order-independent). `competition` — id match (or both null).
- `level` — exact enum.
- `players[]` — each `name` id + `role` enum.
- `stage` / `time` — **text/label** facets (E2): compared leniently (normalised string /
  enum), tracked as **soft**, do not block a single-run pass.

## Verdict — strict pass on the costly facets (E5)

A run **passes** iff **every costly facet is exact**:

- `status` (+ correct abstain bucket),
- `sport`,
- every market id (markets-found recall = 100%, no false-positive market),
- **binding** on every selector,
- **line side + value** and **odds bounds** on every selector.

The soft facets (stage/time wording, optional-facet recall) are **tracked** (how *close* a
fail was) but **never earn a pass**. A **wrong** answer is weighed worse than a **missing**
one — precision ≫ recall, because there's money on the line. (Rejected alternatives: a single
partial-credit score hides a wrong bet under a healthy average; whole-plan exact match fails
on a harmless wording gap.)

## Aggregation + coverage (E7)

- Group queries by **behavior tag**; report **pass-rate per tag** (a query contributes to
  every tag it carries).
- Target ~5 queries per tag; thin tags are a coverage gap to fill.

## Ship gate (E12)

- **Critical** tags (`CRITICAL_TAGS` in `behavior-tags.ts`) must be **100%**.
- **Soft** tags sit on an **aggregate ~90%** bar.
- One critical miss **blocks release**; soft misses are tracked.
- The exact percentages and the critical/soft split are **calibratable** against a baseline;
  the principle (critical = 100, soft = aggregate) is fixed.

## Failure triage (E4)

On any fail, emit the per-axis diagnostics **plus the `rawText` plan** beside the grounded
output, so a human can localise the break:
- gold words present in `rawText`, wrong id in `grounded` → **grounding** bug.
- gold words absent from `rawText` → **extraction** bug.

Automating this attribution is deferred (open question in `revisiting_Arch.md`).

## Worked example — grading `g001` with a binding swap

Gold `g001` (abbrev): selectors = `[Bruno→corners(1001159897)`, `Vitinha→SOT(2100015085) over 0.5`,
`either_match_team→team-goals({1001159967,1001159633}) over 1.5]`.

Suppose one run returns the **markets right but Bruno and Vitinha swapped**:
`[Bruno→SOT over 0.5`, `Vitinha→corners`, `either_match_team→team-goals over 1.5]`.

| step | result |
|---|---|
| status gate | `resolved` == `resolved` ✓ |
| sport | `FOOTBALL` ✓ |
| align by market id | all 3 market ids pair → **markets-found = 3/3 (100%)** |
| axis (b) binding — corners pair | gold owner Bruno (1001699381), predicted Vitinha (1001982735) → **fail** |
| axis (b) binding — SOT pair | gold owner Vitinha, predicted Bruno → **fail** |
| axis (b) binding — team-goals pair | both `either_match_team` ✓ |
| axis (c) line/odds | over 0.5 ✓, over 1.5 ✓ |
| **verdict** | binding is a **costly facet** and failed → **query FAILS** despite 100% markets-found |
| reads as | *"found all 3 markets, mis-bound 2 of them"* — `binding` is a **critical** tag, so this **blocks the gate** (E12) |

This is the design's whole point (E3/E5): a swap can't hide behind a high markets-found score.

## Findings surfaced while authoring the seed records

Pressure-testing the design against the three real records produced these (logged as open
questions in `revisiting_Arch.md`):

1. **Groundable cells can be an id SET, not one id.** `g001`'s "team total goals"
   (`either_match_team`) grounds to the home+away split criteria `{1001159967, 1001159633}`;
   an attrFilter like "strikers" grounds to a player-id set too. E9 specified a single-id
   `{id, accept[]}` cell — widened here to `id: number | number[]`. Confirm this is the
   chosen representation (vs a separate `ids[]` field).
2. **Player-bound team market.** `g001`'s "Bruno corners" binds a `player` subject to a
   team/match market (no player-corner criterion exists). The gold keeps the stated binding
   (faithful to the doc's `Bruno↔corners`); pin whether that's always the rule or whether
   some markets should reject a player owner.
3. **Tier mapping is a judgement call.** `behavior-tags.ts` assigns critical/soft per tag
   with a rationale, but E12 only fixed the *facets*. Calibrate the tag→tier split against a
   real baseline before trusting the gate.
4. **Corpus still lacks abstain cases.** `g002` (tennis) and `g003` (no-sport default) are
   the first two; the football+unbuilt-mix bucket (E6 iii) and more `abstain` / `sport-default`
   coverage still need authoring.
