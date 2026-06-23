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
import { BO_TYPE_KEYS, BO_TYPE_REFERENCE } from "./bo-types";

export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(HERE, "extractor-prompt.md"), "utf8").replace(
  "{{BO_TYPES}}",
  BO_TYPE_REFERENCE,
);
const KNOWN_BO_TYPES = new Set<string>(BO_TYPE_KEYS);

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

// Haiku occasionally emits a structurally-broken selector that the schema rejects but that has a clear
// fail-safe normalization. Repair these at the parse boundary (KE-6 / decision 21) rather than throw —
// the model is now trying to resolve every query (never abstaining), so the odd malformed leaf shouldn't
// sink the whole query. Each repair maps an unusable-but-clear shape to its fail-safe:
//   1. An absent OPTIONAL selector leaf (line/odds/attrFilter) emitted as `null` or `{}` → omit it.
//   2. A line that can't satisfy its kind (e.g. a numeric skeleton with `value: null`) → drop it
//      (= "all offered lines"), the same fail-open as a blank leaf.
//   3. A `team` subject with no name (the schema requires one) → coerce to the bare `event` subject.
//   4. An all-null `stage`/`time` skeleton (Haiku emits this instead of `null`) → coerce to `null`
//      (the "needs a round/ordinal" / "needs a window/kickoff" refines reject the empty object).
const OPTIONAL_SELECTOR_LEAVES = ["line", "odds", "attrFilter"] as const;
function isBlank(v: unknown): boolean {
  return v === null || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
}
function isUsableLine(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  if (l.kind === "numeric") return typeof l.value === "number" && (l.direction === "over" || l.direction === "under");
  if (l.kind === "binary") return l.direction === "yes" || l.direction === "no";
  if (l.kind === "selection") return typeof l.value === "string" && l.value.length > 0;
  return false;
}
// Sanitize `odds`: drop any min/max that isn't a positive number; an odds object left with no valid bound is
// removed (the schema needs >=1 positive bound). Repairs the `{ min: 0 }` placeholder a superlative like
// "shortest odds" produces — Haiku invents a 0 bound when "odds" is named with no real number.
function sanitizeOdds(rec: Record<string, unknown>): void {
  const o = rec.odds as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object") return;
  for (const k of ["min", "max"] as const) {
    if (!(typeof o[k] === "number" && (o[k] as number) > 0)) delete o[k];
  }
  if (o.min === undefined && o.max === undefined) delete rec.odds;
}
// Sanitize `attrFilter`: drop null/empty/invalid predicates; an attrFilter left with no real predicate is
// removed (the schema needs >=1). Repairs the `{ region: null }` placeholder Haiku tacks on when there is no
// actual outcome filter.
function sanitizeAttrFilter(rec: Record<string, unknown>): void {
  const a = rec.attrFilter as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return;
  for (const k of ["position", "region"] as const) {
    if (!(typeof a[k] === "string" && (a[k] as string).length > 0)) delete a[k];
  }
  for (const k of ["ageMin", "ageMax"] as const) {
    if (!(typeof a[k] === "number" && Number.isInteger(a[k]) && (a[k] as number) > 0)) delete a[k];
  }
  if (a.position === undefined && a.region === undefined && a.ageMin === undefined && a.ageMax === undefined) delete rec.attrFilter;
}
// Sanitize `bo_types`: keep only known bucket tokens (a hallucinated/garbage token is dropped), dedupe, and
// remove the field entirely if nothing valid remains (fail-open — the resolver then sees all buckets).
function sanitizeBoTypes(rec: Record<string, unknown>): void {
  const bt = rec.bo_types;
  if (!Array.isArray(bt)) { delete rec.bo_types; return; }
  const kept = [...new Set(bt.filter((t): t is string => typeof t === "string" && KNOWN_BO_TYPES.has(t)))];
  if (kept.length) rec.bo_types = kept;
  else delete rec.bo_types;
}
function normalizePlan(plan: unknown): void {
  if (!plan || typeof plan !== "object") return;
  const p = plan as Record<string, unknown>;

  // event_scope: an all-null stage/time skeleton fails its refine -> coerce to null (omit the facet).
  const es = p.event_scope as Record<string, unknown> | undefined;
  if (es && typeof es === "object") {
    const st = es.stage as Record<string, unknown> | null;
    if (st && st.round == null && st.ordinal == null) es.stage = null;
    const tm = es.time as Record<string, unknown> | null;
    if (tm && tm.date_window == null && tm.kickoff_time_of_day == null && tm.fixture_pick == null) es.time = null;
    // `region` is a newer event_scope field; until the extractor prompt is taught to populate it, an
    // older response may omit it. Default the absent key to null so the (required-nullable) schema parses.
    if (!("region" in es)) es.region = null;
    // `play_state` is required-nullable too: default an absent key to null, and coerce any value that isn't
    // a valid state to null (the enum would otherwise reject "in-play"/garbage and sink the whole plan).
    if (es.play_state !== "live" && es.play_state !== "prematch") es.play_state = null;
  }

  // selectors: drop blank/unusable optional leaves; coerce a nameless `team` subject -> `event`.
  const selectors = p.selectors;
  if (!Array.isArray(selectors)) return;
  for (const sel of selectors) {
    if (!sel || typeof sel !== "object") continue;
    const rec = sel as Record<string, unknown>;
    for (const k of OPTIONAL_SELECTOR_LEAVES) {
      if (isBlank(rec[k])) delete rec[k];
    }
    if (rec.line !== undefined && !isUsableLine(rec.line)) delete rec.line;
    sanitizeOdds(rec);
    sanitizeAttrFilter(rec);
    sanitizeBoTypes(rec);
    // `odds_sort` is an optional enum: drop anything that isn't "low"/"high" (incl. null/{}) so the schema parses.
    if ("odds_sort" in rec && rec.odds_sort !== "low" && rec.odds_sort !== "high") delete rec.odds_sort;
    const subj = rec.subject as Record<string, unknown> | undefined;
    if (subj && subj.kind === "team" && (typeof subj.name !== "string" || subj.name.length === 0)) {
      rec.subject = { kind: "event" };
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
