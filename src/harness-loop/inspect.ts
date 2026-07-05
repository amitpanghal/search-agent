// inspect — drain ONE ad-hoc query through the rig (HARNESS_DEPS) and print a readable envelope digest. Same
// deps + cache-miss contract as harness-run, but for a single query and dumping the full result, not a grade.
//
//   tsx src/harness-loop/inspect.ts "Give me next 3 events in world cup 2026 and total goals odd of Sweden fixture"
//
// On an LLM cache miss it writes pending-llm.json and exits 3 (fulfil + re-run). Recall fetches live inline.

import { runPipeline } from "../resolver/resolve";
import type { ResponseEnvelope } from "../resolver/execute";
import { HARNESS_DEPS } from "./pipeline-doubles";
import { CacheMiss, flushPending } from "./llm-cache";

const query = process.argv.slice(2).join(" ").trim()
  || "Give me next 3 events in world cup 2026 and total goals odd of Sweden fixture";

function printEnvelope(env: ResponseEnvelope): void {
  console.log(`\nQUERY: ${query}\n`);
  const evById = new Map(env.events.map((e) => [e.id, e]));
  console.log(`results: ${env.results.length} event(s)`);
  for (const r of env.results) {
    const e = evById.get(r.highlighted[0]?.eventId ?? -1);
    console.log(`\n  ▸ EVENT ${e?.id ?? "?"}  ${e?.name ?? "?"}  [${e?.state ?? "?"}]  start=${e?.start ?? ""}  group=${e?.group ?? ""}`);
    for (const h of r.highlighted) {
      const sel = h.outcomes.find((o) => o.selected);
      const tag = h.betOffer.criterion.englishLabel ?? h.betOffer.criterion.label;
      console.log(`      · ${tag}  (${h.outcomes.length} outcomes)${sel ? `  selected="${sel.englishLabel ?? sel.label}" @${sel.odds}` : ""}`);
    }
  }
  if (env.additional.length) console.log(`\nadditional: ${env.additional.length} market(s)`);
  if (env.combinations?.length) console.log(`combinations: ${env.combinations.length}`);
  console.log(`\nnotes: ${env.notes.length ? env.notes.join(" | ") : "(none)"}`);
  console.log(`clarificationNeeded: ${env.clarificationNeeded ?? "(none)"}`);
}

async function main(): Promise<void> {
  try {
    let env: ResponseEnvelope | undefined;
    for await (const evt of runPipeline(query, HARNESS_DEPS)) if (evt.stage === "done") env = evt.envelope;
    printEnvelope(env!);
  } catch (e) {
    if (e instanceof CacheMiss) {
      const reqs = flushPending();
      console.log(`LLM cache MISS: ${e.req.kind} (${e.req.key}) -> pending-llm.json (${reqs.length} pending). Fulfil + re-run.`);
      process.exit(3);
    }
    throw e;
  }
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
