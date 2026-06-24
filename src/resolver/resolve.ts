// resolve — the orchestrator (build plan Phase 6). The single entry that chains the whole pipeline:
//
//   extract → groundScope → resolveEntities → planRecall → recall(BROAD live data)
//     → per leg-group: scopeMenu(narrow) → filter(subject) → resolve(market) → select(line/subject)
//   → execute → ResponseEnvelope
//
// The market is NEVER decided before the fetch (theory §1): recall fetches by ENTITY ids broadly, then each
// leg narrows the data to its OWN scope (scopeMenu) and resolves its market against that narrowed menu. Per-leg
// scope (the redesign): every selector carries its own grain/competition/time, so narrowing is per leg, not global.

import { extract } from "./extract";
import { checkComplete } from "./check-complete";
import { groundScope, type EntityResolution, type ResolvedLegScope } from "./ground-scope";
import { resolveEntities } from "./resolve-entities";
import { planRecall } from "./plan-recall";
import { recall, scopeMenu, variantOf } from "./recall";
import { filterBySubject } from "./filter";
import { boTypeIdSet } from "./bo-types";
import { resolveMarkets } from "./resolve-market";
import { select, type SelectSpec } from "./select";
import { execute, type ResponseEnvelope } from "./execute";
import { fold } from "./lexical";
import type { BetOffer, KEvent } from "./offering-client";
import type { Subject, Line } from "./schema";
import type { ResolvedLeg, MarketPick } from "./live-menu-types";

// FILTER subject — a NAMED entity narrows the menu to its markets; a relational role (home/away) or `event`
// subject has no name to filter on, so the whole fixture menu is kept (the per-side precision is a SELECT job).
const filterSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined;

// SELECT subject — the named team/player, OR the relational "home"/"away" for an either_match_team selector.
const selectSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : s.kind === "either_match_team" ? s.side : undefined;

// The grounded PARTICIPANT id for a selector's subject — SELECT's preferred (robust) key, == the feed's
// outcome.participantId on named markets. Only a CONFIDENT resolution yields an id (an unsure entity must not
// silently mis-bind). Relational/event/soft -> undefined.
const confidentId = (r: EntityResolution | null | undefined): number | undefined =>
  r && r.tier === "confident" ? r.candidates[0]?.id : undefined;

// Read the subject's grounded id from THIS leg's scope: a player's from the leg's `subjectPlayer`, a named
// team's from the leg's grounded `teams` (matched by folded name).
function subjectParticipantId(leg: ResolvedLegScope, s: Subject): number | undefined {
  if (s.kind === "player") return confidentId(leg.subjectPlayer);
  if (s.kind === "team") {
    const t = leg.teams.find((e) => fold(e.text) === fold(s.name)) ?? leg.teams.find((e) => fold(e.candidates[0]?.name ?? "") === fold(s.name));
    return confidentId(t);
  }
  return undefined;
}

// A selector's Line + subject -> the deterministic SELECT spec (value + direction, never a market binding).
function selSpec(line: Line | undefined, odds: { min?: number; max?: number } | undefined, subject?: string, subjectId?: number): SelectSpec {
  const base: SelectSpec = {
    ...(subjectId != null ? { subjectId } : {}),
    ...(subject ? { subject } : {}),
    ...(odds?.min != null ? { oddsMin: odds.min } : {}),
    ...(odds?.max != null ? { oddsMax: odds.max } : {}),
  };
  if (!line) return base;
  if (line.kind === "numeric") return { ...base, line: line.value, dir: line.direction };
  if (line.kind === "binary") return { ...base, dir: line.direction };
  return { ...base, selection: line.value }; // named selection: HT/FT "1/1", correct score "2-1", double chance "X2"
}

// The picked market's betoffers (criterion + variant). SELECT flattens these to outcomes itself, but keeps
// the betOffer parent for the handicap-sign check — so hand it the offers, not pre-flattened outcomes.
const offersForPick = (offers: BetOffer[], criterionId?: number, variant?: string): BetOffer[] =>
  offers.filter((b) => b.criterion?.id === criterionId && variantOf(b) === (variant ?? ""));

export type StageEvent =
  | { stage: "extracting" }
  | { stage: "fetching" }
  | { stage: "resolving" }
  | { stage: "done"; envelope: ResponseEnvelope };

