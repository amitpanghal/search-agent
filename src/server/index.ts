// Server entry — boots the Hono app on PORT (default 3000). Env (ANTHROPIC_API_KEY, ANTHROPIC_MODEL) is
// loaded by the `--env-file=.env` flag in the npm scripts, same as the eval/probe runners.

import { serve } from "@hono/node-server";
import { buildApp } from "./app";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: buildApp().fetch, port }, (info) => {
  console.log(`search-agent listening on http://localhost:${info.port}`);
});
