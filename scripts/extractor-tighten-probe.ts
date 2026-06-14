// Extractor-tightening probe (1x, real Haiku): re-extract the queries the OLD prompt got wrong — the 53
// `unsupported` over-abstentions + the worst dropped/verbose concepts + the tennis case — under the NEW
// sport-agnostic prompt, then ground the new plans to measure how many now REACH the grounder (before: the
// abstentions reached it 0 times). Writes the new plans to scripts/.extractor-tighten.json (reuse, no re-run).
//   npx tsx scripts/extractor-tighten-probe.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";
import { groundPlan } from "../src/resolver/ground-market";

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

// Hand-picked verbose/dropped-qualifier cases (the Rule-B targets) + the tennis case (sport id).
const EXTRA = [
  "Djokovic vs Alcaraz total games over 22.5",
  "corners with a -1 start and the draw as a third option",
  "first half line spotting one team a goal, with the draw included",
  "which team gets more corners",
];

async function main(): Promise<void> {
  loadDotEnv();
  const oldCache = JSON.parse(readFileSync(join(DATA, "tier1-extractor-cache.json"), "utf8")) as Record<string, any>;
  const wasUnsupported = Object.keys(oldCache).filter((q) => oldCache[q]?.status === "unsupported");
  const queries = [...new Set([...wasUnsupported, ...EXTRA])];

  const out: Record<string, any> = {};
  let resolved = 0, reached = 0, grounded = 0;
  const fails: string[] = [];
  for (const q of queries) {
    let plan: any;
    try {
      plan = await extract(q);
    } catch (e) {
      fails.push(`${q}: ${(e as Error).message}`);
      continue;
    }
    out[q] = plan;
    if (plan.status === "resolved") resolved++;
    const legs = (plan.selectors ?? []).map((s: any) => ({ concept: s.market_concept, subjectKind: s.subject?.kind, line: s.line, period: s.period }));
    const hasMarket = legs.some((l: any) => l.concept && l.concept !== "main");
    if (hasMarket) reached++; // a real (non-`main`) market concept → the grounder gets something to resolve
    const { perSelector } = await groundPlan(legs, plan.event_scope?.level);
    if (perSelector.some((g) => g)) grounded++; // at least one selector grounded to a real catalog market
  }
  writeFileSync(join(ROOT, "scripts", ".extractor-tighten.json"), JSON.stringify(out, null, 1));

  console.log(`Re-extracted ${queries.length} formerly-broken queries (${wasUnsupported.length} were 'unsupported', +${EXTRA.length} concept/sport cases)\n`);
  console.log(`  now resolved:                ${resolved}/${queries.length}   (before: the ${wasUnsupported.length} unsupported reached the grounder 0 times)`);
  console.log(`  reach the grounder (a real market concept): ${reached}/${queries.length}`);
  console.log(`  of those, ≥1 selector grounds to a catalog market: ${grounded}/${queries.length}`);
  if (fails.length) console.log(`  extraction errors: ${fails.length}\n    ${fails.join("\n    ")}`);

  console.log(`\nSpot-checks (sport + concept):`);
  for (const q of EXTRA) {
    const p = out[q];
    if (!p) continue;
    const concepts = (p.selectors ?? []).map((s: any) => s.market_concept);
    console.log(`  «${q}»\n     → status=${p.status} sport=${p.sport} concepts=${JSON.stringify(concepts)}`);
  }
  console.log(`\nSample of former abstentions now resolved:`);
  for (const q of wasUnsupported.slice(0, 10)) {
    const p = out[q];
    if (!p) continue;
    const concepts = (p.selectors ?? []).map((s: any) => s.market_concept);
    console.log(`  [${p.sport ?? p.status}] «${q}» → ${JSON.stringify(concepts)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
