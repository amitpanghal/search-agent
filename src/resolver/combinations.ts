// COMBINATIONS — the bet-builder Phase 1 filtering arm. Given the recalled pre-configured coupons and THIS
// query's resolved picks, keep only coupons that sit wholly on the shown games, rank them by how closely they
// echo what the user asked, and shape the top few for the envelope. No fetching, no LLM — pure ranking.
//
// Relevance ladder (most to least specific), scored per coupon by counting its legs that hit each set:
//   1. exact pick    — the coupon leg IS one of the user's selected outcomes (same outcome id)
//   2. same betoffer — same line & market instance, either side, as a pick (same betOffer id)
//   3. same event    — the coupon leg sits on one of the query's shown games (event id in finalEventIds)
//   4. same market   — same market family as a pick, any line/side (same criterion id)
// Ties break CUSTOM-before-AUTO (operator-curated first), then shortest combined price.

import type { BetOffer, KOutcome, PrePackCoupon, PrePackOutcomeRef, PrePackResponse } from "./offering-client";

// One leg of a pre-built combination, rendered for the envelope (odds/line stay RAW integer millis).
export type CombinationLeg = {
  eventId?: number;
  market: string;      // criterion englishLabel ("Total Goals")
  outcome: string;     // outcome englishLabel ("Over", "France", "Yes")
  participant?: string;
  line?: number;       // RAW millis (3500 = 3.5)
  matched?: boolean;   // true when this leg is one of the user's exact resolved picks
};
// A pre-configured coupon = a whole betslip already priced. `tag` is AUTO (machine) or CUSTOM (operator-curated).
export type Combination = {
  id: number;
  odds: number;        // RAW millis combined price (3750 = 3.75)
  tag: string;
  legs: CombinationLeg[];
};

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
    // Keep if ANY row is relevant by the ladder — exact pick / same betoffer / same event / same market — not
    // only when EVERY leg is on a shown game. This keeps cross-game coupons that contain a real pick; the extra
    // (non-shown) events they reference are enriched onto the envelope by the caller from `prepacks.events`.
    if (!exact && !bo && !market && !evs.some((e) => finalEventIds.has(e))) continue;
    scored.push({ c, exact, bo, ev, market });
  }
  scored.sort((a, b) =>
    b.exact - a.exact ||
    b.bo - a.bo ||
    b.ev - a.ev ||
    b.market - a.market ||
    (isCustom(b.c) ? 1 : 0) - (isCustom(a.c) ? 1 : 0) ||
    priceOf(a.c) - priceOf(b.c),
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
      ...(resolved.has(r.id) ? { matched: true } : {}),
    });
  }
  return { id: c.id, odds: priceOf(c), tag: (c.prePackCouponTags ?? [])[0] ?? "AUTO", legs };
}
