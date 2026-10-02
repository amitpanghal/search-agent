// COMBINATIONS — combine the user's OWN resolved legs into ONE bet ("EXACT"), one part per match: 2+ legs on a
// match are a Bet Builder priced by the feed's correlated onDemandPricing endpoint (a same-event joint price is
// NOT the product); a leg alone on its match is a single at its own odds. Parts are different matches, so they
// multiply. No fetching beyond the injected priceCombo, no LLM.

import { levelOf, type BetOffer, type KEvent, type KOutcome } from "../shared/offering-client";
import type { ResolvedLeg } from "../shared/live-menu-types";

// One leg of the priced combination, rendered for the envelope (odds/line stay RAW integer millis).
export type CombinationLeg = {
  market: string; // criterion englishLabel ("Total Goals")
  outcome: string; // outcome englishLabel ("Over", "France", "Yes")
  participant?: string;
  line?: number; // RAW millis (3500 = 3.5)
  matched?: boolean; // true when this leg is one of the user's exact resolved picks
  outcomeId: number; // the feed outcome id (the betslip selection id) — set on every leg so the frontend can add it
};
// One match inside the combination: a Bet Builder (2+ legs priced together) or a single (1 leg at its own odds).
export type CombinationPart = {
  eventId: number;
  odds: number; // RAW millis — the Bet Builder's joint price, or the single's own odds
  legs: CombinationLeg[];
};
// The user's resolved legs combined into ONE bet (`tag` EXACT) — one card, a section per part.
export type Combination = {
  odds: number; // RAW millis combined price (3750 = 3.75) — the product of the parts. Not for display
  oddsLabel: string; // the combined price exactly as the Kambi betslip shows it ("4.35") — the frontend prints this
  tag: string;
  parts: CombinationPart[];
};

// The correlated same-event pricing call (offering-client.onDemandPricing), injected so buildBetslip stays pure.
export type PriceCombo = (eventId: number, outcomeIds: number[], lang?: string) => Promise<number | null>;

// EXACT combination — price the user's OWN resolved legs together. Fixture-level picks only
// (competition/outright picks have no match event to price against). Each LEG contributes AT MOST ONE pick:
// a multi-fixture leg ("City to win" over its next 3 games) is one intent, never an accumulator of itself.
// Legs are assigned to events greedily — the event covering the most legs first (soonest kickoff tie-break) —
// so co-occurring legs price as ONE correlated `priceCombo` group (a Bet Builder part) and genuinely-disjoint
// legs are single parts. A group the feed refuses whole is retried on its subsets (largest first — see
// priceLargest): a leg that can't combine with its match drops out of the combination and keeps its result
// card. A group where NOTHING prices bans that event and its legs re-assign to their other fixtures (the
// "City to win and Liverpool to win" pair that happen to meet next becomes the intended double).
// <2 surviving legs -> no combination. Parts, and legs inside a part, keep query order; legs carry `outcomeId`
// so the frontend can show what's in vs out. RAW millis.

// k-subsets of arr in lexicographic index order — the tie-break: among same-size subsets, the one keeping the
// earliest-mentioned legs is generated (and therefore picked) first.
const subsetsOf = (arr: number[], k: number): number[][] => {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i <= arr.length - (k - cur.length); i++) {
      cur.push(arr[i]!);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
};

// The LARGEST combinable subset of one same-event group: try all ids together (1 call — the common case), then
// on refusal every subset one size smaller IN PARALLEL, stopping at the first size where anything prices.
// Combinability is monotone (a failing set never combines by adding legs), so top-down never misses a bigger win.
// ponytail: capped at 3 rounds — a 5-leg group where no triple combines returns null (pairs never tested).
async function priceLargest(
  eventId: number,
  ids: number[],
  priceCombo: PriceCombo,
  lang?: string,
): Promise<{ ids: number[]; price: number } | null> {
  for (let size = ids.length, round = 0; size >= 2 && round < 3; size--, round++) {
    const combos = subsetsOf(ids, size);
    const prices = await Promise.all(combos.map((c) => priceCombo(eventId, c, lang)));
    const k = prices.findIndex((p) => p != null);
    if (k >= 0) return { ids: combos[k]!, price: prices[k]! };
  }
  return null;
}

