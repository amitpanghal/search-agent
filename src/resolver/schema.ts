// The extractor's output schema — the decision-18 `QueryPlan`, TEXT-valued.
//
// This is what the single Haiku extraction call emits via structured output, BEFORE any
// grounding: `market_concept`, entity names, `competition`,
// stage round, and time windows are all plain strings. Grounding maps text -> catalog ids
// downstream, in place. The eval's `gold-record.ts` is the same shape with every groundable
// leaf wrapped in a `Grounded` cell that carries the real id; keep the two in sync.
//
import { z } from "zod";
import { BO_TYPE_KEYS } from "./bo-types";

// Who owns a market. The four concrete kinds are the BOUND readings (recall-resolve Role 1): an owner
// named it OR the phrase reads at a single level, so the kind is certain and the hard subject-filter
// stays. `player.name` is OPTIONAL (decision 21): named, a specific player owns a line ("Mbappé shots");
// omitted, it's a generic per-player market ("player shots") whose outcomes the executor returns for
// every player. `team` still carries a required name; either_match_team/event are bare tags.
//
// `soft` is the deferred reading: NO owner AND the phrase reads at more than one level ("to score over
// 2.5 goals" -> player or event). We do NOT pick — carry the >=2 plausible kinds so recall can pull
// per-kind (balanced) and the catalog-aware resolver decides. Kept rare (see plan §7).
export const Subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("player"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("team"), name: z.string().min(1) }),
  z.object({ kind: z.literal("either_match_team"), side: z.enum(["home", "away"]).optional() }),
  z.object({ kind: z.literal("event") }),
  z.object({
    kind: z.literal("soft"),
    kinds: z.array(z.enum(["player", "team", "either_match_team", "event"])).min(2),
  }),
]);
export type Subject = z.infer<typeof Subject>;

// A line is the stated outcome VALUE, or omitted — never a side. A NUMBER is a rung the resolver matches on
// the outcome's line: an over/under threshold ("over 2.5" -> 2.5) or a handicap start ("-1 start" -> -1). A
// STRING is a named multi-outcome pick the resolver matches on the outcome's label/score: HT/FT ("draw/win"),
// correct score ("2-1"), win/draw/loss across stages. The TYPE alone routes resolution (number -> line match,
// string -> label match) — there is no `kind` and no direction (over/under, yes/no). The resolver returns ALL
// sides of the market, so "which side" is never extracted; only the rung/pick that names a distinct market is.
// Omitted = no value stated (a yes/no prop, a superlative, an outright) -> all offered lines/sides.
export const Line = z.union([z.number(), z.string().min(1)]);
export type Line = z.infer<typeof Line>;

// A price bound on the outcome. At least one of min/max; min <= max.
const Odds = z
  .object({ min: z.number().positive().optional(), max: z.number().positive().optional() })
  .refine((o) => o.min !== undefined || o.max !== undefined, "need >=1 bound")
  .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, "min <= max");

const Time = z
  .object({
    date_window: z
      .object({ value: z.string().min(1), anchor: z.enum(["tournament", "now"]) })
      .nullable(),
    kickoff_time_of_day: z.string().min(1).nullable(),
    fixture_pick: z
      .object({ order: z.enum(["earliest", "latest"]), count: z.number().int().min(1) })
      .nullable(),
  })
  .refine(
    (t) => t.date_window !== null || t.kickoff_time_of_day !== null || t.fixture_pick !== null,
    "need a window, a kickoff band, or a fixture pick",
  );

// PER-LEG scope (the per-leg-scope redesign): every `Selector` carries its OWN `scope` — the fixtures THAT
// leg settles over. There is NO query-level `event_scope` and NO inheritance: when legs share a value
// (competition / region / teams / a time window), the extractor REPEATS it on every leg's `scope`. `level` is
// tagged independently per leg (a tournament-wide outcome is `competition`, a single match is `fixture`), so a
// mixed-grain query keeps each leg's grain and a fixture leg keeps its `time` even when a sibling is competition.
const Scope = z.object({
  teams: z.array(z.string().min(1)),
  players: z.array(z.object({ name: z.string().min(1), role: z.enum(["plays", "starts", "captain"]) })),
  competition: z.string().min(1).nullable(),
  // A place/territory that SCOPES the competition (a country like "Italy", or a cross-country comp branch
  // like "Champions League") — distinct from a country named as a TEAM, which stays in `teams`. The scope
  // grounder resolves it to a top-level branch and hard-scopes competition candidates to that branch's
  // subtree. Nullable; populated by the extractor (see extractor-prompt.md region/team routing rule).
  region: z.string().min(1).nullable(),
  level: z.enum(["fixture", "competition"]),
  stage: z.string().min(1).nullable(), // the tournament round as text, else null
  time: Time.nullable(),
  // In-play vs pre-match restriction (sport-agnostic). `live` = matches in progress; `prematch` = not yet
  // started; `null` = no preference. Required-nullable like `region` (always present, value-or-null), so the
  // scope keeps its fixed shape. Disjoint from `time`: a bare clock phrase is a time window, not a state.
  play_state: z.enum(["live", "prematch"]).nullable(),
});
export type Scope = z.infer<typeof Scope>;

const Selector = z.object({
  subject: Subject,
  market_concept: z.string().min(1),
  // Over-inclusive shortlist of coarse market-type buckets that could carry this market (tokens validated
  // against data/betoffertypes.json via BO_TYPE_KEYS). Narrows the fetch + resolve menu; omitted = keep all
  // buckets. The resolver still picks the exact market — this only prunes, never commits.
  bo_types: z.array(z.enum(BO_TYPE_KEYS)).optional(),
  line: Line.optional(),
  odds: Odds.optional(),
  // Rank the market's outcomes by price instead of bounding it (sport-agnostic). `low` = shortest/lowest/
  // best price first (favourite); `high` = longest/highest/biggest first (underdog). Optional
  // — omitted = no price ranking. Carried per-selector into the FetchPlan (postFilters.outcomes), with line/odds.
  odds_sort: z.enum(["low", "high"]).optional(),
  // How many outcomes of a multi-outcome FIELD to surface (an outright / award / top-scorer with many named
  // competitors). A singular ask ("who wins", "the winner", a "top <stat>" leader) -> 1, paired with
  // odds_sort "low" (the favourite); "top 3" -> 3; omitted = the whole field. Ignored on non-field markets.
  count: z.number().int().min(1).optional(),
  // This leg's own scope (per-leg-scope redesign) — grain, competition, teams, stage, time, state. Required.
  scope: Scope,
});

// The extractor ALWAYS resolves and identifies the sport — `sport` is free text (any sport: "football",
// "tennis", …), not a built-sport enum. It never abstains: a sport with no catalog simply fails downstream
// at grounding, which is the right place for it, not extraction. So there is no `unsupported`/`ambiguous`
// status. A query naming no market still resolves to the lone `main` sentinel selector (decision 24); a plan
// always carries `sport` and >=1 selector, and every selector carries its own `scope`.
export const QueryPlan = z.object({
  status: z.literal("resolved"),
  sport: z.string().min(1),
  otherSports: z.array(z.string()).optional(), // present only when sport-ambiguous (best guess first)
  selectors: z.array(Selector).min(1),
});
export type QueryPlan = z.infer<typeof QueryPlan>;
