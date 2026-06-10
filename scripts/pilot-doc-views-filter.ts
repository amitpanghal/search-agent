// Pilot-only (Sprint 6, decision 27) — run the REAL collision filter over doc-views authored by a fresh,
// eval-BLIND subagent (Opus), NOT by gen-doc-views.ts's own Opus call. Reuses buildClusters + filterCluster
// so the filter math is byte-identical to the production pipeline. Reads the subagent's raw views (a JSON
// array of { ref, paraphrases }, ref = index in the cluster's member list), embeds names + views with
// voyage-3, drops any view closer to a distinct-statCore sibling than to its own market, and prints
// survivors + drops. THROWAWAY — delete once Phase 1 step 2 runs for real.
//
//   npx tsx scripts/pilot-doc-views-filter.ts <category-substr> <raw-views.json>

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildClusters, filterCluster } from "./gen-doc-views";
import { loadCatalog } from "../src/resolver/catalog";
import { embed } from "../src/resolver/embed";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [catSub, rawFile] = process.argv.slice(2);
  if (!catSub || !rawFile) throw new Error("usage: pilot-doc-views-filter.ts <category-substr> <raw-views.json>");

  const cat = loadCatalog();
  const cluster = buildClusters(cat.list).find((c) => c.category.toLowerCase().includes(catSub.toLowerCase()));
  if (!cluster) throw new Error(`no cluster matching category "${catSub}"`);

  const authored = JSON.parse(readFileSync(rawFile, "utf8")) as { ref: number; paraphrases: string[] }[];
  const raw: Record<number, string[]> = {};
  for (const { ref, paraphrases } of authored) {
    const m = cluster.members[ref];
    if (!m) { console.warn(`(ref ${ref} out of range — ignored)`); continue; }
    raw[m.id] = [...new Set(paraphrases.map((p) => p.trim()).filter(Boolean))];
  }

  const texts = [...new Set([...cluster.members.map((m) => m.name), ...Object.values(raw).flat()])];
  const vecs = await embed(texts, "document");
  const vec = new Map(texts.map((t, i) => [t, vecs[i]!]));
  const kept = filterCluster(cluster, raw, vec);

  let nGen = 0;
  let nKept = 0;
  for (const m of cluster.members) {
    const all = raw[m.id] ?? [];
    const surv = kept[m.id] ?? [];
    nGen += all.length;
    nKept += surv.length;
    console.log(`\n[${m.id}] ${m.name}`);
    for (const v of surv) console.log(`   ✓ ${v}`);
    for (const v of all.filter((v) => !surv.includes(v))) console.log(`   ✗ ${v}`);
  }
  console.log(`\nCluster "${cluster.key}": ${cluster.members.length} members · ${nKept}/${nGen} views survived the collision filter (${nGen ? ((100 * nKept) / nGen).toFixed(0) : 0}%).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
