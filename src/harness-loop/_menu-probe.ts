import { extract } from "../resolver/extract";
import { groundScope } from "../resolver/ground-scope";
import { resolveEntities } from "../resolver/resolve-entities";
import { planRecall } from "../resolver/plan-recall";
import { recall, scopeMenu, marketLabelOf } from "../resolver/recall";
import { fold } from "../resolver/lexical";

const query = "I want to back Saudi Arabia to grind out a clean sheet against Cape Verde — give me Saudi Arabia to win to nil.";
const plan = await extract(query);
const scope = groundScope(plan);
const settled = await resolveEntities(query, scope);
const r = await recall(planRecall(settled, plan));
const scoped = scopeMenu(r.data, settled.legs[0]!);
const ev = scoped.events[0]!;
console.log(`fixture: home="${ev.homeName}" away="${ev.awayName}" name="${ev.name}"`);

const subj = fold("Saudi Arabia");
const opp = fold("Cape Verde");

// group label -> a sample betOffer for its type
const byLabel = new Map<string, any>();
for (const b of scoped.offers) {
  const l = marketLabelOf(b);
  if (!byLabel.has(l)) byLabel.set(l, b);
}
console.log(`\n=== labels NAMING THE OPPONENT (Cape Verde) ===`);
for (const [l, b] of byLabel) {
  const f = fold(l);
  if (f.includes(opp) && !f.includes(subj)) {
    console.log(`  [boType ${b.betOfferType?.id} ${b.betOfferType?.name}] ${l}`);
  }
}
console.log(`\n=== labels NAMING THE SUBJECT (Saudi Arabia) ===`);
for (const [l, b] of byLabel) {
  const f = fold(l);
  if (f.includes(subj) && !f.includes(opp)) {
    console.log(`  [boType ${b.betOfferType?.id} ${b.betOfferType?.name}] ${l}`);
  }
}
console.log(`\n=== labels naming BOTH teams ===`);
for (const [l, b] of byLabel) {
  const f = fold(l);
  if (f.includes(subj) && f.includes(opp)) console.log(`  [boType ${b.betOfferType?.id}] ${l}`);
}
