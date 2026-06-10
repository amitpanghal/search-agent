# Doc-view generation prompt (Sprint 6, decision 27 — Phase 1 step 2)

> Run by the **doc-view generator (Opus, `claude-opus-4-8`)** via `scripts/gen-doc-views.ts`. Authors the
> per-criterion **doc-views**: extra terse phrasings of each market, embedded as additional vectors so the
> grounder's cosine tail can match a user query that shares no words with the official catalog name.
> **Cluster-contrastive** (decision #6): Opus sees a whole cluster of sibling markets and writes views that
> *distinguish each member from its siblings*; a mechanical collision filter then drops any view closer to a
> sibling than to its own market. Opus is **blind to the eval set and the failure list** (clean-room, #3).
> Views are authored in the terse `market_concept` register — what the grounder embeds — **not** chatty user
> prose (that register belongs to the eval queries, `eval-query-prompt.md`).

## System prompt

```
You generate "doc-views" for a sports betting market catalog. A doc-view is a short alternate phrasing of
ONE market, written in the terse register a search system normalizes user queries into — noun-phrase betting
shorthand, NOT chatty user prose. These phrasings become additional embedding vectors, so a market can still
be found when a user's wording shares no words with its official catalog name.

You are given a CLUSTER of sibling markets from the same catalog category. They are easy to confuse with one
another. For EACH market in the cluster, write 6-8 DISTINCT terse paraphrases of its meaning that:

1. MEANING, NOT NAME. Capture what the market settles on, using DIFFERENT words from the official name where
   you can. The official name already embeds well — the views exist to cover the phrasings it misses
   ("To keep a clean sheet" -> "shut out", "concede no goals", "nil at the back").

2. DISTINGUISH IT FROM ITS SIBLINGS. A view must not equally describe a sibling in the cluster. If markets
   differ only by a qualifier — period (1st half / full match / extra time), side (home / away), or
   settlement source — that qualifier MUST appear in every view ("total corners 1st half", not "total
   corners"). If you cannot phrase a view that excludes the siblings, omit it. Fewer precise views beat more
   ambiguous ones.

3. STAY IN THE TERSE MARKET REGISTER. "away team to win to nil", "anytime goalscorer", "over 9.5 total
   corners" — short betting shorthand. Do NOT write full sentences or questions ("how many corners will
   there be?"). No team or player names, no competition names — just the market concept.

4. DO NOT INVENT MARKETS. Paraphrase only the meaning of the given name. Never add an outcome, line, or
   compound the name does not state.

Output strictly via the emit_doc_views tool: for each input market `ref`, return its `paraphrases` array.
Return one entry per input ref, in any order.
```

## Per-cluster user message

```
Category: <category name>   (subject: <player | team_or_match>)
Markets in this cluster — write distinguishing views for EACH, keeping them distinct from the others:

[
  { "ref": 0, "name": "Total Corners" },
  { "ref": 1, "name": "Most Corners" },
  { "ref": 2, "name": "First Corner" },
  ...
]
```

## Worked example (cluster: Corners, team_or_match)

| ref | market | ✅ distinguishing views | ❌ ambiguous (also fits a sibling) |
| --- | --- | --- | --- |
| 0 | Total Corners | "over/under total corners", "number of corner kicks in the match", "corner count" | "corners" (fits Most/First Corner too) |
| 1 | Most Corners | "team with the most corners", "which side wins the corner count" | "corners in the match" |
| 2 | First Corner | "team to take the first corner", "who wins corner one" | "corner winner" (fits Most Corners) |

## Collision filter (mechanical, post-generation — not Opus)

Every surviving view is embedded and compared (cosine) to its own market's name vector vs each **distinct-
family sibling** in the cluster (family = `statCore` minus facet parameters: period, line/window template,
settlement/dead-heat parentheticals, alternate-line direction). A view a sibling beats by **more than a small
margin (ε)** is dropped. Markets that differ ONLY by a facet (period, Home/Away side, settlement, line/window
— same `familyKey`) are **twins**, not siblings — they keep sharing views, because the grounder already
disambiguates those facets at query time (period collapse, line→boType gate). This stops a terse market
(`First Corner`) from being annihilated by its own period/window variants, while still dropping a view that
genuinely points at a different stat-type sibling.
