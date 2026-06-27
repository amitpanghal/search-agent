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
import { loadScopeCatalog } from "./scope-catalog";

const settle = (r: EntityResolution | null | undefined): Candidate | null => (r && r.tier === "confident" ? r.candidates[0]! : null);

// Participants a leg contributes to the broad fetch: confident teams + players + subject, plus each player's
// club + country team (so a fixture-level player market is reachable without the criterion).
// For competition-grain team legs, also inject the full squad: competition markets ("Tournament progress by
// the team", "to reach the final") are hung off PLAYER participant ids in the feed, never the team id itself.
// A single roster pick is fragile (e.g. the keeper at #1 may have no comp offers); the whole squad is bounded
// (+~9 betoffers probed for Norway) and guarantees at least one player pulls the team markets through.
function legParticipants(leg: ResolvedLegScope): number[] {
  const teamIds = leg.teams.map(settle).filter((c): c is Candidate => c != null).map((c) => c.id);
  const players = [...leg.players, leg.subjectPlayer].map(settle).filter((c): c is Candidate => c != null);
  const squadIds: number[] = [];
  if (leg.level === "competition") {
    const cat = loadScopeCatalog();
    for (const tid of teamIds) squadIds.push(...(cat.roster.get(tid) ?? []));
  }
  return [
    ...teamIds,
    ...players.map((p) => p.id),
    ...players.flatMap((p) => [p.clubId, p.countryTeamId].filter((x): x is number => x != null)),
    ...squadIds,
  ];
}

export function planRecall(settled: SettledEntities, plan: QueryPlan): RecallInput {
  const legs = settled.legs;
  const participantIds = [...new Set(legs.flatMap(legParticipants))];
  // groupIds come ONLY from legs that name NO participant: a participant leg is served by the participant endpoint
  // (Model P), but a bare-competition leg ("next 3 in WC26") still needs its group fetched. A mixed query emits
  // BOTH so neither leg's data starves the other (recall fetches and unions them).
  const groupIds = [...new Set(
    legs.filter((l) => legParticipants(l).length === 0).map((l) => settle(l.competition)?.id).filter((x): x is number => x != null),
  )];
  const levels = [...new Set(legs.map((l) => l.level))] as Level[]; // union of leg grains -> the fan-out covers both

  // playState: bind server-side ONLY when every leg agrees (same non-null); else fetch broad (scopeMenu filters per leg).
  const states = new Set(legs.map((l) => l.playState));
  const playState = states.size === 1 && !states.has(null) ? legs[0]!.playState ?? undefined : undefined;

  // boTypes: union of the selectors' tokens -> ids, but ONLY when EVERY selector named buckets — a bare leg means
  // "all buckets", which a whole-fetch `type=` can't carry, so drop the prune entirely. Per-leg precision is FILTER's job.
  // Competition-level legs never produce yesno (type 18) betoffers in this feed — those are fixture-level propositions;
  // competition elimination/progress markets are outright/Winner (type 4). Strip yesno from competition-leg contributions
  // so a mistaken extractor tag can't prune valid markets off the fetch.
  const YESNO_ID = boTypeId("yesno");
  const effectiveBoTypes = (s: (typeof plan.selectors)[number], leg: ResolvedLegScope): string[] => {
    const types = s.bo_types ?? [];
    return leg.level === "competition" ? types.filter((t) => boTypeId(t) !== YESNO_ID) : types;
  };
  const everyTyped = plan.selectors.every((s, i) => (effectiveBoTypes(s, legs[i]!).length > 0));
  const boTypes = everyTyped
    ? [...new Set(plan.selectors.flatMap((s, i) => effectiveBoTypes(s, legs[i]!)).map(boTypeId).filter((x): x is number => x != null))]
    : [];

  // onlyMain: bind the server-side shrink ONLY when EVERY leg is the bare-event "main" market — a mixed query
  // (one main leg + one named leg) shares this broad fetch, so a server onlyMain would starve the named leg;
  // those cases fetch broad and the main leg's MAIN-tag filter is applied per-leg downstream (resolve.ts).
  const onlyMain = plan.selectors.every((s) => s.market_concept === "main");

  const base: RecallInput = { levels, ...(playState ? { playState } : {}), ...(boTypes.length ? { boTypes } : {}), ...(onlyMain ? { onlyMain: true } : {}) };
  // Model P: a named participant -> participant endpoint; a bare-competition leg -> its group; a mixed query -> both.
  return { ...base, ...(participantIds.length ? { participantIds } : {}), ...(groupIds.length ? { groupIds } : {}) };
}
