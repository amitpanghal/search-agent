// RESOLVE(market) — build plan Phase 2. The LLM picks one market per BET from the FILTERED live menu and labels
// each exact | close | none (theory §4). It sees LABELS ONLY (no odds, no outcomes) and picks by `ref`; we map
// the ref back to the menu item's label (the market identity). The model may always abstain (`none`). BATCHED (Q2): legs that share
// one filtered menu resolve in a SINGLE call — the menu is sent once, not per leg — saving repeated input tokens
// and a round-trip. `resolveMarket` (singular) is a thin wrapper kept for the offline gates. The contract —
// confident-wrong ≈ 1 in 180 case-evaluations — was validated by scripts/.contract-probe.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Menu, MarketPick, MatchLabel } from "./live-menu-types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESOLVE_MARKET_MODEL = "claude-haiku-4-5-20251001";
const TOOL_NAME = "pick";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (export it or put it in .env).");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

let cachedPrompt: string | undefined;
const systemPrompt = (): string => (cachedPrompt ??= readFileSync(join(HERE, "resolve-market-prompt.md"), "utf8"));

// One pick per BET: `leg` echoes which bet it answers (so a missing/reordered pick is detectable, never silently
// mis-bound), `ref` indexes the shared menu (null = none).
const INPUT_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      description: "exactly one pick per bet",
      items: {
        type: "object",
        properties: {
          leg: { type: "integer", description: "the bet's leg index this pick answers" },
          ref: { type: ["integer", "null"], description: "the chosen menu item's ref, or null for none" },
          match: { type: "string", enum: ["exact", "close", "none"] },
          outcome: { type: ["string", "null"], description: "verbatim outcome label from the picked item's [outcomes: …], when the bet names one; else null" },
          related: { type: "array", items: { type: "integer" }, description: "the (up to 3) menu refs for other markets on the same fixture, most related first; [] only if the fixture has no other market" },
        },
        required: ["leg", "ref", "match"],
      },
    },
  },
  required: ["picks"],
};

// The raw model output for one bet (a menu ref + label), before we map it back to the market identity.
export type RawPick = { ref: number | null; match: string; outcome?: string | null; related?: number[] };
// Batched decider — one call for all bets sharing the menu. Injectable so the gate can replay captured decisions.
export type DecideManyFn = (phrases: string[], menu: Menu) => Promise<RawPick[]>;
// Singular decider — kept for the offline gates' per-phrase replay.
export type DecideFn = (phrase: string, menu: Menu) => Promise<RawPick>;

// Map one raw pick -> MarketPick. `none` (or a ref the menu doesn't carry, or a missing leg) collapses to an
// abstain with no market identity, so a hallucinated/absent pick can never become a confident wrong answer.
// `outcomeLabel` is only accepted when it appears verbatim in the item's outcomes list (anti-hallucination).
const toPick = (raw: RawPick | undefined, menu: Menu): MarketPick => {
  const match = (raw?.match ?? "none") as MatchLabel;
  if (!raw || match === "none" || raw.ref == null || !menu[raw.ref]) return { match: "none" };
  const item = menu[raw.ref]!;
  const outcomeLabel = raw.outcome && item.outcomes?.includes(raw.outcome) ? raw.outcome : undefined;
  // related: the model's suggested refs (deduped, self dropped, capped 3). No same-event filter here — execute
  // attaches a related market only if a betoffer with that label exists on the pick's OWN event, so the real
  // event guard is downstream; filtering here on the menu's example eventId only dropped valid same-event markets.
  const related = [...new Set(
    (raw.related ?? []).filter((r): r is number => typeof r === "number" && r !== raw.ref && menu[r] != null)
  )].slice(0, 3).map((r) => menu[r]!.label);
  return { label: item.label, match, ...(outcomeLabel ? { outcomeLabel } : {}), ...(related.length ? { related } : {}) };
};

// Pick + label a market for EACH phrase against the one shared filtered menu, in a single model call.
export async function resolveMarkets(phrases: string[], menu: Menu, decideFn: DecideManyFn = callModel): Promise<MarketPick[]> {
  if (!phrases.length) return [];
  if (!menu.length) return phrases.map(() => ({ match: "none", reason: "empty menu" }));
  const raws = await decideFn(phrases, menu);
  return phrases.map((_, i) => toPick(raws[i], menu));
}

// Singular convenience (one phrase). Kept so the offline gates' singular replay deciders work unchanged.
export async function resolveMarket(phrase: string, menu: Menu, decideFn?: DecideFn): Promise<MarketPick> {
  const many: DecideManyFn = decideFn ? async (ps, m) => [await decideFn(ps[0]!, m)] : callModel;
  return (await resolveMarkets([phrase], menu, many))[0]!;
}

const callModel: DecideManyFn = async (phrases, menu) => {
  const list = menu.map((m, i) => `${i}: ${m.label}${m.outcomes?.length ? `  [outcomes: ${m.outcomes.join(" | ")}]` : ""}`).join("\n");
  const bets = phrases.map((p, i) => `${i}: ${p}`).join("\n");
  const msg = await client().messages.create({
    model: RESOLVE_MARKET_MODEL,
    max_tokens: Math.min(2048, 256 + 256 * phrases.length),
    temperature: 0,
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [{ name: TOOL_NAME, description: "For each bet, pick one market from the live menu and label it exact/close/none.", input_schema: INPUT_SCHEMA }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: `LIVE menu (ref: label) — the only markets actually offered:\n${list}\n\nBETS (leg: phrase):\n${bets}\n\nFor EACH bet, pick one market by ref (or none) and label it exact/close/none.`,
      },
    ],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    const text = msg.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
    throw new Error(`resolveMarket returned no tool_use block. Got: ${text || "(empty)"}`);
  }
  // Map picks back to phrase order BY `leg` (robust to reordering); any omitted leg -> none.
  const picks = ((block.input as { picks?: unknown }).picks ?? []) as Array<{ leg?: number } & RawPick>;
  const byLeg = new Map<number, RawPick>();
  for (const p of picks) if (typeof p.leg === "number") byLeg.set(p.leg, { ref: p.ref, match: p.match, outcome: p.outcome, related: p.related });
  return phrases.map((_, i) => byLeg.get(i) ?? { ref: null, match: "none" });
};
