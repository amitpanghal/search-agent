// Probe the shallow + deep miss queries (tightening/*.md) through the CURRENT grounder. Those files list
// the reachable grounding misses from the OLD grounder (gold in-bucket but ranked below the top-8 cut):
// shallow = rank 9–32, deep = rank >32. Since we just removed 6 post-cosine layers, this asks: how many of
// those misses does the leaner grounder now recover (pass)? Reuses cached extractor plans (NO Haiku; skips
// uncached); grounds each selector with groundMarket (Voyage embeds, cached per concept in-process).
//
//   npx tsx scripts/probe-misses.ts
//
// Scoring is identical to scripts/extractor-ground-probe.ts (auto accept-set; clean|twin|narrowed = pass).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundMarket } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { idsContainGold, normalize } from "../src/eval/structural-scorer";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const CACHE = join(ROOT, "data", "football", "tier1-extractor-cache.json");
const SHALLOW = join(ROOT, "tightening", "shallow_candidates.md");
const DEEP = join(ROOT, "tightening", "deep_candidates.md");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// column 2 (Query) of each markdown table row "| # | Query | Gold | ... |"
function queriesFrom(file: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    if (cells[2]) out.push(cells[2]);
  }
  return out;
}

const marketKey = (name: string) =>
  normalize(name.replace(/\(settled[^)]*\)/gi, "")).replace(/^player(\ss)?\s/, "").replace(/\sby(\sthe)?\splayer$/, "").trim();
function acceptSet(target: Criterion): Set<number> {
  const key = marketKey(target.name);
  const ids = new Set<number>([target.id]);
  for (const c of loadCatalog().list) if (c.subject === target.subject && marketKey(c.name) === key) ids.add(c.id);
  return ids;
}
const isClean = (t?: string) => t === "confident" || t === "variants";
type Cls = "clean" | "twin" | "narrowed" | "fail";
const PASS: Cls[] = ["clean", "twin", "narrowed"];

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const items = (JSON.parse(readFileSync(DATA, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const idByQuery = new Map(items.map((x) => [x.q, x.id]));
  const cache: Record<string, QueryPlan> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

  const bands: { name: string; queries: string[] }[] = [
    { name: "shallow (rank 9–32)", queries: queriesFrom(SHALLOW) },
    { name: "deep (rank 33+)", queries: queriesFrom(DEEP) },
  ];

  for (const band of bands) {
    let skipped = 0;
    const tally: Record<Cls, number> = { clean: 0, twin: 0, narrowed: 0, fail: 0 };
    const recovered: { q: string; cls: Cls; ground: string }[] = [];
    for (const q of band.queries) {
      const id = idByQuery.get(q);
      const plan = id != null ? cache[q] : undefined;
      if (id == null || !plan || plan.status !== "resolved") { skipped++; continue; }
      const target = cat.byId.get(id);
      if (!target) { skipped++; continue; }
      const accept = acceptSet(target);
      const level = plan.event_scope.level;
      let cls: Cls = "fail";
      let groundStr = "";
      const rank = (c: Cls) => PASS.indexOf(c);
      for (const sel of plan.selectors) {
        const g = await groundMarket(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level, period: sel.period });
        const contains = [...accept].some((a) => idsContainGold(g.ids, a));
        if (!contains) continue;
        const here: Cls = isClean(g.tier) ? (idsContainGold(g.ids, id) ? "clean" : "twin") : "narrowed";
        if (cls === "fail" || (rank(here) >= 0 && rank(here) < rank(cls))) {
          cls = here;
          groundStr = `${g.method}/${g.tier}→${g.ids.map((x) => `${x} "${cat.byId.get(x)?.name}"`).join(", ")}`;
        }
      }
      tally[cls]++;
      if (PASS.includes(cls)) recovered.push({ q, cls, ground: groundStr });
    }

    const graded = band.queries.length - skipped;
    const passed = tally.clean + tally.twin + tally.narrowed;
    console.log(`\n=== ${band.name}: ${band.queries.length} queries (${graded} graded, ${skipped} skipped uncached/unresolved) ===`);
    console.log(`NOW RECOVERED by the leaner grounder: ${passed}/${graded}  [clean ${tally.clean} + twin ${tally.twin} + narrowed ${tally.narrowed}]   still-miss: ${tally.fail}`);
    if (recovered.length) {
      console.log(`recovered queries:`);
      for (const r of recovered) console.log(`  [${r.cls}] "${r.q}"\n        → ${r.ground}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
