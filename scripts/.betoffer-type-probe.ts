// Scratch probe: for the WC26 group, fetch real bet-offers and, for EACH unique betOfferType,
// pull ONE example offer and show its outcome structure. Goal: see how outcomes differ per type
// (Over/Under vs Yes/No vs 1X2 vs named participants), to judge a betOfferType-aware SELECT.

import { betOffersByGroup, betOffersByEvents, eventsByGroup, levelOf } from "../src/resolver/offering-client";
import type { BetOffer, KOutcome } from "../src/resolver/offering-client";

const WC = 2010133908;

const oShape = (o: KOutcome) => ({
  id: o.id,
  label: o.label,
  ...(o.participant != null ? { participant: o.participant } : {}),
  ...(o.participantId != null ? { participantId: o.participantId } : {}),
  ...(o.line != null ? { line: o.line } : {}),
  ...(o.type != null ? { type: o.type } : {}),
  odds: o.odds,
});

function analyze(label: string, offers: BetOffer[]) {
  console.log(`\n${"█".repeat(90)}\n  ${label}  —  ${offers.length} bet-offers\n${"█".repeat(90)}`);
  const byType = new Map<string, BetOffer>();
  const counts = new Map<string, number>();
  for (const b of offers) {
    const key = `${b.betOfferType?.id} · ${b.betOfferType?.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!byType.has(key)) byType.set(key, b);
  }
  console.log(`\n  Unique betOfferTypes: ${byType.size}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} ×  ${k}`);

  for (const [key, b] of byType) {
    console.log(`\n${"─".repeat(90)}`);
    console.log(`betOfferType : ${key}`);
    console.log(`criterion    : ${b.criterion?.id} · ${b.criterion?.label}`);
    console.log(`tags         : ${JSON.stringify(b.tags)}`);
    console.log(`#outcomes    : ${b.outcomes?.length}`);
    console.log(`outcomes     :`);
    for (const o of (b.outcomes ?? []).slice(0, 6)) console.log(`   ${JSON.stringify(oShape(o))}`);
    if ((b.outcomes?.length ?? 0) > 6) console.log(`   … +${b.outcomes!.length - 6} more`);
  }
}

async function main() {
  // 1) Competition-grain (tournament outrights) from the group endpoint.
  const grp = await betOffersByGroup(WC, { onlyCompetitions: true });
  analyze("COMPETITION grain (group, onlyCompetitions)", grp.betOffers);

  // 2) Match-grain: pick one real fixture and pull its full menu (richest per-fixture structure).
  const events = await eventsByGroup(WC);
  const fixtures = events.filter((e) => levelOf(e.tags) === "fixture");
  // prefer an imminent prematch fixture (richest), else just the first fixture
  const pick = fixtures.find((e) => e.state === "NOT_STARTED") ?? fixtures[0];
  if (pick) {
    const ev = await betOffersByEvents([pick.id]);
    analyze(`MATCH grain — ${pick.name} (event ${pick.id}, state=${pick.state})`, ev.betOffers);
  } else {
    console.log("\n(no fixtures found in group)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
