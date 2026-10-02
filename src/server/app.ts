// HTTP surface — a thin Hono app exposing the resolver over POST /query as Server-Sent Events.
//
// The pipeline (resolve.ts) is the brain; this file is just transport. We stream the generator's coarse
// stage markers (extracting -> fetching -> resolving) so a frontend can show progress, then emit the final
// envelope as the `done` event. The result is one JSON object (computed whole), not a token stream — see
// the StageEvent shape in resolve.ts.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runPipeline } from "../resolver/resolve";
import type { ResponseEnvelope } from "../resolver/result/execute";
import { traceStore, type TraceEvent } from "../resolver/shared/trace";
import { queryRecord, writeLog, OFFERING } from "./log";

// An IANA zone NAME the runtime actually knows ("Europe/Stockholm"), never a numeric offset — an offset is only
// correct at one instant and silently breaks across a DST switch. Constructing the formatter is the check:
// Intl throws RangeError on an unknown zone.
const isKnownZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// `tz` is the USER's zone; the resolver reads day boundaries and kickoff hours in it (see time-window.ts). The
// CLIENT owns it — it is the only side with the customer setting and the device — so we never guess one here:
// a bad value is a 400 (loud, a client bug) and an absent one falls back to UTC (the pre-tz behaviour); the log
// record shows it as `tz: null`. Guessing from the server's own zone would silently change the answer whenever the box moves region.
const QueryBody = z.object({
  query: z.string().min(1).max(500),
  tz: z.string().refine(isKnownZone, "unknown IANA timezone").optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2}_[A-Z]{2}$/, "locale must look like sv_SE")
    .optional(),
});

// A click on something /query showed (planning/logging.md). Ids only: the query record, joined on queryId, already
// holds the event, market and odds. No position — result cards are the person's own legs, not a ranked list.
const EventBody = z.object({
  queryId: z.uuid(),
  target: z.enum(["outcome", "betslip", "additional", "tile"]),
  outcomeIds: z.array(z.number().int()).max(50),
  playerId: z.number().int().optional(),
});

export function buildApp() {
  const app = new Hono();

  // Health/keepalive probe. Returns 200 so an uptime pinger doesn't record a failure on every hit —
  // cron-job.org disables a job after 25 consecutive failures, which would silently end the keepalive
  // that stops Render's free instance from spinning down (a wake costs the next user ~60s).
  app.get("/", (c) => c.text("ok"));

  // CORS so a browser frontend (the MFE) can POST cross-origin. `*` echoes the caller's origin; lock this
  // to the real frontend origin before any public deployment.
  const postCors = cors({ origin: (o) => o ?? "*", allowMethods: ["POST", "OPTIONS"] });
  app.use("/query", postCors);
  app.use("/event", postCors);

  app.post("/query", async (c) => {
    // One id per search: on every SSE event and on the log record, so the widget's clicks join back to it.
    const queryId = crypto.randomUUID();
    const t0 = Date.now();
    let body: unknown;
    let query: string;
    let tz: string | undefined;
    let locale: string | undefined;
    try {
      body = await c.req.json();
      ({ query, tz, locale } = QueryBody.parse(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid request body";
      const raw = (body as { query?: unknown } | undefined)?.query;
      writeLog(
        queryRecord({
          queryId,
          t0,
          query: typeof raw === "string" ? raw.slice(0, 500) : null,
          trace: [],
          error: message,
          errorClass: "bad-request",
        }),
      );
      return c.json({ error: message }, 400);
    }

    return streamSSE(c, async (stream) => {
      // traceStore switches the pipeline's emit() calls on for this request only (trace.ts); the record is built from them.
      const trace: TraceEvent[] = [];
      let envelope: ResponseEnvelope | undefined;
      let error: string | undefined;
      try {
        await traceStore.run(trace, async () => {
          for await (const evt of runPipeline(query, { tz, locale })) {
            if (evt.stage === "done") envelope = evt.envelope;
            // Stage markers carry only their name; `done` carries the whole envelope. Both carry the queryId.
            await stream.writeSSE({
              event: evt.stage,
              data: JSON.stringify({ ...(evt.stage === "done" ? evt.envelope : evt), queryId }),
            });
          }
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: error, queryId }) });
      } finally {
        writeLog(queryRecord({ queryId, t0, query, tz, locale, trace, envelope, error }));
      }
    });
  });

  // Fire-and-forget from the widget (fetch with keepalive, so it survives the page closing): one line, no LLM.
  app.post("/event", async (c) => {
    const parsed = EventBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    writeLog({ type: "click", ts: new Date().toISOString(), offering: OFFERING, ...parsed.data });
    return c.body(null, 204);
  });

  return app;
}
