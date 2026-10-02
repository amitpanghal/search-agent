// openai-call — transport for an OpenAI-hosted model through Chat Completions with a forced function call.
// Same signature as bedrockToolCall, which routes EVERY stage (extract, entities, market) here when
// LLM_PROVIDER=openai — for models the AWS account cannot reach on Bedrock (GPT-6 Luna, 2026-09). Usage lands in the per-query cost store with
// OPENAI_PRICE_* on the row, so the envelope's cost block stays right under a mixed config.
//
// Config (env): OPENAI_API_KEY, OPENAI_MODEL (e.g. gpt-6-luna), OPENAI_PRICE_IN / OPENAI_PRICE_OUT / OPENAI_PRICE_CACHED /
// OPENAI_PRICE_CACHE_WRITE (USD per 1M, unset => cost reports 0; an unset CACHE_WRITE prices writes as plain input),
// OPENAI_BASE_URL (default https://api.openai.com/v1; eu.api.openai.com/v1 for EU residency).

import { usageStore } from "./cost";
import { emit } from "../shared/trace";

type Resp = {
  error?: { message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> };
  }>;
};

export async function openaiToolCall(
  system: string,
  user: string,
  toolName: string,
  schema: Record<string, unknown>,
  maxTokens = 2048,
): Promise<Record<string, unknown>> {
  const model = process.env.OPENAI_MODEL;
  if (!process.env.OPENAI_API_KEY || !model)
    throw new Error("OPENAI_API_KEY and OPENAI_MODEL must be set (see openai-call.ts header).");
  emit({ kind: "llm-req", tool: toolName, model, system, user, schema });

  const res = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [{ type: "function", function: { name: toolName, parameters: schema } }],
      tool_choice: { type: "function", function: { name: toolName } }, // forced, like Converse toolChoice.tool
      reasoning_effort: "none", // GPT-5.x/6 reason at `medium` by default
      temperature: 0, // accepted only with reasoning off (Bedrock Converse rejects it for these models)
      prompt_cache_key: toolName, // routes every extractor call to the same cache shard: the ~4.8K system prompt is the prefix
      max_completion_tokens: maxTokens,
    }),
  });
  const body = (await res.json()) as Resp;
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);

  const inputTokens = body.usage?.prompt_tokens ?? 0,
    outputTokens = body.usage?.completion_tokens ?? 0;
  const cachedTokens = body.usage?.prompt_tokens_details?.cached_tokens ?? 0; // automatic for prompts > 1,024 tokens; counted inside prompt_tokens
  const cacheWriteTokens = body.usage?.prompt_tokens_details?.cache_write_tokens ?? 0; // GPT-5.6+ bills these at 1.25× input; also inside prompt_tokens
  usageStore.getStore()?.push({
    tool: toolName,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    priceIn: Number(process.env.OPENAI_PRICE_IN ?? 0),
    priceOut: Number(process.env.OPENAI_PRICE_OUT ?? 0),
    priceCached: Number(process.env.OPENAI_PRICE_CACHED ?? 0),
    priceCacheWrite: Number(process.env.OPENAI_PRICE_CACHE_WRITE || process.env.OPENAI_PRICE_IN || 0),
  });

  // The forced call's arguments are JSON; if the model answers in text instead, slice the JSON out (as bedrock-call does).
  const choice = body.choices?.[0];
  const raw = choice?.message?.tool_calls?.[0]?.function?.arguments ?? choice?.message?.content ?? "";
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error(
      `OpenAI returned no tool call or parseable JSON for "${toolName}". Got: ${raw.slice(0, 500) || "(empty)"}`,
    );
  const out = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  emit({
    kind: "llm-resp",
    tool: toolName,
    output: out,
    inputTokens,
    outputTokens,
    cachedTokens,
    stopReason: choice?.finish_reason,
  });
  return out;
}
