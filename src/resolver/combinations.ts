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
// multiply. A same-event group the feed refuses whole is retried on its subsets (largest first — see
// priceLargest), so one toxic leg no longer kills the group: it falls out and keeps its independent result card.
// <2 surviving legs -> no betslip. Legs keep query order and carry `outcomeId` so the frontend can show what's
// in vs out. RAW millis.

// k-subsets of arr in lexicographic index order — the tie-break: among same-size subsets, the one keeping the
// earliest-mentioned legs is generated (and therefore picked) first.
const subsetsOf = (arr: number[], k: number): number[][] => {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i <= arr.length - (k - cur.length); i++) { cur.push(arr[i]!); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
};

// The LARGEST combinable subset of one same-event group: try all ids together (1 call — the common case), then
// on refusal every subset one size smaller IN PARALLEL, stopping at the first size where anything prices.
// Combinability is monotone (a failing set never combines by adding legs), so top-down never misses a bigger win.
// ponytail: capped at 3 rounds — a 5-leg group where no triple combines returns null (pairs never tested).
async function priceLargest(eventId: number, ids: number[], priceCombo: PriceCombo, lang?: string): Promise<{ ids: number[]; price: number } | null> {
  for (let size = ids.length, round = 0; size >= 2 && round < 3; size--, round++) {
    const combos = subsetsOf(ids, size);
    const prices = await Promise.all(combos.map((c) => priceCombo(eventId, c, lang)));
    const k = prices.findIndex((p) => p != null);
    if (k >= 0) return { ids: combos[k]!, price: prices[k]! };
  }
  return null;
}

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

  // Price each event group (all groups in parallel): same-event ≥2 -> the largest combinable subset via the
  // correlated API (priceLargest); single -> the outcome's own odds. A null (nothing ≥2 combines / transient)
  // drops that group; legs outside the priced subset fall back to independent result cards.
  const groups = [...byEvent.entries()];
  const priced = await Promise.all(groups.map(([eid, ids]) =>
    ids.length >= 2
      ? priceLargest(eid, ids, priceCombo, lang)
      : Promise.resolve(byOutcome.get(ids[0]!)?.o.odds != null ? { ids, price: byOutcome.get(ids[0]!)!.o.odds! } : null)));

  const survivors = new Set<number>();
  let product = 1;
  for (const p of priced) {
    if (p == null) continue; // dropped group
    product *= p.price / 1000;
    for (const id of p.ids) survivors.add(id);
  }

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
