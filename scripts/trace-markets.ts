// trace-markets — show what the market-resolver LLM picked per leg. Replicates resolveQuery's per-leg loop
// (extract -> ground -> entities -> recall -> scopeMenu -> filterBySubject -> resolveMarkets) and logs, for each
// leg: the menu sent to the LLM and the market it picked (criterion + variant + tier + reason).
//   tsx scripts/trace-markets.ts
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "../src/resolver/extract";
import { groundScope, type EntityResolution, type ResolvedLegScope } from "../src/resolver/ground-scope";
import { resolveEntities } from "../src/resolver/resolve-entities";
import { planRecall } from "../src/resolver/plan-recall";
import { recall, scopeMenu } from "../src/resolver/recall";
import { filterBySubject } from "../src/resolver/filter";
import { resolveMarkets } from "../src/resolver/resolve-market";
import { fold } from "../src/resolver/lexical";
import type { Subject } from "../src/resolver/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
for (const line of existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
}

const filterSubject = (s: Subject): string | undefined => (s.kind === "team" || s.kind === "player" ? s.name : undefined);
const confidentId = (r?: EntityResolution | null): number | undefined => (r && r.tier === "confident" ? r.candidates[0]?.id : undefined);
function subjectParticipantId(leg: ResolvedLegScope, s: Subject): number | undefined {
  if (s.kind === "player") return confidentId(leg.subjectPlayer);
  if (s.kind === "team") return confidentId(leg.teams.find((e) => fold(e.text) === fold(s.name)) ?? leg.teams.find((e) => fold(e.candidates[0]?.name ?? "") === fold(s.name)));
  return undefined;
}

const QUERIES = [
  "Mbappé most goals in WC26 and to score in his next game",
  "Kane 1st goalscorer in his next game and golden ball in WC26",
];

async function main() {
  for (const q of QUERIES) {
    console.log("\n======================================================");
    console.log("QUERY:", q);
    const plan = await extract(q);
    const settled = await resolveEntities(q, groundScope(plan));
    const r = await recall(planRecall(settled, plan));
    console.log(`recall: endpoint=${r.endpoint}, ${r.data.events.length} events, ${r.data.betOffers.length} offers, broad menu=${r.menu.length}`);
    for (let i = 0; i < plan.selectors.length; i++) {
      const sel = plan.selectors[i]!;
      const leg = settled.legs[i]!;
      const scoped = scopeMenu(r.data, leg);
      const subjId = subjectParticipantId(leg, sel.subject);
      const fr = filterBySubject(scoped.offers, scoped.events, filterSubject(sel.subject), subjId);
      const labels = fr.menu.map((m) => m.label);
      console.log(`\n  LEG ${i}: "${sel.market_concept}"  [level=${leg.level}, subject=${JSON.stringify(sel.subject)}, subjId=${subjId ?? "-"}]`);
      console.log(`    scopeMenu -> ${scoped.events.length} events; subject menu = ${labels.length} markets`);
      console.log(`    menu sent: ${labels.slice(0, 30).join(" | ") || "(EMPTY)"}${labels.length > 30 ? ` …(+${labels.length - 30})` : ""}`);
      const [pick] = await resolveMarkets([sel.market_concept], fr.menu);
      const label = fr.menu.find((m) => m.criterionId === pick!.criterionId && m.variant === (pick!.variant ?? ""))?.label;
      console.log(`    >> LLM PICK: match=${pick!.match}  criterionId=${pick!.criterionId ?? "-"}  variant=${JSON.stringify(pick!.variant ?? "")}  -> ${label ?? "(no market)"}`);
      if (pick!.reason) console.log(`    >> reason: ${pick!.reason}`);
    }
  }
}
main();
