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
import { pickCombinations, buildBetslip } from "./combinations";
import { fold } from "./lexical";
import { isMain, onDemandPricing, type BetOffer, type KEvent } from "./offering-client";
import { usageStore, summarizeCost, type RawCall } from "./cost";
import type { Subject, Line } from "./schema";
import { getSport } from "./sports";
import type { ResolvedLeg, MarketPick, EnvelopeLeg } from "./live-menu-types";

// FILTER subject — a NAMED entity narrows the menu to its markets; a relational role (home/away) or `event`
// subject has no name to filter on, so the whole fixture menu is kept (the per-side precision is a SELECT job).
const filterSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined;

// SELECT subject — the named team/player, OR the relational "home"/"away" for an either_match_team selector.
const selectSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : s.kind === "either_match_team" ? s.side : undefined;

// The resolver decides market IDENTITY, which includes GRAIN + WHICH player. A PLAYER-subject leg appends a
// parenthetical so the picker (a) prefers the per-player prop over the match/team total of the same stat, and
// (b) picks the RIGHT player's market when the feed scopes it by name in its LABEL ("Total Aces - Taylor Fritz"
// vs the combined "Total Aces" — the name is the only thing that separates them). Prefer the subject's NAME (it
// carries both the grain AND the identity); fall back to the bare "one player" grain hint when the leg named no
// player (a nameless player prop). Team/event/either_match_team get NO note — their concept already names a
// team/match market, and a note would clash with a period qualifier ("1st half handicap") and make it abstain.
// COMPETITION-grain player legs get no note either: an outright (win overall, top scorer) has no per-player-vs-
// match-total twin — the player is an OUTCOME inside one market (Winner) — so the note only makes the picker read
// the plain outright as an aggregate "total" and prefer a narrower Top-N (confirmed: TdF "win overall" -> Top 10).
const betPhrase = (sel: { subject: Subject; market_concept: string }, level?: string): string =>
  sel.subject.kind === "player" && level !== "competition"
    ? `${sel.market_concept} (for ${sel.subject.name ?? "one player"})`
    : sel.market_concept;

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

