// Catalog support — the catalog is the truth of what we support.
//
// A gold row naming an entity no catalog carries cannot be served however perfectly it is extracted:
// "Michael Huntley +2.5 legs" is darts, the darts catalog holds no Michael Huntley, so a flawless
// sport=darts + player="Michael Huntley" plan still fetches nothing. Grading that row measures CATALOG
// COVERAGE, not extraction, and no prompt rewrite can ever win it back. Those rows are reported
// separately and excluded from the extraction score.
//
// UNSERVABLE = not one anchor grounds, in any of the row's gold sports. The anchor set mirrors
// check-complete.ts (team / player / competition / region) because that is what the pipeline fetches on:
// a row with one missing anchor and one present still fetches, so it stays graded.
//
// Standalone:  npx tsx src/eval/catalog-support.ts        # list the unservable rows

import { loadScopeCatalog } from "../resolver/scope-catalog";
import { groundTeam, groundPlayer, groundCompetition, groundRegion } from "../resolver/ground-scope";
import { slugify, getSport, builtSports } from "../resolver/sports";
import { loadGold, type GoldRecord } from "./gold-record";

type Anchor = { text: string; competitor: boolean };

// Every anchor the gold row names, with the pair of grounders that could carry it. Competitor and
// circumstance rather than the four types: an individual sport mirrors players into the team index, and
// "Italy" is one id as both branch and group, so a type split here would invent misses.
function anchorsOf(row: GoldRecord): Anchor[] {
  const out = new Map<string, Anchor>();
  const add = (cell: { accept?: string[] } | null | undefined, competitor: boolean) => {
    const text = cell?.accept?.[0];
    if (text) out.set(`${competitor}:${text.toLowerCase()}`, { text, competitor });
  };
  for (const sel of row.expect.selectors) {
    if (sel.subject.kind === "team" || sel.subject.kind === "player") add(sel.subject.name, true);
    for (const t of sel.scope.teams) add(t, true);
    for (const p of sel.scope.players) add(p.name, true);
    add(sel.scope.competition, false);
    add(sel.scope.region, false);
  }
  return [...out.values()];
}

// A `shortlist` hit alone does not prove coverage: it is a fuzzy substring match, and a name the catalogs do
// NOT hold matches almost all of them. Across every gold anchor the split is bimodal — real entities named by
// nickname ("Lions", "Saka", "Valkyries") match 1-8 of the 37 catalogs, while "Michael Huntley" (the header's
// own missing-darts-player example) matches 25 and "Adam Staniczek" 23. So a shortlist-ONLY anchor that
// matches more than a third of the catalogs is noise. Without this, those two rows graded as servable and the
// gate missed the very case it exists for.
const tiersFor = (a: Anchor, sport: string) =>
  (a.competitor ? [groundTeam, groundPlayer] : [groundCompetition, groundRegion])
    .map((g) => g(a.text, loadScopeCatalog(sport)).tier);

const isFuzzy = (a: Anchor): boolean =>
  builtSports().filter((s) => tiersFor(a, s).some((t) => t !== "none")).length > builtSports().length / 3;

const grounds = (a: Anchor, sport: string): boolean => {
  // Event-centric sports (F1) ground ANY competition text to the sport root — a named GP is an event, not a
  // group, so it never appears in the group index and is served anyway (ground-scope.ts eventCentricComp).
  if (!a.competitor && getSport(sport)?.eventCentric) return true;
  const tiers = tiersFor(a, sport);
  if (tiers.some((t) => t !== "none" && t !== "shortlist")) return true; // a real match, at any strength
  return tiers.includes("shortlist") && !isFuzzy(a);
};

export type Support = { servable: boolean; anchors: number; missing: string[] };

export function catalogSupport(row: GoldRecord): Support {
  const anchors = anchorsOf(row);
  const sports = (Array.isArray(row.expect.sport) ? row.expect.sport : [row.expect.sport]).map(slugify);
  const missing = anchors.filter((a) => !sports.some((s) => grounds(a, s))).map((a) => a.text);
  // No anchor at all is a different row (a marketless "odds tomorrow"), graded as always — checkComplete owns it.
  return { servable: !anchors.length || missing.length < anchors.length, anchors: anchors.length, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gold = loadGold();
  const dead = gold.filter((r) => !catalogSupport(r).servable);
  console.log(`${dead.length} of ${gold.length} gold rows name NO anchor our catalogs carry:\n`);
  for (const r of dead) {
    const sports = [Array.isArray(r.expect.sport) ? r.expect.sport.join("|") : r.expect.sport];
    console.log(`  ${r.id.padEnd(6)} ${sports[0]!.padEnd(18)} "${r.query}"`);
    console.log(`         missing: ${catalogSupport(r).missing.join(", ")}`);
  }
}
