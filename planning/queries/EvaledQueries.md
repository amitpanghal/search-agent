# Evaled Queries

Running log of ad-hoc queries probed against the extractor (`npm run eval -- --query "..."`),
with the returned `QueryPlan`. Newest entries on top. This is a probing record, not a graded
eval — promising entries are candidates for gold records in `eval/gold.seed.jsonl`.

Each entry notes: date/time, model, the raw query, the returned plan, and any triage flags.

---

## Known Errors / Known Issues

Standing list of confirmed extractor weaknesses. Parked by decision, not yet fixed. Update an
entry's status when revisiting; add new ones as probes surface them.

### KE-1 — `numeric` line with null value/direction crashes extraction
- **Status:** OPEN (parked — log only, no prompt edit). Logged 2026-06-01.
- **Severity:** crash (uncaught) — `extract()` throws, `npm run eval` exits 1.
- **Trigger:** an over/under phrasing with **no number stated**. Repro query:
  `"Brazil first-half corners over/under, and most corners in the match."`
- **Symptom:** Haiku emits `line: { kind: "numeric", value: null, direction: null }`. This fails
  `QueryPlan` validation (numeric requires a number + `"over"|"under"`), so `extract.ts:80`
  throws instead of returning a plan.
- **Two distinct problems underneath:** (a) the model should not pick `numeric` when no threshold
  is given — "over/under" with no number is a request for all offered lines (omit) or a
  yes/no; (b) even if it does, a malformed line should degrade gracefully, not crash the run.
- **When revisited:** decide whether to harden the schema/extractor (coerce/relax null numeric →
  drop line or flag unsupported) and/or sharpen the `line` numeric rule. No fix applied yet.

### KE-2 — bare "first card" specials omit the line
- **Status:** OPEN (parked — "stop tweaking" decision). Logged 2026-06-01.
- **Severity:** wrong shape (no crash) — line omitted where convention is `binary "yes"`.
- **Trigger:** bare first-event card markets, e.g. `"Pedri first card vs Germany"`. Confirmed
  consistent (omitted 5/5 at the 14:30 prompt), not run-to-run noise.
- **Symptom:** `{ subject: …, market_concept: "first card" }` with **no line**; should be
  `line: { kind: "binary", direction: "yes" }` per the pinned occurrence/specials convention.
- **Note:** the 14:30 omit-scoping clause in the numeric bullet did not fix this and is suspected
  to have sloshed "card in the first 10 minutes" from binary → omitted (also 5/5). Left in place
  by decision. Revisit together with KE-1's numeric rule.

### KE-3 — occurrence line dropped + negation baked into concept (context-sensitive)
- **Status:** OPEN (parked — stop tweaking). Logged 2026-06-01.
- **Severity:** wrong shape (no crash).
- **Triggers** (same probe — "…first goal before the 15th minute…, no own goal, …, Vinicius to
  score the opener"):
  1. "first goal before 15 minutes" (occurrence, no number) → **no line**; should be binary yes
     (same class as KE-2 bare "first card").
  2. "no own goal" → market_concept "no own goal" + binary **yes**; canonical is market_concept
     "own goal" + direction **"no"** (negation belongs in `direction`). The identical phrase
     resolves correctly elsewhere (the WC-26-final probe) → the defect is **context-sensitive**,
     not phrase-specific.
- **Note:** reverting the tie-breaker (Edit C) did **not** fix it — so it is intrinsic temp-0
  context instability for bare occurrence/negation legs, not a clean rule regression. Revisit
  with KE-1's numeric rule.

---

## 2026-06-01 16:30 CEST — Q13 Step-1 fix verification + root-cause isolation

Model: `claude-haiku-4-5-20251001`. **The Step-1 sport-default edits did NOT fix Q13.** A
controlled A/B (change only the subject) proves the cause is the **subject**, not the sport.

**Fix verification (Step-1 edits in place, extractor-prompt.md:23-29):**
- Q13 re-probe → still `{ "status": "unsupported", "recognizedAs": "ambiguous query" }`. The
  *format* part of the fix landed (paragraph → short token), the sport-default override did not.
- No regression: gold **3/3 PASS**, **SHIP GATE PASS**; cricket "Kohli…" → `unsupported`,
  `recognizedAs: "cricket"` intact; g002 tennis abstain intact.

**Root-cause A/B — only the subject phrase changed:**
- `"…outright for the four hosts plus the top seeds."` → `unsupported` / `"ambiguous query"`.
- `"…outright for Mexico and Brazil."` → **resolved** cleanly:
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": ["Mexico","Brazil"], "players": [], "competition": "World Cup", "level": "competition", "stage": { "round": "group stage", "ordinal": null, "conditional": false }, "time": null },
  "selectors": [ { "subject": { "kind": "team", "name": "Mexico" }, "market_concept": "to win the World Cup" },
                 { "subject": { "kind": "team", "name": "Brazil" }, "market_concept": "to win the World Cup" } ] }
```
**Conclusion:** the trigger is an **ungroundable collective subject descriptor** ("the four hosts
plus the top seeds" — names no concrete team, implies enumeration the structural extractor can't
do). The identical market phrase + sport resolve perfectly with named teams, so the 16:10 "Flag 1"
diagnosis (sport-default miss) was **wrong** — this is a *subject* abstention. `recognizedAs:
"ambiguous query"` is also off-spec (unsupported is reserved for a **named unbuilt sport**).
Contrast Q3 earlier ("Brazil … vs a group minnow") resolved because a **named** team anchored the
scope; here the whole subject set is descriptive with no anchor.

**Step-1 sport-default edits reverted** (per decision — they didn't fix Q13; dead patch removed,
Step 1 back to last-committed text; Step-2 `level` and Step-3 line/odds/attrFilter refinements
kept). Real fix still open: tighten the **abstention boundary** (`unsupported` ⟺ a **named unbuilt
sport** only; vague/collective subjects resolve with the descriptor kept as text in `teams`) vs.
park as **KE-4**.

**RESOLVED — abstention-boundary bullet applied** (Step 1): *"Abstain only on a named unbuilt
sport … vague/collective subjects resolve, descriptor kept as text in `teams`; never emit
`recognizedAs` reason text."* Q13 now resolves:
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": ["the four hosts","the top seeds"], "players": [], "competition": "World Cup", "level": "competition", "stage": { "round": "group stage", "ordinal": null, "conditional": false }, "time": null },
  "selectors": [ { "subject": { "kind": "either_match_team" }, "market_concept": "to win the World Cup" } ] }
```
No regression: gold **3/3 PASS**, **SHIP GATE PASS**; cricket "Kohli…" still `unsupported` /
`recognizedAs: "cricket"` (short — the new clause covers the verbosity the Step-1 revert reopened).
One principled bullet fixed it, no per-query example added. **Gold-record candidate:**
ungroundable-collective-subject → resolve (descriptor kept as text), a new behavior axis.

## 2026-06-01 16:10 CEST — Outright / tournament-level probes (15 queries)

Model: `claude-haiku-4-5-20251001`. **14/15 resolved FOOTBALL; Q13 wrongly `unsupported`.**
All 14 resolved plans set `level: "competition"` correctly — the level-by-scope rule is holding
14/14 on outright/award/tournament markets.

