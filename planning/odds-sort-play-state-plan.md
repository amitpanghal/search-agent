# Plan: extract "odds sort" and "live vs pre-match"

## Context

Two natural-language sportsbook filters are recognised by people but have **no field** in the
query plan today, so the extractor silently drops them ([ScenariosLeft.md](ScenariosLeft.md)):

1. **Sort / rank by odds** — "which player has the *shortest odds* to score first", "*highest draw odds*".
   Today this crash-repairs to a plain market (a junk `odds: {min:0}` is stripped by `sanitizeOdds`) and
   the ranking intent is lost.
2. **In-play vs pre-match** — "*live* corner markets", "*pre-match* odds for the final". No live/prematch flag.

Goal: **extract** both into the structured plan, and verify the extraction in the eval — wired exactly as
`line`/`odds` are today (captured in the plan + graded by eval, but **not** carried into `FetchPlan`/executor).

### Decisions (locked with the user)

- `odds_sort: "low" | "high"` on the **selector** (per-market). `low` = shortest/lowest price first
  (favourite); `high` = longest/highest first (underdog). Word mapping: **shortest/lowest/best → `low`**,
  **longest/highest/biggest → `high`** (bare "best odds" = favourite = `low`).
- `play_state: "live" | "prematch"` on the **event_scope** (per-query). `null` = no preference.
- Scope = "like `line`/`odds` today": schema + prompt + normalize + eval grading. **No** `FetchPlan`,
  `ground-*`, or `disambiguate` changes (they don't consume these fields).

## Changes

### 1. `src/resolver/schema.ts`
- Add to `Selector`: `odds_sort: z.enum(["low", "high"]).optional()` (mirrors the optional `period` field).
- Add to `EventScope`: `play_state: z.enum(["live", "prematch"]).nullable()` (mirrors the required-nullable
  `region` field, so event_scope keeps its "always present, value-or-null" shape).

### 2. `src/resolver/extractor-prompt.md` — rule rewrites (sport-agnostic; no example-stacking)
Three crisp edits, then show exact old→new diffs for approval before applying (per our prompt workflow):
- **`odds` subsection (Step 3):** distinguish a price *bound* from a price *ranking*. A bare/`priced` number
  stays `odds`. A **superlative/comparative on the price** ("shortest/lowest/best odds" → `odds_sort:"low"`;
  "longest/highest/biggest odds" → `odds_sort:"high"`) emits `odds_sort`, never a bound. This is the
  root-cause fix for the old `{min:0}` placeholder.
- **`market_concept` superlative rule (Step 3):** carve out that "highest/best **odds/price**" is **not** a
  market superlative — the market is whatever is being priced ("to score first") and the price-ranking goes
  to `odds_sort`. ("which player has the shortest odds to score first" → market_concept "to score first" +
  `odds_sort:"low"`, never a market named "shortest odds".)
- **event_scope bullet (Step 2):** add `play_state`. "live / in-play / playing now / currently on" → `live`;
  "pre-match / before kick-off / not started" → `prematch`; else `null`. **Disambiguation:** a bare clock
  phrase ("now", "today", "next 48 hours", "this week") is a `time` window (anchor `now`), NOT `play_state`
  — only "in progress" wording sets `live`.
- Add `"play_state": null` to the two worked-example JSON blocks; add a one-line `odds_sort (optional)`
  note to the selector facet list.

### 3. `src/resolver/extract.ts` — `normalizePlan`
- In the selector-leaf cleanup: drop `odds_sort` if it isn't `"low"`/`"high"` (same defensive pattern as
  `sanitizeAttrFilter`). Keep `sanitizeOdds` as-is (safety net for legacy `{min:0}`).
- In the event_scope block: default an absent `play_state` key to `null` (exactly like the existing
  `region` default), and coerce an invalid value to `null`.

### 4. `src/eval/gold-record.ts` — keep the gold mirror in sync (schema.ts comment requires it)
- `GoldSelector`: add `odds_sort: z.enum(["low","high"]).optional()` (plain enum, not `Grounded` — mirrors
  how `period` is added).
- `GoldEventScope`: add `play_state: z.enum(["live","prematch"]).nullable().default(null)` (mirrors `region`'s
  `.default(null)` so pre-existing gold rows still parse).

