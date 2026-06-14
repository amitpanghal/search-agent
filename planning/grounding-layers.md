# Grounding: what happens after extraction

This walks through everything the grounder does **after** the extractor has turned a
query into a plan. The extractor gives us, per selector (per "leg"):

- a **market concept** — free text, e.g. `"total goals"`, `"to score a brace"`
- a **subject kind** — `player`, `team`, `either_match_team`, or `event`
- a **line** (optional) — e.g. over/under 2.5
- a **period** (optional) — `full`, `first_half`, `second_half`, `extra_time`
- a **level** (optional) — `fixture` (one match) or `competition` (a tournament)

The grounder's job: turn that free-text concept into real **catalog criterion id(s)**.
It never forces a single guess — it returns one of several **tiers** so the executor
knows how much to trust the answer.

Code: `src/resolver/ground-market.ts` (the whole pipeline), `src/resolver/catalog.ts`
(the data it reads).

---

## The four trust tiers (the output)

Every grounding ends in one of these. This is the most important idea — the grounder
prefers to **abstain or ask** over guessing wrong.

| Tier | Meaning | Example |
|------|---------|---------|
| **confident** | One clear winner. Trust it. | `"to win"` → `Match Odds` |
| **variants** | Several ids that are the *same* market split into pieces (return them all). | `"total goals"` for one team → `Total Goals by Home Team` + `Total Goals by Away Team` |
| **ambiguous** | Two *different* markets are basically tied. Executor must ask the user. | a query that scores `Corners` and `Cards` within a hair of each other |
| **shortlist** | Nothing was strong enough to be confident, but a few candidates are plausible. Hand them over to clarify. | a weak `"match result"` returning the top 3 guesses |

And two non-results:

- **none** — nothing cleared the floor. A genuine "I don't know" (abstain).
- **main** — the query named no market at all; the executor uses the event's headline bet.

---

## The pipeline, in order

The concept runs through these stages. **The first stage that produces a hit wins** —
later stages only run if earlier ones miss. (Function: `resolveMarket`.)

```
  pre-clean  →  Stage 0  →  Stage 1  →  Stage 2  →  Stage 3  →  Stage 4  →  post-step
  (normalize)   (sentinels) (exact alias) (exact name) (subset alias) (vector)  (per-side divert)
```

### Pre-clean (always runs first)

Three text fixes before anything is matched:

1. **Fold in the period.** The period lives in a separate field, but the catalog bakes it
   into the *name* (`"Correct Score - 2nd Half"`). So we append the period words to the text.
   - `"correct score"` + period `second_half` → `"correct score second half"`
   - If period is `full` or missing → no change.

2. **Expand acronyms.** Betting shorthand embeds to noise, so we spell it out (from a
   curated list, `aliases.json`).
   - `"second-half BTTS"` → `"second half both teams to score"`

3. **Normalize.** Lowercase, strip punctuation, etc., so matching is consistent.

### Stage 0 — sentinels (the easy exits)

- **If the cleaned key is empty** → return **none**.
- **If the key is `"main"`** → return **main**. (The extractor emits `"main"` when the query
  names no market, e.g. *"Brazil vs Argentina"* with no bet named. We never vector-search the
  literal word "main" into junk.)

### Stage 1 — exact alias fast-path

A curated alias table (`aliases.json` / `derived-aliases.json`) maps whole phrases to ids.
**Only an exact, whole-key match fires here.**

- `"to win"` → alias → `Match Odds` → **confident**

**The level catch (decision 23):** some aliases are scoped to a level. `"to win"` aliases to
`Match Odds` **only for a fixture**. For a *competition* ("to win the World Cup"), the alias is
skipped and it falls through to the vector path (so it can reach the tournament-outright market
instead of the match-winner market).

- `"to win"` + level `fixture` → `Match Odds` (alias fires)
- `"to win"` + level `competition` → alias skipped → falls through

If the alias resolves to >1 id → **variants**, else → **confident**.

### Stage 2 — exact catalog name match

Match the text against the catalog's **own market names**. This is tried in layers, loosest
last:

1. **Bare text** as-is.
2. **Player registers** (only if subject is `player`): the catalog writes player generics two
   ways, `"Player X"` and `"Player's X"`. So `"fouls won"` is also tried as `"player fouls won"`
   and `"player s fouls won"`.
3. **Settlement-suffix stripped**: some markets only exist as `"... (Settled using Opta data)"`.
   We strip that parenthetical so `"to score or assist"` can reach
   `"To Score Or Assist (Settled using Opta data)"`.

