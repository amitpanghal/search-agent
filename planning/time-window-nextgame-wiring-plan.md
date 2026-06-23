# Plan: wire the time-window + "next game" filter (minimal, MATCH-tag gated)

## Context

In the live-menu pipeline (`extract → groundScope → resolveEntities → planRecall → recall → filter →
resolveMarkets → select → execute`), time scope is effectively dead:

- `RecallInput.window` exists and `recall`'s group fan-out can consume it, but **nothing produces it** —
  `planRecall` never sets `window` and `resolveTimeWindow` is never called in `src/`. So time is always off.
- **"next game" (`fixture_pick`) is never applied anywhere.** `filterEventsByTime` only does date/kickoff;
  the `pick` value is carried but no code selects the earliest/latest fixture. (The old `next-game-noresult-plan.md`
  ported it to `executor.ts`, which is now dead architecture.)
- Result, proven by the live trace of *"France HT/FT + Mbappé brace in next game"*: the participant fetch
  returns **22 events unfiltered**; the menu mixes every France/Mbappé/PSG market, and SELECT can't tell which
  fixture is meant.
- On a **mixed** query (*"Top scorer WC26 Mbappé + France winning its next game"*) the extractor also **drops
  "next game"** (`time: null`) — unstably (probes: leg order flips it; `level: competition` alone does NOT
  force the drop — variant 4 kept it). Root cause: one `event_scope` (one `level`, one `time`) can't represent
  a competition-grain leg and a fixture-grain leg, so the fixture timing gets squeezed out.

**Chosen approach (minimal, no schema change).** The participant fetch already returns both grains, and grain
is inert on that path; so if the time/next-game filter runs **only on `MATCH`-tagged events**, an outright leg
(a `COMPETITION` event) is never touched while the fixture leg narrows. Two parts:

1. **Produce + apply** the time window post-fetch, endpoint-independent, gated to `MATCH`-tagged events.
2. **Stop the extractor dropping "next game"** with one crisp rule (so mixed queries keep the timing).

Intended outcome: "next game" / "next 2" / "last game" narrow to the right fixture(s) for fixture queries, and
on a mixed query the outright leg surfaces untouched while the fixture leg narrows — all without a schema change.

## Approach

### Part A — produce the window (`src/resolver/plan-recall.ts`)
Resolve the time phrase here (deterministic) and put it on `RecallInput.window`:
```ts
import { resolveTimeWindow, hasWindow } from "./time-window";
const window = settled.time ? resolveTimeWindow(settled.time, { now: new Date() }) : undefined;
const win = window && (hasWindow(window) || window.pick) ? { window } : {};
// add ...win to both returns
```
`tournamentStart` is unavailable on the participant path, so tournament-anchored *date* phrases are ignored by
`resolveTimeWindow` (rare, already its documented behavior); clock-relative phrases and the `fixture_pick`
`from = now` floor still apply.

### Part B — apply it post-fetch, MATCH-only (`src/resolver/recall.ts` + `src/resolver/time-window.ts`)
Add one `finalize` step used at **all three** `recall` returns (event / participant / group) so it's
endpoint-independent. Partition events by tag: `COMPETITION`/untagged are kept as-is; only `MATCH`-tagged
events are time-filtered and then fixture-picked. Restrict offers to the kept events and rebuild the menu so
menu/offers/events stay in lockstep.
```ts
// recall.ts
function finalize(endpoint, betOffers, events, truncated, window): RecallResult {
  let evs = events, offs = betOffers;
  if (window && (hasWindow(window) || window.pick)) {
    const isMatch = (e: KEvent) => levelOf(e.tags) === "fixture";   // MATCH tag only
    const others = events.filter((e) => !isMatch(e));               // COMPETITION + untagged -> always kept
    let matches = filterEventsByTime(events.filter(isMatch), window); // date/kickoff (drops past via from=now)
    if (window.pick) matches = applyFixturePick(matches, window.pick); // earliest/latest N by kickoff
    evs = [...others, ...matches];
    const keep = new Set(evs.map((e) => e.id));
    offs = betOffers.filter((b) => b.eventId == null || keep.has(b.eventId));
  }
  return { endpoint, menu: buildMenu(offs), data: { betOffers: offs, events: evs }, truncated };
}
// each return: return finalize("participant", res.betOffers, res.events, res.truncated, input.window);
```
```ts
// time-window.ts — new exported helper (uses the existing private startOf)
export function applyFixturePick(events: KEvent[], pick: FixturePick): KEvent[] {
  const withStart = events.filter((e) => startOf(e) != null);
  const times = [...new Set(withStart.map((e) => +startOf(e)!))].sort((a, b) => a - b);
  const chosen = new Set(pick.order === "earliest" ? times.slice(0, pick.count) : times.slice(-pick.count));
  return withStart.filter((e) => chosen.has(+startOf(e)!));   // ties at a chosen kickoff kept
}
```
Reuse: `levelOf` (`offering-client.ts:12`), `filterEventsByTime`/`hasWindow`/`startOf` (`time-window.ts`),
`buildMenu` (`recall.ts`). Note: `fanOutGroup` already pre-filters by time as a fetch-size optimization;
`finalize` re-applying is idempotent.

