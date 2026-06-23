// Gold-record schema for the golden eval set (decision E9 in revisiting_Arch.md).
//
// A gold record mirrors the decision-18 `QueryPlan`, but every *groundable* leaf
// (entity / market / competition / region) is wrapped as a `Grounded` cell that
// carries the real catalog id it must resolve to. Structural / numeric / enum /
// text leaves stay literal and are graded by exact match (E2). The `id` is the
// grading source of truth; `accept[]` is diagnostic-only for now (E9).
//
// Assumes `zod` (the project's package.json arrives in plan step 2). This file is
// the schema source; the seed data lives in gold.seed.jsonl, the stamp in gold.meta.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BEHAVIOR_TAG_IDS } from "./behavior-tags";

// A groundable cell. `id` is usually a single catalog id, but may be an id SET:
// e.g. `either_match_team` + a team-total market grounds to the home+away split
// criteria, and an attrFilter set ("strikers") grounds to a participant id set.
// (This `number | number[]` widening is the one change from E9's single-id cell,
// forced by authoring g001's "team total goals" selector -- see scorer.spec.md.)
export const Grounded = z.object({
  id: z.union([z.number(), z.array(z.number()).min(1)]),
  accept: z.array(z.string()).default([]),
  // Entity-grounding ONLY: the tier the scope grounder is expected to return for this cell. Default
  // "confident" (a clean, single resolution that must CONTAIN the gold id — confident-precision). A clarify
  // tier ("ambiguous"/"shortlist") means the cell is genuinely under-specified (e.g. bare "World Cup"), so
  // the right answer is the grounder SURFACING that ambiguity with the gold id(s) in its candidate set
  // (recall@k), never a forced guess. Ignored by the market/binding axes (which use their own tier rule).
  tier: z.enum(["confident", "variants", "ambiguous", "shortlist"]).optional(),
});
export type Grounded = z.infer<typeof Grounded>;

// ---- gold mirror of the decision-18 QueryPlan ----

const GoldSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("player"), name: Grounded }),
  z.object({ kind: z.literal("team"), name: Grounded }),
  z.object({ kind: z.literal("either_match_team") }), // bare -- teams come from event_scope
  z.object({ kind: z.literal("event") }), // bare -- whole-match / no named owner
  // soft (recall-resolve Role 1): no owner + reads at >1 level -- carry the plausible kinds, don't pick
  z.object({
    kind: z.literal("soft"),
    kinds: z.array(z.enum(["player", "team", "either_match_team", "event"])).min(2),
  }),
]);

// numeric/binary are structural -- graded by exact value (E2). selection is a groundable
// pick (HT/FT cell, correct score) -> the value carries the real outcome id.
const Line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("numeric"), value: z.number(), direction: z.enum(["over", "under"]) }),
  z.object({ kind: z.literal("binary"), direction: z.enum(["yes", "no"]) }),
  z.object({ kind: z.literal("selection"), value: Grounded }),
]);

const Odds = z
  .object({ min: z.number().positive().optional(), max: z.number().positive().optional() })
  .refine((o) => o.min !== undefined || o.max !== undefined, "need >=1 bound")
  .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, "min <= max");

// position/age = text (roster feed, out of strict scope, E2); region = grounded (region table)
const AttrFilter = z
  .object({
    position: z.string().min(1).optional(),
    region: Grounded.optional(),
    ageMin: z.number().int().positive().optional(),
    ageMax: z.number().int().positive().optional(),
  })
  .refine(
    (a) => a.position || a.region || a.ageMin != null || a.ageMax != null,
    "need >=1 predicate"
  )
  .refine((a) => a.ageMin == null || a.ageMax == null || a.ageMin <= a.ageMax, "ageMin <= ageMax");

// A market_concept is graded one of three ways. EXACT (`id`): the criterion id(s) the grounder must
// contain at a clean confident|variants tier (the normal case). OFFER (`offer`): no exact market exists
// for the *stated subject*, so the right outcome is the grounder SURFACING these real alternatives as a
// `shortlist` for the executor to clarify — never a confident guess at a market that isn't there. The
// canonical case is g001's "Bruno Fernandes corners": a `player` subject with no player corners-count
// market, where the honest answer is "that isn't offered; here are the player corner markets that are".
// MAIN (`main: true`): the marketless sentinel (decision 24) — the query named no market, so the lone
// selector is `{ subject: event, market_concept: "main" }` and the grounder returns method "main" (no
// id; the executor shows the event's main betoffer). NONE (`none: true`): the stated subject has no
// market AND nothing surfaces — the grounder must ABSTAIN (method "none"), so the system clarifies rather
// than guessing (e.g. a player asked for a team-only stat, like "Bruno Fernandes corners" under WC26 —
// no player-corners market exists and there is nothing to offer). Exactly one of id|offer|main|none;
// accept[] stays diagnostic (and pairs a `none` cell to its plan selector by text).
const MarketConcept = z.union([
  z.object({
    id: z.union([z.number(), z.array(z.number()).min(1)]),
    accept: z.array(z.string()).default([]),
  }),
  z.object({
    offer: z.array(z.number()).min(1),
    accept: z.array(z.string()).default([]),
  }),
  z.object({ main: z.literal(true), accept: z.array(z.string()).default([]) }),
  z.object({ none: z.literal(true), accept: z.array(z.string()).default([]) }),
]);

