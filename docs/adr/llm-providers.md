# ADR: LLM providers

Status: current
Last verified: 2026-09-30 against eb4aae8

## Purpose
One transport signature for every model call, with two backends: AWS Bedrock (Converse API) and OpenAI
(Chat Completions). Three stages call it: extraction (`emit_query_plan`), the entity gate (`settle_cells`)
and market resolution (`pick`). Every call records its tokens into a per-query store that becomes the
envelope's cost block.

## Input and output
- In: a system prompt, a user message, a tool name, the tool's JSON Schema, and a max-token budget.
- Out: the parsed tool input as a plain object. Each caller decodes its own fields.

## How it works
1. `bedrockToolCall` is the entry. With `LLM_PROVIDER=openai` it forwards every call to `openaiToolCall`.
2. On Bedrock the model id is `BEDROCK_MODEL`, or a per-stage override `BEDROCK_MODEL_<TOOLNAME>`
   (`_EMIT_QUERY_PLAN`, `_SETTLE_CELLS`, `_PICK`). The call forces the tool (`toolChoice`) at temperature 0.
   For OpenAI-family models on Converse no temperature is sent and reasoning is turned off, so no reasoning
   tokens are billed.
3. Forced tool choice is honoured only by some model families; others answer in a text block. The transport
   accepts either: the tool's parsed input, or JSON sliced out of the text (fences and stray prose stripped).
4. On OpenAI the same prompt goes through Chat Completions with a forced function call. `OPENAI_BASE_URL`
   selects the EU endpoint when needed.
5. Every response pushes `{ tool, inputTokens, outputTokens, cachedTokens?, cacheWriteTokens? }` into
   `usageStore`, an `AsyncLocalStorage` the orchestrator opens per query. OpenAI rows carry their own
   prices; Bedrock rows are priced from `BEDROCK_PRICE_IN` and `BEDROCK_PRICE_OUT`. `summarizeCost` turns
   the rows into the envelope's `cost` block.
6. Each call also emits a trace event (request and response) that the probe and the log record read.

## Key decisions and why
- **Structured output by forced tool use.** The schema is the contract; the model fills a form instead of
  writing prose.
- **Temperature 0.** The eval protocol assumes it: the same query must give the same plan.
- **One signature, two backends.** The stages never know which provider runs; a config change moves all
  three.
- **Per-stage model override.** The three stages can run different models from `.env` alone.
- **Cost accounting through async local storage.** No argument threading through the stages, and safe
  across concurrent requests because each query has its own array.
- **Tolerant response parsing.** A model that ignores forced tool choice still yields a usable object.
- **The model id is env-driven.** Nothing in code names a model.

## Invariants
- `cost.ts` carries a self-check for the arithmetic; the envelope's `cost` block is built only from
  recorded rows.
- The log record stamps `model` and `provider` on every query, so a model change is visible in the data
  without a commit.

## Limits
- No retry or backoff in either transport. A throttled call fails the query. Only the eval runner retries
  throttles.
- Per-query cost is approximate under a mixed per-stage model config on Bedrock (one price pair).
- No prompt caching is used.

## Where to look
- `src/resolver/llm/bedrock-call.ts`, `openai-call.ts`, `cost.ts`; env keys in `.env.example`.
- Probe `[llm ...]` rows show the exact system and user prompt of every call.
- Related: extraction, grounding, market-resolution, logging.
