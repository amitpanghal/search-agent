# ADR: Logging

Status: current — built
Date: 2026-09-30
Component record: [components/logging.md](../components/logging.md)

## Context
One JSON line per search and one per click, written to stdout. The platform ships stdout to CloudWatch.
The record serves product analytics (did people click what we showed) and quality work (which queries
clarified or failed, what was extracted, what was on the menu, what was picked). The agent has no storage
code.

## Decisions
- **One wide record per search, not per-stage lines.** Every question about a search is answered from one
  row; joins are on `queryId` only.
- **Compact on purpose.** No prompts, no full envelope, no full menu. Only what analytics and eval replay
  need.
- **The menu labels are kept.** The feed changes daily, so they are the one thing that cannot be recovered
  later; they let a wrong pick be re-run offline through the market gate.
- **The plan is kept verbatim.** The eval replay reads exactly this shape.
- **`commit`, `model`, `provider` are the version stamps.** Prompts and catalogs are committed, so the
  commit pins them; the model and provider come from env.
- **Scrub, never store PII.** Emails and long digit runs are the realistic leaks in a betting query.
- **stdout to CloudWatch, nothing else.** No files, no S3 client, no session id, no click position.

## Related
- Related: api, evaluation, deployment.
