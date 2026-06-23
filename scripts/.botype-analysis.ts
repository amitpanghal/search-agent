// scratch: NO LLM. Reuse the exact recall input from the payload probe and measure how much a server-side
// betOfferType filter would shrink the menu for each subject. Also flag mapping ambiguity (which types the
// target markets live under, and how many distinct criteria share each type).
import { recall } from "../src/resolver/recall";
import { filterBySubject } from "../src/resolver/filter";
import { variantOf } from "../src/resolver/recall";
import type { BetOffer } from "../src/resolver/offering-client";

const RECALL_INPUT = { grain: "match" as const, participantIds: [1000000321, 1003026206, 1000000125] };

const typeName = (b: BetOffer) => `${b.betOfferType?.id ?? "?"} ${b.betOfferType?.name ?? "(none)"}`;

function report(title: string, offers: BetOffer[]) {
  // distinct (criterion+variant) menu size
  const menuKeys = new Set(offers.filter((b) => b.criterion?.id != null).map((b) => `${b.criterion!.id}|${variantOf(b)}`));
  // group distinct menu items by betOfferType
  const byType = new Map<string, Set<string>>();
  for (const b of offers) {
    if (b.criterion?.id == null) continue;
    const t = typeName(b);
    const key = `${b.criterion.id}|${variantOf(b)}`;
    (byType.get(t) ?? byType.set(t, new Set()).get(t)!).add(key);
  }
  console.log(`\n##### ${title} #####`);
  console.log(`offers: ${offers.length} | distinct menu items: ${menuKeys.size} | distinct betOfferTypes: ${byType.size}`);
  console.log("menu-items per betOfferType (this is the reduction lever):");
  [...byType.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .forEach(([t, set]) => console.log(`  ${String(set.size).padStart(3)}  type ${t}`));
}

function show(title: string, offers: BetOffer[], match: (label: string) => boolean) {
  const hits = offers.filter((b) => match(`${b.criterion?.label ?? ""} ${variantOf(b)}`));
  const types = new Set(hits.map(typeName));
  console.log(`\n>>> "${title}" target market lives under type(s): ${[...types].join("  |  ") || "(not found)"}`);
}

// menu size if we KEEP only offers whose betOfferType id is in `keep` (simulating the extractor's shortlist)
function keepSize(offers: BetOffer[], keep: Set<number>): number {
  const keys = new Set(
    offers.filter((b) => b.criterion?.id != null && keep.has(b.betOfferType?.id ?? -1)).map((b) => `${b.criterion!.id}|${variantOf(b)}`),
  );
  return keys.size;
}

async function main() {
  const r = await recall(RECALL_INPUT);
  console.log(`recall: ${r.data.events.length} events, ${r.data.betOffers.length} offers`);

  const france = filterBySubject(r.data.betOffers, r.data.events, "France").offers;
  const mbappe = filterBySubject(r.data.betOffers, r.data.events, "Mbappé").offers;

  report("FRANCE subject", france);
  show("HT/FT", france, (l) => /half time\/full time|half time \/ full time/i.test(l));

  report("MBAPPÉ subject", mbappe);
  show("to score twice", mbappe, (l) => /score at least 2|score twice|2 goals/i.test(l));

  console.log("\n===== SHORTLIST SIMULATION (drop-irrelevant, keep-probable) =====");
  // France "HT/FT": keep the result/half family; drop player props, corners, handicaps, outrights.
  console.log(`France 137 -> tight result family {8,2,3,12,11,1}: ${keepSize(france, new Set([8, 2, 3, 12, 11, 1]))}`);
  console.log(`France 137 -> + yes/no + position {…,18,117}: ${keepSize(france, new Set([8, 2, 3, 12, 11, 1, 18, 117]))}`);
  // Mbappé "to score twice": keep player-scoring families; drop player-vs-player head2head + outrights.
  console.log(`Mbappé 35  -> player props {127,125,17,18}: ${keepSize(mbappe, new Set([127, 125, 17, 18]))}`);
  console.log(`Mbappé 35  -> drop only head2head(13)+winner(4): ${keepSize(mbappe, new Set([127, 125, 17, 18, 2, 3, 6, 7, 8, 1, 11, 12, 117]))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
