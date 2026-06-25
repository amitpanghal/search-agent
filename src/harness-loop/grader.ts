// GRADER — the single pass/fail authority, reading ONLY the final ResponseEnvelope (the user's fixed measurement
// point). Three axes (theory of the rig):
//   1. market targets — each leg's any-of criterion id set must appear among the envelope's picked markets.
//   2. odds filter (POST-resolve) — every SELECTED outcome must respect the price floor/ceiling.
//   3. time filter (PRE-resolve) — graded SOFT for now: a timebound query must return a non-empty slate.
// Per-layer numbers are logged elsewhere for TRIAGE (where it broke); the verdict is the envelope.

import type { ResponseEnvelope } from "../resolver/execute";
import type { BatchQuery, GradeResult } from "./types";

// Every criterion id the envelope surfaced (across events + highlighted markets).
const idsIn = (env: ResponseEnvelope): number[] =>
  env.results.flatMap((r) => r.highlighted.map((h) => h.betOffer.criterion.id));

// Odds (decimal) of the outcomes the query actually SELECTED — feed stores integer millis (1800 == 1.80).
const selectedOdds = (env: ResponseEnvelope): number[] =>
  env.results.flatMap((r) => r.highlighted.flatMap((h) => h.outcomes.filter((o) => o.selected).map((o) => o.odds / 1000)));

export function grade(q: BatchQuery, env: ResponseEnvelope): GradeResult {
  const gotIds = idsIn(env);
  const reasons: string[] = [];

  for (const leg of q.grade.targets) {
    if (!leg.some((id) => gotIds.includes(id))) reasons.push(`missing target leg (want any of ${JSON.stringify(leg)})`);
  }

  const odds = selectedOdds(env);
  if (q.grade.oddsMin != null && odds.some((o) => o < q.grade.oddsMin!)) reasons.push(`selected odds below floor ${q.grade.oddsMin}`);
  if (q.grade.oddsMax != null && odds.some((o) => o > q.grade.oddsMax!)) reasons.push(`selected odds above ceiling ${q.grade.oddsMax}`);

  if (q.grade.timebound && env.results.length === 0) reasons.push("timebound query returned an empty slate");

  return { id: q.id, category: q.category, pass: reasons.length === 0, pending: false, reasons, gotIds };
}
