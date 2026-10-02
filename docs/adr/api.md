# ADR: API

Status: current
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

## Key decisions and why
- **One JSON answer, streamed progress.** The envelope is computed whole; the SSE stream only carries
  coarse stage markers so a frontend can show progress, then the single `done` object.
- **The client owns the timezone.** Only the client has the customer's setting and device. The server never
  guesses a zone; a bad zone is loud and an absent one is the documented UTC fallback.
- **A zone name, never an offset.** An offset is right at one instant and breaks across a DST switch.
- **`queryId` minted server-side.** The search and its clicks are joined on it in the logs.
- **`/event` is fire-and-forget.** The widget sends it with `keepalive`, so it survives the page closing;
  the server validates and returns before anything else.
- **Health returns 200 always.** A keepalive pinger must never record a failure and stop pinging.

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
