// Extractor runner: one Haiku call, raw query -> validated text-valued QueryPlan.
//
// Structured output via forced tool use: the QueryPlan zod schema (decision 18) is
// compiled to JSON Schema and passed as the tool's input_schema; the model is forced to
// call that tool. The ~11 KB system prompt is constant across calls, so it's marked for
// prompt caching. No grounding here -- every value comes back as text/enum (decision 11).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { QueryPlan } from "./schema";

export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(HERE, "extractor-prompt.md"), "utf8");

const TOOL_NAME = "emit_query_plan";

// The Anthropic tool input_schema must be a top-level object, but QueryPlan is a
// discriminated union (root anyOf). Wrap it in { plan }. zod v4's native toJSONSchema
// inlines single-use schemas, so the result is self-contained (no $defs/$ref) for the API.
const PlanEnvelope = z.object({ plan: QueryPlan });
const INPUT_SCHEMA: Anthropic.Tool.InputSchema = (() => {
  const schema = z.toJSONSchema(PlanEnvelope) as Record<string, unknown>;
  delete schema.$schema;
  return schema as Anthropic.Tool.InputSchema;
})();

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (!cached) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set (export it or put it in .env).");
    }
    cached = new Anthropic();
  }
  return cached;
}

// Haiku occasionally emits an absent OPTIONAL selector leaf (line/odds/attrFilter) as an
// explicit `null` OR an empty object `{}` rather than omitting it — both fail validation
// (`.optional()` rejects `null`; the `.refine` guards reject `{}`), and none of the three is
// ever validly empty (a line needs a `kind`, odds need ≥1 bound, attrFilter needs ≥1
// predicate). Normalize either to omitted at the parse boundary (KE-6 secondary / decision 21)
// — scoped to the three leaves, so the legitimately nullable fields (stage/time/competition)
// are untouched and the model-facing JSON Schema is unchanged (we don't advertise `null`).
const OPTIONAL_SELECTOR_LEAVES = ["line", "odds", "attrFilter"] as const;
function isBlank(v: unknown): boolean {
  return v === null || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
}
function dropBlankSelectorLeaves(plan: unknown): void {
  if (!plan || typeof plan !== "object") return;
  const selectors = (plan as { selectors?: unknown }).selectors;
  if (!Array.isArray(selectors)) return;
  for (const sel of selectors) {
    if (!sel || typeof sel !== "object") continue;
    const rec = sel as Record<string, unknown>;
    for (const k of OPTIONAL_SELECTOR_LEAVES) {
      if (isBlank(rec[k])) delete rec[k];
    }
  }
}

export async function extract(query: string): Promise<QueryPlan> {
  const msg = await client().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 2048,
    temperature: 0,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit the single structured query plan for the user's search query.",
        input_schema: INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: query }],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    const text = msg.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
    throw new Error(`Extractor returned no tool_use block. Got: ${text || "(empty)"}`);
  }

  const envelope = block.input as { plan?: unknown };
  // Haiku sometimes serializes the plan field as a JSON string rather than a nested
  // object, because the wrapped field's schema is an anyOf (the status discriminated
  // union). The payload is well-formed JSON either way — decode it before validating.
  let planValue: unknown = envelope?.plan;
  if (typeof planValue === "string") {
    try {
      planValue = JSON.parse(planValue);
    } catch {
      // leave as the raw string; QueryPlan validation below will surface it.
    }
  }
  dropBlankSelectorLeaves(planValue);
  const parsed = QueryPlan.safeParse(planValue);
  if (!parsed.success) {
    throw new Error(
      `Extractor output failed QueryPlan validation: ${parsed.error.message}\n` +
        `Raw: ${JSON.stringify(planValue)}`,
    );
  }
  return parsed.data;
}