// runPipeline — the orchestrator as an async generator. It yields a coarse progress marker before each
// expensive phase (extract LLM, recall fetch, market-resolve LLM) and a final `done` carrying the envelope.
// The SSE server forwards each yield; resolveQuery (below) drains it to the single envelope for non-streaming
// callers (eval, probes).
export async function* runPipeline(query: string): AsyncGenerator<StageEvent> {
  // Per-query LLM usage: each stage runs inside usageStore so bedrock-call records its tokens here (cost.ts).
  // Stamp every `done` envelope with the running total so the frontend can show per-query token/cost.
  const calls: RawCall[] = [];
  const withCost = (e: ResponseEnvelope): ResponseEnvelope => { e.cost = summarizeCost(calls); return e; };

  yield { stage: "resolving" };
  const plan = await usageStore.run(calls, () => extract(query));
  // Bare-competition browse: a `main` sentinel (no market named) tagged competition-level has nothing to show —
  // main markets are per-match, and outright-less leagues (Allsvenskan, most non-marquee comps) carry no
  // competition-level offer at all, so `onlyCompetitions` comes back empty. The intent of a bare league name is
  // "show its events with their main markets" = fixture level. Force it here (a real outright query NAMES a
  // market, so market_concept !== "main" and stays competition-level).
  for (const sel of plan.selectors) {
    if (sel.market_concept === "main" && sel.scope.level === "competition") sel.scope.level = "fixture";
  }
  // Incomplete-query gate: no team/player/league/region anchor -> nothing to scope to. Stop BEFORE any
  // grounding/fetch/LLM and ask the user to add one (canned message; no network spent).
  const incomplete = checkComplete(plan);
  if (incomplete) {
    yield { stage: "done", envelope: withCost({ summary: "", events: [], results: [], legs: [], additional: [], notes: [], clarificationNeeded: incomplete.question }) };
    return;
  }

  if (plan.sport === "other" || !getSport(plan.sport)) {
    const what = plan.sport === "other" ? "that sport" : plan.sport;
    yield { stage: "done", envelope: withCost({ summary: "", events: [], results: [], legs: [], additional: [], notes: [], clarificationNeeded: `We don't support ${what} yet. Try searching for another sport, or check back later as we continue adding more.` }) };
    return;
  }

  yield { stage: "routing" };
  const scope = groundScope(plan);
  const settled = await usageStore.run(calls, () => resolveEntities(query, scope));

  // Guard: if the entity gate couldn't resolve any ids (e.g. ambiguous player with no competition anchor)
  // and raised clarifications, return them instead of crashing in recall with "need groupIds, participantIds…".
  const recallInput = planRecall(settled, plan);
  if (!recallInput.participantIds?.length && !recallInput.groupIds?.length && !recallInput.eventIds?.length) {
    if (settled.clarifications.length > 0) {
      yield { stage: "done", envelope: withCost(execute({ legs: [], data: { betOffers: [], events: [] }, clarifications: settled.clarifications })) };
      return;
    }
    // No ids AND no clarifications — fall through; recall will throw its diagnostic error.
  }

  const r = await recall(recallInput); // BROAD data; per-leg narrowing is scopeMenu's job below

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

  // Fixture inheritance. A FLOATING leg names no subject, team, competition or time: alone it fans across the whole
  // broad fetch (e.g. "total goals over 2.5" in a single-match combo landing on every club game a fetched player's
  // team dragged in). Resolve ANCHORED groups first, collect the fixtures they price, then feed each floating group
  // only those events. No anchor in the query -> floats stay broad (unchanged).
  const isFloating = (i: number): boolean => {
    const leg = settled.legs[i]!;
    return filterSubject(plan.selectors[i]!.subject) == null
      && !leg.teams.some((t) => t.tier === "confident")
      && leg.competition?.tier !== "confident"
      && !leg.time && leg.level !== "competition";
  };
  const anchorEventIds = new Set<number>();
  const ordered = [...groups].sort(([, a], [, b]) => Number(isFloating(a[0]!)) - Number(isFloating(b[0]!)));

  // Per group: scopeMenu + filterBySubject (deterministic, synchronous), then ONE resolveMarkets LLM call for that
  // group's named legs against its shared filtered menu (the answer-preserving multi=false batch). Ordered
  // anchored-first so the sync prep populates anchorEventIds before any floating group reads it.
  const pickJobs: { idxs: number[]; picks: Promise<MarketPick[]> }[] = [];
  for (const [key, idxs] of ordered) {
    const leg = settled.legs[idxs[0]!]!;
    const sel0 = plan.selectors[idxs[0]!]!;
    const floating = isFloating(idxs[0]!);
    const data = floating && anchorEventIds.size
      ? { events: r.data.events.filter((e) => e.id != null && anchorEventIds.has(e.id)), betOffers: r.data.betOffers }
      : r.data;
    const scoped = scopeMenu(data, leg); // narrow the (possibly fixture-restricted) data to this group's leg scope
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
    idxs.forEach((i) => { keyByIdx[i] = key; });
    // "main" legs name no market — they skip the LLM pick entirely and fan out into every main market below.
    // Only the named legs go to resolveMarkets (keep the pick-index alignment to THOSE legs).
    const llmIdxs = idxs.filter((i) => plan.selectors[i]!.market_concept !== "main");
    // Kick the pick off WITHOUT awaiting — each group resolves against its own menu with no cross-group
    // dependency, so all groups' picks run concurrently; awaited together after the loop.
    // ponytail: unbounded fan-out (one call per group). If a query splits into enough groups to hit Bedrock's
    // per-second limit, pool it like recall.ts (chunk + Promise.all).
    if (llmIdxs.length) pickJobs.push({ idxs: llmIdxs, picks: usageStore.run(calls, () => resolveMarkets(llmIdxs.map((i) => betPhrase(plan.selectors[i]!, settled.legs[i]!.level)), fr.menu, undefined, query)) });
    // anchored group -> remember the fixtures it prices, so later floating groups inherit them
    if (!floating) for (const b of fr.offers) if (b.eventId != null) anchorEventIds.add(b.eventId);
  }
  // All group picks were kicked off concurrently above; await together, then map each group's results back to its
  // leg indices (order within a group == llmIdxs order == resolveMarkets phrase order).
  const jobResults = await Promise.all(pickJobs.map((j) => j.picks));
  pickJobs.forEach((j, ji) => j.idxs.forEach((i, k) => { pickByIdx[i] = jobResults[ji]![k]!; }));

  // Relational subjects need the fixture's home/away — from THIS leg's picked betoffer's event, within the
  // group's NARROWED events (so "home"/"away" binds to the right match, never another leg's).
  const eventOf = (offers: BetOffer[], events: KEvent[]) => {
    const eid = offers.find((b) => b.eventId != null)?.eventId;
    return events.find((e) => e.id === eid) ?? events[0];
  };

  yield { stage: "searching" };

  const legsOut: ResolvedLeg[] = [];
  const legsUnderstood: EnvelopeLeg[] = []; // "We understood" echo, one per selector in query order
  for (let i = 0; i < plan.selectors.length; i++) {
    const sel = plan.selectors[i]!;
    const leg = settled.legs[i]!;
    const { scoped, fr } = groupData.get(keyByIdx[i]!)!;
    const subj = selectSubject(sel.subject); // subject AS ASKED (raw name / "home"|"away"; undefined for whole-match)
    // Shared echo fields for this selector; `matched` + `market` are branch-specific (set at each push below).
    // ponytail: `matched` is the resolve-side "found market + a non-fallback outcome"; execute's data-level prune
    // can still drop a leg whose ids don't land — rare (execute is fed exactly what select resolved against).
    const under = { ...(subj ? { subject: subj } : {}), phrase: sel.market_concept, ...(sel.line != null ? { line: sel.line } : {}) };
    const spec: SelectSpec = {
      ...selSpec(sel.line, sel.odds, subj, subjectParticipantId(leg, sel.subject), sel.odds_sort, sel.count),
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
      // A bare PLAYER subject has no "main market" — main markets price the teams, not him — so `isMain` cuts
      // everything and the browse comes back empty. His intent is "show his priced markets": fr.offers is already
      // exactly those (filterBySubject kept only markets where he's a participant). Every other subject keeps the
      // MAIN-tagged cut (a team/league browse = the match's main markets).
      const isPlayerBrowse = sel.subject.kind === "player";
      const mainOffers = fr.offers.filter((b) => (isPlayerBrowse || isMain(b.tags)) && b.criterion?.id != null);
      let matched = false;
      for (const label of new Set(mainOffers.map(marketLabelOf))) {
        const selection = selectFor(offersForPick(mainOffers, label));
        if (selection && !selection.fallback) matched = true;
        legsOut.push({ phrase: label, pick: { label, match: "exact" }, ...(selection ? { selection } : {}), ...(spec.subjectId != null ? { subjectId: spec.subjectId } : {}) });
      }
      legsUnderstood.push({ ...under, matched });
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
    legsUnderstood.push({ ...under, matched: !!selection && !selection.fallback, ...(pick.label ? { market: pick.label } : {}) });
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

  // Bet-builder Phase 2: price the user's OWN resolved legs together as one EXACT betslip (same-event legs via the
  // correlated priceCombo endpoint, cross-event legs multiply). Same inputs pickCombinations used; omitted when <2 legs combine.
  const betslip = await buildBetslip(legsOut, [...execOffers], [...execEvents.values()], onDemandPricing, recallInput.lang);

  const envelope = execute({
    legs: legsOut,
    data: { events: [...execEvents.values()], betOffers: [...execOffers] },
    clarifications: settled.clarifications,
    notes: [...extraNotes],
    truncated: r.truncated,
    fetchFailed: r.failed,
    combinations,
    combinationEvents,
    ...(betslip ? { betslip } : {}),
  });
  envelope.legs = legsUnderstood; // the per-selector "We understood" echo (execute groups by event and loses order)
  yield { stage: "done", envelope: withCost(envelope) };
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
