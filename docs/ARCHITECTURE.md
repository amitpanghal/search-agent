# Architecture

search-agent turns one free-text betting query ("Arsenal to win and over 2.5 goals tonight") into a set of
priced bet offers from Kambi's live offering feed. One HTTP endpoint, one pipeline, no database.

This page is the index. Each component has a **component record** under `docs/components/` (purpose, input
and output, how it works, invariants, limits, where to look — living, verified against a commit) and a
**decision record** under `docs/adr/` (context and decisions — frozen once accepted).

Last verified: 2026-10-03 against 19912c9 (docs split into component and decision records).

## The pipeline

    query
      1. extraction         LLM    query text -> QueryPlan: one selector per bet, each with its own scope
      2. grounding          mixed  names -> catalog ids; deterministic first, one LLM call for doubtful cells
      3. recall             feed   entity ids -> broad live data, then one scoped menu per leg
      4. market-resolution  LLM    a leg's phrase + its filtered menu -> one market, graded exact/close/none
      5. selection          code   the picked market -> the concrete outcome(s), or an honest fallback
      6. combinations       feed   the user's legs -> one priced betslip, a part per match
      7. envelope           code   everything above -> the ResponseEnvelope

The one idea that explains the design: **the market is decided after the fetch.** A market such as "both
teams to score" exists only as a label inside the live feed, and the feed changes daily. So recall fetches by
entity (team, player, competition), never by market, and each leg picks its market from the menu that came back.

The orchestrator that chains these stages is its own record: [pipeline](components/pipeline.md).

## Component records

How each component works today.

| Record | Covers |
|---|---|
| [pipeline](components/pipeline.md) | stage order, early stops, leg grouping, progress events |
| [extraction](components/extraction.md) | query to QueryPlan: prompt, schema, repair, retry |
| [grounding](components/grounding.md) | names to catalog ids: tiers, joint resolution, the entity LLM, sport recovery |
| [recall](components/recall.md) | entity ids to live data: fetch plan, endpoints, fan-out, per-leg scoping, time windows |
| [market-resolution](components/market-resolution.md) | the subject filter and the LLM market pick |
| [selection](components/selection.md) | picked market to outcomes: lines, sides, ladders, fallbacks |
| [combinations](components/combinations.md) | the betslip: a part per match, correlated pricing |
| [envelope](components/envelope.md) | the response shape and how it is assembled |
| [offering-feed](components/offering-feed.md) | the Kambi feed client: endpoints, caps, labels, locales |
| [catalogs](components/catalogs.md) | per-sport entity catalogs: build chain, overrides, aliases, refresh |
| [llm-providers](components/llm-providers.md) | Bedrock and DeepSeek transports, forced tool use, cost accounting |
| [api](components/api.md) | routes, request body, the SSE contract, click events |
| [logging](components/logging.md) | one record per search and one per click |
| [evaluation](components/evaluation.md) | gold decks, the three gates, the free gates, probe and trace |
| [deployment](components/deployment.md) | container, ECS Fargate, load balancer, secrets, logs, the production plan |

## Decision records (ADRs)

Why it is built that way. One record per decision, never edited after acceptance except its
status lines (`accepted — not yet built` → `current — built <commit>` → `superseded by <record>`).

| Record | Status | Date |
|---|---|---|
| [pipeline](adr/pipeline.md) | current — built | 2026-09-30 |
| [extraction](adr/extraction.md) | current — built | 2026-09-30 |
| [grounding](adr/grounding.md) | current — built | 2026-09-30 |
| [recall](adr/recall.md) | current — built | 2026-09-30 |
| [market-resolution](adr/market-resolution.md) | current — built | 2026-09-30 |
| [selection](adr/selection.md) | current — built | 2026-09-30 |
| [combinations](adr/combinations.md) | current — built | 2026-09-30 |
| [envelope](adr/envelope.md) | current — built | 2026-09-30 |
| [offering-feed](adr/offering-feed.md) | current — built | 2026-09-30 |
| [catalogs](adr/catalogs.md) | current — built | 2026-09-30 |
| [llm-providers](adr/llm-providers.md) | current — built | 2026-10-02 |
| [api](adr/api.md) | current — built | 2026-09-30 |
| [logging](adr/logging.md) | current — built | 2026-09-30 |
| [evaluation](adr/evaluation.md) | current — built | 2026-09-30 |
| [deployment](adr/deployment.md) | current — built | 2026-10-02 |
| [market-taxonomy](adr/market-taxonomy.md) | accepted — not yet built | 2026-10-03 |
| [one-market-call](adr/one-market-call.md) | current — built | 2026-10-03 |
| [typed-fetch](adr/typed-fetch.md) | proposed — decision pending production numbers | 2026-10-03 |

## The rule for changes

1. A change in behaviour starts as a **new** ADR (`docs/adr/<slug>.md`, `Status: accepted — not yet built`).
2. When it ships, the ADR's status flips to `current — built <commit>`, and the **component records** it touches
   are updated to the new current state with a one-line pointer to the ADR.
3. An ADR is never rewritten. A decision that replaces an old one is a new ADR; the old one gets
   `Superseded by: <slug>` and nothing else.

## Reading order for a newcomer

pipeline first, then extraction through envelope in order, then offering-feed and catalogs. The rest as
needed — component records for how, ADRs for why. CLAUDE.md and the skills under `.claude/skills/` are the
working guides for agents.