### Part C — stop the extractor dropping "next game" (`src/resolver/extractor-prompt.md`) — show diff + approve
Root cause (probed): the model drops/mangles `time` when a competition-grain leg collides with a fixture leg in
the single `event_scope`. Add one crisp, sport-agnostic rule to the `time`/`fixture_pick` section (NOT per-query
examples): *`time`/`fixture_pick` records the stated match timing for the query's fixtures and must be kept even
when the query also names a tournament-wide market and even when `level` resolves to `competition` — a
tournament-wide market does not erase a fixture leg's timing.* **Show the exact old→new diff and get explicit
approval before editing the prompt** (repo discipline). Then verify with `scripts/probe-scope-mix.ts` that the
mixed variants keep `fixture_pick`, and run the eval ship gate for no-regress.

## Explicitly out of scope (deferred to the event-grain workstream)
- **Mixed-grain with NO named participant** (group endpoint): global `level` still picks one grain → the
  wrong-grain leg is starved. Needs per-leg `level` (schema change).
- **Two fixture legs with different timings** (e.g. "France's next game and England's last game"): one global
  `time` can't hold both → per-leg `time` (schema change).
- **Mixed-query extraction quality** seen in probes (duplicated top-scorer leg, subject mislabeled "event") —
  a separate extractor concern, not timing.
- If Part C proves unreliable on mixed queries, escalate to the per-leg-scope schema change.

## Critical files
- `src/resolver/plan-recall.ts` — Part A (resolve + set `window`).
- `src/resolver/recall.ts` — Part B (`finalize`: MATCH-only time+pick filter at all 3 returns).
- `src/resolver/time-window.ts` — Part B (export `applyFixturePick`; reuse private `startOf`).
- `src/resolver/extractor-prompt.md` — Part C (keep-time rule; **show diff + approve first**).

## Phasing (define → carry → consume; each phase coherent + revertable)
- **Phase 1 — Parts A+B** (no prompt change). Activates "next game" for **single-grain fixture** queries, where
  the extractor already emits `fixture_pick` (verified: "France winning its next game" → `fixture_pick
  earliest/1`). Deterministically testable; ships value alone.
- **Phase 2 — Part C** (prompt). Extends correct "next game" to **mixed** queries. Gated by extractor probes +
  eval ship gate + diff-and-approve.

## Verification
- **Deterministic (snapshot, no network)** — new `scripts/verify-timewindow.ts`: build a MATCH event
  (tags incl. `MATCH`, a `start`) + a COMPETITION event (tags `COMPETITION`, a `start`) + their offers, then
  run `finalize`/the filter and assert: (a) COMPETITION event **and its offers kept** even with a window/pick;
  (b) MATCH events narrowed to earliest/latest N; (c) offers+menu restricted to kept events. Mirrors the
  `scripts/verify-select-positional.ts` snapshot-driven style.
- **Extractor probes** — `scripts/probe-scope-mix.ts`: after Part C, the mixed variants keep `fixture_pick`
  (no `time: null`).
- **Live, end-to-end** — `scripts/run-pipeline-trace.ts`:
  - *"France HT/FT + Mbappé brace in next game"* → menu narrowed to France's **next** fixture (not all 22 events).
  - *"Top scorer WC26 Mbappé + France winning its next game"* → Mbappé top-scorer surfaces (COMPETITION event,
    untouched) **and** the France next-game fixture market resolves.
- **Ship gate** — `npm run eval` (1×): Part C didn't regress the gold set. Skip the 5× release run.
- **Typecheck** — `npm run typecheck`.

## Risks / decisions
- **MATCH-tag gate, not "has kickoff"** — verified the COMPETITION event carries a `start` too, so gating on
  the tag is what keeps outrights safe. Untagged events (`levelOf` null) are kept and never picked (lenient).
- **Part C is LLM-affecting** — the only place to keep the timing signal; one crisp root-caused rule, gated by
  eval + show-diff-approve. No per-query examples (repo discipline).
- **No schema change** — reuses the existing `time`/`fixture_pick` fields; per-leg scope stays deferred.
