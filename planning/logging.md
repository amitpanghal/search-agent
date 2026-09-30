# Logging — one record per search, one per click, for product analytics and quality work

Agreed 2026-09-30 (grill session). Status: **accepted, not built**. Jira: see the last section.

## Decision

The agent writes **one JSON line per search** to stdout when the search finishes or fails, and **one JSON line
per click** the widget reports through a new `POST /event`. Nothing else is logged. The platform (Kambi AWS
containers) ships stdout to **CloudWatch**; the agent has no storage code, no local files, no S3 client.

Two purposes, in this order: **product analytics** (did people click what we showed, per operator) and **quality /
model improvement** (which queries clarified or failed, what the model extracted, what was on the menu, what it
picked). Not audit, not ops-first. The record is shaped so real traffic feeds the eval for free.

> Rejected on purpose, don't re-propose: session id, click position, storing LLM prompts or response text, the
> full envelope, the full menu or any sampled full capture, prompt-file hashes, S3 writes from the agent, files on
> the agent or daily dumps, per-stage log lines, customer id or IP, Grafana for the POC, any Render-based option
> (Render is POC hosting only, production is Kambi AWS).

## The query record

Written in a `finally`, so a thrown error still produces one record with whatever stages had run.

```json
{ "type": "query", "ts": "2026-09-30T18:02:11Z", "queryId": "3f9c…", "offering": "kambi",
  "query": "Arsenal to win and over 2.5 goals tonight", "tz": "Europe/Stockholm", "locale": "sv_SE",
  "commit": "50e7092", "model": "gpt-6-luna", "provider": "openai",
  "extract": { "…the plan exactly as the model returned it…" },
  "ground": { "cells": [ { "text": "Arsenal", "type": "team", "tier": "confident", "id": 1000000123, "sport": "football" } ] },
  "entitiesLlm": false,
  "recall": { "feedCalls": 2, "events": 1, "offers": 412, "ms": 640 },
  "legs": [ { "phrase": "Arsenal to win", "labels": [ "Full Time", "Draw No Bet", "…59 more" ], "pick": "Full Time", "match": "exact", "matched": true },
            { "phrase": "over 2.5 goals", "labels": [ "…" ], "pick": "Total Goals", "line": 2500, "match": "exact", "matched": true } ],
  "shown": [ { "eventId": 1023, "event": "Arsenal - Chelsea", "start": "2026-09-30T19:00Z", "betOfferId": 77, "criterion": "Full Time",
               "outcomes": [ { "id": 901, "label": "Arsenal", "odds": 1850 } ] } ],
  "additional": [ { "eventId": 1023, "betOfferId": 91, "criterion": "Both Teams To Score", "outcomes": [ { "id": 4410, "label": "Yes", "odds": 1650 } ] } ],
  "betslip": { "odds": 3750, "parts": [ { "eventId": 1023, "outcomeIds": [ 901, 1207 ] } ] },
  "outcome": "answered", "reason": null, "errorClass": null, "message": null,
  "timing": { "total": 5120, "firstEvent": 40, "extract": 2800, "ground": 30, "entities": 0, "recall": 640, "market": 1400, "execute": 250 },
  "llm": { "calls": 2, "inputTokens": 9800, "outputTokens": 310, "throttled": false, "stopReasons": [ "tool_calls", "tool_calls" ] },
  "cost": { "…the existing envelope cost block…" } }
```

Field notes:

- `queryId` — UUID minted by the agent when the POST arrives, sent to the widget in the **first** SSE event and again
  in the `done` envelope. The widget stamps every click with it.
- `query` — as typed, never normalized. Emails, phone numbers and 13–19-digit runs are replaced by `[redacted]`
  before writing. JSON encoding already escapes newlines; the server caps the query at 500 chars.
- `commit`, `model`, `provider` — the only version stamps. Prompts and catalogs are committed files, so the commit
  pins them; the model and provider come from env and can change without a commit.
