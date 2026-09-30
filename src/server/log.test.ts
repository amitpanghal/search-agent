// The query log record (log.ts): the compact projection a click joins against, the query scrub, and the error
// path still producing a record from whatever stages ran. Free: a hand-built trace, no network, no LLM.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { queryRecord, scrub } from "./log";
import type { TraceEvent } from "../resolver/trace";
import type { ResponseEnvelope } from "../resolver/execute";

const t0 = 1_000;
const plan = { sport: "football", selectors: [{ market_concept: "win" }, { market_concept: "total goals" }] };
const trace: TraceEvent[] = [
  { kind: "llm-resp", tool: "emit_query_plan", output: {}, inputTokens: 9000, outputTokens: 300, stopReason: "tool_calls", t: 3_790 },
  { kind: "stage", stage: "extract", out: plan, t: 3_800 },
  { kind: "stage", stage: "ground", out: { sport: "football", legs: [{ region: null, competition: null, teams: [{ text: "Arsenal", tier: "confident", candidates: [{ id: 1, name: "Arsenal", score: 1 }] }], players: [], subjectPlayer: null }] }, t: 3_830 },
  { kind: "kambi-req", url: "u", t: 3_900 },
  { kind: "stage", stage: "recall", out: { data: { events: [{}], betOffers: [{}, {}] }, truncated: false, failed: false }, t: 4_470 },
  { kind: "stage", stage: "filter", out: { offers: [], menu: [{ label: "Full Time" }, { label: "Total Goals" }], legs: [0, 1] }, t: 4_471 },
  { kind: "stage", stage: "market", out: [{ label: "Full Time", match: "exact" }, { label: "Total Goals", match: "exact" }], t: 5_870 },
  { kind: "stage", stage: "execute", out: {}, t: 6_120 },
];
const envelope = {
  summary: "", subjects: [], notes: [], additional: [], clarificationNeeded: null,
  events: [{ id: 10, name: "Arsenal - Chelsea", start: "2026-09-30T19:00:00Z", group: "", sport: "", tags: [], participants: [], state: "" }],
  results: [{ highlighted: [{
    eventId: 10,
    betOffer: { id: 77, criterion: { id: 1, label: "Fulltid", englishLabel: "Full Time" }, betOfferType: { id: 2, name: "Match" }, tags: [] },
    outcomes: [{ id: 901, label: "Arsenal", odds: 1850, status: "OPEN", selected: true }, { id: 902, label: "Draw", odds: 3400, status: "OPEN" }],
  }] }],
  legs: [{ phrase: "win", market: "Full Time", matched: true }, { phrase: "total goals", matched: false }],
  betslip: { odds: 3750, oddsLabel: "3.75", tag: "EXACT", parts: [{ eventId: 10, odds: 3750, legs: [
    { market: "Full Time", outcome: "Arsenal", outcomeId: 901 }, { market: "Total Goals", outcome: "Over", outcomeId: 1207 }] }] },
} satisfies ResponseEnvelope;

test("the record projects the envelope to ids, labels and odds", () => {
  const r = queryRecord({ queryId: "q1", t0, query: "Arsenal to win", trace, envelope }, 6_200);
  assert.deepEqual(r.shown, [{ eventId: 10, event: "Arsenal - Chelsea", start: "2026-09-30T19:00:00Z", betOfferId: 77, criterion: "Full Time",
    outcomes: [{ id: 901, label: "Arsenal", odds: 1850, selected: true }, { id: 902, label: "Draw", odds: 3400 }] }]);
  assert.deepEqual(r.betslip, { odds: 3750, parts: [{ eventId: 10, outcomeIds: [901, 1207] }] });
  assert.deepEqual(r.legs[1], { phrase: "total goals", pick: "Total Goals", match: "exact", matched: false, labels: ["Full Time", "Total Goals"] });
  assert.deepEqual(r.ground, { sport: "football", cells: [{ text: "Arsenal", type: "team", tier: "confident", ids: [1] }] });
  assert.deepEqual(r.recall, { feedCalls: 1, events: 1, offers: 2, truncated: false, failed: false });
  assert.deepEqual(r.timing, { extract: 2800, ground: 30, recall: 640, market: 1400, execute: 250, total: 5200 });
  assert.deepEqual(r.llm, { calls: 1, inputTokens: 9000, outputTokens: 300, stopReasons: ["tool_calls"] });
  assert.equal(r.outcome, "partial"); // one leg unmatched
  assert.equal(r.extract, plan);
});

test("the query is scrubbed of emails, phone and card numbers, and nothing else", () => {
  assert.equal(scrub("call +46 70 123 45 67 or a@b.se, card 4111 1111 1111 1111, over 2.5 goals on 2026-10-04"),
    "call [redacted] or [redacted], card [redacted], over 2.5 goals on 2026-10-04");
});

test("a thrown error still writes a record with the stages that ran", () => {
  const r = queryRecord({ queryId: "q2", t0, query: "Arsenal to win", trace: trace.slice(0, 2), error: "boom" }, 4_000);
  assert.equal(r.outcome, "error");
  assert.equal(r.message, "boom");
  assert.deepEqual(r.legs[0], { phrase: "win", pick: null, match: null, matched: null });
  assert.deepEqual(r.timing, { extract: 2800, total: 3000 });
  assert.deepEqual([r.shown, r.betslip, r.cost], [[], null, null]);
});

test("each leg logs its OWN group's menu, even with a shared market name or no pick", () => {
  // "Arsenal to win and Barcelona corners over 9": two groups; both menus carry "Full Time", leg 1 picks nothing.
  const two: TraceEvent[] = [
    { kind: "stage", stage: "extract", out: { selectors: [{ market_concept: "win" }, { market_concept: "corners" }] }, t: 2_000 },
    { kind: "stage", stage: "filter", out: { offers: [], menu: [{ label: "Full Time" }, { label: "Draw No Bet" }], legs: [0] }, t: 2_001 },
    { kind: "stage", stage: "filter", out: { offers: [], menu: [{ label: "Full Time" }, { label: "Total Corners" }], legs: [1] }, t: 2_002 },
    { kind: "stage", stage: "market", out: [{ label: "Full Time", match: "exact" }, { match: "none" }], t: 3_000 },
  ];
  const r = queryRecord({ queryId: "q3", t0, query: "x", trace: two }, 3_100);
  assert.deepEqual(r.legs.map((l) => l.labels), [["Full Time", "Draw No Bet"], ["Full Time", "Total Corners"]]);
});
