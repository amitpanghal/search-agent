# ADR: Pipeline

Status: current — built
Date: 2026-09-30
Component record: [components/pipeline.md](../components/pipeline.md)

## Context
`runPipeline` in `src/resolver/resolve.ts` is the one place that chains the stages. It turns a query into a
`ResponseEnvelope`, stops early when the query cannot be served, and yields coarse progress markers so the
server can stream them. No stage calls another; the orchestrator passes each one what it needs.

## Decisions
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

## Related
- Related: every other record here. The `resolver-pipeline` skill is the agent's stage map.