**Flag 1 (headline) — Q13 wrongly returns `unsupported`, violating the sport-default rule.**
"...to win the World Cup from the group stage outright for the four hosts plus the top seeds."
came back `unsupported` with `recognizedAs` = a *reasoning paragraph* ("'World Cup' without
naming a sport is ambiguous between football/cricket/rugby…"). Two defects: (a) Step 1 says a
**sport-silent** query defaults to FOOTBALL — the other 14 "World Cup"/"WC 26" queries all
resolved fine, so this is inconsistent and wrong; (b) `recognizedAs` should be a short sport
name or null, never an explanation. Trigger looks like the complex "from the group stage / four
hosts / top seeds" phrasing tipping the model into over-reasoning the sport. **Critical-tag
(sport-default) miss.**

**Flag 2 — "to win the group" shape inconsistent.** Q5 "to win group" → **no line**; Q10 "to
win the group" → **binary yes**. Same yes/no proposition, two shapes (Q5 is the wrong one).

**Consistent & correct (worth noting):** `level: "competition"` on every resolved outright;
multi-team split into per-team selectors (Q6 Brazil/Argentina, Q14 Portugal/Germany/
Netherlands); **Group A→L expanded into 12 `selection` selectors** (Q8); `attrFilter.region`
"Europe"/"South America" (Q7); award outrights (Golden Ball, Golden Glove, Young Player, top
goalscorer) → event + no line; superlative team outright with **no named achiever** ("team to
score the most goals", Q15) → no line (correctly distinct from a named-achiever binary).

### Q1 "…outright winner odds for World Cup 2026 across all 48 teams."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": null, "time": null },
  "selectors": [ { "subject": { "kind": "event" }, "market_concept": "outright winner" } ] }
```

### Q2 "…back France to win the tournament and reach the final as well."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "to win the tournament", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "to reach the final", "line": { "kind": "binary", "direction": "yes" } } ] }
```
Note: "the tournament" named no competition → `competition: null` (defensible).

### Q3 "…top goalscorer outright markets for WC 26, including the top five favourites?"
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": null, "time": null },
  "selectors": [ { "subject": { "kind": "event" }, "market_concept": "top goalscorer" } ] }
```

### Q4 "…Golden Ball (Player of the Tournament) outright odds for the World Cup."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup", "level": "competition", "stage": null, "time": null },
  "selectors": [ { "subject": { "kind": "event" }, "market_concept": "Golden Ball" } ] }
```

### Q5 "…which group England will win, plus their stage of elimination market?"
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": ["England"], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "to win group" },
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "stage of elimination" } ] }
```
Flag: "to win group" → no line (cf. Q10 "to win the group" → binary yes).

### Q6 'Pull up the "to reach the final" outrights for both Brazil and Argentina.'
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": ["Brazil","Argentina"], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Brazil" }, "market_concept": "to reach the final", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "Argentina" }, "market_concept": "to reach the final", "line": { "kind": "binary", "direction": "yes" } } ] }
```

### Q7 "…top European nation and top South American nation outright markets for WC 26."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "top European nation outright", "attrFilter": { "region": "Europe" } },
    { "subject": { "kind": "event" }, "market_concept": "top South American nation outright", "attrFilter": { "region": "South America" } } ] }
```

### Q8 "…outright winner of Group A through Group L for the World Cup 2026."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": { "round": "group stage", "ordinal": null, "conditional": false }, "time": null },
  "selectors": [ { "subject": { "kind": "event" }, "market_concept": "group winner", "line": { "kind": "selection", "value": "Group A" } }, … through "Group L" — 12 selectors, one per group ] }
```

### Q9 "…Young Player of the Tournament outright and the Golden Glove (best goalkeeper) market?"
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "Young Player of the Tournament" },
    { "subject": { "kind": "event" }, "market_concept": "Golden Glove" } ] }
```

### Q10 "Show me Spain's outrights: to win the group, to reach the semi-finals, and to win the tournament."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": ["Spain"], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "to win the group", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "to reach the semi-finals", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "to win the tournament", "line": { "kind": "binary", "direction": "yes" } } ] }
```

### Q11 'Can I get the "name the finalists" outright and the "winning confederation" market for WC 26?'
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "name the finalists" },
    { "subject": { "kind": "event" }, "market_concept": "winning confederation" } ] }
```

### Q12 "…dark horse outrights, top scorer by nation, and the highest-placed debutant team market."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "dark horse outrights" },
    { "subject": { "kind": "event" }, "market_concept": "top scorer by nation" },
    { "subject": { "kind": "event" }, "market_concept": "highest-placed debutant team" } ] }
```

### Q13 'I want the "to win the World Cup from the group stage" outright for the four hosts plus the top seeds.' — ⚠️ WRONG
```json
{ "status": "unsupported", "recognizedAs": "The query does not specify a sport and references 'World Cup' without naming a sport. While 'World Cup' commonly refers to FIFA football, the query is ambiguous … (football, cricket, rugby, etc.) … cannot be processed as a resolved football query." }
```
Should be `resolved` FOOTBALL (sport-silent → default). See Flag 1.

### Q14 "Pull up the stage of elimination outrights for Portugal, Germany, and the Netherlands."
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": ["Portugal","Germany","Netherlands"], "players": [], "competition": null, "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Portugal" }, "market_concept": "stage of elimination" },
    { "subject": { "kind": "team", "name": "Germany" }, "market_concept": "stage of elimination" },
    { "subject": { "kind": "team", "name": "Netherlands" }, "market_concept": "stage of elimination" } ] }
```

### Q15 "…team to score the most goals and the team with the best defensive record at WC 26?"
```json
{ "status": "resolved", "sport": "FOOTBALL", "event_scope": { "teams": [], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "team to score the most goals" },
    { "subject": { "kind": "event" }, "market_concept": "team with the best defensive record" } ] }
