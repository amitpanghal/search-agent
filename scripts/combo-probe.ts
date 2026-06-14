// Combined-market assembly probe (Sprint 7) — fully OFFLINE (no LLM, no Voyage): the combo pass is pure token
// cover, so it runs straight off the cached extractor plans. Validates that the grounder's `assembleCombos`
// re-surfaces the ever-offered combined markets the extractor's "X and Y" split made unreachable, with no
// legacy-combo leakage and no spurious combos on unrelated multi-leg queries.
//   npx tsx scripts/combo-probe.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assembleCombos, comboCovers } from "../src/resolver/ground-market";
import { eligibleCombos } from "../src/resolver/combos";
import { loadCatalog } from "../src/resolver/catalog";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "football");
const j = (f: string) => JSON.parse(readFileSync(join(DATA, f), "utf8"));

type Plan = { selectors?: { market_concept: string }[] };

function main(): void {
  const cat = loadCatalog();
  const nm = (id: number) => cat.byId.get(id)?.name ?? `?${id}`;
  const eligible = eligibleCombos();
  const eligibleIds = new Set(eligible.map((c) => c.id));

  console.log(`ELIGIBLE COMBOS (combined catalog rows ∩ ever-offered): ${eligible.length}`);
  for (const c of eligible) console.log(`  ${c.id}  ${c.name}`);

  const queries = j("tier1-extractor-queries.json").queries as { id: number; q: string }[];
  const cache = j("tier1-extractor-cache.json") as Record<string, Plan>;

  const multiLeg = queries
    .map((x) => ({ ...x, plan: cache[x.q] }))
    .filter((x) => (x.plan?.selectors?.length ?? 0) >= 2);

  let leaks = 0;
  let fps = 0;

  console.log(`\nCOMBO-TARGET QUERIES (target is an eligible combo):`);
  for (const { id: target, q, plan } of multiLeg) {
    if (!eligibleIds.has(target)) continue;
    const legs = plan!.selectors!.map((s) => s.market_concept);
    const surfaced = assembleCombos(legs).flatMap((r) => r.ids);
    const covers = comboCovers(legs);
    const targetCombo = covers.find((c) => c.ids.includes(target));
    const bestSingle = Math.max(...legs.map((l) => comboCovers([l]).find((c) => c.ids.includes(target))?.cover ?? 0));
    const hit = surfaced.includes(target);
    console.log(
      `  [${hit ? "PASS" : "MISS"}] ${target} «${q}»  cover=${(targetCombo?.cover ?? 0).toFixed(2)}  bestSingleLeg=${bestSingle.toFixed(2)}  legs=${JSON.stringify(legs)}`,
    );
  }

  console.log(`\nFALSE-POSITIVE SCAN (multi-leg query surfaced a combo whose ids exclude its target):`);
  for (const { id: target, q, plan } of multiLeg) {
    const legs = plan!.selectors!.map((s) => s.market_concept);
    const surfaced = assembleCombos(legs);
    for (const r of surfaced) {
      if (r.ids.some((id) => !eligibleIds.has(id))) leaks++;
      if (!r.ids.includes(target)) {
        fps++;
        console.log(`  «${q}» (target ${target} ${nm(target)}) → combo ${JSON.stringify(r.ids.map(nm))}`);
      }
    }
  }
  if (fps === 0) console.log("  (none)");

  console.log(`\nmulti-leg queries scanned: ${multiLeg.length}`);
  console.log(`leaked (combo id outside the eligible set): ${leaks}`);
}

main();
