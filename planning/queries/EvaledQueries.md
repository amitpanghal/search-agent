# Evaled Queries

A registry of queries probed end-to-end (extractor → grounding). **One entry per query, updated in
place** — re-probing a query overwrites its entry with the latest state; we do not keep old runs.

Each entry logs four things, in plain English:
1. **Query** — the raw text probed.
2. **Extractor** — what the extractor pulled out (subjects, market concepts, lines).
3. **Grounding** — what each concept grounded to (the real catalog market).
4. **Status** — correct or incorrect, and why if incorrect.

The **Query Index** lists every query that has an entry. **Known Errors** tracks standing extractor
weaknesses (update a status when revisiting).

---

## Query Index

1. outright winner odds for World Cup 2026 across all 48 teams
2. back France to win the tournament and reach the final as well
3. top goalscorer outright markets for WC 26, including the top five favourites
4. Golden Ball (Player of the Tournament) outright odds for the World Cup
5. which group England will win, plus their stage of elimination market
6. the "to reach the final" outrights for both Brazil and Argentina
7. top European nation and top South American nation outright markets for WC 26
8. outright winner of Group A through Group L for the World Cup 2026
9. Young Player of the Tournament outright and the Golden Glove (best goalkeeper) market
10. Spain's outrights: to win the group, to reach the semi-finals, and to win the tournament
11. the "name the finalists" outright and the "winning confederation" market for WC 26
12. dark horse outrights, top scorer by nation, and the highest-placed debutant team market
13. the "to win the World Cup from the group stage" outright for the four hosts plus the top seeds
14. stage of elimination outrights for Portugal, Germany, and the Netherlands
15. team to score the most goals and the team with the best defensive record at WC 26
16. France -1.5 Asian handicap vs Mexico, Mbappé anytime scorer, and over 3.0 Asian total goals
17. England -0.75 Asian handicap vs USA, under 2.75 Asian goals, and Bellingham shots on target over 1.5
18. Brazil -2 3-way handicap vs a group minnow, Vinicius first goalscorer, and Brazil to win to nil
19. Argentina +1 3-way handicap in a knockout tie, Messi to assist, and the match to go to extra time
20. France to score the first goal, an own goal, a penalty awarded, and Mbappé to score from the spot vs Germany
21. first goal before the 15th minute in Brazil's opener, no own goal, VAR overturn, and Vinicius to score the opener
22. France to win to nil vs Mexico, win by exactly 2 goals, Mbappé brace, and a clean sheet for France
23. WC 26 match with Mbappé shots on target over 2.5 and team to score first
24. games with Bellingham starting, his passes completed over 40, plus anytime scorer
25. matches with Modrić in the lineup (self-correction from "Haaland-less Norway") and his assist markets above 4.0
26. every Yamal appearance in WC 26 with shot markets, dribbles completed over 3.5, and his team match result
27. fixtures where Bruno Fernandes is captain with his free kick specials and shots on target over 1.5
28. WC 26 knockout fixtures with goalscorer markets for forwards under 25 and first-half goals over 0.5
29. group-stage matches involving CONMEBOL teams with corner markets above 10.5 and red card specials
30. upcoming WC 26 games in the next 48 hours with player shot markets and BTTS odds over 1.90
31. every Spain fixture with passing-related player props and possession over 60% markets
32. late kick-offs at WC 26 with over 3.5 goals markets, anytime scorer for strikers, and clean sheet odds under 3.0
33. Build me Brazil to win, Vinicius to score, and over 2.5 goals in their opener
34. Back France to win the World Cup outright
35. Argentina to win to nil with Messi anytime scorer in their R16
36. Stack France winning HT/FT with Mbappé scoring twice
37. Give me Argentina -1.5 Asian handicap for their group opener
38. Pull up France draw-no-bet odds against the highest-ranked side in their group
39. Show me alternative handicaps where Brazil are priced under 2.0 to cover -2
40. Do we have European handicap markets for the England Round of 16 tie
41. Find me Spain -0.5 spreads across all their group stage games
42. Show me correct score markets for Germany vs Mexico with 2-1 priced under 8.0
43. Pull up method of victory for the final — penalties vs extra time vs 90 minutes
44. Give me scorecast specials with Mbappé as first scorer in a 2-0 France win
45. Do we have winning margin markets for Brazil's group games over 2 goals
46. I want exact half-time score odds for the Spain opener
47. Show me first-10-minute goal markets for Saudi Arabia vs USA
48. Pull up second-half BTTS odds across every WC 26 group game today
49. Give me race-to-2-goals markets for France vs Germany in the knockouts
50. Do we have first-half corners over 4.5 for the Argentina game
51. Find me 15-minute interval scorer markets in the Portugal vs Brazil quarter
52. Show me Mbappé vs Vinicius head-to-head for tournament top scorer
53. Pull up Bellingham vs Pedri matchup odds for most assists in the group stage
54. Give me a same-game player duel — Saka vs Foden, most shots on target
55. Do we have a goalkeeper saves matchup between Donnarumma and Courtois
56. Find me defender matchup markets — Saliba vs Van Dijk, most clearances across the groups
57. Show me today's WC 26 acca builder with every favourite priced under 1.50
58. Pull up a 4-fold across Saturday's group matches with BTTS yes on each leg
59. Give me an over 2.5 goals acca for every CONMEBOL nation's opening fixture
60. Do we have a draw acca builder across the Round of 16 weekend
61. Find me a clean sheet acca for the top three FIFA-ranked sides across the group stage
62. Show me today's featured boost on Mbappé to score 2+ against any African nation
63. Pull up the daily price boost for the WC 26 marquee fixture
64. Give me request-a-bet options for the England game — Bellingham brace plus Kane assist
65. Do we have any specials boosted on the host nation's opening match
66. Find me the enhanced odds section for WC 26 final week

_Last probed: 2026-06-06 (re-probe on the **adopted decision-24 `main`-sentinel** build; Q37–Q66) — extractor `claude-haiku-4-5`, grounding `voyage-3`. **28/30 now carry a real market selector** (was ~13 dropped under the `fixture_lookup` WIP). Only **Q40** (European handicap) still wrongly → `main`; **Q65** correctly → `main`. 0 regressions vs the already-resolved set; ship gate PASS. **Q48 + Q46 since fixed** (Q48: grounding-layer acronym expansion `BTTS`/`GG`/`DNB`; Q46: `half time score` alias → Correct Score - 1st Half). Remaining grounding-axis misses: Q43/Q49/Q51._
_Earlier (2026-06-06): decision-23 result-family aliases; Q33–Q36 — grounding `voyage-3` + `level`-aware aliases + soft boType gate._

---

## Query Log