```

---

## 2026-06-01 15:50 CEST — VERIFY revert of Edit C (affected queries only: Q6/Q7/Q8/Q10)

Reverted Edit C to the proven tie-breaker ("superlative/occurrence/scorer stays binary"); kept
Edits A + B. Re-probed only the 4 affected.

**Scorer recovered (net positive):**
| Leg | Before revert | After revert |
|---|---|---|
| Q7 Mbappé brace | no line | binary yes ✓ |
| Q8 Pulisic anytime scorer | no line | binary yes ✓ |
| Q10 Mbappé first goalscorer | no line | binary yes ✓ |

Handicap Q10 "Asian handicap" · selection "-1.5" intact; Q10 "no own goal" → concept "own goal"
· direction "no" (correct). So with Q1/Q3 (already binary), scorer is now ~5/5 in dedicated
scorer queries.

**Q6 did NOT recover — Edit-C-regression hypothesis disproven.** The revert left Q6 unchanged,
so its slosh is intrinsic instability, not a clean C regression:
- "first goal before 15 minutes" → still **no line** (occurrence, no number — same class as bare
  "first card", KE-2).
- "no own goal" → still market_concept "no own goal" · binary **yes** (negation in the concept;
  Q10's identical phrase is correct → inconsistent).
- Vinicius "first goalscorer" → no line *in this context* (binary yes in Q3/Q10).

Net kept: Edits **A** (handicap → selection) + **B** (scorer list) + **reverted C**. Handicap
and scorer families fixed; Q6's occurrence/negation residuals logged as **KE-3**, parked.

---

## 2026-06-01 15:35 CEST — VERIFY: handicap + scorer edits applied; mixed result

Applied Edits A/B/C to `resolver/extractor-prompt.md` (A: handicap → selection in the selection
branch; B: scorer props added to the binary list; C: tie-breaker rewritten to
achiever/scorer → binary vs abstract-outcome → selection). Re-probed all 10. Gold still **3/3,
ship gate PASS**.

**WIN — handicaps unified (5/5), Edit A.** All one shape now: `market_concept` = type only,
`line` = selection of the signed number, team in subject.
| Query | After |
|---|---|
| Q1 / Q10 France -1.5 Asian | "Asian handicap" · selection "-1.5" |
| Q2 England -0.75 Asian | "Asian handicap" · selection "-0.75" |
| Q3 Brazil -2 3-way | "3-way handicap" · selection "-2" |
| Q4 Argentina +1 3-way | "3-way handicap" · selection "+1" |

**PARTIAL — scorer props (2/5), Edit B/C.** Same phrase, different result by context:
| Leg | After |
|---|---|
| Q1 Mbappé anytime scorer | binary yes ✓ |
| Q3 Vinicius first goalscorer | binary yes ✓ |
| Q8 Pulisic anytime scorer | no line ✗ |
| Q10 Mbappé first goalscorer | no line ✗ |
| Q7 Mbappé brace | no line ✗ |

**REGRESSION — Edit C dropped the word "occurrence" from the tie-breaker and sloshed Q6:**
- "first goal before 15 minutes" → **no line** (was binary yes).
- "no own goal" → market_concept "no own goal" + binary **yes** (was market_concept "own goal"
  + direction "no"; the negation belongs in `direction`). Q10's "no own goal" stayed correct
  (concept "own goal" / no) — so negation is now **inconsistent** between Q6 and Q10.

Corrective proposed: revert Edit C to the proven tie-breaker (restore "occurrence stays
binary"), add only "/scorer" to that clause; keep Edits A + B. Pending user OK.

---

## 2026-06-01 15:10 CEST — Handicaps / scorers / specials probes (10 queries)

Model: `claude-haiku-4-5-20251001`. All ten `resolved` FOOTBALL. New families probed: Asian &
3-way handicaps, scorer markets (anytime / first / opener), match specials (own goal, penalty,
VAR, extra time, brace, win-to-nil), correct score & winning margin. No edits made — probe only.

**Flag 1 (headline) — handicap line encoding is inconsistent (4 shapes for one family).**
The handicap number lands in `line`, in `market_concept`, in both, or nowhere; and the
`selection.value` form varies:
| Query | market_concept | line |
|---|---|---|
| Q1 France -1.5 Asian | "Asian handicap" | selection "-1.5" |
| Q10 France -1.5 Asian | "Asian handicap" | selection "-1.5" |
| Q2 England -0.75 Asian | "Asian handicap -0.75" | *(none)* |
| Q3 Brazil -2 3-way | "3-way handicap -2" | selection "Brazil -2" |
| Q4 Argentina +1 3-way | "+1 3-way handicap" | selection "Argentina +1" |
No single rule for handicaps. Number should live in one place (the line); `selection.value` form
should be fixed ("-1.5" vs "Brazil -2"). Needs a `line` rule for signed-threshold handicaps.

**Flag 2 — "win to nil" dropped its line once.** binary yes in Q3/Q7/Q8, but **no line** in Q10
(its final leg, a 6-selector query). Same concept, line dropped — position/length sensitive.

**Flag 3 — scorer markets split by phrasing.** Noun-phrase "anytime scorer" / "first
goalscorer" → **no line** (Q1, Q3, Q8, Q10); verb-phrase "to score the opener / first goal /
from the spot" → **binary yes** (Q5, Q6). Same semantics, shape keyed to surface phrasing.
(Defensible if scorer = pick/no-line and "to score" = binary — needs a convention call.)

**Flag 4 (minor) — "brace"** (Q7) → no line; arguably binary yes. **`either_match_team`** (Q9)
is a new subject kind for un-owned "team corners" — confirm vs binding to the salient team.

**Consistent & correct:** negation "no own goal" → binary **no** (Q6, Q10); all specials (own
goal, penalty, VAR, extra time, assist) → binary yes; correct score / winning margin →
selection; stage/level — "knockout"→round, "opener"→ordinal first, "WC 26 final"→round final +
competition, "at WC 26"→competition + level fixture (level-by-scope rule holding).

### Q1: "Show me France -1.5 Asian handicap vs Mexico, Mbappé anytime scorer, and over 3.0 Asian total goals."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["France","Mexico"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "Asian handicap", "line": { "kind": "selection", "value": "-1.5" } },
    { "subject": { "kind": "player", "name": "Mbappé" }, "market_concept": "anytime scorer" },
    { "subject": { "kind": "event" }, "market_concept": "Asian total goals", "line": { "kind": "numeric", "value": 3, "direction": "over" } }
  ] }
```

### Q2: "Can I get England -0.75 Asian handicap vs USA, under 2.75 Asian goals, and Bellingham shots on target over 1.5?"
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["England","USA"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "Asian handicap -0.75" },
    { "subject": { "kind": "event" }, "market_concept": "Asian goals", "line": { "kind": "numeric", "value": 2.75, "direction": "under" } },
    { "subject": { "kind": "player", "name": "Bellingham" }, "market_concept": "shots on target", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } }
  ] }
```
Flag: "Asian handicap -0.75" bakes the number into concept with no line (cf. Q1/Q10 selection "-1.5").

### Q3: "Give me Brazil -2 on the 3-way handicap vs a group minnow, Vinicius first goalscorer, and Brazil to win to nil."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Brazil"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Brazil" }, "market_concept": "3-way handicap -2", "line": { "kind": "selection", "value": "Brazil -2" } },
    { "subject": { "kind": "player", "name": "Vinicius" }, "market_concept": "first goalscorer" },
    { "subject": { "kind": "team", "name": "Brazil" }, "market_concept": "to win to nil", "line": { "kind": "binary", "direction": "yes" } }
  ] }
```
Note: "a group minnow" (unnamed opponent) → not added to teams. Number duplicated in concept + line.

### Q4: "Do you have Argentina +1 3-way handicap in a knockout tie, Messi to assist, and the match to go to extra time?"
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Argentina"], "players": [], "competition": null, "level": "fixture", "stage": { "round": "knockout", "ordinal": null, "conditional": false }, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Argentina" }, "market_concept": "+1 3-way handicap", "line": { "kind": "selection", "value": "Argentina +1" } },
    { "subject": { "kind": "player", "name": "Messi" }, "market_concept": "to assist", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "event" }, "market_concept": "to go to extra time", "line": { "kind": "binary", "direction": "yes" } }
  ] }
```

### Q5: "Give me France to score the first goal, an own goal in the match, a penalty awarded, and Mbappé to score from the spot vs Germany."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["France","Germany"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "to score first goal", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "event" }, "market_concept": "own goal", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "event" }, "market_concept": "penalty awarded", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "player", "name": "Mbappé" }, "market_concept": "to score from the spot", "line": { "kind": "binary", "direction": "yes" } }
  ] }
```

### Q6: "I want first goal before the 15th minute in Brazil's opener, no own goal, VAR overturn to occur, and Vinicius to score the opener."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Brazil"], "players": [{ "name": "Vinicius", "role": "plays" }], "competition": null, "level": "fixture", "stage": { "round": null, "ordinal": "first", "conditional": false }, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "first goal before 15 minutes", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "event" }, "market_concept": "own goal", "line": { "kind": "binary", "direction": "no" } },
    { "subject": { "kind": "event" }, "market_concept": "VAR overturn to occur", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "player", "name": "Vinicius" }, "market_concept": "to score the opener", "line": { "kind": "binary", "direction": "yes" } }
  ] }
```
Note: "no own goal" → binary **no** (negation read correctly). "to score the opener" → binary yes (cf. "first goalscorer" → no line in Q3).

### Q7: "Show me France to win to nil vs Mexico, win by exactly 2 goals, Mbappé brace, and a clean sheet for France at WC 26."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["France","Mexico"], "players": [], "competition": "World Cup 2026", "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "to win to nil", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "event" }, "market_concept": "winning margin", "line": { "kind": "selection", "value": "exactly 2 goals" } },
    { "subject": { "kind": "player", "name": "Mbappé" }, "market_concept": "brace" },
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "clean sheet", "line": { "kind": "binary", "direction": "yes" } }
  ] }
```
Flag: "brace" → no line (arguably binary yes). "at WC 26" → competition + level fixture (correct).

