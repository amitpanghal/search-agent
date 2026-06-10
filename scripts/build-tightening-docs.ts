// Build tightening/shallow_candidates.md and tightening/deep_candidates.md — one table row per reachable
// miss (gold present in its bucket but ranked below the live top-8 cut). Shallow = rank 9–32, deep = rank
// >32. Columns: Query | Gold | Returned | Candidates (rank 1 → gold) | Reason | Probable fix.
//
//   npx tsx scripts/build-tightening-docs.ts
//
// Returned value (what the live pipeline actually grounded to) is read from the probe log — no re-grounding
// for that. The candidate chain is the raw cosine ranking from candidatePool (one Voyage embed per miss
// selector). Reason/fix come from the shared tagger (miss-reasons.ts).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidatePool } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { normalize } from "../src/eval/structural-scorer";
import { type Miss, classify } from "./miss-reasons";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, "planning", "queries", "tier_1_automation.md");
const QUERIES = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const CACHE = join(ROOT, "data", "football", "tier1-extractor-cache.json");
const OUTDIR = join(ROOT, "tightening");
const CHAIN_CAP = 32; // names shown in the candidate chain before "…" (keeps the table cell readable)

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

const marketKey = (name: string) =>
  normalize(name.replace(/\(settled[^)]*\)/gi, "")).replace(/^player(\ss)?\s/, "").replace(/\sby(\sthe)?\splayer$/, "").trim();
function acceptSet(target: Criterion, cat: ReturnType<typeof loadCatalog>): Set<number> {
  const key = marketKey(target.name);
  const ids = new Set<number>([target.id]);
  for (const c of cat.list) if (c.subject === target.subject && marketKey(c.name) === key) ids.add(c.id);
  return ids;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const queries = (JSON.parse(readFileSync(QUERIES, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const idByQuery = new Map(queries.map((x) => [x.q, x.id]));
  const cache: Record<string, QueryPlan> = JSON.parse(readFileSync(CACHE, "utf8"));

  // probe log → resolved-miss query + the "returned" grounding-response cell (already pipe-escaped there)
  const md = readFileSync(LOG, "utf8");
  const failBlock = (md.match(/<!-- PROBE:START -->[\s\S]*?<!-- PROBE:END -->/)?.[0] ?? "").split(/### Passing queries/)[0] ?? "";
  const returnedByQ = new Map<string, string>();
  for (const raw of failBlock.split("\n")) {
    if (!raw.startsWith("| ✗")) continue;
    const m = raw.match(/^\|\s*✗[^|]*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*([\s\S]*?)\s*\|\s*$/);
    if (!m) continue;
    const rankCell = (m[1] ?? "").trim();
    if (rankCell === "—" || rankCell === "") continue; // punt — not a resolved miss
    returnedByQ.set((m[2] ?? "").replace(/\\\|/g, "|"), (m[4] ?? "").trim());
  }

  type Row = { rank: number; q: string; gold: string; goldId: number; returned: string; chain: string; reason: string; fix: string };
  const rows: Row[] = [];
  let done = 0;
  for (const [q] of returnedByQ) {
    const id = idByQuery.get(q);
    const plan = cache[q];
    if (id == null || !plan || plan.status !== "resolved") continue;
    const target = cat.byId.get(id)!;
    const accept = acceptSet(target, cat);
    const level = (plan as any).event_scope?.level;
    let best: { rank: number; pool: { id: number; name: string; score: number }[]; concept: string } | null = null;
    for (const sel of plan.selectors) {
      const pool = await candidatePool(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level });
      const at = pool.findIndex((c) => accept.has(c.id));
      if (at >= 0 && (!best || at + 1 < best.rank)) best = { rank: at + 1, pool, concept: sel.market_concept };
    }
    if (!best || !Number.isFinite(best.rank)) continue; // unreachable (∞) excluded — these are reachable misses
    // candidate chain: rank 1 → gold, capped, gold bolded
    const goldIdx = best.rank - 1;
    const shown = best.pool.slice(0, Math.min(best.rank, CHAIN_CAP));
    const chainParts = shown.map((c, i) => {
      const label = `${i + 1}. ${esc(c.name)} [${c.score.toFixed(3)}]`;
      return accept.has(c.id) ? `**${label} ⟵ GOLD**` : label;
    });
    if (best.rank > CHAIN_CAP) chainParts.push(`… **${best.rank}. ${esc(target.name)} [${best.pool[goldIdx]!.score.toFixed(3)}] ⟵ GOLD**`);
    const miss: Miss = { q, id, gold: target.name, subject: target.subject, rank: best.rank, concept: best.concept, top3: best.pool.slice(0, 3).map((c) => `${c.name} [${c.score.toFixed(3)}]`), allConcepts: plan.selectors.map((s) => s.market_concept) };
    const { reason, fix } = classify(miss);
    rows.push({ rank: best.rank, q, gold: target.name, goldId: id, returned: returnedByQ.get(q) ?? "—", chain: chainParts.join("<br>"), reason, fix });
    if (++done % 40 === 0) process.stderr.write(`  …${done}\n`);
  }
  rows.sort((a, b) => a.rank - b.rank);

  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR);
  const header = (title: string, band: string, n: number) =>
    [
      `# ${title}`,
      "",
      `> Reachable grounding misses from the cleaned extractor→ground probe (355 queries): the gold market IS`,
      `> in its subject bucket but ranked **${band}** by raw cosine, below the live top-8 pool cut. ${n} queries.`,
      `> **Returned** = what the live pipeline actually grounded to (method/tier→ids). **Candidates** = the raw`,
      `> cosine ranking from rank 1 down to the gold (capped at ${CHAIN_CAP} names; gold in bold).`,
      `> Generated by scripts/build-tightening-docs.ts. Plain-English reason + probable fix per row.`,
      "",
      `| # | Query | Gold | Returned (resolved value) | Candidates (rank 1 → gold) | Reason it landed there | Probable fix |`,
      `| --- | --- | --- | --- | --- | --- | --- |`,
    ].join("\n");
  const render = (r: Row, i: number) => `| ${i + 1} | ${esc(r.q)} | ${esc(r.gold)} (${r.goldId}) | ${r.returned} | ${r.chain} | ${esc(r.reason)} | ${esc(r.fix)} |`;

  const shallow = rows.filter((r) => r.rank <= 32);
  const deep = rows.filter((r) => r.rank > 32);
  writeFileSync(join(OUTDIR, "shallow_candidates.md"), header("Tightening — shallow candidates (rank 9–32)", "9–32", shallow.length) + "\n" + shallow.map(render).join("\n") + "\n");
  writeFileSync(join(OUTDIR, "deep_candidates.md"), header("Tightening — deep candidates (rank 33+)", "33 and deeper", deep.length) + "\n" + deep.map(render).join("\n") + "\n");
  console.log(`\nwrote tightening/shallow_candidates.md (${shallow.length}) + tightening/deep_candidates.md (${deep.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
