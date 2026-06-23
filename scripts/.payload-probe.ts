// scratch: run steps 1-6 (extract -> groundScope -> resolveEntities -> planRecall -> recall -> filter)
// and dump the EXACT payload that resolveMarkets would receive, WITHOUT calling it. Only extract() may hit an LLM.
import { extract } from "../src/resolver/extract";
import { groundScope } from "../src/resolver/ground-scope";
import { resolveEntities, type DecideFn } from "../src/resolver/resolve-entities";
import { planRecall } from "../src/resolver/plan-recall";
import { recall } from "../src/resolver/recall";
import { filterBySubject } from "../src/resolver/filter";
import { boTypeIdSet } from "../src/resolver/bo-types";

const QUERY = "Stack France winning HT/FT with Mbappé scoring twice in next game";

// Guard: if entity disambiguation tries to call the model, refuse (only extract is allowed to).
const NO_LLM: DecideFn = () => {
  throw new Error("__ENTITY_LLM_NEEDED__");
};

const filterSubject = (s: any): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined;

function confId(r: any): string {
  if (!r) return "(none)";
  const top = r.candidates?.[0];
  return `${r.tier}${top ? ` -> #${top.id} ${top.name}` : ""}`;
}

async function main() {
  console.log("QUERY:", QUERY, "\n");

  // 1. extract (LLM)
  const plan = await extract(QUERY);
  console.log("=== 1. EXTRACT (plan) ===");
  console.log(JSON.stringify(plan, null, 2), "\n");

  // 2. groundScope
  const scope = groundScope(plan);

  // 3. resolveEntities (no-LLM guard)
  let settled;
  try {
    settled = await resolveEntities(QUERY, scope, NO_LLM);
  } catch (e: any) {
    if (e?.message === "__ENTITY_LLM_NEEDED__") {
      console.log("!! resolveEntities needed a Haiku disambiguation call (some entity was not confident). Stopping per no-LLM rule.");
      return;
    }
    throw e;
  }
  const u = settled.units[0]!;
  console.log("=== 2-3. GROUNDED + SETTLED ENTITIES (no LLM needed) ===");
  console.log("competition:", confId(settled.competition));
  console.log("teams:", u.teams.map(confId));
  console.log("players:", u.players.map(confId));
  console.log("subjectPlayers:", u.subjectPlayers.map(confId));
  console.log("clarifications:", settled.clarifications, "\n");

  // 4. planRecall
  const ri = planRecall(settled);
  console.log("=== 4. PLAN RECALL (fetch input) ===");
  console.log(JSON.stringify(ri, null, 2), "\n");

  // 5. recall (network, no LLM)
  const r = await recall(ri);
  console.log("=== 5. RECALL (live fetch) ===");
  console.log("endpoint:", r.endpoint, "| events:", r.data.events.length, "| betOffers:", r.data.betOffers.length, "| truncated:", r.truncated);
  console.log("events:", r.data.events.map((e) => `#${e.id} ${e.name}`), "\n");

  // 6. FILTER + group exactly like resolve.ts, then dump the resolveMarkets payload per group.
  const EVENT_KEY = " event";
  const groups = new Map<string, number[]>();
  u.selectors.forEach((sel, i) => {
    const key = filterSubject(sel.subject) ?? EVENT_KEY;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
  });

  console.log("=== 6. FILTER -> PAYLOAD TO resolveMarkets (one block per group) ===\n");
  for (const [key, idxs] of groups) {
    const subj = filterSubject(u.selectors[idxs[0]!]!.subject);
    // mirror resolve.ts: union the group's legs' bo_types -> ids, pass as keepTypes (client-side prune).
    const keepTypes = boTypeIdSet(idxs.flatMap((i) => (u.selectors[i]!.bo_types as string[] | undefined) ?? []));
    const frNoPrune = filterBySubject(r.data.betOffers, r.data.events, subj);
    const fr = filterBySubject(r.data.betOffers, r.data.events, subj, keepTypes);
    const phrases = idxs.map((i) => u.selectors[i]!.market_concept);

    console.log(`----- GROUP key=${JSON.stringify(key)} (filterSubject=${JSON.stringify(subj ?? null)}) -----`);
    console.log(`bo_types (union): ${JSON.stringify([...keepTypes])}`);
    console.log(`menu items: subject-only ${frNoPrune.menu.length} -> +bo_types prune ${fr.menu.length}`);
    console.log(`offers after filter: ${fr.offers.length}  |  menu items: ${fr.menu.length}`);
    console.log("\nphrases[] (market_concepts sent):");
    console.log(JSON.stringify(phrases, null, 2));
    console.log("\nmenu[] (MenuItem[] sent — the FULL payload):");
    console.log(JSON.stringify(fr.menu, null, 2));

    // The literal user-message text resolveMarkets' callModel would build:
    const list = fr.menu.map((m, i) => `${i}: ${m.label}`).join("\n");
    const bets = phrases.map((p, i) => `${i}: ${p}`).join("\n");
    console.log("\n--- as the LLM would see it ---");
    console.log(`LIVE menu (ref: label):\n${list}\n\nBETS (leg: phrase):\n${bets}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
