# ADR: Pipeline

Status: current
Last verified: 2026-09-30 against eb4aae8

## Purpose
`runPipeline` in `src/resolver/resolve.ts` is the one place that chains the stages. It turns a query into a
`ResponseEnvelope`, stops early when the query cannot be served, and yields coarse progress markers so the
server can stream them. No stage calls another; the orchestrator passes each one what it needs.

## Input and output
- In: the query string, plus `tz` (the user's IANA zone), `locale`, and `until` (probe-only early stop).
- Out: an async generator of `StageEvent`: `resolving`, `routing`, `disambiguating`, `searching`, then
  `done` carrying the `ResponseEnvelope`. `resolveQuery` drains it to the envelope for eval and probes.

## How it works
1. Yield `resolving`. Extract the `QueryPlan`. A `main` selector tagged competition-level is forced to
   fixture level: a bare league name means "its matches with their main markets".
2. Incomplete gate: no team, player, competition or region anywhere in the plan means nothing to scope to.
   Stop with a fixed question. No fetch, no second model call.
3. Sport recovery: if the extractor's sport has no entry for a named team or player, and exactly one other
   sport has it confidently, switch. Several sports match: stop and ask which.
4. Sport `other`, or a sport with no built catalog: stop with "not supported yet".
5. Yield `routing`. Ground the scope (deterministic), then settle doubtful cells with one LLM call. The
   settled sport replaces the plan's sport, after the trace row for extraction is written.
6. Plan the recall as the union across legs. No ids at all plus open clarifications: stop and return them.
7. Recall the broad live data. This is the only network call in the main path.
8. Yield `disambiguating`. Group selectors by a signature built from grounded ids: the filter subject and its
   side, the subject's participant id, level, competition id, confident team ids, time, stage and play state.
   Each group gets one scoped menu, one subject filter and one batched market call. Then select per leg.
9. A `main` leg skips the market call and fans out into every main-tagged market of its fixtures.
10. Yield `searching`. Build the betslip, assemble the envelope, attach the cost block, yield `done`.

## Key decisions and why
- **Market after fetch.** The market a user means exists only as a label in the live feed, and the feed
  changes daily. So fetch by entity, then decide the market against the real menu.
- **Per-leg scope, no inheritance.** Every selector carries its own grain, competition, teams and time.
  A mixed query keeps each leg's grain, and a fixture leg keeps its time even beside a competition leg.
- **Group by grounded signature.** Surface variants ("WC26", "World Cup 2026") collapse into one group, so
  the menu is scoped, filtered and sent to the model once per group, not once per leg.
- **Abstain over wrong.** No deterministic stage forces a guess, the market model may always answer `none`,
  and select degrades to a named fallback. A clarification is a valid answer.
- **Stop before spending.** The incomplete, multi-sport and unsupported-sport stops happen before any fetch
  and before any second model call.
- **The extractor's sport is a prior.** Sport recovery and the entity gate may both correct it.
- **Coarse progress, one answer.** Markers are yielded before each expensive phase; the answer is one JSON
  object computed whole, never a token stream.
- **`until` for probes.** Stopping after a stage leaves no envelope on purpose; that is how a probe avoids
  the next paid call.

## Invariants
- Never drop a row on missing data; every filter is lenient (`src/resolver/invariants.test.ts`).
- A stage's trace row shows what that stage produced, not a later mutation.
- Every `done` envelope carries the `cost` block, including the early stops.
- An `until` stop yields no `done` event (probe skill).

## Limits
- One sport per query; cross-sport parlays are not handled (`planning/limitations.md`).
- The betslip pricing call is not traced by the probe (probe skill).

## Where to look
- `src/resolver/resolve.ts`; `src/resolver/shared/trace.ts` for the emits a probe reads.
- Probe stage names: `extract`, `ground`, `entities`, `recall`, `scopeMenu`, `filter`, `market`, `select`, `execute`.
- Related: every other record here. The `resolver-pipeline` skill is the agent's stage map.
