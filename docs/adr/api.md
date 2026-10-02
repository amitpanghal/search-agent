# ADR: API

Status: current — built
Date: 2026-09-30
Component record: [components/api.md](../components/api.md)

## Context
The HTTP surface: a thin Hono app that exposes the pipeline over Server-Sent Events, accepts click events
from the widget, and answers a health probe. Transport only. The pipeline is the brain.

## Decisions
- **One JSON answer, streamed progress.** The envelope is computed whole; the SSE stream only carries
  coarse stage markers so a frontend can show progress, then the single `done` object.
- **The client owns the timezone.** Only the client has the customer's setting and device. The server never
  guesses a zone; a bad zone is loud and an absent one is the documented UTC fallback.
- **A zone name, never an offset.** An offset is right at one instant and breaks across a DST switch.
- **`queryId` minted server-side.** The search and its clicks are joined on it in the logs.
- **`/event` is fire-and-forget.** The widget sends it with `keepalive`, so it survives the page closing;
  the server validates and returns before anything else.
- **Health returns 200 always.** A keepalive pinger must never record a failure and stop pinging.

## Related
- Related: pipeline, logging, deployment.
