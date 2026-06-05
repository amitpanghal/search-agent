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

_Last probed: 2026-06-05 (grounding re-probe) — extractor `claude-haiku-4-5` (2026-06-04), grounding `voyage-3` + IDF/BM25 cover + soft boType gate._

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
