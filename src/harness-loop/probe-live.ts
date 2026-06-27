// One-shot live probe — calls the real pipeline (real LLM, live feed) and prints the envelope.
// Usage: npx tsx src/harness-loop/probe-live.ts "<query>"
import { extract } from "../resolver/extract";
import { runPipeline } from "../resolver/resolve";

const query = process.argv.slice(2).join(" ") || "Will Norway be eliminated in round of 16 of World Cup 2026?";
console.error(`[probe-live] query: ${query}`);

// Show what the extractor actually returns
const plan = await extract(query);
console.error("[extract plan]", JSON.stringify(plan, null, 2));

let env;
for await (const evt of runPipeline(query)) {
  if (evt.stage === "done") env = evt.envelope;
  else console.error(`[stage] ${evt.stage}`);
}
console.log(JSON.stringify(env, null, 2));
