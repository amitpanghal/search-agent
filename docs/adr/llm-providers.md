# ADR: LLM providers

Status: current — built
Date: 2026-10-02
Component record: [components/llm-providers.md](../components/llm-providers.md)

## Context
One transport signature for every model call, with two backends: AWS Bedrock (Converse API) and DeepSeek
(its own OpenAI-format Chat Completions API). Three stages call it: extraction (`emit_query_plan`), the entity gate (`settle_cells`)
and market resolution (`pick`). Every call records its tokens into a per-query store that becomes the
envelope's cost block.

## Decisions
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
- **DeepSeek V4.1 Flash is the model.** Picked on the extractor gate (211/227 on 2026-10-02; GPT-6 Luna 178, Qwen 156
  on the same gold). GPT-6 Luna is out regardless: OpenAI support advised against it for this agent under their
  gambling terms (2026-10-02). DeepSeek's own API is China-hosted and for dev only; production serves the same
  model from another host (OpenRouter, Fireworks or DeepInfra) through `DEEPSEEK_BASE_URL`, decided later.

## Related
- Related: extraction, grounding, market-resolution, logging.
