// verify-timewindow — deterministic check of recall.scopeMenu: the per-leg post-fetch narrowing that replaced
// finalize (per-leg-scope Phase 5). No network. Synthetic events (a COMPETITION outright + MATCH fixtures at
// different kickoffs + a past fixture, all one group; plus a second-group outright) + one offer each. Covers the
// time/next-game pick (unchanged logic) AND the new per-leg filters: grain (level tag) and competition (groupId).
//   tsx scripts/verify-timewindow.ts
import { scopeMenu } from "../src/resolver/recall";
import { resolveTimeWindow } from "../src/resolver/time-window";
import type { EntityResolution, ResolvedLegScope } from "../src/resolver/ground-scope";
import type { Scope } from "../src/resolver/schema";
import type { BetOffer, KEvent } from "../src/resolver/offering-client";

const ev = (id: number, tags: string[], start: string, groupId: number, teams: number[] = []): KEvent =>
  ({ id, name: `ev${id}`, tags, start, groupId, participants: teams.map((t) => ({ participantId: t, participantType: "TEAM" })) } as KEvent);
const offer = (eventId: number, critId: number, label: string): BetOffer =>
  ({ eventId, criterion: { id: critId, label }, outcomes: [{ id: critId * 10, label: "x" }] } as BetOffer);

// One group (10): a COMPETITION outright + 3 fixtures (M1 earliest, M2 later, PAST before now). A second group
// (20) outright for the groupId filter. Teams: M1 {1,2}, M2 {1,3}, PAST {5,6}.
const COMP = ev(900, ["COMPETITION"], "2026-06-23T03:00:00Z", 10);
const M1 = ev(901, ["MATCH"], "2026-06-26T18:00:00Z", 10, [1, 2]);
const M2 = ev(902, ["MATCH"], "2026-07-01T18:00:00Z", 10, [1, 3]);
const PAST = ev(903, ["MATCH"], "2020-01-01T00:00:00Z", 10, [5, 6]);
const COMP20 = ev(904, ["COMPETITION"], "2026-06-23T03:00:00Z", 20);
const events = [COMP, M1, M2, PAST];
const offers = [offer(900, 1, "Top Scorer"), offer(901, 2, "Half Time/Full Time"), offer(902, 3, "Match Result"), offer(903, 4, "BTTS")];

const NOW = new Date("2026-06-24T00:00:00Z");
const conf = (id: number): EntityResolution => ({ text: String(id), tier: "confident", candidates: [{ id, name: String(id), score: 1 }] });
const leg = (over: Partial<ResolvedLegScope> = {}): ResolvedLegScope => ({
  region: null, competition: null, level: "fixture", stage: null, time: null, playState: null,
  teams: [], players: [], playerRoles: [], subjectPlayer: null, ...over,
});
const pick = (order: "earliest" | "latest", count: number): NonNullable<Scope["time"]> => ({ date_window: null, kickoff_time_of_day: null, fixture_pick: { order, count } });
const run = (l: ResolvedLegScope, evs: KEvent[] = events) => scopeMenu({ betOffers: offers, events: evs }, l, { now: NOW });
const evIds = (r: ReturnType<typeof scopeMenu>) => r.events.map((e) => e.id).sort((a, b) => a - b);

let pass = 0, fail = 0;
function check(desc: string, got: unknown, expect: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${desc}  -> ${JSON.stringify(got)}${ok ? "" : ` (expect ${JSON.stringify(expect)})`}`);
  ok ? pass++ : fail++;
}

console.log("resolveTimeWindow sanity:");
const wNext = resolveTimeWindow(pick("earliest", 1), { now: NOW });
check("next game .pick", wNext.pick, { order: "earliest", count: 1 });
check("next game .from set", wNext.from != null, true);

// A FIXTURE leg drops the COMPETITION outright (900) via the grain filter — it wants matches, not the outright.
console.log("\ntime / next-game pick (fixture leg: matches only, COMP dropped by grain):");
check("next game (earliest/1) -> M1", evIds(run(leg({ time: pick("earliest", 1) }))), [901]);
check("latest/1 -> M2", evIds(run(leg({ time: pick("latest", 1) }))), [902]);
check("earliest/2 -> M1 + M2 (PAST dropped by from=now)", evIds(run(leg({ time: pick("earliest", 2) }))), [901, 902]);
check("no time -> all matches kept (incl PAST)", evIds(run(leg({}))), [901, 902, 903]);

console.log("\nper-leg grain (level tag) + co-occurrence:");
check("competition leg -> only COMP outright (matches dropped)", evIds(run(leg({ level: "competition" }))), [900]);
check("co-occurrence teams {1,3} -> M2 only", evIds(run(leg({ teams: [conf(1), conf(3)] }))), [902]);

console.log("\nper-leg competition (groupId):");
check("competition=group10 -> drops group20 outright", evIds(run(leg({ level: "competition", competition: conf(10) }), [COMP, COMP20])), [900]);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
