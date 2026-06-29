// phase0-perleg-probe — Phase 0 gate for the per-leg `scope` redesign.
//
//   tsx scripts/phase0-perleg-probe.ts
//
// Mirrors src/resolver/extract.ts EXACTLY (Haiku claude-haiku-4-5, temp 0, forced tool use, the live
// extractor-prompt.md) but swaps in a PROBE-LOCAL per-leg schema — so we test the new prompt through real
// structured output WITHOUT touching shipped schema.ts. One query per call.
//
// Per query it records: rawValid (model output parses against the per-leg schema) and normValid (parses after
// the tiny Phase-2.5-style normalizer: all-null time/stage -> null, default region/play_state). Scope-logic (a)
// and no-fabrication (c) are read off the dumped JSON by hand. Full dump -> scripts/.phase0-out.json (gitignored).

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!key || process.env[key]) continue;
    process.env[key] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

// ---- probe-local per-leg schema (draft of Phase 1; field shapes copied verbatim from schema.ts) ----
const Subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("player"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("team"), name: z.string().min(1) }),
  z.object({ kind: z.literal("either_match_team"), side: z.enum(["home", "away"]).optional() }),
  z.object({ kind: z.literal("event") }),
  z.object({ kind: z.literal("soft"), kinds: z.array(z.enum(["player", "team", "either_match_team", "event"])).min(2) }),
]);
const Line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("numeric"), value: z.number(), direction: z.enum(["over", "under"]) }),
  z.object({ kind: z.literal("binary"), direction: z.enum(["yes", "no"]) }),
  z.object({ kind: z.literal("selection"), value: z.string().min(1) }),
]);
const Odds = z
  .object({ min: z.number().positive().optional(), max: z.number().positive().optional() })
  .refine((o) => o.min !== undefined || o.max !== undefined, "need >=1 bound")
  .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, "min <= max");
const Stage = z
  .object({ round: z.string().min(1).nullable(), ordinal: z.enum(["first", "last"]).nullable(), conditional: z.boolean() })
  .refine((s) => s.round !== null || s.ordinal !== null, "stage needs a round or an ordinal");
const Time = z
  .object({
    date_window: z.object({ value: z.string().min(1), anchor: z.enum(["tournament", "now"]) }).nullable(),
    kickoff_time_of_day: z.string().min(1).nullable(),
    fixture_pick: z.object({ order: z.enum(["earliest", "latest"]), count: z.number().int().min(1) }).nullable(),
  })
  .refine((t) => t.date_window !== null || t.kickoff_time_of_day !== null || t.fixture_pick !== null, "need a window/kickoff/pick");
const Scope = z.object({
  level: z.enum(["fixture", "competition"]),
  competition: z.string().min(1).nullable(),
  region: z.string().min(1).nullable(),
  teams: z.array(z.string().min(1)),
  players: z.array(z.object({ name: z.string().min(1), role: z.enum(["plays", "starts", "captain"]) })),
  stage: Stage.nullable(),
  time: Time.nullable(),
  play_state: z.enum(["live", "prematch"]).nullable(),
});
const Selector = z.object({
  subject: Subject,
  market_concept: z.string().min(1),
  line: Line.optional(),
  odds: Odds.optional(),
  odds_sort: z.enum(["low", "high"]).optional(),
  scope: Scope,
});
const QueryPlanV2 = z.object({
  status: z.literal("resolved"),
  sport: z.string().min(1),
  selectors: z.array(Selector).min(1),
});

const PlanEnvelope = z.object({ plan: QueryPlanV2 });
const INPUT_SCHEMA = (() => {
  const s = z.toJSONSchema(PlanEnvelope) as Record<string, unknown>;
  delete s.$schema;
  return s as Anthropic.Tool.InputSchema;
})();

