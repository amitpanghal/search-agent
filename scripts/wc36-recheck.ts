// Re-check the 36 WC in-menu queries with the NEW (sport-agnostic + Rule-B) extractor, grounded under the
// WC-178 catalog — and diff vs the old WC run (scripts/.wc26-wc26.json). Uses groundPlan, so the combo
// pass is included. Run with the subset active:
//   CATALOG_SUBSET=data/football/wc26-subset.json npx tsx scripts/wc36-recheck.ts
// Caches the new extractions to scripts/.wc36-plans.json (reuse; no re-extract on a second run).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";
import { groundPlan, candidatePool, type GroundResult, type Tier } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football");
const j = (f: string) => JSON.parse(readFileSync(join(DATA, f), "utf8"));
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// #30 gold widened (re-judged): "one goal head start" Handicap also accepts Asian / 3-way handicap.
const ACCEPT: Record<number, number[]> = { 1001159711: [1002135397, 1002275572, 1001224081] };
const goldSet = (id: number) => new Set<number>([id, ...(ACCEPT[id] ?? [])]);

type Row = { id: number; q: string; target: string; tier: Tier | "none"; gotIds: number[]; rank: number; via: string };
function klass(r: { id: number; gotIds: number[]; tier: Tier | "none" }): string {
  const got = r.gotIds.some((x) => goldSet(r.id).has(x));
  if (got) return r.tier === "confident" || r.tier === "variants" ? "hit" : "narrowed";
  return r.gotIds.length ? "wrong" : "none";
}
const tally = (rs: { id: number; gotIds: number[]; tier: Tier | "none" }[]) =>
  rs.reduce((a, r) => ((a[klass(r)] = (a[klass(r)] ?? 0) + 1), a), {} as Record<string, number>);

async function main(): Promise<void> {
  loadDotEnv();
  const mode = process.env.CATALOG_SUBSET ? "wc26" : "full";
  const cat = loadCatalog();
  const nm = (id: number) => cat.byId.get(id)?.name ?? `?${id}`;
  const subset = new Set<number>(j("wc26-subset.json").ids.map(Number));
  const queries = (j("tier1-extractor-queries.json").queries as { id: number; q: string }[]).filter((x) => subset.has(x.id));

  const planCacheFile = join(ROOT, "scripts", ".wc36-plans.json");
  const planCache: Record<string, any> = existsSync(planCacheFile) ? JSON.parse(readFileSync(planCacheFile, "utf8")) : {};

  const rows: Row[] = [];
  for (const { id: target, q } of queries) {
    let plan = planCache[q];
    if (!plan) { plan = await extract(q); planCache[q] = plan; }
    const gold = goldSet(target);
    const legs = (plan.selectors ?? []).map((s: any) => ({ concept: s.market_concept, subjectKind: s.subject?.kind, line: s.line, period: s.period, side: s.subject?.side }));
    const { perSelector, combos } = await groundPlan(legs, plan.event_scope?.level);

    // best gold-bearing result across per-selector groundings AND the combo pass
    const results: { r: GroundResult; via: string }[] = [
      ...perSelector.flatMap((r, i) => (r ? [{ r, via: `sel${i}` }] : [])),
      ...combos.map((r) => ({ r, via: "combo" })),
    ];
    const hit = results.find((x) => x.r.ids.some((id) => gold.has(id)));
    const chosen = hit ?? results[0];
    // gold rank in the raw-cosine pool (best across selectors)
    let rank = -1;
    for (const leg of legs) {
      const pool = await candidatePool(leg.concept, { subjectKind: leg.subjectKind, line: leg.line, level: plan.event_scope?.level, period: leg.period });
      const idx = pool.findIndex((c) => gold.has(c.id));
      if (idx >= 0 && (rank < 0 || idx + 1 < rank)) rank = idx + 1;
    }
    rows.push({ id: target, q, target: nm(target), tier: chosen?.r.tier ?? "none", gotIds: chosen?.r.ids ?? [], rank, via: hit?.via ?? "—" });
  }
  writeFileSync(planCacheFile, JSON.stringify(planCache, null, 1));

  console.log(`\nNEW extractor, ${mode} catalog (${cat.list.length} markets), ${rows.length} queries`);
  console.log("tally:", tally(rows));

  console.log("\nFAILING rows (wrong + none):");
  for (const r of rows) {
    const k = klass(r);
    if (k !== "wrong" && k !== "none") continue;
    const got = r.gotIds.slice(0, 2).map(nm).join(", ") || "—";
    console.log(`  [${k.padEnd(5)}] "${r.q}"\n            gold: ${r.target} (rank ${r.rank}) | got: ${got}`);
  }

  const oldFile = join(ROOT, "scripts", ".wc26-wc26.json");
  if (existsSync(oldFile)) {
    const old: any[] = JSON.parse(readFileSync(oldFile, "utf8"));
    const byQ = new Map(old.map((r) => [r.q, r]));
    console.log(`OLD extractor, wc26: ${JSON.stringify(tally(old))}`);
    console.log("\nchanged rows (old → new):");
    for (const w of rows) {
      const o = byQ.get(w.q);
      if (!o) continue;
      const ck = klass(o), cw = klass(w);
      if (ck !== cw) {
        const land = w.gotIds.some((id) => goldSet(w.id).has(id)) ? `✓gold${w.via === "combo" ? "(combo)" : ""}` : w.gotIds.slice(0, 2).map(nm).join(", ") || "none";
        console.log(`  ${w.target.slice(0, 38).padEnd(38)} | ${ck} → ${cw.padEnd(8)} | wc26 lands: ${land}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
