// WC26 less-noise probe (NO LLM): ground the tier-1 queries whose by-construction target IS a WC26-offered
// market, twice — once against the FULL catalog, once against the WC26-178 subset (CATALOG_SUBSET) — and
// diff the grounding behaviour. Tests the hypothesis: fewer distractor criterions ⇒ more `confident`, fewer
// `ambiguous`/`shortlist`/wrong-id. Reuses cached extractor plans (no Anthropic call); only the Voyage query
// embeds are live. Also records the gold target's RANK in the raw-cosine candidate pool (recall ceiling).
//   npx tsx scripts/wc26-noise-probe.ts                                   # FULL — writes scripts/.wc26-full.json
//   CATALOG_SUBSET=data/football/wc26-subset.json npx tsx scripts/wc26-noise-probe.ts   # WC26 — writes + TABLE
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundMarket, candidatePool, type GroundOpts, type SubjectKind, type Tier } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football");
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

type Sel = { subject: { kind: SubjectKind }; market_concept: string; line?: GroundOpts["line"]; period?: GroundOpts["period"] };
type Plan = { status: string; event_scope?: { level?: GroundOpts["level"] }; selectors?: Sel[] };
// Per query: the grounding the executor would see + where the gold sits in the raw-cosine pool.
type Row = {
  id: number; q: string; target: string;
  tier: Tier | "none"; gotIds: number[]; gotNames: string[]; // grounding outcome (primary selector)
  rank: number; poolSize: number; goldCos: number;           // gold's rank in the pool (1-based; -1 = not in pool)
};

const j = (f: string) => JSON.parse(readFileSync(join(DATA, f), "utf8"));

// Gold accept-overrides (re-judged 2026-06-11): a query's labeled id plus any catalog market that is a
// legitimately-equivalent answer, so the grounder isn't marked wrong for picking an equal market. #30
// "one goal head start" — Handicap also accepts Asian Handicap (both twins) and 3-Way Handicap.
const ACCEPT: Record<number, number[]> = { 1001159711: [1002135397, 1002275572, 1001224081] };
const goldSet = (id: number) => new Set<number>([id, ...(ACCEPT[id] ?? [])]);

async function run(): Promise<Row[]> {
  const cat = loadCatalog();
  const nm = (id: number) => cat.byId.get(id)?.name ?? `?${id}`;
  const subsetIds = new Set<number>(j("wc26-subset.json").ids.map(Number));
  const queries = j("tier1-extractor-queries.json").queries as { id: number; q: string }[];
  const cache = j("tier1-extractor-cache.json") as Record<string, Plan>;
  const inMenu = queries.filter((x) => subsetIds.has(x.id) && cache[x.q]);

  const rows: Row[] = [];
  for (const { id: target, q } of inMenu) {
    const gold = goldSet(target);
    const plan = cache[q]!;
    const level = plan.event_scope?.level;
    // Per selector: ground it, and find the BEST gold rank (any accepted id) in that selector's pool.
    const per = [] as { tier: Tier | "none"; ids: number[]; rank: number; poolSize: number; cos: number; hasTarget: boolean }[];
    for (const sel of plan.selectors ?? []) {
      const opts: GroundOpts = { subjectKind: sel.subject.kind, line: sel.line, level, period: sel.period };
      const g = await groundMarket(sel.market_concept, opts);
      const pool = await candidatePool(sel.market_concept, opts);
      const idx = pool.findIndex((c) => gold.has(c.id));
      per.push({ tier: g.tier ?? "none", ids: g.ids, rank: idx < 0 ? -1 : idx + 1, poolSize: pool.length, cos: idx < 0 ? 0 : pool[idx]!.score, hasTarget: g.ids.some((id) => gold.has(id)) });
    }
    // primary selector = the one returning the gold; else the one ranking the gold best; else the first.
    const withGold = per.filter((p) => p.rank > 0);
    const primary = per.find((p) => p.hasTarget) ?? (withGold.sort((a, b) => a.rank - b.rank)[0]) ?? per[0] ?? { tier: "none" as const, ids: [], rank: -1, poolSize: 0, cos: 0 };
    rows.push({ id: target, q, target: nm(target), tier: primary.tier, gotIds: primary.ids, gotNames: primary.ids.map(nm), rank: primary.rank, poolSize: primary.poolSize, goldCos: primary.cos });
  }
  return rows;
}

function classify(r: Row): "hit" | "narrowed" | "wrong" | "none" {
  const got = r.gotIds.some((id) => goldSet(r.id).has(id));
  if (got) return r.tier === "confident" || r.tier === "variants" ? "hit" : "narrowed";
  return r.gotIds.length ? "wrong" : "none";
}
const tally = (rs: Row[]) => rs.reduce((a, r) => ((a[classify(r)] = (a[classify(r)] ?? 0) + 1), a), {} as Record<string, number>);

async function main(): Promise<void> {
  loadDotEnv();
  if (!process.env.VOYAGE_API_KEY) { console.error("VOYAGE_API_KEY not set (.env)"); process.exit(2); }
  const mode = process.env.CATALOG_SUBSET ? "wc26" : "full";
  const rows = await run();
  writeFileSync(join(ROOT, "scripts", `.wc26-${mode}.json`), JSON.stringify(rows, null, 1));
  console.log(`\nMODE=${mode}  catalog=${loadCatalog().list.length} markets  queries=${rows.length}  tally=${JSON.stringify(tally(rows))}`);

  if (mode !== "wc26") { console.log(`wrote baseline. Now run with CATALOG_SUBSET=data/football/wc26-subset.json.`); return; }
  const fullFile = join(ROOT, "scripts", `.wc26-full.json`);
  if (!existsSync(fullFile)) { console.log("(run without CATALOG_SUBSET first to get the full-catalog baseline)"); return; }
  const full: Row[] = JSON.parse(readFileSync(fullFile, "utf8"));
  const byQ = new Map(full.map((r) => [r.q, r]));

  // one row per query: gold | FULL verdict+rank | WC26 verdict+rank | what it grounded to (wc26)
  const rk = (r: Row) => (r.rank < 0 ? "—" : `#${r.rank}/${r.poolSize}`);
  const verdict = (r: Row) => `${classify(r)}/${r.tier}`;
  const landed = (r: Row) => (r.gotIds.some((id) => goldSet(r.id).has(id)) ? "✓ gold" : (r.gotNames.slice(0, 2).join(", ") || "none"));
  console.log("\n# | gold market | FULL | rank | WC26 | rank | wc26 landed on");
  console.log("--|-------------|------|------|------|------|----------------");
  rows.forEach((w, i) => {
    const f = byQ.get(w.q)!;
    console.log(`${String(i + 1).padStart(2)} | ${w.target.slice(0, 40).padEnd(40)} | ${verdict(f).padEnd(18)} | ${rk(f).padEnd(9)} | ${verdict(w).padEnd(18)} | ${rk(w).padEnd(9)} | ${landed(w)}`);
  });
  console.log(`\nFULL tally: ${JSON.stringify(tally(full))}`);
  console.log(`WC26 tally: ${JSON.stringify(tally(rows))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
