// COMBINATIONS — price the user's OWN resolved legs together as one betslip (bet-builder "EXACT" combo).
// Same-event legs are priced by the feed's correlated onDemandPricing endpoint (their joint price is NOT the
// product); cross-event legs multiply. No fetching beyond the injected priceCombo, no LLM.

import { levelOf, type BetOffer, type KEvent, type KOutcome } from "./offering-client";
import type { ResolvedLeg } from "./live-menu-types";

// One leg of the priced combination, rendered for the envelope (odds/line stay RAW integer millis).
export type CombinationLeg = {
  eventId?: number;
  market: string;      // criterion englishLabel ("Total Goals")
  outcome: string;     // outcome englishLabel ("Over", "France", "Yes")
  participant?: string;
  line?: number;       // RAW millis (3500 = 3.5)
  matched?: boolean;   // true when this leg is one of the user's exact resolved picks
  outcomeId: number;   // the feed outcome id (the betslip selection id) — set on every leg so the frontend can add it
};
// The user's resolved legs priced together as one betslip (`tag` EXACT).
export type Combination = {
  odds: number;        // RAW millis combined price (3750 = 3.75)
  tag: string;
  legs: CombinationLeg[];
};

// The correlated same-event pricing call (offering-client.onDemandPricing), injected so buildBetslip stays pure.
export type PriceCombo = (eventId: number, outcomeIds: number[], lang?: string) => Promise<number | null>;

// EXACT betslip — price the user's OWN resolved legs together. Fixture-level picks only
// (competition/outright picks have no match event to price against). Same-event ≥2-pick groups are priced by the
// feed's correlated `priceCombo` (their combined odds is NOT the product); single-pick events and cross-event legs
// multiply. A same-event group the feed won't combine (priceCombo -> null) is dropped whole; <2 surviving legs ->
// no betslip. Legs keep query order and carry `outcomeId` so the frontend can show what's in vs out. RAW millis.
export async function buildBetslip(
  legs: ResolvedLeg[],
  offers: BetOffer[],
  events: KEvent[],
  priceCombo: PriceCombo,
  lang?: string,
): Promise<Combination | undefined> {
  const byOutcome = new Map<number, { b: BetOffer; o: KOutcome }>();
  for (const b of offers) for (const o of b.outcomes ?? []) if (o.id != null) byOutcome.set(o.id, { b, o });
  const fixtureEvents = new Set<number>();
  for (const e of events) if (e.id != null && levelOf(e.tags) === "fixture") fixtureEvents.add(e.id);

  // Selected outcome ids in query order, fixture-level only, grouped by event (dedup — a leg never doubles a pick).
  const byEvent = new Map<number, number[]>();
  const seen = new Set<number>();
  for (const l of legs) {
    for (const id of l.selection?.selectedIds ?? (l.selection?.outcomeId != null ? [l.selection.outcomeId] : [])) {
      if (seen.has(id)) continue;
      const eid = byOutcome.get(id)?.b.eventId;
      if (eid == null || !fixtureEvents.has(eid)) continue;
      seen.add(id);
      let arr = byEvent.get(eid);
      if (!arr) byEvent.set(eid, arr = []);
      arr.push(id);
    }
  }

  // Price each event group: same-event ≥2 -> correlated API (one round-trip each, all in parallel); single -> the
  // outcome's own odds. A null price (not combinable / transient) drops that whole group.
  const groups = [...byEvent.entries()];
  const prices = await Promise.all(groups.map(([eid, ids]) =>
    ids.length >= 2 ? priceCombo(eid, ids, lang) : Promise.resolve(byOutcome.get(ids[0]!)?.o.odds ?? null)));

  const survivors = new Set<number>();
  let product = 1;
  groups.forEach(([, ids], k) => {
    const price = prices[k];
    if (price == null) return; // dropped group
    product *= price / 1000;
    for (const id of ids) survivors.add(id);
  });

  const outLegs: CombinationLeg[] = [];
  for (const l of legs) {
    for (const id of l.selection?.selectedIds ?? (l.selection?.outcomeId != null ? [l.selection.outcomeId] : [])) {
      if (!survivors.has(id)) continue;
      survivors.delete(id); // emit each surviving pick once, in query order
      const { b, o } = byOutcome.get(id)!;
      outLegs.push({
        ...(b.eventId != null ? { eventId: b.eventId } : {}),
        market: b.criterion?.englishLabel ?? b.criterion?.label ?? "?",
        outcome: o.englishLabel ?? o.label ?? "?",
        ...(o.participant ? { participant: o.participant } : {}),
        ...(o.line != null ? { line: o.line } : {}),
        outcomeId: id,
        matched: true,
      });
    }
  }

  if (outLegs.length < 2) return undefined;
  return { tag: "EXACT", odds: Math.round(product * 1000), legs: outLegs };
}
