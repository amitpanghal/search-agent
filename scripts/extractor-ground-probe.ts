// Spike (b), Sprint 4 — the TRUE-distribution grounding probe. Unlike the no-LLM catalog sweep, this
// runs realistic USER queries through the REAL extractor (Haiku) and grounds the emitted `market_concept`,
// so it measures what grounding actually receives in production (extractor normalization in the loop) —
// not a hand-authored paraphrase of a catalog name. Each query is authored to target a known catalog id
// (the by-construction label); grading uses an auto accept-set (target + its settlement/register twins),
// the "accept-set, not single-id" fix. Directly comparable to the direct-paraphrase batch (same targets).
//
//   npx tsx scripts/extractor-ground-probe.ts
//
// Mirrors run.ts's grounding wiring exactly: groundMarket(market_concept, { subjectKind, line, level }).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";
import { groundMarket, candidatePool } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { idsContainGold, normalize } from "../src/eval/structural-scorer";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const LOG = join(ROOT, "planning", "queries", "tier_1_automation.md");
// Extractor-output cache (query -> QueryPlan). The extractor is the only LLM call here; caching its output
// means re-scoring / re-grounding / re-logging never re-hits the LLM (only uncached queries call extract()).
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

// Market identity (same as catalog-sweep): settlement + player-register folded, period/side kept.
const marketKey = (name: string) =>
  normalize(name.replace(/\(settled[^)]*\)/gi, ""))
    .replace(/^player(\ss)?\s/, "")
    .replace(/\sby(\sthe)?\splayer$/, "")
    .trim();

// Auto accept-set: the target id + every catalog id that is the SAME market (settlement/register twin),
// same subject. Implements "accept-set, not single-id" so a twin grounding counts as correct.
function acceptSet(target: Criterion): Set<number> {
  const key = marketKey(target.name);
  const ids = new Set<number>([target.id]);
  for (const c of loadCatalog().list) if (c.subject === target.subject && marketKey(c.name) === key) ids.add(c.id);
  return ids;
}

const isClean = (t?: string) => t === "confident" || t === "variants";
const nm = (ids: number[]) => ids.map((id) => `${id} "${loadCatalog().byId.get(id)?.name ?? "?"}"`).join(" | ") || "—";

// PASS = the gold (or an accept-set twin) is in the returned ids: `clean` (exact id, confident|variants),
// `twin` (sibling id, confident|variants), `narrowed` (gold present in a non-confident ambiguous/shortlist
// set — surfaced for the executor to clarify, not lost). `fail` = gold absent / grounded elsewhere / abstain.
type Cls = "clean" | "twin" | "narrowed" | "fail";
const PASS_CLS: Cls[] = ["clean", "twin", "narrowed"];
// rank = the BEST (lowest) cosine rank at which an accept-set id sits in its subject bucket, across the
// query's selectors — the reachability ceiling. Infinity = unreachable (gold in the wrong bucket entirely,
// so no doc-view reranking of the cosine pool could ever surface it). Measured for resolved queries only.
type Row = { q: string; id: number; status: string; concepts: string; grounded: string; cls: Cls; rank: number };

function loadCache(): Record<string, QueryPlan> {
  return existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, QueryPlan>) : {};
}

