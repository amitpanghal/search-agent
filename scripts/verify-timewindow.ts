// verify-timewindow — deterministic check of recall.finalize: the post-fetch time/next-game filter that runs
// only on MATCH-tagged events. No network. Synthetic events (a COMPETITION outright + several MATCH fixtures
// at different kickoffs + a past fixture) + one offer each.
//   tsx scripts/verify-timewindow.ts
import { finalize } from "../src/resolver/recall";
import { resolveTimeWindow, type TimeWindow } from "../src/resolver/time-window";
import type { BetOffer, KEvent } from "../src/resolver/offering-client";

const ev = (id: number, tags: string[], start: string): KEvent => ({ id, name: `ev${id}`, tags, start });
const offer = (eventId: number, critId: number, label: string): BetOffer =>
  ({ eventId, criterion: { id: critId, label }, outcomes: [{ id: critId * 10, label: "x" }] } as BetOffer);

// COMPETITION outright (has a start too — must survive on the TAG, not the kickoff) + 3 fixtures + 1 past.
const COMP = ev(900, ["COMPETITION"], "2026-06-23T03:00:00Z");
const M1 = ev(901, ["MATCH"], "2026-06-26T18:00:00Z"); // earliest upcoming
const M2 = ev(902, ["MATCH"], "2026-07-01T18:00:00Z"); // later
const PAST = ev(903, ["MATCH"], "2020-01-01T00:00:00Z"); // before now -> dropped by from=now
const events = [COMP, M1, M2, PAST];
const offers = [offer(900, 1, "Top Scorer"), offer(901, 2, "Half Time/Full Time"), offer(902, 3, "Match Result"), offer(903, 4, "BTTS")];

const NOW = new Date("2026-06-24T00:00:00Z");
const labels = (r: ReturnType<typeof finalize>) => r.menu.map((m) => m.label).sort();
const evIds = (r: ReturnType<typeof finalize>) => r.data.events.map((e) => e.id).sort((a, b) => a - b);

let pass = 0, fail = 0;
function check(desc: string, got: unknown, expect: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${desc}  -> ${JSON.stringify(got)}${ok ? "" : ` (expect ${JSON.stringify(expect)})`}`);
  ok ? pass++ : fail++;
}

// Part A sanity: resolveTimeWindow turns "next game" into {from: now, pick: earliest/1}
const wNext = resolveTimeWindow({ date_window: null, kickoff_time_of_day: null, fixture_pick: { order: "earliest", count: 1 } }, { now: NOW });
check("resolveTimeWindow(next game).pick", wNext.pick, { order: "earliest", count: 1 });
check("resolveTimeWindow(next game).from set", wNext.from != null, true);

const run = (w?: TimeWindow) => finalize("participant", offers, events, false, w);

console.log("\nnext game (earliest/1):");
const a = run(wNext);
check("events = COMP + earliest fixture (M1)", evIds(a), [900, 901]);
check("menu = Top Scorer + HT/FT (M2 & past dropped)", labels(a), ["Half Time/Full Time", "Top Scorer"]);

console.log("\nlatest/1:");
const b = run({ from: NOW, pick: { order: "latest", count: 1 } });
check("events = COMP + latest fixture (M2)", evIds(b), [900, 902]);

console.log("\nnext 2 (earliest/2):");
const c = run({ from: NOW, pick: { order: "earliest", count: 2 } });
check("events = COMP + M1 + M2 (past still dropped by from=now)", evIds(c), [900, 901, 902]);

console.log("\nno window -> passthrough:");
const d = run(undefined);
check("all events kept", evIds(d), [900, 901, 902, 903]);

console.log("\ndate window only (tomorrow = 06-25..06-26), no pick:");
const e = run({ from: new Date("2026-06-25T00:00:00Z"), to: new Date("2026-06-26T23:59:59Z") });
check("COMP kept (tag), only M1 in window", evIds(e), [900, 901]);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
