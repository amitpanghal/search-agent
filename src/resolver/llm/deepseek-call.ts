// deepseek-call — transport for DeepSeek's own API (OpenAI-format Chat Completions) with a forced function call.
// Same signature as bedrockToolCall, which routes EVERY stage (extract, entities, market) here when
// LLM_PROVIDER=deepseek — DeepSeek V4.1 Flash is not on Bedrock (2026-10). Usage lands in the per-query cost store
// with DEEPSEEK_PRICE_* on the row, so the envelope's cost block stays right under a mixed config.
//
// Config (env): DEEPSEEK_API_KEY, DEEPSEEK_MODEL (e.g. deepseek-flash), DEEPSEEK_PRICE_IN / DEEPSEEK_PRICE_OUT /
// DEEPSEEK_PRICE_CACHED (USD per 1M: cache miss / output / cache hit; unset => cost reports 0),
// DEEPSEEK_BASE_URL (default https://api.deepseek.com; any host serving the same OpenAI-format API works).
// ponytail: one price set — DeepSeek bills 2x at peak (01-04 and 06-10 UTC, Mon-Fri), so cost reads low then;
// add a peak multiplier if the cost block must match the invoice.

import { usageStore } from "./cost";
import { emit } from "../shared/trace";

type Resp = {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> };
  }>;
};

export async function deepseekToolCall(
  system: string,
  user: string,
  toolName: string,
  schema: Record<string, unknown>,
  maxTokens = 2048,
): Promise<Record<string, unknown>> {
  const model = process.env.DEEPSEEK_MODEL;
  if (!process.env.DEEPSEEK_API_KEY || !model)
    throw new Error("DEEPSEEK_API_KEY and DEEPSEEK_MODEL must be set (see deepseek-call.ts header).");
  emit({ kind: "llm-req", tool: toolName, model, system, user, schema });

  const res = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [{ type: "function", function: { name: toolName, parameters: schema } }],
      tool_choice: { type: "function", function: { name: toolName } }, // forced, like Converse toolChoice.tool
      thinking: { type: "disabled" }, // no reasoning tokens billed or waited on
      temperature: 0,
      max_tokens: maxTokens,
    }),
  });
  const body = (await res.json()) as Resp;
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);

  const inputTokens = body.usage?.prompt_tokens ?? 0,
    outputTokens = body.usage?.completion_tokens ?? 0;
  const cachedTokens = body.usage?.prompt_cache_hit_tokens ?? 0; // automatic prefix cache; counted inside prompt_tokens
  usageStore.getStore()?.push({
    tool: toolName,
    inputTokens,
    outputTokens,
    cachedTokens,
    priceIn: Number(process.env.DEEPSEEK_PRICE_IN ?? 0),
    priceOut: Number(process.env.DEEPSEEK_PRICE_OUT ?? 0),
    priceCached: Number(process.env.DEEPSEEK_PRICE_CACHED ?? 0),
  });

  // The forced call's arguments are JSON; if the model answers in text instead, slice the JSON out (as bedrock-call does).
  const choice = body.choices?.[0];
  const raw = choice?.message?.tool_calls?.[0]?.function?.arguments ?? choice?.message?.content ?? "";
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error(
      `DeepSeek returned no tool call or parseable JSON for "${toolName}". Got: ${raw.slice(0, 500) || "(empty)"}`,
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
