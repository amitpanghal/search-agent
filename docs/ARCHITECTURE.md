# Architecture

search-agent turns one free-text betting query ("Arsenal to win and over 2.5 goals tonight") into a set of
priced bet offers from Kambi's live offering feed. One HTTP endpoint, one pipeline, no database.

This page is the index. Each component has its own record under `docs/adr/`, all on the same template:
purpose, input and output, how it works, key decisions and why, invariants, limits, where to look.

Last verified: 2026-09-30 against eb4aae8.

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

The orchestrator that chains these stages is its own record: [pipeline](adr/pipeline.md).

## Records

| Record | Covers |
|---|---|
| [pipeline](adr/pipeline.md) | stage order, early stops, leg grouping, progress events |
| [extraction](adr/extraction.md) | query to QueryPlan: prompt, schema, repair, retry |
| [grounding](adr/grounding.md) | names to catalog ids: tiers, joint resolution, the entity LLM, sport recovery |
| [recall](adr/recall.md) | entity ids to live data: fetch plan, endpoints, fan-out, per-leg scoping, time windows |
| [market-resolution](adr/market-resolution.md) | the subject filter and the LLM market pick |
| [selection](adr/selection.md) | picked market to outcomes: lines, sides, ladders, fallbacks |
| [combinations](adr/combinations.md) | the betslip: a part per match, correlated pricing |
| [envelope](adr/envelope.md) | the response shape and how it is assembled |
| [offering-feed](adr/offering-feed.md) | the Kambi feed client: endpoints, caps, labels, locales |
| [catalogs](adr/catalogs.md) | per-sport entity catalogs: build chain, overrides, aliases, refresh |
| [llm-providers](adr/llm-providers.md) | Bedrock and OpenAI transports, forced tool use, cost accounting |
| [api](adr/api.md) | routes, request body, the SSE contract, click events |
| [logging](adr/logging.md) | one record per search and one per click |
| [evaluation](adr/evaluation.md) | gold decks, the three gates, the free gates, probe and trace |
| [deployment](adr/deployment.md) | container, ECS Fargate, load balancer, secrets, logs, the production plan |

## Reading order for a newcomer

pipeline first, then extraction through envelope in order, then offering-feed and catalogs. The rest as
needed. CLAUDE.md and the skills under `.claude/skills/` are the working guides for agents; these records
hold the why.