- `extract` — the plan **verbatim**. The eval replay loader (`npm run eval -- --from`) reads exactly this.
- `legs[].labels` — the deduped English labels the market picker chose among. The feed changes daily, so this is
  the one thing that cannot be recovered later; it is what re-runs a wrong pick offline through the market gate.
- `shown` / `additional` / `betslip` — compact projections: ids, labels, odds. Not the envelope.
- `outcome` — `answered` | `partial` (some legs unmatched) | `clarify` | `error`. `reason` for clarify:
  `incomplete`, `ambiguous-entity`, `multi-sport`, `unsupported-sport`, `no-fixture`, `subject-unidentified`.
  `errorClass` for error: `llm-throttle`, `llm-parse`, `llm-unavailable`, `feed-down`, `bad-request`, `bug`.
  `message` carries the sentence the user saw or the error text.
- `llm.stopReasons` — `max_tokens` means an answer was cut off mid-JSON, a silent failure worth counting.

Size: 2–4 KB. Well under CloudWatch's 256 KB per event.

## The click record and `POST /event`

```json
{ "type": "click", "ts": "2026-09-30T18:02:19Z", "queryId": "3f9c…", "offering": "kambi",
  "target": "betslip", "outcomeIds": [ 901, 1207 ] }
```

- `target` — `outcome` (one outcome on a result card, `outcomeIds: [901]`), `betslip` (the combination card,
  every leg's outcome id across all parts), `additional` (a suggestion), `tile` (a player tile, `outcomeIds: []`
  plus `playerId`). No position: result cards are the person's own legs, not a ranked list.
- Event, market, odds shown and whether the outcome was a matched leg come from the query record through the join
  on `queryId`; they are not repeated. Rows are **appended, never updated**: two clicks are two rows.
- `POST /event` — body validated with zod like `/query` (`queryId` UUID, `offering`, `target` enum, `outcomeIds`
  numbers), replies `204` at once, writes one line, no LLM, same CORS as `/query`. The widget sends it with
  `fetch(url, { method: "POST", keepalive: true, body })` so it survives the page closing. Health `GET /` never logs.
- The widget cannot log "added to betslip": by design it never knows what a click means (the host decides through
  the callback). If a host later reports "added", that is one more `target` value with the same shape.

## Storage, retention, alarms

