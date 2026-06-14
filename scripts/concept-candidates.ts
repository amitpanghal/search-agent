// Candidate-pool dumper for the concept-repair probe (NO Anthropic call — only Voyage embeds, the grounding
// stage). For each selector of the cached batch-2 plans, emits the extractor's market_concept + the grounder's
// TOP-10 in-bucket cosine candidates, so a cold Haiku subagent can judge "is the right market here?" and, if
// not, re-express the concept. An optional overrides file (scripts/.concept-overrides.json: {"q|i": "new
// concept"}) lets round 2 re-ground the subagent's rewrites with the SAME pool view. Writes scripts/.concept-
// candidates.json and prints a readable digest.
//   npx tsx scripts/concept-candidates.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidatePool, groundMarket, type GroundOpts } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "scripts", ".dual-probe.json");
const OVERRIDES = join(ROOT, "scripts", ".concept-overrides.json");
const OUT = join(ROOT, "scripts", ".concept-candidates.json");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

const QUERIES = [
  // failing grounding rows (re-probed against the full 2503-market index)
  "Edin Dzeko to score anytime Bosnia World Cup tonight",
  "Joao Felix to score and Portugal to win World Cup late kickoff",
  "Uruguay vs Croatia World Cup draw at half time",
  "World Cup tonight first team to score odds under 2.0",
  "Yunus Akgün anytime assist Turkey this weekend",
  "Mexico to win both halves World Cup odds above 6.0",
  "Viktor Gyökeres first goalscorer or last goalscorer tonight",
];

// mirror the grounder's period fold-in (withPeriod) so the candidate pool matches what the live grounder sees.
const withPeriod = (text: string, period?: string) => (period && period !== "full" ? `${text} ${period.replace(/_/g, " ")}` : text);

type Item = {
  q: string; i: number; concept: string;
  subjectKind?: string; line?: string; period?: string; level?: string;
  candidates: { id: number; name: string; score: number }[];
};

async function main(): Promise<void> {
  loadDotEnv();
  const cache = JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, QueryPlan>;
  const overrides: Record<string, string> = existsSync(OVERRIDES) ? JSON.parse(readFileSync(OVERRIDES, "utf8")) : {};

  const items: Item[] = [];
  for (const q of QUERIES) {
    const plan = cache[q];
    if (!plan) { console.error(`! no cached plan for: ${q}`); continue; }
    const level = plan.event_scope?.level;
    plan.selectors.forEach((sel, i) => {
      const concept = overrides[`${q}|${i}`] ?? sel.market_concept;
      const opts: GroundOpts = { subjectKind: sel.subject?.kind, level };
      items.push({ q, i, concept, subjectKind: sel.subject?.kind, line: sel.line?.kind, period: sel.period, level, candidates: [] });
    });
  }

  for (const it of items) {
    const pool = await candidatePool(withPeriod(it.concept, it.period), { subjectKind: it.subjectKind as any, level: it.level as any });
    it.candidates = pool.slice(0, 10).map((c) => ({ id: c.id, name: c.name, score: +c.score.toFixed(3) }));
  }

  writeFileSync(OUT, JSON.stringify(items, null, 1) + "\n");

  const cat = loadCatalog();
  const nm = (id: number) => cat.byId.get(id)?.name ?? `?${id}`;
  for (const it of items) {
    const tag = [it.subjectKind, it.line ? `line:${it.line}` : "", it.period && it.period !== "full" ? it.period : ""].filter(Boolean).join(", ");
    const plan = cache[it.q]!;
    const sel = plan.selectors[it.i]!;
    const g = await groundMarket(it.concept, { subjectKind: it.subjectKind as any, line: sel.line, level: it.level as any, period: sel.period });
    console.log(`\n[${it.q}]  sel#${it.i}  concept=«${it.concept}»  [${tag}]`);
    console.log(`   GROUNDS -> ${g.method}/${g.tier ?? "none"}  ${JSON.stringify(g.ids)} [${g.ids.map(nm).join(" | ")}]`);
    for (const c of it.candidates) console.log(`   ${c.score.toFixed(3)}  ${c.id}  ${c.name}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
