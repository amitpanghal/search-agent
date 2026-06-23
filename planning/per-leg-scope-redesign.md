# Plan: Per-leg scope (dissolve `event_scope`)

**Deliverable of this task:** save this document to the repo as `planning/per-leg-scope-redesign.md`. The
sections below are the implementation plan for the redesign itself (a later effort).

---

## Context

The extractor emits one query-level `event_scope` carrying a single `level` (fixture vs competition), one
`time`, one `stage`, etc. But a query's legs can have different **grains**. Two real failures we traced:

- *"Mbappé most goals in WC26 **and** to score in his next game"* → `level: competition` for the whole query,
  so the fixture leg's `time.fixture_pick` ("next game") was **dropped**.
- *"Kane 1st goalscorer in his next game **and** golden ball in WC26"* → `level: fixture`, so the golden-ball
  outright leg sits under a match grain; any match-grain menu prune would delete it.

One `level`/`time` can't represent both legs. We also can't safely prune the menu by grain (a match-grain prune
deletes a competition leg's outright market). **Fix:** move scope onto each selector so every leg fully describes
its own bet — grain, competition, stage, time, state. Decision (confirmed): **full dissolve** — `event_scope`
disappears; only `status` + `sport` stay global. Intended outcome: mixed-grain queries resolve every leg, and a
per-leg menu build replaces the unsafe global grain/time pass.

---

## New shape

`QueryPlan = { status, sport, selectors[] }`. Each selector gains a `scope`:

```jsonc
selector = {
  subject, market_concept, bo_types?, line?, odds?, odds_sort?,   // unchanged
  scope: {
    level: "fixture" | "competition",                 // required
    competition: string | null,
    region: string | null,
    teams: string[],
    players: [{ name, role }],
    stage: { round, ordinal, conditional } | null,
    time:  { date_window, kickoff_time_of_day, fixture_pick } | null,
    play_state: "live" | "prematch" | null,
  }
}
```

No query-level defaults, no inheritance — shared scope (e.g. `competition: "World Cup 2026"`) is repeated on
every leg.

---

## Phase 0 — Gate: can the extractor tag per-leg scope? (do this FIRST)

The redesign only pays off if the extractor reliably stamps `scope` on every selector — repeating
`competition`/`time` and tagging the minority-grain leg on long queries. This is historically its weakest spot
(it flattens long multi-leg queries). **Before any plumbing**, probe ~12–15 mixed-grain / multi-scope queries
(extract-only) and measure per-leg `scope` accuracy. Reuse the seam pattern in
[`scripts/batch-trace.ts`](scripts/batch-trace.ts) (or `scripts/probe-extract-one.ts`). If accuracy is poor,
bump extraction to Sonnet (`extract.ts` model is one line) or restructure the prompt before continuing. **No
code past this phase until the gate passes.**

## Phase 1 — Schema (`src/resolver/schema.ts`)

- Add a `Scope` zod object with the fields above. **Reuse** existing `Stage`, `Time`, `Subject`, `Line`, `Odds`
  definitions (move `teams`/`players` shapes off the old `EventScope`).
- `Selector` gains `scope: Scope`. Delete `EventScope`. `QueryPlan = { status, sport, selectors.min(1) }`.

## Phase 2 — Extractor prompt (`src/resolver/extractor-prompt.md`)

Rewrite **Step 2 (Scope the event)** from one `event_scope` to a per-selector `scope`. New core rules:
- Each selector states its **own full scope**; repeat shared scope (competition/region/time) on every leg — there
  is no query-level default.
- Tag each leg's grain (`level`) independently: a tournament-wide outcome (*most goals, golden ball, outright
  winner, top scorer*) is `competition`; a single-match outcome is `fixture`.
