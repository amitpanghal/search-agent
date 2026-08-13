# Extractor rebuild: probe-driven corpus, gold set, schema + prompt rewrite

## Context

58 queries were run through the live pipeline across 14 sports (traces: `run.jsonl`, `run2.jsonl`).
14 produced an answer; **1 was fully correct**. The failures cluster into three owners, and only one is
the prompt:

| failure | owner |
|---|---|
| League dropped when it also identified the sport (`MLB game` → `competition: null`) | extractor prompt |
| "the over" lost, or flipped to "under" by a filter clause | extractor prompt |
| "by 13+ / by a big margin" picks the plain winner market | extractor prompt |
| Fractional odds read as decimal (`4/1` → `min 4`, should be 5.0) | extractor prompt |
| Price floor becomes a second betting leg | extractor prompt |
| Named team replaced by a guessed home/away side (Valkyries → Chicago Sky) | extractor prompt |
| Line filters never filter — `line above 8.5` returned the whole 6.5–12.5 ladder | **schema** (no line range) |
| `biggest handicap` / `highest total line` — no line sort exists | **schema** |
| `combined odds clear 2.0` applied to one leg, killing it | **schema** (odds is per-selector) |
| Odds bound runs before the line pick and silently moves the line | `select.ts` (Phase 7) |
| Pick destroyed by 512-token truncation | `resolve-market.ts` (**already fixed**: `maxItems: 3`) |

The prompt (328 lines) grew by accretion, one rule per sprint, tuned against a gold set of **18 rows,
all football**, in which:

- `scope` is graded as a **soft, non-blocking note, on leg 0 only** ([structural-scorer.ts:346](src/eval/structural-scorer.ts:346) → `scopeDiffs`) — the dropped-league bug cannot fail the gate.
- `direction` is **not graded at all** — it isn't a field on `GoldSelector`.

So the prompt cannot be safely rewritten yet: nothing would catch what a rewrite breaks across the other
40 sports. **Build the measurement net first, then rebuild the extractor against it.**

---

## Phase 0 — Branch

All of this lands on a dedicated branch off `main`, e.g. `extractor-rebuild`. `main` keeps the current
extractor working while the corpus and rewrite churn. Only the `maxItems: 3` fix in `resolve-market.ts`
(already applied, unrelated to the rewrite) is a candidate to cherry-pick to `main` early.

---

## Phase 1 — Make the eval able to see the bugs

Without this the rewrite is unmeasured. No prompt changes in this phase.

| change | file |
|---|---|
| Add `direction` to `GoldSelector`; grade it beside `line`/`odds`/`odds_sort` | `src/eval/gold-record.ts`, `src/eval/structural-scorer.ts` |
| Promote `scope` from soft note to **hard failure**, gated by the row's tags (a row tagged `scope-competition` fails on a competition miss; untagged rows keep it soft) | `src/eval/structural-scorer.ts` |
| Compare scope **per leg**, not just `selectors[0]` | `src/eval/structural-scorer.ts` |
| Relax `MarketConcept` to allow an **accept-only** cell (`{accept: [...]}`) | `src/eval/gold-record.ts` |
| Add behaviour tags for the new classes (below) | `src/eval/behavior-tags.ts` |

New tags:

```
league-modifier    critical   "<COMP> game/match" — the modifier is the competition, not a category word
over-under-side    critical   "the over" sets direction; a filter clause must not flip it
margin-market      critical   "by 13+" is a margin/handicap market, not the plain winner
price-fractional   critical   "4/1" -> 5.0 decimal; "even money" -> 2.0
price-not-a-leg    critical   a price floor is `odds`, never a second selector
named-over-side    critical   a named team beats a guessed home/away side
outright           critical   competition-grain winner/top-scorer/progress markets
player-prop        critical   per-player line markets vs the team/match total twin
score-combo        critical   correct score / set betting / map score — and the subject's SIDE of it
multi-leg          critical   two settling bets in one query, correctly split and bound
line-range         soft       "line above 8.5" is a range, not a rung        (needs Phase 3)
line-sort          soft       "biggest handicap" ranks by line               (needs Phase 3)
combined-odds      soft       "combined odds over 2.0" is query-level        (needs Phase 3)
family-ask         soft       "show me all the corner markets"
```

