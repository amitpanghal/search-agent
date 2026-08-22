// The load-bearing invariants of the deterministic (zero-LLM, zero-network) stages, as runnable asserts.
// Free to run — no Bedrock, no Kambi. This is the ONLY gate that costs nothing, so it guards the rules that
// would otherwise regress silently between paid eval runs:
//   1. never drop a row on MISSING data (under-dropping is safe, over-dropping loses the right answer)
//   2. diacritic folding is symmetric and never eats a non-decomposable letter
//   3. the day/hour calendar is read in the USER's zone, the instants stay UTC
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeWindow, eventMatchesTime, applyFixturePick, filterEventsByTime } from "./time-window";
import { fold, contentTokens, lc, stripSettle } from "./lexical";
import type { KEvent } from "./offering-client";
import { queryNamesSport } from "./resolve-entities";

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
