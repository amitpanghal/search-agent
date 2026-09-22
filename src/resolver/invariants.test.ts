// The load-bearing invariants of the deterministic (zero-LLM, zero-network) stages, as runnable asserts.
// Free to run — no Bedrock, no Kambi. This is the ONLY gate that costs nothing, so it guards the rules that
// would otherwise regress silently between paid eval runs:
//   1. never drop a row on MISSING data (under-dropping is safe, over-dropping loses the right answer)
//   2. diacritic folding is symmetric and never eats a non-decomposable letter
//   3. the day/hour calendar is read in the USER's zone, the instants stay UTC
// Run: npm test

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeWindow, eventMatchesTime, applyFixturePick, filterEventsByTime } from "./time-window";
import { fold, contentTokens, lc, stripSettle } from "./lexical";
import type { BetOffer, KEvent } from "./offering-client";
import { buildBetslip } from "./combinations";
import { resolveMarkets, decideWithJev } from "./resolve-market";
import type { ResolvedLeg, Menu } from "./live-menu-types";
import { readFileSync } from "node:fs";
import { queryNamesSport, adoptSport, resolveEntities } from "./resolve-entities";
import { propagate, retier, byProminence, type Candidate } from "./ground-scope";
import { execute } from "./execute";
import { summarizeCost, usageStore, type RawCall } from "./cost";
import { traceStore, type TraceEvent } from "./trace";

// Set env vars for the duration of fn, then put back exactly what was there (delete, never the string
// "undefined") — the cost and the entity gate read process.env at call time.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) v === undefined ? delete process.env[k] : (process.env[k] = v); };
  set(vars);
  try { return await fn(); } finally { set(prev); }
}

const ev = (id: number, start?: string, state?: string): KEvent => ({ id, ...(start && { start }), ...(state && { state }) });
// The extractor's time field has all three keys, nullable — spell the absent ones so the tests type-check.
type TimeField = NonNullable<NonNullable<Parameters<typeof resolveTimeWindow>[0]>>;
const tf = (t: Partial<TimeField>): TimeField =>
  ({ date_window: null, kickoff_time_of_day: null, fixture_pick: null, ...t });
const NOW = new Date("2026-06-18T12:00:00Z"); // a Thursday

// ---- invariant 1: lenient on missing data -------------------------------------------------------------
test("an event with no start survives every window", () => {
  const w = resolveTimeWindow(tf({ date_window: { value: "tomorrow", anchor: "now" } }), { now: NOW });
  assert.ok(w.from && w.to, "tomorrow must resolve to a window");
  assert.equal(eventMatchesTime(ev(1), w, []), true);
});

test("originalStartDate is used when start is absent", () => {
  const w = resolveTimeWindow(tf({ date_window: { value: "today", anchor: "now" } }), { now: NOW });
  const stale: KEvent = { id: 1, originalStartDate: "2026-06-18T19:00:00Z" };
  assert.equal(eventMatchesTime(stale, w, []), true);
  const other: KEvent = { id: 2, originalStartDate: "2026-06-25T19:00:00Z" }; // next week -> out
  assert.equal(eventMatchesTime(other, w, []), false);
});

test("a live match survives a now-floored window but not a future-day one", () => {
  const started = ev(1, "2026-06-18T10:00:00Z", "STARTED"); // kicked off before `now`
  const today = resolveTimeWindow(tf({ date_window: { value: "today", anchor: "now" } }), { now: NOW });
  assert.equal(today.liveOk, true);
  assert.equal(eventMatchesTime(started, today, []), true);

  const tomorrow = resolveTimeWindow(tf({ date_window: { value: "tomorrow", anchor: "now" } }), { now: NOW });
  assert.equal(tomorrow.liveOk, false);
  assert.equal(eventMatchesTime(started, tomorrow, []), false);
});

test("an unparseable phrase is flagged unresolved, not silently ignored", () => {
  const w = resolveTimeWindow(tf({ date_window: { value: "some_friday_ish", anchor: "now" } }), { now: NOW });
  assert.equal(w.unresolved, true);
  assert.equal(w.unresolvedPhrase, "some_friday_ish");
  assert.equal(w.from, undefined);
});

test("a tournament-anchored phrase with no tournamentStart drops the window, keeps the kickoff band", () => {
  const w = resolveTimeWindow(
    tf({ date_window: { value: "weekend", anchor: "tournament" }, kickoff_time_of_day: "after 8pm" }),
    { now: NOW },
  );
  assert.equal(w.from, undefined);
  assert.equal(w.unresolved, undefined);
  assert.deepEqual(w.kickoff, { afterHour: 20 });
});

// ---- invariant 3: the calendar is the user's, the instants are UTC ------------------------------------
test("the kickoff hour band reads in the user's zone, not UTC", () => {
  const time = tf({ date_window: { value: "today", anchor: "now" }, kickoff_time_of_day: "after 8pm" });
  const game = ev(1, "2026-06-18T18:30:00Z"); // 20:30 in Stockholm (UTC+2), 18:30 UTC

  const local = resolveTimeWindow(time, { now: NOW, tz: "Europe/Stockholm" });
  assert.equal(eventMatchesTime(game, local, []), true, "20:30 local is after 8pm");

  const utc = resolveTimeWindow(time, { now: NOW });
  assert.equal(eventMatchesTime(game, utc, []), false, "18:30 UTC is not after 8pm");
});

test("a day boundary is the user's midnight", () => {
  // 23:30 Thu in Stockholm = 21:30Z Thu. For a UTC user that is still Thursday; both call it today.
  // 00:30 Fri in Stockholm = 22:30Z Thu — tomorrow locally, still today in UTC.
  const justPastMidnightLocal = ev(1, "2026-06-18T22:30:00Z");
  const today = tf({ date_window: { value: "today", anchor: "now" } });

  const se = resolveTimeWindow(today, { now: NOW, tz: "Europe/Stockholm" });
  assert.equal(eventMatchesTime(justPastMidnightLocal, se, []), false);

  const utc = resolveTimeWindow(today, { now: NOW });
  assert.equal(eventMatchesTime(justPastMidnightLocal, utc, []), true);
});

test("late/early is relative to the other kickoffs that day", () => {
  const events = [ev(1, "2026-06-18T13:00:00Z"), ev(2, "2026-06-18T16:00:00Z"), ev(3, "2026-06-19T20:00:00Z")];
  const late = resolveTimeWindow(tf({ kickoff_time_of_day: "late" }), { now: NOW });
  // 16:00 is the last kickoff on the 18th; the 19th's 20:00 is a different day and is also its own latest.
  assert.deepEqual(filterEventsByTime(events, late).map((e) => e.id), [2, 3]);
});

