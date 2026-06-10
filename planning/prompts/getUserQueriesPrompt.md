# Get-user-queries prompt — Sprint 6 doc-views eval set

**What this is.** A self-contained prompt for generating the **stratified-blind eval queries** (decision 27):
realistic user search queries, each targeting a known catalog market by `id` (the by-construction label, E8).

**How to use it — keep it blind.**
1. Open a **fresh chat** with a strong model (**GPT-5.5** preferred for the cross-model guard; **Sonnet** is
   fine) — a session that has **not** seen the doc-view design or the failure list. That blindness is what
   keeps the eval honest.
2. Replace the example `INPUT` batch with your full stratified sample — sample `quota` markets per family
   from [`eval-families.json`](../../data/football/eval-families.json), pulling each market's `name`,
   `subject` and a `category` from `data/football/football_criterions.json`. (You can paste one family at a
   time or all at once.)
3. Save the model's JSON output to `data/football/tier1-extractor-queries.json`. Those queries then go
   through **real Haiku** (cached) before grounding.

> Do **not** run this inside the design conversation / with an assistant that has read `tier_1_automation.md`
> — it would author queries that already know the answers (memorization, not generalization).

---

## Prompt (copy everything in this block)

````
You are a football bettor typing a short query into a search box to find ONE specific betting market.
You will be given a list of target markets. Write ONE natural query for EACH market.

For each market you get its official catalog `name`, its `category` (a hint), and its `subject` — either a
team/match-level market, or a single named player. Write the query the way a REAL PERSON searches, not the
way a betting site labels markets.

HARD RULES
1. Target the market's MEANING — do NOT reuse the distinctive words of its official name. If the name is
   "Total Corners", do NOT write "total corners"; write something like "how many corners in the game".
   Reusing the catalog name defeats the entire purpose.
2. Sound like a real user: casual, short, sometimes vague or sloppy. You MAY include a team name, a
   competition, or context ("in the Brazil game", "World Cup final"). If the subject is a player, phrase it
   about a player and use a plausible player name (e.g. "will Mbappé ...").
3. Don't be cryptic and don't write riddles. Natural, not a puzzle.
4. Vary your phrasing across markets — do not reuse a single template.
5. Exactly ONE query per market, and keep its `id`.

OUTPUT
Return ONLY a JSON array — one object per input market, in the same order — and nothing else (no prose, no
markdown fences), so it can be saved straight to a file:
[ { "id": <number>, "q": "<the query>" }, ... ]

EXAMPLES (good vs. bad)
  "Total Corners"               -> good: "how many corners in the Brazil game"          bad: "total corners"
  "To keep a clean sheet" (plr) -> good: "will their keeper keep it tight at the back"  bad: "to keep a clean sheet"
  "Draw No Bet"                 -> good: "back France but refund my stake if it draws"  bad: "draw no bet"
  "Top Goal Scorer" (player)    -> good: "who ends the tournament as leading scorer"    bad: "top goal scorer"

