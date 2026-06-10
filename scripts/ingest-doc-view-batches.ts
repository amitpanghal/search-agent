// Subagent-generation mode (Sprint 6, decision 27) — ingest cold-subagent batch outputs into the pipeline.
//
// Flow: `gen-doc-views.ts --emit-plan` writes /tmp/docviews/plan.json (one entry per Opus batch, with the
// exact cache key the pipeline expects). A cold, eval-BLIND subagent authors EACH batch — sees only its
// market names — and writes [{ ref, paraphrases }] to that batch's outFile. This script reads the plan + the
// authored files and primes gen-doc-views.ts's batch CACHE (doc-views-gen-cache.json), keyed by batchKey,
// mapping each ref back to its criterion id. A subsequent `npm run gen:doc-views -- <same filters>` then
// finds every batch CACHED -> makes ZERO Opus API calls -> only runs the embed + collision filter + write.
// So the subagents replace the generation call; the rest of the proven pipeline is reused unchanged.
//
//   npx tsx scripts/ingest-doc-view-batches.ts [/tmp/docviews/plan.json]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data", "football", "doc-views-gen-cache.json");

type PlanBatch = { i: number; key: string; members: { ref: number; id: number; name: string }[]; outFile: string };

function main(): void {
  const planPath = process.argv[2] ?? join(ROOT, ".docviews", "plan.json");
  if (!existsSync(planPath)) throw new Error(`plan not found at ${planPath} — run \`gen:doc-views -- --emit-plan ...\` first.`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanBatch[];
  const cache: Record<string, Record<number, string[]>> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

  let done = 0;
  let missing = 0;
  let views = 0;
  const missingBatches: number[] = [];
  for (const b of plan) {
    if (!existsSync(b.outFile)) { missing++; missingBatches.push(b.i); continue; }
    const authored = JSON.parse(readFileSync(b.outFile, "utf8")) as { ref: number; paraphrases: string[] }[];
    const byId: Record<number, string[]> = {};
    for (const { ref, paraphrases } of authored) {
      const m = b.members[ref];
      if (!m || !Array.isArray(paraphrases)) continue;
      byId[m.id] = [...new Set(paraphrases.map((p) => String(p).trim()).filter(Boolean))];
      views += byId[m.id].length;
    }
    cache[b.key] = byId;
    done++;
  }
  writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  console.log(`Ingested ${done}/${plan.length} batches into ${CACHE} (${views} raw views).`);
  if (missing) console.log(`  ${missing} batch outFile(s) not yet written: ${missingBatches.slice(0, 30).join(", ")}${missing > 30 ? " …" : ""}`);
}

main();
