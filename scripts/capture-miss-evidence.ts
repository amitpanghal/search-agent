// Evidence capture for the "why is the gold buried?" breakdown. For every RESOLVED miss in the cleaned
// probe, re-ground via candidatePool (read-only cosine ranking) and record: the gold's rank + cosine score,
// and the names/scores sitting ABOVE it. That's the raw material for tagging each miss by reason. No LLM
// (extractor output reused from cache); one Voyage embed per selector of the misses only.
//
//   npx tsx scripts/capture-miss-evidence.ts   # writes /tmp/miss-evidence.json + a readable summary

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidatePool } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { normalize } from "../src/eval/structural-scorer";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, "planning", "queries", "tier_1_automation.md");
const QUERIES = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const CACHE = join(ROOT, "data", "football", "tier1-extractor-cache.json");
const OUT = "/tmp/miss-evidence.json";

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// accept-set = target + settlement/register twins (mirrors the probe's grading)
const marketKey = (name: string) =>
  normalize(name.replace(/\(settled[^)]*\)/gi, "")).replace(/^player(\ss)?\s/, "").replace(/\sby(\sthe)?\splayer$/, "").trim();
function acceptSet(target: Criterion, cat: ReturnType<typeof loadCatalog>): Set<number> {
  const key = marketKey(target.name);
  const ids = new Set<number>([target.id]);
  for (const c of cat.list) if (c.subject === target.subject && marketKey(c.name) === key) ids.add(c.id);
  return ids;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const queries = (JSON.parse(readFileSync(QUERIES, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const idByQuery = new Map(queries.map((x) => [x.q, x.id]));
  const cache: Record<string, QueryPlan> = JSON.parse(readFileSync(CACHE, "utf8"));

  // resolved-miss queries from the failing table (rank cell is a number or ∞, never "—")
  const md = readFileSync(LOG, "utf8");
  const failBlock = (md.match(/<!-- PROBE:START -->[\s\S]*?<!-- PROBE:END -->/)?.[0] ?? "").split(/### Passing queries/)[0] ?? "";
  const missQs: string[] = [];
  for (const raw of failBlock.split("\n")) {
    if (!raw.startsWith("| ✗")) continue;
    const m = raw.match(/^\|\s*✗[^|]*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|/);
    if (!m) continue;
    if ((m[1] ?? "").trim() === "—" || (m[1] ?? "").trim() === "") continue;
    missQs.push((m[2] ?? "").replace(/\\\|/g, "|"));
  }

  const out: any[] = [];
  let done = 0;
  for (const q of missQs) {
    const id = idByQuery.get(q);
    const plan = cache[q];
    if (id == null || !plan || plan.status !== "resolved") continue;
    const target = cat.byId.get(id)!;
    const accept = acceptSet(target, cat);
    const level = (plan as any).event_scope?.level;
    let best: any = { rank: Infinity };
    for (const sel of plan.selectors) {
      const pool = await candidatePool(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level });
      const at = pool.findIndex((c) => accept.has(c.id));
      if (at >= 0 && at + 1 < best.rank) {
        best = {
          rank: at + 1,
          concept: sel.market_concept,
          subjectKind: sel.subject.kind,
          line: sel.line?.kind ?? null,
          goldScore: Number(pool[at]!.score.toFixed(3)),
          top3: pool.slice(0, 3).map((c) => `${c.name} [${c.score.toFixed(3)}]`),
          justAbove: pool.slice(Math.max(0, at - 2), at).map((c) => `${c.name} [${c.score.toFixed(3)}]`),
        };
      }
    }
    out.push({ q, id, gold: target.name, subject: target.subject, ...best, allConcepts: plan.selectors.map((s) => s.market_concept) });
    if (++done % 40 === 0) process.stderr.write(`  …${done}/${missQs.length}\n`);
  }
  out.sort((a, b) => a.rank - b.rank);
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`captured ${out.length} resolved misses → ${OUT}`);
  console.log(`  rank>8: ${out.filter((x) => x.rank > 8 && Number.isFinite(x.rank)).length}  ·  shallow 9–32: ${out.filter((x) => x.rank > 8 && x.rank <= 32).length}  ·  deep >32: ${out.filter((x) => x.rank > 32 && Number.isFinite(x.rank)).length}  ·  ∞: ${out.filter((x) => !Number.isFinite(x.rank)).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
