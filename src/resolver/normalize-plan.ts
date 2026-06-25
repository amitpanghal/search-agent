// normalize-plan — deterministic repair of the extracted QueryPlan, run after extract() and before grounding
// (per-leg-scope redesign Phase 2.5). Structured output + Haiku occasionally emit an unusable-but-clear shape;
// repair it at the parse boundary rather than throw — the extractor never abstains, so one malformed leaf must
// not sink the whole query. Two classes of repair:
//   1. PER-LEG SCOPE cleanups — an all-null `stage`/`time` skeleton -> null (its refine rejects the empty
//      object); default an absent `region`/`play_state` to null (both are required-nullable).
//   2. PER-SELECTOR leaf repairs (moved verbatim from extract.ts): drop a blank/unusable optional line/odds,
//      sanitize odds bounds + bo_types tokens, coerce a nameless `team` subject -> the bare `event` subject.
//
// NOT done here: stripping a "fabricated" competition. The Phase 0 gate (temp 0, one query per call) showed
// ZERO fabrication across 14 queries, and a pre-grounding text check is unsafe — it would wrong-strip a
// legitimately lifted competition whose surface form differs ("WC26" in the query -> "World Cup 2026" in
// scope), and would still MISS a fabrication that is consistent across legs. The reliable signal is "did it
// ground to a real competition?", so that check belongs AFTER Phase 3 grounding, not here. Revisit if
// fabrication actually appears in the live extractor.

import { BO_TYPE_KEYS } from "./bo-types";

const KNOWN_BO_TYPES = new Set<string>(BO_TYPE_KEYS);
const OPTIONAL_SELECTOR_LEAVES = ["line", "odds"] as const;

function isBlank(v: unknown): boolean {
  return v === null || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
}
function isUsableLine(v: unknown): boolean {
  // A line is now a bare value: a number (rung/handicap, 0 included) or a non-empty string (named pick).
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.length > 0;
}
// Sanitize `odds`: drop any min/max that isn't a positive number; an odds object left with no valid bound is
// removed (the schema needs >=1 positive bound). Repairs the `{ min: 0 }` placeholder a superlative like
// "shortest odds" produces — Haiku invents a 0 bound when "odds" is named with no real number.
function sanitizeOdds(rec: Record<string, unknown>): void {
  const o = rec.odds as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object") return;
  for (const k of ["min", "max"] as const) {
    if (!(typeof o[k] === "number" && (o[k] as number) > 0)) delete o[k];
  }
  if (o.min === undefined && o.max === undefined) delete rec.odds;
}
// Sanitize `bo_types`: keep only known bucket tokens (a hallucinated/garbage token is dropped), dedupe, and
// remove the field entirely if nothing valid remains (fail-open — the resolver then sees all buckets).
function sanitizeBoTypes(rec: Record<string, unknown>): void {
  const bt = rec.bo_types;
  if (!Array.isArray(bt)) { delete rec.bo_types; return; }
  const kept = [...new Set(bt.filter((t): t is string => typeof t === "string" && KNOWN_BO_TYPES.has(t)))];
  if (kept.length) rec.bo_types = kept;
  else delete rec.bo_types;
}

// Per-leg scope: an all-null stage/time skeleton fails its refine -> coerce to null (omit the facet); default
// the required-nullable `region`/`play_state` so an absent or garbage value still parses.
function normalizeScope(sc: Record<string, unknown>): void {
  const st = sc.stage as Record<string, unknown> | null;
  if (st && st.round == null && st.ordinal == null) sc.stage = null;
  const tm = sc.time as Record<string, unknown> | null;
  if (tm && tm.date_window == null && tm.kickoff_time_of_day == null && tm.fixture_pick == null) sc.time = null;
  if (!("region" in sc)) sc.region = null;
  if (sc.play_state !== "live" && sc.play_state !== "prematch") sc.play_state = null;
}

export function normalizePlan(plan: unknown): void {
  if (!plan || typeof plan !== "object") return;
  const p = plan as Record<string, unknown>;
  const selectors = p.selectors;
  if (!Array.isArray(selectors)) return;
  for (const sel of selectors) {
    if (!sel || typeof sel !== "object") continue;
    const rec = sel as Record<string, unknown>;
    // (1) per-leg scope cleanups
    const sc = rec.scope as Record<string, unknown> | undefined;
    if (sc && typeof sc === "object") normalizeScope(sc);
    // (2) per-selector leaf repairs (drop blank/unusable optional leaves; coerce a nameless `team` -> `event`).
    for (const k of OPTIONAL_SELECTOR_LEAVES) {
      if (isBlank(rec[k])) delete rec[k];
    }
    if (rec.line !== undefined && !isUsableLine(rec.line)) delete rec.line;
    sanitizeOdds(rec);
    sanitizeBoTypes(rec);
    // `odds_sort` is an optional enum: drop anything that isn't "low"/"high" (incl. null/{}) so the schema parses.
    if ("odds_sort" in rec && rec.odds_sort !== "low" && rec.odds_sort !== "high") delete rec.odds_sort;
    // `count` is an optional positive integer (the field-outright limit); drop anything else so the schema parses.
    if ("count" in rec && !(Number.isInteger(rec.count) && (rec.count as number) >= 1)) delete rec.count;
    const subj = rec.subject as Record<string, unknown> | undefined;
    if (subj && subj.kind === "team" && (typeof subj.name !== "string" || subj.name.length === 0)) {
      rec.subject = { kind: "event" };
    }
  }
}