- Keep `time`/`fixture_pick` on each fixture leg **even when another leg is competition** (the bug we're fixing).

Update the worked examples to the new shape. `extract.ts` only validates against the schema — confirm the cached
prompt prefix still works; no logic change expected.

## Phase 3 — Grounding (`src/resolver/ground-scope.ts`)

- **Keep** the per-entity functions `groundRegion` / `groundCompetition` / `groundTeam` / `groundPlayer` — reused
  unchanged.
- Rework only the `groundScope` orchestrator: run the cascade (region→competition→team→player) **per selector's
  scope**, with a memo cache keyed by entity text (+ scope context) so identical entities across legs aren't
  re-grounded.
- Replace `ResolvedScope`/`ScopeUnit` with a **per-leg grounded scope**:
  `ResolvedLegScope = { region, competition, level, stage, time, playState, teams, players(+roles), subjectPlayer }`,
  and `ResolvedScope = { sport, legs: ResolvedLegScope[] }`. Keep the `opts.region` test hook (adapt per-leg).

## Phase 4 — Types + entity gate (`live-menu-types.ts`, `resolve-entities.ts`)

- `CellRef` becomes per-leg, but **dedup by distinct entity**: build one cell per unique (entity text + scope
  context), gate it once, then fan the settled pick back to every leg that referenced it (so we never re-ask the
  same clarification per leg). Reuse the existing two-pass `runPasses`/`decide` machinery untouched — only
  `buildEntityCells` and `setEntity`/`applyOutcomes` change to iterate legs and write back per-leg.
- `SettledEntities = <new per-leg ResolvedScope> & { clarifications }`.

## Phase 5 — Recall planning + engine (`plan-recall.ts`, `recall.ts`)

- `plan-recall`: derive the fetch from the **union across legs** — union of participant ids
  (teams+players+subjectPlayers), the set of competition group ids (usually one; multiple ⇒ multiple group
  fetches), the union of levels (fan-out). Carry **per-leg** windows; drop the single global
  `grain`/`window`/`matchTeamIds`.
- `recall`: fetch the union broadly (participant or group). `finalize` **stops** applying global time/grain/
  co-occurrence.
- Add `scopeMenu(data, legScope)`: for one leg, narrow events by `level` (fixture vs competition tag) +
  competition group + stage + time window + `fixture_pick` + head-to-head co-occurrence, then build the menu.
  **Reuse** `filterEventsByTime`, `applyFixturePick`, `fixtureHasAllTeams`, `buildMenu` (all already in
  `recall.ts`/`time-window.ts`).

## Phase 6 — Orchestrator (`src/resolver/resolve.ts`)

- Group selectors by **(filterSubject + scope signature)** instead of subject alone. Identical subject+scope legs
  share one `scopeMenu` + one batched `resolveMarkets` call; differing legs split into their own group.
- Per group: `scopeMenu(data, groupLegScope)` → `filterBySubject` → `resolveMarkets` → `select`.
  `selectSubject`/`subjectParticipantId` read from the per-leg grounded scope.
- `execute.ts` is **unchanged** (already groups results by event).

## Phase 7 — Eval + probe sync

- Gold shape mirrors `QueryPlan` (see `schema.ts` header): update `src/eval/gold-record.ts`,
  `scope-scorer.ts`, `behavior-tags.ts`, and the `gold.seed.jsonl` corpus to per-leg scope. Adapt
  `live-menu-gate.ts`, `market-resolve-gate.ts`, `run.ts`. Mechanical but sizeable (gold corpus rewrite).
- Update active probes that read `event_scope`: `scripts/batch-trace.ts`, `scripts/run-pipeline-trace.ts`,
  `scripts/probe-extract-*`, `scripts/probe-scope-mix.ts`. (Probe `.`-dotfiles under `scripts/` are scratch — ignore.)

---

## Verification

1. **Phase 0 gate** — extractor per-leg `scope` accuracy on ~12–15 mixed/multi-scope queries (extract-only). Must
   pass before building.
2. `npx tsc --noEmit` clean.
3. `npm run gate:live-menu` green; `npm run eval` (1× ship gate) green after the gold corpus is re-synced.
4. `npx tsx scripts/verify-timewindow.ts` still 8/8.
5. **End-to-end on the two motivating queries** via `scripts/batch-trace.ts`:
   - *Mbappé* — leg 0 `most goals` → competition outright resolves; leg 1 `to score` → France's **next game**
     resolves (today it loses the next-game scope).
   - *Kane* — leg 0 `first goalscorer` → next game resolves; leg 1 `golden ball` → outright resolves (today a
     grain prune would delete it).

## Risks / call-outs

- **Extractor reliability is the make-or-break** — hence the Phase 0 gate. If it can't tag per-leg scope on long
  queries, the plumbing has nothing to act on; the answer is Sonnet extraction or a prompt restructure first.
- **Eval gold corpus rewrite** (`gold.seed.jsonl` + scorers) is the largest mechanical chunk and a drift risk;
  keep schema ⇄ gold in lockstep.
- **Repetition cost** (the trade chosen): `competition`/shared `time` repeat on every selector, raising extractor
  output tokens and the chance of per-leg drift.
- Suggested build order: Phase 0 → 1 → 2 (validate extraction) → 3 → 4 → 5 → 6 → 7, typechecking between phases.