Exit check: the existing 18 rows still pass (they need `direction` backfilled where the query names a side).

---

## Phase 2 — Sweep the feed and the catalogs (free: Kambi only, no LLM)

Produce a per-sport **fact sheet** feeding the corpus, the alias tables and the prompt.

Reuse: `src/resolver/offering-client.ts`, `marketLabelOf`/`variantOf` in `src/resolver/recall.ts`,
`loadScopeCatalog` in `src/resolver/scope-catalog.ts`, `scripts/fetch-groups.ts`,
`catalogData/*-scope-index.json`.

Collect per sport:

1. **Competition names + short-forms** — every group name plus how people say it (MLB, NFL, AFL, NPC, AIHL, CS2). Only **3 of 41** sports have an alias file today (`football`, `basketball`, `tennis`).
2. **Market families, classified by offering type** — the real `criterion.englishLabel` + `description`, bucketed into: match result · handicap/spread · totals · team totals · player props · outrights/awards · score combos · method/specials · first/last · in-play. This is the ground truth for what a `market_concept` must land on, and the evidence for the market-naming rules.
3. **`betOfferType` distribution** — which sports actually carry handicaps, totals, correct-score, set-betting. Drives which shapes are worth testing per sport.
4. **Event-name shape** — `home - away` vs `away @ home`. Root cause of the Valkyries/Chicago Sky side inversion.
5. **Catalog gaps** — leagues in the feed with no catalog entry (AIHL confirmed missing), and the four sports whose root returned **404** (`padel`, `surfing`, `pesapallo`, `swimming`) — stale or renamed.

Measured baseline (live, this session) — market families per sport at the sport root:

```
A (deep)    tennis 545 · rugby-league 316 · football 265 · american-football 255 ·
            basketball 201 · baseball 176 · ufc-mma 164
B (medium)  golf 96 · australian-rules 95 · rugby-union 94 · cricket 81 · esports 74 ·
            table-tennis 61 · ice-hockey 39 · darts 38 · snooker 36
C (thin)    boxing 11 · horse-racing 5 · volleyball 5 · formula-1 3 · handball 2 · chess 1 · …
```

Deliverable: one fact sheet per sport (scratch dir) plus a written summary of (1)–(5). No production
files change here.

---

## Phase 3 — Schema changes

Only fields the probes proved missing; each needs a consumer or it's dead weight.

| field | why | consumer |
|---|---|---|
| `line: number \| string \| {min?, max?}` | "runs line above 8.5", "total under 41", "handicap bigger than 10" | `select.ts` line gate |
| `line_sort: "low" \| "high"` | "biggest handicap", "highest total line", "widest spread" — today mis-filed into `odds_sort` (a *price* sort) | `select.ts` + cross-event ranking |
| query-level `combined_odds: {min?, max?}` | "only if the combined odds clear 2.0" — per-selector `odds` killed the Arsenal leg | `combinations.ts` `buildBetslip` |

Files: `src/resolver/schema.ts`, `src/resolver/normalize-plan.ts`, `src/resolver/live-menu-types.ts`
(`SelectSpec`), `src/resolver/select.ts`, `src/resolver/combinations.ts`.

Note: widening `line` is breaking for `SelectSpec.lineValue` and the combo-token path in `select.ts` —
the range form routes to a filter; scalar and combo-token forms keep today's behaviour.

---

## Phase 4 — Build the corpus (~450 queries)

Two axes, crossed per sport: **offering type** (what the sport actually carries, from Phase 2) ×
**query shape** (how people phrase it). Queries are authored against real fixtures found in Phase 2, so
they reference things that exist.

**Offering types** — the coverage the current 58 probes almost entirely missed:

```
match result / moneyline      handicap / spread / line        totals over-under
team totals                   player props (line + anytime)   outrights: winner / top scorer / MVP
tournament progress           score combos: correct score / set betting / map score
method & specials: by KO / by decision / to nil / straight sets
first & last: first goalscorer / first try / last scorer
in-play / live                family asks ("all the corner markets")
multi-leg: same event         multi-leg: cross event          bet-builder / prepack coupons
```

