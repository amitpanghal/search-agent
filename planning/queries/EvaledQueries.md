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

_Last probed: 2026-06-04 — extractor `claude-haiku-4-5`, grounding `voyage-3`._

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
