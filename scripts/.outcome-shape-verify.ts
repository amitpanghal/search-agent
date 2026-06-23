// Verify BetOffer.md claims against live data: raw outcome keys, OT_OVER_EXACT pairs (type 127),
// 1X2 label style (type 2), handicap line signs (type 1 vs 11), englishLabel presence.
import { betOffersByEvents, eventsByGroup, levelOf } from "../src/resolver/offering-client";

const WC = 2010133908;

async function main() {
  const events = await eventsByGroup(WC);
  const fx = events.filter((e) => levelOf(e.tags) === "fixture");
  const pick = fx.find((e) => e.state === "NOT_STARTED") ?? fx[0];
  if (!pick) return console.log("no fixture");
  console.log(`fixture: ${pick.name} (event ${pick.id})  home=${pick.homeName} away=${pick.awayName}`);
  // event participants (home/away ids) — needed to map a team subject to OT_ONE/OT_TWO when outcomes lack participantId
  console.log(`event.participants: ${JSON.stringify((pick as any).participants ?? "none")}`);

  const { betOffers } = await betOffersByEvents([pick.id]);
  const firstOfType = (id: number) => betOffers.find((b) => b.betOfferType?.id === id);

  const dump = (title: string, id: number) => {
    const b = firstOfType(id);
    console.log(`\n${"─".repeat(80)}\n${title}  (betOfferType ${id})`);
    if (!b) return console.log("  (none in this fixture)");
    console.log(`  criterion: ${b.criterion?.label}   #outcomes=${b.outcomes?.length}`);
    for (const o of b.outcomes ?? []) console.log(`   ${JSON.stringify(o)}`); // RAW — show every key incl englishLabel
  };

  dump("Player Occurrence Line", 127);
  dump("1 x 2", 2);
  dump("Handicap (opposite signs?)", 1);
  dump("Three way HCP (same sign?)", 11);
  dump("Correct Score (englishLabel?)", 3);
  dump("Head to Head", 13);

  // confirm what distinct outcome.type values exist for type 127 across ALL its betoffers
  const t127 = betOffers.filter((b) => b.betOfferType?.id === 127);
  const types = new Set(t127.flatMap((b) => (b.outcomes ?? []).map((o) => o.type)));
  const sizes = new Set(t127.map((b) => b.outcomes?.length));
  console.log(`\ntype 127: ${t127.length} betoffers; outcome.type values = ${JSON.stringify([...types])}; #outcomes seen = ${JSON.stringify([...sizes])}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
