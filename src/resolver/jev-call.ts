// jev-call — the second model transport: TypeSafe's Jev decision model (POST api.typesafe.ai/v1/systemone),
// used by the entity gate (resolve-entities.ts) and nothing else. Jev is not on Bedrock and has no text
// output: it answers a `choice` question with one probability per option, which is exactly what settling a
// candidate list needs and nothing a prompt-and-parse round trip adds. It mirrors bedrock-call.ts at the seams
// — trace `emit` on request and reply, one usage row into usageStore — so probe traces and the cost block read
// the same for both transports. Own key (JEV_ACCESS_KEY), own retry: one more attempt after a backoff on
// 429/529; every other failure returns null and the caller decides (the entity gate clarifies every cell).
// Only a missing key throws — a configuration error fails the query by name, as a missing AWS key does.
//
// Config (env): JEV_ACCESS_KEY (required), JEV_MODEL (default jev-latest), JEV_PRICE_IN (USD per 1M input
// tokens, default 0.042; Jev output is free). A blank or non-numeric number falls back to its default.

import { z } from "zod";
import { usageStore } from "./cost";
import { emit } from "./trace";

const URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 3000;   // ponytail: a stall is a network error, not a hang; raise if Jev's p99 ever nears it
const RETRY_MS = 500;      // backoff before the one retry on 429/529 when the reply names no Retry-After
const RETRY_MAX_MS = 2000; // cap on an honoured Retry-After — a query must never sit minutes on a throttle

// A numeric env value, or `fallback` when it is unset, blank, non-numeric or outside [min, max]. A config typo
// must never silently become 0 or NaN: a NaN threshold compares false and would wave every pick through.
export function envNumber(name: string, fallback: number, min = -Infinity, max = Infinity): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export type JevQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };

// Only what the caller reads; extra fields (confidence, type) pass through untouched, missing usage is 0.
const Reply = z.object({
  answers: z.record(z.string(), z.object({ choice: z.string(), probabilities: z.record(z.string(), z.number()) })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number().optional() }).optional(),
});
export type JevReply = z.infer<typeof Reply>;

const post = (key: string, body: string): Promise<Response> => fetch(URL, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body,
  signal: AbortSignal.timeout(TIMEOUT_MS),
});

// ONE request carrying every question. Returns the parsed reply, or null on any failure after the retry.
export async function jevChoice(toolName: string, state: unknown, questions: Record<string, JevQuestion>): Promise<JevReply | null> {
  const key = process.env.JEV_ACCESS_KEY;
  if (!key) throw new Error("JEV_ACCESS_KEY must be set (see jev-call.ts header).");
  const model = process.env.JEV_MODEL || "jev-latest";
  const body = JSON.stringify({ model, state, questions });
  emit({ kind: "llm-req", tool: toolName, model, system: Object.values(questions).map((q) => q.instructions).join("\n"), user: JSON.stringify(state), schema: questions });
  const fail = (error: string): null => { emit({ kind: "llm-resp", tool: toolName, output: { error }, inputTokens: 0, outputTokens: 0 }); return null; };
  try {
    let res = await post(key, body);
    if (res.status === 429 || res.status === 529) {
      const after = res.headers.get("retry-after");
      const wait = after !== null && Number.isFinite(Number(after)) ? Math.min(Number(after) * 1000, RETRY_MAX_MS) : RETRY_MS;
      await res.body?.cancel().catch(() => undefined); // release the throttled reply's socket before waiting
      await new Promise((r) => setTimeout(r, wait));
      res = await post(key, body);
    }
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const parsed = Reply.safeParse(await res.json());
    if (!parsed.success) return fail("malformed body");
    const inputTokens = parsed.data.usage?.input_tokens ?? 0, outputTokens = parsed.data.usage?.output_tokens ?? 0;
    usageStore.getStore()?.push({ tool: toolName, inputTokens, outputTokens, priceIn: envNumber("JEV_PRICE_IN", 0.042, 0), priceOut: 0 });
    emit({ kind: "llm-resp", tool: toolName, output: parsed.data.answers, inputTokens, outputTokens });
    return parsed.data;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e)); // network error, timeout, or a body that is not JSON
  }
}
