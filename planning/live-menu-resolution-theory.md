# Live-Menu Resolution — approach & decisions

> **Status:** core resolve + select validated by probes (June 2026); the entity gate is ~80% already in code.
> Not yet wired as one pipeline.
> **One line:** resolve every named entity to an id *first*, fetch by those ids, then let the LLM pick the
> market from the **live list the feed actually returned** (labelling it exact / close / none), and pull the
> line + subject deterministically from the real outcomes.

---

## 1. Core idea

The market is **not** needed to decide which API to call. Which endpoint and which ids to fetch is driven
entirely by *entities* — team, player, group, competition — plus a **coarse grain** (match market vs
competition market). The market is only ever a **filter on the response**.

So we defer the market decision until *after* the fetch and make it against the live data:

> **Resolve where the knowledge lives. Decide the market against the live menu, not a guess.**

The product surfaces two things, and the design serves both:

1. **The answer** — the market that exactly settles the user's bet.
2. **Suggestions** — close markets, when the exact one isn't offered.

That second output is why a "closest market" is a useful result, not a failure — *as long as the system
knows it's a suggestion and says so.*

The one thing we **don't** defer is the **entity**: it picks *which data we fetch at all*, so it must be
resolved to a concrete id before recall (see §3).

---

## 2. The pipeline

```
1.  EXTRACT           query -> entity mentions + coarse grain + per-leg market phrase + line/outcome constraints
1.5 RESOLVE ENTITIES  resolve every NAMED entity (competition -> team/player) to ids BEFORE recall; clarify on collision
2.  RECALL            fetch by the resolved ENTITY ids, from the richest source for the grain
3.  FILTER            deterministically keep only markets that price the subject
4.  RESOLVE (market)  LLM picks the market from the live menu and labels it: exact | close | none
5.  SELECT            deterministically pick the outcome — line, subject, relational role — against real outcomes
```

**1. Extract** — reliable about *entity mentions* and a *coarse grain*. It does **not** need to nail the exact
market (stage 4) or bind the line to a market (stage 5); it carries the market phrase and the line value +
direction as-is.

**1.5 Resolve entities** — a hard gate: every named entity becomes a concrete id before we fetch (§3).