// ---- fixture pick -----------------------------------------------------------------------------------
test("fixture pick orders by kickoff and drops events it cannot order", () => {
  const events = [ev(3, "2026-06-20T12:00:00Z"), ev(1, "2026-06-18T12:00:00Z"), ev(2, "2026-06-19T12:00:00Z"), ev(9)];
  assert.deepEqual(applyFixturePick(events, { order: "earliest", count: 2 }).map((e) => e.id), [1, 2]);
  assert.deepEqual(applyFixturePick(events, { order: "latest", count: 1 }).map((e) => e.id), [3]);
});

test("a fixture pick floors the window at now so past fixtures never win", () => {
  const w = resolveTimeWindow(tf({ fixture_pick: { order: "earliest", count: 1 } }), { now: NOW });
  assert.equal(+w.from!, +NOW);
  assert.equal(w.liveOk, false, "'next game' stays strictly upcoming");
});

// ---- invariant 2: diacritic folding -----------------------------------------------------------------
test("fold collapses accents and keeps non-decomposable letters", () => {
  assert.equal(fold("Müller"), fold("Muller"));
  assert.equal(fold("Ødegaard"), "odegaard"); // NOT "degaard"
  assert.equal(fold("Łukasz"), "lukasz");
  assert.equal(fold("Weiß"), "weiss");
  assert.equal(fold("N'Golo Kanté"), "n golo kante");
});

test("lc drops apostrophes where fold splits on them", () => {
  assert.equal(lc("N'Golo"), "ngolo");
  assert.equal(stripSettle("Total Goals (settled at full time)").trim(), "Total Goals");
});

test("content tokens fold women's markers, decompound goalscorer, and singularize", () => {
  const wc = contentTokens("Women's World Cup");
  assert.deepEqual([...contentTokens("World Cup (W)")].sort(), [...wc].sort());
  assert.ok(contentTokens("Goalscorer").has("scorer"));
  assert.deepEqual([...contentTokens("Goalscorer")].sort(), [...contentTokens("Goal Scorers")].sort());
  assert.equal(contentTokens("the a of to").size, 0, "stopwords carry no content");
});

// ---- RC-B guard: a stated sport word locks cross-sport widening ----------------------------------------
test("a stated sport word locks widening; a guessed sport doesn't", () => {
  assert.equal(queryNamesSport("czech republic turkey womens basketball winner", "basketball"), true);
  assert.equal(queryNamesSport("steelers to cover the spread", "american-football"), false);
  assert.equal(queryNamesSport("ice hockey scores tonight", "ice-hockey"), true);
});

// ---- squad-aware competition grounding: "<name> Women" twin groups -------------------------------------
// Uses the committed tennis catalog (disk read, zero network). Kambi keeps gendered editions as separate
// groups ("US Open" vs "US Open Women"); the squad marker must pick the twin, and must NEVER degrade the
// bare name when no twin matches (squad "men" has no twin -> falls back to the men's group).
import { groundScope } from "./ground-scope";
import type { QueryPlan } from "./schema";

const planFor = (squad: string | null): QueryPlan => ({
  sport: "tennis",
  selectors: [{
    subject: { kind: "event" },
    market_concept: "who wins",
    scope: { teams: [], players: [], competition: "US Open", region: null, level: "competition", stage: null, squad, time: null, play_state: null },
  }],
} as QueryPlan);

test("squad 'women' grounds the competition to its Women twin; null and 'men' keep the men's group", () => {
  const women = groundScope(planFor("women")).legs[0]!.competition!;
  assert.equal(women.tier, "confident");
  assert.equal(women.candidates[0]!.name, "US Open Women");

  for (const squad of [null, "men"]) {
    const comp = groundScope(planFor(squad)).legs[0]!.competition!;
    assert.equal(comp.tier, "confident", `squad=${squad} must stay confident`);
    assert.equal(comp.candidates[0]!.name, "US Open", `squad=${squad} must keep the men's group`);
  }
});

// ---- pair grounding: doubles pairs are players-table entries; multi-surname queries must reach them ----
import { groundTeam, groundPlayer } from "./ground-scope";
import { loadScopeCatalog } from "./scope-catalog";

test("pair phrasings ground to the pair entry; single names keep the old ladder", () => {
  const cat = loadScopeCatalog("tennis");
  const pair = /granollers.*zeballos|zeballos.*granollers/i;
  for (const q of ["Granollers/Zeballos", "Granollers and Zeballos", "Marcel Granollers and Horacio Zeballos", "Granollers y Zeballos"]) {
    const r = groundTeam(q, cat);
    assert.equal(r.tier, "confident", `${q} must ground confident`);
    assert.match(r.candidates[0]!.name, pair, q);
  }
  // regression guards: exact and single/initial names keep today's behavior
  assert.equal(groundTeam("Marcel Granollers", cat).candidates[0]!.name, "Marcel Granollers");
  assert.equal(groundTeam("Spain", cat).candidates[0]!.name, "Spain");
  assert.ok(groundPlayer("R. Matos", cat).candidates.some((c) => c.name === "Rafael Matos"),
    "R. Matos must still shortlist the singles player, not only pairs");
});

test("pair join: two weak partner mentions both gain the joint pair candidate", () => {
  const plan = {
    sport: "tennis",
    selectors: [{
      subject: { kind: "event" },
      market_concept: "who wins",
      scope: { teams: ["Nys", "Roger-Vasselin"], players: [], competition: null, region: null, level: "fixture", stage: null, squad: null, time: null, play_state: null },
    }],
  } as QueryPlan;
  const { legs } = groundScope(plan);
  const joint = /nys.*roger.*vasselin/i;
  for (const t of legs[0]!.teams) {
    assert.ok(t.candidates.some((c) => joint.test(c.name)), `"${t.text}" must carry the joint pair candidate`);
    assert.notEqual(t.tier, "none");
  }
});

// ---- betslip subset search: ONE biggest combo, earliest-legs tie-break ----------------------------------
// 4 picks on one fixture; the fake priceCombo decides combinability, so no network and the call pattern is
// observable (round 1 = full set, round 2 = the four triples in parallel, pairs never reached).
const slipFixture = () => {
  const offers = [1, 2, 3, 4].map((id) => ({
    id: 10 + id, eventId: 100, criterion: { id, englishLabel: `M${id}` },
    outcomes: [{ id, odds: 2000, englishLabel: `O${id}` }],
  })) as BetOffer[];
  const legs: ResolvedLeg[] = [1, 2, 3, 4].map((id) => ({ phrase: `leg${id}`, pick: { label: `M${id}`, match: "exact" }, selection: { outcomeId: id } }));
  return { legs, offers, events: [{ id: 100, tags: ["MATCH"] }] as KEvent[] };
};