### Q8: "Do we have host nation USA to win to nil in the opener, Pulisic anytime scorer, and a 2-0 correct score?"
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["USA"], "players": [], "competition": null, "level": "fixture", "stage": { "round": null, "ordinal": "first", "conditional": false }, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "USA" }, "market_concept": "to win to nil", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "player", "name": "Pulisic" }, "market_concept": "anytime scorer" },
    { "subject": { "kind": "event" }, "market_concept": "correct score", "line": { "kind": "selection", "value": "2-0" } }
  ] }
```

### Q9: "Give me England to win full-time, lead at half-time, over 5.5 team corners, Saka shots on target over 1.5, Rice to be carded, and a clean sheet vs USA."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["England","USA"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "to win full-time", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "lead at half-time", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "either_match_team" }, "market_concept": "team corners", "line": { "kind": "numeric", "value": 5.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Saka" }, "market_concept": "shots on target", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Rice" }, "market_concept": "to be carded", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "clean sheet", "line": { "kind": "binary", "direction": "yes" } }
  ] }
```
Flag: "team corners" → `either_match_team` though the legs are England-centric. Confirm intended vs binding England.

### Q10: "I'd like France -1.5 Asian handicap, Mbappé first goalscorer, over 9.5 match corners, Dembélé shots over 2.5, no own goal, and France to win to nil in the WC 26 final."
```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["France"], "players": [], "competition": "World Cup 2026", "level": "fixture", "stage": { "round": "final", "ordinal": null, "conditional": false }, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "Asian handicap", "line": { "kind": "selection", "value": "-1.5" } },
    { "subject": { "kind": "player", "name": "Mbappé" }, "market_concept": "first goalscorer" },
    { "subject": { "kind": "event" }, "market_concept": "match corners", "line": { "kind": "numeric", "value": 9.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Dembélé" }, "market_concept": "shots", "line": { "kind": "numeric", "value": 2.5, "direction": "over" } },
    { "subject": { "kind": "event" }, "market_concept": "own goal", "line": { "kind": "binary", "direction": "no" } },
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "to win to nil" }
  ] }
```
Flag: "to win to nil" → **no line** here (binary yes elsewhere — Q3/Q7/Q8). Last leg of a long query.

---

## 2026-06-01 14:30 CEST — FIX APPLIED: line by answer-type, level by scope; full re-probe

Applied two principled rewrites to `resolver/extractor-prompt.md` (line = answer-type not
nouns; level = settlement scope not whether a tournament is named). Re-ran all 12 session
probes + gold eval.

**Result: 10/12 converged, gold 3/3, ship gate PASS.** Previously-failing now fixed — "most
fouls committed" / "highest possession in their group" → binary yes; "first foul inside 2
minutes" → binary yes + level fixture; Croatia "at WC 26" → level fixture; all
numeric/prop/selection markets unchanged. Level-by-scope confirmed: "at WC 26" alone → fixture,
"in their group" / "across the group stage" → competition.

**2 residuals from over-compression (clauses cut too aggressively), terse fix pending user OK:**
- "Pedri first card" → no line (regressed). Cause: dropped the bare first-event case → model
  routed it to numeric "no number → omit". Fix: scope *omit* to true over/under markets only.
- "most passes by a French player to be Griezmann" → `selection "Griezmann"` (value duplicates
  subject; should be binary). Cause: dropped the "superlative stays binary even when it names
  the achiever" clincher. Fix: restore that clause in the tie-breaker.

Plans unchanged from the 14:10 entry except those two fixes; not re-pasted.

---

## 2026-06-01 14:10 CEST — Shots / fouls / possession probes (6 queries)

Model: `claude-haiku-4-5-20251001`. All six `resolved` FOOTBALL. Surfaced that the 13:55
binary fix only **partially** generalized — see flags.

**Flag 1 (main) — superlative/achievement binary fix is keyed to corner/card examples, not the
category.** "most shots in the match" → binary yes (correct), but the same class missed when
the stat differs: "most fouls committed", "first foul inside 2 minutes", "highest possession
in their group", "most passes by a French player" all came back with **no line**. Root cause:
the yes/no branch enumerates phrasings instead of naming the category. Fix = state the category
("most/highest/fewest X", "first to N", "first X within N minutes", "to top/lead a ranking") =
binary yes regardless of stat. NOT YET FIXED — pending user go-ahead.

**Flag 2 — Q4 level misclassification.** "…at WC 26" flipped `level` to `competition` for
single-match markets ("first foul inside 2 minutes", "Modric to commit over 1.5 fouls"). A
named competition should not change level; `competition` is only for whole-tournament
settlement. Should be `fixture`.

**Flag 3 (minor) — concept wording.** Q1 "France over 18.5 match shots" → market_concept
"match shots" while Q2's equivalent gave "shots". Cosmetic.

### Q: "Give me France over 18.5 match shots, Mbappé shots over 4.5, Dembélé shots on target over 1.5, and over 9.5 shots on target combined."
```json
{
  "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["France"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "match shots", "line": { "kind": "numeric", "value": 18.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Mbappé" }, "market_concept": "shots", "line": { "kind": "numeric", "value": 4.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Dembélé" }, "market_concept": "shots on target", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } },
    { "subject": { "kind": "event" }, "market_concept": "shots on target combined", "line": { "kind": "numeric", "value": 9.5, "direction": "over" } }
  ]
}
```

### Q: "I want England team shots over 15.5 vs USA, Saka shots on target over 2.5, and most shots in the match by England."
```json
{
  "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["England", "USA"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "shots", "line": { "kind": "numeric", "value": 15.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Saka" }, "market_concept": "shots on target", "line": { "kind": "numeric", "value": 2.5, "direction": "over" } },
    { "subject": { "kind": "team", "name": "England" }, "market_concept": "most shots in the match", "line": { "kind": "binary", "direction": "yes" } }
  ]
}
```

### Q: "Do we have over 22.5 match fouls in Uruguay vs Brazil, Uruguay over 12.5 team fouls, and most fouls committed by Uruguay?"
```json
{
  "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Uruguay", "Brazil"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "match fouls", "line": { "kind": "numeric", "value": 22.5, "direction": "over" } },
    { "subject": { "kind": "team", "name": "Uruguay" }, "market_concept": "team fouls", "line": { "kind": "numeric", "value": 12.5, "direction": "over" } },
    { "subject": { "kind": "team", "name": "Uruguay" }, "market_concept": "most fouls committed" }
  ]
}
```
Flag: "most fouls committed" → no line; should be binary yes.

### Q: "Pull up first foul inside 2 minutes, Croatia over 11.5 fouls, and Modric to commit over 1.5 fouls at WC 26."
```json
{
  "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Croatia"], "players": [], "competition": "World Cup 2026", "level": "competition", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "first foul inside 2 minutes" },
    { "subject": { "kind": "team", "name": "Croatia" }, "market_concept": "fouls", "line": { "kind": "numeric", "value": 11.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Modric" }, "market_concept": "fouls", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } }
  ]
}
```
Flags: "first foul inside 2 minutes" → no line (should be binary yes); level should be `fixture`, not `competition`.

