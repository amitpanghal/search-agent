// normalize-plan — deterministic repair of the extracted QueryPlan, run after extract() and before grounding
// (per-leg-scope redesign Phase 2.5). Structured output occasionally emits an unusable-but-clear shape;
// repair it at the parse boundary rather than throw — the extractor never abstains, so one malformed leaf must
// not sink the whole query. Two classes of repair:
//   1. PER-LEG SCOPE cleanups — an all-null `stage`/`time` skeleton -> null (its refine rejects the empty
//      object); default an absent `region`/`play_state` to null (both are required-nullable).
//   2. PER-SELECTOR leaf repairs (moved verbatim from extract.ts): drop a blank/unusable optional line/odds,
//      sanitize odds bounds, coerce a nameless `team` subject -> the bare `event` subject.
//
// NOT done here: stripping a "fabricated" competition. The Phase 0 gate (temp 0, one query per call) showed
// ZERO fabrication across 14 queries, and a pre-grounding text check is unsafe — it would wrong-strip a
// legitimately lifted competition whose surface form differs ("WC26" in the query -> "World Cup 2026" in
// scope), and would still MISS a fabrication that is consistent across legs. The reliable signal is "did it
// ground to a real competition?", so that check belongs AFTER Phase 3 grounding, not here. Revisit if
// fabrication actually appears in the live extractor.

const OPTIONAL_SELECTOR_LEAVES = ["line", "odds"] as const;

function isBlank(v: unknown): boolean {
  return v === null || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
}
function isUsableLine(v: unknown): boolean {
  // A line is a bare value — a number (rung/handicap, 0 included) or a non-empty string (named pick) — OR a
  // RANGE object bounding which fixtures qualify. The range is sanitized like `odds`: non-numeric bounds are
  // stripped, and one left with no bound at all is unusable.
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length > 0;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["min", "max"] as const) if (!(typeof o[k] === "number" && Number.isFinite(o[k]))) delete o[k];
    return o.min !== undefined || o.max !== undefined;
  }
  return false;
}
// Sanitize `odds`: drop any min/max that isn't a positive number; an odds object left with no valid bound is
// removed (the schema needs >=1 positive bound). Repairs the `{ min: 0 }` placeholder a superlative like
// "shortest odds" produces — the model invents a 0 bound when "odds" is named with no real number.
function sanitizeOdds(rec: Record<string, unknown>, key = "odds"): void {
  const o = rec[key] as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object") return;
  for (const k of ["min", "max"] as const) {
    if (!(typeof o[k] === "number" && (o[k] as number) > 0)) delete o[k];
  }
  if (o.min === undefined && o.max === undefined) delete rec[key];
}

// Per-leg scope: a blank `stage` or an all-null `time` skeleton -> coerce to null (omit the facet); default
// the required-nullable `region`/`play_state` so an absent or garbage value still parses.
function normalizeScope(sc: Record<string, unknown>): void {
  // required-nullable fields: an ABSENT or blank value means "no value" -> null. Models may omit nulls to save
  // output tokens (some models emit them, others omit them), so backfill deterministically here rather than force the
  // model to spend tokens emitting nulls.
  for (const k of ["competition", "region", "stage", "time"] as const) {
    if (!(k in sc) || (typeof sc[k] === "string" && !(sc[k] as string).trim())) sc[k] = null;
  }
  const tm = sc.time as Record<string, unknown> | null;
  if (tm && typeof tm === "object") {
    // Time's own sub-fields are required-nullable too — backfill omitted ones, then collapse an all-null skeleton.
    for (const k of ["date_window", "kickoff_time_of_day", "fixture_pick"] as const) if (!(k in tm)) tm[k] = null;
    if (tm.date_window == null && tm.kickoff_time_of_day == null && tm.fixture_pick == null) sc.time = null;
  }
  if (sc.play_state !== "live" && sc.play_state !== "prematch") sc.play_state = null;
  // `level` is a required enum with NO null option, so a weak model that drops it would sink the whole
  // query at parse. Default an absent/garbage value to the majority grain `fixture` (a bare league is forced
  // to fixture in resolve.ts anyway; a real competition query names a market and gets tagged competition).
  if (sc.level !== "fixture" && sc.level !== "competition") sc.level = "fixture";
  if (!Array.isArray(sc.teams)) sc.teams = [];
  if (!Array.isArray(sc.players)) sc.players = [];
}

export function normalizePlan(plan: unknown): void {
  if (!plan || typeof plan !== "object") return;
  const p = plan as Record<string, unknown>;
  // query-level bound (same shape as a selector's `odds`, so the same sanitizer)
  sanitizeOdds(p, "combined_odds");
  if (!Array.isArray(p.selectors)) return;
  // Model slop: a half-emitted selector arrives as a bare string in the array — drop it rather than sink
  // the whole plan (schema still refuses an emptied plan).
  const selectors = (p.selectors as unknown[]).filter(
    (s): s is Record<string, unknown> => !!s && typeof s === "object",
  );
  if (selectors.length) p.selectors = selectors;
  for (const rec of selectors) {
    // (1) per-leg scope cleanups
    const sc = rec.scope as Record<string, unknown> | undefined;
    if (sc && typeof sc === "object") normalizeScope(sc);
    // (2) per-selector leaf repairs (drop blank/unusable optional leaves; coerce a nameless `team` -> `event`).
    for (const k of OPTIONAL_SELECTOR_LEAVES) {
      if (isBlank(rec[k])) delete rec[k];
    }
    if (rec.line !== undefined && !isUsableLine(rec.line)) delete rec.line;
    sanitizeOdds(rec);
    // `odds_sort` / `line_sort` are optional enums: drop anything that isn't "low"/"high" (incl. null/{}) so the
    // schema parses. Same rule for both — one ranks by price, the other by line size.
    for (const k of ["odds_sort", "line_sort"] as const) {
      if (k in rec && rec[k] !== "low" && rec[k] !== "high") delete rec[k];
    }
    // `direction` is an optional enum too: drop an off-enum value so one bad side-word degrades to
    // show-all-sides instead of sinking the whole plan at parse.
    if ("direction" in rec && !["over", "under", "at_least", "at_most", "yes", "no"].includes(rec.direction as string))
      delete rec.direction;
    // `count` is an optional positive integer (the field-outright limit); drop anything else so the schema parses.
    if ("count" in rec && !(Number.isInteger(rec.count) && (rec.count as number) >= 1)) delete rec.count;
    const subj = rec.subject as Record<string, unknown> | undefined;
    if (subj && subj.kind === "team" && (typeof subj.name !== "string" || subj.name.length === 0)) {
      rec.subject = { kind: "event" };
    }
  }
  // The same bet re-described is one bet: drop selectors identical after repair.
  // ponytail: JSON key-order dedup; canonicalize keys if a model ever reorders them between twin legs
  const seen = new Set<string>();
  p.selectors = selectors.filter((s) => {
    const k = JSON.stringify(s);
    return seen.has(k) ? false : (seen.add(k), true);
  });
  // A 1-selector plan can never carry combined_odds (schema rule): one bet's combined price IS its price.
  const legs = p.selectors as Record<string, unknown>[];
  if (legs.length === 1 && p.combined_odds) {
    if (!legs[0]!.odds) legs[0]!.odds = p.combined_odds;
    delete p.combined_odds;
  }
}