test("betslip: one toxic leg falls out, the biggest combo prices in 2 rounds", async () => {
  const { legs, offers, events } = slipFixture();
  const calls: number[][] = [];
  const slip = await buildBetslip(legs, offers, events, async (_e, ids) => { calls.push(ids); return ids.includes(4) ? null : 15000; });
  assert.deepEqual(slip?.legs.map((l) => l.outcomeId), [1, 2, 3]); // pen-style leg 4 excluded, not the whole group
  assert.equal(slip?.odds, 15000);
  assert.equal(calls.length, 5); // full set + the 4 triples; pairs never tried
});

test("betslip tie-break: among same-size combinable subsets, keep the earliest-mentioned legs", async () => {
  const { legs, offers, events } = slipFixture();
  // legs 1 and 2 conflict with EACH OTHER; every set avoiding that pair prices. [1,3,4] must beat [2,3,4].
  const slip = await buildBetslip(legs, offers, events, async (_e, ids) => (ids.includes(1) && ids.includes(2) ? null : 12000));
  assert.deepEqual(slip?.legs.map((l) => l.outcomeId), [1, 3, 4]); // drops the later-mentioned conflicting leg
});

// ---- betslip event assignment: one pick per LEG, shared event first, refusal re-assigns ------------------
// Two fan-out legs ("City to win" + "Haaland to score") each pick one outcome per fixture across the same
// events; the slip must be ONE correlated pair on the soonest shared fixture — never a 2N-leg accumulator.
const fanoutFixture = () => {
  // events 100 (soonest) and 200; leg A picks 1@100 / 2@200, leg B picks 3@100 / 4@200.
  const offers = [
    { id: 11, eventId: 100, criterion: { id: 1, englishLabel: "Full Time" }, outcomes: [{ id: 1, odds: 1200 }] },
    { id: 12, eventId: 200, criterion: { id: 1, englishLabel: "Full Time" }, outcomes: [{ id: 2, odds: 1500 }] },
    { id: 13, eventId: 100, criterion: { id: 2, englishLabel: "To Score" }, outcomes: [{ id: 3, odds: 1600 }] },
    { id: 14, eventId: 200, criterion: { id: 2, englishLabel: "To Score" }, outcomes: [{ id: 4, odds: 1700 }] },
  ] as BetOffer[];
  const legs: ResolvedLeg[] = [
    { phrase: "city to win", pick: { label: "Full Time", match: "exact" }, selection: { outcomeId: 1, selectedIds: [1, 2] } },
    { phrase: "haaland to score", pick: { label: "To Score", match: "exact" }, selection: { outcomeId: 3, selectedIds: [3, 4] } },
  ];
  const events = [
    { id: 100, tags: ["MATCH"], start: "2026-09-05T14:00:00Z" },
    { id: 200, tags: ["MATCH"], start: "2026-09-08T19:00:00Z" },
  ] as KEvent[];
  return { legs, offers, events };
};

test("betslip: two fan-out legs collapse to ONE correlated pair on the soonest shared fixture", async () => {
  const { legs, offers, events } = fanoutFixture();
  const calls: [number, number[]][] = [];
  const slip = await buildBetslip(legs, offers, events, async (e, ids) => { calls.push([e, ids]); return 2030; });
  assert.deepEqual(calls, [[100, [1, 3]]]); // one correlated call, soonest event only — never an accumulator
  assert.equal(slip?.odds, 2030);
  assert.deepEqual(slip?.legs.map((l) => [l.eventId, l.outcomeId]), [[100, 1], [100, 3]]);
});

test("betslip: a refused shared event re-assigns its legs — rivals who meet next still get their double", async () => {
  const { legs, offers, events } = fanoutFixture(); // shared event 100 refuses (e.g. City win + Liverpool win same game)
  const slip = await buildBetslip(legs, offers, events, async (e) => (e === 100 ? null : 9999));
  // both legs fall back to event 200: still same-event there -> one correlated group on the next fixture
  assert.deepEqual(slip?.legs.map((l) => [l.eventId, l.outcomeId]), [[200, 2], [200, 4]]);
  assert.equal(slip?.odds, 9999);
});

test("betslip: a leg re-assigned onto an already-priced event re-prices correlated, never multiplies", async () => {
  // Leg A fans out over both fixtures; B is ev100-only, C is ev200-only. Event 100 (soonest, wins the tie,
  // takes A+B) refuses whole, so A re-assigns to ev200 — where C already priced as a single. The two picks now
  // share an event: they must go back through the correlated API, never multiply as two independent singles.
  const offers = [
    { id: 11, eventId: 100, criterion: { id: 1, englishLabel: "Full Time" }, outcomes: [{ id: 1, odds: 1200 }] },
    { id: 12, eventId: 200, criterion: { id: 1, englishLabel: "Full Time" }, outcomes: [{ id: 2, odds: 1500 }] },
    { id: 13, eventId: 100, criterion: { id: 2, englishLabel: "To Score" }, outcomes: [{ id: 3, odds: 1600 }] },
    { id: 14, eventId: 200, criterion: { id: 3, englishLabel: "Corners" }, outcomes: [{ id: 4, odds: 1700 }] },
  ] as BetOffer[];
  const legs: ResolvedLeg[] = [
    { phrase: "A", pick: { label: "Full Time", match: "exact" }, selection: { outcomeId: 1, selectedIds: [1, 2] } },
    { phrase: "B", pick: { label: "To Score", match: "exact" }, selection: { outcomeId: 3 } },
    { phrase: "C", pick: { label: "Corners", match: "exact" }, selection: { outcomeId: 4 } },
  ];
  const events = [
    { id: 100, tags: ["MATCH"], start: "2026-09-05T14:00:00Z" },
    { id: 200, tags: ["MATCH"], start: "2026-09-08T19:00:00Z" },
  ] as KEvent[];
  const calls: [number, number[]][] = [];
  const slip = await buildBetslip(legs, offers, events, async (e, ids) => { calls.push([e, ids]); return e === 100 ? null : 9999; });
  assert.deepEqual(calls, [[100, [1, 3]], [200, [2, 4]]]); // the merged ev200 pair IS re-priced correlated
  assert.equal(slip?.odds, 9999); // the joint price, never 1.5 × 1.7 = 2550
  assert.deepEqual(slip?.legs.map((l) => [l.eventId, l.outcomeId]), [[200, 2], [200, 4]]);
});

