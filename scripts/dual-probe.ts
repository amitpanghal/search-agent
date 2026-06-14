// Dual-stage probe: run a fixed query list through BOTH stages and print each query's extractor plan and the
// per-selector grounding. Extractor plans are cached to scripts/.dual-probe.json so a re-run never re-hits
// Haiku (only NEW queries call the model); the Voyage query embeds run live through groundMarket.
//   npx tsx scripts/dual-probe.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";
import { groundPlan } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";
import type { QueryPlan } from "../src/resolver/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "scripts", ".dual-probe.json");

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
  // failing grounding rows from batches 1+2 — re-ground against the now-full 2503-market index
  "Edin Dzeko to score anytime Bosnia World Cup tonight",
  "Joao Felix to score and Portugal to win World Cup late kickoff",
  "Uruguay vs Croatia World Cup draw at half time",
  "World Cup tonight first team to score odds under 2.0",
  "Yunus Akgün anytime assist Turkey this weekend",
  "Mexico to win both halves World Cup odds above 6.0",
  "Viktor Gyökeres first goalscorer or last goalscorer tonight",
];

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const nm = (id: number) => cat.byId.get(id)?.name ?? `?${id}`;
  const cache: Record<string, QueryPlan> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

  for (const q of QUERIES) {
    let plan = cache[q];
    if (!plan) {
      plan = await extract(q);
      cache[q] = plan;
      writeFileSync(CACHE, JSON.stringify(cache, null, 1) + "\n"); // persist incrementally
    }

    console.log("\n" + "=".repeat(100));
    console.log(`QUERY: ${q}`);
    console.log("-- EXTRACTOR --");
    console.log(JSON.stringify(plan, null, 1));

    const legs = (plan.selectors ?? []).map((s) => ({
      concept: s.market_concept,
      subjectKind: s.subject?.kind,
      line: s.line,
      period: s.period,
      side: s.subject?.kind === "either_match_team" ? s.subject.side : undefined,
    }));
    const { perSelector, combos } = await groundPlan(legs as any, plan.event_scope?.level);

    console.log("-- GROUNDING --");
    legs.forEach((leg, i) => {
      const g = perSelector[i];
      const tag = [leg.subjectKind, leg.line ? `line:${leg.line.kind}` : "", leg.period && leg.period !== "full" ? leg.period : ""].filter(Boolean).join(", ");
      if (!g) {
        console.log(`  «${leg.concept}» [${tag}]  ->  none`);
      } else {
        console.log(`  «${leg.concept}» [${tag}]  ->  ${g.method}/${g.tier}  ${JSON.stringify(g.ids)} [${g.ids.map(nm).join(" | ")}]`);
      }
    });
    if (combos.length) {
      for (const c of combos) console.log(`  +COMBO  ${c.method}/${c.tier}  ${JSON.stringify(c.ids)} [${c.ids.map(nm).join(" | ")}]`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
