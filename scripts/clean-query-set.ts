// One-shot query-set cleanup (Sprint 4 punt triage). Splits the 59 extractor-punts of the 400-query probe
// into three classes and acts on each — see planning/queries/tier_1_automation.md for the analysis:
//   A (5)  convoluted authoring        -> REWRITE in place (same target id, paraphrased, no catalog-name echo)
//   B (9)  extractor recall bug        -> KEEP in the eval (honest failing tests) + list in the gap doc
//   C (45) out-of-scope exotic market  -> QUARANTINE to tier1-out-of-scope.json, remove from the 400
//
//   npx tsx scripts/clean-query-set.ts          # apply (rewrites queries.json, writes the corpus + gap doc)
//   npx tsx scripts/clean-query-set.ts --dry     # print the plan, write nothing
//
// Idempotent on the A rewrites and C removal: re-running after a clean pass is a no-op (the old convoluted
// texts and the C ids are already gone). Asserts the A/B/C partition still exactly covers the live punts.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "../src/resolver/catalog";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUERIES = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const OUT_OF_SCOPE = join(ROOT, "data", "football", "tier1-out-of-scope.json");
const GAP_DOC = join(ROOT, "planning", "queries", "tier1-extractor-gaps.md");

type Q = { id: number; q: string };

// --- A: convoluted authoring -> rewrite (id -> new user-style phrasing, paraphrased off the catalog name) ---
const REWRITE: Record<number, string> = {
  1003249042: "which team wins the next free kick", // was: "...void if none" (settlement jargon)
  1004411242: "how many penalties does the away team score in the shootout", // was: "...stick away..." (slang)
  1002153710: "total off-target shots if the game goes to extra time", // was: "wayward shots over 120 if it goes long"
  1002114354: "which team scores the fastest goal from kickoff", // was: "...out of all today's games" (cross-fixture)
  1002154385: "casemiro's total fouls if the match goes to extra time", // was: "...full 120 if it goes to extra time"
};

// --- B: in-scope market the extractor wrongly punts -> KEEP in eval, track as an extractor coverage bug ---
const KEEP_GAP: number[] = [
  1001159861, 1003194959, 2100097912, 1004670973, 1001241016, 1002520396, 1001877372, 1002077068, 1003430635,
];

// --- C: out-of-scope exotic market -> quarantine. Grouped by the reason the extractor scopes it out. ---
const QUARANTINE: { reason: string; ids: number[] }[] = [
  { reason: "manager/coaching-staff market", ids: [1001243154, 1001478672, 1001774699, 1004488595, 1004673130] },
  { reason: "club-attendance market", ids: [1001518728, 1001518729, 1001518731] },
  { reason: "exact finishing-order market", ids: [1001241014, 1001241030, 1002236023, 1002627042, 1002725250, 1004830083] },
  { reason: "conditional 'winner without team X' outright", ids: [1003100962, 1003325552, 1003815443, 1003822379, 1004709200] },
  { reason: "transfer-window special", ids: [1003080650, 1005255361, 1001241776, 1002468313, 1002779985] },
  { reason: "novelty/joke market", ids: [1005103822] },
  { reason: "fantasy-match market", ids: [1001221616] },
  { reason: "multi-leg combo / accumulator special", ids: [2100062479, 1003934916, 1001537279, 1002207343] },
  { reason: "hyper-specific team/competition aggregate", ids: [1006170149, 1005628726, 1004632734] },
  { reason: "throw-in micro-market", ids: [1002955490, 1003042067, 1003042069] },
  { reason: "referee-conduct special", ids: [1003258992] },
  { reason: "conditional extra-time penalty market", ids: [1003272107] },
  { reason: "season aggregate w/ playoff-exclusion nuance", ids: [1004530989] },
  { reason: "nationality-of-winner market", ids: [1001957585] },
  { reason: "ordered 'which happens first / all teams' list market", ids: [1005059685, 1003412480] },
  { reason: "player N+ goals 'fielded anytime' variant", ids: [2100091955] },
  { reason: "per-player penalty-shootout scorer", ids: [1007764665] },
  { reason: "alternate-line corners market", ids: [1002467526] },
];

