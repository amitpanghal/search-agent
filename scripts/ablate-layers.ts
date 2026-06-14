// Layer ablation over the extractor→ground probe (Sprint-7 cleanup). Answers "which post-cosine layer
// actually earns its place?" by turning each one OFF and measuring the pass count on the 400-query set.
//
//   npx tsx scripts/ablate-layers.ts
//
// NO extractor (Haiku) calls — it reuses the cached plans (data/football/tier1-extractor-cache.json) and
// SKIPS any uncached query. It does embed each unique market_concept ONCE via Voyage (cached in-process by
// ground-market's qEmbedCache), so all configs share a single embed pass. Scoring is IDENTICAL to
// scripts/extractor-ground-probe.ts (auto accept-set; clean|twin|narrowed = pass), so the baseline column
// reproduces that probe's headline. Each other column flips exactly one layer off via groundMarket's
// guarded `ablate` switch (default off = production behavior), so deltas isolate that one layer.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundMarket, type AblationFlag } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { idsContainGold, normalize } from "../src/eval/structural-scorer";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const CACHE = join(ROOT, "data", "football", "tier1-extractor-cache.json");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// ---- scoring: identical to extractor-ground-probe.ts (accept-set, clean|twin|narrowed = pass) ----
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
const PASS_CLS: Cls[] = ["clean", "twin", "narrowed"];

// one query's pass-class under a given ablation config (best class across its selectors)
async function classify(plan: Extract<QueryPlan, { status: "resolved" }>, id: number, accept: Set<number>, ablate?: Set<AblationFlag>): Promise<Cls> {
  const level = plan.event_scope.level;
  let cls: Cls = "fail";
  const rank = (c: Cls) => PASS_CLS.indexOf(c);
  for (const sel of plan.selectors) {
    const g = await groundMarket(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level, period: sel.period, ablate });
    const containsGold = [...accept].some((a) => idsContainGold(g.ids, a));
    if (!containsGold) continue;
    const here: Cls = isClean(g.tier) ? (idsContainGold(g.ids, id) ? "clean" : "twin") : "narrowed";
    if (cls === "fail" || (rank(here) >= 0 && rank(here) < rank(cls))) cls = here;
  }
  return cls;
}

type Config = { name: string; ablate?: Set<AblationFlag> };
// The 6 net-harmful/inert layers were DELETED from the grounder after this ablation (2026-06-11), so only
// the two survivors stay toggleable. After the deletion the NEW baseline should reproduce the old "LEAN"
// number (~72 pass / 23 clean) — that's the regression check that the code removal matches the measurement.
const CONFIGS: Config[] = [
  { name: "baseline (lexical+bm25, others removed)" },
  { name: "-lexical", ablate: new Set(["lexical"]) },
  { name: "-bm25", ablate: new Set(["bm25"]) },
  { name: "-lexical -bm25 (whole lexical channel)", ablate: new Set(["lexical", "bm25"]) },
];

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const items = (JSON.parse(readFileSync(DATA, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const cache: Record<string, QueryPlan> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

  // resolved, cached, with a known target — the gradable population (no Haiku; uncached are skipped)
  type Item = { q: string; id: number; plan: Extract<QueryPlan, { status: "resolved" }>; accept: Set<number> };
  const gradable: Item[] = [];
  let skippedUncached = 0;
  for (const { id, q } of items) {
    const plan = cache[q];
    if (!plan) { skippedUncached++; continue; }
    if (plan.status !== "resolved") continue;
    const target = cat.byId.get(id);
    if (!target) continue;
    gradable.push({ q, id, plan, accept: acceptSet(target) });
  }

  // baseline classes first (the comparison key for both recall (pass) and precision (clean) flips)
  const base = new Map<string, Cls>();
  for (const it of gradable) base.set(it.q, await classify(it.plan, it.id, it.accept));

  const pass = (cls: Cls) => PASS_CLS.includes(cls);
  const isCln = (cls: Cls) => cls === "clean"; // confident on the EXACT id = the precision metric
  const basePass = [...base.values()].filter(pass).length;
  const baseClean = [...base.values()].filter(isCln).length;
  const sgn = (n: number) => (n >= 0 ? "+" : "") + n;

  console.log(`\n=== Layer ablation — extractor→ground, ${gradable.length} resolved+cached queries (skipped ${skippedUncached} uncached, no Haiku) ===`);
  console.log(`baseline: pass(recall)=${basePass}  clean(precision)=${baseClean}  of ${gradable.length}\n`);
  console.log(`config                                          pass  Δpass   clean  Δclean   clean-lost  clean-gained`);
  console.log(`---------------------------------------------------------------------------------------------------------`);
  console.log(`${"baseline (all on)".padEnd(46)}  ${String(basePass).padStart(4)}    —    ${String(baseClean).padStart(5)}     —`);

  const detail: string[] = [];
  for (const cfg of CONFIGS.slice(1)) {
    let p = 0;
    let cl = 0;
    const cleanLost: string[] = [];
    const cleanGained: string[] = [];
    for (const it of gradable) {
      const cls = await classify(it.plan, it.id, it.accept, cfg.ablate);
      if (pass(cls)) p++;
      if (isCln(cls)) cl++;
      const wasClean = isCln(base.get(it.q)!);
      if (wasClean && !isCln(cls)) cleanLost.push(it.q);
      if (!wasClean && isCln(cls)) cleanGained.push(it.q);
    }
    const dp = p - basePass;
    const dc = cl - baseClean;
    console.log(
      `${cfg.name.padEnd(46)}  ${String(p).padStart(4)}  ${sgn(dp).padStart(4)}    ${String(cl).padStart(5)}  ${sgn(dc).padStart(5)}    ${String(cleanLost.length).padStart(9)}  ${String(cleanGained.length).padStart(11)}`,
    );
    if (cleanLost.length || cleanGained.length) {
      detail.push(`\n[${cfg.name}]  Δpass ${sgn(dp)}  Δclean ${sgn(dc)}`);
      for (const q of cleanLost) detail.push(`   − lost confident: "${q}"`);
      for (const q of cleanGained) detail.push(`   + gained confident: "${q}"`);
    }
  }

  console.log(`\n--- confident (clean) flips per layer ---`);
  console.log(detail.join("\n") || "  (no clean flips)");
  console.log(`\nReading it: a layer with Δpass≈0 AND Δclean≈0 and no clean flips is true dead weight (drop).`);
  console.log(`Δclean < 0 (clean-lost > clean-gained) = it protects PRECISION even if recall is flat → keep.`);
  console.log(`Δpass > 0 while Δclean ≥ 0 (like specificity) = net-harmful: it buries golds without buying precision → drop/fix.\n`);
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
