You write a batch of realistic sports-betting **search queries** for an offline test rig. Each query is
paired with the ONE market (or markets) it must resolve to — its **gold**. Your output *is* the test's
answer key, so the pairing has to be airtight: a real user, reading your query cold, would look for
exactly that market and nothing else.

> Run by a **Sonnet** subagent (richer, more natural phrasing than Haiku). This is generation only — the
> rig's cache-miss fulfilment (extract / entities / markets) still uses **Haiku at temperature 0**, because
> that mirrors production. Don't confuse the two roles.

You are given REAL markets sampled from the live-feed snapshot. **Never invent an id or a market** — every
gold id must be one you were handed.

---

## Input you receive

A JSON array of candidate targets. For each:

```
{ "id": 1001159598, "label": "Total Corners by Turkey", "category": "Corners",
  "subject": "team", "scope": { "competition": "World Cup 2026", "teams": ["Turkey","USA"], "level": "fixture" },
  "siblings": ["Total Corners", "Total Corners by USA", "Total Corners - 1st Half", "Full Time", ...] }
```

- **`label`** is the market's official feed name — its *meaning* is your target, its *words* are off-limits (rule 1).
- **`siblings`** are the other markets offered on the same fixture / competition — **the field your query must
  out-point.** If your query could also match a sibling, it is broken.

---

## Output

One JSON object per line (**JSONL**) — no prose, no markdown fences. Shape (`BatchQuery`):

```
{"id":"q007","category":"multi-layer","q":"how many corners will Turkey get and total match goals","grade":{"targets":[[1001159598],[1001159926]]}}
```

- **`targets`** — an array of legs; each leg is an **any-of** list of acceptable criterion ids (usually one).
  A single-market query has one leg; a two-market query has two. A **pure-filter** query (no market named)
  uses `"targets": []`.
- Optional in `grade`: **`oddsMin`** / **`oddsMax`** (decimal price bound the *selected* outcome must respect —
  add only when the query states a price), **`timebound": true`** (the query carries a time scope; graded soft —
  the slate must be non-empty).
- `id` runs `q001`, `q002`, … in order. Pick `category` from the taxonomy below.

---

## Rule 1 — sound like a real user

Write the way people actually type into a search box, not the way a sportsbook labels a market.

- **Casual, short, abbreviated, sometimes vague.** Drop punctuation, use shorthand and nicknames ("WC26",
  "Türkiye", "the USMNT"), contractions, lowercase. Chatty is fine.
- **Vary the form** across lines — questions ("who wins …", "how many …"), imperatives ("show me …", "give me
  …"), bare fragments ("Turkey USA btts"). Never reuse a template back-to-back.
- **Don't copy the label's distinctive words.** Target the *meaning*: label "Total Corners" → "how many corners
  in the game", never "total corners". Reusing the name defeats the test.
- Natural, **not** cryptic — no riddles, no deliberately obscure wording.

Same meaning, many natural surfaces (all fine): `"who wins turkey usa"` · `"Turkey or USA who takes it"` ·
`"match result Turkey v USA"` · `"Türkiye USA outright"`.

## Rule 2 — the query must pin the gold UNIQUELY (against the siblings)

This is the whole point of the test. Reading your query cold, with the sibling list in front of you, there
must be **exactly one** market it points to — the gold.

- **Match the gold's GRANULARITY.** This is where golds break most often:
  - Whole-match gold (`Total Corners`) → generic phrasing: "how many corners in the match".
  - **Team-specific** gold (`Total Corners by Turkey`) → **name that team**: "how many corners will Turkey get".
  - Half-specific gold (`Total Goals - 1st Half`) → say the half: "first-half goals in Turkey USA".
  - Never write a generic query for a specific gold (it should resolve to the *broad* twin), or a specific
    query for a generic gold.
- **No market-vs-non-market ambiguity.** Don't phrase a market as a stat lookup, a live-score check, or an
  "is it on the schedule" question — those don't name a bettable outcome. Bad: *"what's the score"* (reads as a
  stat / the live scoreline / Correct Score / the result — none uniquely). For the result market write "who
  wins …"; for the scoreline write "… correct score" / "exact scoreline". Reserve bare-event wording ("their
  next game", "is it on") only for a query you intend to target the `main` event sentinel.
- **Numbers and prices are not market words** — an over/under is a `line` baked into the wording ("over 2.5
  corners"), a price goes to `oddsMin`/`oddsMax` ("priced above 1.8"), never into the market name.

## Rule 3 — self-check every line before you emit it

For each query, ask: *with the siblings in front of me, does this point to exactly one market, and is it the
gold?* If two readings fit, or it reads as a non-market, **rewrite or drop it**. When unsure, **add scope**
(team / half / competition / time) — specificity beats a broken gold. A slightly less casual but unambiguous
query is better than a natural but mis-pinned one.

---

## Categories (aim for a spread across the batch)

- `competition-level` — a tournament-wide outcome (outright winner, top scorer, an award). Gold is `competition`.
- `single-layer` — one market on one fixture.
- `multi-layer` — two markets on the **same** fixture (two legs).
- `mixed-event-player` — a player prop tied to a fixture (e.g. "X to score").
- `competition-plus-match` — one competition-level leg **and** one fixture leg in the same query (two legs).
- `filter-timebound` — scoped by time ("on Saturday", "next 48h"); set `timebound: true`. Often `targets: []`.
- `filter-odds` — carries a price bound; set `oddsMin` / `oddsMax`.

For a two-leg query, combine two of the targets you were given; the `targets` array lists both, in query order.

---

## Worked examples (✅ keep / ❌ fix)

| Gold (label) | ✅ natural & uniquely pinned | ❌ broken — why |
| --- | --- | --- |
| `1001159897` Total Corners (whole match) | "how many corners in Turkey USA" | "total corners" — copies the label |
| `1001159598` Total Corners **by Turkey** | "how many corners will Turkey get" | "corners in the match" — pins the *whole-match* twin, not this gold |
| `1001159858` Full Time (result) | "who wins Turkey USA" | "what's the score" — reads as a stat / scoreline, not the result |
| `1001642858` Both Teams To Score | "will both teams find the net, Turkey USA" | "btts" is fine too; "goals" alone is too vague (matches Total Goals) |
| `1001304945` Top Scorer (WC26) | "who finishes World Cup 2026 as leading scorer" | "top goal scorer" — copies the label |

---

## Boundaries

- Output **only** the JSONL lines. No commentary, no fences, no trailing text.
- Every gold id must come from the targets you were given — never invented, never guessed.
- A pure-filter query (names no market) is valid with `targets: []` — but most lines should name a market.
