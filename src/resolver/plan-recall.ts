// plan-recall — derive the RECALL input from the resolved ENTITIES, with NO market involved (theory §1-2).
// Per-leg-scope: the fetch is the UNION across legs — recall fetches BROAD (every leg's participants/competitions
// + the union of levels), and per-leg time/grain/co-occurrence narrowing is deferred to recall.scopeMenu. So
// nothing leg-specific (window, single grain, head-to-head) is bound here.
//
// Market-deferred union: for a player we fetch the player id AND the player's team(s) in one participant call,
// so a fixture-level player market is reachable without knowing the criterion up front.

import type { Candidate, EntityResolution, ResolvedLegScope } from "./ground-scope";
import type { SettledEntities } from "./live-menu-types";
import type { RecallInput } from "./recall";
import type { QueryPlan } from "./schema";
import type { Level } from "./offering-client";
import { boTypeId } from "./bo-types";

const settle = (r: EntityResolution | null | undefined): Candidate | null => (r && r.tier === "confident" ? r.candidates[0]! : null);

// Participants a leg contributes to the broad fetch: confident teams + players + subject, plus each player's
// club + country team (so a fixture-level player market is reachable without the criterion).
function legParticipants(leg: ResolvedLegScope): number[] {
  const teamIds = leg.teams.map(settle).filter((c): c is Candidate => c != null).map((c) => c.id);
  const players = [...leg.players, leg.subjectPlayer].map(settle).filter((c): c is Candidate => c != null);
  return [
    ...teamIds,
    ...players.map((p) => p.id),
    ...players.flatMap((p) => [p.clubId, p.countryTeamId].filter((x): x is number => x != null)),
  ];
}

export function planRecall(settled: SettledEntities, plan: QueryPlan): RecallInput {
  const legs = settled.legs;
  const participantIds = [...new Set(legs.flatMap(legParticipants))];
  const groupIds = [...new Set(legs.map((l) => settle(l.competition)?.id).filter((x): x is number => x != null))];
  const levels = [...new Set(legs.map((l) => l.level))] as Level[]; // union of leg grains -> the fan-out covers both

  // playState: bind server-side ONLY when every leg agrees (same non-null); else fetch broad (scopeMenu filters per leg).
  const states = new Set(legs.map((l) => l.playState));
  const playState = states.size === 1 && !states.has(null) ? legs[0]!.playState ?? undefined : undefined;

  // boTypes: union of the selectors' tokens -> ids, but ONLY when EVERY selector named buckets — a bare leg means
  // "all buckets", which a whole-fetch `type=` can't carry, so drop the prune entirely. Per-leg precision is FILTER's job.
  const everyTyped = plan.selectors.every((s) => (s.bo_types?.length ?? 0) > 0);
  const boTypes = everyTyped
    ? [...new Set(plan.selectors.flatMap((s) => s.bo_types ?? []).map(boTypeId).filter((x): x is number => x != null))]
    : [];

  const base: RecallInput = { levels, ...(playState ? { playState } : {}), ...(boTypes.length ? { boTypes } : {}) };
  // Model P: any named participant -> participant endpoint; else the competition group(s).
  if (participantIds.length) return { ...base, participantIds };
  return { ...base, ...(groupIds.length ? { groupIds } : {}) };
}