test("betslip: legs on disjoint events multiply as a genuine cross-event double", async () => {
  const offers = [
    { id: 11, eventId: 100, criterion: { id: 1, englishLabel: "Full Time" }, outcomes: [{ id: 1, odds: 2000 }] },
    { id: 12, eventId: 200, criterion: { id: 1, englishLabel: "Full Time" }, outcomes: [{ id: 2, odds: 3000 }] },
  ] as BetOffer[];
  const legs: ResolvedLeg[] = [
    { phrase: "city to win", pick: { label: "Full Time", match: "exact" }, selection: { outcomeId: 1 } },
    { phrase: "liverpool to win", pick: { label: "Full Time", match: "exact" }, selection: { outcomeId: 2 } },
  ];
  const events = [{ id: 100, tags: ["MATCH"] }, { id: 200, tags: ["MATCH"] }] as KEvent[];
  let called = false;
  const slip = await buildBetslip(legs, offers, events, async () => { called = true; return null; });
  assert.equal(called, false); // singles use their own odds — the correlated API is never hit
  assert.equal(slip?.odds, 6000); // 2.0 × 3.0
  assert.deepEqual(slip?.legs.map((l) => l.outcomeId), [1, 2]);
});

// ---------------------------------------------------------------------------------------------------------
// SELECT: margin asks and zero-of-the-stat — "win by 2+" lands the -(N-0.5) handicap rung, "not scoring"
// lands Under 0.5 on an anonymous over/under ladder (not a subject-absent).
import { select } from "./select";

test("select: 'win by 2 or more' picks the subject's -1.5 handicap rung, not the nearest-to-+2", () => {
  const hcp = (id: number, line: number): BetOffer => ({
    id, eventId: 9, betOfferType: { id: 1 }, criterion: { label: "Handicap" },
    outcomes: [
      { id: id * 10 + 1, type: "OT_ONE", line, participant: "Barca", participantId: 160 },
      { id: id * 10 + 2, type: "OT_CROSS", line },
      { id: id * 10 + 3, type: "OT_TWO", line },
    ],
  }) as unknown as BetOffer;
  const slice = { events: [{ id: 9 }] as KEvent[], betOffers: [hcp(1, -500), hcp(2, -1500), hcp(3, -2500)] };
  const sel = select(slice, { subjectId: 160, lineValue: 2, dir: "at_least" });
  assert.equal(sel.line, -1.5);
  assert.equal(sel.outcomeId, 21);
});

test("select: 'not scoring' on an anonymous team-total ladder picks Under 0.5, not subject-absent", () => {
  const ou = (id: number, line: number): BetOffer => ({
    id, eventId: 9, betOfferType: { id: 6 }, criterion: { label: "Total Goals by Rayo" },
    outcomes: [
      { id: id * 10 + 1, type: "OT_OVER", line },
      { id: id * 10 + 2, type: "OT_UNDER", line },
    ],
  }) as unknown as BetOffer;
  const slice = { events: [{ id: 9 }] as KEvent[], betOffers: [ou(1, 500), ou(2, 1500)] };
  const sel = select(slice, { subjectId: 214, subject: "Rayo", dir: "no" });
  assert.equal(sel.fallback, undefined);
  assert.equal(sel.line, 0.5);
  assert.equal(sel.outcomeId, 12);
});

