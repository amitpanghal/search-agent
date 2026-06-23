// .verify-postfilters — OFFLINE check of the two new post-filters (no network, no LLM):
//   (1) odds [min,max] bound in select.ts  — driven against REAL captured outcomes from the snapshot
//   (2) time-window filter (date_window / kickoff / fixture_pick) — driven against synthetic fixtures
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { select } from "../src/resolver/select";
import { resolveTimeWindow, filterEventsByTime } from "../src/resolver/time-window";
import type { BetOffer, KEvent, KOutcome } from "../src/resolver/offering-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(HERE, "../src/eval/live-menu.snapshot.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "  ok" : "x FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

// ---------- (1) ODDS BOUND ----------
const allBo: BetOffer[] = [...snap.competition.betOffers, ...snap.match.betOffers];
const oddsOf = (o: KOutcome) => (o.odds != null ? o.odds / 1000 : null);
// a market with >=2 distinctly-priced outcomes, so a mid bound actually splits them
const bo = allBo.find((b) => {
  const ds = (b.outcomes ?? []).map(oddsOf).filter((d): d is number => d != null);
  return new Set(ds).size >= 2;
})!;
const ev = snap.match.events.find((e: KEvent) => e.id === bo.eventId) ?? snap.competition.events[0];
const slice = { events: [ev], betOffers: [bo] };
const prices = (bo.outcomes ?? []).map(oddsOf).filter((d): d is number => d != null).sort((a, b) => a - b);
const mid = prices[Math.floor(prices.length / 2)]!;
const oddsById = new Map((bo.outcomes ?? []).map((o) => [o.id, oddsOf(o)] as const));
console.log(`ODDS BOUND — market "${bo.criterion?.label}", prices [${prices.join(", ")}], mid=${mid}`);

const selMin = select(slice, { oddsMin: mid });
ok("oddsMin=mid -> picked price >= mid", selMin.outcomeId != null && (oddsById.get(selMin.outcomeId) ?? 0) >= mid, `picked ${oddsById.get(selMin.outcomeId!)}`);

const selMax = select(slice, { oddsMax: mid });
ok("oddsMax=mid -> picked price <= mid", selMax.outcomeId != null && (oddsById.get(selMax.outcomeId) ?? 99) <= mid, `picked ${oddsById.get(selMax.outcomeId!)}`);

const selNone = select(slice, { oddsMin: prices[prices.length - 1]! + 100 });
ok("impossible floor -> fallback 'odds-absent', no outcome", selNone.fallback === "odds-absent" && selNone.outcomeId == null);

const selBase = select(slice, {});
ok("no bound -> still picks an outcome (no regression)", selBase.outcomeId != null);

// ---------- (2) TIME WINDOW ----------
// synthetic fixtures around a fixed 'now' = Thu 2026-06-18 12:00Z
const now = new Date("2026-06-18T12:00:00Z");
const mk = (id: number, iso: string): KEvent => ({ id, name: `E${id}`, start: iso } as KEvent);
const evs: KEvent[] = [
  mk(1, "2026-06-18T20:00:00Z"), // today, 20:00 (after 8pm)
  mk(2, "2026-06-19T15:00:00Z"), // tomorrow, 15:00
  mk(3, "2026-06-20T18:00:00Z"), // Sat (weekend)
  mk(4, "2026-06-21T18:00:00Z"), // Sun (weekend)
  mk(5, "2026-06-25T18:00:00Z"), // next week
];
const ids = (xs: KEvent[]) => xs.map((e) => e.id).sort((a, b) => a! - b!).join(",");
const win = (time: any) => resolveTimeWindow(time, { now, tournamentStart: now });
const filt = (time: any) => filterEventsByTime(evs, win(time));

console.log("\nTIME WINDOW — synthetic fixtures (now = Thu 2026-06-18 12:00Z)");
ok("tomorrow -> only the 19th", ids(filt({ date_window: { value: "tomorrow", anchor: "now" } })) === "2");
ok("weekend -> Sat+Sun (20,21)", ids(filt({ date_window: { value: "weekend", anchor: "now" } })) === "3,4");
ok("next_2_days -> within 48h (today+tomorrow)", ids(filt({ date_window: { value: "next_2_days", anchor: "now" } })) === "1,2");
ok("kickoff after 8pm -> only the 20:00 game", ids(filt({ kickoff_time_of_day: "after 8pm" })) === "1");

// fixture_pick is applied in resolve.ts (earliest/latest N over the window survivors); here assert the window
// it produces lower-bounds at now (no past games) so the pick never reaches backwards.
const wp = win({ fixture_pick: { order: "earliest", count: 2 } });
ok("fixture_pick sets pick + now lower-bound", wp.pick?.order === "earliest" && wp.pick?.count === 2 && wp.from != null);

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
