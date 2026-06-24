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

const QueryBody = z.object({ query: z.string().min(1).max(500) });

export function buildApp() {
  const app = new Hono();

  // CORS so a browser frontend (the MFE) can POST cross-origin. `*` echoes the caller's origin; lock this
  // to the real frontend origin before any public deployment.
  app.use("/query", cors({ origin: (o) => o ?? "*", allowMethods: ["POST", "OPTIONS"] }));

  app.post("/query", async (c) => {
    let query: string;
    try {
      ({ query } = QueryBody.parse(await c.req.json()));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid request body" }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const evt of runPipeline(query)) {
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