**2. Recall** — the API call is **deterministic** from the resolved entity ids and grain (e.g. a player's
team-id + player-id, or a competition's group-id). Recall the union in one call where the endpoint allows it,
so we never need the exact criterion to choose what to fetch. If the feed genuinely returns no market that
maps to the query, the honest path is **clarify** (stage 4, `none`), never a silent swap.

**3. Filter (deterministic)** — keep only markets that actually price the subject; drop the rest **before** the
LLM sees them. A code-level set operation, not an LLM judgement. It protects the model from noise and shrinks
the payload for free.

**4. Resolve (LLM)** — give the model the user query + the **filtered live menu** (labels only); it returns a
**pick** at `(criterion + variant)` granularity plus a **match label** `exact | close | none` (§4).

**5. Select (deterministic)** — once the market is picked, pull the outcome mechanically: the line, the
subject's outcome, the relational role. All matched against the market's **real outcomes** — never asserted
blind (§5).

---

## 3. Entity resolution (the pre-recall gate)

**Decision: every NAMED entity is resolved to an id before recall.** Recall runs only on a fully-resolved
set; when a name is genuinely ambiguous we **clarify first**, never fetch on a guess. This is the one place the
"defer until we see the data" philosophy does *not* apply — the competition entity decides *which* dataset we
fetch, so it can't be settled against a menu we haven't pulled yet.

*Why it matters (worked example):* "Give me World Cup group winner odds" — the feed holds several "World Cup"
groups (men's 2026, Women's, U-20, Club…). Pick the wrong group id and *everything* downstream is wrong. So the
competition must resolve up front.

**Entities resolve in dependency order — competition scopes the rest.**

```
competition (confident) ──▶ scopes the team / player candidate pool to that tournament
confident team           ──▶ further scopes the player pool (the homonym cut)
```

*Worked example* — "World Cup group winner odds for England, and Kane to be top scorer":
1. **Competition:** "World Cup" → WC26 group id (deterministic: active + canonical).
2. **Team:** "England" → matched within WC26's 45 teams → one candidate.
3. **Player:** "Kane" → matched within the England squad → one candidate (no other "Kane" to confuse it with).
   Scoping to the competition collapses most same-name collisions for free.

**The resolution ladder:** live candidate set → context narrows (type team-vs-player, competition, role) →
**clarify** on genuine residual ambiguity; a name that matches nothing is an honest "not in this competition".
Deterministic lexical mapping handles the common case (active/recency, canonical default, qualifier keywords);
the LLM disambiguator fires **only on a true collision**. Ambiguity is rare in practice — competition and team
names almost never collide; player *surnames* collide heavily, but the dependency scoping above resolves them.

**Named vs relational — a boundary that keeps the gate clean.** "Home team", "the favourite", "the underdog",
and *which fixture* are **not** named entities — they're roles filled by data we don't have until we fetch. So:
- **Named entities** (competition / team / player / group) → resolved *before* recall, at this gate.
- **Relational roles + fixture selection** → bound from the fetched data at SELECT (home/away from the fixture,
  "favourite" = lowest price).

**The disambiguator's role changes accordingly.** It stops being a *rewrite/patch* layer — its old license to
change the line and subject "if it sees fit" is **removed**. Market ambiguity moves to RESOLVE (stage 4),
line/subject to SELECT (stage 5); the disambiguator's only remaining jobs are **entity-collision clarify** and
the resolver's **`none` → clarify**.

**Status — mostly already built.** `groundScope` is the deterministic, tier'd grounder with exactly this
dependency cascade; `disambiguate.ts` is the two-pass LLM layer (pick / reexpress / clarify) that already runs
*before* planFetch and only touches doubtful tiers. The redesign work here is **subtractive**: keep the entity
half, delete the market half (including the line/subject rewriter `applyCorrection`). Plan:
[entity-disambiguator-trim-plan.md](entity-disambiguator-trim-plan.md). Keeping the build-time
`scope-index.json` fresh against the live feed is a tracked side concern.

---

## 4. The resolver contract (the heart of the market step)

The whole safety of the market step rests on one thing: the resolver knowing **which of the three it's giving**.

| Label | Meaning | Example | What the app does |
|---|---|---|---|
| `exact` | settles the bet | "Spain to win the trophy" → `Finishing Position — Winner` | shows it as the answer |
| `close` | same direction, not exact | "Japan eliminated in QF" (no stage market) → a related stage market | shows it under **Suggestions**, labelled |
| `none` | nothing maps | a market the feed simply doesn't carry | clarifies; shows the menu as evidence |

The menu unit is `(criterion + variant)`: `Finishing Position — Winner` and `Finishing Position — Top 4` are
two different items, because the variant is part of the market's identity.

Two guards that make `close` honest:

- A suggestion must be in the **right direction**. "Top 8" means a team *reached* the QF — the opposite of
  being knocked out there. If the only near market is an opposite bet, the answer is `none`, not a misleading
  suggestion.
- The model can always choose `none`. It is never forced to pick.

---

## 5. Line & subject — the SELECT step

**Decision: line and subject are deterministic lookups against the picked market's real outcomes — not
pre-commitments.** This kills the old failure mode where the extractor bound a line to the wrong market and the
disambiguator was let rewrite line/subject. Nothing is committed before the data, so there is nothing to
rewrite; a wrong line/subject degrades to an honest fallback, not a confident wrong result.

**Where the line lives:** on the outcome (`o.line`, with direction in the label — `Over`/`Under`/`Yes`). The
set of offered lines for a market is just the outcomes that exist. The extractor supplies only the **value +
direction**, never a market binding. "Over 2.5 goals" → pick the goals market (stage 4) → select the `Over`
outcome at line `2.5` from the real offered lines.

**Where the subject lives — three deterministic places:**
1. The outcome `participant` (player props, handicap: `Ricardo Pepi`, `Turkey`).
2. The **market label itself** — a per-team variant (`Total Goals by USA` vs `Total Goals by Turkey`). Here
   picking the right variant *is* picking the subject.
3. The fixture's **home / away** (1X2 `Full Time`, relational subjects).

**Two honest fallbacks (the same `close`/`none` discipline as the market layer):**
- **Line not offered → nearest line as a suggestion** (offered `[0.5…6.5]`, asked `2.25` → suggest `2.5`).
- **Subject absent → honest "not offered for this subject"** (a player not in this fixture), never a wrong pick.

Worked examples (validated live, zero LLM):

| Phrase | Resolves via |
|---|---|
| "under 4.5 total goals" | line on outcome → exact |
| "over 2.25 total goals" | line not offered → nearest `2.5` suggestion |
| "USA over 0.5 goals" | subject in the market label (`Total Goals by USA`) |
| "Pepi over 2.5 shots" | subject = outcome participant + line |
| "Turkey -0.5 handicap" | subject + signed line on the outcome |
| "home team to win" | relational subject → 1X2 home outcome |
| "Messi over 2.5 shots" | subject not in fixture → honest not-offered |

Subject is still needed — for recall (coarse, match-grain only) and for select — but it is no longer a
committed filter a disambiguator patches. A name that doesn't match a real participant is **entity resolution**
(the §3 gate), not a SELECT bug.

---

## 6. Menu & payload handling

The cost lever is **payload**: pass the LLM the fewest, most relevant labels. (Fetch cost is not a concern;
latency tuning comes later — showing the correct market is the priority.)

1. **Subject/coverage filter first (deterministic, zero risk).** Drop every market that doesn't price the
   subject. This is the biggest cut and it can't drop the right answer.
2. **Send labels only** — `id/ref + label (+ variant)`. No odds, outcomes, or betoffer metadata. A ~100-item
   match menu is only a few hundred tokens this way, so it may need no further pruning. **Measure before
   pruning more.**
3. **If still too big, let the LLM prune in the same call — never pre-cut in code by query words.** Hand it
   the feed's category headers with the markets under them; the model ignoring "Corners" costs nothing and
   can't accidentally drop the right market. Always keep the core result/goals categories unconditionally —
   that's where non-lexical maps live (e.g. "home team to win" = "Full Time").

**Never cosine-prefilter the live menu.** Cosine buries exactly the non-lexical maps this design exists to
rescue — "Full Time" shares no words with "home team to win" and ranks far down. If pruning is ever needed,
prune *structurally* (above), never by embedding score.

Worked example — "home team to win" at match grain:
- Subject filter → keep only markets pricing the home team (~100 → ~40).
- Labels-only → ~40 labels ≈ a few hundred tokens. Send them all. "Full Time" survives because nothing was
  cut by word.
- Do **not** guess "this is a result query" and drop the Goals category — "home team to win to nil" needs it.

---

## 7. Failure classes this design handles

| Failure | How this design handles it |
|---|---|
| Wrong criterion twin ("win the World Cup" → a dead twin instead of live "Finishing Position") | the dead twin isn't in the live menu; the model can only pick from what's offered |
| Confusable names / non-lexical maps ("home team to win" = 1X2 "Full Time") | the LLM reads real labels in context; resolve at `(criterion + variant)` granularity |
| Wrong competition ("World Cup" → the wrong edition) | resolved at the §3 gate before recall; clarify on collision |
| Wrong line on the wrong market | the line never binds to a market early — it's selected from real offered lines (§5) |
| Market simply not offered | `none` → honest clarify, with the live menu as evidence |
| Subject not covered (a team absent from a market) | the deterministic filter drops markets that don't price the subject |
| Exact market/line absent, but a near one exists | `close` / nearest-line → surfaced as a labelled suggestion, never as the answer |

---

## 8. Design rules (carry forward)

1. **Resolve every named entity to an id before recall;** clarify on genuine collision, never fetch on a guess.
2. **Entities resolve in dependency order** (competition → team/player); relational roles (home/away/favourite)
   bind from data at SELECT, not at the gate.
3. **Recall deterministically from the entity ids + grain, in one union call** where possible.
4. **Menu unit = `(criterion + variant)`.** Variants are distinct markets ("Winner" vs "Top 4").
5. **Subject/coverage filtering is deterministic and runs before the LLM.** Never ask the model to reason
   about coverage.
6. **Don't feed outcomes to the LLM for market selection.** It picks from labels; outcomes are a downstream
   deterministic step.
7. **The resolver always labels its pick `exact | close | none`** and may always choose `none`.
8. **A suggestion (`close`) must be same-direction**, or it's `none`.
9. **Line and subject are deterministic SELECT lookups against real outcomes** — never a pre-bound filter, and
   the disambiguator never rewrites them.
10. **Never cosine-prefilter the live menu;** prune only structurally, never by query words.
11. **Send labels, not full offer objects.**

---

## 9. What the probes showed (evidence)

Run end-to-end against the live feed with a small model (Haiku) as the resolver.

1. **Recall-then-resolve fixes the non-lexical map.** "Both teams to score… and home team to win." Handing the
   model the *whole* live match menu → it picked **Both Teams To Score** and **Full Time** (the 1X2) correctly.
2. **A cosine pre-filter BREAKS it.** Ranking the menu by cosine and passing top-k: "Full Time" ranked outside
   the top 10 of ~99 and got cut → the model fell back to **Double Chance** (wrong).
3. **Variants must be in the menu.** "Spain in top 4" only resolved once the menu carried the variant
   (`Finishing Position — Top 4`); with the criterion alone the model picked the winner market.
4. **Resolver-contract stacked deck** (`scripts/.contract-probe.ts`, ~18 runs over the live WC26 feed):
   **confident-wrong ≈ 1 in 180 case-evaluations** — the danger metric is effectively clean, and never fired on
   the variant / twin / subject-filter / non-lexical cases. The residual instability is the **abstain boundary**
   (`none ↔ close` wobble), dominated by the opposite-direction Japan case (it sometimes offers `Top 4` as a
   `close` suggestion instead of `none`). When it errs it errs *safe* (a labelled suggestion), never a confident
   wrong answer.
5. **SELECT (line + subject)** (`scripts/.select-probe.ts`, live fixture, **zero LLM**): every path resolved
   deterministically — line offered → exact; line absent → nearest suggestion; subject in participant / in the
   market label / via home-away; subject absent → honest not-offered; handicap signed line.

---

## 10. Open work (before / during build)

1. **Inverse-direction guard (closes the one residual risk).** Add a deterministic check on any `close` pick:
   if the candidate settles the *opposite* outcome of what was asked (eliminated-at-stage vs reached-stage),
   force `none`. This targets the Japan `none ↔ close` wobble without a bigger model. *(Resolver contract itself
   is now measured — item 4 above.)*
2. **Coverage audit for the filter.** Partly validated by the SELECT probe (subject reliably sits in
   participant / market label / home-away). Remaining: confirm across *all* market types where the subject's
   name lives (structured field vs free-text outcome label), so the filter never over- or under-drops.
3. **Measure payload at match grain.** Confirm labels-only + subject filter is small enough that structural
   pruning isn't needed; only build pruning if the numbers say so.
4. **Trim the entity disambiguator** to entity-only (keep the loop, delete the market/rewrite half) — see
   [entity-disambiguator-trim-plan.md](entity-disambiguator-trim-plan.md).
5. **Entity index freshness.** Keep `scope-index.json` (the groups⋈participants snapshot the grounder reads)
   current against the live feed so the candidate set doesn't drift.

---

## 11. Out of scope (separate axes — don't expect the market/select steps to fix these)

- **Deep entity-resolution edge cases** beyond the §3 gate (a name that resolves to the wrong real person/team
  despite scoping) — still its own axis, but now homed in §3, not unhandled.
- **Time-window / "which fixture"** ("tonight", "next game") — entity + time, bound at recall/select.
- **Bracket / "half of the draw"** — needs external structure the feed doesn't carry.
- **Multi-subject fetch routing** (one leg's ids getting dropped) — a fetch-planning bug, orthogonal.