**Bare-first is deliberate:** a prop named `"to score"` matches its own name before we try
gluing `"player"` in front of it.

**Why this sits ABOVE the next stage (decision 25):** a long market that is literally its own
catalog entry must ground to itself. `"Match to go into Extra Time"` is a real market name — it
must win here, and never be shadowed by the shorter subset alias `"extra time" → "Extra Time"`
that would otherwise grab it in Stage 3.

Hit → **variants** if >1 id, else **confident**.

### Stage 3 — subset-alias fallback

Now we allow a *looser* alias: the most-specific alias whose **every key-token appears in the
concept**.

- `"to score a brace"` → contains the token `"brace"` → alias `"brace"` fires
- If several aliases match, the one with the **most key-tokens wins** (most specific).

Guards:
- **Single-token keys match the exact token only** — `"brace"` matches `"brace"` but not
  `"braces"` — so distinctive curated keys can't over-fire.
- **Level-scoped aliases are skipped here** (exact-only). This stops `"to win"` from
  subset-stealing `"to win to nil"` — the latter must reach the per-side Win-to-Nil divert,
  not get hijacked to `Match Odds`.

Hit → **variants** / **confident**.

### Stage 4 — the vector tail (the smart fallback)

If nothing above matched, we fall back to embeddings. This is the multi-step core
(function `vectorGround`). Steps:

#### 4a. Subject pre-filter (the load-bearing cut)

Restrict candidates to the query subject's **bucket** before scoring anything:

- `player` subject → only player markets
- `team` / `either_match_team` → only team/match markets
- `event` / no hint → **both buckets** (an "event" outcome could be a team market like
  `Winner` *or* a player award like `Golden Ball Winner`)

So a **player** query *never* sees team/match markets, and vice-versa. This single cut
prevents most cross-category mistakes.

#### 4b. Cosine score + a lexical bonus

- **Cosine**: embed the query, score every candidate name in the bucket by meaning-similarity.
- **Lexical bonus**: raw cosine under-weights *exact word matches*, so we add a small bonus
  (up to `LEX_WEIGHT = 0.1`) for candidates whose name literally contains the query's content
  words. The overlap is **IDF-weighted** — a rare word like `"stoppage"` (in 15 names) counts
  far more than a common one like `"team"` (in 557 names).
  - `"goal in stoppage time"` ⊆ `"Goal scored - Stoppage Time"`: cosine alone stalls below
    threshold, the bonus lifts it over.
  - **The bonus only ADDS** — it can promote a near-miss, never demote a confident hit, and it's
    bounded so a full-word-match false friend at low cosine still can't fake a confident.

- **BM25 channel** (runs alongside): a sparse rare-word retriever nominates the top lexical
  names into the pool, surfacing a true market whose cosine ranked it below the candidate cut.
  - `"to score first"` → `"Team to score First Goal in respective match"` (cosine < 0.25, missed
    by cosine, rescued by BM25).
  - **But a BM25 nominee can reach at most `shortlist`** — its cold cosine keeps it under the
    confident threshold. So this extra recall can **never mint a false confident**.

> Note: six older post-cosine layers (specificity, scope, yes/no tie-break, period penalty,
> line-gate, period-collapse) were **deleted on 2026-06-11**. An ablation over 346 queries showed
> all six were net-harmful or did nothing; dropping them gained +8 recall at flat precision.
> Ranking is now **cosine + lexical bonus only**.

#### 4c. Who gets to be a candidate at all (the entry gate)

A candidate enters scoring if **either**:
- its raw cosine is warm (`raw ≥ FLOOR − LEX_WEIGHT`, i.e. ≥ 0.25), **OR**
- it's a BM25 nominee.

Then it survives only if **either**:
- its gate score (cosine + bonus) `≥ FLOOR` (0.35), **OR**
- it's a BM25 nominee that covers `≥ LEX_COVER_FLOOR` (0.8) of the query's IDF word-mass — a
  strong literal match worth clarifying.
  - This 0.8 bar is why a crossbar market whose boilerplate `"(which does not result in a goal)"`
    matches only `"result"` for query `"match result"` (cover 0.70) is **excluded** — letting the
    real `Match Odds` cosine keep the shortlist.

If nothing survives → **none**.

#### 4d. Tiering — the final if/else

Now decide the tier from the survivors:

- **No survivor cleared THRESHOLD (0.55)?** → **shortlist** (top 3). Ordering inside the
  shortlist:
  - **Strong lexical rescues lead** (cover ≥ 0.8). Within that group, order by **BM25** (most
    exact name first) — because a strong lexical group is a collision where cosine is unreliable
    (`"to score first"` hits ~8 score-first markets all at cover 1.0).
  - The non-strong group has no real lexical signal (`"match result"`), so order by
    **cosine** (`adj`). This keeps `Match Odds` atop its shortlist while letting the
    score-first family lead theirs.

- **At least one cleared THRESHOLD?** Take the top one and look at its **stat-core** (the market
  name stripped of subject markers, home/away polarity, and settlement suffix — so a market and
  its home/away twins share a core, but a full-match vs a 1st-half twin stay distinct):

  - **A *different*-core rival is within EPSILON (0.03) of the top** → **ambiguous**. Two
    genuinely different markets are tied → return the tied cluster and let the executor ask.
    *Don't guess.*

  - **Otherwise** → collect everyone sharing the top's core **and** at least one shared category
    (the shared-category check guards against an accidental core-string collision merging two
    real different markets):
    - more than one id → **variants** (this is how the home/away side-split comes out)
    - exactly one id → **confident**

### Post-step — named-team per-side divert

After whatever the above returned, **for a `team` or `either_match_team` subject only**, one more
adjustment (function `applyPerSideDivert`). A query naming **one** team wants the side-specific
market.

- **(a) Swap:** the result is a single, clean **match-level** market that *has* per-side twins
  → swap it for the twins.
  - `"Arsenal total goals"` lands on match-level `Total Goals` → swapped to
    `Total Goals by Home Team` + `Total Goals by Away Team` → **variants**.
  - **Not applied** to a low-confidence shortlist (we don't promote a weak guess).

- **(b) Direct:** the result was **none**, but the concept exists *only* per-side, with no
  match-level sibling to land on → match its core straight against the per-side index.
  - `"Brazil to win to nil"` → no match-level `Win to Nil` exists → reach the per-side
    `Win to Nil` twins directly.

- **No twins?** → left unchanged.
  - `"Arsenal to win"` → `Winner` has no per-side twins → stays `Winner`. (We never drop a real
    match-level team market.)

---

## Combined markets (Sprint 7) — a separate additive pass

The extractor splits `"X and Y"` into two separate legs, so a single combined catalog row
(`"Home Team to Win and Both Teams To Score"`) is never reached by per-leg grounding. A separate
pass (`assembleCombos`) re-surfaces it. It runs **alongside** the per-leg results — it adds,
never replaces.

Rules:

- **Only for ≥2 legs.** A 1-leg query that *is* a combo grounds normally through the name/vector
  path.
- **Only the ever-offered combos** are eligible (~5 of 293 combo rows; the rest are dead legacy
  tail, filtered by the offer registry).
- A combo surfaces only if its **side-stripped core words are near-fully covered** (≥ 0.8 IDF
  cover) by the **union of the leg concepts**.
  - `["home team to win", "both teams to score"]` covers `"Win and BTTS"` → surfaced.
  - A lone `"both teams to score"` can't covet `"Win and BTTS"` — the `"win"` words are missing.
- **Negated legs are dropped from the pool.** `"no draw and both teams score"` won't match
  `"Draw and BTTS"` on the bare token `"draw"` — token cover is blind to polarity, and this is
  the one principled exception.
- Per-side combos return their home/away twin pair as **variants**.

---

## The knobs (all in `ground-market.ts`)

| Knob | Value | What it does |
|------|-------|--------------|
| `THRESHOLD` | 0.55 | Gate score must clear this to be **confident**. |
| `EPSILON` | 0.03 | A different-core rival this close to the top → **ambiguous**. |
| `FLOOR` | 0.35 | Below this, abstain (**none**); in `[FLOOR, THRESHOLD)` → **shortlist**. |
| `LEX_WEIGHT` | 0.1 | Max size of the lexical bonus (cosine units). |
| `LEX_COVER_FLOOR` | 0.8 | IDF-cover bar for a BM25 rescue / a combo to count. |
| `TOP_K` | 8 | Candidate / BM25 nominee pool size. |
| `SHORTLIST_CAP` | 3 | Max ids returned in a shortlist. |
| `BM25_K1` / `BM25_B` | 1.5 / 0.75 | Standard BM25 saturation / length-norm knobs. |

**Design bias throughout:** every uncertain branch fails *safe* — it abstains (`none`) or
over-clarifies (`ambiguous` / `shortlist`) rather than guessing a single wrong id.
