# ADR: One market call per query

Status: current — built
Date: 2026-10-03
Component record: [components/market-resolution.md](../components/market-resolution.md)
Supersedes: the "Batched per group" decision in [market-resolution](market-resolution.md)

## Context

The market resolver was called once per leg group: legs sharing a subject and a scope shared one filtered
menu and one call, and a query with two subjects ("Arsenal to win and over 2.5 goals") made two concurrent
calls, each carrying its own menu. The menu is the expensive part of the prompt, and the menus overlap almost
entirely: the menu item identity is the market label (English label plus variant) with no team or fixture in
it, a team subject keeps most of its fixture's menu (96 of 113 labels on Croatia–England, 2026-10-03), two
outright subjects share the same Finishing Position labels, and two fixtures of one sport share most market
names. Measured before this change on 12 multi-group queries: 24 pick calls, 87.8K market-stage input tokens.

The same merge had been built on the Jev transport (commit 1192593, 2026-09-22) and never reached main. With
every stage on DeepSeek, the prompt path needed it too.

## Decisions

- **One resolver call per query.** The orchestrator still runs `scopeMenu` and `filterBySubject` per group,
  synchronously and anchored-first, but collects each named leg as a bet (phrase plus its group's filtered
  menu) and makes one `resolveMarkets` call after the loop. Picks map back to legs in job order, then bet order.
- **The union lives in the resolver, not the orchestrator.** `resolveMarkets` takes bets that each carry their
  own menu. Inside, the menus are unioned by label with outcome lists merged, and answered refs map back into
  each bet's own menu. A ref outside the bet's set maps to no item and collapses to `none`; an outcome string
  is checked against the bet's own item, so an outcome that exists only on another group's twin is rejected.
- **A bet is tagged only when its set is a strict subset.** `[may pick: 0-5, 9]` as compact ranges, written by
  code. A bet that may use the whole union carries no tag, so a single-group call reads exactly as before.
- **One prompt sentence.** "The same menu serves all of them" became: a bet may carry `[may pick: …]`, the
  only refs that price its subject; choose its pick and its `related` from those refs only; a bet with no tag
  may use the whole menu. Nothing else in the prompt moved.
- **No switch.** Rollback is a revert of one commit. Unlike the taxonomy, nothing here answers without the
  model seeing the bet, and nothing changes without a deploy.
- **Ships before the market taxonomy.** Its hook subtracts hits from the same bet list; decision 7 there
  ("only the misses go to the batched LLM call") holds with no edit.

## Consequences

Measured 2026-10-03 on the same 12 multi-group queries, before and after, six minutes apart, DeepSeek V4.1
Flash, live fixtures (Nations League, NFL, NHL, MLB, ATP, Premier League outrights):

| | before | after |
|---|---|---|
| pick calls | 24 | 12 |
| market-stage input tokens | 87,807 | 48,036 |
| of which uncached | 29,567 | 24,996 |
| market-stage output tokens | 1,751 | 1,372 |
| pick wall time, summed | 17.7 s | 12.3 s |
| query wall time, summed | 38.6 s | 29.0 s |
| legs identical | | 23 of 27 |

- Four legs changed: "Arsenal to win the Premier League" moved from `close: Winner without Arsenal and Man
  City` to `exact: Season Finishing Position — Winner` (a fix); the two Hurricanes legs kept their markets and
  moved from `close` to `exact`; "Kane to score at any time" moved between the twins `To Score (Fielded
  Anytime)` and `To Score`.
- The uncached saving is smaller than the token saving because DeepSeek's prefix cache already served the
  repeated system prompt, and the before-run's repeated England menus hit the cache across queries. On a
  transport with no cache the saving is the full token drop.
- One request per query means one throttle point instead of one per group; neither transport retries.
- The free live-menu gate gained a check that two bets with different menus bind into their own menus in one
  call; `invariants.test.ts` covers the union, the tags and the ref mapping.

## Related

- market-resolution (superseded decision), llm-providers, market-taxonomy, evaluation.
