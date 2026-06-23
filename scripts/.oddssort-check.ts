import { extract } from "../src/resolver/extract";
async function main() {
  for (const q of ["which match has the shortest draw odds", "which match has the highest draw odds"]) {
    const p = await extract(q);
    const s = p.selectors[0]!;
    console.log("Q:", q);
    console.log("  market_concept:", JSON.stringify(s.market_concept), "| odds_sort:", s.odds_sort, "| bo_types:", JSON.stringify(s.bo_types), "| line:", JSON.stringify(s.line), "| subject:", JSON.stringify(s.subject));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
