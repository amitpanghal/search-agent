# Extractor role split: findings behind reducing the extractor to Job A

## Why this document

The extractor mis-splits queries and fails in unrelated-looking ways, and its prompt rules fight each other —
roughly half of them try to settle *catalog* questions (which sport, is this a team or a player, does this league
exist) using only the sentence. The proposal under review is to change the extractor's **role** rather than patch
it again:

- **Job A (language)** — needs only the sentence: split legs, name the market, pull out the number, the side, the
  time, and the names with their grammatical roles.
- **Job B (data)** — needs the catalogues: which sport, is this name a team or a player, does that league exist,
  is it ambiguous.

This document records what the code and the catalog data actually say about that split — the blast radius on the
grounding layer, whether the per-type lookups survive, and what it costs to look a name up across every sport.
All numbers were measured on the repo as of 2026-08-14 (reproduction commands at the end).

Companion to [extractor-rebuild-plan.md](planning/extractor-rebuild-plan.md), which owns the measurement net,
the schema gaps and the prompt-rewrite loop.

## Verdict after measuring it (read this first)

The split was A/B-tested offline against 3 captured extractor sweeps × ~250 gold rows before any production code
changed (§6). The result splits the proposal in half:

- **The type half works, but barely matters.** Deriving team-vs-player and competition-vs-region from the
  catalogues beats the extractor's slot choice by **+0.8 to +1.6 points** — on an axis the extractor already gets
  **97.6-98.1%** right. That is 2-4 mentions per 250.
- **The sport half fails, decisively and reproducibly.** Deriving the sport from the names scores **52-57%**
  against the extractor's **90.7-92.0%**, and clarifies on a third of all queries. *Every* weaker variant that
  merely lets the catalogue **question** the extractor's sport also loses: finishing `recoverSport` as proposed
  scores 89.8-90.2% (below today), and its clarifications land almost entirely on rows that were already right.
- **The pain is in the language job, not the data job.** The official eval on the same captures fails
  `binding` 0/9, `multi-leg` 4/18, `score-combo` 3/13, `margin-market` 1/8, `named-over-side` 3/10. Those are all
  Job A. The data decisions the proposal wanted to relocate were already being made at 90-98%.

**So: keep `sport` in the extractor. Do not build the sport-hypothesis layer.** The parts of the proposal that
survive are the *diagnosis* (§1-3: the schema fuses role and type, and the prompt fights itself over claims the
extractor cannot make) and the prompt shrink that follows from it — but the win must come from freeing the
model's attention for the language job, **not** from better data decisions, because the data decisions were not
what was broken. Revised sequencing at the end.

---

## Finding 1 — `sport` is an index-selection variable, not a query variable

`recall` never uses the sport. It fetches by participant ids, group ids, levels and a locale; a grep for `sport`
across [recall.ts](src/resolver/recall.ts) returns one unrelated comment, and
[offering-client.ts](src/resolver/offering-client.ts) carries it only as an optional passthrough field.

The **only** thing `plan.sport` does is choose which catalog file names are looked up in:

```
ground-scope.ts:363     loadScopeCatalog(plan.sport)
plan-recall.ts:47       loadScopeCatalog(plan.sport)
resolve-entities.ts:102 loadScopeCatalog(scope.sport)
```

So the pipeline asks the LLM to pick the index *before* the lookup, and then spends a whole stage
([recover-sport.ts](src/resolver/recover-sport.ts)) plus an 11-line header comment undoing that choice. This is
an ordering bug, not a prompt-quality bug — no rewrite of the sport rules can fix it, which is consistent with
"five successive prompt rewrites moved nothing" recorded on `competition` in
[schema.ts:83-99](src/resolver/schema.ts:83).

## Finding 2 — the schema fuses two different claims into every slot

Each scope slot asserts a **role** (recoverable from grammar) and a **type** (only knowable from the catalogue)
at the same time:

