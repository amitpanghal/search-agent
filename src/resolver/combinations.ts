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
// (competition/outright picks have no match event to price against). Each LEG contributes AT MOST ONE pick:
// a multi-fixture leg ("City to win" over its next 3 games) is one intent, never an accumulator of itself.
// Legs are assigned to events greedily — the event covering the most legs first (soonest kickoff tie-break) —
// so co-occurring legs price as ONE correlated `priceCombo` group and genuinely-disjoint legs multiply as a
// cross-event double. A group the feed refuses whole is retried on its subsets (largest first — see
// priceLargest); a group where NOTHING prices bans that event and its legs re-assign to their other fixtures
// (the "City to win and Liverpool to win" pair that happen to meet next becomes the intended double).
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
  const startOf = new Map<number, string>(); // UTC kickoff for the soonest-first tie-break; unknown sorts last
  for (const e of events) if (e.id != null && levelOf(e.tags) === "fixture") { fixtureEvents.add(e.id); startOf.set(e.id, e.start ?? "9999"); }

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
      for (const li of pending) for (const eid of legPicks[li]!.keys()) if (!banned.has(eid)) count.set(eid, (count.get(eid) ?? 0) + 1);
      let best: number | undefined, bestN = 0;
      for (const [eid, n] of count)
        if (n > bestN || (n === bestN && startOf.get(eid)! < startOf.get(best!)!)) { best = eid; bestN = n; }
      if (best == null) break;
      const ids: number[] = [];
      for (const li of [...pending]) {
        const id = legPicks[li]!.get(best);
        if (id != null) { ids.push(id); pending.delete(li); }
      }
      groups.push([best, ids]);
    }
    return groups;
  };
  const legOf = (id: number) => legPicks.findIndex((p) => [...p.values()].includes(id));

  // Price the assigned groups (all in parallel): ≥2 picks -> the largest combinable subset via the correlated
  // API (priceLargest); single -> the outcome's own odds; groups multiply. A group where NOTHING prices bans
  // that event and re-assigns its legs to their remaining fixtures next round; legs merely outside a priced
  // subset fall out for good (keep their result cards).
  // ponytail: 3 reassign rounds — a chain of 3 fully-refused events leaves the tail legs un-combined.
  const survivors = new Set<number>();
  let product = 1;
  const banned = new Set<number>();
  let pending = new Set(legPicks.map((_, i) => i));
  for (let round = 0; round < 3 && pending.size; round++) {
    const groups = assign(pending, banned);
    const priced = await Promise.all(groups.map(([eid, ids]) =>
      ids.length >= 2
        ? priceLargest(eid, ids, priceCombo, lang)
        : Promise.resolve(byOutcome.get(ids[0]!)?.o.odds != null ? { ids, price: byOutcome.get(ids[0]!)!.o.odds! } : null)));
    pending = new Set();
    groups.forEach(([eid, ids], i) => {
      const p = priced[i];
      if (p == null) { banned.add(eid); for (const id of ids) pending.add(legOf(id)); return; }
      product *= p.price / 1000;
      for (const id of p.ids) survivors.add(id);
    });
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
