// scratch: DOES THE EXTRACTOR EMIT bo_types AS EXPECTED? One Haiku call per query, mirroring production
// extraction EXACTLY (same model, same real extractor-prompt.md, same QueryPlan tool schema) but with the
// planned `bo_types` field injected into (a) the prompt — the rule + the 25-bucket reference block — and
// (b) the per-selector tool schema. Nothing in src/ is touched. Reports, per query:
//   - each selector's market_concept + the bo_types it returned (token -> label)
//   - shortlist SIZE (tightness) and whether the CORRECT bucket(s) are INCLUDED (the never-under-drop test)
//   - any out-of-vocab token (would the real fail-open parse have to drop it?)
//   - PASS/FAIL vs a hand-set expectation; multi-leg cases stress the known flattening risk.
//
// Run:  npx tsx scripts/.botype-extract-probe.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { EXTRACTION_MODEL } from "../src/resolver/extract";
import { QueryPlan } from "../src/resolver/schema";

// Node 18 has no process.loadEnvFile — parse .env by hand (only fills keys not already in env).
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
} catch { /* no .env; key may already be exported */ }

const TYPES: Record<string, { id: number; label: string; gloss: string }> = JSON.parse(
  readFileSync(new URL("../data/betoffertypes.json", import.meta.url), "utf8"),
);
const KEYS = Object.keys(TYPES);
const KEYSET = new Set(KEYS);
const label = (t: string) => TYPES[t]?.label ?? "(UNKNOWN TOKEN)";
const REFERENCE = Object.entries(TYPES).map(([k, v]) => `- ${k} — ${v.label}: ${v.gloss}`).join("\n");

// The planned prompt addition, verbatim from the plan (rule + injected list), appended to the REAL prompt.
const BO_TYPES_SECTION = `

## bo_types (per selector, optional) — candidate market-type buckets

Each selector object additionally accepts an optional \`bo_types\` array.

You are given a fixed list of coarse market-type buckets (token — name):

${REFERENCE}

For each selector, return \`bo_types\`: every bucket token that could **plausibly** carry this market — a
shortlist to narrow the search, not an exact pick. **Keep generously; drop a bucket only when it clearly
cannot hold the market. When in doubt, or if nothing can be ruled out, omit the field** (= keep all
buckets). Buckets overlap — when more than one could fit, include them all rather than committing to one.
Do not encode the line, period, or subject here — each has its own facet.
`;

const PROMPT_PATH = new URL("../src/resolver/extractor-prompt.md", import.meta.url);
const SYSTEM_PROMPT = readFileSync(PROMPT_PATH, "utf8") + BO_TYPES_SECTION;

// Build the production tool schema, then inject an optional bo_types array into the Selector node (the object
// node carrying both `subject` and `market_concept`). Faithful to the plan's schema edit.
function buildInputSchema(): Anthropic.Tool.InputSchema {
  const schema = z.toJSONSchema(z.object({ plan: QueryPlan })) as Record<string, unknown>;
  delete schema.$schema;
  let injected = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const props = n.properties as Record<string, unknown> | undefined;
    if (props && "subject" in props && "market_concept" in props && !("bo_types" in props)) {
      props.bo_types = {
        type: "array",
        items: { type: "string", enum: KEYS },
        description: "Over-inclusive shortlist of plausible market-type buckets; omit when unsure.",
      };
      injected++;
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v);
    }
  };
  visit(schema);
  if (injected === 0) throw new Error("could not find the Selector node to inject bo_types");
  return schema as Anthropic.Tool.InputSchema;
}
const INPUT_SCHEMA = buildInputSchema();

// Expectation groups: a query PASSES if the UNION of all selectors' bo_types intersects every `need` group.
// `omit: true` means the right behavior is to emit nothing (no clean bucket / vague query).
const WIN_1X2 = ["onecrosstwo", "result", "doublechance"];
const OUTRIGHT = ["outright", "result"];
const OU = ["overunder", "asianoverunder"];
const HTFT = ["htft"];
const BTTS = ["yesno"];