| slot | role claim (language) | type claim (catalogue) |
|---|---|---|
| `scope.teams` | this name is the thing that plays / wins / scores | it is a club, not a player or a tournament |
| `scope.players` | this name constrains which fixture (plays/starts/captain) | it is a person in the participant index |
| `scope.competition` | this name qualifies *which* competition | such a competition exists, under this sport |
| `scope.region` | this place scopes where, it isn't a competitor | it is a top-level branch |
| `subject.kind` | `event` / `either_match_team` / `side` are roles | `player` / `team` are types |

The extractor cannot satisfy the right-hand column, so the prompt has grown defences against its own design:

- Universal rule 6 "never drop the anchor" exists because a name with no obvious slot gets dropped entirely.
- The one `.describe()` in the schema exists because a league that names its own sport (MLB, UFC, WNBA) gets
  spent on `sport` and never reaches `competition`.
- `recoverSport` exists because the sport claim is a guess that has to be defended and then overridden.
- `otherSports` exists because ambiguity has nowhere else to go.

Every one of those is downstream of the fusion. They delete themselves when the type claim leaves — which is the
real reason the prompt shrinks (~80-90 of 378 lines by construction), not because words get trimmed.

## Finding 3 — sport read from a market word is language; sport read from a name is data

These are different sources and the prompt mixes them in one paragraph
([extractor-prompt.md:35-41](src/resolver/extractor-prompt.md:35)): "read it from a named sport, the
teams/players/competition, or the market vocabulary". The first two are catalogue claims; the third is not.

Market vocabulary is a **genuine language signal and the only thing that resolves some ambiguities**:
"Cincinnati **total games** over 22.5" is decidable because *games* is tennis vocabulary; "three-pointers",
"aces", "both teams to score" likewise. Delete sport from the extractor outright and this signal is lost —
precisely for the queries the redesign is meant to fix.

**Recommendation:** keep a nullable `sport_hint` fed *only* by market vocabulary, explicitly with no authority.
The grounder uses it to break ties between sport hypotheses; it never selects a catalogue. The rule to write is
one line and cannot fight itself: *a sport read from a market word is language; a sport read from an entity name
is data.*

## Consequently — what Job A keeps and what it hands over