// runPipeline — the orchestrator as an async generator. It yields a coarse progress marker before each
// expensive phase (extract LLM, recall fetch, market-resolve LLM) and a final `done` carrying the envelope.
// The SSE server forwards each yield; resolveQuery (below) drains it to the single envelope for non-streaming
// callers (eval, probes). The phase logic is UNCHANGED — only the yields are new.
export async function* runPipeline(query: string): AsyncGenerator<StageEvent> {
  yield { stage: "extracting" };
  const plan = await extract(query);
  // Incomplete-query gate: no team/player/league/region anchor -> nothing to scope to. Stop BEFORE any
  // grounding/fetch/LLM and ask the user to add one (canned message; no network spent).
  const incomplete = checkComplete(plan);
  if (incomplete) {
    yield { stage: "done", envelope: { summary: "", results: [], notes: [], clarificationNeeded: incomplete.question } };
    return;
  }

  yield { stage: "fetching" };
  const scope = groundScope(plan);
  const settled = await resolveEntities(query, scope);
  const r = await recall(planRecall(settled, plan)); // BROAD data; per-leg narrowing is scopeMenu's job below

  yield { stage: "resolving" };

  // Group selectors that share BOTH a filter-subject AND a grounded scope signature: they get ONE scopeMenu +
  // ONE filterBySubject + ONE batched resolveMarkets call. The signature spans everything that shapes the menu
  // (level, competition group, teams, time, stage, playState) + the subject filter (name + grounded id), built
  // from GROUNDED ids so surface variants ("WC26" vs "World Cup 2026") collapse to one group, not two.
  const sigOf = (i: number): string => {
    const leg = settled.legs[i]!;
    const sel = plan.selectors[i]!;
    const teamIds = leg.teams.filter((t) => t.tier === "confident").flatMap((t) => t.candidates.map((c) => c.id)).sort((a, b) => a - b);
    return JSON.stringify([
      filterSubject(sel.subject) ?? "",
      subjectParticipantId(leg, sel.subject) ?? 0,
      leg.level,
      confidentId(leg.competition) ?? 0,
      teamIds,
      leg.time,
      leg.stage,
      leg.playState,
    ]);
  };

  const groups = new Map<string, number[]>();
  plan.selectors.forEach((_, i) => {
    const key = sigOf(i);
    let idxs = groups.get(key);
    if (!idxs) groups.set(key, (idxs = []));
    idxs.push(i);
  });

  type GroupData = { scoped: ReturnType<typeof scopeMenu>; fr: ReturnType<typeof filterBySubject> };
  const groupData = new Map<string, GroupData>();
  const keyByIdx: string[] = new Array(plan.selectors.length);
  const pickByIdx: MarketPick[] = new Array(plan.selectors.length);
  const extraNotes = new Set<string>(); // pipeline-level notes resolve alone can build (needs per-leg scope)

  for (const [key, idxs] of groups) {
    const leg = settled.legs[idxs[0]!]!;
    const sel0 = plan.selectors[idxs[0]!]!;
    const scoped = scopeMenu(r.data, leg); // narrow the broad data to this group's leg scope
    if (scoped.timeUnresolved) {
      const phrase = leg.time?.date_window?.value ?? leg.time?.kickoff_time_of_day ?? "you gave";
      extraNotes.add(`Couldn't read the time "${phrase}" — showing all matching games instead.`);
    }
    const keepTypes = boTypeIdSet(idxs.flatMap((i) => plan.selectors[i]!.bo_types ?? []));
    const subjId = subjectParticipantId(leg, sel0.subject);
    const fr = filterBySubject(scoped.offers, scoped.events, filterSubject(sel0.subject), subjId, keepTypes);
    groupData.set(key, { scoped, fr });
    const picks = await resolveMarkets(idxs.map((i) => plan.selectors[i]!.market_concept), fr.menu);
    idxs.forEach((i, k) => { pickByIdx[i] = picks[k]!; keyByIdx[i] = key; });
  }

  // Relational subjects need the fixture's home/away — from THIS leg's picked betoffer's event, within the
  // group's NARROWED events (so "home"/"away" binds to the right match, never another leg's).
  const eventOf = (offers: BetOffer[], events: KEvent[]) => {
    const eid = offers.find((b) => b.eventId != null)?.eventId;
    return events.find((e) => e.id === eid) ?? events[0];
  };

  const legsOut: ResolvedLeg[] = [];
  for (let i = 0; i < plan.selectors.length; i++) {
    const sel = plan.selectors[i]!;
    const leg = settled.legs[i]!;
    const pick = pickByIdx[i]!;
    const { scoped, fr } = groupData.get(keyByIdx[i]!)!;
    let selection;
    if (pick.match !== "none") {
      const picked = offersForPick(fr.offers, pick.criterionId, pick.variant);
      const ev = eventOf(picked, scoped.events); // per-leg home/away from this leg's market's event
      const ctx = { home: ev?.homeName, away: ev?.awayName };
      const slice = { events: scoped.events, betOffers: picked };
      selection = select(slice, selSpec(sel.line, sel.odds, selectSubject(sel.subject), subjectParticipantId(leg, sel.subject)), ctx);
    }
    legsOut.push({ phrase: sel.market_concept, pick, ...(selection ? { selection } : {}) });
  }

  // execute gets only the REFERENCED data (union of the groups' narrowed events/offers), never the broad fetch —
  // so a leg's result can never carry another leg's event. execute prunes further to picked-outcome events.
  const execEvents = new Map<number, KEvent>();
  const execOffers = new Set<BetOffer>();
  for (const { scoped } of groupData.values()) {
    for (const e of scoped.events) if (e.id != null) execEvents.set(e.id, e);
    for (const b of scoped.offers) execOffers.add(b);
  }
  yield {
    stage: "done",
    envelope: execute({
      legs: legsOut,
      data: { events: [...execEvents.values()], betOffers: [...execOffers] },
      clarifications: settled.clarifications,
      notes: [...extraNotes],
      truncated: r.truncated,
      fetchFailed: r.failed,
    }),
  };
}

// resolveQuery — the non-streaming entry: drain runPipeline and return the final envelope. Existing callers
// (eval, probes) keep their `Promise<ResponseEnvelope>` contract; the generator always emits exactly one `done`.
export async function resolveQuery(query: string): Promise<ResponseEnvelope> {
  let envelope: ResponseEnvelope | undefined;
  for await (const evt of runPipeline(query)) {
    if (evt.stage === "done") envelope = evt.envelope;
  }
  return envelope!;
}
