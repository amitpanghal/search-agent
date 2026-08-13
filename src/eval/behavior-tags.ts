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
  "player-role",
  "level",
  "stage",
  "time",
  "either-team",
  "yes/no-line",
  "odds-only-bounds",
  "self-correction",
  "age-normalize",
  "sport-default",
  "fixture-lookup",
  "scope-competition",
  "scope-region",
  "scope-team",
  "scope-player",
  "scope-mononym",
  "scope-nt-variant",
  "odds-sort",
  "play-state",
  // ---- added by the extractor-rebuild sweep (planning/extractor-rebuild-plan.md): one tag per failure
  // class measured across 58 live probes. See BEHAVIOR_TAGS below for the evidence behind each. ----
  "league-modifier",
  "over-under-side",
  "margin-market",
  "price-fractional",
  "price-not-a-leg",
  "named-over-side",
  "outright",
  "player-prop",
  "score-combo",
  "multi-leg",
  "line-range",
  "line-sort",
  "combined-odds",
  "family-ask",
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
    desc: "Resolve \"his team\" to the team that player represents in the query's context.",
    example: "\"every Yamal appearance ... his team match result\" -> his team = the team Yamal plays for in context.",
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
    desc: "Tournament round.",
    example: "\"the quarterfinal\", \"the knockout tie\" -> stage round (text).",
  },
  "time": {
    tier: "soft",
    desc: "A time facet: date_window vs kickoff_time_of_day, anchored to the tournament or to now.",
    example: "\"in the first week\" (date_window, tournament), \"late kick-offs\" (kickoff band).",
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
    desc: "No sport named -> infer the sport from the market vocabulary (graded loosely as free text). Sport is a costly facet (E5), hence critical.",
    example: "\"Both teams to score markets priced over 1.90\" -> sport football (inferred from BTTS).",
  },
  "fixture-lookup": {
    tier: "critical",
    desc: "A marketless / 'show me the fixtures' query -> status resolved with a single sentinel selector { subject: event, market_concept: \"main\" }; never a fabricated 'match' market or a crash (decision 24, replacing the fixture_lookup status). On these records the fixture-selecting facets (teams/stage/time) grade HARD (Option A).",
    example: "\"is England's next match listed yet\" -> resolved, one \"main\" selector; \"match result\" would instead be a real market selector.",
  },
  // ---- scope-grounding behaviors (graded by the SEPARATE deterministic grounder gate, not the extractor
  // tag gate): recall@k (gold id in the candidate set) + confident-precision (a confident/variants tier
  // must contain the gold id). Tier "soft" only marks that the new grounder is still uncalibrated; a
  // confident-WRONG entity is always a hard miss in the entity gate regardless. ----
  "scope-competition": {
    tier: "soft",
    desc: "Ground a competition name to its group id; an under-specified one (no edition) stays ambiguous, surfacing the editions for the disambiguator.",
    example: "\"World Cup 2026\" -> confident WC26; bare \"World Cup\" -> ambiguous {WC26, WC22}.",
  },
  "scope-region": {
    tier: "soft",
    desc: "A place word scopes the competition: resolve it to a top-level branch and hard-scope competition candidates to that branch's subtree (rescuing a high-collision name).",
    example: "\"English Premier League\" -> region England cuts the 8 'Premier League' nodes to England's one.",
  },
  "scope-team": {
    tier: "soft",
    desc: "Ground a team name (club or national team) to its participant id.",
    example: "\"Brazil\" -> the Brazil national-team id.",
  },
  "scope-player": {
    tier: "soft",
    desc: "Ground a player name to its participant id, hard-scoped under a confident competition / team (the homonym cut).",
    example: "\"Bruno Fernandes\" with Portugal in scope -> the Portugal international, not the other Bruno Fernandes.",
  },
  "scope-mononym": {
    tier: "soft",
    desc: "A single-name (mononym) player collides many ways; bare it stays ambiguous, scoped to a competition it collapses to one.",
    example: "\"Juninho\" -> ambiguous (7 players); \"Juninho\" in Liga MX -> the one Liga MX Juninho.",
  },
  "scope-nt-variant": {
    tier: "soft",
    desc: "A national-team name defaults to the senior_men variant; a marker (U23/U21) picks the youth variant.",
    example: "\"Brazil\" -> senior_men national team (default variant).",
  },
  "odds-sort": {
    tier: "soft",
    desc: "Rank by price (shortest/longest odds) — a sort, not a bound.",
    example: "\"shortest odds to score first\" -> odds_sort low; \"highest draw odds\" -> odds_sort high.",
  },
  "play-state": {
    tier: "soft",
    desc: "Live (in-play) vs pre-match; a bare clock phrase stays a time window.",
    example: "\"live corner markets\" -> play_state live; \"games next 48h\" -> time window, play_state null.",
  },

  // ---- extractor-rebuild classes. Every example below is a real failure from the 58-probe sweep, not a
  // hypothetical: the wording is what the user typed and the "got" is what the extractor actually emitted. ----
  "league-modifier": {
    tier: "critical",
    desc: "A competition used as a MODIFIER on the event noun is still the competition, never a category word. Dropping it leaves the plan with no anchor at all, so check-complete stops the query before any fetch.",
    example: "\"which MLB game tonight\" -> competition MLB (got null, because MLB also told it sport=baseball); \"in the MLB, which game tonight\" already keeps it.",
  },
  "over-under-side": {
    tier: "critical",
    desc: "The over/under side comes from the BET clause; a condition clause about the line must never set or flip it (getting it wrong is the opposite bet).",
    example: "\"the over, only if the total is under 41\" -> direction over (got under, taken from the condition).",
  },
  "margin-market": {
    tier: "critical",
    desc: "A winning-margin ask names a margin/handicap market, not the plain winner — picking the winner then applying the margin as a line empties the leg.",
    example: "\"Penrith by 13+\" -> a margin market (got \"Regular Time (3-way)\" + line 13 -> line-absent, no result).",
  },
  "price-fractional": {
    tier: "critical",
    desc: "Fractional and idiomatic prices normalise to DECIMAL odds; reading the numerator as a decimal silently loosens the bound.",
    example: "\"paying over 4/1\" -> odds {min: 5.0} (got {min: 4}, which let a 4.30 shot through); \"over even money\" -> {min: 2.0}.",
  },
  "price-not-a-leg": {
    tier: "critical",
    desc: "A price condition is `odds` on the bet it qualifies — never a second selector, and never a line on a market of its own.",
    example: "\"a player to kick 3+ goals, over 4.0\" -> ONE selector + odds {min 4.0} (got a second selector: event \"goals\" line 4 over).",
  },
  "named-over-side": {
    tier: "critical",
    desc: "A named team or player owns the market; never replace it with a positional home/away guess, which inverts whenever the feed orders the fixture the other way.",
    example: "\"Golden State vs Chicago Sky - Valkyries to cover\" -> subject team Golden State (got either_match_team away; the feed lists it Chicago Sky @ Golden State, so every price returned was Chicago Sky's).",
  },
  "outright": {
    tier: "critical",
    desc: "A competition-grain market (outright winner, top scorer, award, tournament progress) settles over the whole competition, not one fixture.",
    example: "\"top scorer across the Premier League season\" -> level competition; a single-match stat at a tournament stays fixture.",
  },
  "player-prop": {
    tier: "critical",
    desc: "A per-player line market, distinguished from the team/match total twin of the same stat.",
    example: "\"Bueckers 20+ points\" -> the per-player points market, not the game total.",
  },
  "score-combo": {
    tier: "critical",
    desc: "Correct score / set betting / map score name one outcome of a multi-outcome market — and the token is stated from the SUBJECT's side, so the subject must be captured or the side inverts.",
    example: "\"Learner Tien vs Shelton - Shelton in straight sets\" -> subject Shelton, so 0-2 @ 2.12 (got subject event and 2-0 @ 4.40, which is Tien winning).",
  },
  "multi-leg": {
    tier: "critical",
    desc: "Two independently-settling bets in one query split into two selectors, each bound to its own subject.",
    example: "\"Gyokeres anytime and Arsenal to win\" -> two selectors (player scorer, team winner), never merged or swapped.",
  },
  "line-range": {
    tier: "soft",
    desc: "A comparative on the LINE bounds which lines qualify — it does not pick one rung. Needs the schema's line range.",
    example: "\"only games with a runs line above 8.5\" -> line {min: 8.5} (got line 8.5, which returned the whole 6.5-12.5 ladder).",
  },
  "line-sort": {
    tier: "soft",
    desc: "A superlative on the LINE ranks fixtures by line size — distinct from odds_sort, which ranks by price. Needs the schema's line_sort.",
    example: "\"which game has the biggest handicap\" -> line_sort high (got odds_sort high, a price ranking).",
  },
  "combined-odds": {
    tier: "soft",
    desc: "A price bound on the COMBINED return of several legs is query-level, not per-selector; applying it to one leg deletes that leg.",
    example: "\"Gyokeres anytime and Arsenal to win, only if the combined odds clear 2.0\" -> combined_odds {min 2.0} (got odds {min 2.0} on the Arsenal leg, priced 1.2, so it was dropped).",
  },
  "family-ask": {
    tier: "soft",
    desc: "A request to see a whole market family rather than one bet.",
    example: "\"show me all the corner markets\" -> one selector naming the family, resolved with siblings as related.",
  },
};

export const CRITICAL_TAGS: BehaviorTag[] = BEHAVIOR_TAG_IDS.filter(
  (t) => BEHAVIOR_TAGS[t].tier === "critical"
);
export const SOFT_TAGS: BehaviorTag[] = BEHAVIOR_TAG_IDS.filter(
  (t) => BEHAVIOR_TAGS[t].tier === "soft"
);
