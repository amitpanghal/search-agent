// Per-query LLM cost accounting. Every model call funnels through bedrock-call.ts or openai-call.ts, which record
// its token usage into the per-query store below (AsyncLocalStorage — no arg threading, and safe across
// concurrent requests: each query gets its own array). runPipeline wraps each LLM stage in
// usageStore.run(calls, …) so the calls land in that query's own list; summarizeCost() turns them into the
// envelope's `cost` block. A row prices from its own priceIn/priceOut when it carries them (OpenAI), else from
// BEDROCK_PRICE_* (Bedrock) — two transports, one cost block.

import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

// priceIn/priceOut: USD per 1M tokens for THIS row; unset means a Bedrock row, priced from BEDROCK_PRICE_*.
// cachedTokens: the part of inputTokens the provider served from its prompt cache, priced at priceCached.
// cacheWriteTokens: the part of inputTokens written INTO the cache (GPT-5.6+ bills 1.25× input), priced at
// priceCacheWrite; a row without that price bills them as plain input.
export type RawCall = { tool: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number; priceIn?: number; priceOut?: number; priceCached?: number; priceCacheWrite?: number };
export type LlmCall = { stage: string; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; cost: number };
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
const costOf = (c: RawCall): number => {
  const priceIn = c.priceIn ?? Number(process.env.BEDROCK_PRICE_IN ?? 0);
  const cached = c.cachedTokens ?? 0, written = c.cacheWriteTokens ?? 0;
  return ((c.inputTokens - cached - written) * priceIn + cached * (c.priceCached ?? 0) + written * (c.priceCacheWrite ?? priceIn) +
    c.outputTokens * (c.priceOut ?? Number(process.env.BEDROCK_PRICE_OUT ?? 0))) / 1e6;
};

export function summarizeCost(raw: RawCall[]): QueryCost {
  const calls: LlmCall[] = raw.map((c) => ({
    stage: STAGE[c.tool] ?? c.tool,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cachedTokens: c.cachedTokens ?? 0,
    cacheWriteTokens: c.cacheWriteTokens ?? 0,
    cost: costOf(c),
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
    { tool: "settle_cells", inputTokens: 1_000_000, outputTokens: 0, priceIn: 0.042, priceOut: 0 }, // a row priced on its own
    { tool: "emit_query_plan", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 900_000, priceIn: 0.10, priceOut: 0.50, priceCached: 0.01 }, // an OpenAI row: 100K full + 900K cached
    { tool: "pick", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 900_000, cacheWriteTokens: 100_000, priceIn: 0.10, priceOut: 0.50, priceCached: 0.01, priceCacheWrite: 0.125 }, // same, but the 100K were cache writes
  ]);
  console.assert(c.totalInputTokens === 4_000_000 && c.totalOutputTokens === 1_000_000, "token totals wrong");
  console.assert(Math.abs(c.totalCost - 18.0825) < 1e-9, `total cost expected 18.0825, got ${c.totalCost}`); // 18.042 + 0.019 + (0.0125 + 0.009)
  console.assert(c.calls[0]!.stage === "extract" && c.calls[1]!.stage === "market" && c.calls[2]!.stage === "entities", "stage labels wrong");
  console.log("cost.ts self-check OK:", JSON.stringify(c));
}
