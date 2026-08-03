// Extractor runner: one Bedrock call, raw query -> validated text-valued QueryPlan.
//
// Structured output via forced tool use: the QueryPlan zod schema (decision 18) is
// compiled to JSON Schema and passed as the tool's inputSchema; the model is forced to
// call that tool. No grounding here -- every value comes back as text/enum (decision 11).
// Model is BEDROCK_MODEL via the Converse API (see bedrock-call.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { QueryPlan } from "./schema";
import { builtSports } from "./sports";
import { normalizePlan } from "./normalize-plan";
import { bedrockToolCall } from "./bedrock-call";

// Label for logging/eval; the actual model id is read from BEDROCK_MODEL at call time.
export const EXTRACTION_MODEL = process.env.BEDROCK_MODEL ?? "bedrock";

const HERE = dirname(fileURLToPath(import.meta.url));
// The live SUPPORTED SPORTS menu — every built catalog, de-slugified for reading ("ice-hockey" → "ice
// hockey"). Injected so the extractor emits a sport getSport will actually match; slugify() on the read side
// turns the model's answer back into the file slug. Built once at load (catalogData/ ships with the app).
const SUPPORTED_SPORTS = [...builtSports(), "other"].join(", ");
const SYSTEM_PROMPT = readFileSync(join(HERE, "extractor-prompt.md"), "utf8")
  .replace("{{SUPPORTED_SPORTS}}", SUPPORTED_SPORTS);
const TOOL_NAME = "emit_query_plan";

// The tool inputSchema must be a top-level object, but QueryPlan is a discriminated union
// (root anyOf). Wrap it in { plan }. zod v4's native toJSONSchema inlines single-use schemas,
// so the result is self-contained (no $defs/$ref) for the API.
const PlanEnvelope = z.object({ plan: QueryPlan });
const INPUT_SCHEMA: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(PlanEnvelope) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

export async function extract(query: string): Promise<QueryPlan> {
  const envelope = await bedrockToolCall(SYSTEM_PROMPT, query, TOOL_NAME, INPUT_SCHEMA) as { plan?: unknown };

  // Some models serialize the plan field as a JSON string rather than a nested object; the payload is
  // well-formed JSON either way — decode it before validating. Weaker models also drop the { plan }
  // wrapper (the `envelope?.plan ?? envelope` fallback recovers that).
  let planValue: unknown = envelope?.plan ?? envelope;
  if (typeof planValue === "string") {
    try {
      planValue = JSON.parse(planValue);
    } catch {
      // leave as the raw string; QueryPlan validation below will surface it.
    }
  }
  normalizePlan(planValue);
  const parsed = QueryPlan.safeParse(planValue);
  if (!parsed.success) {
    throw new Error(
      `Extractor output failed QueryPlan validation: ${parsed.error.message}\n` +
        `Raw: ${JSON.stringify(planValue)}`,
    );
  }
  return parsed.data;
}
