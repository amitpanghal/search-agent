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
});
export type Grounded = z.infer<typeof Grounded>;

// ---- gold mirror of the decision-18 QueryPlan ----

const GoldSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("player"), name: Grounded }),
  z.object({ kind: z.literal("team"), name: Grounded }),
  z.object({ kind: z.literal("either_match_team") }), // bare -- teams come from event_scope
  z.object({ kind: z.literal("event") }), // bare -- whole-match / no named owner
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

const GoldSelector = z.object({
  subject: GoldSubject,
  market_concept: Grounded, // criterion / betOfferType id
  line: Line.optional(),
  odds: Odds.optional(),
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
  })
  .refine(
    (t) => t.date_window !== null || t.kickoff_time_of_day !== null,
    "need a window or a kickoff band"
  );

const GoldEventScope = z.object({
  teams: z.array(Grounded), // each team id; may be empty (market-only query)
  players: z.array(z.object({ name: Grounded, role: z.enum(["plays", "starts", "captain"]) })),
  competition: Grounded.nullable(), // competition id
  level: z.enum(["fixture", "competition"]),
  stage: Stage.nullable(),
  time: Time.nullable(),
});

// the expected plan: status-discriminated, exactly like decision 18.
// `sport` is a free string here, validated against the runtime BUILT_SPORTS on load (E11).
const GoldPlan = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    sport: z.string().min(1),
    event_scope: GoldEventScope,
    selectors: z.array(GoldSelector).min(1),
  }),
  z.object({ status: z.literal("ambiguous"), candidates: z.array(z.string()).min(2) }),
  z.object({ status: z.literal("unsupported"), recognizedAs: z.string().nullable() }),
]);

export const GoldRecord = z.object({
  id: z.string().min(1), // gold row id, e.g. "g001"
  query: z.string().min(1), // the raw natural-language query under test
  tags: z.array(z.enum(BEHAVIOR_TAG_IDS)).min(1), // behaviors this query stresses (E7)
  expect: GoldPlan, // the grounded plan it must produce (expect.status is the abstain bucket)
  notes: z.string().optional(), // authoring rationale: coref, self-correction, edge cases
});
export type GoldRecord = z.infer<typeof GoldRecord>;