### Q1 — outright winner odds for World Cup 2026 across all 48 teams
- **Query:** outright winner odds for World Cup 2026 across all 48 teams.
- **Extractor:** One bet — the tournament outright winner, competition "World Cup 2026". "all 48 teams" correctly ignored (it's the whole field, not a filter).
- **Grounding:** "outright winner" → **Winner**.
- **Status:** ✅ Correct.

### Q2 — back France to win the tournament and reach the final
- **Query:** back France to win the tournament and reach the final as well.
- **Extractor:** Two bets, both for France — "to win the tournament" and "to reach the final".
- **Grounding:** "to win the tournament" → **To Win The Trophy**; "to reach the final" → **To reach the Final**.
- **Status:** ✅ Correct.

### Q3 — top goalscorer outright (top five favourites)
- **Query:** top goalscorer outright markets for WC 26, including the top five favourites?
- **Extractor:** One bet — top goalscorer. "top five favourites" correctly dropped (a presentation aside, not a price).
- **Grounding:** "top goalscorer" → clarify-list **{Top Goal Scorer, Nationality of Top Goalscorer, Goal Scorer, Winner and Top Goalscorer}**.
- **Status:** ✅ Correct — the right market (Top Goal Scorer) leads an ambiguous list the executor clarifies. Cluster is slightly noisy but not wrong.

### Q4 — Golden Ball
- **Query:** Golden Ball (Player of the Tournament) outright odds for the World Cup.
- **Extractor:** One bet — the Golden Ball award; "(Player of the Tournament)" folded in.
- **Grounding:** "Golden Ball" → **Golden Ball Winner**.
- **Status:** ✅ Correct.

### Q5 — England group winner + stage of elimination
- **Query:** which group England will win, plus their stage of elimination market?
- **Extractor:** Two bets for England — "group winner" and "stage of elimination".
- **Grounding:** "group winner" → **Group Winner**; "stage of elimination" → **nothing**.
- **Status:** ✅ Correct — Group Winner is right; "stage of elimination" correctly abstains (no such single market).

### Q6 — Brazil & Argentina to reach the final
- **Query:** Pull up the "to reach the final" outrights for both Brazil and Argentina.
- **Extractor:** Two bets — Brazil and Argentina, both "to reach the final".
- **Grounding:** both → **To reach the Final**.
- **Status:** ✅ Correct.

### Q7 — top European / South American nation
- **Query:** top European nation and top South American nation outright markets for WC 26.
- **Extractor:** Two bets — "top European nation" and "top South American nation", each kept whole (not split into winner + region filter).
- **Grounding:** → **Best European Team**; → **Best South American Team**.
- **Status:** ✅ Correct.

### Q8 — group winner, Group A through L
- **Query:** outright winner of Group A through Group L for the World Cup 2026.
- **Extractor:** 12 bets, one per group A–L — concept "group winner" with the group letter as the pick.
- **Grounding:** all 12 → **Group Winner**.
- **Status:** ✅ Correct.

### Q9 — Young Player + Golden Glove
- **Query:** Young Player of the Tournament outright and the Golden Glove (best goalkeeper) market?
- **Extractor:** Two bets — Young Player of the Tournament, Golden Glove (best goalkeeper).
- **Grounding:** → **Young Player of the Tournament**; → **Golden Glove Winner**.
- **Status:** ✅ Correct.

### Q10 — Spain: group / semi-finals / tournament
- **Query:** Show me Spain's outrights: to win the group, to reach the semi-finals, and to win the tournament.
- **Extractor:** Three bets for Spain.
- **Grounding:** "to win the group" → clarify-pair **{To win Group, Group Winner}**; "to reach the semi-finals" → **To reach the Semi Final**; "to win the tournament" → **To Win The Trophy**.
- **Status:** ✅ Correct — group is a clarify-pair (both right), the other two confident-correct.

### Q11 — name the finalists + winning confederation
- **Query:** Can I get the "name the finalists" outright and the "winning confederation" market for WC 26?
- **Extractor:** Two bets — "name the finalists" and "winning confederation".
- **Grounding:** "name the finalists" → **nothing**; "winning confederation" → **Winning Confederation**.
- **Status:** ⚠️ Mostly correct — Winning Confederation right. "name the finalists" abstains; the closest market ("Teams to reach the Final") is a genuinely different bet, so abstaining is defensible.

### Q12 — dark horse / top scorer by nation / debutant
- **Query:** dark horse outrights, top scorer by nation, and the highest-placed debutant team market
- **Extractor:** Three bets — "dark horse", "top scorer by nation", "highest-placed debutant team".
- **Grounding:** "dark horse" → nothing; "top scorer by nation" → **Nationality of Top Goalscorer**; "debutant" → nothing.
- **Status:** ✅ Correct — top-scorer-by-nation right; "dark horse" and "debutant" correctly abstain (no such markets exist).

### Q13 — to win the World Cup from the group stage
- **Query:** I want the "to win the World Cup from the group stage" outright for the four hosts plus the top seeds
- **Extractor:** One bet — "to win the World Cup from the group stage"; the descriptors "the four hosts"/"the top seeds" kept as team text (resolved later).
- **Grounding:** → **To win Group**.
- **Status:** ❌ Incorrect — the bet means winning the whole World Cup, but the words "from the group stage" pulled the match to the group-winner market. Needs head-weighted reranking (deferred).

### Q14 — stage of elimination (Portugal, Germany, Netherlands)
- **Query:** Pull up the stage of elimination outrights for Portugal, Germany, and the Netherlands.
- **Extractor:** Three bets, one per team, all "stage of elimination" (kept literal — not reworded into a different market).
- **Grounding:** all three → **nothing**.
- **Status:** ✅ Correct — abstains consistently (no such single market); matches Q5's behaviour.

### Q15 — most goals + best defensive record
- **Query:** team to score the most goals and the team with the best defensive record at WC 26?
- **Extractor:** Two bets — "team to score the most goals", "team with the best defensive record".
- **Grounding:** → **Team to Score Most Goals**; → **Team to Concede Least Goals**.
- **Status:** ✅ Correct.

### Q16 — France AH -1.5, Mbappé anytime scorer, Asian total over 3.0
- **Query:** Show me France -1.5 Asian handicap vs Mexico, Mbappé anytime scorer, and over 3.0 Asian total goals.
- **Extractor:** Three bets — France Asian handicap -1.5; Mbappé anytime scorer; over 3.0 Asian total goals.
- **Grounding:** → **Asian Handicap**; "anytime scorer" → **To Score**; "Asian total goals" → **Asian Total**.
- **Status:** ✅ Correct.

### Q17 — England AH -0.75, Asian goals under 2.75, Bellingham SOT over 1.5
- **Query:** Can I get England -0.75 Asian handicap vs USA, under 2.75 Asian goals, and Bellingham shots on target over 1.5?
- **Extractor:** Three bets — England Asian handicap -0.75; under 2.75 Asian goals; Bellingham shots on target over 1.5.
- **Grounding:** → **Asian Handicap**; "Asian goals" → **Asian Total**; "shots on target" → **Player Shots on Target**.
- **Status:** ✅ Correct.

### Q18 — Brazil 3-way -2, Vinicius first scorer, Brazil win to nil
- **Query:** Give me Brazil -2 on the 3-way handicap vs a group minnow, Vinicius first goalscorer, and Brazil to win to nil.
- **Extractor:** Three bets — Brazil 3-way handicap -2; Vinicius first goalscorer; Brazil to win to nil. "a group minnow" correctly dropped (vague opponent).
- **Grounding:** → **3-Way Handicap**; → **First Goal Scorer**; "to win to nil" → **Home/Away Team to Win to Nil** (per-side pair).
- **Status:** ✅ Correct.

### Q19 — Argentina 3-way +1 (knockout), Messi assist, extra time
- **Query:** Do you have Argentina +1 3-way handicap in a knockout tie, Messi to assist, and the match to go to extra time?
- **Extractor:** Three bets; the "knockout" stage is captured.
- **Grounding:** → **3-Way Handicap**; → **To Assist**; "to go to extra time" → **Extra Time**.
- **Status:** ✅ Correct.

### Q20 — France first goal, own goal, penalty awarded, Mbappé from the spot
- **Query:** Give me France to score the first goal, an own goal in the match, a penalty awarded, and Mbappé to score from the spot vs Germany.
- **Extractor:** Four bets, each split out cleanly.
- **Grounding:** → **To score first goal**; → **Own goal**; "penalty awarded" → **Penalty Kick awarded**; "to score from the spot" → **To score from a penalty**.
- **Status:** ✅ Correct.

### Q21 — first goal before 15 min, no own goal, VAR overturn, Vinicius opener
- **Query:** I want first goal before the 15th minute in Brazil's opener, no own goal, VAR overturn to occur, and Vinicius to score the opener.
- **Extractor:** Four bets; the opener is captured as Brazil's first match.
- **Grounding:** "first goal before the 15th minute" → **Goal scored in the First Minute of the Tournament**; "no own goal" → **Own goal** (No side); "VAR overturn" → nothing; "score the opener" → **First Goal Scorer**.
- **Status:** ❌ Partly incorrect — "no own goal", "score the opener" right, and "VAR overturn" correctly abstains. But "first goal before the 15th minute" grounds to the **wrong** market (the tournament's first minute, not the match's first 15 minutes). The right market ("score within the first 14:59 minute") was cut by the 0.55 threshold. Needs rerank/threshold (deferred).

### Q22 — France win to nil, exact 2-goal margin, Mbappé brace, clean sheet
- **Query:** Show me France to win to nil vs Mexico, win by exactly 2 goals, Mbappé brace, and a clean sheet for France at WC 26.
- **Extractor:** Four bets, each split out cleanly.
- **Grounding:** "to win to nil" → **Home/Away Team to Win to Nil** (per-side pair); "win by exactly 2 goals" → **Exact Winning Margin**; "brace" → **To Score At Least 2 Goals**; "clean sheet" → **To keep a clean sheet**.
- **Status:** ✅ Correct.

### Q23 — Mbappé shots on target over 2.5, team to score first
- **Query:** Find any WC 26 match featuring Mbappé with his shots on target markets over 2.5 and team to score first odds.
- **Extractor:** Two bets — comp "World Cup 2026", players=[Mbappé]. Mbappé shots on target (numeric over 2.5); either_match_team "to score first" (binary yes).
- **Grounding:** "shots on target" → **Player Shots on Target** (name/confident). "to score first" → **shortlist** [Team to score first | To Score his first goal against | Team to score first goal in season] (vector, score 0.367).
- **Status:** ⚠️ Improved (2026-06-05) — selector 1 right. Selector 2's shortlist is now **led by Team to score first** (`1001828740`) — the exact `[head]` match the soft boType gate now surfaces instead of hard-dropping — with the score-first family pulled in by the BM25 recall channel, no longer junk. Still a `shortlist` (not confident): "to score first" is a genuine collision of near-identical score-first markets, so clarify is correct. (Was: junk shortlist; the canonical `1001271977` sat below the top-8 cosine cut.)

### Q24 — Bellingham passes completed over 40, anytime scorer
- **Query:** Show all games with Bellingham starting and his passes completed over 40 plus anytime scorer markets.
- **Extractor:** Two bets — players=[Bellingham], comp null. "starting" correctly a lineup condition, not a market. Bellingham passes completed (numeric over 40); "anytime scorer" (subject=event).
- **Grounding:** "passes completed" → **Player's passes completed** (`1001159617`, name/confident — exact-name path, so the numeric-line→boType gate is bypassed). "anytime scorer" → **To Score** (alias/variants).
- **Status:** ✅ Correct (markets). Minor: "anytime scorer" got subject=event, not Bellingham — the antecedent ("his … plus anytime scorer") arguably scopes it to Bellingham; grounding is right either way.

### Q25 — self-correction to Modrić, assist markets above 4.0
- **Query:** Pull up matches with Haaland-less Norway out — sorry, with Modrić in the lineup and his assist markets above 4.0.
- **Extractor:** One bet — the self-correction is handled: players=[Modrić] only, no Haaland, no Norway, comp null. "above 4.0" read as a price filter (odds min 4), not a line.
- **Grounding:** "assists" → **Player Assists (Settled by Opta Data)** (name/confident).
- **Status:** ✅ Correct — the headline (mid-sentence retraction) resolves cleanly.

### Q26 — Yamal shots, dribbles completed over 3.5, his team match result
- **Query:** Give me every Yamal appearance in WC 26 with shot markets, dribbles completed over 3.5, and his team match result odds.
- **Extractor:** Three bets — comp "World Cup 2026", players=[Yamal]; "his team" inferred to team=Spain. Yamal shots (no line); Yamal dribbles completed (numeric over 3.5); Spain match result (no line).
- **Grounding:** "shots" → **Player's shots** (name/confident). "dribbles completed" → **shortlist** led by **Player's successful dribbles** (`1007694778`) (vector, score 0.404). "match result" → **shortlist** led by **Match Odds** (vector, score 0.397).
- **Status:** ⚠️ Improved (2026-06-05). Selector 1 right; nice "his team"→Spain inference. Selector 2 now **surfaces the true market**: the soft boType gate (KE-5) demotes rather than drops the `[head]`-tagged **Player's successful dribbles** (`1007694778`), so it leads the shortlist (was: fell to a passes-completed Opta false friend). Selector 3 **Match Odds** still leads its shortlist (sub-threshold — a semantic, not lexical, near-miss). Both stay `shortlist` (clarify), which is correct: the over/under line can't be priced on a `head` market, so we surface rather than over-claim.

### Q27 — Bruno Fernandes free kick specials, shots on target over 1.5
- **Query:** List fixtures where Bruno Fernandes is captain with his free kick specials and shots on target over 1.5.
- **Extractor:** Two bets — players=[Bruno Fernandes], comp null. "is captain" correctly a lineup condition. "free kick specials" (no line); shots on target (numeric over 1.5).
- **Grounding:** "free kick specials" → **shortlist** [To take a direct free kick | To score from a direct free kick | Number of player goals scored from a direct free-kick in the Tournament/League] (vector, score 0.478). "shots on target" → **Player Shots on Target** (name/confident).
- **Status:** ✅ Correct — selector 2 clean; selector 1's shortlist is the right behaviour for a deliberately vague "specials" (a family of direct-free-kick player markets to clarify against), not a miss.

### Q28 — WC 26 knockout: goalscorer for forwards under 25, first-half goals over 0.5
- **Query:** I want WC 26 knockout fixtures with goalscorer markets for forwards under 25 and first half goals over 0.5.
- **Extractor:** *(re-probed 2026-06-05, post-decision-21.)* Two bets — comp "World Cup 2026", level fixture, stage `{round: "knockout"}`. Sel1 "goalscorer" → `subject: player` (no name) + `attrFilter {position: forward, ageMax: 24}` ("under 25" → ageMax 24, inclusive ✓) — **flipped from `event` to nameless `player`** by the per-player-line rule. Sel2 "first half goals" → `subject: event` (one match outcome), numeric over 0.5.
- **Grounding:** "goalscorer" → **Goal Scorer** (`1001582442`, vector/confident 0.753; candidate list now all scorer markets, no team noise). "first half goals" over 0.5 → **Total Goals - 1st Half** (`1001159532`, vector/confident 0.607).
- **Status:** ✅ Correct. Post-decision-21 the per-player "goalscorer" is a **nameless `player`** (kept in the player bucket); grounding held confident through the flip.

### Q29 — group-stage CONMEBOL: corners above 10.5, red card specials
- **Query:** Can you show me group stage matches involving CONMEBOL teams with corner markets above 10.5 and red card specials.
- **Extractor:** Two bets — comp **null** (no tournament named), level fixture, stage `{round: "group stage"}`. "CONMEBOL teams" captured as `attrFilter {region: "CONMEBOL"}` on both selectors. Sel1 `subject: either_match_team`, "corners" numeric over 10.5. Sel2 `subject: event`, "red card specials" (no line).
- **Grounding:** "corners" over 10.5 → **Number of corners in the Tournament/League** (`1002023771`, vector/confident 0.492) — ⚠️ **wrong target**: should be per-match **Total Corners** (`1147` in criterions; exists), but it never enters the top-5 raw cosine; bare "corners" embeds nearest First Corner (0.510) / Most Corners (0.509) / the tournament aggregate (0.482), and the numeric line gates out the first two, leaving the aggregate. "red card specials" → **shortlist** [To Get a Red Card | Red Cards Handicap | Most Red Cards] (vector/shortlist 0.483) ✅.
- **Status:** ⚠️ Partial. Sel2 shortlist correct (right behaviour for vague "specials"). Sel1 mis-grounds (tournament-aggregate corners vs match Total Corners) → grounding-side KE candidate. Also debatable: comp=null, and `region` (an outcome filter per schema) repurposed to *scope fixtures* by confederation; `either_match_team` used with teams=[] (rule wants ≥2 named teams).

### Q30 — upcoming WC 26 (48h): player shot markets, BTTS over 1.90
- **Query:** Give me upcoming WC 26 games in the next 48 hours with player shot markets and BTTS odds over 1.90.
- **Extractor:** ✅ **Resolves** *(re-probed 2026-06-05, post-decision-21; was a crash).* comp "World Cup 2026", level fixture, `time.date_window {next 48 hours, now}`. Sel1 `subject: player` (no name) "shots" — the **nameless generic player** (`player.name` now optional). Sel2 `subject: either_match_team` "both teams to score" binary yes, `odds.min 1.9`.
- **Grounding:** "shots" → **Player's shots** (`2100015084`, name/confident — the player bucket gives the exact-name hit). "both teams to score" → **Both Teams To Score** (`1001642858`, name/confident).
- **Status:** ✅ Fixed (decision 21). Was the KE-6 crash (unnamed `player`); now a nameless `player` keeps the bucket → `Player's shots` confident (vs the noisier `event` route the old "fix direction" would have taken).

### Q31 — every Spain fixture: passing player props, possession over 60%
- **Query:** Pull together every Spain fixture with passing-related player props and possession over 60% markets.
- **Extractor:** ✅ **Resolves** *(re-probed 2026-06-05, post-decision-21; was a crash.)* teams=["Spain"], comp null, level fixture. Sel1 `subject: player` (no name) "passing" — Haiku emitted an empty `attrFilter: {}`, **dropped at the parse boundary** by `dropBlankSelectorLeaves`. Sel2 `subject: team` Spain "possession" numeric over 60.
- **Grounding:** "passing" → **Player's passes completed** (`1001159617`, **alias/confident** — head-stat alias now wired). "possession" over 60 → **shortlist** [Ball possession (%) Handicap | Most Ball possession | Total Ball possession by Away Team] (vector/shortlist 0.290).
- **Status:** ✅ Fixed (decision 21). Both KE-6 faults gone (nameless `player` valid; blank `{}`/`null` leaves dropped). "passing" now grounds **confident** to the head stat via the `passing → Player's passes completed` alias (`passing accuracy` / `pass completion` guarded → `Player's pass completion %`, closing the subset-alias over-fire). "possession" stays a niche-market shortlist (separate). No crash.

### Q32 — late kick-offs WC 26: goals over 3.5, anytime scorer for strikers, clean sheet under 3.0
- **Query:** Find me late kick-offs at WC 26 with over 3.5 goals markets, anytime scorer for strikers, and clean sheet odds under 3.0.
- **Extractor:** *(re-probed 2026-06-05, post-decision-21.)* Three bets — comp "World Cup 2026", level fixture, `time.kickoff_time_of_day "late kick-offs"` ✓. Sel1 `subject: event` "total goals" numeric over 3.5. Sel2 "anytime scorer" → `subject: player` (no name) + `attrFilter {position: striker}` binary yes — **flipped from `event` to nameless `player`** by the per-player-line rule. Sel3 `subject: either_match_team` "clean sheet" binary yes, `odds.max 3`.
- **Grounding:** "total goals" over 3.5 → **Total Goals** (`1001159926`, name/confident). "anytime scorer" (striker) → **To Score** (`1001159886` + variant `1006478338`, alias/variants). "clean sheet" → **To keep a clean sheet** (`1003971484`, alias/confident).
- **Status:** ✅ Correct. "late kick-offs" → kickoff band; post-decision-21 "anytime scorer" is a nameless `player` with "strikers" as its `attrFilter`; still grounds `To Score`. All three clean.

### Q33 — Brazil to win, Vinicius to score, over 2.5 goals in their opener
- **Query:** Build me Brazil to win, Vinicius to score, and over 2.5 goals in their opener.
- **Extractor:** *(probed 2026-06-06, post-decision-23.)* Three bets — level fixture, teams [Brazil], stage `{ordinal: first}` ("opener"). Sel1 `subject: team:Brazil` "to win" binary yes. Sel2 `subject: player:Vinicius` "to score" binary yes. Sel3 `subject: event` "total goals" numeric over 2.5.
- **Grounding:** "to win" (team, **level=fixture**) → **Match Odds** (`1004712874`, alias/confident) — the decision-23 `level`-aware alias. "to score" → To Score (`1001159886` + `1006478338`, name/variants). "total goals" over 2.5 → Total Goals (`1001159926`, name/confident).
- **Status:** ✅ Correct (post-decision-23). "to win" at fixture level now aliases to **Match Odds** — was a shortlist of `To win a Medal | To win Group | To Win The Trophy` (decision-23 blind spot). Executor picks Brazil's win outcome within Match Odds.

### Q34 — France to win the World Cup outright
- **Query:** Back France to win the World Cup outright.
- **Extractor:** One bet — level competition, comp "World Cup", `subject: team:France` "to win the World Cup".
- **Grounding:** "to win the World Cup" (**level=competition**) → the `to win` alias is **gated off** (fixture-only) → vector path → **To qualify for the World Cup** (`1004315271`, vector/confident 0.570).
- **Status:** 🟡 Gating correct, outright grounding imperfect. The `level`-gate correctly keeps the *competition* "to win" off the Match-Odds alias (decision 23 targets only the *fixture* result family). The outright itself still mis-grounds ("to qualify" vs `Winner`/`To Win The Trophy`) — a separate, pre-existing outright-grounding weakness, unchanged here.

### Q35 — Argentina to win to nil, Messi anytime scorer, R16
- **Query:** Argentina to win to nil with Messi as anytime scorer in their R16.
- **Extractor:** Two bets — level fixture, teams [Argentina], players [Messi], stage `{round: round of 16}`. Sel1 `subject: team:Argentina` "to win to nil" binary yes. Sel2 `subject: player:Messi` "anytime scorer" binary yes.
- **Grounding:** "to win to nil" (team, fixture) → **Home/Away Team to Win to Nil** (`1001642867`/`1001642866` + combo, vector/shortlist 0.382) via the per-side divert — the decision-23 `to win` alias correctly did **not** steal it (level-aliases are exact-only, skipped by the subset fallback). "anytime scorer" → To Score (alias/variants).
- **Status:** ✅ Correct — confirms the **non-steal**: "to win to nil" reaches the Win-to-Nil divert, not Match Odds. Side stays shortlist (home/away unresolved without fixture context, as before).

### Q36 — France HT/FT, Mbappé scoring twice
- **Query:** Stack France winning HT/FT with Mbappé scoring twice.
- **Extractor:** Two bets — level fixture, teams [France]. Sel1 `subject: team:France` "HT/FT" selection "France/France". Sel2 `subject: player:Mbappé` "to score a brace".
- **Grounding:** "HT/FT" (fixture) → **Half Time/Full Time** (`1001159830`, alias/confident) — decision-23 `level`-aware alias. "to score a brace" → To Score At Least 2 Goals (`1001160026`, alias/confident).
- **Status:** ✅ Correct (post-decision-23). "HT/FT" now aliases to **Half Time/Full Time** — was **GROUND→none** (the abbreviation cosined 0.305, below the recall floor). Fixes the abbreviation miss for free.

### Q37 — Argentina -1.5 Asian handicap, group opener
- **Query:** Give me Argentina -1.5 Asian handicap for their group opener.
- **Extractor:** `resolved`. level fixture, teams [Argentina], stage {group stage, ordinal first}. One sel `team:Argentina` "Asian handicap" `selection "-1.5"`.
- **Grounding:** → **Asian Handicap** (`1002135397`,`1002275572`, name/variants).
- **Status:** ✅ Correct. `-1.5` rides as the selection string; right criterion (line value not differentiated at grounding, as designed).

### Q38 — France draw-no-bet vs highest-ranked side
- **Query:** Pull up France draw-no-bet odds against the highest-ranked side in their group.
- **Extractor:** `resolved`. level fixture, teams [France, "highest-ranked side in their group"]. One sel `team:France` "draw-no-bet" `binary yes`.
- **Grounding:** → **Draw No Bet** (`1001159666`, name/confident).
- **Status:** ✅ Correct — **recovered** (was a `fixture_lookup` drop pre-decision-24). The descriptive opponent is kept as a literal team string.

### Q39 — alternative handicaps Brazil under 2.0 to cover -2
- **Query:** Show me alternative handicaps where Brazil are priced under 2.0 to cover -2.
- **Extractor:** `resolved`. level fixture, teams [Brazil]. One sel `team:Brazil` "Asian handicap" `selection "-2"` `odds {max: 2}`.
- **Grounding:** → **Asian Handicap** (`1002135397`,`1002275572`, name/variants).
- **Status:** ✅ Correct (family) — `-2` + odds≤2 captured; "alternative" nuance folded into Asian Handicap.

### Q40 — European handicap, England R16 tie
- **Query:** Do we have European handicap markets for the England Round of 16 tie.
- **Extractor:** `resolved`. level fixture, teams [England], stage {round of 16}. One sel `event` **`main`** — the market dropped to the sentinel.
- **Grounding:** → none (`main`).
- **Status:** ❌ **The one residual drop** post-decision-24. "European handicap" (= **3-Way Handicap**, exists) buried under a list-verb + event-noun ("do we have … the … tie") still reads as marketless. Worst-case unfamiliar-term + fixture-flavour combo; everything else in the handicap/margin/BTTS families recovered.

### Q41 — Spain -0.5 spreads, group stage
- **Query:** Find me Spain -0.5 spreads across all their group stage games.
- **Extractor:** `resolved`. level fixture, teams [Spain], stage {group stage}. One sel `team:Spain` "Asian handicap" `selection "-0.5"`.
- **Grounding:** → **Asian Handicap** (`1002135397`,`1002275572`, name/variants).
- **Status:** ✅ Correct — "spreads"/`-0.5` → Asian Handicap (right family).

### Q42 — correct score Germany vs Mexico, 2-1 under 8.0
- **Query:** Show me correct score markets for Germany vs Mexico with 2-1 priced under 8.0.
- **Extractor:** `resolved`. level fixture, teams [Germany, Mexico]. One sel `event` "correct score" `selection "2-1"` `odds {max: 8}`.
- **Grounding:** → **Correct Score** (`1001159780`, name/confident).
- **Status:** ✅ Correct. Clean two-team fixture; scoreline + odds filter captured.

### Q43 — method of victory, the final
- **Query:** Pull up method of victory for the final — penalties vs extra time vs 90 minutes.
- **Extractor:** `resolved`. level fixture, no teams, stage {final}. One sel `event` "method of victory".
- **Grounding:** → **Method of First Goal** (`1004552272`, vector/confident 0.527).
- **Status:** ⚠️ Extractor **recovered** (was a `fixture_lookup` drop) but **mis-grounds**: "method of victory" (pens/ET/90) lands on *Method of First Goal*; the closer **Way of winning** (`1001159495`) was a candidate (0.474) but lost. Grounding axis, not an extractor drop.

### Q44 — scorecast Mbappé first scorer in 2-0 France win
- **Query:** Give me scorecast specials with Mbappé as first scorer in a 2-0 France win.
- **Extractor:** `resolved`. level fixture, teams [France]. Two sels: (1) `player:Mbappé` "first goalscorer"; (2) `team:France` "correct score" `selection "2-0"`.
- **Grounding:** (1) → **First Goal Scorer** (`1005153918`, vector/confident 0.737). (2) → **Correct Score** (`1001159780`, name/confident).
- **Status:** ✅ **Improved** — now decomposes the scorecast into scorer × correct-score, both confident. (Pre-decision-24 leg 2 was a vague generic-scorecast cluster at 0.405.)

### Q45 — winning margin, Brazil group games over 2
- **Query:** Do we have winning margin markets for Brazil's group games over 2 goals.
- **Extractor:** `resolved`. level fixture, teams [Brazil], stage {group stage}. One sel `team:Brazil` "winning margin" `numeric over 2`.
- **Grounding:** → **Exact Winning Margin** (`1001475014`, vector/confident 0.573).
- **Status:** ✅ Correct — **recovered** (was a `fixture_lookup` drop).

### Q46 — exact half-time score, Spain opener
- **Query:** I want exact half-time score odds for the Spain opener.
- **Extractor:** `resolved`. level fixture, teams [Spain], stage {ordinal first}. One sel `event` "half-time exact score".
- **Grounding:** → **Correct Score - 1st Half** (`1000505272`, alias/confident).
- **Status:** ✅ Correct (**fixed** — alias). The "half-time" phrasing lexically collides with the **Half Time** (1X2 *result*) market, which won the rerank on full lexical-cover + no specificity penalty — demoting the right market *despite its higher raw cosine* (so a pure-vector tweak was unreliable; `Correct Score - 2nd Half` even out-cosined `1st Half`). Fix: a deterministic alias `half time score` → **Correct Score - 1st Half** (unscoped, so subset-matching also covers "exact half-time score"). Guards verified: "half time result" / bare "half time" → Half Time, "to score in the first half" → scorer — none contain all of `{half, time, score}`. (The explicit "first half correct score" already grounded confidently at 0.738.)

### Q47 — first-10-minute goal, Saudi Arabia vs USA
- **Query:** Show me first-10-minute goal markets for Saudi Arabia vs USA.
- **Extractor:** `resolved`. level fixture, teams [Saudi Arabia, USA]. One sel `either_match_team` "goal in first 10 minutes".
- **Grounding:** → **Total Goal Minutes by Home/Away Team** (`1001652795`,`1001652796`, vector/variants).
- **Status:** ⚠️ Extractor **recovered** (was a `fixture_lookup` drop); grounding **approximate** — "Total Goal Minutes" is *when* goals fall, not a first-10-min market (the catalog has no exact one). Surfaced for the executor rather than dropped.

### Q48 — second-half BTTS, every WC26 group game today
- **Query:** Pull up second-half BTTS odds across every WC 26 group game today.
- **Extractor:** `resolved`. comp World Cup 2026, level fixture, stage {group stage}, time {today}. One sel `event` "second-half BTTS".
- **Grounding:** → **Both Teams To Score - 2nd Half** (`1001642868`, vector/confident 0.616).
- **Status:** ✅ Correct (**fixed** — grounding-layer acronym expansion). A whole-word `abbreviations` map in `aliases.json` (`btts`/`gg`→`both teams to score`, `dnb`→`draw no bet`) expands the opaque acronym *before* matching, so it reaches the right family and the period facet picks the 2nd-half variant. Abbreviated and expanded phrasings now ground **identically** (both 0.616) — the run-to-run sensitivity is gone. Same change also fixed **bare `BTTS`** (previously grounded to **none**) and **`second-half DNB`** (previously the wrong *base* Draw No Bet).

### Q49 — race-to-2-goals, France vs Germany knockouts
- **Query:** Give me race-to-2-goals markets for France vs Germany in the knockouts.
- **Extractor:** `resolved`. level fixture, teams [France, Germany], stage {knockout}. One sel `either_match_team` "race to 2 goals".
- **Grounding:** → **Total Goals / Exact Total Goals / Number of team goals** (`1001159926`,…, vector/shortlist 0.405).
- **Status:** ❌ Mis-grounded (false friend). No "race to X goals" criterion exists → should abstain, but lands on **Total Goals**. Grounding axis. Candidate KE.

### Q50 — first-half corners over 4.5, Argentina
- **Query:** Do we have first-half corners over 4.5 for the Argentina game.
- **Extractor:** `resolved`. level fixture, teams [Argentina]. One sel `event` "first-half corners" `numeric over 4.5`.
- **Grounding:** → **Total Corners - 1st Half** (`1001159820`, vector/confident 0.513).
- **Status:** ✅ Correct — **recovered** (was a `fixture_lookup` drop).

### Q51 — 15-minute interval scorer, Portugal vs Brazil QF
- **Query:** Find me 15-minute interval scorer markets in the Portugal vs Brazil quarter.
- **Extractor:** `resolved`. level fixture, teams [Portugal, Brazil], stage {quarterfinal}. One sel **nameless** `player` "15-minute interval scorer".
- **Grounding:** → **Goal Scorer / To Score / To Score** (`1001582442`,…, vector/shortlist 0.350).
- **Status:** ❌ Mis-grounded. Interval markets exist (**Goal Interval**, **Total Goals Interval**, **Player Intervals**) but it lands on plain anytime-scorer, dropping the interval dimension. Grounding axis. Candidate KE.

### Q52 — Mbappé vs Vinicius H2H, tournament top scorer
- **Query:** Show me Mbappé vs Vinicius head-to-head for tournament top scorer.
- **Extractor:** `resolved`. level competition, players [Mbappé, Vinicius]. One sel `event` "tournament top scorer".
- **Grounding:** → **Top Goal Scorer / Goal Scorer** (`1001284857`,`1001582442`, vector/ambiguous 0.630).
- **Status:** ✅ **Recovered** — both player names now retained (pre-decision-24 it dropped both names *and* the market). Top scorer is a tournament outright, so a single `event` selector is reasonable; no player-vs-player H2H market exists, so the duel framing collapses to the shared outright (executor clarifies).

### Q53 — Bellingham vs Pedri, most assists, group stage
- **Query:** Pull up Bellingham vs Pedri matchup odds for most assists in the group stage.
- **Extractor:** `resolved`. level competition, stage {group stage}. Two sels: `player:Bellingham` / `player:Pedri` "most assists".
- **Grounding:** both → **To give most assists (Opta)** (`1003002064`, vector/confident 0.556).
- **Status:** ✅ **Recovered** + grounds confidently (was a `fixture_lookup` drop). Clean per-player decomposition.

### Q54 — Saka vs Foden, most shots on target
- **Query:** Give me a same-game player duel — Saka vs Foden, most shots on target.
- **Extractor:** `resolved`. level fixture, players [Saka, Foden]. Two sels: `player:Saka` / `player:Foden` "most shots on target".
- **Grounding:** both → **Most Shots on Target (Opta)** (`1002035664`, name/confident).
- **Status:** ✅ **Recovered** + confident (was a `fixture_lookup` drop).

### Q55 — goalkeeper saves matchup, Donnarumma vs Courtois
- **Query:** Do we have a goalkeeper saves matchup between Donnarumma and Courtois.
- **Extractor:** `resolved`. level fixture, players [Donnarumma, Courtois]. Two sels: `player:Donnarumma` / `player:Courtois` "saves".
- **Grounding:** both → **Player Saves (Opta)** (`2100039302`, name/confident).
- **Status:** ✅ **Recovered** + confident (was a `fixture_lookup` drop). Per-player decomposition.

### Q56 — Saliba vs Van Dijk, most clearances, groups
- **Query:** Find me defender matchup markets — Saliba vs Van Dijk, most clearances across the groups.
- **Extractor:** `resolved`. level competition, players [Saliba, Van Dijk], stage {group stage}. **Three** sels: `player:Saliba` "clearances", `player:Van Dijk` "clearances", and a nameless `player` "most clearances" `attr {position: defender}`.
- **Grounding:** the two "clearances" → **none** (correct — no player clearances market; only *Team with most clearance completed*). The "most clearances" → **To cover most distance** (vector/shortlist 0.305, wrong).
- **Status:** ⚠️ Clearances correctly abstain, but the extra nameless "most clearances" selector is **noise** (weak false-friend grounding) — a minor tidiness regression vs the prior 2-selector state.

### Q57 — today's WC26 acca, every favourite under 1.50
- **Query:** Show me today's WC 26 acca builder with every favourite priced under 1.50.
- **Extractor:** `resolved`. comp World Cup 2026, level competition, time {today}. One sel `event` "acca builder" `odds {max: 1.5}`.
- **Grounding:** → **Enhanced Acca** (`1003584781`, vector/shortlist 0.399).
- **Status:** ⚠️ Now extracts (was `fixture_lookup`). "acca builder" → the real **Enhanced Acca** market (shortlist); favourite≤1.50 → odds.max. An acca is really a bet-builder surface, so the executor still assembles the legs.

### Q58 — 4-fold, Saturday group matches, BTTS each leg
- **Query:** Pull up a 4-fold across Saturday's group matches with BTTS yes on each leg.
- **Extractor:** `resolved`. level fixture, time {Saturday}. One sel `event` "both teams to score".
- **Grounding:** → **Both Teams To Score** (`1001642858`, name/confident).
- **Status:** ✅ Sensible — grounds the **BTTS leg** (the real market); the 4-fold/acca wrapper is the executor's to assemble. ("group matches" → stage not set.)

### Q59 — over 2.5 goals acca, CONMEBOL opening fixtures
- **Query:** Give me an over 2.5 goals acca for every CONMEBOL nation's opening fixture.
- **Extractor:** `resolved`. level fixture, stage {ordinal first}. One sel `event` "total goals" `numeric over 2.5` `attr {region: CONMEBOL}`.
- **Grounding:** → **Total Goals** (`1001159926`, name/confident).
- **Status:** ✅ **Improved** — over-2.5 grounds confidently and **CONMEBOL is captured as a region attrFilter** (pre-decision-24 the whole query dropped).

### Q60 — draw acca, Round of 16 weekend
- **Query:** Do we have a draw acca builder across the Round of 16 weekend.
- **Extractor:** `resolved`. level fixture, stage {round of 16}, time {date_window "weekend", anchor tournament}. One sel `event` "draw acca builder".
- **Grounding:** → **Enhanced Acca** (`1003584781`, vector/shortlist 0.350).
- **Status:** ⚠️ Now extracts (was `fixture_lookup`). "draw acca builder" → Enhanced Acca (shortlist); the *draw* leg isn't separately captured. Good R16 + tournament-anchored time parse.

### Q61 — clean sheet acca, top three FIFA-ranked sides, group stage
- **Query:** Find me a clean sheet acca for the top three FIFA-ranked sides across the group stage.
- **Extractor:** `resolved`. level competition, teams **["top three FIFA-ranked sides"]** (literal), stage {group stage}. One sel `either_match_team` "clean sheet".
- **Grounding:** → **To keep a clean sheet** (`1003971484`, alias/confident).
- **Status:** ✅ **Improved** — clean-sheet market grounds confidently (was `fixture_lookup`). "top three FIFA-ranked sides" still a literal team string (entity-parse quirk, cf Q65).

### Q62 — featured boost, Mbappé 2+ vs an African nation
- **Query:** Show me today's featured boost on Mbappé to score 2+ against any African nation.
- **Extractor:** `resolved`. level fixture, teams ["African nation"] (literal), players [Mbappé], time {today}. One sel `player:Mbappé` "to score 2+" `binary yes`.
- **Grounding:** → shortlist **To Score At Least 2 Goals / Any player to score at least 2 goals / …** (`1001160026`,…, vector/shortlist 0.423).
- **Status:** ✅ **Recovered** — Mbappé + the 2+ market are back (pre-decision-24 the boost wrapper dropped both). The right market (`1001160026`) leads the shortlist. "African nation" kept literal.

### Q63 — daily price boost, WC26 marquee fixture
- **Query:** Pull up the daily price boost for the WC 26 marquee fixture.
- **Extractor:** `resolved`. comp World Cup 2026, level fixture, time {daily}. One sel `event` "price boost".
- **Grounding:** → **Boosted Odds** (`1003584867`,…, vector/shortlist 0.349).
- **Status:** ⚠️ Now extracts (was `fixture_lookup`). "price boost" → the real **Boosted Odds** family (shortlist) — reasonable for a boost surface; the executor picks the live boost.

### Q64 — request-a-bet, England, Bellingham brace + Kane assist
- **Query:** Give me request-a-bet options for the England game — Bellingham brace plus Kane assist.
- **Extractor:** `resolved`. level fixture, teams [England]. Two sels: `player:Bellingham` "to score a brace" `binary yes`; `player:Kane` "to assist" `binary yes`.
- **Grounding:** "to score a brace" → **To Score At Least 2 Goals** (`1001160026`, alias/confident). "to assist" → **To Assist** (`2100034146`, name/confident).
- **Status:** ✅ Correct. RAB decomposed into its two legs, both confident.

### Q65 — specials boosted, host nation opener
- **Query:** Do we have any specials boosted on the host nation's opening match.
- **Extractor:** `resolved`. level fixture, teams ["host nation"] (literal), stage {ordinal first}. One sel `event` **`main`**.
- **Grounding:** → none (`main`).
- **Status:** ✅ Correctly marketless — "specials" is a surface, not a bettable market → the `main` sentinel (executor shows the opener's main betoffer). "host nation" kept literal.

### Q66 — enhanced odds section, WC26 final week
- **Query:** Find me the enhanced odds section for WC 26 final week.
- **Extractor:** `resolved`. comp World Cup 2026, level competition, stage {final}, time {date_window "final week", anchor tournament}. One sel `event` "enhanced odds".
- **Grounding:** → **Boosted Odds** (8 ids, vector/variants 0.528).
- **Status:** ✅ Now extracts (was `fixture_lookup`). "enhanced odds" → the **Boosted Odds** family (variants); good tournament-anchored time + stage parse.

---

## Known Errors / Known Issues

Standing list of confirmed extractor weaknesses. Parked by decision. Update an entry's status when
revisiting; add new ones as probes surface them.

### KE-1 — `numeric` line with null value/direction crashes extraction
- **Status:** OPEN (parked — log only). Logged 2026-06-01.
- **Severity:** crash (uncaught) — `extract()` throws, `npm run eval` exits 1.
- **Trigger:** an over/under phrasing with **no number stated**. Repro: `"Brazil first-half corners over/under, and most corners in the match."`
- **Symptom:** Haiku emits `line: { kind: "numeric", value: null, direction: null }`, which fails `QueryPlan` validation, so `extract()` throws instead of returning a plan.
- **Note:** the 2026-06-04 rule #6 clause ("omit any field rather than fill it with a guess or placeholder") fixed the same *class* for a stray odds placeholder (Q3), but KE-1's exact numeric-line repro hasn't been re-verified. Decide whether to harden the schema (coerce null numeric → drop line) and/or sharpen the numeric rule.

### KE-2 — bare "first card" specials omit the line
- **Status:** OPEN (parked — "stop tweaking"). Logged 2026-06-01.
- **Severity:** wrong shape (no crash) — line omitted where convention is `binary "yes"`.
- **Trigger:** bare first-event card markets, e.g. `"Pedri first card vs Germany"` (omitted 5/5).
- **Symptom:** `{ market_concept: "first card" }` with no line; should be `line: { kind: "binary", direction: "yes" }`. Revisit with KE-1.

### KE-3 — occurrence line dropped; negation baked into concept (context-sensitive)
- **Status:** PARTIALLY RESOLVED. Logged 2026-06-01; updated 2026-06-04.
- **Trigger #1 (OPEN):** "first goal before the 15th minute" (occurrence, no number) → **no line**; should be binary yes. Still reproduces (Q21) and contributes to its wrong grounding.
- **Trigger #2 (RESOLVED 2026-06-04):** "no own goal" used to become `market_concept "no own goal"` + binary **yes**. The new negation clause in rule #4 now yields `market_concept "own goal"` + direction **"no"**, which grounds to **Own goal** (No side) — verified in Q21.
- **Note:** trigger #1 is the same class as KE-2 (bare occurrence → omitted line); revisit together with KE-1's numeric rule.

### KE-4 — group-outright instance baked into concept — RESOLVED (2026-06-04)
- **Status:** RESOLVED. The field-outright + enumerated-instance rule now emits `market_concept "group winner"` + a `selection` line per group (Group A…L) instead of baking the letter into the concept. All 12 ground to **Group Winner** (Q8). (Was an open drift note from regression `7e7a815`.)

### KE-5 — numeric line gate drops a count-stat market that only carries a `head` boType — RESOLVED (2026-06-05)
- **Status:** RESOLVED (2026-06-05) — option (a), soft boType gate. Logged 2026-06-04 (Q26).
- **Severity:** wrong grounding (no crash) — lands on a same-family false friend instead of the true market.
- **Trigger:** a player count-stat whose only catalog market is tagged boType `head` (no over/under mapping in this snapshot), queried **with** a numeric over/under line. Repro: `"dribbles completed over 3.5"` → the only dribbles market **Player's successful dribbles** (`1007694778`, `[head]`) is removed by the line→boType HARD gate (needs overunder/asianoverunder/playeroccurrenceline), so the vector tail falls to **Player's Passes completed (Settled using Opta data)** (`playeroccurrenceline`).
- **Asymmetry:** the same class is invisible when the concept **exact-name matches** the catalog — `"passes completed over 40"` resolves to **Player's passes completed** (`1001159617`, also `[head]`) via the exact-name path, which never applies the gate (Q24). The bug only bites when the concept misses exact-name and reaches `vectorGround` (here: catalog name is "successful dribbles", not "dribbles completed").
- **Options (parked):** (a) soften the numeric gate from HARD-drop to a penalty for `head`-only count markets; (b) treat `head` as numeric-compatible for player count stats; (c) let exact-name near-matches reach the count market before the gate. Needs calibration — don't tweak blind.
- **Resolution (2026-06-05):** took **option (a)**, applied uniformly. The line→boType gate is now **SOFT** — a mismatch costs `GATE_PENALTY` (0.10) in `ground-market.ts` instead of hard-dropping. The right market is demoted, not deleted, so a much-stronger off-type match still wins through (dribbles cosine 0.506 beats its passes-completed rival by 0.13 > 0.10). `"dribbles completed over 3.5"` now surfaces **Player's successful dribbles** leading the shortlist; the same class is fixed for **Q23**'s `"to score first"` → **Team to score first** (`1001828740`, `[head]`). Lands `shortlist` not `confident` by design — the over/under line can't be priced on a `head` market, so clarify rather than over-claim. Measured: **0 regressions** on the 32-case grounding snapshot; ship-gate g002/g003 unchanged.

### KE-6 — generic/unnamed "player <market>" emitted as `subject:player` with no name (schema-invalid)
- **Status:** RESOLVED (decision 21, 2026-06-05) — implemented + verified: both Q30/Q31 crashes gone, Q28/Q32 per-player scorers flipped to nameless `player` and still ground, awards stay `event`, ship gate PASS (0 regressions on g001–g003). Logged 2026-06-05 (Q30, Q31).
- **Severity:** crash (uncaught) — `extract()` throws on `QueryPlan` validation; `player`/`team` subjects require `name: string().min(1)`.
- **Trigger:** a market owned by a *generic class* of player with **no specific name and no position qualifier** — `"player shot markets"` (Q30), `"passing-related player props"` (Q31).
- **Symptom:** `selectors[].subject = { kind: "player" }` (no `name`), which the schema rejects (`player.name` is `string().min(1)`). *(Decision 21 makes `name` optional, so this nameless form becomes valid and keeps the player bucket — see Resolution; the earlier "route to `event`" lean was reversed because `event` loses that bucket.)*
- **Contrast (why it's a rule gap, not random):** when a **position qualifier is present** the extractor does the right thing — `"forwards under 25"` (Q28) and `"strikers"` (Q32) both → `subject: event` + `attrFilter`. The miss is specifically the *bare* `"player <market>"` with no position to anchor the event+attrFilter path; the literal word "player" pulls it to `subject: player`, which then has no name to give.
- **Secondary (Q31):** optional selector fields emitted as explicit `null` (`line: null, odds: null, attrFilter: null`) instead of omitted — `.optional()` accepts *undefined*, not `null`. Same family as KE-1 / rule #6 ("omit any field rather than fill it with a guess or placeholder"); fails validation independently of the name issue.
- **Resolution (decision 21, 2026-06-05 — implemented + verified):** made `player.name` **optional** so a generic player market stays a **nameless `player` subject** (keeps the player bucket — *better* than routing to `event`, which the probe showed leaks team/per-player markets). The player-vs-event cut is rewritten around a **per-player-line test** (each player priced → `player`; one match/tournament outcome → `event` + attr), which root-causes the inconsistency and carves out awards without naming them — so the Contrast above is **unified**, not special-cased (per-match scorers flip from `event` to nameless `player`+attr, to be re-probed). The blank secondary is fixed by **dropping a `null` or empty `{}`** on `line`/`odds`/`attrFilter` at the parse boundary (`dropBlankSelectorLeaves` in `extract.ts`; Haiku emitted `attrFilter: {}` here), scoped so `stage`/`time`/`competition` are untouched. Topic phrasings ("passing props") ground to the **head stat**; family-expansion is deferred to the shared no-result **suggestions** engine. Full rationale + rejected alternatives: **decision 21** in `docs/architecture.md`.

### KE-7 — fixture match-result derivatives ground to tournament outrights — RESOLVED (2026-06-06)
- **Status:** RESOLVED (2026-06-06) — decision 23. Surfaced in a 30-query probe (batch 4).
- **Severity:** wrong grounding (no crash) — a fixture result bet lands on a tournament outright (confident-wrong or shortlist), or misses entirely.
- **Trigger:** the fixture match-result family at level fixture — "to win" (Q33), "match winner", "draw after 90", "HT/FT" (Q36), "win to nil" (Q35).
- **Symptom:** "to win" cosined to the ~80 tournament `To win …` outrights (`Winner` 0.513 top); the real fixture market **Match Odds** (`1004712874`) is lexically disjoint — not even top-6. "HT/FT" cosined 0.305, **below the recall floor → none**. Grounding was `level`-blind (`GroundOpts` had only `subjectKind`, `line`).
- **Resolution (decision 23):** carry `level` into `groundMarket` (`GroundOpts.level`, threaded from `event_scope.level`); add **`level`-aware `criterion_concept` aliases** — `to win`/`match result`/`1X2`/`match winner` → **Match Odds**, `HT/FT` → **Half Time/Full Time** (`1001159830`) — gated to `level: fixture` and **exact-only** (skipped by the subset fallback, so "to win" can't steal "to win to nil"). Verified: Q33 "to win" → Match Odds confident; Q36 "HT/FT" → Half Time/Full Time confident; Q35 "to win to nil" still reaches the per-side Win-to-Nil divert; Q34 competition "to win the World Cup" correctly **not** aliased. Scope (fixture vs tournament) is **not** a static catalog property (categories/boTypes/raw feed all fail) → enforcement deferred to the executor (re-ground within the offered betoffer menu). Full rationale: **decision 23** in `docs/architecture.md`.

### KE-8 — marketless / fixture-only query crashes or fabricates a market — RESOLVED (2026-06-06)
- **Status:** RESOLVED (2026-06-06) — decision 22. Surfaced in the same 30-query probe (batch 1 + live).
- **Severity:** crash + grounding noise. The `selectors.min(1)` invariant left no honest encoding for a query naming no market.
- **Trigger:** a query naming **no bettable market** — "the France opener", "Brazil vs Argentina group-stage match", "show me what's live now".
- **Symptom:** the extractor fabricated a `"match"` concept (→ grounding noise Fantasy Match / Match Odds), emitted `selectors: []` (→ schema crash), or bailed to `unsupported`.
- **Resolution (decision 22):** a 4th plan status **`fixture_lookup`** (`{sport, event_scope}`, no selectors), decided by an event-noun-vs-outcome rule (an event noun "match/fixture/game" or a list verb is not a market); grounding doesn't run; the executor shows each event under its main betoffer. Eval grades the fixture-selecting facets (teams/stage/time) HARD on these records. Verified via gold gf01–gf05 (ship gate PASS). Full rationale: **decision 22** in `docs/architecture.md`.
