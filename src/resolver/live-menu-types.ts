// Live-menu resolution — shared types (build plan Phase 0: "lock the new types").
//
// These are the end-to-end shapes for the post-fetch half of the new pipeline:
//   extract -> groundScope -> resolveEntities -> RECALL(live menu) -> FILTER -> RESOLVE(market) -> SELECT -> execute
// Defined up front, BEFORE any module, so the one-cut rewire (Phase 6) never fights type drift. Wired to
// nothing yet — only typechecked. Existing types (ResolvedScope, CellRef, BetOfferResponse) are reused here,
// never re-declared.

import type { ResolvedScope } from "./ground-scope";
import type { BetOfferResponse } from "./offering-client";

// Which entity cell a resolution/clarification belongs to (entity-only after the cut — the old "market:i" ref
// is gone). Owned here so resolve-entities can depend on it without a cycle. Per-leg-scope: every kind is
// indexed now (region/competition can differ across legs), and the index runs over DISTINCT grounded entities,
// not legs — the gate dedups identical entities (same grounded reference) into one cell, gated once.
export type CellRef = `region:${number}` | `competition:${number}` | `team:${number}` | `player:${number}` | `subject:${number}`;

// A clarification raised anywhere in the pipeline: an entity cell the gate couldn't pin (`CellRef`), or a
// post-fetch reason — a market not offered (`market`), a too-broad scope (`scope`), or an unresolved time
// (`time`). Same shape the old SettledScope carried; lifted out so the gate and the post-fetch steps share it.
export type Clarification = { ref: CellRef | "market" | "scope" | "time"; question: string; suggest?: number[] };

// ---- entity gate output (replaces SettledScope) ----
// resolveEntities' output: the grounded scope with every NAMED entity collapsed to `confident` (picked) or
// left non-confident with a clarification raised. Drops SettledScope's market sidecars (`marketIds` / `combos`)
// — the market is decided AFTER the fetch now, so nothing market-shaped is committed at this stage.
export type SettledEntities = ResolvedScope & {
  clarifications: Clarification[];
};

// ---- RECALL output: the live menu ----
// One market the feed actually offered, identified by (criterion id + variant). `variant` is the betoffer
// `description` ("Winner", "Top 4", "" when none) and is PART of the identity — "Finishing Position — Winner"
// and "Finishing Position — Top 4" are two distinct menu items (theory §4). `label` is the single display
// string the resolver reads (criterion label + variant); `eventId` ties a match-grain item to its fixture.
export type MenuItem = {
  criterionId: number;
  variant: string;
  label: string;
  eventId?: number;
};
// The filtered live list handed to RESOLVE — labels only, no odds/outcomes (theory §6, §8 rule 11).
export type Menu = MenuItem[];

// ---- RESOLVE(market) output ----
// The resolver's tier on its pick (theory §4): `exact` settles the bet; `close` is a same-direction
// suggestion; `none` = nothing maps (always allowed, never forced).
export type MatchLabel = "exact" | "close" | "none";
// The market the LLM picked from the live menu, at (criterion + variant) granularity, plus its tier. When
// `match === "none"` there is no pick (clarify), so `criterionId` / `variant` are left unset.
//
// NOTE (deviation from the plan's Phase-0 sketch): the tier field is named `match`, not `label` — the
// validated `.contract-probe.ts` uses `match`, and `MenuItem.label` already means the display string, so two
// different `label`s would invite bugs. Flag for the plan author; trivial to rename back if preferred.
export type MarketPick = {
  criterionId?: number;
  variant?: string;
  match: MatchLabel;
  reason?: string;
};

// ---- SELECT output ----
// The deterministic outcome lookup against the picked market's REAL outcomes (theory §5, zero LLM). `outcomeId`
// is the chosen KOutcome.id; `line` / `subject` are the resolved values. `fallback` is set ONLY when we
// degraded from an exact hit: a nearest offered line, or an honest not-offered (the subject or line the market
// doesn't carry). Absent `fallback` === exact hit.
export type Selection = {
  outcomeId?: number;
  line?: number;
  subject?: string;
  fallback?: "nearest-line" | "subject-absent" | "line-absent" | "odds-absent";
};

// ---- new executor input (replaces the FetchPlan's committed `marketIds`) ----
// One resolved market leg the thin Phase-4 execute consumes: the picked market + selected outcome, both
// decided post-fetch. `phrase` is the leg's original market wording (for display / clarify on a `none`).
export type ResolvedLeg = {
  phrase: string;
  pick: MarketPick;
  selection?: Selection;
};

// The whole post-fetch result handed to execute: the resolved legs, the live data they were resolved against
// (so execute reads odds/labels without re-fetching), and any carried-forward clarifications. Today execute
// takes a FetchPlan with pre-committed `marketIds`; that field goes away, since the market is no longer known
// before the fetch. (`data` is one response here as a Phase-0 sketch; Phase 4 firms up multi-leg recall.)
export type ExecuteInput = {
  legs: ResolvedLeg[];
  data: BetOfferResponse;
  clarifications?: Clarification[];
};