### Q: "Give me Spain over 65% possession vs Mexico, over 3.5 match offsides, and Rodri over 89.5 passes completed."
```json
{
  "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Spain", "Mexico"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "possession", "line": { "kind": "numeric", "value": 65, "direction": "over" } },
    { "subject": { "kind": "event" }, "market_concept": "match offsides", "line": { "kind": "numeric", "value": 3.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Rodri" }, "market_concept": "passes completed", "line": { "kind": "numeric", "value": 89.5, "direction": "over" } }
  ]
}
```
Clean.

### Q: "I'd like Germany highest possession in their group, over 5.5 Brazil offsides across the group stage, and most passes by a French player to be Griezmann."
```json
{
  "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Germany", "Brazil", "France"], "players": [], "competition": null, "level": "competition", "stage": { "round": "group stage", "ordinal": null, "conditional": false }, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Germany" }, "market_concept": "highest possession in their group" },
    { "subject": { "kind": "team", "name": "Brazil" }, "market_concept": "offsides across the group stage", "line": { "kind": "numeric", "value": 5.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Griezmann" }, "market_concept": "most passes by a French player" }
  ]
}
```
Flags: "highest possession in their group" and "most passes by a French player" → no line; both should be binary yes. (Coref to Griezmann + France-in-teams handled well.)

---

## 2026-06-01 13:55 CEST — FIX: binary handling for occurrence/specials markets

Root-caused the 13:40 cross-cutting flag and fixed `resolver/extractor-prompt.md`. Re-probed:
all six occurrence/specials markets now emit `binary "yes"`, quantity markets stay `numeric`,
gold eval still 3/3, ship gate PASS.

**Root cause (two reinforcing sources):**
1. The counted/over-under branch advertised "cards, corners" as counted nouns, so occurrence
   phrasings ("to be carded", "race to 5 corners") were routed to the counted branch by their
   *surface noun*, hit "no number → omit line", and dropped the line.
2. The lone "to be carded" example (attrFilter section) showed **no line**, modeling the wrong
   shape for a canonical yes/no market.

**Fix (rule rewrites, not example-piling):**
- Counted branch reframed as a *quantity threshold* (asks "how many" over/under); added an
  explicit hand-off: a counted noun without an over/under threshold is yes/no, not counted.
- Yes/no branch widened to cover *occurrence / achievement* markets ("to be carded", "a red
  card any time", "a card in the first 10 minutes", "first card", "race to 5 corners", "win
  the most corners") — a countable noun does not force numeric. Convention confirmed with user:
  these are all `binary "yes"`.
- Fixed the "to be carded" example to carry the binary line; widened universal rule 4.

**Follow-on bug caught + fixed in same pass:** flipping "first corner inside 5 minutes" to
binary made Haiku dump the timing band into `attrFilter: { position: "inside 5 minutes" }`.
Added an attrFilter guard: `position` is a player field position only; a time window / score
band is never an attrFilter — it stays in `market_concept` text. Re-verified: now
`market_concept "first corner inside 5 minutes"` + `binary yes`, no attrFilter.

Corrected outputs (the six that changed):

| Query phrase | Before | After |
|---|---|---|
| Casemiro "to be carded" | *(no line)* | binary yes |
| "red card any time" | *(no line)* | binary yes |
| "card in the first 10 minutes" | *(no line)* | binary yes |
| Pedri "first card" | *(no line)* | binary yes |
| Brazil "race to 5 corners" | *(no line)* | binary yes |
| Vinicius "to win the most corners" | *(no line)* | binary yes |
| "first corner inside 5 minutes" | selection "inside 5 minutes" | binary yes (timing kept in market_concept) |

Note: the gold set's `yes/no-line` tag is still uncovered — these six are strong gold-record
candidates now that the convention is pinned.

---

## 2026-06-01 13:40 CEST — Corners & cards multi-selector probes (4 queries)

Model: `claude-haiku-4-5-20251001`. All four returned `resolved` FOOTBALL plans.

**Cross-cutting flag — inconsistent binary handling.** Yes/no markets in this batch
("to be carded", "red card any time", "race to 5 corners", "to win the most corners",
"first card", "card in the first 10 minutes") emitted **no line**, whereas the prior
13:34 batch emitted `line: { kind: "binary", direction: "yes" }` for the same semantic
class ("clean sheet", "penalty to be saved", "win on penalties"). Same class, different
shape — likely a prompt-rule gap, and it matters for scoring (`lineEqual` treats absent
line as distinct). Decide the intended convention (binary-yes vs selection vs omit) and
tighten the rule.

### Q: "Give me over 10.5 match corners in France vs Germany, France over 6.5 team corners, and first corner inside 5 minutes."

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | event | match corners | numeric over 10.5 |
| 2 | team: France | team corners | numeric over 6.5 |
| 3 | event | first corner | selection "inside 5 minutes" |

Teams France + Germany, competition null. Clean: match vs team corners split correctly.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["France", "Germany"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "match corners", "line": { "kind": "numeric", "value": 10.5, "direction": "over" } },
    { "subject": { "kind": "team", "name": "France" }, "market_concept": "team corners", "line": { "kind": "numeric", "value": 6.5, "direction": "over" } },
    { "subject": { "kind": "event" }, "market_concept": "first corner", "line": { "kind": "selection", "value": "inside 5 minutes" } }
  ]
}
```

### Q: "I'd like Brazil race to 5 corners, over 4.5 first-half corners, and Vinicius to win the most corners in their group opener."

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | team: Brazil | race to 5 corners | *(none)* |
| 2 | event | first-half corners | numeric over 4.5 |
| 3 | player: Vinicius | to win the most corners | *(none)* |

Stage `round: "group stage", ordinal: "first"` (group opener) decoded correctly.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["Brazil"], "players": [], "competition": null, "level": "fixture", "stage": { "round": "group stage", "ordinal": "first", "conditional": false }, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Brazil" }, "market_concept": "race to 5 corners" },
    { "subject": { "kind": "event" }, "market_concept": "first-half corners", "line": { "kind": "numeric", "value": 4.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Vinicius" }, "market_concept": "to win the most corners" }
  ]
}
```

Triage: "first-half corners" bound to `event` though flanked by Brazil-specific legs — flag if Brazil-team scope expected. "race to 5 corners" / "win the most corners" are arguably `selection` markets, not bare binaries.

### Q: "Do you have over 4.5 match cards in Argentina vs Brazil, Casemiro to be carded, a red card any time, and over 2.5 second-half cards?"

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | event | match cards | numeric over 4.5 |
| 2 | player: Casemiro | to be carded | *(none)* |
| 3 | event | red card any time | *(none)* |
| 4 | event | second-half cards | numeric over 2.5 |

Teams Argentina + Brazil, competition null.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["Argentina", "Brazil"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "match cards", "line": { "kind": "numeric", "value": 4.5, "direction": "over" } },
    { "subject": { "kind": "player", "name": "Casemiro" }, "market_concept": "to be carded" },
    { "subject": { "kind": "event" }, "market_concept": "red card any time" },
    { "subject": { "kind": "event" }, "market_concept": "second-half cards", "line": { "kind": "numeric", "value": 2.5, "direction": "over" } }
  ]
}
```

### Q: "Show me Pedri first card vs Germany, Spain over 1.5 team cards, and a card in the first 10 minutes of WC 26."

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | player: Pedri | first card | *(none)* |
| 2 | team: Spain | team cards | numeric over 1.5 |
| 3 | event | card in the first 10 minutes | *(none)* |

Teams Spain + Germany, competition "World Cup 2026".

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["Spain", "Germany"], "players": [], "competition": "World Cup 2026", "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "player", "name": "Pedri" }, "market_concept": "first card" },
    { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "team cards", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } },
    { "subject": { "kind": "event" }, "market_concept": "card in the first 10 minutes" }
  ]
}
```

