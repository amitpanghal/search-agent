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

// An IANA zone NAME the runtime actually knows ("Europe/Stockholm"), never a numeric offset — an offset is only
// correct at one instant and silently breaks across a DST switch. Constructing the formatter is the check:
// Intl throws RangeError on an unknown zone.
const isKnownZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

// `tz` is the USER's zone; the resolver reads day boundaries and kickoff hours in it (see time-window.ts). The
// CLIENT owns it — it is the only side with the customer setting and the device — so we never guess one here:
// a bad value is a 400 (loud, a client bug) and an absent one falls back to UTC (the pre-tz behaviour) with a
// warn. Guessing from the server's own zone would silently change the answer whenever the box moves region.
const QueryBody = z.object({
  query: z.string().min(1).max(500),
  tz: z.string().refine(isKnownZone, "unknown IANA timezone").optional(),
});

export function buildApp() {
  const app = new Hono();

  // Health/keepalive probe. Returns 200 so an uptime pinger doesn't record a failure on every hit —
  // cron-job.org disables a job after 25 consecutive failures, which would silently end the keepalive
  // that stops Render's free instance from spinning down (a wake costs the next user ~60s).
  app.get("/", (c) => c.text("ok"));

  // CORS so a browser frontend (the MFE) can POST cross-origin. `*` echoes the caller's origin; lock this
  // to the real frontend origin before any public deployment.
  app.use("/query", cors({ origin: (o) => o ?? "*", allowMethods: ["POST", "OPTIONS"] }));

  app.post("/query", async (c) => {
    let query: string;
    let tz: string | undefined;
    try {
      ({ query, tz } = QueryBody.parse(await c.req.json()));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid request body" }, 400);
    }
    if (!tz) console.warn("[query] no tz sent — time filters fall back to UTC; the client should send an IANA zone name");

    return streamSSE(c, async (stream) => {
      try {
        for await (const evt of runPipeline(query, { tz })) {
          // Stage markers carry only their name; `done` carries the whole envelope.
          await stream.writeSSE({
            event: evt.stage,
            data: JSON.stringify(evt.stage === "done" ? evt.envelope : evt),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
      }
    });
  });

  return app;
}