const GoldSelector = z.object({
  subject: GoldSubject,
  market_concept: MarketConcept, // exact criterion id(s) OR an offer-of-alternatives (see MarketConcept)
  period: z.enum(["full", "first_half", "second_half", "extra_time"]).optional(), // mirrors Selector (schema.ts); plain enum, not grounded
  line: Line.optional(),
  odds: Odds.optional(),
  odds_sort: z.enum(["low", "high"]).optional(), // mirrors Selector (schema.ts); plain enum, not grounded
  attrFilter: AttrFilter.optional(),
});

const Stage = z
  .object({
    round: z.string().min(1).nullable(), // text -- resolved by the live layer (E2)
    ordinal: z.enum(["first", "last"]).nullable(),
    conditional: z.boolean(),
  })
  .refine((s) => s.round !== null || s.ordinal !== null, "stage needs a round or an ordinal");

const Time = z
  .object({
    date_window: z
      .object({ value: z.string().min(1), anchor: z.enum(["tournament", "now"]) })
      .nullable(),
    kickoff_time_of_day: z.string().min(1).nullable(), // text
    fixture_pick: z
      .object({ order: z.enum(["earliest", "latest"]), count: z.number().int().min(1) })
      .nullable()
      .optional(), // optional: rows that don't exercise it omit the key
  })
  .refine(
    (t) => t.date_window != null || t.kickoff_time_of_day != null || t.fixture_pick != null,
    "need a window, a kickoff band, or a fixture pick"
  );

const GoldEventScope = z.object({
  teams: z.array(Grounded), // each team id; may be empty (market-only query)
  players: z.array(z.object({ name: Grounded, role: z.enum(["plays", "starts", "captain"]) })),
  competition: Grounded.nullable(), // competition (group) id
  region: Grounded.nullable().default(null), // region branch id (country / cross-country comp branch); scopes competition. default null so pre-region gold rows still parse
  level: z.enum(["fixture", "competition"]),
  stage: Stage.nullable(),
  time: Time.nullable(),
  play_state: z.enum(["live", "prematch"]).nullable().default(null), // mirrors Selector-side play_state (schema.ts); .default(null) so pre-existing gold rows still parse
});

// the expected plan: always resolved. The extractor never abstains — it identifies the sport (free text,
// graded loosely) and resolves; an unsupported sport fails at grounding, not extraction. A marketless query
// is the lone `main` sentinel selector (market_concept {main:true}), graded like the former fixture_lookup
// (fixture-selecting facets HARD, Option A).
const GoldPlan = z.object({
  status: z.literal("resolved"),
  sport: z.string().min(1),
  event_scope: GoldEventScope,
  selectors: z.array(GoldSelector).min(1),
});

export const GoldRecord = z.object({
  id: z.string().min(1), // gold row id, e.g. "g001"
  query: z.string().min(1), // the raw natural-language query under test
  tags: z.array(z.enum(BEHAVIOR_TAG_IDS)).min(1), // behaviors this query stresses (E7)
  expect: GoldPlan, // the grounded plan it must produce (expect.status is the abstain bucket)
  // Default true: the row is graded by the extractor/market ship gate (scoreRun). Set false for a
  // pure-SCOPE row whose point is the deterministic entity gate only (entity text fed from gold) — it is
  // skipped by the LLM market gate so a not-yet-taught extractor (e.g. region routing) can't redden it.
  gradeMarket: z.boolean().default(true),
  notes: z.string().optional(), // authoring rationale: coref, self-correction, edge cases
});
export type GoldRecord = z.infer<typeof GoldRecord>;

// Load + validate the gold seed (one JSON object per line). Shared by the eval runner and the gates so the
// parse lives in one place; throws with the offending line number on bad JSON / schema.
export function loadGold(): GoldRecord[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "gold.seed.jsonl"), "utf8");
  const out: GoldRecord[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`gold.seed.jsonl line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }
    const parsed = GoldRecord.safeParse(obj);
    if (!parsed.success) {
      throw new Error(`gold.seed.jsonl line ${i + 1}: schema error — ${parsed.error.message}`);
    }
    out.push(parsed.data);
  }
  return out;
}
