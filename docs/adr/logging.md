# ADR: Logging

Status: current
Last verified: 2026-09-30 against eb4aae8

## Purpose
One JSON line per search and one per click, written to stdout. The platform ships stdout to CloudWatch.
The record serves product analytics (did people click what we showed) and quality work (which queries
clarified or failed, what was extracted, what was on the menu, what was picked). The agent has no storage
code.

## Input and output
- In: the `queryId`, the request fields, the trace events the pipeline emitted, the final envelope, and any
  error.
- Out: a `type: "query"` record of 2 to 4 KB, or a `type: "click"` record.

## How it works
1. `queryRecord` in `src/server/log.ts` builds the record after the request, from the trace store plus the
   envelope. The pipeline is untouched; its `emit()` calls are no-ops unless a store is active.
2. Query record fields: `ts`, `queryId`, `offering`, `query` (as typed, scrubbed), `tz`, `locale`,
   `commit` (from the image build), `model`, `provider`, `extract` (the plan verbatim), `ground` (sport and
   entity cells with text, type, tier, ids), `entitiesLlm` (whether the entity model ran), `recall`
   (feed calls, events, offers, truncated, failed), `legs` (phrase, pick, match, matched, and the menu
   labels the picker chose among), `shown` and `additional` (cards reduced to ids, labels, odds),
   `betslip` (odds and parts with outcome ids), `outcome`, `errorClass`, `message`, `timing`, `llm`
   (calls, tokens, stop reasons), `cost`.
3. `outcome` is derived: `error` when the request threw, `clarify` when there are no results and a
   clarification, `empty` when neither, `partial` when a clarification or an unmatched leg sits beside
   results, else `answered`.
4. `timing` reads each stage's end from its emit; scope-menu and filter fold into `market`. `total` is
   wall time from the POST.
5. Scrubbing replaces emails and any run of 9 or more digits with `[redacted]`; an ISO date has only 8
   digits and survives. The query is capped at 500 characters by validation.
6. Click record: `ts`, `queryId`, `offering`, `target`, `outcomeIds`, optional `playerId`. Rows are
   appended, never updated; the joined query record already holds the event, market and odds.
7. Written in `finally`, so a thrown error still yields a record with the stages that ran.

## Key decisions and why
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

## Invariants
- `src/server/log.test.ts` covers the record's shape, the scrub, and the error path.
- The health route never logs.

## Limits
- Not built yet (`planning/logging.md`): `reason` codes on clarifications, `queryId` on the envelope type,
  the eval loader accepting `row.extract`, the two CloudWatch alarms and the 90-day retention.
- One operator: `offering` is constant until the frontend sends it.

## Where to look
- `src/server/log.ts`, `app.ts`; the design and Jira keys in `planning/logging.md`; queries to read it
  back in the same document.
- Related: api, evaluation, deployment.
