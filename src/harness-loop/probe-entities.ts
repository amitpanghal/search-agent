// One-shot probe: extract + groundScope + resolveEntities only — prints settled clarifications
// and per-leg subjectPlayer resolution. Use to diagnose entity-gate failures without crashing at recall.
// Usage: npx tsx --env-file=.env src/harness-loop/probe-entities.ts "<query>"
import { extract } from "../resolver/extract";
import { groundScope } from "../resolver/ground-scope";
import { resolveEntities } from "../resolver/resolve-entities";
import { planRecall } from "../resolver/plan-recall";

const query = process.argv.slice(2).join(" ") || "Hernández to score or assist";
console.error(`[probe-entities] query: ${query}\n`);

const plan = await extract(query);
console.error("[extract plan]", JSON.stringify(plan, null, 2));

const scope = groundScope(plan);
console.error("\n[groundScope] per-leg subjectPlayer tiers:");
for (const [i, leg] of scope.legs.entries()) {
  console.error(`  leg ${i}: subjectPlayer=${JSON.stringify(leg.subjectPlayer?.tier)} candidates=${JSON.stringify(leg.subjectPlayer?.candidates.map((c) => c.name))}`);
}

const settled = await resolveEntities(query, scope);
console.error("\n[resolveEntities] clarifications:", JSON.stringify(settled.clarifications, null, 2));
console.error("\n[resolveEntities] per-leg subjectPlayer tiers after settling:");
for (const [i, leg] of settled.legs.entries()) {
  console.error(`  leg ${i}: subjectPlayer=${JSON.stringify(leg.subjectPlayer?.tier)} candidates=${JSON.stringify(leg.subjectPlayer?.candidates.map((c) => c.name))}`);
}

const recallInput = planRecall(settled, plan);
console.error("\n[planRecall] input:", JSON.stringify({ participantIds: recallInput.participantIds, groupIds: recallInput.groupIds, eventIds: recallInput.eventIds }));