- **stdout → CloudWatch.** One log group for the agent. Retention **90 days**, then only aggregates survive.
- **Infra items (open, owner: infra team)** — none change agent code: (1) confirm container stdout is shipped to
  CloudWatch (or Loki — either works); (2) set retention 90 d; (3) set the log driver to **non-blocking** mode with a
  buffer, so a stalled shipper drops a few lines instead of blocking the request (a container's stdout is a pipe;
  Node's pipe writes are synchronous on Linux).
- **Two alarms**, metric filters on the log lines, no agent code, SNS email to Amit:
  - errors: ≥ 5 records with `outcome = "error"` in 15 min (a count, not a rate — two operators' night traffic makes
    rates flip on two failures);
  - money: `sum(cost.totalCost)` over 1 h > **$2** (normal at 5,000 searches/day ≈ $0.50/h; 4× = a loop or abuse).
- Deferred to production: p95 `timing.total` > 10 s, `errorClass = "llm-throttle"` ≥ 3 / 15 min, a silence alarm,
  Slack delivery.
- Cost at POC size (2 operators, 5,000 searches + 1,500 clicks a day ≈ 450 MB/month): CloudWatch ingest is inside
  the 5 GB/month free tier, storage ≈ $0.04/month. Cost is not a factor until well past 1M searches/month.

## Reading it back

Counts, in the console (Logs Insights; JSON fields are auto-discovered):

```
# clarify rate per operator per day
filter type = "query" | stats count(*) by offering, outcome, bin(1d)

# clicks by target per operator
filter type = "click" | stats count(*) by offering, target, bin(1d)

# cost per operator per day
filter type = "query" | stats sum(cost.totalCost), count(*) by offering, bin(1d)

# clarify reasons, worst first
filter type = "query" and outcome = "clarify" | stats count(*) by reason | sort by count desc
```

Joins (was **this** search clicked) and eval feeding need the rows as files. Pull them, then use DuckDB:

```bash
aws logs filter-log-events --log-group-name <group> --start-time <ms> --end-time <ms> --output json \
  | jq -r '.events[].message' > records.jsonl
```

```sql
SELECT q.offering, q.outcome, count(*) AS searches, count(c.queryId) AS clicked
FROM read_json_auto('records.jsonl') q
LEFT JOIN read_json_auto('records.jsonl') c ON c.type = 'click' AND c.queryId = q.queryId
WHERE q.type = 'query' GROUP BY 1, 2;
```

Eval feeding, all free: a `clarify` / `partial` record is a ready gold candidate (query as typed + plan + labels +
pick); a wrong pick becomes a market-gate row (`phrase`, `labels`, expected pick); `npm run eval -- --from records.jsonl`
re-grades any gold query that appeared in traffic once the loader accepts `row.extract` (see below).

## Build plan

Ungated (transport, eval tooling, tests):

1. **Record builder** — new `src/server/log.ts`. Builds the query record from the events the pipeline already sends
   through `emit()` in `src/resolver/trace.ts` (stage outputs, `llm-resp` tokens/stopReason, `kambi-resp` status),
   plus the cost store and the envelope; projects `shown`/`additional`/`betslip`; scrubs the query; one
   `console.log(JSON.stringify(record))`. The pipeline is untouched — the emits exist today and are no-ops only
   because no store is active in prod.
2. **Wiring** — `src/server/app.ts`: mint `queryId` (`crypto.randomUUID()`), run `runPipeline` inside
   `traceStore.run([])`, send the id in the first SSE event, time the stages from the yields, write the record in
   `finally` (also on the 400 path, as `errorClass: "bad-request"`), add `POST /event`.
3. **Eval loader** — `src/eval/run.ts` `loadReplay`: also accept `row.extract` (three lines).
4. **Test** — one unit test for the builder over a captured probe trace: projection shape, scrub, error path.

Gated (resolver code — plan + worked example, then ask before editing):

5. `reason` code next to each `clarificationNeeded` sentence and `errorClass` on thrown errors, where they are
   produced: `src/resolver/resolve.ts`, `check-complete.ts`, `resolve-entities.ts`. Zero-edit fallback: derive
   `reason` from the last stage seen in the trace.
6. `queryId` on the `ResponseEnvelope` type in `src/resolver/execute.ts`.

Widget (separate repo): read `queryId` from the first SSE event; on outcome / betslip / additional / tile click,
`POST /event` with `keepalive: true`.

Infra: the three open items + the two alarms above.

## Jira

Created 2026-09-30 in project SB under epic PD-9573 "NL Search — Partner POC". Linked (Relates) to SB-195086, whose
"Observability" and "Production quality monitoring" bullets this story covers.

- **SB-195164** — story: NL Search - Query and click logging for analysis (POC)
  - SB-195165 — Agent: write one query record per search to stdout (build plan items 1, 2, 4)
  - SB-195166 — Agent: `POST /event` click endpoint
  - SB-195167 — Agent: outcome and reason codes on clarify and error paths (gated resolver change; items 5, 6)
  - SB-195168 — Eval: accept production records in `--from` replay; document gold-from-traffic (item 3)
  - SB-195169 — Widget: send click events with the queryId (frontend, next to SB-195087)
  - SB-195170 — Infra: CloudWatch log group, 90-day retention, non-blocking log driver, two alarms
  - SB-195171 — Analysis: saved Logs Insights queries and the first weekly report

Order: 195165 → 195166 → 195169 (the widget needs the endpoint); 195167 and 195168 alongside 195165; 195170 in
parallel with the hosting work; 195171 one week after data flows.
