// Recompute the grounder's TOP-10 candidate pool for every query in tightening/shallow_candidates.md, against
// the CURRENT index (full catalog), reusing cached extractor plans (NO Anthropic call — only Voyage embeds).
// For each shallow row: parse its query + gold id, pull the cached plan, pick the selector whose pool best
// contains the gold (accept-set = gold + same-market twins), and emit the top-10 candidates + the gold's rank.
// Output feeds a cold Haiku presence/re-express judge; goldInTop10 is the ground-truth to score Haiku against.
//   npx tsx scripts/shallow-pool.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidatePool } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { normalize } from "../src/eval/structural-scorer";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MD = join(ROOT, "tightening", "shallow_candidates.md");
const CACHE = join(ROOT, "data", "football", "tier1-extractor-cache.json");
const OUT = join(ROOT, "scripts", ".shallow-pool.json");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// gold + same-market twins (period/side/settlement variants) — a hit on any is "present" (matches the eval).
const marketKey = (name: string) =>
  normalize(name.replace(/\(settled[^)]*\)/gi, "")).replace(/^player(\ss)?\s/, "").replace(/\sby(\sthe)?\splayer$/, "").trim();
function acceptSet(target: Criterion, cat: ReturnType<typeof loadCatalog>): Set<number> {
  const key = marketKey(target.name);
  const ids = new Set<number>([target.id]);
  for (const c of cat.list) if (c.subject === target.subject && marketKey(c.name) === key) ids.add(c.id);
  return ids;
}
const withPeriod = (t: string, p?: string) => (p && p !== "full" ? `${t} ${p.replace(/_/g, " ")}` : t);

// parse "| n | query | gold (id) | ..." rows (unescaped-pipe split; query/gold may carry \| )
function parseRows(md: string): { q: string; goldId: number }[] {
  const out: { q: string; goldId: number }[] = [];
  for (const line of md.split("\n")) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    const q = cells[2];
    const gold = cells[3] ?? "";
    const m = gold.match(/\((\d+)\)\s*$/);
    if (q && m) out.push({ q, goldId: Number(m[1]) });
  }
  return out;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const cache: Record<string, QueryPlan> = JSON.parse(readFileSync(CACHE, "utf8"));
  const rows = parseRows(readFileSync(MD, "utf8"));

  type Item = {
    q: string; concept: string; subjectKind?: string; goldId: number; goldName: string;
    goldRank: number; goldInTop10: boolean; candidates: { id: number; name: string }[];
  };
  const items: Item[] = [];
  let done = 0;
  for (const { q, goldId } of rows) {
    const plan = cache[q];
    const target = cat.byId.get(goldId);
    if (!plan || plan.status !== "resolved" || !target) continue;
    const accept = acceptSet(target, cat);
    const level = (plan as any).event_scope?.level;
    let best: { rank: number; pool: { id: number; name: string; score: number }[]; concept: string; subjectKind?: string } | null = null;
    for (const sel of plan.selectors) {
      const pool = await candidatePool(withPeriod(sel.market_concept, (sel as any).period), { subjectKind: sel.subject.kind, line: sel.line, level });
      const at = pool.findIndex((c) => accept.has(c.id));
      const rank = at >= 0 ? at + 1 : Infinity;
      if (!best || rank < best.rank) best = { rank, pool, concept: sel.market_concept, subjectKind: sel.subject.kind };
    }
    if (!best) continue;
    items.push({
      q, concept: best.concept, subjectKind: best.subjectKind, goldId, goldName: target.name,
      goldRank: Number.isFinite(best.rank) ? best.rank : -1,
      goldInTop10: best.rank <= 10,
      candidates: best.pool.slice(0, 10).map((c) => ({ id: c.id, name: c.name })),
    });
    if (++done % 30 === 0) process.stderr.write(`  …${done}\n`);
  }
  writeFileSync(OUT, JSON.stringify(items, null, 1) + "\n");

  const in10 = items.filter((i) => i.goldInTop10).length;
  console.log(`\nshallow rows scored: ${items.length}`);
  console.log(`gold now in TOP-10 (full index): ${in10}/${items.length}  (${Math.round((100 * in10) / items.length)}%)`);
  console.log(`gold still BELOW top-10:         ${items.length - in10}`);
  console.log(`wrote ${OUT}`);
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
