// Per-query LLM cost accounting. Every Bedrock call funnels through bedrock-call.ts, which records its token
// usage into the per-query store below (AsyncLocalStorage — no arg threading, and safe across concurrent
// requests: each query gets its own array). runPipeline wraps each LLM stage in usageStore.run(calls, …) so
// the calls land in that query's own list; summarizeCost() turns them into the envelope's `cost` block.

import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

export type RawCall = { tool: string; inputTokens: number; outputTokens: number };
export type LlmCall = { stage: string; inputTokens: number; outputTokens: number; cost: number };
export type QueryCost = {
  calls: LlmCall[]; // one row per LLM call made for the query, in call order
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number; // USD
};

// The current query's per-call usage. bedrock-call pushes; runPipeline reads. Undefined outside a .run().
export const usageStore = new AsyncLocalStorage<RawCall[]>();

// Friendly stage label per tool (the three LLM steps). Unknown tools pass through as-is.
const STAGE: Record<string, string> = { emit_query_plan: "extract", settle_cells: "entities", pick: "market" };

// ponytail: Bedrock price is per-model and per-region — a calibration knob, not a constant. Set
// BEDROCK_PRICE_IN / BEDROCK_PRICE_OUT to your model's price in USD per 1M tokens; unset => cost reports 0
// (token counts are still real). Read at call time so a late .env load / model swap is picked up.
const costOf = (inTok: number, outTok: number): number =>
  (inTok * Number(process.env.BEDROCK_PRICE_IN ?? 0) + outTok * Number(process.env.BEDROCK_PRICE_OUT ?? 0)) / 1e6;

export function summarizeCost(raw: RawCall[]): QueryCost {
  const calls: LlmCall[] = raw.map((c) => ({
    stage: STAGE[c.tool] ?? c.tool,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cost: costOf(c.inputTokens, c.outputTokens),
  }));
  return {
    calls,
    totalInputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    totalCost: calls.reduce((s, c) => s + c.cost, 0),
  };
}

// self-check: `npx tsx src/resolver/cost.ts`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.env.BEDROCK_PRICE_IN = "3"; // $3 / 1M input
  process.env.BEDROCK_PRICE_OUT = "15"; // $15 / 1M output
  const c = summarizeCost([
    { tool: "emit_query_plan", inputTokens: 1_000_000, outputTokens: 0 },
    { tool: "pick", inputTokens: 0, outputTokens: 1_000_000 },
  ]);
  console.assert(c.totalInputTokens === 1_000_000 && c.totalOutputTokens === 1_000_000, "token totals wrong");
  console.assert(Math.abs(c.totalCost - 18) < 1e-9, `total cost expected 18, got ${c.totalCost}`);
  console.assert(c.calls[0]!.stage === "extract" && c.calls[1]!.stage === "market", "stage labels wrong");
  console.log("cost.ts self-check OK:", JSON.stringify(c));
}
