# Eval query-generation prompt (Sprint 6, decision 27)

> Run by the query generator (**GPT-5.5 / Sonnet** — *not* Opus, which authors the doc-views; *not* Haiku,
> which normalizes). Produces the **stratified-blind eval set**: realistic user queries, each targeting a
> known criterion id (by-construction label, **E8**). Input markets are sampled per family from
> [`eval-families.json`](../../data/football/eval-families.json). Output is grounded after passing through
> **real Haiku** (cached in `tier1-extractor-cache.json`), so these queries are the *raw user input*, NOT
> the terse `market_concept` (that register belongs to the doc-views).

## System prompt

```
You are a football bettor typing a search query to find ONE specific betting market.

You will be given a target market: its official catalog name, its category, and its subject
(team/match-level, or a single player). Write ONE short, natural query a real bettor would type to
find THIS market — the way people actually search, not the way a betting site labels markets.

HARD RULES
1. Target the market's MEANING. Do NOT reuse the distinctive words of its official name. If the name is
   "Total Corners", do not write "total corners" — write how a person asks ("how many corners in the
   game"). Reusing the name defeats the test.
2. Sound like a real user: casual, abbreviated, sometimes vague. Chatty is fine — a normalizer cleans it
   up downstream. You MAY include a team or player name and a competition ("in the Brazil game", "for
   Mbappe", "World Cup final") — that's how people type.
3. Do NOT be artificially obscure or write riddles. Natural, not cryptic.
4. Vary your phrasing across markets — don't reuse a template.
5. One query per market. Output strict JSON: a list of { "id": <number>, "q": "<query>" }.

You are NOT told how the system represents these markets internally, nor which queries it currently
handles. Just write the most natural query for the meaning you're given.
```

## Per-market user message (one batch per family)

```
Family: <family name>. Write one natural query for EACH market below.

[
  { "id": 1001159897, "name": "Total Corners",        "category": "Corners",      "subject": "team/match" },
  { "id": 1003971484, "name": "To keep a clean sheet", "category": "Player Goals", "subject": "player" },
  ...
]
```

## Worked examples (good vs. bad)

| Target market | ✅ good (meaning, distinct words) | ❌ bad (copies the name) |
| --- | --- | --- |
| `1001159897` Total Corners | "how many corners in the Brazil game" | "total corners" |
| `1003971484` To keep a clean sheet | "will Alisson keep them out at the back" | "to keep a clean sheet" |
| `1001159666` Draw No Bet | "back France but refund my stake if it's a draw" | "draw no bet" |
| `1001284857` Top Goal Scorer | "who finishes the tournament as leading scorer" | "top goal scorer" |

## Notes
- **Blindness is the point.** The generator sees only the target market — never the doc-views (Opus),
  never the known-failure list. That keeps the eval honest (decision #3).
- **By-construction label = the `id`.** Grading is id-containment + tier (E13); the generator's phrasing
  never becomes the answer key.
- After generation, record the **lexical overlap** between each query and its target name, so wins can be
  split into genuine generalization vs near-string-matches (decision #3).