[
  {
    "id": 1001642863,
    "name": "Both Teams To Score - 1st Half",
    "category": "Half Time",
    "subject": "team/match"
  },
  {
    "id": 1001642868,
    "name": "Both Teams To Score - 2nd Half",
    "category": "Half Time",
    "subject": "team/match"
  },
  {
    "id": 1001657421,
    "name": "Both Teams to Score in Both Halves",
    "category": "Both Teams to Score",
    "subject": "team/match"
  },
  {
    "id": 1001957106,
    "name": "Home Team to Win and Both Teams To Score",
    "category": "Both Teams to Score",
    "subject": "team/match"
  },
  {
    "id": 1001957108,
    "name": "Away Team to Win and Both Teams To Score",
    "category": "Both Teams to Score",
    "subject": "team/match"
  },
  {
    "id": 1002363220,
    "name": "Draw and Both Teams To Score",
    "category": "Both Teams to Score",
    "subject": "team/match"
  },
  {
    "id": 1004808233,
    "name": "Both teams to score - including extra time",
    "category": "BTTS",
    "subject": "team/match"
  },
  {
    "id": 2100100122,
    "name": "Both Teams To Score - Extra Time",
    "category": "Extra Time",
    "subject": "team/match"
  },
  {
    "id": 2100111420,
    "name": "Home Team to win or draw and both teams to score",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 2100111421,
    "name": "Away Team to win or draw and both teams to score",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 2100111422,
    "name": "Either team to win and both teams to score",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 2100111705,
    "name": "Double Chance and Both Teams to Score",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001159610,
    "name": "Next Corner, No Corner No Bet ({0})",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1001159807,
    "name": "Most Corners",
    "category": "Cards & Corners",
    "subject": "team/match"
  },
  {
    "id": 1001159897,
    "name": "Total Corners",
    "category": "Cards & Corners",
    "subject": "team/match"
  },
  {
    "id": 1001159899,
    "name": "Corners Handicap - 1st Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1001159951,
    "name": "Total Corners - 2nd Half",
    "category": "Cards & Corners",
    "subject": "team/match"
  },
  {
    "id": 1001239604,
    "name": "First to 3 Corners",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1001967052,
    "name": "Total Corners - {0}:00-{1}:59",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1001980238,
    "name": "Total Corners Including Extra Time",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1002114152,
    "name": "Total cumulative corners kicked",
    "category": "Matchday Specials",
    "subject": "team/match"
  },
  {
    "id": 1002467526,
    "name": "Total Corners - Low Alternate Line",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1002483414,
    "name": "Corners Handicap - 2nd Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1002483456,
    "name": "Corners 3-Way Handicap",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1003016277,
    "name": "Match outcome & Over/Under 10.5 corners taken",
    "category": "Match Parlay",
    "subject": "team/match"
  },
  {
    "id": 1003226217,
    "name": "First Corner (Draw: No Corner) {0}:00-{1}:59 - 2nd Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1003226219,
    "name": "First Corner (Draw: No Corner) {0}:00-{1}:59 - Extra Time 2nd Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1003246244,
    "name": "Corner {0}:00-{1}:59 - 2nd Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1003246271,
    "name": "Corner {0}:00-{1}:59 - Extra Time 1st Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 1003303619,
    "name": "Home team to win in Extra Time, match to have over 11.5 Corners & Under 2.5 Cards",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004556491,
    "name": "Total goals scored (2.5) & Total corners taken (9.5)",
    "category": "Match Parlay",
    "subject": "team/match"
  },
  {
    "id": 1004670636,
    "name": "Grand Salami - Total Corners",
    "category": "1X2",
    "subject": "team/match"
  },
  {
    "id": 1004702150,
    "name": "At least 1 goal scored straight from a direct corner kick without being deflected/touched by any player",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004727049,
    "name": "Home team to Win, Home team Over 5.5 Shots on Target & Home team Over 5.5 Corners",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 1005189536,
    "name": "Match outcome & total corners taken {0}.5",
    "category": "Match Parlay",
    "subject": "team/match"
  },
  {
    "id": 1005189537,
    "name": "Total goals scored {0}.5 & Total corners taken {1}.5",
    "category": "Match Parlay",
    "subject": "team/match"
  },
  {
    "id": 2100011878,
    "name": "Total number of corners in the matches on this date",
    "category": "Price Boost",
    "subject": "team/match"
  },
  {
    "id": 2100044967,
    "name": "Total Corners By Home Team - 2nd Half",
    "category": "Corners",
    "subject": "team/match"
  },
  {
    "id": 2100092354,
    "name": "Arsenal to score within 15 seconds of taking a corner",
    "category": "Shots on target Slot 2",
    "subject": "team/match"
  },
  {
    "id": 2100109403,
    "name": "Most Corners - Extra Time",
    "category": "Corners Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1001159493,
    "name": "Next Card ({0}) No Card No Bet",
    "category": "Cards",
    "subject": "team/match"
  },
  {
    "id": 1001159573,
    "name": "Card awarded - {0}0:00-{1}9:59",
    "category": "Time Intervals",
    "subject": "team/match"
  },
  {
    "id": 1001159706,
    "name": "Total Booking Points - 2nd Half",
    "category": "Cards & Corners",
    "subject": "team/match"
  },
  {
    "id": 1001159856,
    "name": "Total Booking Points by Home Team",
    "category": "Booking Points",
    "subject": "team/match"
  },
  {
    "id": 1001239612,
    "name": "Half with most Booking Points",
    "category": "Disciplinary",
    "subject": "team/match"
  },
  {
    "id": 1001770648,
    "name": "Total Yellow Cards",
    "category": "Disciplinary",
    "subject": "team/match"
  },
  {
    "id": 1001774532,
    "name": "Home Team given a Red Card",
    "category": "Cards",
    "subject": "team/match"
  },
  {
    "id": 1001774541,
    "name": "Red card given - 00:00-09:59",
    "category": "Disciplinary",
    "subject": "team/match"
  },
  {
    "id": 1002114163,
    "name": "Player to be shown the fastest card from kick off in the respective match",
    "category": "Matchday Specials",
    "subject": "team/match"
  },
  {
    "id": 1002133405,
    "name": "Red Card given - Extra Time",
    "category": "Cards",
    "subject": "team/match"
  },
  {
    "id": 1002506035,
    "name": "Booking Points Handicap",
    "category": "Booking Points",
    "subject": "team/match"
  },
  {
    "id": 1002506161,
    "name": "First to ({0}) Booking Points",
    "category": "Booking Points",
    "subject": "team/match"
  },
  {
    "id": 1002603598,
    "name": "Number of cumulative Red Cards shown in the Semi Finals",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1002702960,
    "name": "Total Cards - 2nd Half",
    "category": "Cards",
    "subject": "team/match"
  },
  {
    "id": 1003258992,
    "name": "Referee to give at least three yellow cards to one player in one match",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1003269244,
    "name": "At least 1 player sitting on the substitute bench to get a red card",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1003430635,
    "name": "Team to receive least Red Cards",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1004713992,
    "name": "Highest number of cards received by a team during the Competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1005579232,
    "name": "Manager to be sent off the pitch in any match during the competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1007667999,
    "name": "Marek Hamsik to score & get a card & Juraj Kucka to give an assist",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 1007748376,
    "name": "Marek Hamšík to score & get a card & Robert Mak to give an assist",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 1007764420,
    "name": "Diogo Jota to score & give an assist & Jan Vertonghen & Toby Alderweireld both to get a card",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 1007794449,
    "name": "Spain to win & Álvaro Morata to score & Pedri to give an assist & Sergio Busquets to get a card",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 1007794460,
    "name": "Pedri to score & give an assist & Giorgio Chiellini & Leonardo Bonucci both to get a card",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 2100011876,
    "name": "Total number of yellow cards in the matches on this date",
    "category": "Price Boost",
    "subject": "team/match"
  },
  {
    "id": 1001159978,
    "name": "Away Team to score next penalty ({0})",
    "category": "Away Penalties",
    "subject": "team/match"
  },
  {
    "id": 1001877372,
    "name": "Team to concede a penalty in the Tournament/League",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1003146082,
    "name": "Next Goal {0} scored by a Penalty - (No goal, No bet)",
    "category": "Next Method of Scoring",
    "subject": "team/match"
  },
  {
    "id": 1003247833,
    "name": "Most Free Kicks - 1st Half",
    "category": "Free Kicks",
    "subject": "team/match"
  },
  {
    "id": 1003247835,
    "name": "Most Free Kicks - {0}:00-{1}:59",
    "category": "Time Intervals",
    "subject": "team/match"
  },
  {
    "id": 1003247843,
    "name": "Total Free Kicks by Home Team - 1st Half",
    "category": "Free Kicks",
    "subject": "team/match"
  },
  {
    "id": 1003249042,
    "name": "Next Free Kick ({0}) (No Free Kick No Bet)",
    "category": "Free Kicks",
    "subject": "team/match"
  },
  {
    "id": 1003258903,
    "name": "Number of Direct Free Kicks scored in the Competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1003272107,
    "name": "Penalty Awarded {0} - To be scored (Extra Time)",
    "category": "Most Popular",
    "subject": "team/match"
  },
  {
    "id": 1004411242,
    "name": "Total penalties converted by Away Team in Penalty Shoot Out",
    "category": "Penalties",
    "subject": "team/match"
  },
  {
    "id": 1004411244,
    "name": "Correct Score - Penalty Shoot Out",
    "category": "Penalties",
    "subject": "team/match"
  },
  {
    "id": 1004459437,
    "name": "Number of goals scored in the Competition including extra time excluding penalty shootout",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004702194,
    "name": "At least 1 goalkeeper to score a goal from own Penalty Box - Excluding Own Goals",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1007676980,
    "name": "To win at least one penalty shoot-out",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1007764603,
    "name": "Gareth Bale to score in Penalty Shootout - Bets void if the player does not take a penalty in the shootout",
    "category": "Penalties",
    "subject": "team/match"
  },
  {
    "id": 1007764665,
    "name": "Georginho Wijnaldum to score in Penalty Shootout - Bets void if the player does not take a penalty in the shootout",
    "category": "Penalties",
    "subject": "team/match"
  },
  {
    "id": 1007764866,
    "name": "Toni Kroos to score in Penalty Shootout - Bets void if the player does not take a penalty in the shootout",
    "category": "Penalties",
    "subject": "team/match"
  },
  {
    "id": 2100097662,
    "name": "Total Penalties Awarded",
    "category": "Match Events",
    "subject": "team/match"
  },
  {
    "id": 1001159861,
    "name": "Most Offsides",
    "category": "Match and Team Stats",
    "subject": "team/match"
  },
  {
    "id": 1001239638,
    "name": "Total Fouls committed by Home Team",
    "category": "Fouls Committed",
    "subject": "team/match"
  },
  {
    "id": 1001239657,
    "name": "Total Ball possession (%) by Home Team (Settled using Opta Data)",
    "category": "Ball Possession",
    "subject": "team/match"
  },
  {
    "id": 1001240971,
    "name": "First throw-in",
    "category": "Match Events",
    "subject": "team/match"
  },
  {
    "id": 1001772887,
    "name": "A shot to hit the Post or Crossbar (which does not result in a goal)",
    "category": "Match Events",
    "subject": "team/match"
  },
  {
    "id": 1001957110,
    "name": "Total Shots off Target",
    "category": "Match Stats",
    "subject": "team/match"
  },
  {
    "id": 1002153710,
    "name": "Total Shots off Target - Including Extra Time",
    "category": "Match Stats",
    "subject": "team/match"
  },
  {
    "id": 1002153721,
    "name": "Most Offsides - Including Extra Time",
    "category": "Match and Team Stats",
    "subject": "team/match"
  },
  {
    "id": 1002615262,
    "name": "Match with most Shots on Target",
    "category": "Match Stats",
    "subject": "team/match"
  },
  {
    "id": 1002940287,
    "name": "First Throw-In Awarded (Draw: No Throw-In) {0}:00-{1}:59",
    "category": "4",
    "subject": "team/match"
  },
  {
    "id": 1002955490,
    "name": "First Throw-In Awarded (Draw: No Throw-In) {0}:00-{1}:59 Including Extra Time",
    "category": "4",
    "subject": "team/match"
  },
  {
    "id": 1003042067,
    "name": "Next Throw-In Awarded After {0}:{1}0 of 2nd Half",
    "category": "Instant Betting",
    "subject": "team/match"
  },
  {
    "id": 1003042068,
    "name": "Next Throw-In Awarded After {0}:{1}0 of Extra Time 1st Half",
    "category": "Instant Betting",
    "subject": "team/match"
  },
  {
    "id": 1003042069,
    "name": "Next Throw-In Awarded After {0}:{1}0 of Extra Time 2nd Half",
    "category": "Instant Betting",
    "subject": "team/match"
  },
  {
    "id": 1003247808,
    "name": "Most Goal Kicks - 1st Half",
    "category": "Goal Kicks",
    "subject": "team/match"
  },
  {
    "id": 1003247825,
    "name": "Total Goal Kicks by Away Team - {0}:00-{1}:59",
    "category": "Time Intervals",
    "subject": "team/match"
  },
  {
    "id": 1003247830,
    "name": "First to {0} Goal Kicks (Draw: Neither Team) - Including Extra Time",
    "category": "Goal Kicks",
    "subject": "team/match"
  },
  {
    "id": 1003264116,
    "name": "At least 1 goalkeeper to score from a goal kick",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1004544392,
    "name": "Total Shots Odd/Even",
    "category": "Match and Team Shots",
    "subject": "team/match"
  },
  {
    "id": 1004673892,
    "name": "Total Shots by Away Team - Including Extra Time (Settled using Opta Data)",
    "category": "Match Stats",
    "subject": "team/match"
  },
  {
    "id": 1005064680,
    "name": "Total Shots on Target - {0}0:00-{1}9:59",
    "category": "Time Intervals",
    "subject": "team/match"
  },
  {
    "id": 1007674387,
    "name": "Time of first substitution",
    "category": "Substitution / Stoppage Time",
    "subject": "team/match"
  },
  {
    "id": 1007684539,
    "name": "Total Fouls conceded by Home Team - Including Extra Time (Settled using Opta Data)",
    "category": "Match and Team Fouls",
    "subject": "team/match"
  },
  {
    "id": 1007694616,
    "name": "Total Shots on Target by Artem Dzyuba & Denis Cheryshev",
    "category": "Match and Team Shots",
    "subject": "team/match"
  },
  {
    "id": 1007817310,
    "name": "Over 10.5 Shots on Target & Away Team to win the Trophy - Including Extra Time",
    "category": "Match and Team Shots",
    "subject": "team/match"
  },
  {
    "id": 1008060971,
    "name": "Total Shots on Target by Zlatan Ibrahimović & Ante Rebić",
    "category": "Match and Team Shots",
    "subject": "team/match"
  },
  {
    "id": 2100014579,
    "name": "Tiago Thomas shots on target",
    "category": "Match and Team Shots",
    "subject": "team/match"
  },
  {
    "id": 2100041233,
    "name": "1+ shot on target each in the 1st half",
    "category": "1st Half Specials",
    "subject": "team/match"
  },
  {
    "id": 1000505272,
    "name": "Correct Score - 1st Half",
    "category": "Correct Score",
    "subject": "team/match"
  },
  {
    "id": 1001159780,
    "name": "Correct Score",
    "category": "Correct Score",
    "subject": "team/match"
  },
  {
    "id": 1001240988,
    "name": "Exact margin of goal difference in the match",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001241014,
    "name": "Exact Finishing Order (1st & 2nd placed)",
    "category": "Competition Combinations",
    "subject": "team/match"
  },
  {
    "id": 1001241030,
    "name": "Exact Finishing Order (1st-4th placed)",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1001293208,
    "name": "Last goalscorer & correct score",
    "category": "Scorecast",
    "subject": "team/match"
  },
  {
    "id": 1001475014,
    "name": "Exact Winning Margin",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001568619,
    "name": "Correct Score - 2nd Half",
    "category": "Half Time",
    "subject": "team/match"
  },
  {
    "id": 1001980219,
    "name": "Correct Score Including Extra Time",
    "category": "Full Time Including Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1002236023,
    "name": "Exact Finishing Order (1st-5th placed)",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1002627042,
    "name": "Exact Finishing Order (2nd-4th placed)",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1002725250,
    "name": "Exact Finishing Order (1st-3rd placed)",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004552219,
    "name": "Correct Score - Group",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1004829690,
    "name": "Exact Finishing Order (1st & 2nd placed) - Including Playoffs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004830083,
    "name": "Exact Finishing Order (1st & 2nd placed) - Excluding Playoffs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1005046923,
    "name": "Exact Winning Margin - 1st Half",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1005046925,
    "name": "Exact Winning Margin - 2nd Half",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1005046963,
    "name": "Exact Winning Margin - Including Extra Time",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 2100109401,
    "name": "Correct Score - Extra Time",
    "category": "Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1000105110,
    "name": "First Goal. No Goal, No Bet",
    "category": "First & Last Goal",
    "subject": "team/match"
  },
  {
    "id": 1001239590,
    "name": "Last Goal (Draw: No Goals)",
    "category": "First & Last Goal",
    "subject": "team/match"
  },
  {
    "id": 1001240977,
    "name": "Time of first goal scored by the Home Team",
    "category": "Match Events",
    "subject": "team/match"
  },
  {
    "id": 1001241016,
    "name": "Team to Score Least Goals",
    "category": "Matchups",
    "subject": "team/match"
  },
  {
    "id": 1001271977,
    "name": "Team to score First Goal in respective match",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1001642860,
    "name": "Away Team To Score",
    "category": "Both Teams to Score",
    "subject": "team/match"
  },
  {
    "id": 1001642861,
    "name": "Goal scored - 00:00-29:59",
    "category": "Goal Interval",
    "subject": "team/match"
  },
  {
    "id": 1001774526,
    "name": "Goal scored - Stoppage Time",
    "category": "Goal Interval",
    "subject": "team/match"
  },
  {
    "id": 1001903232,
    "name": "Scorecast - First Goal",
    "category": "Scorecast/Wincast",
    "subject": "team/match"
  },
  {
    "id": 1001956104,
    "name": "Any team to score at least 5 goals",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1001961573,
    "name": "Team to score first goal in the respective matches",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1002114354,
    "name": "Team to score the fastest goal from kick off in the respective match",
    "category": "Matchday Specials",
    "subject": "team/match"
  },
  {
    "id": 1003146061,
    "name": "Method of scoring next Goal {0} - (No goal, No bet)",
    "category": "Next Method of Scoring",
    "subject": "team/match"
  },
  {
    "id": 1003267632,
    "name": "Method of Last Goal scored in the Competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1003337557,
    "name": "Team to Score Least Goals - Excluding Play Offs",
    "category": "Team Goals",
    "subject": "team/match"
  },
  {
    "id": 1004154937,
    "name": "Home Team to score from a header",
    "category": "Match Events",
    "subject": "team/match"
  },
  {
    "id": 1004154943,
    "name": "Away Team to score from a header",
    "category": "Match Events",
    "subject": "team/match"
  },
  {
    "id": 1004699015,
    "name": "At least 1 goal to be scored in stoppage time of Extra Time",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004728665,
    "name": "Home team to score first in first half, away team to score first in second half & Over 4.5 goals",
    "category": "Match Combinations",
    "subject": "team/match"
  },
  {
    "id": 2100006003,
    "name": "First team to score against FC Copenhagen in next 3 superliga matches",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1001159633,
    "name": "Total Goals by Away Team",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001159926,
    "name": "Total Goals",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001159967,
    "name": "Total Goals by Home Team",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001221616,
    "name": "Fantasy Match - Total Goals Scored",
    "category": "Fantasy Match",
    "subject": "team/match"
  },
  {
    "id": 1001241025,
    "name": "Number of team goals",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1001242984,
    "name": "Half with most Goals scored",
    "category": "Half Time",
    "subject": "team/match"
  },
  {
    "id": 1001537187,
    "name": "Grand Salami - Total Goals Scored",
    "category": "1X2",
    "subject": "team/match"
  },
  {
    "id": 1001711098,
    "name": "Number of goals scored by the team in the Competition",
    "category": "Team Goals",
    "subject": "team/match"
  },
  {
    "id": 1001892836,
    "name": "Number of goals scored in the Competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1001892837,
    "name": "Number of Own Goals Scored in the Competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1001980239,
    "name": "Total Goals Including Extra Time",
    "category": "Full Time Including Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1001980242,
    "name": "Total Goals by Home Team Including Extra Time",
    "category": "Full Time Including Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1002109521,
    "name": "Stadium to feature least goals scored in the Competition",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1002114151,
    "name": "Total cumulative goals scored",
    "category": "Matchday Specials",
    "subject": "team/match"
  },
  {
    "id": 1002567388,
    "name": "Exact amount of goals scored by Away Team",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1003194956,
    "name": "Total Goals by Away Team - 1st Half",
    "category": "Half Time",
    "subject": "team/match"
  },
  {
    "id": 1003194958,
    "name": "Total Goals by Home Team - 1st Half",
    "category": "Half Time",
    "subject": "team/match"
  },
  {
    "id": 1003194959,
    "name": "Total Goals by Home Team - 2nd Half",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1003272613,
    "name": "Number of goals scored by the team in the Group Stage",
    "category": "Team Goals",
    "subject": "team/match"
  },
  {
    "id": 1003371562,
    "name": "Number of goals scored by the team in the Competition - Excluding Play Offs",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1003831128,
    "name": "Number of goals scored in the Competition - Excluding Playoffs",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004530989,
    "name": "Number of goals conceded by the team in the Competition - Excluding Playoffs",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1004552220,
    "name": "Exact Total Goals",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1004561501,
    "name": "Total goals scored in the mentioned matches",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1004670634,
    "name": "Grand Salami - Total Goals - 1st Half",
    "category": "1X2",
    "subject": "team/match"
  },
  {
    "id": 1006170149,
    "name": "Combined goals scored by Imad Khalili and Abdul Khalili in Allsvenskan 2020",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1008020145,
    "name": "Goals scored by Malmö in the group",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 2100047425,
    "name": "Number of Goalscorers",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 2100092368,
    "name": "Total Goals Interval - {0}:00-{1}:59",
    "category": "Interval O/U",
    "subject": "team/match"
  },
  {
    "id": 2100093908,
    "name": "Total number of goals scored by Away Teams in the matches on this date",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 2100095461,
    "name": "Total Goals Interval Away Team - {0}:00-{1}:59",
    "category": "Time Intervals",
    "subject": "team/match"
  },
  {
    "id": 2100095625,
    "name": "Which player will reach 10 Premier League goals scored first",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 2100097912,
    "name": "Total Goals - Extra Time",
    "category": "Extra Time",
    "subject": "team/match"
  },
  {
    "id": 2100100120,
    "name": "Total Goals By Home Team - Extra Time",
    "category": "Extra Time",
    "subject": "team/match"
  },
  {
    "id": 2100100121,
    "name": "Total Goals By Away Team - Extra Time",
    "category": "Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1001241028,
    "name": "To qualify from Group Stage",
    "category": "Most Popular",
    "subject": "team/match"
  },
  {
    "id": 1001320509,
    "name": "Team(s) to finish in Bottom 2",
    "category": "Finishing Position",
    "subject": "team/match"
  },
  {
    "id": 1001370411,
    "name": "To reach the Quarter Final",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1001518843,
    "name": "Finishing position in the Competition",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1001537279,
    "name": "Exact combination of relegated teams",
    "category": "Relegation",
    "subject": "team/match"
  },
  {
    "id": 1001627244,
    "name": "Team to finish in 3rd place",
    "category": "Finishing Position",
    "subject": "team/match"
  },
  {
    "id": 1001728706,
    "name": "Top English Team",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1001728707,
    "name": "Top German Team",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1001955975,
    "name": "Team to obtain most points in Group Stage",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1002055416,
    "name": "At least 1 own goal scored in the Competition by a player from this Nation",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1002207343,
    "name": "Exact treble combination of relegated teams",
    "category": "Relegation",
    "subject": "team/match"
  },
  {
    "id": 1002520396,
    "name": "To qualify for Play-Off",
    "category": "Team Progress",
    "subject": "team/match"
  },
  {
    "id": 1002703415,
    "name": "Number of promoted teams to play a Top 4 team on their first match",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1003217206,
    "name": "To win the league in this round",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1003218195,
    "name": "Teams to qualify from Group Stage",
    "category": "Team Progress",
    "subject": "team/match"
  },
  {
    "id": 1003245296,
    "name": "Teams to reach the Final",
    "category": "Team Progress",
    "subject": "team/match"
  },
  {
    "id": 1003267513,
    "name": "Number of assists in the Competition",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1003369598,
    "name": "To go the whole season without winning a game in Tournament/League",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1003884431,
    "name": "Team to finish in 7th place",
    "category": "Finishing Position",
    "subject": "team/match"
  },
  {
    "id": 1004315271,
    "name": "To qualify for the World Cup",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004331841,
    "name": "Team to qualify for the next playoff stage",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004632734,
    "name": "Number of teams from Eliteserien eliminated in the first ordinary round of the cup",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1004699099,
    "name": "All teams to score at least 1 goal during all 16 matches in Group Stage Match Day 1",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004829693,
    "name": "Exact Combination of Competition Winner & Top Goalscorer - Including Playoffs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1005608989,
    "name": "Team(s) to finish in Bottom 2 - Excluding Play Offs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1006793528,
    "name": "To lift the trophy",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1007477783,
    "name": "To finish top 3 + to have most clean sheets in Allsvenskan 2021",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 2100030087,
    "name": "Swedish teams to qualify for European football group stage",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 2100054822,
    "name": "Final between two teams from the Italian Serie A",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 2100062245,
    "name": "To win the Champions League, Premier League, FA Cup & EFL Cup",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 2100062476,
    "name": "To win the Premier League & EFL Cup",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 2100062479,
    "name": "To win the Champions League, FA Cup & EFL Cup",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 2100062480,
    "name": "To win the Premier League, FA Cup & EFL Cup",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 2100108271,
    "name": "Spanish Teams to win all three European Trophies (Champions League, Europa League, Conference League).",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 2100112425,
    "name": "Arsenal not to win the league and Tottenham to stay up",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1001243154,
    "name": "To be Chairperson of the Club",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1001478672,
    "name": "Assistant Head Coach/Manager of the team",
    "category": "Management",
    "subject": "team/match"
  },
  {
    "id": 1001518728,
    "name": "Team with lowest average home attendance",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1001518729,
    "name": "Team with highest average total attendance",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1001518731,
    "name": "Team with highest average home attendance",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1001774699,
    "name": "To have joint Head Coach/Manager in the team",
    "category": "Management",
    "subject": "team/match"
  },
  {
    "id": 1003080650,
    "name": "To sign for the club during the managerial tenure of Pep Guardiola",
    "category": "Transfers",
    "subject": "team/match"
  },
  {
    "id": 1004488595,
    "name": "Next Head Coach/Manager",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004673130,
    "name": "Any manager to be sent to the stands in any match",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004974858,
    "name": "Ultimo Marcatore - Squadra Casa",
    "category": "Goal Scorer #2",
    "subject": "team/match"
  },
  {
    "id": 1004974866,
    "name": "Ultimo Marcatore - Squadra Ospite",
    "category": "Goal Scorer #2",
    "subject": "team/match"
  },
  {
    "id": 1005255361,
    "name": "Transfer record to be broken",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1006032756,
    "name": "Coach Van Het Jaar",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1007012955,
    "name": "Zlatan Ibrahimović to be included in Sweden's squad for Euro 2020",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1007383398,
    "name": "Zlatan Ibrahimović to be included in Sweden's squad for the WC 2022 Qualification matches against Georgia and Kosovo",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1001159711,
    "name": "Handicap",
    "category": "Full Time",
    "subject": "team/match"
  },
  {
    "id": 1001224738,
    "name": "Fantasy Match - Double Chance",
    "category": "Fantasy Match",
    "subject": "team/match"
  },
  {
    "id": 1001568620,
    "name": "3-Way Handicap - 1st Half",
    "category": "3-Way Handicap",
    "subject": "team/match"
  },
  {
    "id": 1001604934,
    "name": "Winner - Including Play Offs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1001957585,
    "name": "Nationality of Winner",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1001980224,
    "name": "Handicap Including Extra Time",
    "category": "Full Time Including Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1002208811,
    "name": "Winner - Including Handicap",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1002254479,
    "name": "Asian Handicap - 1st Half",
    "category": "Asian Lines",
    "subject": "team/match"
  },
  {
    "id": 1002750017,
    "name": "Winner without Juventus & Roma",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003100962,
    "name": "Winner without Los Angeles Galaxy & New York Red Bulls",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003300562,
    "name": "Winner without Ajax",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003318821,
    "name": "Winner without Paris SG",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003324068,
    "name": "Winner without Celtic & Rangers FC",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003325552,
    "name": "Winner without VfB Stuttgart",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003387674,
    "name": "Winner without Fenerbahçe",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003729324,
    "name": "Winner without Beşiktaş",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003815443,
    "name": "Winner without HJK & SJK",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003822379,
    "name": "Winner without Dalkurd FF",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003826304,
    "name": "Winner Without Seattle Sounders & Toronto FC",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1003934916,
    "name": "Match Winner & Player Goals Double",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1004010822,
    "name": "Winner without FCSB - Excluding Play Offs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004046367,
    "name": "Winner without Ajax, PSV Eindhoven & Feyenoord",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004115279,
    "name": "Winner without FC Copenhagen & Brøndby IF",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004289607,
    "name": "Winner without Fortuna Düsseldorf",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004461601,
    "name": "Winner without Rosenborg & Molde",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004523520,
    "name": "Winner without FCSB and CFR Cluj",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004532894,
    "name": "Winner without Helsingborgs IF",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004681720,
    "name": "Golden Boot winner to score all goals with his head",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004709200,
    "name": "Winner without Hammarby",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004712875,
    "name": "Map Handicap",
    "category": "Match",
    "subject": "team/match"
  },
  {
    "id": 1004714521,
    "name": "Boosted Odds - Match Winner",
    "category": "Price Boost",
    "subject": "team/match"
  },
  {
    "id": 1004825852,
    "name": "Winner without Manchester City & Liverpool",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004851312,
    "name": "Winner Without FC Köln",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1004879795,
    "name": "Winner without Málaga & Deportivo La Coruña",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1005211214,
    "name": "Regional Federation of Winner",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1006086031,
    "name": "Winner without Halmstads BK & Örgryte IS",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1006158146,
    "name": "Winner without Molde",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 1006673629,
    "name": "Winner without Ajax, AZ Alkmaar, Feyenoord & PSV Eindhoven - Excluding Play Offs",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 2100062844,
    "name": "Winner Without Mamelodi Sundowns",
    "category": "Competition",
    "subject": "team/match"
  },
  {
    "id": 2100109405,
    "name": "Handicap - Extra Time",
    "category": "Extra Time",
    "subject": "team/match"
  },
  {
    "id": 1004544407,
    "name": "To have most Shots (Settled using Opta data)",
    "category": "Match and Team Shots",
    "subject": "player"
  },
  {
    "id": 1006674743,
    "name": "Alejandro \"Papu\" Gómez shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 1007684725,
    "name": "Player’s shots on target from outside the penalty box",
    "category": "Player Shots on Target",
    "subject": "player"
  },
  {
    "id": 1007684752,
    "name": "Player's shots on target by header",
    "category": "Player Shots on Target",
    "subject": "player"
  },
  {
    "id": 1007714003,
    "name": "Goran Pandev shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100005175,
    "name": "Raphinha shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100009212,
    "name": "Ryan Kent shots on target",
    "category": "Match and Team Shots",
    "subject": "player"
  },
  {
    "id": 2100009600,
    "name": "Thiago Alcantara shots on target",
    "category": "Match and Team Shots",
    "subject": "player"
  },
  {
    "id": 2100010166,
    "name": "Krzysztof Piatek shots on target",
    "category": "Match and Team Shots",
    "subject": "player"
  },
  {
    "id": 2100014175,
    "name": "Beto shots on target",
    "category": "Match and Team Shots",
    "subject": "player"
  },
  {
    "id": 2100018174,
    "name": "Youssef Msakni shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018175,
    "name": "Issam Jebali shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018178,
    "name": "Seifeddine Jaziri shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018248,
    "name": "Darko Lazovic shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018273,
    "name": "Maxi Gómez shots on target",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018547,
    "name": "Total Shots on Target by Richarlison & Raphinha",
    "category": "Player Shots on Target",
    "subject": "player"
  },
  {
    "id": 2100018667,
    "name": "Firas Al-Buraikan total shots",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018760,
    "name": "Selim Amallah total shots",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018841,
    "name": "Hwang Hee-Chan total shots",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100018854,
    "name": "Richarlison total shots",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100019512,
    "name": "Tim Weah total shots",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100034283,
    "name": "Player's shots on target",
    "category": "Player Shots on Target",
    "subject": "player"
  },
  {
    "id": 2100085317,
    "name": "Player to have next Shot on Target ({0}), No Shot on Target No Bet (Settled Using Opta Data)",
    "category": "Player Shots On Target",
    "subject": "player"
  },
  {
    "id": 2100088730,
    "name": "Shots By The Player (Settled by Opta Data)",
    "category": "Player Shots",
    "subject": "player"
  },
  {
    "id": 2100094011,
    "name": "Pedri and Raphinha each to have 1+ shots on target",
    "category": "Player Combinations",
    "subject": "player"
  },
  {
    "id": 1001159667,
    "name": "To Get a Card",
    "category": "Cards",
    "subject": "player"
  },
  {
    "id": 1001240965,
    "name": "To score & get booked",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001489271,
    "name": "To get first Red Card",
    "category": "Disciplinary",
    "subject": "player"
  },
  {
    "id": 1001517978,
    "name": "Player to receive most Yellow Cards in the Competition",
    "category": "Player Cards",
    "subject": "player"
  },
  {
    "id": 1001839907,
    "name": "Player not to start the match and to get a Red Card",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002003246,
    "name": "To get a card for diving",
    "category": "Player Cards",
    "subject": "player"
  },
  {
    "id": 1002077068,
    "name": "Player to receive the fastest Card from Kick Off",
    "category": "Player Cards",
    "subject": "player"
  },
  {
    "id": 1002100940,
    "name": "To receive a Red Card in any group stage match",
    "category": "Player Cards",
    "subject": "player"
  },
  {
    "id": 1002188949,
    "name": "Number of Yellow Cards given to the player in the Competition",
    "category": "Disciplinary",
    "subject": "player"
  },
  {
    "id": 1002661913,
    "name": "To come on as a substitute, score, get booked and player's team to win",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002661914,
    "name": "To come on as a substitute, score, get booked and player's team to lose",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1003170347,
    "name": "Number of cards given to the player in the Competition",
    "category": "Player Cards",
    "subject": "player"
  },
  {
    "id": 1004799267,
    "name": "To score, give an assist & get booked",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1004833953,
    "name": "Number of cards received by the player in the Competition",
    "category": "Player Cards",
    "subject": "player"
  },
  {
    "id": 2100018341,
    "name": "Any substitute to get a card",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001159656,
    "name": "To have most passes completed",
    "category": "Player advanced stats",
    "subject": "player"
  },
  {
    "id": 1001159690,
    "name": "To suffer most fouls",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1001159742,
    "name": "Most Fouls committed",
    "category": "Fouls Committed",
    "subject": "player"
  },
  {
    "id": 1001240968,
    "name": "Player's fouls committed",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1001240969,
    "name": "Player's fouls suffered",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1001243170,
    "name": "To concede most fouls (Settled using Opta data)",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1001809658,
    "name": "Player's tackles completed (Settled using Opta data)",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001809659,
    "name": "Player's offside infringements (Settled using Opta Data)",
    "category": "Player advanced stats",
    "subject": "player"
  },
  {
    "id": 1002154385,
    "name": "Player's fouls committed - Including Extra Time",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1002154386,
    "name": "Player's fouls suffered - Including Extra Time",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1002154387,
    "name": "Player's pass completion % - Including Extra Time",
    "category": "Player advanced stats",
    "subject": "player"
  },
  {
    "id": 1002154388,
    "name": "Player's offside infringements - Including Extra Time (Settled using Opta Data)",
    "category": "Player advanced stats",
    "subject": "player"
  },
  {
    "id": 1002154390,
    "name": "To commit most fouls - Including Extra Time",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1002154391,
    "name": "To suffer most fouls - Including Extra Time",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1003002182,
    "name": "To have highest pass completion %",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1003400481,
    "name": "Number of offsides committed by the player in the competition",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1004670974,
    "name": "Player's tackles - gained & not gained",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1004784651,
    "name": "To commit most tackles - Including Extra Time",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1007684756,
    "name": "Player's fouls conceded - Including Extra Time (Settled using Opta Data)",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1007684761,
    "name": "Player's fouls won (Settled using Opta data)",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1007684762,
    "name": "Player's fouls won - Including Extra Time (Settled using Opta Data)",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1007684769,
    "name": "To win most fouls - Including Extra Time",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1007684777,
    "name": "Player's fouls conceded & player's fouls won",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 2100015083,
    "name": "Player's fouls won",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 2100112504,
    "name": "Player's Passes completed (Settled using Opta data)",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001159641,
    "name": "To score most goals",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1001159803,
    "name": "To Score At Least 3 Goals",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 1001159997,
    "name": "To score from outside the penalty box",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 1001160026,
    "name": "To Score At Least 2 Goals",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 1001326635,
    "name": "To score during 2nd Half",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 1001337423,
    "name": "To score from a penalty",
    "category": "James Specials",
    "subject": "player"
  },
  {
    "id": 1001376413,
    "name": "To score most goals in the Competition for the Team",
    "category": "Most Popular",
    "subject": "player"
  },
  {
    "id": 1001482031,
    "name": "To score from a direct free kick",
    "category": "James Specials",
    "subject": "player"
  },
  {
    "id": 1001489270,
    "name": "To score on debut match",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001651914,
    "name": "To score most goals in official competitions for the club",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001774492,
    "name": "Any player to score at least 2 goals",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1002090442,
    "name": "To score at least 1 own goal in the Tournament/League",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1002804695,
    "name": "French player to score most goals in the Tournament/League",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1002899070,
    "name": "To score from inside the six-yard box",
    "category": "James Specials",
    "subject": "player"
  },
  {
    "id": 1002899074,
    "name": "To score at least 3 goals, one with left foot, one with right foot & one from a header",
    "category": "James Specials",
    "subject": "player"
  },
  {
    "id": 1003113374,
    "name": "To score most goals in the Tournament/League without Gonzalo Higuaín",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1003269668,
    "name": "To score with his first touch in the Competition",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1003296986,
    "name": "Kyle Lafferty (Northern Ireland) to score next goal ({0})",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 1003584792,
    "name": "Any substitute to score the winning goal",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1004556266,
    "name": "To score most goals in the Group Stage",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1005103822,
    "name": "To score a goal and drink a beer while celebrating",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1005153919,
    "name": "Last Goal Scorer",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 1007621203,
    "name": "To score - Including Extra Time",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 2100018082,
    "name": "French Ligue 1 player to score most goals in the competition",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 2100018083,
    "name": "German Bundesliga player to score most goals in the competition",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 2100091955,
    "name": "To score at least {0} goals (Fielded Anytime)",
    "category": "Goal Scorer",
    "subject": "player"
  },
  {
    "id": 2100109433,
    "name": "To Score Or Give An Assist - Extra Time (Settled using Opta data)",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 2100112498,
    "name": "Either Player to Assist (Settled using Opta data)",
    "category": "Either Player",
    "subject": "player"
  },
  {
    "id": 2100115368,
    "name": "Either Jorge de Frutos or Alemão To Score",
    "category": "Either Player",
    "subject": "player"
  },
  {
    "id": 2100116178,
    "name": "Either Carnejy Antoine or Wilde-Donald Guerrier To Score",
    "category": "Either Player",
    "subject": "player"
  },
  {
    "id": 1001241776,
    "name": "Player's league after this transfer window",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001587771,
    "name": "To save a penalty",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1001665324,
    "name": "PFA Player of the Year",
    "category": "Player Awards",
    "subject": "player"
  },
  {
    "id": 1001800539,
    "name": "To be included in starting XI for the first match",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002055355,
    "name": "Player to start in the first match of the team",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002110722,
    "name": "Best Young Player",
    "category": "Player Awards",
    "subject": "player"
  },
  {
    "id": 1002119104,
    "name": "First player to be substituted",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002468313,
    "name": "Next player to be sold to a foreign club",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002476925,
    "name": "Number of clean sheets in the Competition",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1002779985,
    "name": "Next player to be eligible to play in this league after this transfer window",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1003354328,
    "name": "To give most assists in the Competition - Including Play Offs",
    "category": "Player Assists",
    "subject": "player"
  },
  {
    "id": 1003366829,
    "name": "To give most assists in the Competition - Excluding Play Offs",
    "category": "Player Assists",
    "subject": "player"
  },
  {
    "id": 1003367081,
    "name": "Nationality of Top Goalscorer - Excluding Play Offs",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1004119509,
    "name": "Number of assists by the player in the Competition",
    "category": "Player Assists",
    "subject": "player"
  },
  {
    "id": 1004136022,
    "name": "Number of goals scored from outside the box by the player in the League, Domestic Cups and European Cups",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1004670973,
    "name": "Player's sprints",
    "category": "Player Fouls",
    "subject": "player"
  },
  {
    "id": 1004681724,
    "name": "Any goal of the Competition scored by a player who has never scored an international goal",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1005192434,
    "name": "Female Golden boot",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1005628726,
    "name": "Number of assists delivered by the player for Anderlecht - Including Playoffs",
    "category": "Player Specials",
    "subject": "player"
  },
  {
    "id": 1007637397,
    "name": "Number of goals scored by the player in the Group Stage",
    "category": "Player Goals",
    "subject": "player"
  },
  {
    "id": 1001576426,
    "name": "To enter the field during regular time at least once",
    "category": "Team Specials",
    "subject": "team/match"
  },
  {
    "id": 1001903237,
    "name": "Wincast - Anytime Goal",
    "category": "Scorecast/Wincast",
    "subject": "team/match"
  },
  {
    "id": 1002215582,
    "name": "To win domestic double",
    "category": "Team Performance",
    "subject": "team/match"
  },
  {
    "id": 1003269321,
    "name": "At least 1 player to give at least 3 assists in one match",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1003412480,
    "name": "All listed teams to draw or lose their respective matches",
    "category": "Enhanced Accas",
    "subject": "team/match"
  },
  {
    "id": 1003871142,
    "name": "Combination Special",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1004105470,
    "name": "To win both matches against 1. FC Union Berlin",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1004450517,
    "name": "A Swedish player to be selected in the All-Star team",
    "category": "Specials",
    "subject": "team/match"
  },
  {
    "id": 1005059685,
    "name": "To happen first",
    "category": "Special Offers",
    "subject": "team/match"
  },
  {
    "id": 1007465489,
    "name": "To go undefeated in Allsvenskan 2021",
    "category": "Team Performance",
    "subject": "team/match"
  }
]
````

---

## After you have the queries
- Output shape matches `tier1-extractor-queries.json` (`{ id, q }`) — the `id` is the by-construction label,
  so grading stays id-containment + tier (E13); the phrasing never becomes the answer key.
- Optional honesty check: record the **lexical overlap** between each `q` and its target `name`, so wins can
  later be split into genuine generalization vs. near-string-matches (decision #3).
- Next step (separate, paid): run these through **real Haiku** → cache into `tier1-extractor-cache.json` →
  ground the `market_concept`s → score ON vs. OFF doc-views.
