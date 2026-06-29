// squad-trim-cap-check — VALIDATE the SQUAD_FETCH_LIMIT pinned in plan-recall.ts (drop-bo_types change).
//
// Theory: dropping `type=` makes the participant call untyped, so a FULL squad would silently hit the 2000-cap
// in an offer-dense competition. We trim to the first N roster ids instead. This script proves, against the LIVE
// offering API (read-only public CDN GETs, no auth, no LLM):
//   (1) the FULL squad really does cap (≥2000) for dense nations -> the trim is necessary;
//   (2) the TRIMMED squad (first N) stays under the cap;
//   (3) the trimmed squad STILL pulls the team's competition markets through (a COMPETITION-level event with
//       betoffers appears) -> coverage is preserved.
//
// Run: npx tsx scripts/squad-trim-cap-check.ts [N]   (default N = SQUAD_FETCH_LIMIT)

import { betOffersByParticipants, levelOf, type BetOffer, type KEvent } from "../src/resolver/offering-client";
import { marketLabelOf } from "../src/resolver/recall";
import { loadScopeCatalog } from "../src/resolver/scope-catalog";

const N = Number(process.argv[2] ?? 5);
const CAP = 2000;

// The competition markets we expect a trimmed squad to still pull through: betoffers whose event is
// COMPETITION-level (Tournament Winner / reach-the-final / stage-of-elimination / top scorer, etc.).
function compMarkets(betOffers: BetOffer[], events: KEvent[]): string[] {
  const compEventIds = new Set(events.filter((e) => levelOf(e.tags) === "competition").map((e) => e.id));
  const labels = new Set<string>();
  for (const b of betOffers) if (b.eventId != null && compEventIds.has(b.eventId)) labels.add(marketLabelOf(b));
  return [...labels];
}

type Probe = { offers: number; capped: boolean; comp: string[]; err?: string };
async function probe(ids: number[]): Promise<Probe> {
  try {
    const r = await betOffersByParticipants(ids); // UNTYPED — exactly what recall now sends
    const total = r.range?.total ?? r.betOffers.length;
    return { offers: r.betOffers.length, capped: total >= CAP, comp: compMarkets(r.betOffers, r.events) };
  } catch (e) {
    return { offers: 0, capped: false, comp: [], err: String((e as Error).message).slice(0, 24) };
  }
}

async function main(): Promise<void> {
  const cat = loadScopeCatalog("football");
  // National teams with a roster, densest-first by roster size (proxy; the API call is the real measure).
  const nations = cat.teams
    .filter((t) => (cat.roster.get(t.id)?.length ?? 0) >= 11)
    .map((t) => ({ id: t.id, name: t.name, roster: cat.roster.get(t.id)! }))
    .sort((a, b) => b.roster.length - a.roster.length)
    .slice(0, 12);

  if (!nations.length) { console.log("no national teams with rosters found in football catalog"); return; }
  console.log(`N=${N}  cap=${CAP}  probing ${nations.length} nations (full squad vs first-${N})\n`);

  let worstTrim = 0, coverageMisses = 0, capMisses = 0;
  for (const t of nations) {
    // FULL squad: a 400 (URL/param overflow on a big roster) is itself "unfetchable in one call" evidence.
    const full = await probe(t.roster);
    const trim = await probe(t.roster.slice(0, N));
    worstTrim = Math.max(worstTrim, trim.offers);
    const cover = trim.comp.length > 0;
    if (trim.err) { coverageMisses++; capMisses++; }
    else { if (!cover) coverageMisses++; if (trim.capped) capMisses++; }
    const fullCell = full.err ? `FULL  ${full.err.padEnd(8)}` : `FULL ${String(full.offers).padStart(4)}${full.capped ? " CAP" : "   "}`;
    const trimCell = trim.err ? `TRIM(${N}) ${trim.err}` : `TRIM(${N}) ${String(trim.offers).padStart(4)}${trim.capped ? " CAP" : "   "}`;
    console.log(
      `${t.name.padEnd(22)} roster=${String(t.roster.length).padStart(2)}  ${fullCell}  ${trimCell}  ` +
      `compMarkets=${String(trim.comp.length).padStart(2)} ${trim.err ? "ERR" : cover ? "ok" : "MISS"}`,
    );
    if (!trim.err && !cover) console.log(`    ^ trimmed squad pulled NO competition markets (full had ${full.comp.length})`);
  }

  console.log(`\nworst trim=${worstTrim}  cap-misses(trim)=${capMisses}  coverage-misses(trim)=${coverageMisses}`);
  console.log(capMisses === 0 && coverageMisses === 0
    ? `PASS: N=${N} stays under cap AND preserves competition-market coverage for every probed nation.`
    : `FAIL: N=${N} ${capMisses ? `caps in ${capMisses} nation(s)` : ""}${coverageMisses ? ` loses coverage in ${coverageMisses}` : ""}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
