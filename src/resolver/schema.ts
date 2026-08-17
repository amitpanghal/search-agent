// The extractor's output schema — the decision-18 `QueryPlan`, TEXT-valued.
//
// This is what the single extraction call emits via structured output, BEFORE any
// grounding: `market_concept`, entity names, `competition`,
// stage round, and time windows are all plain strings. Grounding maps text -> catalog ids
// downstream, in place. The eval's `gold-record.ts` is the same shape with every groundable
// leaf wrapped in a `Grounded` cell that carries the real id; keep the two in sync.
//
import { z } from "zod";
import { builtSports } from "./sports";

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

// A BOUND on the line rather than a rung of it: "only games with a runs line above 8.5", "the total sits
// below 158". This is a FIXTURE filter, not an outcome filter — every baseball game offers the whole 6.5-12.5
// ladder, so keeping outcomes above 8.5 would drop no game at all. What the query means is the fixture's
// HEADLINE line (the feed's MAIN_LINE betoffer), so SELECT reads that per event and keeps the ones in bounds.
// Distinct from `odds` (a price) and from a scalar `line` (a rung to select).
export const LineRange = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .refine((o) => o.min !== undefined || o.max !== undefined, "need >=1 bound")
  .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, "min <= max");
export type LineRange = z.infer<typeof LineRange>;

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
  // The ONE field carrying a `.describe()`. Guidance in the system prompt is 340 lines from the point of
  // generation and loses to the model's own instinct here: a league whose name states its own sport (MLB, UFC,
  // WNBA) gets spent on `sport` and never reaches this field, leaving `null` — and a plan with no competition,
  // team or player is refused before any fetch. Five successive prompt rewrites moved nothing; leagues that
  // name no sport (Bundesliga, Copa Libertadores) were never affected. The description rides in the tool schema,
  // beside the field, at the moment the model fills it in.
  competition: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "The league, tournament or competition this leg settles in, as text. Fill this in whenever the query " +
        "names one — INCLUDING a league whose name states its own sport (MLB, UFC, NRL, WNBA) and one used " +
        "only as a modifier on another noun (\"<LEAGUE> games tonight\"). Having used that same name to " +
        "identify `sport` does NOT exempt it: it belongs in both places. Use null only when the query names " +
        "no competition at all.",
    ),
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
  // A rung to SELECT (number / combo token), or a RANGE that bounds which fixtures qualify (see LineRange).
  line: z.union([Line, LineRange]).optional(),
  // Which SIDE of a two-sided market the query named — carried alongside `line`, never inside it. Add it when
  // the query states an over/under side ("over"/"more than" -> "over"; "under"/"fewer than" -> "under"), an
  // inclusive BAND ("N+"/"at least N" -> "at_least"; "N or fewer"/"up to N" -> "at_most"), or a yes/no side
  // (a negation "won't"/"no" -> "no"; an explicit affirmative -> "yes"). A handicap names a team,
  // not a side, so leave it off there (the team is the subject). SELECT reads it as its `dir`.
  // A band is NOT an over/under: "2+ hits" means >= 2, which on a ladder is "over 1.5". Only SELECT can make
  // that conversion (it sees the offered rungs), so the extractor states the band and select maps it.
  // MEASURED, don't re-try: giving this field a `.describe()` (the wording that fixed `competition`) moved
  // nothing — 13 failing rows before, 13 after, 4 fixed / 4 broken. A 45-line prompt carrying the SAME rule
  // fixes 8 of 9, so what suppresses `direction` lives in the prompt's own text, not in this field's distance
  // from it. See the arm-3/arm-4 probe in planning/extractor-role-split-findings.md.
  direction: z.enum(["over", "under", "at_least", "at_most", "yes", "no"]).optional(),
  odds: Odds.optional(),
  // Rank the market's outcomes by price instead of bounding it (sport-agnostic). `low` = shortest/lowest/
  // best price first (favourite); `high` = longest/highest/biggest first (underdog). Optional
  // — omitted = no price ranking. Carried per-selector into the FetchPlan (postFilters.outcomes), with line/odds.
  odds_sort: z.enum(["low", "high"]).optional(),
  // Rank fixtures by the size of their LINE — a different axis from `odds_sort`, which ranks by PRICE.
  // "which game has the biggest handicap" / "the highest total line" / "the widest spread" -> "high".
  // Read off each fixture's headline (MAIN_LINE) betoffer, magnitude-wise so a -12.5 handicap outranks a -2.5.
  line_sort: z.enum(["low", "high"]).optional(),
  // How many outcomes of a multi-outcome FIELD to surface (an outright / award / top-scorer with many named
  // competitors). A singular ask ("who wins", "the winner", a "top <stat>" leader) -> 1, paired with
  // odds_sort "low" (the favourite); "top 3" -> 3; omitted = the whole field. Ignored on non-field markets.
  count: z.number().int().min(1).optional(),
  // This leg's own scope (per-leg-scope redesign) — grain, competition, teams, stage, time, state. Required.
  scope: Scope,
});

// The extractor ALWAYS resolves and identifies the sport. `sport` is a HARD ENUM of the built sports
// (extract.ts injects the same list into the prompt) plus `other` — the model can't typo or pick an
// off-list name, and `other` is the graceful path for a genuinely-unknown sport. It never abstains: an
// `other`/unknown sport simply fails downstream
// at grounding, which is the right place for it, not extraction. So there is no `unsupported`/`ambiguous`
// status. A query naming no market still resolves to the lone `main` sentinel selector (decision 24); a plan
// always carries `sport` and >=1 selector, and every selector carries its own `scope`.
export const QueryPlan = z.object({
  // ponytail: the enum makes extract stricter — an off-enum value fails validation instead of failing
  // downstream. Forced tool use + `other` make that near-impossible; widen to z.string() if a model can't hold it.
  sport: z.enum(["other", ...builtSports()] as [string, ...string[]]),
  // The query's LANGUAGE, named in English ("Swedish", "German") — free text like `sport`, never a locale code
  // and never an enum: the extractor just detects, and code maps the name to a supported Kambi locale (an
  // unmapped or absent language degrades to English labels downstream). Omitted when the query is English or the
  // language is unclear. Used only to localize the feed's market/outcome LABELS; all resolution stays in English.
  language: z.string().min(1).optional(),
  // A price bound on the COMBINED return of every leg ("only if the combined odds clear 2.0") — QUERY-level,
  // because it constrains the parlay, not any single bet. Put per-selector instead it deletes the leg it lands
  // on: "Gyökeres anytime AND Arsenal to win, combined over 2.0" applied {min:2} to Arsenal at 1.2, so the
  // winner leg was dropped as odds-absent. Checked ONCE against the priced betslip; a miss is reported, never
  // a silent drop.
  combined_odds: Odds.optional(),
  selectors: z.array(Selector).min(1),
});
export type QueryPlan = z.infer<typeof QueryPlan>;
