# ADR: Typed fetch from the taxonomy

Status: proposed — decision pending production numbers
Date: 2026-10-03
Depends on: market-taxonomy (built and live)
Component record: none yet (would change `components/recall.md`)

## Context

Recall makes one untyped call per query, by entity, and reads the market afterwards (recall ADR, "fetch by
entity, broad, then narrow per leg"). The call is big and it is capped: measured 2026-10-02 on the live feed,
the Premier League group returned 1.9 MB in 164 ms, 2000 offers — the silent cap — covering only 8 of its 20
matches, which today triggers the fan-out (more calls). The Arsenal participant endpoint returned 914 KB in
153 ms.

The same calls with a bet offer type: `type=2` (1X2) on the Premier League group returned 283 KB in 51 ms,
240 offers, all 20 matches; on the Arsenal participant endpoint 41 KB in 43 ms. `type=2,6` (a comma list) works.
Roughly 7–20× less data, ~100 ms faster, and the cap is escaped — that last part is the real win.

The market-taxonomy rows store no type, but its log record carries the bet offer type of the pick and of every
menu item, so the types for the pick and each related market are mined from the logs into the rows if this is
accepted — nothing in the pipeline changes before then. The types are the stable half of a
market across sports: a plain winner is type `Match` in all 19 sports that offer one, a total is `Over/Under`
in all; only the label varies. A type is a family, not a market — `type=2` still returns Full Time, Half Time,
Draw No Bet and First Goal — so the label (via the taxonomy id) still picks within it.

History that matters: the extractor's `bo_types` (dropped 2026-06-29) was a blind model guess at the type,
applied to the fetch; a wrong guess hard-pruned the right market into an empty answer. The type here would come
from a judged, human-approved row, matched against the fetched menu — a different source and a different
failure shape. The objection to `bo_types` was the guess, not the parameter.

## What is proposed

1. When **every** leg of a query has a taxonomy row — no `main` leg, no miss — recall adds `type=` with the
   union of the pick types and the related types of all legs. Otherwise the fetch stays untyped, as today.
2. Everything after the fetch is unchanged: the taxonomy lookup, the id-on-menu check, select, the betslip.
3. If a stored id is not on the typed menu (a rename or a retired market), the leg goes to the LLM **with the
   typed menu**: the family is still there, so the model can pick within it. The alternative — refetch broad —
   costs a second round trip on a path that should be rare. Which one, is decided with the numbers below.

## What decides it

The fetch is one call for the whole query, so only queries where **all** legs hit can be typed. The decision
needs, from two to three weeks of `pickSource` logs after the taxonomy is live:

- the share of queries where every leg hit, per sport — the share that benefits;
- how often a hit's id was absent from the menu — the size of the miss-after-typed path, which picks between
  "LLM on the typed menu" and "refetch broad";
- how often the untyped fetch hit the 2000 cap on those same queries — the size of the cap-escape win;
- the measured latency on the typed path in production, against today's ~0.2 s recall.

With those in hand this record is either accepted (status → `accepted — not yet built`, the open choice in
point 3 filled in) or closed as not worth it (status → `rejected`, numbers attached). Nothing is built before.

## Consequences if accepted

- `recall` gains the `type` list the feed client already serializes (`boParams`, `type=` as a comma list,
  verified). `planRecall` learns whether every leg has a row; a `main` leg or a miss disables typing.
- Related cards survive because their types are in the list; family asks and `main` legs are untouched because
  they never type the fetch.
- The cap fan-out rarely triggers on typed queries.
- Risk: a wrong type in a row hides the right market behind a typed fetch. Mitigated three times: rows are judged
  and human-approved; the id-on-menu check turns a hidden market into a miss, not a wrong pick; the miss goes
  to the LLM on a menu that still holds the family.
- Partial-hit queries get no fetch benefit; their saving is the skipped resolver calls only.

## Not this

- Typing from the extractor's output (`bo_types`): a guess; dropped once, not coming back.
- Typing on partial hits by fetching twice (typed for the hits, broad for the misses): two calls instead of one
  on exactly the queries that are already the slow ones.

## Related

- market-taxonomy (the rows; their types mined from its logs), recall (the fetch this would change),
  offering-feed (the `type=` parameter and the 2000 cap).
