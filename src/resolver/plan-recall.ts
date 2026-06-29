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
import { loadScopeCatalog, type ScopeCatalog } from "./scope-catalog";

const settle = (r: EntityResolution | null | undefined): Candidate | null => (r && r.tier === "confident" ? r.candidates[0]! : null);

// How many roster ids to inject per competition-grain team (the squad TRIM). The fetch is now untyped (no
// `type=` shrink), so the FULL squad would silently hit the participant endpoint's 2000-betoffer cap in an
// offer-dense league. We don't need the whole roster: a team's competition markets ("Tournament progress by
// the team", "to reach the final") hang off a per-team CONTAINER event that lists all the team's players as
// participants, so querying ANY of them pulls those markets through. A few ids guarantee coverage (a single
// pick was the fragility worry — one keeper may have no comp offers) while staying well under the cap. N is
// pinned against the densest competition observed (scripts/squad-trim-cap-check.ts), not guessed.
const SQUAD_FETCH_LIMIT = 5;

// Participants a leg contributes to the broad fetch: confident teams + players + subject, plus each player's
// club + country team (so a fixture-level player market is reachable without the criterion).
// For competition-grain team legs, also inject a TRIMMED squad (first N roster ids) — competition markets are
// hung off PLAYER participant ids via the per-team container event (see SQUAD_FETCH_LIMIT), never the team id.
function legParticipants(leg: ResolvedLegScope, cat: ScopeCatalog): number[] {
  const teamIds = leg.teams.map(settle).filter((c): c is Candidate => c != null).map((c) => c.id);
  const players = [...leg.players, leg.subjectPlayer].map(settle).filter((c): c is Candidate => c != null);
  const squadIds: number[] = [];
  if (leg.level === "competition") {
    for (const tid of teamIds) squadIds.push(...(cat.roster.get(tid) ?? []).slice(0, SQUAD_FETCH_LIMIT));
  }
  return [
    ...teamIds,
    ...players.map((p) => p.id),
    ...players.flatMap((p) => [p.clubId, p.countryTeamId].filter((x): x is number => x != null)),
    ...squadIds,
  ];
}

export function planRecall(settled: SettledEntities, plan: QueryPlan): RecallInput {
  const cat = loadScopeCatalog(plan.sport);
  const legs = settled.legs;
  const participantIds = [...new Set(legs.flatMap((l) => legParticipants(l, cat)))];
  // groupIds come ONLY from legs that name NO participant: a participant leg is served by the participant endpoint
  // (Model P), but a bare-competition leg ("next 3 in WC26") still needs its group fetched. A mixed query emits
  // BOTH so neither leg's data starves the other (recall fetches and unions them).
  const groupIds = [...new Set(
    legs.filter((l) => legParticipants(l, cat).length === 0).map((l) => settle(l.competition)?.id).filter((x): x is number => x != null),
  )];
  const levels = [...new Set(legs.map((l) => l.level))] as Level[]; // union of leg grains -> the fan-out covers both

  // playState: bind server-side ONLY when every leg agrees (same non-null); else fetch broad (scopeMenu filters per leg).
  const states = new Set(legs.map((l) => l.playState));
  const playState = states.size === 1 && !states.has(null) ? legs[0]!.playState ?? undefined : undefined;

  // onlyMain: bind the server-side shrink ONLY when EVERY leg is the bare-event "main" market — a mixed query
  // (one main leg + one named leg) shares this broad fetch, so a server onlyMain would starve the named leg;
  // those cases fetch broad and the main leg's MAIN-tag filter is applied per-leg downstream (resolve.ts).
  const onlyMain = plan.selectors.every((s) => s.market_concept === "main");

  const base: RecallInput = { levels, ...(playState ? { playState } : {}), ...(onlyMain ? { onlyMain: true } : {}) };
  // Model P: a named participant -> participant endpoint; a bare-competition leg -> its group; a mixed query -> both.
  return { ...base, ...(participantIds.length ? { participantIds } : {}), ...(groupIds.length ? { groupIds } : {}) };
}