type Case = { q: string; need?: string[][]; omit?: boolean; note?: string };
const CASES: Case[] = [
  { q: "France to win at half time and at full time (half time / full time)", need: [HTFT] },
  { q: "Will there be over 2.5 goals in France's next match?", need: [OU] },
  { q: "Mbappé to score against Brazil", need: [["playeroccurrenceline"]], note: "the bucket that was being MISSED — must now appear" },
  { q: "Both teams to score in the final", need: [BTTS], note: "BTTS usually lives under a Yes/No type" },
  { q: "Who will win the World Cup 2026?", need: [OUTRIGHT] },
  { q: "France vs Brazil — match result (home win, draw, or away win)", need: [WIN_1X2] },
  { q: "Correct score 2-1 to France in the final", need: [["result"]], note: "id 3 = Correct Score (was mislabeled 'Result' before)" },
  { q: "Stack France winning HT/FT with Mbappé scoring twice in next game", need: [HTFT, ["playeroccurrenceline"]], note: "MULTI-LEG flattening stress (the showcase query)" },
  { q: "France to win, over 2.5 total goals, and Mbappé to score", need: [WIN_1X2, OU, ["playeroccurrenceline"]], note: "3-leg flattening stress" },
  { q: "What's the best bet for the final?", omit: true, note: "vague -> sentinel selector, market unknown" },
];

const client = new Anthropic();

async function extractWithBoTypes(query: string): Promise<{ selectors: { market_concept: string; bo_types?: string[] }[] }> {
  const msg = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 2048,
    temperature: 0,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "emit_query_plan", description: "Emit the single structured query plan for the user's search query.", input_schema: INPUT_SCHEMA }],
    tool_choice: { type: "tool", name: "emit_query_plan" },
    messages: [{ role: "user", content: query }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("no tool_use block");
  let plan: any = (block.input as { plan?: unknown }).plan;
  if (typeof plan === "string") plan = JSON.parse(plan);
  return { selectors: Array.isArray(plan?.selectors) ? plan.selectors : [] };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set (and .env had none).");
  console.log(`buckets in catalog: ${KEYS.length}\n`);
  let pass = 0;
  const summary: string[] = [];

  for (const c of CASES) {
    console.log("═".repeat(100));
    console.log(`QUERY: ${c.q}`);
    if (c.note) console.log(`  (${c.note})`);
    let result;
    try {
      result = await extractWithBoTypes(c.q);
    } catch (e) {
      console.log(`  EXTRACT ERROR: ${(e as Error).message}`);
      summary.push(`ERR  ${c.q}`);
      continue;
    }

    const union = new Set<string>();
    const unknown = new Set<string>();
    for (const [i, sel] of result.selectors.entries()) {
      const bt = sel.bo_types ?? [];
      bt.forEach((t) => (KEYSET.has(t) ? union.add(t) : unknown.add(t)));
      const shown = bt.length ? bt.map((t) => (KEYSET.has(t) ? `${t}→${label(t)}` : `${t}⚠UNKNOWN`)).join(", ") : "(omitted = keep all)";
      console.log(`  leg[${i}] "${sel.market_concept}"  [${bt.length}] ${shown}`);
    }

    let verdict: string;
    if (c.omit) {
      const ok = union.size === 0;
      verdict = ok ? "PASS (omitted as expected)" : `OVER-INCLUDED (acceptable, keeps all-ish): ${[...union].join(", ")}`;
      if (ok) pass++;
    } else {
      const missing = (c.need ?? []).filter((grp) => !grp.some((t) => union.has(t)));
      const ok = missing.length === 0;
      verdict = ok
        ? `PASS — correct bucket(s) included; union size ${union.size}`
        : `FAIL — UNDER-DROPPED: missing a token from each of ${JSON.stringify(missing)} (union: [${[...union].join(", ")}])`;
      if (ok) pass++;
    }
    if (unknown.size) verdict += `  | OUT-OF-VOCAB emitted: ${[...unknown].join(", ")} (real parse would drop these)`;
    console.log(`  => ${verdict}`);
    summary.push(`${verdict.startsWith("PASS") ? "PASS" : "----"} ${c.q}`);
  }

  console.log("\n" + "═".repeat(100));
  console.log(`SUMMARY: ${pass}/${CASES.length} passed`);
  summary.forEach((s) => console.log("  " + s));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
