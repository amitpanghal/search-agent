# ADR: Envelope

Status: current — built
Date: 2026-09-30
Component record: [components/envelope.md](../components/envelope.md)

## Context
Assemble the answer. By the time `execute` runs, recall has fetched and filter, resolve and select have
decided, so this stage only shapes what was picked into the `ResponseEnvelope`. No fetching, no market
decision. It is deliberately thin.

## Decisions
- **Thin execute.** Every decision has an owner upstream; putting logic here would hide where a bug lives.
- **Events stored once, cards join by id.** No duplicated event blocks across results and betslip.
- **Raw odds.** Formatting is the consumer's job; one convention across the whole envelope.
- **`additional` is flat and capped at 3.** A short, query-scoped list, not a per-card fan-out.
- **The betslip card replaces the standalone card on its event.** One answer per event, not two.
- **`legs[]` is in query order, not event order.** The frontend shows what was read from the query and
  greys out what could not be offered.

## Related
- Related: selection, combinations, api, logging.