// ---- tiny Phase-2.5-style normalizer (validity only; fabrication is scored by hand) ----
function normalize(plan: unknown): void {
  if (!plan || typeof plan !== "object") return;
  const p = plan as Record<string, unknown>;
  for (const sel of (p.selectors as Record<string, unknown>[]) ?? []) {
    const sc = sel?.scope as Record<string, unknown> | undefined;
    if (!sc || typeof sc !== "object") continue;
    const st = sc.stage as Record<string, unknown> | null;
    if (st && st.round == null && st.ordinal == null) sc.stage = null;
    const tm = sc.time as Record<string, unknown> | null;
    if (tm && tm.date_window == null && tm.kickoff_time_of_day == null && tm.fixture_pick == null) sc.time = null;
    if (!("region" in sc)) sc.region = null;
    if (sc.play_state !== "live" && sc.play_state !== "prematch") sc.play_state = null;
  }
}

const SYSTEM_PROMPT = readFileSync(join(ROOT, "src/resolver/extractor-prompt.md"), "utf8");
const MODEL = "claude-haiku-4-5-20251001";
const TOOL_NAME = "emit_query_plan";

const QUERIES = [
  "Mbappé most goals in WC26 and to score in his next game",
  "Kane 1st goalscorer in his next game and golden ball in WC26",
  "Brazil to win the World Cup and over 2.5 goals in their next match",
  "Who wins Group H and Spain vs Germany match result",
  "England outright winner and Bellingham anytime scorer on Sunday",
  "Real Madrid to win La Liga and Mbappé top scorer in the Champions League",
  "Most corners in tonight's Italy game and Germany clean sheet tomorrow",
  "Germany vs Italy quarterfinal: Musiala over 1.5 shots and team total tackles over 18.5",
  "Spain vs France match result and both teams to score",
  "Mbappé most goals in WC26, France to reach the final, and Mbappé to score in France's next game",
  "Across WC26: Brazil outright winner, golden boot to a Brazilian, and Vinicius anytime scorer in their opening match",
  "Top scorer of the group stage and Kane to score in the round of 16",
  "Haaland golden boot and his team to win their next game",
  "World Cup outright winner, top scorer, and most clean sheets",
];

const client = new Anthropic();

async function runOne(query: string): Promise<unknown> {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    temperature: 0,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: TOOL_NAME, description: "Emit the single structured query plan for the user's search query.", input_schema: INPUT_SCHEMA }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: query }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("no tool_use block");
  let planValue: unknown = (block.input as { plan?: unknown }).plan;
  if (typeof planValue === "string") {
    try { planValue = JSON.parse(planValue); } catch { /* surfaced by validation */ }
  }
  return planValue;
}

async function main() {
  const results: unknown[] = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i]!;
    let raw: unknown;
    try {
      raw = await runOne(q);
    } catch (e) {
      console.log(`#${i + 1}  ERROR  ${(e as Error).message}`);
      results.push({ n: i + 1, query: q, error: String(e) });
      continue;
    }
    const rawValid = QueryPlanV2.safeParse(raw).success;
    const norm = JSON.parse(JSON.stringify(raw));
    normalize(norm);
    const normParsed = QueryPlanV2.safeParse(norm);
    const normValid = normParsed.success;
    const sels = (raw as { selectors?: unknown[] })?.selectors ?? [];
    const levels = sels.map((s) => (s as { scope?: { level?: string } })?.scope?.level ?? "?").join("+");
    console.log(
      `#${String(i + 1).padStart(2)}  legs=${sels.length}  levels=${levels.padEnd(24)}  rawValid=${rawValid ? "Y" : "N"}  normValid=${normValid ? "Y" : "N"}` +
        (normValid ? "" : `  << ${normParsed.success ? "" : normParsed.error.issues.map((x) => x.path.join(".") + ":" + x.message).join("; ")}`),
    );
    results.push({ n: i + 1, query: q, rawValid, normValid, raw });
  }
  writeFileSync(join(HERE, ".phase0-out.json"), JSON.stringify(results, null, 2));
  console.log("\nfull dump -> scripts/.phase0-out.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
