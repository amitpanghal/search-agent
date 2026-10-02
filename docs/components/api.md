# API

Component record: how this component works today. The decisions behind it: [adr/api.md](../adr/api.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
The HTTP surface: a thin Hono app that exposes the pipeline over Server-Sent Events, accepts click events
from the widget, and answers a health probe. Transport only. The pipeline is the brain.

## Input and output
- `GET /` returns `ok` (health, keepalive).
- `POST /query`, body `{ query, tz?, locale? }`, streams SSE and ends with the envelope.
- `POST /event`, body `{ queryId, target, outcomeIds, playerId? }`, replies 204.

## How it works
1. The body is validated with zod. `query` is 1 to 500 characters. `tz` must be an IANA zone name the
   runtime knows (checked by constructing an `Intl.DateTimeFormat`); a bad value is a 400, an absent one
   means UTC. `locale` must look like `sv_SE`.
2. One `queryId` (a UUID) is minted per search. It rides on every SSE event and on the log record, so the
   widget's clicks join back to the search.
3. The pipeline runs inside the trace store, so its stage emits are collected for the log record. Each
   yield becomes one SSE event named after the stage: `resolving`, `routing`, `disambiguating`, `searching`,
   then `done` whose data is the whole envelope plus the `queryId`. A thrown error becomes an `error` event
   `{ message, queryId }`.
4. The log record is written in `finally`, so a failed search still produces one. A 400 also logs, with
   `errorClass: "bad-request"`.
5. `POST /event` validates `queryId` (UUID), `target` (`outcome`, `betslip`, `additional`, `tile`),
   `outcomeIds` (at most 50) and an optional `playerId`, writes one click line, and returns 204 at once.
   No model call, no lookup.
6. CORS allows any origin on `/query` and `/event`, echoing the caller's origin. `GET /` never logs.
7. The server boots on `PORT` (default 3000) and runs the TypeScript directly with tsx; no build step.

## Invariants
- Every SSE event and every log record carries the `queryId`.
- A request that fails validation never reaches the pipeline.

## Limits
- CORS is open to any origin; lock it to the frontend origin before a public deployment.
- No API key, quota or rate limit in the app; the deployment puts a WAF rate rule in front.
- One operator today: `offering` is the constant `kambi` in the log module.

## Where to look
- `src/server/app.ts`, `index.ts`; the stage events in `src/resolver/resolve.ts`.
- Related: pipeline, logging, deployment.