**Job A keeps (all grammar):** leg splitting by settlement; which mention owns the market; competitor vs
circumstance ("Italy to win" vs "Italian Serie A" — the place's role in the clause, not a catalogue fact);
participation role (plays / starts / captain); home/away side; `market_concept` wording; `line` vs `odds` vs
`line_sort` vs `odds_sort` vs `count`; `direction`; `time`; `stage`; `level`; coreference; retraction; query
language; `sport_hint` from market vocabulary only.

**Job B takes:** team vs player vs competition vs region-branch. ~~the sport; ambiguity and clarification~~ —
struck out by Finding 6: measured, the catalogues are much worse at the sport than the extractor is, so `sport`
stays in Job A (as a real decision, with `sport_hint`'s vocabulary evidence folded in).

The key consequence for design: **a role becomes a type mask, not a type assertion.** That is what lets the four
existing lookup functions survive unchanged (Q2 below).

---

## Finding 4 — measured: cross-sport lookup costs single-digit milliseconds after one index fix

Catalog inventory (`catalogData/`, 41 built sports, 21 MB on disk):

```
groups 558 · branches 215 · teams 30,529 · players 151,276

largest:  tennis 59,506 players · football 30,436 players + 24,229 teams · trotting 24,857 players
          football 7.4 MB · tennis 7.3 MB · trotting 2.6 MB  (of 21 MB total)
```

**Loading every catalog:** 379 ms cold, retaining ~158 MB heap / ~391 MB RSS. That is a *boot* cost for the
long-lived server, not a per-query cost — and it is memory, not latency.

**Per distinct mention, scanning all 41 sports:**

| grounder | ms per mention, all sports |
|---|---|
| `groundPlayer` | 0.05 |
| `groundRegion` | 0.25 |
| `groundCompetition` | 0.85 – 1.10 |
| `groundTeam` | **25.55** (single-token name) / 5.65 (two-token name) |

Everything except teams is Map-based and effectively free. The 25 ms is **one line** — the token-subset fallback
recomputes `contentTokens(t.name)` for all 30,529 team names on every miss:

```242:244:src/resolver/ground-scope.ts
    const hits = cat.teams
      .filter((t) => { const nt = contentTokens(t.name); return qTokens.every((q) => nt.has(q)); })
      .slice(0, TOP_K);
```

Cache those tokens at catalog load, or build a token → team-ids inverted index, and it collapses to
microseconds. A 3-mention query then costs single-digit milliseconds against every sport, against a Haiku call at
1-2 s and the Kambi fetch. **Performance is not an objection to this design.**

Two notes:

- `recoverSport` already pays the full all-catalog cost today on its blind-anchor path
  ([recover-sport.ts:34-39](src/resolver/recover-sport.ts:34)), so this is not a new class of cost — just a newly
  normal one.
- If the ~160 MB becomes a constraint, the alternative is a build-time cross-sport `name → [{sport, kind, id}]`
  index: measured at **8.9 MB and 126 ms** to load, after which full catalogs load only for surviving sport
  hypotheses. Not recommended initially — loading everything is simpler.

## Finding 5 — measured: the name space is barely ambiguous, but ambiguity sits in the wrong places

Across all catalogs there are **178,544 distinct folded names**. Only **3,300** have more than one home, and
**2,446** span more than one sport — **1.4%**, small enough to audit by hand.

But exact-name matching finds the *wrong* homes, because real sports spell entities fully while the polluted and
shadow catalogs hold the bare forms:

```
"barcelona"   exact -> virtual-sports team ONLY          (football's is "FC Barcelona")
"djokovic"    exact -> trotting player ONLY              (a horse; trotting also lists
                                                          "teams" named Feyenoord and Larsson)
"cincinnati"  exact -> 2 tennis groups + a virtual-sports team
                       (Cincinnati Reds / Bengals / FC Cincinnati surface only via the FUZZY
                        token-subset path)
"italy"       exact -> 14 sports; in football the region branch and the competition group are
                       the SAME id (1000461745), so collapsing region/competition costs nothing
```

Cross-sport hit counts from the same run (any non-`none` tier, all four grounders): `Cincinnati` 7 sports,
`Barcelona` 7, `Toronto` 9, `World Cup` 11, `Italy` 14, `Djokovic` 4, `Verstappen` 1.

Two design rules follow directly:

1. **Strong matches nominate a sport; weak matches only confirm one.** A tier reached via surname, first-name or
   token-subset fallback must never create a sport hypothesis on its own, or "Djokovic" nominates trotting.
2. **Shadow and polluted catalogs are excluded from nomination** — `virtual-sports`, `z-sports`,
   `esports-basketball`, and trotting's mirrored team index.
   [extractor-rebuild-plan.md](planning/extractor-rebuild-plan.md) already records `z-sports` as a shadow root
   carrying NBA/NFL/EPL groups.

And one uncomfortable consequence: the flagship case, "Cincinnati matches on now", is driven **entirely by fuzzy
matching**, which is the hardest place to rank across sports. Exact-name logic alone will not produce the right
clarification.

---

## Finding 6 — measured A/B: the sport half of the proposal fails, the type half wins by ~1 point

Findings 1-5 are static analysis. This one is an experiment, run before any production change, at zero API cost:
`scripts/probe-role-split.ts` replays the **captured** extract sweeps in `.sweep/` through different data layers
and scores each against gold. The language output is byte-identical across arms (the same saved strings), so every
difference is attributable to the data layer.

| arm | what it does |
|---|---|
| **A — today** | the extractor's own `sport` + typed slots, plus `recoverSport` |
| **B — proposal** | same names, slot collapsed to a ROLE, grounded across all 41 catalogues, sport DERIVED |
| **C — middle ground** | keep the extractor's sport; the catalogue only CHALLENGES it (proposal 4, "finish recoverSport") |

Ranges are across three captures (`gold-extract`, `gold-qwen-v2`, `gold-qwen-v3`), ~250 comparable rows each — a
row counts when it names at least one entity and its gold sport isn't `other`. A query naming no entity is refused
by `checkComplete` today, so neither arm resolves it; counting those would flatter arm A.

```
SPORT                              A (today)        B (derived)      C (challenged)
  correct                          90.7 - 92.0%     52 - 57%         89.8 - 90.2%
  wrong sport, proceeds anyway      7.6 -  9.3%     6.8 - 7.3%        8.0 -  9.3%
  asks the user instead                0%           32 - 35%          ~1%
                                                    (3.5 options avg)

ENTITY TYPE (same mentions, same denominator, sport given from gold)
  A - the extractor's slot choice   97.6 - 98.1%
  B - derived from the catalogue    98.7 - 99.2%    <- +0.8 to +1.6 points = 2-4 mentions per 250
```

**The ranking rule is not the bottleneck.** Three different rankings — most names matched, most matched
*exactly*, and Finding 5's "only a strong non-shadow hit may nominate" — land within half a point of each other
(52.2 / 51.8 / 51.8). The cross-sport evidence genuinely ties; no smarter ranking rescues it.

**Every variant that lets the catalogue question the sport also loses.** Arm C was measured three ways:

```
  extended   (recoverSport + competitions as anchors + 2-home clarify)  89.8 - 90.2%   asks: ~1%, almost all REGRESSIVE
  contested  (switch when a rival explains strictly more, strongly)     83.6 - 84.9%   17 regressive asks
  strong-wins (a STRONG rival beats a merely WEAK home sport)           77.0 - 78.1%   27 regressive asks
```

"Regressive" = the clarification replaced an answer arm A had already got **right**. `strong-wins` is the rule the
failures appear to ask for — `"Wellington to win to nil"` is rugby union with an exact club, kept as football only
because football has a loose player of that name — and flipping it fixes 4 rows while breaking 27.

### Why: a missing name means our catalogue is incomplete, not that the sport is wrong

This is the load-bearing reason, and it invalidates the whole family of catalogue-overrides-extractor rules. Of
the 21 rows where today's extractor picks a sport gold rejects:

- **~9 are pure catalogue gaps.** `"Michael Huntley +2.5 legs"` (darts) — absent from the darts catalogue, while
  six other sports carry that surname. Same shape: `"Show me the Tramore racecard"` (horse racing, nothing),
  `"Cook Out 400"` (motorsports, nothing), `"Mexican League"` (nothing but a trotting horse), `"CPL games on now"`
  (cricket's CPL missing; only football's CPL exists). **No pipeline design reaches these — only catalogue work
  does.** They match the darts/table-tennis gaps already recorded in
  [extractor-rebuild-plan.md](planning/extractor-rebuild-plan.md) Phase 7.
- **~8 have usable name evidence** but are blocked by `recoverSport`'s "any match keeps the sport" rule
  (`Wellington`, `Ondrej Kucirek`, `Czech Liga Pro`, `KPL`, `Valkyries`). Flipping that rule costs more than it
  wins — see above.
- **~2 need market vocabulary, not names.** `"Giron vs Rocha set betting"`: both names are weak in football and
  tennis, and *"set betting"* is the only real clue. This is the `sport_hint` case (Finding 3) and it lives in the
  extractor.
- **1 is `recoverSport` doing harm today.** `"Crvena Zvezda vs Bayern Munich, total points over 160.5"` — the
  extractor correctly says basketball; "Bayern Munich" is missing from the basketball catalogue and strong in
  football, so `recoverSport` switches the query to football and breaks a correct answer.

### And the pain is in the language job anyway

The official eval, re-scored on the same captures for free (`npx tsx src/eval/run.ts --from .sweep/gold-qwen-v3.jsonl`),
puts 170/285 rows passing, and the critical misses are all Job A:

```
binding          0/9    which name owns which bet — fails every time it is tested
multi-leg        4/18   two settling bets in one sentence, merged or dropped
score-combo      3/13   margin-market 1/8   named-over-side 3/10   price-fractional 8/19
```

Failing-facet counts: `sport` 27, `market` 25, `competition` 19, `binding` 18, `direction` 18, `line` 14.
So the data decisions the role split wanted to relocate were already being made at 90-98%, while sentence work
sits at 0-42%.

**What survives.** The diagnosis in Findings 1-3 stands: the schema does fuse role and type, and the prompt does
fight itself over claims the extractor cannot reliably make. But the payoff for removing those claims is **freed
attention for the language job**, not better data decisions. That benefit is real and untested — it needs a
rewritten prompt and a paid sweep (~$0.30 for 289 rows), which is the only part of this that cannot be measured
offline.

---

## Q1 — blast radius on the grounding layer

> Superseded in part by Finding 6: the sport-hypothesis layer described here should **not** be built. The rest of
> the section stands as the design note for the type half, which is the only part worth adopting.

Bigger than a patch, smaller than a rewrite, and containable if one line holds: **keep `ResolvedLegScope`
exactly as it is.** Grounding becomes (a) a new typeless front end resolving mention → sport + type + ids, then
(b) a projection into today's slot-shaped legs. Everything from `resolveEntities` onward — `planRecall`, the
`sigOf` grouping, `filterBySubject`, `select`, `execute` — never learns this happened.

| change | file | size |
|---|---|---|
| `Candidate` / `EntityResolution` gain `kind` + `sport` | [ground-scope.ts:39-52](src/resolver/ground-scope.ts:39) | the one rippling type change; the comment "no `kind` — kind is implied by which slot it sits in" is the invariant that inverts |
| `groundScope` **returns** the sport instead of receiving it (plus a third outcome: a sport clarification) | [ground-scope.ts:362](src/resolver/ground-scope.ts:362) | `ResolvedScope.sport` already exists, so the shape holds |
| Callers reading `plan.sport` re-point to the grounded sport | [resolve.ts:159-171](src/resolver/resolve.ts:159), [plan-recall.ts:47](src/resolver/plan-recall.ts:47) | 4 lines; `resolveEntities` already reads `scope.sport` |
| **New: sport-hypothesis layer** | new, in `ground-scope.ts` | the genuinely new code — see below |
| `recoverSport`, `otherSports` and the `"other"` enum member are deleted | [recover-sport.ts](src/resolver/recover-sport.ts), [schema.ts:152-158](src/resolver/schema.ts:152) | net deletion |
| `checkComplete` becomes "no mention at all" | [check-complete.ts](src/resolver/check-complete.ts) | simpler; its documented "odds in Atlantis" edge dissolves (no slot left to occupy with a fake) |
| Entity gate: cells become per-mention, candidates become mixed-type and mixed-sport | [resolve-entities.ts:94-134](src/resolver/resolve-entities.ts:94) | real work: `CellRef` slots, and `labelCandidates` must render "Cincinnati Reds (baseball team)" vs "Cincinnati (tennis tournament)" |
| Disambiguator prompt learns that candidates may be different *kinds* of thing | `src/resolver/disambiguator-prompt.md` | the second prompt rewrite — not zero |
| Eval: the scope/type axis moves from the extractor gate to the grounder gate | [structural-scorer.ts](src/eval/structural-scorer.ts), [scope-scorer.ts](src/eval/scope-scorer.ts) | see risk 2 |

**Why a sport-hypothesis layer is unavoidable.** `propagate` prunes candidate sets on shared structural ids
([ground-scope.ts:318](src/resolver/ground-scope.ts:318)), and ids are catalogue-local. A mention set spanning 41
catalogs therefore has *no* cross-sport links at all: every constraint would empty a set, the "a constraint that
would empty a set is SKIPPED" rule would decline to apply it, and the result is **zero pruning while appearing to
run**. The fix is structural, not a tweak: seed across catalogues, partition candidates by sport, run the
existing `propagate` **per sport hypothesis**, then rank hypotheses (with `sport_hint` as a tiebreak). The
constraint engine itself is reused unchanged.

Note also that `recoverSport`'s replacement is *simpler*, not a completed version of itself: its whole
"blind = trigger, any match = keep" inversion exists only to defend the extractor's prior. With no prior, there
is nothing to defend.

## Q2 — how the per-type lookups handle an untyped mention

> Validated by Finding 6: the two-mask design below is what the experiment implemented, and with the sport given
> it types names at 98.7-99.2% versus the extractor's 97.6-98.1%. This is the one half of the proposal that
> measured better — by 2-4 mentions per 250.

They stay, and become candidate **generators** behind one `groundMention(text, roleMask)`. The role supplies a
mask over generators:

```
role: plays / wins / scores / owns-a-market   ->  team ∪ player
role: in / at / where / league-modifier       ->  competition ∪ region
```

Three properties of the existing code make this cheap:

- **Individual sports already collapse team and player** — players are mirrored into the team indexes at
  [scope-catalog.ts:165-174](src/resolver/scope-catalog.ts:165), so tennis, darts, chess, snooker, F1 and the
  rest need no type decision at all.
- **Region and competition already share an id space** — "Italy" grounds to the same id as both branch and group.
- **The masks must be soft, not hard** — a preference tried first, falling back to the full type space when it
  returns empty or weak. "Cincinnati matches on now" is grammatically a modifier on an event noun (→ circumstance
  mask → tennis tournament) when the truth may be the Reds. Softness is idiomatic here: it is the same edge
  ladder `propagate` already uses.

**The real cost in this area is score comparability, and it is the most under-priced item in the plan.** Each
grounder is tiered on its own calibration — competitions on `COVER_FLOOR` / `SHORTLIST_FLOOR` over IDF mass, teams
on exact-name then token-subset, players on full → surname → first-name fallbacks. Those tiers are not
commensurable, and merging candidate sets makes a `confident` team compete with an `ambiguous` competition. What
is needed is one strength ladder across types —

```
exact-full-name > alias-exact > unique-token-subset > partial-cover > surname/first-name fallback
```

— with type used only as a tiebreak via links and liveness, not via the current per-type tier vocabulary.

## Q3 — performance

Answered by Finding 4: a boot cost of 379 ms / ~160 MB, and single-digit milliseconds per query once the
`groundTeam` token-subset scan is indexed. Not a reason to avoid the design.

---

## Risks and open questions

> Risks 1, 2 and 5 only apply to the parts Finding 6 recommends **dropping** (deriving the sport, clarifying on
> ambiguity, fanning candidates across sports). They are kept here as the record of why that path is expensive as
> well as less accurate. Risks 3 and 4 still apply to the optional type derivation.

1. **Clarify ranking wants liveness, and grounding has none.** A good clarification is short and ranked
   ("baseball, the NFL, or the tennis tournament?"). Ranking needs to know what is actually running — but recall
   happens *after* grounding by design. Offering a tennis tournament that isn't on is a worse answer than
   today's silent baseball guess. Either add a cheap cached "what's live per sport" signal or ship unranked
   clarifies, but decide it deliberately. **This is the one place the plan needs a new capability rather than a
   rearrangement.**
2. **Eval discontinuity.** 289 corpus rows + 14 seed rows encode typed slots per leg
   ([gold-record.ts:123-132](src/eval/gold-record.ts:123)). The very first corpus row is the Cincinnati case,
   with `sport: ["tennis","baseball","american-football","football"]` and `competition: {accept:["Cincinnati"]}` —
   the gold set already concedes sport is undecidable from language, and already makes a type claim the extractor
   is about to stop making. **Recommendation: do not re-author the corpus — grade the projection.** Move the
   scope/type axis to the grounder gate, where the `accept` text still matches mention text. Otherwise the system
   and the measurement change in the same step and no movement can be attributed.
3. **Score comparability across types** (Q2 above).
4. **Nomination pollution** — `virtual-sports`, `z-sports`, `esports-basketball`, trotting's mirrored teams
   (Finding 5).
5. **Candidate cap across sports.** `TOP_K = 5` is currently per entity within one sport; fanning across 41
   sports needs a ranking policy before the cap, or the entity LLM sees five candidates from the wrong sports.

## Recommended sequencing (revised after Finding 6)

Ordered by measured yield per unit of work. The original plan — build the typeless front end and the
sport-hypothesis layer first — is **dropped**: the experiment says that layer loses 35 points of sport accuracy.

**1. Fix the language rules.** `binding` 0/9, `multi-leg` 4/18, `score-combo` 3/13, `margin-market` 1/8,
`named-over-side` 3/10, `price-fractional` 8/19. This is where the failures actually are, and it is Phase 6 of
[extractor-rebuild-plan.md](planning/extractor-rebuild-plan.md), unchanged.

**2. Fix the catalogue gaps.** ~9 of the 21 wrong-sport rows are unreachable by any pipeline design: darts,
table-tennis, horse-racing, motorsports, cricket's CPL, and "Mexican League". Offline, free, and it is the only
thing that moves them. Tracked in that plan's Phase 7.

**3. Add `sport_hint` from market vocabulary** — nullable, no authority, fed only by market words ("set betting",
"total games", "three-pointers"). Worth ~2 rows directly, and it is the tiebreak any future ambiguity handling
would need.

**4. Audit `recoverSport` rather than finishing it.** It switches 6-8 rows per sweep and at least one of those
switches is harmful (`Crvena Zvezda vs Bayern Munich` → football). Measure whether it is net positive at all
before extending it. Do **not** adopt the "competitions as anchors + 2-home clarify" extension: measured at
89.8-90.2%, below today, with clarifications that land on rows already answered correctly.

**5. Optional, low priority — adopt the type derivation** if the grounder is being touched anyway. Keep
`ResolvedLegScope` as the output contract, ground the two role masks, project back. Worth +0.8 to +1.6 points on
name typing. Not worth a dedicated project.

**Not recommended:** removing `sport` from the extractor; building the sport-hypothesis layer; letting the
catalogue override or challenge the extractor's sport.

**The one open question the offline probe cannot answer:** does a prompt that no longer carries the data rules do
the *language* job better? Findings 1-3 argue the rules fight each other; nothing here measures the benefit of
removing them. Testing it costs a rewritten prompt plus ~$0.30 for a 289-row sweep, scored against the same gold.
That is the next experiment if the role split is still wanted.

## Relationship to extractor-rebuild-plan.md

- **Reinforces** that plan's Phase 6: the language rules are where the measured failures are, and its
  `competition` / league-modifier bullet is vindicated (`league-modifier` 44/69, `competition` failing 19 rows,
  and arm C shows the catalogue recovers only ~2 of them).
- **Raises the priority of its Phase 7 catalogue items** (darts, table-tennis, the 404 sports) from follow-up to
  blocker: they cap the achievable sport accuracy no matter what the extractor does.
- **Leaves intact** its Phase 1 (eval net), Phase 2 (offering sweep) and Phase 3 (schema gaps: line range,
  `line_sort`, `combined_odds`).
- **Withdraws** this document's earlier recommendation to reorder the phases and land a grounder change first.

---

## Reproduction

All measurements are read-only and free (no LLM, no Kambi).

```bash
# catalog inventory
node -e 'const fs=require("fs"),p=require("path");let g=0,t=0,pl=0,b=0;
for(const f of fs.readdirSync("catalogData").filter(f=>f.endsWith("-scope-index.json"))){
const j=JSON.parse(fs.readFileSync(p.join("catalogData",f),"utf8"));
g+=(j.groups||[]).length;t+=(j.teams||[]).length;pl+=(j.players||[]).length;b+=(j.branches||[]).length;}
console.log({groups:g,teams:t,players:pl,branches:b});'

# cold load of every catalog + per-grounder cost per mention across all sports
npx tsx -e 'import { loadScopeCatalog } from "./src/resolver/scope-catalog";
import { groundTeam, groundPlayer, groundCompetition, groundRegion } from "./src/resolver/ground-scope";
import { builtSports } from "./src/resolver/sports";
const s = builtSports(); const t0 = Date.now(); for (const x of s) loadScopeCatalog(x);
console.log("cold ms", Date.now()-t0, "heap MB", Math.round(process.memoryUsage().heapUsed/1e6));
const cats = s.map(loadScopeCatalog);
const bench = (l: string, fn: (c: any) => void, n = 20) => { const t = Date.now();
  for (let i=0;i<n;i++) for (const c of cats) fn(c); console.log(l, ((Date.now()-t)/n).toFixed(2), "ms"); };
bench("team", (c)=>groundTeam("Cincinnati", c)); bench("player", (c)=>groundPlayer("Cincinnati", c));
bench("comp", (c)=>groundCompetition("Cincinnati", c)); bench("region", (c)=>groundRegion("Cincinnati", c));'
```

The name-space census (178,544 / 3,300 / 2,446 and the exact-match traps) comes from building a folded
`name -> [{sport, kind, id}]` map over all four entity classes in every `catalogData/*-scope-index.json` and
counting keys whose value spans more than one sport.

The Finding 6 A/B — also free, ~10 s, no API calls (it replays captured extractions):

```bash
# the three arms, across every captured sweep
npx tsx scripts/probe-role-split.ts .sweep/gold-extract.jsonl .sweep/gold-qwen-v2.jsonl .sweep/gold-qwen-v3.jsonl

# the 21 wrong-sport rows, each with what every catalogue knows about its names
npx tsx scripts/probe-role-split.ts --wrong .sweep/gold-extract.jsonl

# per-row disagreements between the arms, plus arm B's wrong-pick patterns
npx tsx scripts/probe-role-split.ts --diffs .sweep/gold-extract.jsonl

# the language axis, official scorer, same captures, no model call
npx tsx src/eval/run.ts --from .sweep/gold-qwen-v3.jsonl
```

Note: `tsx` needs a temp IPC pipe, so these must run outside a filesystem sandbox.

## Critical files

Ordered by the revised sequencing — the first three are the recommended work, the rest only apply if the
(optional) type derivation is adopted.

```
src/resolver/extractor-prompt.md      1. the language rules: binding, multi-leg, score combos, margins, prices
catalogData/*-scope-index.json        2. the catalogue gaps that cap sport accuracy (darts, table-tennis, ...)
scripts/fetch-participants.ts         2. how those gaps get filled (darts is sourced from betoffers)
src/resolver/schema.ts                3. add `sport_hint` (nullable, market-vocabulary only, no authority)
src/resolver/recover-sport.ts         4. AUDIT, do not extend — one of its switches is measurably harmful
scripts/probe-role-split.ts           the Finding 6 A/B harness (offline, replays .sweep captures)
src/resolver/scope-catalog.ts         cache team name tokens at load (the 25 ms groundTeam scan)
src/resolver/ground-scope.ts          5. optional: the two role masks + projection back to ResolvedLegScope
src/resolver/resolve-entities.ts      5. optional: mixed-type candidate labelling in the entity cells
```
