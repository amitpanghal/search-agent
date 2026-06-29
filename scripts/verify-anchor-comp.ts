// verify-anchor-comp — deterministic check of the player-anchored competition grounding (Option B). No network,
// no LLM. Football has two same-named Champions League nodes — a men's group and a "Champions League (W)" group —
// so it exercises the gendered-node bug today (tennis Wimbledon is the same shape, deferred until that index is
// built). Asserts that groundCompetition resolves the bare "Champions League" against the ANCHOR's own leagues:
//   - no anchor            -> men's CL          (today's global behaviour, unchanged)
//   - women-player anchor  -> Champions League (W)   (the fix)
//   - men-player anchor    -> men's CL
//   - off-competition anchor (player not in any CL) -> tier none (don't hard-zero; compId stays null downstream)
//   tsx scripts/verify-anchor-comp.ts
import { groundCompetition, groundPlayer, compUnion } from "../src/resolver/ground-scope";
import { loadScopeCatalog } from "../src/resolver/scope-catalog";

const cat = loadScopeCatalog("football");

// Resolve the two CL nodes BY NAME so the test carries no hard-coded ids (Kambi ids are stable, but names are
// the contract under test). Fail loudly if the index no longer has both.
const groupId = (name: string): number => {
  const g = cat.groups.find((x) => x.name === name);
  if (!g) throw new Error(`fixture group "${name}" not found in football scope-index — update the test`);
  return g.id;
};
const MEN = groupId("Champions League");
const WOM = groupId("Champions League (W)");
// any group that is NOT a Champions League node — the off-competition anchor.
const OTHER = cat.groups.find((g) => !/champions league/i.test(g.name))!.id;

// allow-set built exactly as the pipeline builds it: ground the player by name, union its candidates' leagues.
const anchorOf = (player: string): Set<number> => compUnion([groundPlayer(player, { compId: null, teamIds: [] }, cat)]);
const topId = (r: ReturnType<typeof groundCompetition>): number | null => r.candidates[0]?.id ?? null;

let pass = 0, fail = 0;
function check(desc: string, got: unknown, expect: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${desc}  -> ${JSON.stringify(got)}${ok ? "" : ` (expect ${JSON.stringify(expect)})`}`);
  ok ? pass++ : fail++;
}

console.log(`fixtures: men CL=${MEN}, women CL(W)=${WOM}, other=${OTHER}`);

// Sanity: the anchors actually carry the expected league (else the real assertions below are meaningless).
const renard = anchorOf("Wendie Renard");
const buchanan = anchorOf("Kadeisha Buchanan");
console.log("\nanchor sanity:");
check("Wendie Renard's leagues include CL(W)", renard.has(WOM), true);
check("Wendie Renard's leagues exclude men's CL", renard.has(MEN), false);

console.log("\ngroundCompetition(\"Champions League\", region=null, allow):");
check("no anchor -> men's CL (global, unchanged)", topId(groundCompetition("Champions League", null, cat, null)), MEN);
check("women anchor (Renard) -> Champions League (W)", topId(groundCompetition("Champions League", null, cat, renard)), WOM);
check("women anchor (Renard) -> confident tier", groundCompetition("Champions League", null, cat, renard).tier, "confident");
check("women anchor (Buchanan) -> Champions League (W)", topId(groundCompetition("Champions League", null, cat, buchanan)), WOM);
check("men anchor (Set[MEN]) -> men's CL", topId(groundCompetition("Champions League", null, cat, new Set([MEN]))), MEN);
check("off-competition anchor (Set[OTHER]) -> tier none", groundCompetition("Champions League", null, cat, new Set([OTHER])).tier, "none");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
