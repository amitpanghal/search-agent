// Behavior tags for the golden eval set (decision E7 in revisiting_Arch.md).
//
// Coverage is organised by the *behavior* a query stresses, not its surface shape.
// Each query is multi-tagged; the scorer reports a pass-rate per tag and the ship
// gate (E12) treats `critical` tags differently from `soft` ones:
//   - critical: getting it wrong lands the bet on the wrong entity / market / side
//               (or fabricates a plan that should have abstained) -> must be 100%.
//   - soft:     scoping / wording / optional-facet recall -> aggregate ~90% bar.
// The tier split is calibratable against a baseline; the *principle* is fixed (E12).

export const BEHAVIOR_TAG_IDS = [
  "binding",
  "coref-his",
  "coref-his-team",
  "line-vs-price",
  "line-no-number",
  "attrFilter",
  "player-role",
  "level",
  "stage",
  "time",
  "abstain",
  "either-team",
  "yes/no-line",
  "odds-only-bounds",
  "self-correction",
  "age-normalize",
  "sport-default",
] as const;

export type BehaviorTag = (typeof BEHAVIOR_TAG_IDS)[number];

export const BEHAVIOR_TAGS: Record<
  BehaviorTag,
  { tier: "critical" | "soft"; desc: string; example: string }
> = {
  "binding": {
    tier: "critical",
    desc: "Attach each market to the subject that owns it, not a neighbouring one.",
    example: "\"Bruno Fernandes corner markets, Vitinha shots on target\" -> corners bound to Bruno, SOT bound to Vitinha (never swapped).",
  },
  "coref-his": {
    tier: "critical",
    desc: "Resolve a pronoun (his / their) to the concrete player it refers to.",
    example: "\"Mbappe with his shots on target over 2.5\" -> the SOT subject is Mbappe.",
  },
  "coref-his-team": {
    tier: "critical",
    desc: "Resolve \"his team\" to the right team -- the national team in a World Cup context (countryTeamId), not the club.",
    example: "\"every Yamal appearance ... his team match result\" -> his team = Spain NT, not Barcelona.",
  },
  "line-vs-price": {
    tier: "critical",
    desc: "Tell a stat threshold (a line) apart from a price bound (odds) when both are numeric.",
    example: "\"over 2.5 goals priced above 1.80\" -> line {value 2.5, over} AND odds {min 1.80}.",
  },
  "line-no-number": {
    tier: "soft",
    desc: "A market named with no explicit number -> the line is omitted (means all offered lines).",
    example: "\"Van Dijk aerial duels won markets\" -> market only, no line.",
  },
  "attrFilter": {
    tier: "soft",
    desc: "An outcome attribute filter (position / region / age) applied within a market.",
    example: "\"anytime scorer for strikers\" -> attrFilter.position = striker.",
  },
  "player-role": {
    tier: "soft",
    desc: "An event-scoping player role (plays | starts | captain); starts/captain degrade to plays when no team sheet.",
    example: "\"all games with Bellingham starting\" -> event_scope player role = starts.",
  },
  "level": {
    tier: "soft",
    desc: "Fixture-level vs competition-level (tournament-wide future) market.",
    example: "\"Golden Boot markets\" -> level = competition; \"Vitinha SOT\" -> level = fixture.",
  },
  "stage": {
    tier: "soft",
    desc: "Tournament round, including subject-relative openers and conditional slots.",
    example: "\"Spain opener\", \"Argentina's semi if they reach it\" -> stage round / ordinal / conditional.",
  },
  "time": {
    tier: "soft",
    desc: "A time facet: date_window vs kickoff_time_of_day, anchored to the tournament or to now.",
    example: "\"in the first week\" (date_window, tournament), \"late kick-offs\" (kickoff band).",
  },
  "abstain": {
    tier: "critical",
    desc: "Emit a sentinel status instead of fabricating a plan.",
    example: "\"Djokovic vs Alcaraz total games over 22.5\" -> status unsupported (tennis not built).",
  },
  "either-team": {
    tier: "critical",
    desc: "A generic team market with >=2 match teams in scope and no side named -> subject either_match_team.",
    example: "\"team total goals over 1.5\" in a Portugal vs Brazil fixture.",
  },
  "yes/no-line": {
    tier: "critical",
    desc: "A binary market's side: yes vs no (getting it wrong is the opposite bet).",
    example: "\"clean sheet odds\" -> line {binary, yes}.",
  },
  "odds-only-bounds": {
    tier: "soft",
    desc: "Only a price bound is given, with no line.",
    example: "\"players priced between 5.0 and 15.0\" -> odds {min 5.0, max 15.0}.",
  },
  "self-correction": {
    tier: "critical",
    desc: "An in-query retraction; record the final corrected intent only, drop the retracted entity.",
    example: "\"Haaland-less Norway out -- sorry, with Modric...\" -> gold = Modric / Croatia.",
  },
  "age-normalize": {
    tier: "soft",
    desc: "Convert age phrasing to inclusive integer bounds.",
    example: "\"anyone under 23\" -> ageMax 22.",
  },
  "sport-default": {
    tier: "critical",
    desc: "No sport named -> resolve to the sole built sport (FOOTBALL today). Proposed this session; not in the original E7 list. Sport is a costly facet (E5), hence critical.",
    example: "\"Both teams to score markets priced over 1.90\" -> sport FOOTBALL.",
  },
};

export const CRITICAL_TAGS: BehaviorTag[] = BEHAVIOR_TAG_IDS.filter(
  (t) => BEHAVIOR_TAGS[t].tier === "critical"
);
export const SOFT_TAGS: BehaviorTag[] = BEHAVIOR_TAG_IDS.filter(
  (t) => BEHAVIOR_TAGS[t].tier === "soft"
);