// Recall@k over the RESOLVED misses (a punt has no concept to ground, so it's excluded — it's the
// extractor's problem, not grounding's). `rank` is the accept-set's best cosine position in its bucket;
// recall@k = the share of misses where the gold sits within the top k, i.e. reachable by reranking depth k.
// This is the CEILING a doc-view (embedding enrichment) could win: enrichment only reorders the cosine
// pool, so a gold already buried past practical rerank depth — or unreachable (wrong bucket) — is out of
// reach no matter the doc-view. recall@∞ (any finite rank) minus recall@(small k) = the doc-view headroom.
const KS = [1, 3, 5, 8, 16, 32, 64, 128];
function recallReport(rows: Row[]): string {
  const misses = rows.filter((r) => !PASS_CLS.includes(r.cls) && r.status === "resolved");
  const n = misses.length || 1;
  const reachable = misses.filter((r) => Number.isFinite(r.rank)).length;
  const at = (k: number) => misses.filter((r) => r.rank <= k).length;
  const line = KS.map((k) => `@${k} ${at(k)} (${((100 * at(k)) / n).toFixed(0)}%)`).join("  ");
  return [
    `Recall ceiling over ${misses.length} resolved misses (gold's best cosine rank in its bucket):`,
    `  ${line}`,
    `  reachable at all (finite rank): ${reachable}/${misses.length} (${((100 * reachable) / n).toFixed(0)}%)  ·  unreachable (wrong bucket): ${misses.length - reachable}`,
    `  -> doc-view headroom = recall@∞ − recall@8 = ${reachable} − ${at(8)} = ${reachable - at(8)} misses are reachable but ranked below the live pool cut`,
  ].join("\n");
}

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const items = (JSON.parse(readFileSync(DATA, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const cache = loadCache();
  let cacheDirty = false;
  const rows: Row[] = [];

  for (const { id, q } of items) {
    const target = cat.byId.get(id);
    if (!target) continue;
    const accept = acceptSet(target);
    let status = "resolved";
    const concepts: string[] = [];
    const grounded: string[] = [];
    let cls: Cls = "fail";
    let bestRank = Infinity; // best accept-set cosine rank across selectors (the recall-ceiling read)
    const rank = (c: Cls) => PASS_CLS.indexOf(c); // clean(0) > twin(1) > narrowed(2) > fail(-1); keep the best
    try {
      let plan = cache[q];
      if (!plan) {
        plan = await extract(q); // only uncached queries hit the LLM
        cache[q] = plan;
        cacheDirty = true;
      }
      status = plan.status;
      if (plan.status === "resolved") {
        const level = plan.event_scope.level;
        for (const sel of plan.selectors) {
          concepts.push(`${sel.subject.kind}:"${sel.market_concept}"${sel.line ? `/${sel.line.kind}` : ""}`);
          const g = await groundMarket(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level, period: sel.period });
          grounded.push(`${g.method}/${g.tier ?? "—"}→${nm(g.ids)}`);
          // recall ceiling: where does the accept-set sit in the raw cosine pool this selector would search?
          const pool = await candidatePool(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level });
          const at = pool.findIndex((c) => accept.has(c.id));
          if (at >= 0) bestRank = Math.min(bestRank, at + 1);
          const containsGold = [...accept].some((a) => idsContainGold(g.ids, a));
          if (!containsGold) continue;
          // gold present: clean/twin if confident|variants, else narrowed (ambiguous/shortlist)
          const here: Cls = isClean(g.tier) ? (idsContainGold(g.ids, id) ? "clean" : "twin") : "narrowed";
          if (cls === "fail" || (rank(here) >= 0 && rank(here) < rank(cls))) cls = here;
        }
      }
    } catch (e) {
      status = `error: ${(e as Error).message.slice(0, 60)}`;
    }
    rows.push({ q, id, status, concepts: concepts.join("  ·  "), grounded: grounded.join("  ·  ") || "—", cls, rank: bestRank });
    process.stderr.write(cls === "fail" ? "x" : ".");
  }
  process.stderr.write("\n");
  if (cacheDirty) writeFileSync(CACHE, JSON.stringify(cache, null, 1));

  const tally = (c: Cls) => rows.filter((r) => r.cls === c).length;
  const passes = rows.filter((r) => PASS_CLS.includes(r.cls)).length;
  const head =
    `Extractor→ground true-distribution probe: ${passes}/${rows.length} pass (${((100 * passes) / rows.length).toFixed(1)}%) ` +
    `[clean ${tally("clean")} + twin ${tally("twin")} + narrowed ${tally("narrowed")}]`;
  console.log(`\n${head}\n(comparison: direct-paraphrase batch = 14/36 = 38.9% (same scoring) — same markets, grounder fed a hand-authored paraphrase instead of the extractor's market_concept)\n`);
  console.log(recallReport(rows) + "\n");
  for (const r of rows) {
    console.log(`${PASS_CLS.includes(r.cls) ? "✓" : "✗"} [${r.cls}] "${r.q}"  → ${r.id} "${cat.byId.get(r.id)!.name}"`);
    console.log(`    market_concept: ${r.status === "resolved" ? r.concepts : `[${r.status}]`}`);
    console.log(`    grounded:       ${r.grounded}`);
  }
  writeLogSection(rows, head, cat);
}

// Write the probe results into tier_1_automation.md, between sentinels so the no-LLM catalog sweep preserves
// them. Logs the market_concept for EVERY query, with the failing ones listed first (per request).
function writeLogSection(rows: Row[], head: string, cat: ReturnType<typeof loadCatalog>): void {
  const fails = rows.filter((r) => !PASS_CLS.includes(r.cls));
  const passes = rows.filter((r) => PASS_CLS.includes(r.cls));
  const L: string[] = [];
  L.push("## Extractor → Ground Probe (true distribution)");
  L.push("");
  L.push("> Generated by `scripts/extractor-ground-probe.ts`. Realistic user queries run through the REAL");
  L.push("> extractor (Haiku), then the emitted `market_concept` grounded — the production pipeline. Each query");
  L.push("> targets a known catalog id (by-construction label); graded with an auto accept-set (target + twins).");
  L.push("> **Pass** = gold present in the returned set, incl. a `narrowed` ambiguous/shortlist clarify set.");
  L.push("");
  L.push("```");
  L.push(head);
  L.push("");
  L.push(recallReport(rows));
  L.push("```");
  L.push("");
  const cell = (s: string) => s.replace(/\|/g, "\\|"); // escape the multi-id separator so it doesn't split the table
  const rankCell = (r: Row) => (r.status !== "resolved" ? "—" : Number.isFinite(r.rank) ? String(r.rank) : "∞");
  const row = (r: Row) =>
    `| ${PASS_CLS.includes(r.cls) ? "✓" : "✗"} ${r.cls} | ${rankCell(r)} | ${cell(r.q)} | \`${cell(r.status === "resolved" ? r.concepts : "[" + r.status + "]")}\` | ${cell(r.grounded)} |`;
  const hdr = "| result | gold rank | query | extractor market_concept | grounding response |\n| --- | --- | --- | --- | --- |";
  L.push(`### Failing queries (${fails.length}) — with extractor market_concept (gold rank = accept-set's best cosine rank in bucket; ∞ = wrong bucket)`);
  L.push("");
  L.push(hdr);
  for (const r of fails) L.push(row(r));
  L.push("");
  L.push(`### Passing queries (${passes.length})`);
  L.push("");
  L.push(hdr);
  for (const r of passes) L.push(row(r));
  L.push("");
  const block = `<!-- PROBE:START -->\n${L.join("\n")}\n<!-- PROBE:END -->`;
  const prev = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
  const re = /<!-- PROBE:START -->[\s\S]*?<!-- PROBE:END -->/;
  const next = re.test(prev) ? prev.replace(re, block) : `${prev.trimEnd()}\n\n${block}\n`;
  writeFileSync(LOG, next);
  console.log(`\nprobe section → ${LOG}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