// Kambi's own decimal display rule (formatDecimalOdds in @kambi/betting-client-helpers, which the betslip uses):
// 2 decimals below 100, 1 below 1000, none above.
const kambiOddsLabel = (rawMillis: number): string => {
  const n = rawMillis / 1000;
  return n < 100 ? n.toFixed(2) : n < 1000 ? n.toFixed(1) : n.toFixed(0);
};

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
  const startOf = new Map<number, string>(); // UTC kickoff for the soonest-first tie-break; unknown sorts last
  for (const e of events)
    if (e.id != null && levelOf(e.tags) === "fixture") {
      fixtureEvents.add(e.id);
      startOf.set(e.id, e.start ?? "9999");
    }

  // Per-LEG picks, one per event, fixture-level only (dedup across legs — a pick never doubles).
  const legPicks: Map<number, number>[] = []; // per leg: eventId -> its selected outcomeId there
  const seen = new Set<number>();
  for (const l of legs) {
    const picks = new Map<number, number>();
    for (const id of l.selection?.selectedIds ?? (l.selection?.outcomeId != null ? [l.selection.outcomeId] : [])) {
      if (seen.has(id)) continue;
      const eid = byOutcome.get(id)?.b.eventId;
      if (eid == null || !fixtureEvents.has(eid) || picks.has(eid)) continue;
      seen.add(id);
      picks.set(eid, id);
    }
    if (picks.size) legPicks.push(picks);
  }

  // Assign each pending leg to ONE event: repeatedly take the un-banned event covering the most pending legs
  // (soonest kickoff breaks ties), so co-occurring legs group and loners keep their own soonest fixture. A leg
  // with no un-banned event left stays behind (falls out, keeps its result card). Consumes `pending`.
  const assign = (pending: Set<number>, banned: Set<number>): [number, number[]][] => {
    const groups: [number, number[]][] = [];
    while (pending.size) {
      const count = new Map<number, number>();
      for (const li of pending)
        for (const eid of legPicks[li]!.keys()) if (!banned.has(eid)) count.set(eid, (count.get(eid) ?? 0) + 1);
      let best: number | undefined,
        bestN = 0;
      for (const [eid, n] of count)
        if (n > bestN || (n === bestN && startOf.get(eid)! < startOf.get(best!)!)) {
          best = eid;
          bestN = n;
        }
      if (best == null) break;
      const ids: number[] = [];
      for (const li of [...pending]) {
        const id = legPicks[li]!.get(best);
        if (id != null) {
          ids.push(id);
          pending.delete(li);
        }
      }
      groups.push([best, ids]);
    }
    return groups;
  };
  const legOf = (id: number) => legPicks.findIndex((p) => [...p.values()].includes(id));

  // Price the assigned groups (all in parallel): ≥2 picks -> the largest combinable subset via the correlated
  // API (priceLargest); single -> the outcome's own odds. A group where NOTHING prices bans that event and
  // re-assigns its legs to their remaining fixtures next round; legs merely outside a priced subset fall out for
  // good (keep their result cards). A re-assigned leg landing on an ALREADY-PRICED event MERGES into that event's
  // group and the whole group re-prices correlated: one event holds ONE price, never two that multiply (a
  // same-event joint price is not the product of the singles) — so the multiply happens only at the end, from
  // each event's FINAL group. A refused merge keeps the group that already priced.
  // ponytail: 3 reassign rounds — a chain of 3 fully-refused events leaves the tail legs un-combined.
  const pricedAt = new Map<number, { ids: number[]; price: number }>(); // eventId -> its ONE priced group
  const banned = new Set<number>();
  let pending = new Set(legPicks.map((_, i) => i));
  for (let round = 0; round < 3 && pending.size; round++) {
    const groups = assign(pending, banned).map(([eid, ids]): [number, number[]] => [
      eid,
      [...(pricedAt.get(eid)?.ids ?? []), ...ids].sort((a, b) => legOf(a) - legOf(b)),
    ]);
    const priced = await Promise.all(
      groups.map(([eid, ids]) =>
        ids.length >= 2
          ? priceLargest(eid, ids, priceCombo, lang)
          : Promise.resolve(
              byOutcome.get(ids[0]!)?.o.odds != null ? { ids, price: byOutcome.get(ids[0]!)!.o.odds! } : null,
            ),
      ),
    );
    pending = new Set();
    groups.forEach(([eid, ids], i) => {
      const p = priced[i];
      if (p == null) {
        // a refused MERGE keeps the group that already priced; only the newcomers look elsewhere
        banned.add(eid);
        const kept = pricedAt.get(eid)?.ids ?? [];
        for (const id of ids) if (!kept.includes(id)) pending.add(legOf(id));
        return;
      }
      pricedAt.set(eid, p);
    });
  }

  // Each event's FINAL group is one part (a Bet Builder, or a single); the parts multiply. Group ids are already in
  // leg order, so sorting the parts by their first leg keeps query order.
  const toLeg = (id: number): CombinationLeg => {
    const { b, o } = byOutcome.get(id)!;
    return {
      market: b.criterion?.label ?? b.criterion?.englishLabel ?? "?",
      outcome: o.label ?? o.englishLabel ?? "?",
      ...(o.participant ? { participant: o.participant } : {}),
      ...(o.line != null ? { line: o.line } : {}),
      outcomeId: id,
      matched: true,
    };
  };
  const parts = [...pricedAt]
    .sort(([, a], [, b]) => legOf(a.ids[0]!) - legOf(b.ids[0]!))
    .map(([eventId, g]) => ({ eventId, odds: g.price, legs: g.ids.map(toLeg) }));
  if (parts.reduce((n, p) => n + p.legs.length, 0) < 2) return undefined;
  // Priced exactly the way the Kambi betslip prices it, so the card and the slip always agree: the RAW product in
  // the slip's order (singles first, then Bet Builders — at a tie the float order moves the last digit), rounded
  // ONCE for display. Rounding to millis first rounds twice: 1.58 × 2.75 -> 4345 -> "4.34" vs the slip's "4.35".
  const product = [...parts.filter((p) => p.legs.length === 1), ...parts.filter((p) => p.legs.length > 1)].reduce(
    (x, p) => x * (p.odds / 1000),
    1,
  );
  return { tag: "EXACT", odds: Math.round(product * 1000), oddsLabel: kambiOddsLabel(product * 1000), parts };
}
