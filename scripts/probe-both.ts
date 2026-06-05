// Throwaway: probe BOTH stages (extractor -> grounding) end-to-end for a batch of queries.
// Runs the real extract() then feeds each selector's market_concept + subject.kind + line into
// the real groundMarket() (same wiring the --query and --ground CLI flags use, but chained so
// grounding sees the extractor's actual output). Prints a per-query report. No grading.
//   npx tsx scripts/probe-both.ts

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";
import { groundMarket } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!key || process.env[key]) continue;
    process.env[key] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

const DEFAULT_QUERIES: string[] = [
  "Find me the Portugal vs Brazil quarterfinal with Bruno Fernandes corner markets, Vitinha shots on target over 0.5, and team total goals over 1.5",
  "Show the Netherlands group opener with Van Dijk aerial duels won markets, clean sheet odds, and Gakpo anytime scorer",
  "Pull up Argentina's semi if they reach it with Messi assist markets, Lautaro shots over 2.5, and match result + both teams to score",
  "Give me the final whoever's in it with first goalscorer odds, total cards over 4.5, and goal in stoppage time specials",
  "Show me Golden Boot markets with players priced between 5.0 and 15.0",
  "Find top assist tournament markets filtered to midfielders only",
  "Pull up outright winner odds with European nations under 6.0",
  "Give me Player of the Tournament markets for anyone under 23",
  "Do we have most cards in tournament markets with defenders priced above 8.0",
];

// Each non-flag argv entry is treated as one query; falls back to the curated list above.
const cliQueries = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const QUERIES: string[] = cliQueries.length ? cliQueries : DEFAULT_QUERIES;

function lineStr(line: any): string {
  if (!line) return "—";
  if (line.kind === "numeric") return `numeric ${line.direction} ${line.value}`;
  if (line.kind === "binary") return `binary ${line.direction}`;
  if (line.kind === "selection") return `selection "${line.value}"`;
  return JSON.stringify(line);
}

function subjStr(s: any): string {
  return s.name ? `${s.kind}:${s.name}` : s.kind;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();

  for (const [i, q] of QUERIES.entries()) {
    console.log(`\n${"=".repeat(96)}`);
    console.log(`Q${i + 1}. ${q}`);
    console.log("=".repeat(96));

    let plan: any;
    try {
      plan = await extract(q);
    } catch (e) {
      console.log(`  EXTRACT ERROR: ${(e as Error).message}`);
      continue;
    }

    console.log(`status: ${plan.status}`);
    if (plan.status !== "resolved") {
      console.log(JSON.stringify(plan, null, 2));
      continue;
    }

    const es = plan.event_scope;
    const stage = es.stage ? `stage=${JSON.stringify(es.stage)}` : "";
    console.log(
      `scope: sport=${plan.sport} level=${es.level} comp=${es.competition ?? "null"} ` +
        `teams=[${es.teams.join(", ")}] players=[${es.players.map((p: any) => p.name).join(", ")}] ${stage}`,
    );
    console.log(`selectors: ${plan.selectors.length}`);

    for (const [j, sel] of plan.selectors.entries()) {
      const extras = [
        sel.odds ? `odds=${JSON.stringify(sel.odds)}` : "",
        sel.attrFilter ? `attr=${JSON.stringify(sel.attrFilter)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `\n  [${j + 1}] subject=${subjStr(sel.subject)}  concept="${sel.market_concept}"  line=${lineStr(sel.line)}  ${extras}`,
      );

      const r = await groundMarket(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line });
      if (!r.ids.length) {
        console.log(`      GROUND -> none (${r.method})`);
      } else {
        const names = r.ids.map((id) => cat.byId.get(id)?.name ?? "?");
        const score = r.score != null ? `, score ${r.score.toFixed(3)}` : "";
        console.log(`      GROUND -> ${JSON.stringify(r.ids)} [${names.join(" | ")}] (${r.method}/${r.tier ?? "?"}${score})`);
      }
      if (r.candidates?.length) {
        const top = r.candidates.slice(0, 5).map((c) => `${c.score.toFixed(3)} ${c.id} ${c.name}`);
        console.log(`      cand: ${top.join("  ·  ")}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
