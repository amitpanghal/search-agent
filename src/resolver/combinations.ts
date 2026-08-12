// COMBINATIONS — the bet-builder Phase 1 filtering arm. Given the recalled pre-configured coupons and THIS
// query's resolved picks, keep only coupons that sit wholly on the shown games, rank them by how closely they
// echo what the user asked, and shape the top few for the envelope. No fetching, no LLM — pure ranking.
//
// Relevance ladder (most to least specific), scored per coupon by counting its legs that hit each set:
//   1. exact pick    — the coupon leg IS one of the user's selected outcomes (same outcome id)
//   2. same betoffer — same line & market instance, either side, as a pick (same betOffer id)
//   3. same event    — the coupon leg sits on one of the query's shown games (event id in finalEventIds)
//   4. same market   — same market family as a pick, any line/side (same criterion id)
// To surface at all, a coupon must sit on a shown game AND carry an exact-outcome or same-betoffer leg (event- or
// market-only overlap is dropped). Among survivors, ties break CUSTOM-before-AUTO (operator-curated first).

import { levelOf, type BetOffer, type KEvent, type KOutcome, type PrePackCoupon, type PrePackOutcomeRef, type PrePackResponse } from "./offering-client";
import type { ResolvedLeg } from "./live-menu-types";

// One leg of a pre-built combination, rendered for the envelope (odds/line stay RAW integer millis).
export type CombinationLeg = {
  eventId?: number;
  market: string;      // criterion englishLabel ("Total Goals")
  outcome: string;     // outcome englishLabel ("Over", "France", "Yes")
  participant?: string;
  line?: number;       // RAW millis (3500 = 3.5)
  matched?: boolean;   // true when this leg is one of the user's exact resolved picks
  outcomeId: number;   // the feed outcome id (the betslip selection id) — set on every leg so the frontend can add it
};
// A priced betslip. Phase 1: a pre-configured coupon (`tag` AUTO/CUSTOM, carries the coupon `id`). Phase 2: the
// user's OWN resolved legs priced together (`tag` EXACT, no coupon `id`).
export type Combination = {
  id?: number;
  odds: number;        // RAW millis combined price (3750 = 3.75)
  tag: string;
  legs: CombinationLeg[];
};

// The correlated same-event pricing call (offering-client.onDemandPricing), injected so buildBetslip stays pure.
export type PriceCombo = (eventId: number, outcomeIds: number[], lang?: string) => Promise<number | null>;

// Every outcome ref across ALL of a coupon's rows (never just the first). A row is EITHER a SIMPLE single
// outcome on `row.outcome`, OR a bet-builder nesting its outcomes under `group.groups[].outcomes[]` (a flat
// `group.outcomes` is handled too, defensively). Both shapes co-occur in one coupon (cross-event CUSTOM specials).
const refsOf = (c: PrePackCoupon): PrePackOutcomeRef[] => {
  const out: PrePackOutcomeRef[] = [];
  for (const row of c.prePackCouponRows ?? []) {
    if (row.outcome) out.push(row.outcome); // SIMPLE row
    const g = row.group;
    if (g) {
      for (const sub of g.groups ?? []) for (const o of sub.outcomes ?? []) out.push(o);
      for (const o of g.outcomes ?? []) out.push(o);
    }
  }
  return out;
};
const eventsOf = (c: PrePackCoupon): number[] =>
  [...new Set((c.prePackCouponRows ?? []).map((r) => r.eventId).filter((x): x is number => x != null))];
// The coupon's TOTAL price. The bet-level odds already joins all rows (verified: it equals the product of the
// row odds), so prefer it. Fallback when absent: multiply the row odds (rows are independent legs) — NOT the
// first row alone, which would understate a multi-row coupon. Odds stay RAW millis (1420 = 1.42).
const priceOf = (c: PrePackCoupon): number => {
  const bet = c.prePackCouponBets?.[0]?.odds?.decimal;
  if (bet != null) return bet;
  const rows = c.prePackCouponRows ?? [];
  if (!rows.length) return 0;
  return Math.round(rows.reduce((acc, r) => acc * ((r.odds?.decimal ?? 1000) / 1000), 1) * 1000);
};
const isCustom = (c: PrePackCoupon): boolean => (c.prePackCouponTags ?? []).includes("CUSTOM");