---

## 2026-06-01 13:34 CEST — Multi-selector keeper/goals probes (2 queries)

Model: `claude-haiku-4-5-20251001`. Both returned `resolved` FOOTBALL plans with all three
selectors intact.

### Q: "Show me Donnarumma over 4.5 saves vs Spain, Italy to keep a clean sheet, and under 2.5 match goals at WC 26."

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | player: Donnarumma | saves | numeric over 4.5 |
| 2 | team: Italy | clean sheet | binary yes |
| 3 | event | match goals | numeric under 2.5 |

Event scope: teams Italy + Spain, competition "World Cup 2026", level fixture, stage/time null.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": {
    "teams": ["Italy", "Spain"],
    "players": [],
    "competition": "World Cup 2026",
    "level": "fixture",
    "stage": null,
    "time": null
  },
  "selectors": [
    { "subject": { "kind": "player", "name": "Donnarumma" }, "market_concept": "saves", "line": { "kind": "numeric", "value": 4.5, "direction": "over" } },
    { "subject": { "kind": "team", "name": "Italy" }, "market_concept": "clean sheet", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "event" }, "market_concept": "match goals", "line": { "kind": "numeric", "value": 2.5, "direction": "under" } }
  ]
}
```

Notes: "vs Spain" correctly yielded both teams; whole-match goals bound to `event`, not a team. Looks correct.

### Q: "Can I get Martínez saves over 3.5 in Argentina's knockout game, a penalty to be saved, and Argentina to win on penalties?"

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | player: Martínez | saves | numeric over 3.5 |
| 2 | event | penalty to be saved | binary yes |
| 3 | team: Argentina | to win on penalties | binary yes |

Event scope: team Argentina, player Martínez (role `plays`), competition null, stage round "knockout", time null.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": {
    "teams": ["Argentina"],
    "players": [{ "name": "Martínez", "role": "plays" }],
    "competition": null,
    "level": "fixture",
    "stage": { "round": "knockout", "ordinal": null, "conditional": false },
    "time": null
  },
  "selectors": [
    { "subject": { "kind": "player", "name": "Martínez" }, "market_concept": "saves", "line": { "kind": "numeric", "value": 3.5, "direction": "over" } },
    { "subject": { "kind": "event" }, "market_concept": "penalty to be saved", "line": { "kind": "binary", "direction": "yes" } },
    { "subject": { "kind": "team", "name": "Argentina" }, "market_concept": "to win on penalties", "line": { "kind": "binary", "direction": "yes" } }
  ]
}
```

Triage flags:
- **Player duplicated** — Martínez is both a selector subject and listed in `event_scope.players` (role `plays`). Confirm this matches the intended gold convention (subject player also echoed into scope vs. only when a scope constraint like "if X starts").
- **Competition null** — "Argentina's knockout game" produced a stage (`round: "knockout"`) but no competition. Reasonable since none was named; flag if WC-26 context should be inferred by default.

## Stage B grounding collision probes (2026-06-03)

Ran the extractor to confirm the *real* `market_concept`/subject/line the grounder receives for the collision cases, then fed those exact values to `groundMarket`. The extractor strips the subject into `subject.kind`/`name` and leaves a **bare** stat as `market_concept` — so these are the true grounder inputs, not impoverished probe stubs.

### Q: "Will Saka have over 1.5 shots on target tonight?"

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | player: Saka | shots on target | numeric over 1.5 |

Event scope: time `tonight` (anchor `now`); everything else empty.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": [], "players": [], "competition": null, "level": "fixture", "stage": null, "time": { "date_window": { "value": "tonight", "anchor": "now" }, "kickoff_time_of_day": null } },
  "selectors": [
    { "subject": { "kind": "player", "name": "Saka" }, "market_concept": "shots on target", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } }
  ]
}
```

Grounding (`--ground "shots on target" --subject player --line numeric`): **confident → `2100112502` "Player's Headed Shots on Target"** — WRONG. Generic `2100015085` "Player Shots on Target" ranks 6th (0.554) vs headed (0.586). Gate dropped head-only rivals, leaving a 0.032 gap (just over ε=0.03) → false confidence on the over-specific market.

### Q: "Over 2.5 goals in Arsenal vs Chelsea"

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | event | goals | numeric over 2.5 |

Event scope: teams [Arsenal, Chelsea], everything else empty.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["Arsenal", "Chelsea"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "goals", "line": { "kind": "numeric", "value": 2.5, "direction": "over" } }
  ]
}
```

Grounding (`--ground "goals" --subject event --line numeric`): **none** — bare "goals" tops out at 0.495 (`Total Daily Goals`); the real `1001159926` "Total Goals" sits at 0.438, all below THRESHOLD=0.55. E5-safe abstain, but a miss. The weak link is the extractor emitting bare `goals` rather than `total goals`.

### Q: "Arsenal total goals over 1.5"

| # | Subject | Market | Line |
|---|---|---|---|
| 1 | team: Arsenal | total goals | numeric over 1.5 |

