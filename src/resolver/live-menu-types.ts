// Live-menu resolution — shared types (build plan Phase 0: "lock the new types").
//
// These are the end-to-end shapes for the post-fetch half of the new pipeline:
//   extract -> groundScope -> resolveEntities -> RECALL(live menu) -> FILTER -> RESOLVE(market) -> SELECT -> execute
// Defined up front, BEFORE any module, so the one-cut rewire (Phase 6) never fights type drift. Wired to
// nothing yet — only typechecked. Existing types (ResolvedScope, CellRef, BetOfferResponse) are reused here,
// never re-declared.

import type { ResolvedScope } from "./ground-scope";
import type { BetOfferResponse, KEvent } from "./offering-client";
import type { Combination } from "./combinations";

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
// One market the feed actually offered, identified by its `label` — the single display string the resolver
// reads AND the market's identity: criterion `englishLabel` + the betoffer `description` variant ("Winner",
// "Top 4", "" when none). So "Finishing Position — Winner" / "— Top 4" (same criterion, different variant) and
// "To score at least 2 goals" / "— 3 goals" (SAME criterion id, different englishLabel) are all distinct items
// (theory §4). englishLabel — not the localized label — keeps the identity locale-stable. The criterion id is
// NOT part of the identity: it can't tell the at-least-N family apart, and it's invisible to the resolver
// anyway. `eventId` ties a match-grain item to its fixture.
export type MenuItem = {
  label: string;
  eventId?: number;
  outcomes?: string[]; // meaningful outcome labels (named, non-participant) — set only when they disambiguate the market
};
// The filtered live list handed to RESOLVE — labels only (plus outcomes on ambiguous markets).
export type Menu = MenuItem[];

// ---- RESOLVE(market) output ----
// The resolver's tier on its pick (theory §4): `exact` settles the bet; `close` is a same-direction
// suggestion; `none` = nothing maps (always allowed, never forced).
export type MatchLabel = "exact" | "close" | "none";
// The market the LLM picked from the live menu, carried by its `label` (the MenuItem identity), plus its tier.
// When `match === "none"` there is no pick (clarify), so `label` is left unset. The tier field is `match`, not
// `label`, so it never collides with the identity `label` (which mirrors MenuItem.label).
export type MarketPick = {
  label?: string;
  match: MatchLabel;
  outcomeLabel?: string; // the resolver-picked outcome when the menu item exposed outcomes (verbatim from MenuItem.outcomes)
  related?: string[]; // menu labels for related markets (same fixture, intent-ranked, most direct first; absent = none)
};

// ---- SELECT output ----
// The deterministic outcome lookup against the picked market's REAL outcomes (theory §5, zero LLM). `outcomeId`
// is the SELECTED outcome (the query's line/side match); `outcomeIds` is the participant's WHOLE pool in this
// market — every line and side they're offered, returned so the consumer can show alternatives with the matched
// one flagged. `selectedIds` is the pick(s) to flag: usually just `outcomeId`, but a RELATIONAL multi-fixture
// leg ("home teams to win in the next 2 games") picks one outcome PER fixture, so it lists them all — execute
// flags each in its own event block. `line` / `subject` are the resolved values. `fallback` is set ONLY on an
// honest not-offered (the subject, or the asked side, the market doesn't carry). Absent `fallback` === a pick.
export type Selection = {
  outcomeId?: number;
  outcomeIds?: number[];
  selectedIds?: number[];
  line?: number;
  subject?: string;
  fallback?: "subject-absent" | "line-absent" | "odds-absent";
};

// ---- new executor input (replaces the FetchPlan's committed `marketIds`) ----
// One resolved market leg the thin Phase-4 execute consumes: the picked market + selected outcome, both
// decided post-fetch. `phrase` is the leg's original market wording (for display / clarify on a `none`).
export type ResolvedLeg = {
  phrase: string;
  pick: MarketPick;
  selection?: Selection;
  // the grounded participant id of this leg's subject — carried so execute can trim related-market suggestions
  // to the SAME subject as the highlighted pick (a player-anchored query shouldn't list every player again).
  subjectId?: number;
  // why a `none`-pick leg has no result: the scope matched no fixture (`no-fixture`, `scope` = the team it
  // wanted) vs a fixture existed but no market fit the concept (`no-market`). Drives the clarify wording.
  unavailable?: { kind: "no-fixture" | "no-market"; scope?: string };
};

// The whole post-fetch result handed to execute: the resolved legs, the live data they were resolved against
// (so execute reads odds/labels without re-fetching), and any carried-forward clarifications. Today execute
// takes a FetchPlan with pre-committed `marketIds`; that field goes away, since the market is no longer known
// before the fetch. (`data` is one response here as a Phase-0 sketch; Phase 4 firms up multi-leg recall.)
export type ExecuteInput = {
  legs: ResolvedLeg[];
  data: BetOfferResponse;
  clarifications?: Clarification[];
  notes?: string[];        // caller-built notes (e.g. unresolved time — needs the per-leg phrase)
  truncated?: boolean;     // recall hit the 2000-betoffer cap / a capped group fan-out
  fetchFailed?: boolean;   // a group/participant fetch errored (degraded to empty, not thrown)
  combinations?: Combination[]; // pre-configured combinations already ranked/capped for this query (Bet-builder Phase 1)
  combinationEvents?: KEvent[]; // events referenced by a combination leg that are NOT among the shown results — for envelope enrichment
};
