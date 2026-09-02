// bedrock-call — shared transport for calling the configured Bedrock model (BEDROCK_MODEL) via the Converse
// API's forced tool use. The three prod LLM steps (extract, resolve-entities, resolve-market) all go through it.
// Returns the parsed tool input object; each caller decodes its own fields. Creds come from the standard AWS
// env chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION), loaded from .env.
//
// Config (env): AWS_REGION, BEDROCK_MODEL (on-demand needs the cross-region inference profile id, e.g.
// us.amazon.nova-lite-v1:0), plus the two AWS credential vars.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { usageStore } from "./cost";
import { emit } from "./trace";

let cached: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!cached) {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set (see bedrock-call.ts header).");
    }
    cached = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return cached;
}

export async function bedrockToolCall(
  system: string,
  user: string,
  toolName: string,
  schema: Record<string, unknown>,
  maxTokens = 2048,
): Promise<Record<string, unknown>> {
  // Per-stage override: BEDROCK_MODEL_<TOOLNAME> (BEDROCK_MODEL_EMIT_QUERY_PLAN / _SETTLE_CELLS / _PICK)
  // beats the shared BEDROCK_MODEL, so the three stages can run different models from .env alone.
  // BEDROCK_PRICE_* stays single-model — per-query cost is approximate under a mixed config.
  const modelId = process.env[`BEDROCK_MODEL_${toolName.toUpperCase()}`] || process.env.BEDROCK_MODEL;
  if (!modelId) throw new Error("BEDROCK_MODEL must be set (e.g. us.amazon.nova-lite-v1:0).");
  emit({ kind: "llm-req", tool: toolName, model: modelId, system, user, schema });

  const res = await client().send(
    new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      toolConfig: {
        tools: [{ toolSpec: { name: toolName, inputSchema: { json: schema as never } } }],
        toolChoice: { tool: { name: toolName } }, // force the pick tool (Converse equivalent of forced tool_choice)
      },
      inferenceConfig: { temperature: 0, maxTokens },
    }),
  );

  // Record this call's token usage into the current query's collector (if runPipeline established one).
  const u = res.usage;
  if (u) usageStore.getStore()?.push({ tool: toolName, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 });

  const blocks = (res.output as { message?: { content?: unknown[] } })?.message?.content ?? [];
  // Bedrock enforces forced toolChoice only for some model families (Anthropic Claude, Mistral Large);
  // others (Qwen) treat the tool as optional and answer in a TEXT block instead. Accept either channel:
  // the tool's pre-parsed input, or JSON sliced out of the text (strips ```json fences / stray prose).
  const toolUse = (blocks as Array<{ toolUse?: { input?: unknown } }>).find((b) => b.toolUse)?.toolUse;
  if (toolUse) { const out = (toolUse.input ?? {}) as Record<string, unknown>; emit({ kind: "llm-resp", tool: toolName, output: out, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, stopReason: res.stopReason }); return out; }

  const text = (blocks as Array<{ text?: string }>).map((b) => b.text ?? "").join(" ").trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { const out = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; emit({ kind: "llm-resp", tool: toolName, output: out, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, stopReason: res.stopReason }); return out; } catch { /* fall through to throw */ }
  }
  throw new Error(`Bedrock returned no toolUse or parseable JSON for "${toolName}". Got: ${text.slice(0, 500) || "(empty)"}`);
}