// Rank + shape the recalled coupons for THIS query. `resolved*Ids` are the query's picks at three grains (see the
// ladder above); when all are empty (no market leg resolved) every survivor ties and CUSTOM/price ordering wins.
export function pickCombinations(
  prepacks: PrePackResponse | undefined,
  finalEventIds: Set<number>,
  resolvedOutcomeIds: Set<number>,
  resolvedBetofferIds: Set<number>,
  resolvedCriterionIds: Set<number>,
  limit = 3,
): Combination[] {
  if (!prepacks?.prePackCoupons?.length) return [];
  // Index every bet-builder outcome the coupons reference, by outcome id (the response labels its own legs).
  const byOutcome = new Map<number, { b: BetOffer; o: KOutcome }>();
  for (const b of prepacks.betOffers) for (const o of b.outcomes ?? []) if (o.id != null) byOutcome.set(o.id, { b, o });

  type Scored = { c: PrePackCoupon; exact: number; bo: number; ev: number; market: number };
  const scored: Scored[] = [];
  for (const c of prepacks.prePackCoupons) {
    if (!isCustom(c)) continue; // only CUSTOM coupons are operator-curated "specials"; drop AUTO prepacks/matchparlays
    const evs = eventsOf(c);
    if (!evs.length) continue;
    let exact = 0, bo = 0, ev = 0, market = 0;
    for (const r of refsOf(c)) {
      if (resolvedOutcomeIds.has(r.id)) exact++;
      const b = byOutcome.get(r.id)?.b;
      const boId = r.betOfferId ?? b?.id;
      if (boId != null && resolvedBetofferIds.has(boId)) bo++;
      if (b?.eventId != null && finalEventIds.has(b.eventId)) ev++;
      const crit = b?.criterion?.id;
      if (crit != null && resolvedCriterionIds.has(crit)) market++;
    }
    // Keep only coupons that sit on a shown game AND echo a real pick (an exact outcome or the same betoffer);
    // event-membership alone, or a mere same-market overlap, is too loose to surface. A kept coupon may still
    // reference extra (non-shown) events — those are enriched onto the envelope by the caller from `prepacks.events`.
    if (!evs.some((e) => finalEventIds.has(e)) || (!exact && !bo)) continue;
    scored.push({ c, exact, bo, ev, market });
  }
  scored.sort((a, b) =>
    b.exact - a.exact ||
    b.bo - a.bo ||
    b.ev - a.ev ||
    b.market - a.market,
  );
  return scored.slice(0, limit).map(({ c }) => toCombination(c, byOutcome, resolvedOutcomeIds));
}

function toCombination(c: PrePackCoupon, byOutcome: Map<number, { b: BetOffer; o: KOutcome }>, resolved: Set<number>): Combination {
  const legs: CombinationLeg[] = [];
  for (const r of refsOf(c)) {
    const hit = byOutcome.get(r.id);
    if (!hit) continue; // unlabelled leg (shouldn't happen — the response labels every leg)
    const { b, o } = hit;
    legs.push({
      ...(b.eventId != null ? { eventId: b.eventId } : {}),
      market: b.criterion?.englishLabel ?? b.criterion?.label ?? "?",
      outcome: o.englishLabel ?? o.label ?? "?",
      ...(o.participant ? { participant: o.participant } : {}),
      ...(o.line != null ? { line: o.line } : {}),
      outcomeId: r.id,
      ...(resolved.has(r.id) ? { matched: true } : {}),
    });
  }
  return { id: c.id, odds: priceOf(c), tag: (c.prePackCouponTags ?? [])[0] ?? "AUTO", legs };
}

// EXACT betslip (bet-builder Phase 2) — price the user's OWN resolved legs together. Fixture-level picks only
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
