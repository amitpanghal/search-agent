# Plan: #1 "next-game" fix + #2 no-result-reason policy

## Context

Full-app probing of the executor surfaced two honesty gaps:

- **#1 — "next game" is ignored.** *"Musiala to score in his next game"* returns **all** his upcoming
  matches (Germany–Ivory Coast Jun 20 *and* Ecuador–Germany Jun 25), because "next game" is neither a date
  window nor a stage, so the extractor emits `time: null` and the executor never narrows to one fixture.
- **#2 — empty results are silent.** *"BTTS in Netherlands vs Sweden under 1.5"* returns a blank answer with
  `notes: []`. But BTTS Yes **is** offered at **1.72** — just above the 1.5 cap. The user can't tell "not
  offered" from "priced out" from "teams don't meet". Probed and confirmed: NL–Sweden BTTS Yes = 1.72 (price
  cap), England+Brazil share no fixture (teams don't meet) — these are genuinely distinct empties.

Outcome: (1) relative fixture phrases ("next game", "next 2 fixtures", "last game today") resolve to the right
ordinal slice of fixtures; (2) every empty result carries a reason + a plain-English message (and, where useful,
the closest price and the related-market shelf as alternatives).

Both changes are isolated to the executor + time resolver (+ extractor schema/prompt for #1). No grounding,
catalog, or eval-path code changes.

---

## Part 1 — relative fixture selection ("next game", "next 2", "last game today", …)

Every one of these phrases is the **same operation**: from the time-sorted list of candidate fixtures, keep a
subset by position. It has three knobs — a **window** (already `date_window`: today / weekend / "from now"),
an **order** (count from the front = earliest, or the back = latest), and a **count** (how many). "next game"
is just `order: earliest, count: 1`. So we don't patch "next game" — we let the LLM fill those knobs into one
structured field and have the executor apply it generically. No regex, no per-phrase rules.

### 1a. `src/resolver/schema.ts` — add `fixture_pick` to `time`
The `time` object (≈lines 88–95) carries `date_window` + `kickoff_time_of_day`. Add a third nullable sub-field:
```ts
fixture_pick: z
  .object({ order: z.enum(["earliest", "latest"]), count: z.number().int().min(1) })
  .nullable(),
```
`null` = keep every fixture in the window (the default); set only for an ordinal slice. `ResolvedScope["time"]`
is `QueryPlan["event_scope"]["time"]` verbatim (`time: es.time`, ground-scope.ts:286), so the field flows
untouched into `postFilters.time` and `TimeField` — **no other plumbing**. Also relax the `time` refine
(line 95) to allow `fixture_pick` alone ("his next game" has no window):
`date_window !== null || kickoff_time_of_day !== null || fixture_pick !== null`.

### 1b. `src/resolver/extractor-prompt.md` — fixture-pick rule (show diff + get approval before editing)
Add a `fixture_pick` bullet to the `time` rule (sport-agnostic, rule-shaped — not per-query examples):
> **`fixture_pick`** (or `null`) — set when the query asks for a fixed **number of matches by their order in
> time**, not a date range. `order` = `"earliest"` for "next / upcoming / first", `"latest"` for "last / most
> recent"; `count` = how many (default 1). A pure date range ("this weekend", "all Tuesday games") sets only
> `date_window`. A per-day band ("late kick-offs") stays `kickoff_time_of_day`. A round-tied ordinal ("their
> last group game", "the opener") stays `stage.ordinal`. **Never set `fixture_pick` together with `stage.ordinal`.**

Neutral examples (mirror existing style):
- "his next game" → time `{ date_window: null, kickoff_time_of_day: null, fixture_pick: { order: "earliest", count: 1 } }`.
- "last game today" → time `{ date_window: { value: "today", anchor: "now" }, kickoff_time_of_day: null, fixture_pick: { order: "latest", count: 1 } }`.
- "all weekend matches" → time `{ date_window: { value: "weekend", anchor: "now" }, kickoff_time_of_day: null, fixture_pick: null }`.

Verify it didn't shift other extractions via the eval gate.

### 1c. `src/resolver/time-window.ts` — carry the pick
- Add `pick?: { order: "earliest" | "latest"; count: number }` to `TimeWindow`.
- In `resolveTimeWindow`, after the date_window / kickoff branches:
  `if (time.fixture_pick) { w.pick = time.fixture_pick; if (!w.from) w.from = ctx.now; }` — lower-bound at now
  so "earliest/latest" never reaches into past fixtures. `TimeField` already widens to include the new field;
  `hasWindow` is already true because `from` is set, so the step-(5) time filter runs.

### 1d. `src/resolver/executor.ts` — generic reduction (in `postFilter`, right after step (5) time)
```ts
if (window?.pick && offers.length) {
  const startMs = (o: BetOffer) => { const e = eventOf(o); return e?.start ? +new Date(e.start) : null; };
  const times = [...new Set(offers.map(startMs).filter((t): t is number => t != null))].sort((a, b) => a - b);
  const { order, count } = window.pick;
  const chosen = new Set(order === "earliest" ? times.slice(0, count) : times.slice(-count));
  offers = offers.filter((o) => { const t = startMs(o); return t != null && chosen.has(t); });
}
```
Picks the first/last N **distinct kickoff times** (ties at a chosen kickoff keep both — the rule "next game"
already wanted). `{ earliest, 1 }` is exactly the literal "next game" — a strict generalization. Globally
earliest/latest across all fetched fixtures (club or country); self-narrows when a competition/window is named.
Reuses the existing `eventOf` closure.

**Worked example (Q1):** Musiala "To Score" on Jun 20 + Jun 25 → `{ earliest, 1 }` → **only Germany–Ivory
Coast (Jun 20) @2.8**. "next 2 fixtures" → `{ earliest, 2 }` → both kept. "last game today" → today window
+ `{ latest, 1 }` → the latest-kickoff match today.

**Boundary (the one design risk):** three selectors already encode "which fixtures" — `date_window` (a range),
`kickoff` relative `late`/`early` (each day's extreme), `stage.ordinal` (order within a round). `fixture_pick`
is the fourth (count by clock order). The 1b rule routes each phrase to exactly one, and the
`stage.ordinal` ⊕ `fixture_pick` guard stops two reducers firing on one query. (`stage` isn't executed today,
so there's no live double-apply yet — the guard is forward-cover.)

*Deferred (perf only):* trimming the group fan-out event list to the chosen N before batching — these are
almost always participant queries (no fan-out), so the postFilter reduction is sufficient for correctness.

---

## Part 2 — no-result-reason policy (`src/resolver/executor.ts`)

Track the filter funnel in `postFilter`; when offers end empty, attribute it to the **first stage that
zeroed** and emit a reason + message. The executor's stages already run in order — instrument counts between
them.

### 2a. Types
```ts
export type NoResultReason =
  | "no-fetch" | "nothing-offered" | "teams-dont-meet" | "scope-mismatch"
  | "player-not-offered" | "price-or-line" | "out-of-window";
export type NoResult = { reason: NoResultReason; message: string; closest?: { market: string; pick: string; odds: number } };
```
Extend `PostFilterResult` with `noResult?: NoResult`.

### 2b. Funnel in `postFilter`
Capture counts: `fetched` (raw, pre-filter), `afterCriterion`, `afterEvent`, `afterPlayer`, a
`beforeOutcomes` snapshot (`offers.slice()` before step 4), `afterOutcome`, `afterTime`. After the pipeline,
if `offers.length === 0`, pick the reason by the first stage to hit 0:
- `fetched === 0` → **no-fetch**.
- `afterCriterion === 0` → **nothing-offered** (market absent for these events).
- `afterEvent === 0` → **teams-dont-meet** when
  `pf.opponentTeamIds?.length && ![...eventById.values()].some(e => hasAllParticipants(e, pf.opponentTeamIds))`
  (reuse existing `hasAllParticipants`), else **scope-mismatch**. *(Step 2 drops on five fused causes — level,
  play-state, competition, region, opponent. Only the opponent case is separable here; the rest collapse to
  `scope-mismatch`, whose message stays honestly generic ("those games aren't available for this market and
  scope") rather than asserting a single cause it can't verify — e.g. a market that exists only under a
  different competition must not be reported as a "wrong level".)*
- `afterPlayer === 0` → **player-not-offered**.
- `afterOutcome === 0` → **price-or-line**. Compute `closest` over `beforeOutcomes` offers of the constrained
  criterion, **after re-applying the selector's `line`/selection but dropping only the `odds` bound** (via the
  existing `matchesLine`), then take the min-odds surviving outcome — so it reports the pick the user asked
  for, not the cheapest unrelated one. For a line-only miss, list the offered lines.
  *Why the re-apply matters:* "BTTS **Yes** under 1.5" with Yes @1.72, No @1.40 → keep **Yes** only → report
  Yes @1.72 (over the cap). Without it, `closest` would scan both picks and surface **No @1.40** — a market the
  user never asked for, *below* their 1.5 cap, which reads as self-contradictory.
- `afterTime === 0` → **out-of-window**.

Message built by a small `noResultMessage(reason, facts)` helper — simple English, two-part (what's wrong +
the alternative/closest). Names via `loadCatalog().byId` (market) and `loadScopeCatalog().teamById` (teams;
`loadScopeCatalog` is already imported in this file for `checkExecutable`).

### 2c. Answer shape + assembly
Add a third `Answer` kind:
```ts
| { kind: "no-results"; reason: NoResultReason; message: string; closest?: { market: string; pick: string; odds: number }; related: Related[]; notes: string[] }
```
In `assembleAnswer` (return type widened to `Answer`): if `pf.offers.length === 0 && pf.noResult` → return
`{ kind: "no-results", ...pf.noResult, related: buildShelf(plan), notes: pf.notes }` (shelf = the "try these
instead" suggestion). Otherwise the existing `results`. `execute` is unchanged (already returns
`assembleAnswer(...)`).

**Worked example (Q2):** `afterOutcome === 0` → reason **price-or-line**, `closest = { market: "Both Teams To
Score", pick: "Yes", odds: 1.72 }`, message *"Both Teams To Score is offered, but the lowest price is 1.72 —
above your 1.5 cap."* + the related shelf (Draw & BTTS, etc.).

---

## Phasing

Two independent tracks (Part 1 ⟂ Part 2 — different code regions, no shared types; either order, or two PRs).
Within a track the signal flows **define → carry → consume**, so each phase ships along that arrow and the
in-between state is *inert* (a field carried but not yet read), never a half-broken feature.

**Track 1 — fixture selection**
- **Phase 1 — extraction contract** (`schema.ts` + `extractor-prompt.md`, Parts 1a+1b). LLM emits `fixture_pick`;
  schema accepts it. Coherent alone: the field is carried but **not read yet** (time-window/executor unchanged),
  so every query *executes* exactly as today — only the output JSON changes. *Gate:* eval no-regress + extractor
  probes ("next game"→`{earliest,1}`, "next 2"→`{earliest,2}`, "last today"→`{latest,1}`, "all weekend"→`null`).
  Ship schema+prompt **together** — a required-nullable field with no prompt rule would fail Zod on every query.
- **Phase 2 — executor activation** (`time-window.ts` + `executor.ts`, Parts 1c+1d). Carry `pick` onto
  `TimeWindow`; the generic reducer trims to first/last N. Coherent alone: reads a field already live since
  Phase 1 (was a no-op). *Gate:* `probe-phase4` synthetic picks (Jun 20/Jun 25 → `{earliest,1}` keeps Jun 20,
  `{earliest,2}` both, `{latest,1}` keeps Jun 25) + live `probe-app` Q1.

**Track 2 — no-result reason**
- **Phase 3 — funnel** (`executor.ts` types + `postFilter`, Parts 2a+2b). Count the funnel; compute `reason` +
  `closest`; store on `PostFilterResult.noResult`. Coherent alone: `assembleAnswer` still ignores `noResult`, so
  empties stay `kind:"results"` (today's behavior) — computed but not surfaced. *Gate:* `probe-noresult` on
  synthetic `TaskResult`s (price-cap Yes 1.72 vs No 1.40 → `closest`=Yes; teams-dont-meet; scope-mismatch;
  nothing-offered).
- **Phase 4 — surface** (`executor.ts` `Answer` kind + `assembleAnswer`, Part 2c). Empties become
  `kind:"no-results"` with message + shelf. Coherent alone: tiny diff consuming Phase 3's data; blast radius =
  only `probe-app` reads `Answer`. *Gate:* live `probe-app` Q2 → `kind:"no-results"`, message names 1.72 vs 1.5.

Each phase compiles standalone, leaves a coherent state, has its own (mostly deterministic) gate, and touches a
small focused region. Only Phases 2 and 4 change live behavior; each is independently revertable. Order
**1→2** and **3→4**; group a track into one PR if fewer review rounds are preferred.

## Critical files
- `src/resolver/schema.ts` — Part 1a (`fixture_pick` sub-field + relaxed `time` refine).
- `src/resolver/extractor-prompt.md` — Part 1b (one `fixture_pick` rule + 3 examples; show diff + approve first).
- `src/resolver/time-window.ts` — Part 1c (`pick` flag on `TimeWindow` + read `time.fixture_pick`).
- `src/resolver/executor.ts` — Part 1d (generic `pick` reduction in `postFilter`) + all of Part 2 (funnel, types,
  `noResultMessage`, `Answer` kind, `assembleAnswer`).

## Reused utilities (no new versions)
- `hasAllParticipants`, `eventOf`, `buildShelf` / `relatedMarkets`, `loadCatalog`, `loadScopeCatalog`
  (`executor.ts`).
- `eventMatchesTime` / `filterEventsByTime` / `hasWindow` (`time-window.ts`).

## Verification
- **Deterministic** (extend existing probes, no network):
  - `scripts/probe-phase4.ts` — add: `fixture_pick { earliest, 1 }` → `pick` on the window; and `postFilter`
    reduction checks on synthetic events (Jun 20 / Jun 25 → `{earliest,1}` keeps Jun 20; `{earliest,2}` keeps
    both; `{latest,1}` keeps Jun 25).
  - `scripts/probe-phase2.ts` (or a new `probe-noresult.ts`) — synthetic `TaskResult`s that zero at each stage
    → assert the reason + message: price-cap (BTTS **Yes** 1.72 vs cap 1.5, with a cheaper **No** present →
    `price-or-line` + `closest` = **Yes 1.72**, not No), teams-dont-meet (opponentTeamIds with no matching
    event), scope-mismatch (wrong-competition event → generic message, not "wrong level"), nothing-offered
    (criterion absent → + shelf).
- **Live, end-to-end** — re-run `npx tsx scripts/probe-app.ts`:
  - Q1 → **one** offer (Germany–Ivory Coast Jun 20), not two.
  - Q2 → `kind: "no-results"`, reason `price-or-line`, message naming **1.72 vs 1.5**, related shelf present.
  - Q3 → unchanged (9 weekend games).
- **Ship gate** — `npm run eval` (1×): confirm the extractor prompt change did not regress the gold set
  (critical tags 100%, entity gate, disambiguator replay). Skip the 5× release run.
- **Typecheck** — `tsc` over `src/**` and the probe scripts (via the temp tsconfig pattern used in this build).

## Risks / decisions
- **Prompt + schema change is LLM-affecting** — the only viable place for the fixture-selection signal (the
  executor can't tell "next game" from "all upcoming games" without it). The LLM owns recognition (any phrasing)
  and normalizes to one structured `fixture_pick`; the executor does an exact, drift-free read — no regex,
  no second guessing layer. Gated by the eval ship gate + the diff-and-approve discipline before editing
  `extractor-prompt.md`.
- **Four overlapping "which fixtures" selectors** — `date_window`, `kickoff` late/early, `stage.ordinal`, and
  the new `fixture_pick`. Mitigated by the 1b routing rule + the `stage.ordinal` ⊕ `fixture_pick` guard. Longer
  term `fixture_pick` could absorb the executable (non-round) ordinals, but that's a separate cleanup.
- **`Answer` gains a 3rd kind** (`no-results`) — any consumer must handle it; today only `probe-app.ts`
  consumes `Answer`, so blast radius is nil.
- **`fixture_pick` = globally earliest/latest N fixtures** (club or country) when no competition is named — the
  literal reading; self-narrows when a competition/window is in scope.
- **`closest` respects the selector's line/selection** (drops only the odds bound), so it names the pick the
  user asked for; a numeric-line miss lists offered lines rather than a single "closest line".