test("select: zero-of-the-stat needs the real 0.5 rung — a ladder starting higher degrades honestly", () => {
  // Under 8.5 PAYS on eight corners — a different bet from "no corners". No 0.5 rung -> honest absent,
  // never the nearest rung shipped as a confident pick. Same for "yes": Over 8.5 is not "to score".
  const ou = (id: number, line: number): BetOffer => ({
    id, eventId: 9, betOfferType: { id: 6 }, criterion: { label: "Total Corners" },
    outcomes: [
      { id: id * 10 + 1, type: "OT_OVER", line },
      { id: id * 10 + 2, type: "OT_UNDER", line },
    ],
  }) as unknown as BetOffer;
  const slice = { events: [{ id: 9 }] as KEvent[], betOffers: [ou(1, 8500), ou(2, 9500), ou(3, 10500)] };
  for (const dir of ["no", "yes"] as const) {
    const sel = select(slice, { dir });
    assert.equal(sel.outcomeId, undefined, `dir=${dir} must not pick a far rung`);
    assert.ok(sel.fallback, `dir=${dir} must degrade honestly`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// EXECUTE: a none-pick leg whose fixture menu EXISTED but was emptied by the subject filter must say the
// SUBJECT is absent (naming the grounded person, so a wrong grounding is visible and correctable) — never the
// false "no market is available". The generic no-market wording stays for a genuinely missing concept.
test("execute: subject-absent clarify names the resolved subject, not a missing market", () => {
  const leg = (unavailable: ResolvedLeg["unavailable"]): ResolvedLeg => ({ phrase: "to score", pick: { match: "none" }, unavailable });
  const run = (unavailable: ResolvedLeg["unavailable"]) =>
    execute({ legs: [leg(unavailable)], data: { events: [], betOffers: [] } }).clarificationNeeded ?? "";

  const absent = run({ kind: "subject-absent", subject: "Jamal Musiala", event: "FC Barcelona - Racing Santander" });
  assert.ok(absent.includes("Jamal Musiala"), "must name the grounded subject");
  assert.ok(absent.includes("FC Barcelona - Racing Santander"), "must name the fixture");
  assert.ok(!absent.includes("No \"to score\" market"), "must not claim the market is missing");

  const noMarket = run({ kind: "no-market" });
  assert.ok(noMarket.includes("No \"to score\" market"), "a genuinely missing concept keeps the old wording");
});

// ---------------------------------------------------------------------------------------------------------
// GROUNDER: the shortlist cap must run AFTER the constraint pass, never before — a candidate beyond the cap
// whose club IS the named team has to survive and settle the mention ("Lamine" is 13 wide, Yamal sits 6th).
test("grounder: a linked candidate beyond the shortlist cap survives the cross-check", () => {
  const p = (id: number, clubId: number): Candidate => ({ id, name: `P${id}`, score: 0.7, clubId, competitionIds: [] });
  const team: Candidate = { id: 100, name: "FC Barcelona", score: 1, clubId: 100, competitionIds: [] };
  // six same-first-name players; only the LAST (beyond the old cap of 5) belongs to the team.
  const players = [p(1, 11), p(2, 12), p(3, 13), p(4, 14), p(5, 15), p(6, 100)];
  const [kept] = propagate([players, [team]], 0);
  assert.deepEqual(kept!.map((c) => c.id), [6], "the strong club link must keep exactly the linked player");
  const res = retier({ text: "lamine", tier: "shortlist", candidates: players }, kept!);
  assert.equal(res.tier, "confident");
  assert.equal(res.candidates[0]!.id, 6);
  // uncapped seed, capped OUTPUT: an un-narrowed set still hands the entity gate at most 5 rows, not confident
  const wide = retier({ text: "x", tier: "shortlist", candidates: players }, players);
  assert.equal(wide.candidates.length, 5);
  assert.equal(wide.tier, "shortlist");
});

// ---------------------------------------------------------------------------------------------------------
// ENTITY GATE: a lone cross-sport pick must not flip the sport when anything settled in the HOME sport — a
// leg is never split across two sports (football Yamal + basketball Barcelona). No home evidence keeps the
// wrong-sport rescue alive; disagreeing foreign picks never flip.
test("entity gate: a lone foreign pick cannot flip the sport against home-settled evidence", () => {
  const foreign = new Map([[358, { sport: "basketball", cand: { id: 358, name: "FC Barcelona", score: 0.8 } }]]);
  const pick = (id: number, ref = "team:0") =>
    ({ kind: "settle-entity", ref, resolution: { text: "barcelona", tier: "confident", candidates: [{ id, name: "FC Barcelona", score: 0.8 }] } });
  const legHome = { teams: [], players: [], subjectPlayer: { text: "lamine", tier: "confident", candidates: [{ id: 7, name: "Lamine Yamal", score: 1 }] } };
  const legBare = { teams: [], players: [], subjectPlayer: null };
  assert.equal(adoptSport([pick(358)] as never, [legHome] as never, foreign as never), null, "home player vetoes");
  assert.equal(adoptSport([pick(358)] as never, [legBare] as never, foreign as never), "basketball", "rescue intact");
  const f2 = new Map([...foreign, [9, { sport: "ice-hockey", cand: { id: 9, name: "X", score: 0.8 } }]]);
  assert.equal(adoptSport([pick(358), pick(9, "team:1")] as never, [legBare] as never, f2 as never), null, "disagreement never flips");
});

// ---------------------------------------------------------------------------------------------------------
// GROUNDER: weak shortlists rank by live-competition breadth (a bare "Lamine" should surface Yamal, in 5
// comps, before a 1-comp namesake) — ties keep catalog order via stable sort.
test("grounder: weak shortlists rank by live-competition prominence", () => {
  const c = (id: number, comps: number[]): Candidate => ({ id, name: `C${id}`, score: 0.7, competitionIds: comps });
  assert.deepEqual([c(1, [1]), c(2, [1, 2, 3]), c(3, [1, 2])].sort(byProminence).map((x) => x.id), [2, 3, 1]);
});

// ---------------------------------------------------------------------------------------------------------
// ENTITY GATE: settling a name from a WEAK shortlist is a guess — the envelope must carry a non-blocking
// "Showing X — could also be Y" note naming the runners-up (results + hedge, never a silent wrong answer).
test("entity gate: a pick from a weak shortlist ships with a 'could also be' note", async () => {
  const scope = { sport: "football", legs: [{ region: null, competition: null, level: "fixture", stage: null,
    time: null, playState: null, teams: [], players: [], playerRoles: [], subjectPlayer: { text: "lamine",
    tier: "shortlist", candidates: [
      { id: 1, name: "Lamine A", score: 0.7, competitionIds: [1, 2] },
      { id: 2, name: "Lamine B", score: 0.7, competitionIds: [1] },
    ] } }] };
  const decide = async (_q: string, cells: { ref: string; candidates: { id: number }[] }[]) =>
    [{ ref: cells[0]!.ref, action: "pick", id: cells[0]!.candidates[0]!.id }];
  // the query NAMES the sport, so no cross-sport widening (keeps the test offline-cheap and deterministic)
  const settled = await resolveEntities("lamine to score football", scope as never, decide as never);
  assert.equal(settled.notes.length, 1);
  assert.ok(settled.notes[0]!.includes("Showing Lamine A"), settled.notes[0]);
  assert.ok(settled.notes[0]!.includes("Lamine B"), settled.notes[0]);
  assert.equal(settled.clarifications.length, 0);
});

// ---------------------------------------------------------------------------------------------------------
// ENTITY GATE: cross-sport widening runs the team AND the player grounder against every other sport's
// catalog; a row both of them hit was pushed twice, so the model (and the clarify) saw one entity as two.
// Pins names from the committed football/trotting catalogs: a `npm run catalogs` refresh that renames or
// drops an esports clone updates the expected list here, in the same change.
// The football plan whose team cell widens to 5 esports clones + a trotting horse (committed catalogs).
const tottenhamPlan = {
  sport: "football",
  selectors: [{
    subject: { kind: "team", name: "Tottenham Hotspur" },
    market_concept: "to win",
    scope: { teams: ["Tottenham Hotspur"], players: [], competition: null, region: null, level: "fixture", stage: null, squad: null, time: null, play_state: null },
  }],
} as QueryPlan;

test("entity gate: cross-sport widening lists each id once when the team and player grounders both hit", async () => {
  const seen: { ref: string; candidates: { id: number; name: string }[] }[] = [];
  const decide = async (_q: string, cells: { ref: string; candidates: { id: number; name: string }[] }[]) => {
    seen.push(...cells.map((c) => ({ ref: c.ref, candidates: c.candidates })));
    return [];
  };
  // the query names no sport word, so widening fires (queryNamesSport)
  const settled = await resolveEntities("Tottenham Hotspur to win", groundScope(tottenhamPlan) as never, decide as never);

  const cell = seen.find((c) => c.ref === "team:0")!;
  assert.ok(cell, `expected a team:0 cell, got ${seen.map((c) => c.ref).join(", ")}`);
  const ids = cell.candidates.map((c) => c.id);
  // criterion 1: each id once
  assert.equal(new Set(ids).size, ids.length, `rows ${ids.length}, distinct ${new Set(ids).size}`);
  // criterion 2: the survivors keep their order
  assert.deepEqual(cell.candidates.map((c) => c.name), [
    "Tottenham Hotspur (Jekos)", "Tottenham Hotspur (MakcwellLm)", "Tottenham Hotspur (Nicolas_Rage)",
    "Tottenham Hotspur FC (votizlove)", "Tottenham Hotspur FC (toni)", "Tottenham",
  ]);
  // criterion 3: the clarify the user sees is built from the deduped list
  assert.equal(settled.clarifications.length, 1);
  const clar = settled.clarifications[0]!;
  assert.equal(clar.suggest!.length, 5);
  assert.equal(new Set(clar.suggest).size, 5);
  // the question names each suggested entity once (the names carry parentheses, so count them, not the list)
  const shown = cell.candidates.slice(0, 5).map((c) => c.name);
  assert.equal(new Set(shown).size, 5);
  for (const n of shown) assert.equal(clar.question.split(n).length - 1, 1, ` named more than once`);
});

// ---------------------------------------------------------------------------------------------------------
// COST: a row may carry its own price (a Jev row: JEV_PRICE_IN on input, output free); a row without one is
// a Bedrock row and prices from BEDROCK_PRICE_*. One query mixes both, so each row prices from its own source.
test("cost: a row carrying its own price is priced from the row; a plain row from BEDROCK_PRICE_*", async () => {
  await withEnv({ BEDROCK_PRICE_IN: "3", BEDROCK_PRICE_OUT: "15" }, () => {
    const c = summarizeCost([
      { tool: "settle_cells", inputTokens: 460, outputTokens: 0, priceIn: 0.042, priceOut: 0 },
      { tool: "pick", inputTokens: 0, outputTokens: 1_000_000 },
    ]);
    assert.equal(c.calls[0]!.stage, "entities");
    assert.ok(Math.abs(c.calls[0]!.cost - 460 * 0.042 / 1e6) < 1e-12, `jev row cost ${c.calls[0]!.cost}`);
    assert.equal(c.calls[1]!.cost, 15);
  });
});

// ---------------------------------------------------------------------------------------------------------
// ENTITY GATE on Jev (intent/jev-disambiguator). The default decider sends ONE request to TypeSafe's Jev and
// trusts a pick only at or above JEV_ENTITY_THRESHOLD; everything else clarifies. No network: the global
// fetch is stubbed with Node's own mock (restored when the test ends) and the replies are the 2026-09-21
// replay answers verbatim. `npm test` loads no .env, so a stray Bedrock call would throw on the missing AWS
// key — that is the "never a Bedrock call" proof.
const SAKA = { id: 1005184672, name: "Bukayo Saka" }, SAKA2 = { id: 1030173441, name: "Mathis Saka" };
const PL = [{ id: 1000094985, name: "Premier League (England)" }, { id: 1000171537, name: "Premier League (Ukraine)" }, { id: 1000251645, name: "Premier League (Armenia)" }];
const scored = (cs: { id: number; name: string }[]) => cs.map((c) => ({ ...c, score: 0.7 }));
// one leg, two doubtful cells: subject:0 "Saka" (shortlist) and competition:0 "Premier League" (ambiguous)
const jevScope = () => ({ sport: "football", legs: [{ region: null, level: "fixture", stage: null, time: null, playState: null, teams: [], players: [], playerRoles: [],
  competition: { text: "Premier League", tier: "ambiguous", candidates: scored(PL) },
  subjectPlayer: { text: "Saka", tier: "shortlist", candidates: scored([SAKA, SAKA2]) } }] });
const JEV_QUERY = "Saka winner Premier League football"; // names the sport: no cross-sport widening, offline-cheap
const JEV_OK = {
  answers: {
    "subject:0": { type: "choice", choice: "1005184672", confidence: 0.97, probabilities: { "1005184672": 0.98, none: 0.02, "1030173441": 0 } },
    "competition:0": { type: "choice", choice: "1000094985", confidence: 1, probabilities: { "1000094985": 1, "1000171537": 0, "1000251645": 0, none: 0 } },
  },
  usage: { input_tokens: 1109, output_tokens: 0 },
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
// The stubbed fetch hands out `seq` in order (a Response, or an Error to throw); returns the mock for counting.
const stubFetch = (t: TestContext, seq: Array<Response | Error>) =>
  t.mock.method(globalThis, "fetch", async () => { const r = seq.shift(); if (r instanceof Error) throw r; return r ?? reply({}, 500); });
const jevEnv = { JEV_ACCESS_KEY: "test", JEV_MODEL: undefined, JEV_PRICE_IN: undefined, JEV_ENTITY_THRESHOLD: undefined };

test("entity gate: Jev settles confident cells in one request, with real trace and cost rows", async (t) => {
  await withEnv(jevEnv, async () => {
    const fetch = stubFetch(t, [reply(JEV_OK)]);
    const trace: TraceEvent[] = [], rows: RawCall[] = [];
    const settled = await traceStore.run(trace, () => usageStore.run(rows, () => resolveEntities(JEV_QUERY, jevScope() as never)));
    assert.equal(fetch.mock.callCount(), 1);
    const body = JSON.parse(fetch.mock.calls[0]!.arguments[1]!.body as string);
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions["subject:0"].type, "choice");
    assert.deepEqual(Object.keys(body.questions["subject:0"].criteria), ["1005184672", "1030173441", "none"]);
    const leg = settled.legs[0]!;
    assert.equal(leg.subjectPlayer!.tier, "confident");
    assert.equal(leg.subjectPlayer!.candidates[0]!.id, 1005184672);
    assert.equal(leg.competition!.tier, "confident");
    assert.equal(leg.competition!.candidates[0]!.id, 1000094985);
    assert.equal(settled.clarifications.length, 0);
    const llm = trace.filter((e) => (e.kind === "llm-req" || e.kind === "llm-resp") && e.tool === "settle_cells");
    assert.deepEqual(llm.map((e) => e.kind), ["llm-req", "llm-resp"]);
    assert.equal(llm[0]!.kind === "llm-req" && llm[0]!.model, "jev-latest");
    assert.deepEqual(rows, [{ tool: "settle_cells", inputTokens: 1109, outputTokens: 0, priceIn: 0.042, priceOut: 0 }]);
  });
});

test("entity gate: a Jev pick below the threshold clarifies, never a Bedrock call", async (t) => {
  await withEnv(jevEnv, async () => {
    // the recorded reply: the trotting horse at 0.75 (none 0.19) — a confident-wrong pick the threshold refuses
    const fetch = stubFetch(t, [reply({ answers: { "team:0": { type: "choice", choice: "1003385961", confidence: 0.7, probabilities: { "1003385961": 0.75, none: 0.19, "1008202005": 0.03 } } }, usage: { input_tokens: 787 } })]);
    const settled = await resolveEntities("Tottenham Hotspur to win", groundScope(tottenhamPlan) as never);
    assert.equal(fetch.mock.callCount(), 1);
    assert.notEqual(settled.legs[0]!.teams[0]!.tier, "confident");
    assert.equal(settled.clarifications.length, 1);
    const clar = settled.clarifications[0]!;
    assert.equal(clar.suggest!.length, 5);
    assert.equal(new Set(clar.suggest).size, 5);
  });
});

test("entity gate: a cell with no candidates clarifies without a Jev request", async (t) => {
  await withEnv(jevEnv, async () => {
    const fetch = stubFetch(t, []);
    const scope = { sport: "football", legs: [{ region: null, competition: null, level: "fixture", stage: null, time: null, playState: null, players: [], playerRoles: [], subjectPlayer: null,
      teams: [{ text: "Zxqv United", tier: "none", candidates: [] }] }] };
    const settled = await resolveEntities("Zxqv United to win football", scope as never);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(settled.clarifications.length, 1);
    assert.match(settled.clarifications[0]!.question, /^We couldn't identify/);
  });
});

test("entity gate: a missing JEV_ACCESS_KEY fails the query by name and makes no request", async (t) => {
  await withEnv({ ...jevEnv, JEV_ACCESS_KEY: undefined }, async () => {
    const fetch = stubFetch(t, [reply(JEV_OK)]);
    await assert.rejects(resolveEntities(JEV_QUERY, jevScope() as never), /JEV_ACCESS_KEY/);
    assert.equal(fetch.mock.callCount(), 0);
  });
});

test("entity gate: Jev failures retry once on 429/529 and otherwise clarify", async (t) => {
  await withEnv(jevEnv, async () => {
    const run = async (seq: Array<Response | Error>) => {
      const fetch = stubFetch(t, seq);
      const trace: TraceEvent[] = [];
      const settled = await traceStore.run(trace, () => resolveEntities(JEV_QUERY, jevScope() as never));
      fetch.mock.restore();
      return { calls: fetch.mock.callCount(), settled: settled.legs[0]!.subjectPlayer!.tier === "confident", clarified: settled.clarifications.length, resps: trace.filter((e) => e.kind === "llm-resp").length };
    };
    assert.deepEqual(await run([reply({}, 429, { "Retry-After": "0" }), reply(JEV_OK)]), { calls: 2, settled: true, clarified: 0, resps: 1 }, "429 then 200");
    assert.deepEqual(await run([reply({}, 529, { "Retry-After": "0" }), reply({}, 529)]), { calls: 2, settled: false, clarified: 2, resps: 1 }, "529 twice");
    assert.deepEqual(await run([new Error("ECONNRESET")]), { calls: 1, settled: false, clarified: 2, resps: 1 }, "thrown fetch");
    assert.deepEqual(await run([reply("not json")]), { calls: 1, settled: false, clarified: 2, resps: 1 }, "malformed body");
  });
});

// The cut is "at or above", it is env-driven, and a blank or non-numeric value falls back to 0.8 — never to 0 or
// NaN, either of which would compare false and accept every pick (the fail-open the review caught).
test("entity gate: the threshold is inclusive, env-driven, and falls back to 0.8 on a bad value", async (t) => {
  const at = (p: number) => reply({ answers: { "subject:0": { choice: "1005184672", probabilities: { "1005184672": p, none: 1 - p } } }, usage: { input_tokens: 1 } });
  const oneCell = () => { const s = jevScope(); s.legs[0]!.competition = null as never; return s; };
  const rows: RawCall[] = [];
  const settledAt = (p: number, env: Record<string, string | undefined>) => withEnv({ ...jevEnv, ...env }, async () => {
    const fetch = stubFetch(t, [at(p)]);
    const s = await usageStore.run(rows, () => resolveEntities(JEV_QUERY, oneCell() as never));
    fetch.mock.restore();
    return s.legs[0]!.subjectPlayer!.tier === "confident";
  });
  assert.equal(await settledAt(0.8, {}), true, "exactly 0.8 settles");
  assert.equal(await settledAt(0.79, {}), false, "0.79 clarifies");
  assert.equal(await settledAt(0.98, { JEV_ENTITY_THRESHOLD: "0.99" }), false, "the env raises the bar");
  assert.equal(await settledAt(0.5, { JEV_ENTITY_THRESHOLD: "" }), false, "blank env falls back to 0.8, not 0");
  assert.equal(await settledAt(0.5, { JEV_ENTITY_THRESHOLD: "high" }), false, "non-numeric env falls back, not NaN");
  assert.equal(await settledAt(0.9, { JEV_PRICE_IN: "" }), true);
  assert.equal(rows.at(-1)!.priceIn, 0.042, "blank JEV_PRICE_IN falls back to the default price");
});

// ---------------------------------------------------------------------------------------------------------
// MARKET on Jev (intent/jev-market-resolver). ONE Jev request per resolveMarkets call carries every bet: the union
// menu once in state, and per bet a pick / fit / next / outcome `choice` question over THAT bet's own refs. A pick
// counts at or above JEV_MARKET_THRESHOLD; everything else is `none`. No network: fetch is stubbed and answers by
// LABEL against the request it receives, so the tests never depend on how the decider numbers the union menu. The
// bets and menus are the 2026-09-21 Qwen captures (src/eval/market-picks.capture.json); the expected labels are
// the picks Qwen made then.
type CapturedCase = { query: string; leg: number; phrase: string; menu: Menu; qwen: { label: string | null; match: string } };
const CAPTURE = JSON.parse(readFileSync(new URL("../eval/market-picks.capture.json", import.meta.url), "utf8")) as { cases: CapturedCase[] };
const andorra = CAPTURE.cases.filter((c) => c.query.startsWith("andorra"));
const asBet = (c: CapturedCase) => ({ phrase: c.phrase, menu: c.menu });
const marketEnv = { ...jevEnv, JEV_MARKET_THRESHOLD: undefined };
type Canned = { pick: string; prob?: number; fit?: { exact: number; close: number }; next?: Record<string, number>; outcome?: string };
type JevBody = { state: { menu: { label: string }[] }; questions: Record<string, { criteria: Record<string, string> }> };
// A fetch stub that reads the request and answers each bet by label: pick (a label, "none", or a raw key), fit,
// next (label -> probability) and outcome. Usage is fixed so the cost row is checkable.
const jevStub = (t: TestContext, legs: Canned[]) =>
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as JevBody;
    const refOf = (label: string) => { const i = body.state.menu.findIndex((m) => m.label === label); return i >= 0 ? String(i) : label; };
    const answers: Record<string, unknown> = {};
    legs.forEach((c, b) => {
      const key = refOf(c.pick), p = c.prob ?? 0.97;
      answers[`pick:${b}`] = { type: "choice", choice: key, probabilities: { [key]: p, none: 1 - p } };
      const f = c.fit ?? { exact: 0.9, close: 0.1 };
      answers[`fit:${b}`] = { type: "choice", choice: f.exact >= f.close ? "exact" : "close", probabilities: f };
      if (c.next) {
        const probs = Object.fromEntries(Object.entries(c.next).map(([l, pr]) => [refOf(l), pr]));
        answers[`next:${b}`] = { type: "choice", choice: Object.entries(probs).sort((x, y) => y[1] - x[1])[0]![0], probabilities: probs };
      }
      if (c.outcome) answers[`outcome:${b}`] = { type: "choice", choice: c.outcome, probabilities: { [c.outcome]: 0.95, none: 0.05 } };
    });
    return reply({ answers, usage: { input_tokens: 9494, output_tokens: 0 } });
  });
const requestBody = (fetch: ReturnType<typeof jevStub>): JevBody => JSON.parse(fetch.mock.calls[0]!.arguments[1]!.body as string);

test("market: Jev picks each bet from its own menu in ONE request", async (t) => {
  await withEnv(marketEnv, async () => {
    const fetch = jevStub(t, [{ pick: "Full Time" }, { pick: "Both Teams To Score" }]);
    const picks = await resolveMarkets([asBet(andorra[0]!), asBet(andorra[1]!)], undefined, andorra[0]!.query);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(picks.map((p) => [p.label, p.match]), [["Full Time", "exact"], ["Both Teams To Score", "exact"]]);
    const body = requestBody(fetch);
    assert.ok((body.state as { rules?: string }).rules!.length > 500, "the rulebook rides once, in state.rules");
    assert.deepEqual(Object.keys(body.questions).filter((k) => k.endsWith(":0")).sort(), ["fit:0", "next:0", "outcome:0", "pick:0"]);
    // pick:0 offers bet 0's own menu + none — nothing from bet 1's menu; the union menu is deduped by label
    const keys0 = Object.keys(body.questions["pick:0"]!.criteria);
    assert.equal(keys0.length, andorra[0]!.menu.length + 1);
    assert.ok(keys0.includes("none"));
    assert.deepEqual(new Set(keys0.filter((k) => k !== "none").map((k) => body.state.menu[Number(k)]!.label)), new Set(andorra[0]!.menu.map((m) => m.label)));
    assert.equal(body.state.menu.length, new Set([...andorra[0]!.menu, ...andorra[1]!.menu].map((m) => m.label)).size);
  });
});

test("market: exact or close is the fit question's more probable option", async (t) => {
  await withEnv(marketEnv, async () => {
    jevStub(t, [{ pick: "Full Time", fit: { exact: 0.9, close: 0.1 } }, { pick: "Both Teams To Score", fit: { exact: 0.3, close: 0.7 } }]);
    const picks = await resolveMarkets([asBet(andorra[0]!), asBet(andorra[1]!)]);
    assert.deepEqual(picks.map((p) => p.match), ["exact", "close"]);
  });
});

test("market: below threshold, none, or an unknown ref is none", async (t) => {
  await withEnv(marketEnv, async () => {
    jevStub(t, [{ pick: "Full Time", prob: 0.79 }, { pick: "none", prob: 0.9 }, { pick: "999" }]);
    const picks = await resolveMarkets([asBet(andorra[0]!), asBet(andorra[1]!), asBet(andorra[2]!)]);
    assert.deepEqual(picks, [{ match: "none" }, { match: "none" }, { match: "none" }]);
  });
  await withEnv({ ...marketEnv, JEV_MARKET_THRESHOLD: "0.7" }, async () => {
    jevStub(t, [{ pick: "Full Time", prob: 0.79 }]);
    assert.equal((await resolveMarkets([asBet(andorra[0]!)]))[0]!.label, "Full Time", "the cut is env-driven");
  });
});

test("market: a named outcome comes back verbatim, an unlisted one is dropped", async (t) => {
  await withEnv(marketEnv, async () => {
    jevStub(t, [{ pick: "Correct Score", outcome: "3-2" }]);
    assert.equal((await resolveMarkets([asBet(andorra[2]!)]))[0]!.outcomeLabel, "3-2");
    jevStub(t, [{ pick: "Correct Score", outcome: "9-9" }]);
    assert.equal((await resolveMarkets([asBet(andorra[2]!)]))[0]!.outcomeLabel, undefined);
  });
});

test("market: related is the next question's top three, pick excluded", async (t) => {
  await withEnv(marketEnv, async () => {
    jevStub(t, [{ pick: "Full Time", next: { "Full Time": 0.5, "Total Goals": 0.2, "Both Teams To Score": 0.15, "Handicap": 0.1, "Total Goals by Andorra": 0.05 } }]);
    const [p] = await resolveMarkets([asBet(andorra[0]!)]);
    assert.deepEqual(p!.related, ["Total Goals", "Both Teams To Score", "Handicap"]);
  });
});

test("market: Jev failures retry once on 429/529 and otherwise answer none, never throw", async (t) => {
  await withEnv(marketEnv, async () => {
    const ok = { answers: { "pick:0": { type: "choice", choice: "0", probabilities: { "0": 0.97, none: 0.03 } }, "fit:0": { type: "choice", choice: "exact", probabilities: { exact: 0.9, close: 0.1 } } }, usage: { input_tokens: 10 } };
    const run = async (seq: Array<Response | Error>) => {
      const fetch = stubFetch(t, seq);
      const trace: TraceEvent[] = [];
      const picks = await traceStore.run(trace, () => resolveMarkets([{ phrase: "who wins", menu: [{ label: "Full Time" }] }]));
      fetch.mock.restore();
      return { calls: fetch.mock.callCount(), pick: picks[0]!.match, resps: trace.filter((e) => e.kind === "llm-resp").length };
    };
    assert.deepEqual(await run([reply({}, 429, { "Retry-After": "0" }), reply(ok)]), { calls: 2, pick: "exact", resps: 1 }, "429 then 200");
    assert.deepEqual(await run([reply({}, 529, { "Retry-After": "0" }), reply({}, 529)]), { calls: 2, pick: "none", resps: 1 }, "529 twice");
    assert.deepEqual(await run([new Error("ECONNRESET")]), { calls: 1, pick: "none", resps: 1 }, "thrown fetch");
    assert.deepEqual(await run([reply("not json")]), { calls: 1, pick: "none", resps: 1 }, "malformed body");
  });
});

test("market: a missing JEV_ACCESS_KEY rejects by name and makes no request", async (t) => {
  await withEnv({ ...marketEnv, JEV_ACCESS_KEY: undefined }, async () => {
    const fetch = jevStub(t, [{ pick: "Full Time" }]);
    await assert.rejects(resolveMarkets([asBet(andorra[0]!)]), /JEV_ACCESS_KEY/);
    assert.equal(fetch.mock.callCount(), 0);
  });
});

test("market: one request emits one llm-req/llm-resp pair and one priced usage row", async (t) => {
  await withEnv(marketEnv, async () => {
    jevStub(t, [{ pick: "Full Time" }, { pick: "Both Teams To Score" }]);
    const trace: TraceEvent[] = [], rows: RawCall[] = [];
    await traceStore.run(trace, () => usageStore.run(rows, () => decideWithJev([asBet(andorra[0]!), asBet(andorra[1]!)])));
    const llm = trace.filter((e) => (e.kind === "llm-req" || e.kind === "llm-resp") && e.tool === "pick");
    assert.deepEqual(llm.map((e) => e.kind), ["llm-req", "llm-resp"]);
    assert.equal(llm[0]!.kind === "llm-req" && llm[0]!.model, "jev-latest");
    assert.deepEqual(rows, [{ tool: "pick", inputTokens: 9494, outputTokens: 0, priceIn: 0.042, priceOut: 0 }]);
  });
});
