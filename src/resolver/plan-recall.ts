// plan-recall — build plan Phase 6. Derive the RECALL input (endpoint via ids + grain) from the resolved
// ENTITIES, with NO market involved (theory §1-2). This replaces the market-laden FetchPlan: recall decides the
// endpoint itself (Model P — a named participant wins, else the competition group), so here we only collect the
// confident ids + the coarse grain + playState.
//
// Market-deferred union: for a player we fetch the player id AND the player's team(s) in one participant call,
// so a fixture-level player market is reachable without knowing the criterion up front.

import type { Candidate, EntityResolution } from "./ground-scope";
import type { SettledEntities } from "./live-menu-types";
import type { RecallInput, Grain } from "./recall";
import { boTypeId } from "./bo-types";
import { resolveTimeWindow, hasWindow } from "./time-window";

const settle = (r: EntityResolution | null | undefined): Candidate | null => (r && r.tier === "confident" ? r.candidates[0]! : null);

export function planRecall(settled: SettledEntities): RecallInput {
  const unit = settled.units[0]!;
  const compId = settle(settled.competition)?.id ?? null;
  const teamIds = unit.teams.map(settle).filter((c): c is Candidate => c != null).map((c) => c.id);
  const players = [...unit.players, ...unit.subjectPlayers].map(settle).filter((c): c is Candidate => c != null);
  const playerIds = players.map((p) => p.id);
  // union: each player's club + country team, so a fixture-level player market is reachable without the criterion
  const playerTeamIds = players.flatMap((p) => [p.clubId, p.countryTeamId].filter((x): x is number => x != null));
  const participantIds = [...new Set([...teamIds, ...playerIds, ...playerTeamIds])];
  // 2+ NAMED teams = a matchup: the fixture must contain ALL of them (head-to-head). Kept SEPARATE from the
  // fetch union above, which stays broad for player reachability. recall applies this to MATCH events only.
  const matchTeamIds = teamIds.length >= 2 ? [...new Set(teamIds)] : [];
  const mt = matchTeamIds.length ? { matchTeamIds } : {};

  const grain: Grain = settled.level === "competition" ? "competition" : "match";
  const playState = settled.playState ?? undefined; // "live" | "prematch" | null -> drop null
  // server-side fetch shrink: the union of every selector's bo_types tokens -> ids (over-inclusive by design).
  // The `type=` param filters the WHOLE fetch, so the union is only a safe over-set when EVERY selector named
  // its buckets. A selector that OMITS bo_types means "keep all buckets" (extractor contract) — a meaning a
  // `type=` filter can't carry — so if ANY leg omits, drop the prune entirely (fetch all types) rather than let
  // another leg's narrow set starve it. Per-leg precision is still applied later by FILTER's keepTypes.
  const everyLegTyped = unit.selectors.every((s) => (s.bo_types?.length ?? 0) > 0);
  const boTypes = everyLegTyped
    ? [...new Set(unit.selectors.flatMap((s) => s.bo_types ?? []).map(boTypeId).filter((x): x is number => x != null))]
    : [];
  const bo = boTypes.length ? { boTypes } : {};

  // Resolve the time PHRASE into a concrete window here (deterministic); recall applies it post-fetch on
  // MATCH-tagged events only (endpoint-independent). tournamentStart is unavailable on the participant path,
  // so tournament-anchored DATE phrases are ignored by resolveTimeWindow (rare); clock-relative phrases + the
  // fixture_pick `from=now` floor still apply. Carry the window when it has a real time bound OR a fixture pick.
  const window = settled.time ? resolveTimeWindow(settled.time, { now: new Date() }) : undefined;
  const win = window && (hasWindow(window) || window.pick) ? { window } : {};

  // Model P: any named participant -> the participant endpoint; otherwise the competition group.
  if (participantIds.length) return { grain, participantIds, ...(playState ? { playState } : {}), ...bo, ...win, ...mt };
  return { grain, ...(compId != null ? { groupId: compId } : {}), ...(playState ? { playState } : {}), ...bo, ...win, ...mt };
}
