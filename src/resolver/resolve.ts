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
import { recall, scopeMenu, marketLabelOf } from "./recall";
import { filterBySubject } from "./filter";
import { resolveMarkets } from "./resolve-market";
import { select, type SelectSpec } from "./select";
import { execute, type ResponseEnvelope } from "./execute";
import { pickCombinations } from "./combinations";
import { fold } from "./lexical";
import { isMain, type BetOffer, type KEvent } from "./offering-client";
import type { Subject, Line } from "./schema";
import { getSport } from "./sports";
import type { ResolvedLeg, MarketPick } from "./live-menu-types";

// FILTER subject — a NAMED entity narrows the menu to its markets; a relational role (home/away) or `event`
// subject has no name to filter on, so the whole fixture menu is kept (the per-side precision is a SELECT job).
const filterSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined;

// SELECT subject — the named team/player, OR the relational "home"/"away" for an either_match_team selector.
const selectSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : s.kind === "either_match_team" ? s.side : undefined;

// The resolver decides market IDENTITY, which includes GRAIN. Only the PLAYER grain needs a note: a nameless-player
// "shots on target" lost to the match aggregate because the bare concept gave no per-player signal. Append
// `(for one player)` so the resolver picks the per-player prop, not the match total. Team/event/either_match_team
// get NO note — their concept already names a team/match market, and a "(for the whole match)" note would clash
// with a period qualifier in the concept ("1st half handicap") and make the resolver abstain.
// INDIVIDUAL sports (tennis): the player IS the competitor, so there is no match/team total twin to disambiguate
// from — the note only misleads the resolver into rejecting the player's OWN market as "team-scoped". Skip it.
const betPhrase = (sel: { subject: Subject; market_concept: string }, individual: boolean): string =>
  sel.subject.kind === "player" && !individual ? `${sel.market_concept} (for one player)` : sel.market_concept;

// The grounded PARTICIPANT id for a selector's subject — SELECT's preferred (robust) key, == the feed's
// outcome.participantId on named markets. Only a CONFIDENT resolution yields an id (an unsure entity must not
// silently mis-bind). Relational/event/soft -> undefined.
const confidentId = (r: EntityResolution | null | undefined): number | undefined =>
  r && r.tier === "confident" ? r.candidates[0]?.id : undefined;

// The grounded ENTITY for a selector's subject, from THIS leg's scope: a player's `subjectPlayer`, a named
// team matched by folded name in the leg's `teams`. Relational/event subjects have none.
function subjectEntity(leg: ResolvedLegScope, s: Subject): EntityResolution | null | undefined {
  if (s.kind === "player") return leg.subjectPlayer;
  if (s.kind === "team") return leg.teams.find((e) => fold(e.text) === fold(s.name)) ?? leg.teams.find((e) => fold(e.candidates[0]?.name ?? "") === fold(s.name));
  return undefined;
}

// The subject's grounded participant id (confident only) — SELECT's robust key, == the feed's participantId.
const subjectParticipantId = (leg: ResolvedLegScope, s: Subject): number | undefined => confidentId(subjectEntity(leg, s));

// The subject's CANONICAL feed name — confident grounding ONLY. The feed builds market labels / event names
// from this exact string, so the filter's text homes match precisely (no "Korea" vs "Korea Republic" slip).
// An unresolved named subject never reaches the filter as the sole anchor (the entity gate clarifies and
// stops); in a mixed query it falls through to a passthrough menu, never a raw-name half-match.
function subjectName(leg: ResolvedLegScope, s: Subject): string | undefined {
  const e = subjectEntity(leg, s);
  return e && e.tier === "confident" ? e.candidates[0]?.name : undefined;
}