### 5. `src/eval/structural-scorer.ts` — grade the new facets (additive, safe on existing rows)
- **`odds_sort`** (selector facet, parity with `odds`): add a `sortEqual(p, g)` check in the step-4
  per-pair loop next to `oddsEqual`, pushing a hard `failures` entry on mismatch. No-op when both sides are
  undefined → existing rows unaffected.
- **`play_state`** (event_scope facet → soft note, per the file's "event_scope facets are soft notes"
  convention): add a `play_state` comparison in `eventScopeDiffs` (new `ScopeFacet` value), emitting a soft
  note on mismatch. Leave it OUT of `HARD_FIXTURE_FACETS` (a marketless "live markets" query keeps it soft,
  like `level`/`competition`). No-op when both null.

### 6. `src/eval/behavior-tags.ts` — two new soft tags (with desc + example)
- `"odds-sort"` (soft): "Rank by price (shortest/longest odds) — a sort, not a bound." Example: `"shortest
  odds to score first" → odds_sort low; "highest draw odds" → odds_sort high.`
- `"play-state"` (soft): "Live (in-play) vs pre-match; a bare clock phrase stays a time window." Example:
  `"live corner markets" → play_state live; "games next 48h" → time window, play_state null.`
- Both added to `BEHAVIOR_TAG_IDS` and `BEHAVIOR_TAGS`. (Soft tier: a wrong sort/state is a display/recall
  miss, not a wrong-side bet — same tier as `odds-only-bounds`.)

### 7. `src/eval/gold.seed.jsonl` — add ~4 gold rows
Author with **real criterion ids** (find each via `npm run eval -- --ground "<concept>" --subject <kind>`):
- `odds-sort low`: "which Germany player has the shortest odds to score first" → `odds_sort:"low"`, market
  "to score first"/"first goalscorer".
- `odds-sort high`: "which match has the highest draw odds" → subject `event`, market **"match result"**
  + line **selection "draw"**, `odds_sort:"high"`.
- `play-state live`: "live corner markets for Germany right now" → `play_state:"live"`, market corners,
  AND `time.date_window = { value:"right now", anchor:"now" }`. **Both facets fire on purpose:** "live" is
  in-progress wording (→ `play_state`) and "right now" is a bare clock phrase (→ `time` window) — the row
  asserts the two co-exist, guarding that neither swallows the other.
- `play-state contrast`: "pre-match odds for the final" → `play_state:"prematch"`.

### 8. `planning/queries/EvaledQueries.md`
- After probing with `--query`, append/update the probed queries' entries (per the logging convention).

## Explicitly NOT changing (and why)
- **`ground-market.ts` / `ground-scope.ts`** — neither field changes *which* market/entity is matched, so
  grounding (and its memo key) is untouched. `run.ts:groundSelectors` already passes only concept/subject/
  line/period; no edit.
- **`disambiguate.ts`** — `structuredClone` carries `event_scope.play_state` and the selectors' `odds_sort`
  through automatically; the disambiguator reads neither.
- **`plan-fetch.ts` / executor** — out of scope by decision (extraction-only, like `line`/`odds` today).
- **`check-complete.ts`** — `play_state` is intentionally NOT an anchor ("show me live markets" with no
  team/league still asks for an anchor). No edit, confirmed by design.

## Verification
1. `npm run typecheck` — catches any type break from the schema/scorer additions.
2. Probe extraction (no grading), eyeball the new fields:
   - `npm run eval -- --query "which Germany player has the shortest odds to score first"` → `odds_sort:"low"`.
   - `npm run eval -- --query "which match has the highest draw odds"` → `odds_sort:"high"`.
   - `npm run eval -- --query "live corner markets for Germany right now"` → `play_state:"live"` AND a
     `time` window for "right now" (anchor `now`) — both fire (live wording + a clock phrase).
   - `npm run eval -- --query "games in the next 48 hours"` → `play_state` stays **null** (time window only) —
     guards the live-vs-time disambiguation rule.
   - `npm run eval -- --query "first goalscorer priced over 5.0"` → `odds:{min:5}`, **no** `odds_sort` —
     guards the bound-vs-sort split.
3. `npm run eval` (1× ship gate) — confirm no critical-tag regression; the two new soft tags report. (Skip
   the 5× `--release` run unless reproducibility is needed.)
4. Append the probed queries to `planning/queries/EvaledQueries.md`.