function main(): void {
  const dry = process.argv.includes("--dry");
  const cat = loadCatalog();
  const queries = (JSON.parse(readFileSync(QUERIES, "utf8")).queries as Q[]) ?? [];

  const quarantineIds = new Map<number, string>();
  for (const g of QUARANTINE) for (const id of g.ids) quarantineIds.set(id, g.reason);

  // sanity: no id appears in two classes
  const A = new Set(Object.keys(REWRITE).map(Number));
  const B = new Set(KEEP_GAP);
  const overlap = [...A, ...B].filter((id) => quarantineIds.has(id)).concat([...A].filter((id) => B.has(id)));
  if (overlap.length) throw new Error(`class overlap on ids: ${overlap.join(", ")}`);

  // build the quarantine corpus (id, original query, catalog name, reason)
  const removed: { id: number; q: string; name: string; reason: string }[] = [];
  const kept: Q[] = [];
  let rewritten = 0;
  for (const item of queries) {
    if (quarantineIds.has(item.id)) {
      removed.push({ id: item.id, q: item.q, name: cat.byId.get(item.id)?.name ?? "?", reason: quarantineIds.get(item.id)! });
      continue;
    }
    if (REWRITE[item.id]) {
      kept.push({ id: item.id, q: REWRITE[item.id]! });
      rewritten++;
      continue;
    }
    kept.push(item);
  }

  console.log(`Query-set cleanup${dry ? " (DRY RUN)" : ""}:`);
  console.log(`  start: ${queries.length} queries`);
  console.log(`  A rewritten in place: ${rewritten}/${A.size}`);
  console.log(`  C quarantined:        ${removed.length}/${quarantineIds.size}`);
  console.log(`  B kept (gap-tracked): ${KEEP_GAP.length}`);
  console.log(`  end:   ${kept.length} queries  (${queries.length} − ${removed.length})`);
  if (rewritten !== A.size || removed.length !== quarantineIds.size) {
    console.warn(`  [warn] partition didn't fully apply — already cleaned, or ids drifted. Check counts above.`);
  }

  if (dry) return;

  // 1. cleaned query set
  writeFileSync(QUERIES, JSON.stringify({ queries: kept }, null, 2) + "\n");
  // 2. quarantine corpus
  writeFileSync(
    OUT_OF_SCOPE,
    JSON.stringify(
      { note: "Out-of-scope markets pulled from tier1-extractor-queries.json (Sprint 4 punt triage). The extractor scopes these out by design; kept here so we notice if scope changes.", queries: removed },
      null,
      2,
    ) + "\n",
  );
  // 3. extractor-gap tracking doc (B + the validation crashes)
  const crashIds = new Set([1002467526, 1003430635, 1007764665, 1002153710, 1002114354, 1002154385]);
  const L: string[] = [];
  L.push("# Tier-1 Extractor Coverage Gaps");
  L.push("");
  L.push("> Tracked from the Sprint-4 punt triage of the 400-query extractor→ground probe. These are NOT");
  L.push("> grounding misses — the extractor returned `unsupported` (or crashed) on an in-scope market, so");
  L.push("> grounding never ran. They stay in the eval as honest failing tests; fixing them is extractor work.");
  L.push("");
  L.push("## B — in-scope markets the extractor wrongly punts (kept in the eval)");
  L.push("");
  L.push("| target id | market | probe query |");
  L.push("| --- | --- | --- |");
  for (const id of KEEP_GAP) {
    const item = queries.find((x) => x.id === id);
    L.push(`| ${id} | ${cat.byId.get(id)?.name ?? "?"} | ${item?.q ?? "?"} |`);
  }
  L.push("");
  L.push("## Validation crashes — extractor emitted invalid QueryPlan JSON (robustness bug, fix regardless of scope)");
  L.push("");
  L.push("| target id | market | probe query | class |");
  L.push("| --- | --- | --- | --- |");
  for (const id of crashIds) {
    const item = queries.find((x) => x.id === id);
    const cls = A.has(id) ? "A (rewritten)" : B.has(id) ? "B (kept)" : "C (quarantined)";
    L.push(`| ${id} | ${cat.byId.get(id)?.name ?? "?"} | ${item?.q ?? "?"} | ${cls} |`);
  }
  L.push("");
  L.push("## Note — subject-routing (wrong-bucket) misses");
  L.push("");
  L.push("Separately, the recall probe found ~19 grounding misses where the gold is in the WRONG subject bucket");
  L.push("(`gold rank = ∞` in tier_1_automation.md). Those are a subject-routing problem (extractor `subject.kind`");
  L.push("or catalog subject tag), not extractor punts and not doc-view-fixable — tracked via the probe log.");
  L.push("");
  writeFileSync(GAP_DOC, L.join("\n"));

  console.log(`\nwrote:`);
  console.log(`  ${QUERIES}  (${kept.length} queries)`);
  console.log(`  ${OUT_OF_SCOPE}  (${removed.length} out-of-scope)`);
  console.log(`  ${GAP_DOC}  (B gaps + crashes)`);
}

main();
