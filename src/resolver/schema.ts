// The extractor's output schema — the decision-18 `QueryPlan`, TEXT-valued.
//
// This is what the single Haiku extraction call emits via structured output, BEFORE any
// grounding: `market_concept`, entity names, `competition`, `attrFilter` position/region,
// stage round, and time windows are all plain strings. Grounding maps text -> catalog ids
// downstream, in place. The eval's `gold-record.ts` is the same shape with every groundable
// leaf wrapped in a `Grounded` cell that carries the real id; keep the two in sync.
//
// Assumes `zod`. `BUILT_SPORTS` is generated at startup from data/football/groups.json
// (decision 17) — today only FOOTBALL is built, so the `sport` enum and the `ambiguous`
// candidates are single-valued for now.

import { z } from "zod";

export const BUILT_SPORTS = ["FOOTBALL"] as const;

// Who owns a market. `player.name` is OPTIONAL (decision 21): named, a specific player owns a
// line ("Mbappé shots"); omitted, it's a generic per-player market ("player shots") whose
// outcomes the executor returns for every player. `team` still carries a required name;
// either_match_team/event are bare tags.
const Subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("player"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("team"), name: z.string().min(1) }),
  z.object({ kind: z.literal("either_match_team") }),
  z.object({ kind: z.literal("event") }),
]);

// A line picks the market outcome: a numeric threshold on a counted stat, a yes/no side, or a
// named multi-outcome selection (HT/FT, correct score). Omitted entirely = "all offered lines".
// `selection.value` is text close to the query wording; grounding maps it to an outcome id.
const Line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("numeric"), value: z.number(), direction: z.enum(["over", "under"]) }),
  z.object({ kind: z.literal("binary"), direction: z.enum(["yes", "no"]) }),
  z.object({ kind: z.literal("selection"), value: z.string().min(1) }),
]);

// A price bound on the outcome. At least one of min/max; min <= max.
const Odds = z
  .object({ min: z.number().positive().optional(), max: z.number().positive().optional() })
  .refine((o) => o.min !== undefined || o.max !== undefined, "need >=1 bound")
  .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, "min <= max");

// Filters participant OUTCOMES within a market (position/region/age) — not a subject.
// Age bounds are INCLUSIVE; the extractor normalises ("under 23" -> ageMax: 22).
const AttrFilter = z
  .object({
    position: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    ageMin: z.number().int().positive().optional(),
    ageMax: z.number().int().positive().optional(),
  })
  .refine((a) => a.position || a.region || a.ageMin != null || a.ageMax != null, "need >=1 predicate")
  .refine((a) => a.ageMin == null || a.ageMax == null || a.ageMin <= a.ageMax, "ageMin <= ageMax");

const Selector = z.object({
  subject: Subject,
  market_concept: z.string().min(1),
  line: Line.optional(),
  odds: Odds.optional(),
  attrFilter: AttrFilter.optional(),
});

const Stage = z
  .object({
    round: z.string().min(1).nullable(),
    ordinal: z.enum(["first", "last"]).nullable(),
    conditional: z.boolean(),
  })
  .refine((s) => s.round !== null || s.ordinal !== null, "stage needs a round or an ordinal");

const Time = z
  .object({
    date_window: z
      .object({ value: z.string().min(1), anchor: z.enum(["tournament", "now"]) })
      .nullable(),
    kickoff_time_of_day: z.string().min(1).nullable(),
  })
  .refine((t) => t.date_window !== null || t.kickoff_time_of_day !== null, "need a window or a kickoff band");

const EventScope = z.object({
  teams: z.array(z.string().min(1)),
  players: z.array(z.object({ name: z.string().min(1), role: z.enum(["plays", "starts", "captain"]) })),
  competition: z.string().min(1).nullable(),
  level: z.enum(["fixture", "competition"]),
  stage: Stage.nullable(),
  time: Time.nullable(),
});

// Status-discriminated: no event_scope/selectors exist unless status === "resolved", so
// grounding can never run on an unconfirmed sport. ambiguous/unsupported are abstentions.
export const QueryPlan = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    sport: z.enum(BUILT_SPORTS),
    event_scope: EventScope,
    selectors: z.array(Selector).min(1),
  }),
  z.object({ status: z.literal("ambiguous"), candidates: z.array(z.enum(BUILT_SPORTS)).min(2) }),
  z.object({ status: z.literal("unsupported"), recognizedAs: z.string().nullable() }),
]);
export type QueryPlan = z.infer<typeof QueryPlan>;