// A selector's Line + subject -> the deterministic SELECT spec (value, never a market binding). The line VALUE is
// carried RAW (number or string) as `lineValue`; SELECT decides how to read it from the picked market's
// betOfferType (a numeric rung for handicaps/over-unders, a combo token for correct-score/HT-FT) — never guessed
// from the value's JSON type. No direction: the extractor no longer says "which side", so an over/under resolves
// to all sides at the rung until SELECT returns them.
function selSpec(line: Line | undefined, odds: { min?: number; max?: number } | undefined, subject?: string, subjectId?: number, sort?: "low" | "high", count?: number): SelectSpec {
  const base: SelectSpec = {
    ...(subjectId != null ? { subjectId } : {}),
    ...(subject ? { subject } : {}),
    ...(odds?.min != null ? { oddsMin: odds.min } : {}),
    ...(odds?.max != null ? { oddsMax: odds.max } : {}),
    ...(sort ? { sort } : {}),
    ...(count != null ? { count } : {}),
  };
  return line === undefined ? base : { ...base, lineValue: line };
}

// The picked market's betoffers, keyed by the menu LABEL (the identity — criterion englishLabel + variant).
// SELECT flattens these to outcomes itself, but keeps the betOffer parent for the handicap-sign check — so hand
// it the offers, not pre-flattened outcomes. Same label ⇒ same market, so the slice is exactly the picked market
// (the at-least-N family no longer leaks sibling thresholds into it).
const offersForPick = (offers: BetOffer[], label?: string): BetOffer[] =>
  label == null ? [] : offers.filter((b) => marketLabelOf(b) === label);

export type StageEvent =
  | { stage: "resolving" }
  | { stage: "searching" }
  | { stage: "routing" }
  | { stage: 'disambiguating' }
  | { stage: "done"; envelope: ResponseEnvelope };

// The pipeline's injectable boundaries — the three LLM steps + the network fetch. Production passes nothing and
// gets REAL_DEPS (identical behaviour); the harness-loop rig injects cached/subagent + live-cached doubles so it
// can run the WHOLE real pipeline with no LLM API. Pure plumbing: defaults preserve every production call.
export type PipelineDeps = {
  extract: typeof extract;
  recall: typeof recall;
  resolveEntities: typeof resolveEntities;
  resolveMarkets: typeof resolveMarkets;
};
const REAL_DEPS: PipelineDeps = { extract, recall, resolveEntities, resolveMarkets };

