# LLM providers

Component record: how this component works today. The decisions behind it: [adr/llm-providers.md](../adr/llm-providers.md).
Last verified: 2026-10-02 against 19912c9 (+ the DeepSeek switch)

## Purpose
One transport signature for every model call, with two backends: AWS Bedrock (Converse API) and DeepSeek
(its own OpenAI-format Chat Completions API). Three stages call it: extraction (`emit_query_plan`), the entity gate (`settle_cells`)
and market resolution (`pick`). Every call records its tokens into a per-query store that becomes the
envelope's cost block.

## Input and output
- In: a system prompt, a user message, a tool name, the tool's JSON Schema, and a max-token budget.
- Out: the parsed tool input as a plain object. Each caller decodes its own fields.

## How it works
1. `bedrockToolCall` is the entry. With `LLM_PROVIDER=deepseek` it forwards every call to `deepseekToolCall`.
2. On Bedrock the model id is `BEDROCK_MODEL`, or a per-stage override `BEDROCK_MODEL_<TOOLNAME>`
   (`_EMIT_QUERY_PLAN`, `_SETTLE_CELLS`, `_PICK`). The call forces the tool (`toolChoice`) at temperature 0.
   For OpenAI-family models on Converse no temperature is sent and reasoning is turned off, so no reasoning
   tokens are billed.
3. Forced tool choice is honoured only by some model families; others answer in a text block. The transport
   accepts either: the tool's parsed input, or JSON sliced out of the text (fences and stray prose stripped).
4. On DeepSeek the same prompt goes through Chat Completions with a forced function call and thinking off.
   `DEEPSEEK_BASE_URL` points it at another host serving the same API.
5. Every response pushes `{ tool, inputTokens, outputTokens, cachedTokens? }` into
   `usageStore`, an `AsyncLocalStorage` the orchestrator opens per query. DeepSeek rows carry their own
   prices (`DEEPSEEK_PRICE_IN`, `_OUT`, `_CACHED`); Bedrock rows are priced from `BEDROCK_PRICE_IN` and `BEDROCK_PRICE_OUT`. `summarizeCost` turns
   the rows into the envelope's `cost` block.
6. Each call also emits a trace event (request and response) that the probe and the log record read.

## Invariants
- `cost.ts` carries a self-check for the arithmetic; the envelope's `cost` block is built only from
  recorded rows.
- The log record stamps `model` and `provider` on every query, so a model change is visible in the data
  without a commit.

## Limits
- No retry or backoff in either transport. A throttled call fails the query. Only the eval runner retries
  throttles.
- Per-query cost is approximate under a mixed per-stage model config on Bedrock (one price pair).
- DeepSeek bills 2x at peak hours (01-04 and 06-10 UTC, Mon-Fri); the cost block uses one price set, so it
  reads low then.
- No prompt caching is configured; DeepSeek's automatic prefix cache serves the repeated system prompt.

## Where to look
- `src/resolver/llm/bedrock-call.ts`, `deepseek-call.ts`, `cost.ts`; env keys in `.env.example`.
- Probe `[llm ...]` rows show the exact system and user prompt of every call.
- Related: extraction, grounding, market-resolution, logging.
