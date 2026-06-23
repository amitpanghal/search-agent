// Capture a LIVE-menu snapshot for the offline post-fetch gate (build plan Phase 5). Network-only (no LLM):
// freezes the WC26 competition outrights + one match fixture's offers into src/eval/live-menu.snapshot.json,
// so the gate (src/eval/live-menu-gate.ts) replays resolve/select/execute deterministically and OFFLINE.
// Run: `npx tsx scripts/capture-live-menu.ts` (needs network / sandbox disabled). Refresh occasionally — the
// gate's expectations are tied to this snapshot's contents.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recall } from "../src/resolver/recall";
import { getJson, type BetOffer } from "../src/resolver/offering-client";

const WC26 = 2010133908;
const COMP_URL = `https://eu.offering-api.kambicdn.com/offering/v2018/kambi/betoffer/group/${WC26}?includeParticipants=true&onlyCompetitions=true&market=GB&lang=en_GB`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "eval", "live-menu.snapshot.json");
const desc = (b: BetOffer) => String((b as any).description ?? "").trim();

async function main(): Promise<void> {
  // competition grain — the full outright menu
  const comp = await recall({ grain: "competition", groupId: WC26 });

  // match grain — pick USA's next fixture and freeze ITS offers (deterministic eventId, not a date sort)
  const raw = (await getJson(COMP_URL)) as { betOffers: BetOffer[] };
  const winner = raw.betOffers.find((b) => b.criterion?.label === "Finishing Position" && desc(b) === "Winner");
  const pid = winner?.outcomes?.find((o) => /USA|United States/i.test(o.participant ?? ""))?.participantId!;
  const m = await recall({ grain: "match", participantIds: [pid] });
  const next = m.data.events
    .filter((e) => (e.tags ?? []).includes("MATCH") && e.state === "NOT_STARTED" && e.start)
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))[0]!;
  const fixtureOffers = m.data.betOffers.filter((b) => b.eventId === next.id);

  const snapshot = {
    captured: new Date().toISOString(),
    competition: { groupId: WC26, betOffers: comp.data.betOffers, events: comp.data.events },
    match: {
      fixtureEventId: next.id,
      home: next.homeName ?? "",
      away: next.awayName ?? "",
      betOffers: fixtureOffers,
      events: m.data.events.filter((e) => e.id === next.id),
    },
  };
  writeFileSync(OUT, JSON.stringify(snapshot) + "\n");
  console.log(`wrote ${OUT}`);
  console.log(`  competition: ${comp.data.betOffers.length} offers, ${comp.menu.length} menu items`);
  console.log(`  match: ${next.name} (event ${next.id}) — ${fixtureOffers.length} offers`);
}
main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