// runPipeline — the orchestrator as an async generator. It yields a coarse progress marker before each
// expensive phase (extract LLM, recall fetch, market-resolve LLM) and a final `done` carrying the envelope.
// The SSE server forwards each yield; resolveQuery (below) drains it to the single envelope for non-streaming
// callers (eval, probes). The phase logic is UNCHANGED — only the yields are new.
export async function* runPipeline(query: string, deps: PipelineDeps = REAL_DEPS): AsyncGenerator<StageEvent> {
  yield { stage: "resolving" };
  const plan = await deps.extract(query);
  // Incomplete-query gate: no team/player/league/region anchor -> nothing to scope to. Stop BEFORE any
  // grounding/fetch/LLM and ask the user to add one (canned message; no network spent).
  const incomplete = checkComplete(plan);
  if (incomplete) {
    yield { stage: "done", envelope: { summary: "", events: [], results: [], additional: [], notes: [], clarificationNeeded: incomplete.question } };
    return;
  }

  if (!getSport(plan.sport)) {
    yield { stage: "done", envelope: { summary: "", events: [], results: [], additional: [], notes: [], clarificationNeeded: `We don't support ${plan.sport} yet. Try searching for another sport, or check back later as we continue adding more.` } };
    return;
  }

  yield { stage: "routing" };
  const scope = groundScope(plan);
  const settled = await deps.resolveEntities(query, scope);

  // Guard: if the entity gate couldn't resolve any ids (e.g. ambiguous player with no competition anchor)
  // and raised clarifications, return them instead of crashing in recall with "need groupIds, participantIds…".
  const recallInput = planRecall(settled, plan);
  if (!recallInput.participantIds?.length && !recallInput.groupIds?.length && !recallInput.eventIds?.length) {
    if (settled.clarifications.length > 0) {
      yield { stage: "done", envelope: execute({ legs: [], data: { betOffers: [], events: [] }, clarifications: settled.clarifications }) };
      return;
    }
    // No ids AND no clarifications — fall through; recall will throw its diagnostic error.
  }

  const r = await deps.recall(recallInput); // BROAD data; per-leg narrowing is scopeMenu's job below

  yield { stage: "disambiguating" };

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
      sel.subject.kind === "either_match_team" ? sel.subject.side ?? "" : "",
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
  if (plan.otherSports?.length) {
    extraNotes.add(`Showing ${plan.sport} — did you mean ${plan.otherSports.join(" or ")}?`);
  }
  const individual = !!getSport(plan.sport)?.individual; // gates the per-player grain note off for individual sports

  for (const [key, idxs] of groups) {
    const leg = settled.legs[idxs[0]!]!;
    const sel0 = plan.selectors[idxs[0]!]!;
    const scoped = scopeMenu(r.data, leg); // narrow the broad data to this group's leg scope
    if (scoped.timeUnresolved) {
      const bad = scoped.unresolvedPhrase ?? "you gave";
      extraNotes.add(scoped.timeApplied
        ? `Couldn't read "${bad}" as a kickoff time — showing all kickoff times.`
        : `Couldn't read "${bad}" — showing all matching games.`);
    }
    const subjId = subjectParticipantId(leg, sel0.subject);
    const subjSide = sel0.subject.kind === "either_match_team" ? sel0.subject.side : undefined;
    const fr = filterBySubject(scoped.offers, scoped.events, subjectName(leg, sel0.subject), subjId, subjSide);
    groupData.set(key, { scoped, fr });
    // "main" legs name no market — they skip the LLM pick entirely and fan out into every main market below.
    // Only the named legs go to resolveMarkets (keep the pick-index alignment to THOSE legs).
    const llmIdxs = idxs.filter((i) => plan.selectors[i]!.market_concept !== "main");
    const picks = llmIdxs.length ? await deps.resolveMarkets(llmIdxs.map((i) => betPhrase(plan.selectors[i]!, individual)), fr.menu) : [];
    llmIdxs.forEach((i, k) => { pickByIdx[i] = picks[k]!; });
    idxs.forEach((i) => { keyByIdx[i] = key; });
  }

  // Relational subjects need the fixture's home/away — from THIS leg's picked betoffer's event, within the
  // group's NARROWED events (so "home"/"away" binds to the right match, never another leg's).
  const eventOf = (offers: BetOffer[], events: KEvent[]) => {
    const eid = offers.find((b) => b.eventId != null)?.eventId;
    return events.find((e) => e.id === eid) ?? events[0];
  };

  yield { stage: "searching" };

  const legsOut: ResolvedLeg[] = [];
  for (let i = 0; i < plan.selectors.length; i++) {
    const sel = plan.selectors[i]!;
    const leg = settled.legs[i]!;
    const { scoped, fr } = groupData.get(keyByIdx[i]!)!;
    const spec: SelectSpec = {
      ...selSpec(sel.line, sel.odds, selectSubject(sel.subject), subjectParticipantId(leg, sel.subject), sel.odds_sort, sel.count),
      ...(pickByIdx[i]?.outcomeLabel ? { outcomeLabel: pickByIdx[i]!.outcomeLabel } : {}),
    };
    // select one market's outcomes; event comes off the picked offers (per-leg home/away binds to the right match).
    const selectFor = (picked: BetOffer[]) =>
      select({ events: scoped.events, betOffers: picked }, spec, { home: eventOf(picked, scoped.events)?.homeName, away: eventOf(picked, scoped.events)?.awayName });

    // "main": no LLM pick — surface EVERY main market for the matched fixtures. Filter this leg's offers to the
    // MAIN-tagged ones (the per-leg client-side cut — works on any endpoint; a no-op when recall shrank server-side),
    // then emit one leg per distinct main market so execute groups them under their events. Line/subject/odds still
    // apply per market via the same select() path; only the market-naming LLM step is skipped.
    if (sel.market_concept === "main") {
      const mainOffers = fr.offers.filter((b) => isMain(b.tags) && b.criterion?.id != null);
      for (const label of new Set(mainOffers.map(marketLabelOf))) {
        const selection = selectFor(offersForPick(mainOffers, label));
        legsOut.push({ phrase: label, pick: { label, match: "exact" }, ...(selection ? { selection } : {}), ...(spec.subjectId != null ? { subjectId: spec.subjectId } : {}) });
      }
      continue;
    }

    const pick = pickByIdx[i]!;
    const selection = pick.match !== "none" ? selectFor(offersForPick(fr.offers, pick.label)) : undefined;
    // A `none` pick has no result: distinguish "the scope found no fixture at all" (a fixture-grain leg with an
    // empty scoped slate) from "a fixture existed but no market fit the concept" — execute renders each differently.
    const wantedFixture = sel.scope.level === "fixture" || !!sel.scope.teams?.length || !!sel.scope.time;
    const unavailable = pick.match === "none"
      ? (scoped.events.length === 0 && wantedFixture
          ? { kind: "no-fixture" as const, ...(sel.scope.teams?.[0] ? { scope: sel.scope.teams[0] } : {}) }
          : { kind: "no-market" as const })
      : undefined;
    legsOut.push({ phrase: sel.market_concept, pick, ...(selection ? { selection } : {}), ...(spec.subjectId != null ? { subjectId: spec.subjectId } : {}), ...(unavailable ? { unavailable } : {}) });
  }

  // execute gets only the REFERENCED data (union of the groups' narrowed events/offers), never the broad fetch —
  // so a leg's result can never carry another leg's event. execute prunes further to picked-outcome events.
  const execEvents = new Map<number, KEvent>();
  const execOffers = new Set<BetOffer>();
  for (const { scoped } of groupData.values()) {
    for (const e of scoped.events) if (e.id != null) execEvents.set(e.id, e);
    for (const b of scoped.offers) execOffers.add(b);
  }

  // Bet-builder Phase 1: rank the recalled prepack coupons against THIS query's resolved picks. Collect the
  // selected outcome ids, then — via the offers those outcomes came from — their betOffer + criterion ids (the
  // ranking tiers: exact outcome -> same betoffer -> same market). scopeMenu already scoped the events shown.
  const resolvedOutcomeIds = new Set<number>();
  for (const l of legsOut) for (const id of l.selection?.selectedIds ?? (l.selection?.outcomeId != null ? [l.selection.outcomeId] : [])) resolvedOutcomeIds.add(id);
  const resolvedBetofferIds = new Set<number>();
  const resolvedCriterionIds = new Set<number>();
  for (const b of execOffers) for (const o of b.outcomes ?? []) {
    if (o.id == null || !resolvedOutcomeIds.has(o.id)) continue;
    if (b.id != null) resolvedBetofferIds.add(b.id);
    if (b.criterion?.id != null) resolvedCriterionIds.add(b.criterion.id);
  }
  const combinations = pickCombinations(r.prepacks, new Set(execEvents.keys()), resolvedOutcomeIds, resolvedBetofferIds, resolvedCriterionIds);
  // Enrich: a kept combination may reference a game we're NOT otherwise showing (a cross-game coupon). Attach
  // those events (from the prepack response, deduped, shown games excluded) so the frontend can render each leg.
  const comboEventIds = new Set<number>();
  for (const c of combinations) for (const l of c.legs) if (l.eventId != null) comboEventIds.add(l.eventId);
  const combinationEvents = (r.prepacks?.events ?? []).filter((e) => comboEventIds.has(e.id) && !execEvents.has(e.id));

  yield {
    stage: "done",
    envelope: execute({
      legs: legsOut,
      data: { events: [...execEvents.values()], betOffers: [...execOffers] },
      clarifications: settled.clarifications,
      notes: [...extraNotes],
      truncated: r.truncated,
      fetchFailed: r.failed,
      combinations,
      combinationEvents,
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
