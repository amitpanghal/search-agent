// Throwaway analysis: of the cleaned-probe resolved misses, how many can each proposed lever even TOUCH?
//   - Outcome-family gate (Sprint 7): fires ONLY on the competition-outcome cluster (win-title, reach-stage,
//     qualify-group, finish-position, top-scorer, award) and is inert on fixture-stat markets. So its reach
//     is bounded by how many misses target that cluster.
//   - Doc-views: reorder the cosine pool; reach is bounded by the recall curve (already measured).
// Reuses the captured gold-rank from tier_1_automation.md (no model calls). Family is a coarse lexical proxy
// of Sprint 7's committed cluster — good enough to size reach, not the real build-time tagger.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "../src/resolver/catalog";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, "planning", "queries", "tier_1_automation.md");
const QUERIES = join(ROOT, "data", "football", "tier1-extractor-queries.json");

// coarse proxy for Sprint 7's committed competition-outcome families (Q1). Precision-biased keywords.
function compOutcomeFamily(name: string): string | null {
  const n = name.toLowerCase();
  if (/\btop\b.*\bscorer|\bgoalscorer|most goals in the (competition|tournament|league)|golden boot/.test(n)) return "top-scorer";
  if (/golden (ball|glove)|player of the (tournament|match|competition)|\baward\b|man of the match/.test(n)) return "award";
  if (/\b(reach|to reach)\b.*(final|semi|quarter|round)|to play in the final/.test(n)) return "reach-stage";
  if (/qualif|to go through|to advance|knocked out|eliminated/.test(n)) return "qualify-group";
  if (/relegat|promot|finishing (position|order)|to finish|top \d|bottom (place|\d)|wooden spoon/.test(n)) return "finish-position";
  if (/winner|to win the (trophy|title|league|competition|tournament|cup|group|world cup|final)|tournament outcome|champion|winning (confederation|conference|region)/.test(n))
    return "win-title";
  return null; // fixture-stat / uncommitted → gate inert
}

function main(): void {
  const cat = loadCatalog();
  const queries = (JSON.parse(readFileSync(QUERIES, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const idByQuery = new Map(queries.map((x) => [x.q, x.id]));

  const md = readFileSync(LOG, "utf8");
  const probe = md.match(/<!-- PROBE:START -->[\s\S]*?<!-- PROBE:END -->/)?.[0] ?? "";
  const failBlock = probe.split(/### Passing queries/)[0] ?? "";

  type Miss = { q: string; id: number; name: string; rank: number; fam: string | null };
  const misses: Miss[] = [];
  for (const raw of failBlock.split("\n")) {
    if (!raw.startsWith("| ✗")) continue;
    // | ✗ cls | gold rank | query | concept | grounding |
    const m = raw.match(/^\|\s*✗[^|]*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*([\s\S]*?)\s*\|\s*$/);
    if (!m) continue;
    const rankCell = (m[1] ?? "").trim();
    if (rankCell === "—" || rankCell === "") continue; // punt (no concept grounded) — not a resolved miss
    const q = (m[2] ?? "").replace(/\\\|/g, "|");
    const id = idByQuery.get(q);
    if (id == null) continue;
    const name = cat.byId.get(id)?.name ?? "?";
    misses.push({ q, id, name, rank: rankCell === "∞" ? Infinity : Number(rankCell), fam: compOutcomeFamily(name) });
  }

  const comp = misses.filter((x) => x.fam);
  const stat = misses.filter((x) => !x.fam);
  const reachable = (xs: Miss[], k: number) => xs.filter((x) => x.rank <= k).length;

  console.log(`\nResolved misses parsed: ${misses.length}`);
  console.log(`\n=== Outcome-family gate reach (Sprint 7 committed cluster) ===`);
  console.log(`  in competition-outcome cluster (gate CAN fire): ${comp.length}`);
  const byFam = new Map<string, number>();
  for (const x of comp) byFam.set(x.fam!, (byFam.get(x.fam!) ?? 0) + 1);
  for (const [f, n] of [...byFam].sort((a, b) => b[1] - a[1])) console.log(`      ${f}: ${n}`);
  console.log(`  fixture-stat / uncommitted (gate INERT): ${stat.length}`);
  console.log(`\n  rank of the competition-outcome misses (does the gold even need un-burying?):`);
  console.log(`      @1 ${reachable(comp, 1)}  @3 ${reachable(comp, 3)}  @8 ${reachable(comp, 8)}  @32 ${reachable(comp, 32)}  reachable ${comp.filter((x) => Number.isFinite(x.rank)).length}/${comp.length}`);
  if (comp.length) {
    console.log(`\n  competition-outcome misses (target | gold rank | query):`);
    for (const x of comp.sort((a, b) => a.rank - b.rank)) console.log(`      [${x.fam}] ${x.id} "${x.name}"  rank ${x.rank === Infinity ? "∞" : x.rank}  ::  ${x.q}`);
  }

  console.log(`\n=== Doc-view reach (cosine reorder; bounded by recall curve) ===`);
  for (const k of [8, 16, 32]) console.log(`  misses with gold reachable but ranked > ${k} (doc-view would have to lift past depth ${k}): ${stat.filter((x) => Number.isFinite(x.rank) && x.rank > k).length} fixture-stat + ${comp.filter((x) => Number.isFinite(x.rank) && x.rank > k).length} comp`);
  console.log(`  unreachable (wrong bucket; neither lever helps): ${misses.filter((x) => !Number.isFinite(x.rank)).length}`);
}

main();