**Query shapes** — each traceable to an observed failure:

```
league as modifier · league detached · bare league browse · A vs B + named side ·
margin/handicap ask · the over vs a filter clause · line range · line sort ·
odds floor decimal · odds floor fractional · odds range + sort · combined odds ·
multi-leg same subject · multi-leg split subjects · time windows (tonight / weekend /
next N hours / tomorrow morning / Saturday) · play state · coreference · retraction ·
non-English · marketless browse
```

**Sizing, by tier** (queries scale with the sport's real variety):

| tier | sports | per sport | total |
|---|---|---|---|
| A | tennis, football, american-football, basketball, baseball, rugby-league, ufc-mma | ~30 | 210 |
| B | golf, australian-rules, rugby-union, cricket, esports, table-tennis, ice-hockey, darts, snooker | ~15 | 135 |
| C | remaining ~21 (incl. horse-racing, greyhounds, boxing, motorsports, volleyball, F1, athletics, handball, politics, virtual-sports) | ~5 | ~105 |

≈ **450 queries**. Run extract-only and capture every plan:

```bash
npm run probe -- --file corpus.txt --until=extract --out corpus.jsonl --log=silent
```

**Split 70/30 into gold (tuning) and holdout (verification).** The holdout is run only at the end of an
iteration — it's what proves we generalised rather than fitted the examples.

---

## Phase 5 — Freeze the gold set

Authoring ~315 gold rows is the heaviest step. Method:

- For the **known-broken shapes**, write the expected plan **blind first**, before looking at what the
  model produced — otherwise we anchor on the current wrong answer and encode the bug as gold.
- For everything else, run the sweep and **review/correct** the extracted plan. Correcting is far faster
  than authoring from blank, and accept-only market cells mean writing the wording, not looking up ids.
- Tag every row with the Phase 1 behaviour tags.

Extend `src/eval/gold.seed.jsonl`; bump `src/eval/gold.meta.json`. Then run `npm run eval` against the
**current** prompt to record the baseline the rewrite must beat. Expected: heavy failures on
`league-modifier`, `over-under-side`, `margin-market`, `price-fractional`, `outright`, `score-combo`;
football rows stay green.

---

## Phase 6 — Rewrite the prompt

**Carry forward (each was paid for with a sprint — do not re-litigate):** settlement-based leg splitting;
per-leg scope with no inheritance; coreference (`his` / `their team`); self-correction on retractions;
canonical `date_window` tokens; language detection with proper nouns excluded; the `main` sentinel;
sport-agnostic rules with per-sport vocabulary in the alias tables, never in the prompt.

**Rewrite around the evidence:**

- `competition` — a competition usually appears as a **modifier on the event noun** ("`<COMP>` game/match/round"). Strip the event noun and record what's left; an acronym in that slot is a competition name, not a sport tag. (Probe: `In the MLB, which game…` keeps it; `Which MLB game…` drops it.)
- `direction` — the side belongs to the **bet clause**; a condition clause ("only if the total is under 41") never sets it.
- `odds` — decimal, fractional (`4/1` → 5.0) and idiom (`even money` → 2.0) normalise to decimal; a price is never a selector.
- `line` vs line range vs `line_sort` — three readings, one rule, with the discriminator stated.
- subject — a **named** team or player always beats a positional home/away guess.
- margin — "by N+" / "by a big margin" names a margin market, not the winner.
- outright vs fixture grain — driven by what settles, with the Phase 2 family list as evidence.

Iterate: edit → `npm run eval` → read per-tag rates → next edit. **One rule change per measurement.**
When gold is green, run the holdout once.

The measurement loop, now that the deck is ~300 rows rather than 18:

```bash
npm run eval                                     # 289 corpus + 14 seed, 8-way concurrent, 1x
npm run eval -- --runs 3 --jobs 8                # the measuring default; a row passes only if all 3 pass
npm run eval -- --from .sweep/gold-extract.jsonl # re-score a CAPTURED sweep, no model call, no cost
```

Use `--from` whenever only the gold changed. Only a prompt or model change needs fresh extractions.

---

## Phase 7 — Downstream follow-ups (tracked so they aren't lost)

- `select.ts:251` — the odds bound runs before the line pick and silently moves the line ("Bueckers 20+ points" + "above 2.0" → Over 24.5). Reorder: line first, then price.
- With a line range and no named rung, "the over" picks an arbitrary ladder position (8.5) instead of the fixture's headline rung (9.5). Default to `MAIN_LINE`.
- A failed odds bound deletes the whole leg; report the real price instead ("the spread is 1.91, under your 2.0").
- `check-complete.ts` — revisit the hard stop once the extractor reliably emits `competition`.
- Catalog: add leagues found missing in Phase 2 (AIHL) and fix the four 404 sports.

Found while authoring Phase 5 (all verified against the code, none of them extractor bugs):

- **`scopeMenu` narrows head-to-head on `leg.teams` only.** In an individual sport that is fine (the corpus
  routes competitors to `teams`), but a leg naming two people in `players` — or a mixed leg — never intersects
  to the one fixture. Consider intersecting on players too.
- **The per-player grain hint keys off `subject.kind === "player"`** ([resolve.ts:51](src/resolver/resolve.ts:51)). Individual-sport
  competitors are `team`, so tennis/darts/snooker never get the hint — the known cause of resolve-market
  preferring the combined-total twin over the per-player one. The hint should ask "is this subject one of the
  fixture's two sides in an individual sport?", not "is the kind player?".
- **Catalog gaps.** `darts` has 0 teams and its player list misses live competitors ("Neil Wild" → none;
  "Michael Huntley" → *Michael van Gerwen*, a confidently-wrong shortlist). `table-tennis` grounds neither
  "Slawomir Janus" nor its other live names. Both sports' corpus rows therefore cannot ground even with a
  perfect extraction.
- **`z-sports` is a shadow root** carrying NBA/NFL/EPL groups ("Los Angeles Lakers - Boston Celtics" is a
  z-sports fixture). No query can tell it apart from the real sport, so those gold rows accept either.
- **An off-enum `sport` still sinks the whole query** (`z001` "Who wins the Cook Out 400?" → `"nascar"` →
  `QueryPlan` validation error). It should degrade to `other`, not throw.

---

## Critical files

```
src/resolver/extractor-prompt.md      the rewrite target (328 lines)
src/resolver/schema.ts                QueryPlan; line range, line_sort, combined_odds
src/resolver/normalize-plan.ts        tolerate the new shapes
src/eval/gold-record.ts               direction field; accept-only market cell
src/eval/structural-scorer.ts         hard scope, per-leg, direction grading
src/eval/behavior-tags.ts             new tags + tiers
src/eval/gold.seed.jsonl              18 -> ~315 gold rows
src/resolver/select.ts                consumes line range / line_sort (Phase 3 + 7)
src/resolver/combinations.ts          consumes combined_odds
catalogData/*-scope-aliases.json      per-sport short-forms (3 of 41 exist today)
scripts/probe.ts                      the sweep tool (--until=extract, --out)
```

## Verification

1. `npm run typecheck` — clean.
2. `npm run eval` — ship gate PASS: critical tags 100%, soft aggregate ≥90%, entity and market gates green. Compare per-tag rates against the Phase 5 baseline.
3. Holdout sweep — `npm run probe -- --file holdout.txt --until=extract --out holdout.jsonl`, scored with the same scorer. Once per rewrite iteration, at the end.
4. Full-pipeline re-run of the original 58 probe queries against `run.jsonl`/`run2.jsonl`: answered count rises well above 14/58, and the confidently-wrong cases (Valkyries → Chicago Sky, Shelton → Tien, "the over" → under) are gone.
5. Spot-check the Phase 3 fields end to end: "runs line above 8.5" returns only lines >8.5; "biggest handicap" ranks by line; "combined odds clear 2.0" prices the parlay and compares once.

**Costs** (live API approved): Kambi free. Extract-only ≈ $0.001/query → ~$0.45 per 450-row sweep.
Full pipeline ≈ $0.0025/query → ~$1.10 for the whole corpus, ~$0.15 for the 58-query regression.