Event scope: teams [Arsenal], everything else empty.

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["Arsenal"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "team", "name": "Arsenal" }, "market_concept": "total goals", "line": { "kind": "numeric", "value": 1.5, "direction": "over" } }
  ]
}
```

Grounding (`--ground "total goals" --subject team --line numeric`): **name/confident → `1001159926` "Total Goals"** (match total) — but subject is `team`, so the intent is the per-team side-split `1001159967`/`1001159633` "Total Goals by Home/Away Team". The **exact-name path ignores subject entirely** and short-circuits before the bucket is consulted; and even if consulted, `team` and `event` both collapse to `team_or_match`, so the 2-way bucket can't separate per-team from match-level markets.

## #2 fix re-probe — prompt rule rewrite (2026-06-03)

Added a crisp rule to `extractor-prompt.md` (`market_concept` section): a **bare count noun** is incomplete — a whole-match/whole-team count names the aggregate `"total <noun>"` even when the query omits the word. Root-causes the conflict with the "close to query wording" rule rather than memorizing the failing query.

### Q: "Over 2.5 goals in Arsenal vs Chelsea" (re-probe)

```json
{
  "status": "resolved",
  "sport": "FOOTBALL",
  "event_scope": { "teams": ["Arsenal", "Chelsea"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [
    { "subject": { "kind": "event" }, "market_concept": "total goals", "line": { "kind": "numeric", "value": 2.5, "direction": "over" } }
  ]
}
```

`market_concept` is now **`"total goals"`** (was bare `"goals"`). Grounding (`--ground "total goals" --subject event --line numeric`): **name/confident → `1001159926` "Total Goals"**. #2 closed end-to-end.

## #1 canonical phrasing — player yes/no achievement rule (2026-06-03)

Added a crisp rule to `extractor-prompt.md` (`market_concept` section): a **player yes/no achievement** is an infinitive *to <verb>*, not a noun — "anytime goalscorer" → "to score", "clean sheet" → "to keep a clean sheet"; drop "anytime", keep "first/last". Generalizes a register the prompt already uses (`to be carded`) so the catalog's own name resolves via the exact-name path. Closes the residual fuzzy misses for these two concepts (were `none`).

### Q: "Will Haaland score anytime in Man City vs Chelsea?"

```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Man City", "Chelsea"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [ { "subject": { "kind": "player", "name": "Haaland" }, "market_concept": "to score", "line": { "kind": "binary", "direction": "yes" } } ] }
```

`market_concept` **`"to score"`** ("anytime" dropped). Grounding (`--ground "to score" --subject player --line binary`): **name/variants → `1001159886,1006478338` "To Score"** (was `none` for "anytime goalscorer").

### Q: "Arsenal clean sheet vs Chelsea"

```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Arsenal", "Chelsea"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [ { "subject": { "kind": "team", "name": "Arsenal" }, "market_concept": "to keep a clean sheet", "line": { "kind": "binary", "direction": "yes" } } ] }
```

`market_concept` **`"to keep a clean sheet"`**. Grounding (`--ground "to keep a clean sheet" --subject team --line binary`): **name/confident → `1003971484` "To keep a clean sheet"** (was `none`).

### Q: "Who will be first goalscorer in Arsenal vs Chelsea?" (regression guard)

```json
{ "status": "resolved", "sport": "FOOTBALL",
  "event_scope": { "teams": ["Arsenal", "Chelsea"], "players": [], "competition": null, "level": "fixture", "stage": null, "time": null },
  "selectors": [ { "subject": { "kind": "event" }, "market_concept": "first goalscorer" } ] }
```

`market_concept` **`"first goalscorer"`** — "first" preserved, NOT collapsed to "to score". Grounding (`--ground "first goalscorer" --subject event --line selection`): **vector/ambiguous** (Home/Away splits cluster 0.581–0.562) — unchanged by the rule; correct E5 abstention (no single match-level first-scorer market).

---

## 2026-06-03 — Re-probe: first-10 outright queries (regression check vs 2026-06-01 16:10 baseline)

Re-ran the first 10 logged outright probes (Q1–Q10) via `--query` after the Sprint 2/3 extractor-prompt + catalog changes (model `claude-haiku-4-5-20251001`, temp 0). **Input caveat:** the original full query strings were not preserved — the 2026-06-01 headers are truncated with a leading "…", so I re-probed the header text with the ellipsis stripped. Wording-level diffs could be input-driven; but the line-shape flips below are on **identical** concept strings → genuine prompt/model drift.

**4/10 reproduce the baseline exactly:** Q1 (`outright winner`), Q4 (`Golden Ball`), Q6 (Brazil/Argentina `to reach the final`, both binary yes), Q9 (`Young Player` + `Golden Glove`).

**6/10 drifted — three patterns:**

**Pattern A — binary line dropped on team yes/no outrights (regression).** Same concept string, `line` flipped vs baseline:
- Q2 `to win the tournament`: `binary yes` → **no line** (sibling `to reach the final` stays binary yes → in-query inconsistency, just moved).
- Q10 `to win the group` / `to reach the semi-finals` / `to win the tournament`: **all binary yes** → **all no line**.
- Q5 `to win the group`: **no line** → **binary yes** (opposite direction — improved).
- ⇒ Old Flag-2 inconsistency persists: Q5 `to win the group` = binary yes but Q10 `to win the group` = no line. Same proposition, two shapes. Matters for the grounder line→boType gate.

**Pattern B — `<UNKNOWN>` sentinel leaked into the plan.** Q5 s2 `stage of elimination` → `line: { selection, value: "<UNKNOWN>" }` (baseline had no line). A placeholder escaped into output.

**Pattern C — self-referential / meta selection lines (new noise).**
- Q3 `top goalscorer` → `line: selection "top five favourites"` (baseline no line) — meta-instruction encoded as a selection value.
- Q7 `top European nation` / `top South American nation` → `line: selection` duplicating the concept; **lost** baseline `attrFilter.region = Europe/South America`.

**Plus Q8 restructure:** baseline `group winner` ×12 + `selection "Group A…L"` → now concept `outright winner of Group A…L` ×12 with **no line** (group parameter moved from line into the concept). Both expand to 12 selectors; stage = group stage.

New plans for the 6 drifted (selectors only; event_scope unchanged from baseline unless noted):

```json
// Q2  "back France to win the tournament and reach the final as well."  (competition: null)
[ { "subject": { "kind": "team", "name": "France" }, "market_concept": "to win the tournament" },
  { "subject": { "kind": "team", "name": "France" }, "market_concept": "to reach the final", "line": { "kind": "binary", "direction": "yes" } } ]

// Q3  "top goalscorer outright markets for WC 26, including the top five favourites?"
[ { "subject": { "kind": "event" }, "market_concept": "top goalscorer", "line": { "kind": "selection", "value": "top five favourites" } } ]

// Q5  "which group England will win, plus their stage of elimination market?"  (teams: ["England"])
[ { "subject": { "kind": "team", "name": "England" }, "market_concept": "to win the group", "line": { "kind": "binary", "direction": "yes" } },
  { "subject": { "kind": "team", "name": "England" }, "market_concept": "stage of elimination", "line": { "kind": "selection", "value": "<UNKNOWN>" } } ]

// Q7  "top European nation and top South American nation outright markets for WC 26."  (competition: "World Cup 2026")
[ { "subject": { "kind": "event" }, "market_concept": "top European nation", "line": { "kind": "selection", "value": "top European nation" } },
  { "subject": { "kind": "event" }, "market_concept": "top South American nation", "line": { "kind": "selection", "value": "top South American nation" } } ]

// Q8  "outright winner of Group A through Group L for the World Cup 2026."  (stage: group stage) — 12 selectors, one per group:
[ { "subject": { "kind": "event" }, "market_concept": "outright winner of Group A" }, … "Group B" … through … "Group L" ]

// Q10 "Show me Spain's outrights: to win the group, to reach the semi-finals, and to win the tournament."  (teams: ["Spain"])
[ { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "to win the group" },
  { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "to reach the semi-finals" },
  { "subject": { "kind": "team", "name": "Spain" }, "market_concept": "to win the tournament" } ]
```

### Pattern A fix — team tournament-outright binary line (2026-06-03)

**Root cause.** Git shows the only prompt changes since the 2026-06-01 baseline are two uncommitted 2026-06-03 paragraphs in `market_concept`; last *commit* touching the prompt was the repo reorg. Q10 (header carries the full query, no "…") regressed all-binary-yes → all-no-line on **identical input** ⇒ prompt-driven. Two compounding causes: (1) the new achievement rule was scoped "**player** yes/no achievement → *to <verb>*", yet its own `clean sheet → to keep a clean sheet` example is a team market — the "player" label told the model a team "to win the tournament" isn't a yes/no, weakening its binary default; (2) the binary rule's coverage list (props / occurrences / superlatives) **never named the team tournament-outright family**, so it was unanchored even at baseline (why Q5 was the lone 2026-06-01 outlier).

**Fix (crisp rule rewrite, not example-appending) — 3 edits to `extractor-prompt.md`:**
1. `market_concept`: "**player** yes/no achievement" → "**yes/no achievement** (a player *or team* proposition)" — removes the false player-only scoping.
2. `line`/binary `Covers …` list: add "a **named team's tournament outright** (to win the tournament / group, to reach the final / semi-finals — a single team's progression is a yes/no)".
3. Binary-vs-selection note: add the protective contrast — a **named team to win / reach** a stage → `binary` ("Spain to win the group" → binary yes); the bare **field** outright ("outright winner", "group winner") names no side → subject `event`, not binary.

**Verification re-probe (5 queries, temp 0):** all pass.
- Q2 `back France to win the tournament and reach the final`: **both `binary` yes** (s1 regained).
- Q10 `Spain … to win the group / reach the semi-finals / win the tournament`: **all three `binary` yes** (regained).
- Q5 `to win the group`: **`binary` yes** (Flag-2 inconsistency vs Q10 now resolved — both binary yes).
- Control Q1 `outright winner` (event field): **no line** — did NOT over-trigger to binary.
- Control Q6 Brazil/Argentina `to reach the final`: **both `binary` yes** — unchanged.

**Still open (out of scope):** Q5 s2 `stage of elimination` still emits `selection { value: "<UNKNOWN>" }` (Pattern B — a which-round pick with no named round; the `<UNKNOWN>` sentinel should be a no-line/abstain, not a fabricated selection value). Pattern C (Q3/Q7 self-referential selection lines; Q7 lost `attrFilter.region`) also untouched.

### Stage-2 grounding of the first-10 plans (2026-06-03)

Fed the **already-extracted** `market_concept`/`subject.kind`/`line.kind` from the plans above into `--ground` (no Haiku re-run; post-fix plans for Q2/Q5/Q10). 13 unique (concept, subject, line) triples — `to win the tournament`/`to win the group` dedupe across Q2/Q5/Q10; `outright winner of Group A` stands in for Q8's 12 identical group selectors.

| concept (subj/line) | grounded | tier | verdict |
| --- | --- | --- | --- |
| outright winner (event) | `1001221607` Winner | vec/confident 0.557 | ✓ correct |
| to reach the final (team/bin) | `1001232823` To reach the Final | name/confident | ✓ correct |
| Young Player of the Tournament (event) | `1003303515` Young Player of the Tournament | name/confident | ✓ correct |
| to reach the semi-finals (team/bin) | `1001241010` To reach the Semi Final | vec/confident 0.553 | ✓ correct (gate chose team-specific over plural `1004664149`) |
| **to win the tournament** (team/bin) | `1003027271` Any Team to win **without conceding a goal** | vec/confident 0.584 | ✗ FALSE-CONFIDENT (right `1005991769` To win the competition was #2 @ 0.570) |
| **Golden Ball** (event) | `1004699098` Golden Ball **& team doesn't reach KO** | vec/confident 0.560 | ✗ FALSE-CONFIDENT (no clean Golden Ball criterion; compound won) |
| top goalscorer (event/sel) | `1004105291,1003786635,2100047425,1003267569` | vec/ambiguous 0.617 | ~ abstain (correct `1003786635` in set) |
| **to win the group** (team/bin) | none | — | ✗ MISS — `1001241029` To win Group 0.584 / `1001615382` Group Winner 0.601 gated out by binary boType gate |
| top European nation (event/sel) | none | — | ~ near-miss (`1001876097` Best European Team 0.490, sub-threshold) |
| top South American nation (event/sel) | none | — | ~ near-miss (`2100017824` Best South American Team 0.533) |
| outright winner of Group A (event) | none | — | ~ near-miss (`1001615382` Group Winner 0.515; concept-baking lowered the match) |
| stage of elimination (team/sel) | none | — | ✓ correct abstain (top candidate 0.349 — no such market) |
| Golden Glove (event) | none | — | ✓ correct abstain (no best-GK criterion) |

**Tally:** 4 correct grounds, 2 correct abstains, 2 false-confidents, 1 ambiguous, 3 threshold/gate near-misses.

**Findings:**
1. **Two false-confidents (E5 precision miss)** — `to win the tournament` → "win without conceding a goal", `Golden Ball` → a conditional compound. Generic concept loses at the top of cosine to a longer specific name (the semantic-collision case). The correct/competition markets cluster just below (`To win the competition` 0.570, `To Win The Trophy` 0.553).
2. **Pattern A fix surfaced a gate seam** — `to win the group` now emits `binary`, so the line→boType HARD gate filters out `To win Group` (0.584) / `Group Winner` (0.601) → `none`. Extractor correct, grounding can't complete; likely those catalog markets aren't tagged binary. (Q5 baseline also failed here — not a new regression, but a real seam.)
3. **Catalog covers outrights better than cautioned** — real markets present for Winner, To reach the Final/Semi Final, Young Player, To win the competition, Group Winner, Best European/South American Team. Only `stage of elimination` and `Golden Glove` are genuinely absent; the other `none`s are threshold/gate near-misses, not missing data.
4. **Concept-baking hurts grounding** — `outright winner of Group A` (0.515, none) vs the cleaner `group winner` register; argues for the baseline parameterized shape (concept `group winner` + `selection "Group A"`) over the drifted baked concept.

### Gate seam fix + yes/no tie-break (2026-06-03)

Resolves Finding #2's seam above (`to win the group` → `none`) and re-tunes the two markets it touched. Two changes to `ground-market.ts` (an **untracked** file — `git diff` won't show it).

**1. Gate fix — `BINARY_BOTYPES` now `{yesno, outright}` (was `{yesno}`).** A named subject's tournament outright (to win the group / tournament, to reach a stage) is itself a yes/no, but Kambi tags those markets `outright`, often WITHOUT `yesno` (verified: `To win Group` `1001241029` / `Group Winner` `1001615382` carry boTypes `["outright"]` only; `To reach the Semi Final` `1001241010` carries `["head","outright","yesno"]`). The binary HARD gate therefore wrongly dropped the outright-only ones. Adding `outright` can only let MORE candidates pass, never fewer.

Effects of the gate fix **alone** (re-probed, team/binary):
- `to win the group`: `none` → **`[1001615382,1001241029]` ambiguous 0.600** — SEAM CLOSED.
- `to win the tournament`: false-confident "win without conceding" → **ambiguous `[1003027271,1003844283]`** — precision WIN (honest abstain).
- `to reach the semi-finals`: confident `[1001241010]` 0.553 → **ambiguous `[1004664149,1001241010]` 0.555** — REGRESSION: the outright-only plural `Teams to reach the Semi-Finals` (`["outright"]`, 0.555) now survives the gate and edges the correct `To reach the Semi Final` (`yesno`-bearing, 0.553).

**2. Rejected: blunt "penalize non-`yesno` on a binary line" (−0.05 to `adj`).** Verified it DID restore semi-finals to confident, but it turned `to win the tournament` into a **false-confident on the WRONG market** `1003027271` "Any Team to win without conceding a goal" — a `yesno`-only false-friend that tops raw cosine (0.584). The penalty demoted every better outright candidate (Tournament Outcome, Winner, To Win The Trophy) and left the false-friend alone → confident wrong id = **E5 violation**. The fix-lever and the bug-lever are the same (both shove a rival out of the ε band), so a uniform penalty can't buy one without the other. Reverted.

**3. Adopted: scoped `yesno` tie-break at the ambiguous step.** When a binary near-tie cluster (survivors within ε of top) is **entirely `outright`-typed** AND a *strict subset* ALSO carries `yesno`, prefer that subset (the truer single-subject yes/no). The `allOutright` guard is the crux — a `yesno`-**only** false-friend lacks `outright`, so it fails the guard and never triggers the preference. No new score penalty; the rule only re-tiers an already-detected collision.

Final state (re-probed, deterministic):
| concept (team/bin) | grounded | tier | vs gate-fix-only |
| --- | --- | --- | --- |
| to reach the semi-finals | `1001241010` To reach the Semi Final | confident 0.553 | regression **FIXED** |
| to win the group | `1001615382,1001241029` Group Winner / To win Group | ambiguous 0.600 | unchanged (no `yesno` member in cluster) |
| to win the tournament | `1003027271,1003844283` …without conceding / Tournament Outcome | ambiguous 0.584 | unchanged — guard blocks false-confident |
| to reach the final / to win the competition | (name/confident) | — | unchanged (name path, pre-vector) |

Net: gate seam closed (group outrights ground), `to win the tournament` stays an honest abstain, semi-finals confident restored — all **E5-clean**. The remaining collisions (`to win the tournament`, `Golden Ball` from Finding #1) are genuine semantic-collision cases for the rerank/facet work, not boType-gate problems.
