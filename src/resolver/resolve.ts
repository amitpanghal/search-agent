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
import { execute, type ResponseEnvelope, type EnvelopeSubject } from "./execute";
import { buildBetslip } from "./combinations";
import { fold } from "./lexical";
import { isMain, onDemandPricing, type BetOffer, type KEvent } from "./offering-client";
import { usageStore, summarizeCost, type RawCall } from "./cost";
import type { Subject, Line, LineRange } from "./schema";
import { getSport } from "./sports";
import { recoverSport } from "./recover-sport";
import type { ResolvedLeg, MarketPick, EnvelopeLeg, Selection } from "./live-menu-types";
import { emit } from "./trace";

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
// player (a nameless player prop). TEAM-subject legs get the same note — the bare concept ("goals") hides which
// side the bet binds to, and the picker chose the combined-total twin over "Total Goals by <team>" (Rayo
// not-scoring bug); the prompt's Grain rule makes a team note a twin-PREFERENCE, not a hard constraint, so a
// period-qualified concept with no team twin ("1st half handicap (for X)") still picks normally.
// Event/either_match_team get NO note — their concept already names a match market.
// COMPETITION-grain legs get no note either: an outright (win overall, top scorer) has no per-subject-vs-
// match-total twin — the subject is an OUTCOME inside one market (Winner) — so the note only makes the picker read
// the plain outright as an aggregate "total" and prefer a narrower Top-N (confirmed: TdF "win overall" -> Top 10).
const betPhrase = (sel: { subject: Subject; market_concept: string }, level?: string): string => {
  if (level === "competition") return sel.market_concept;
  if (sel.subject.kind === "player") return `${sel.market_concept} (for ${sel.subject.name ?? "one player"})`;
  if (sel.subject.kind === "team" && sel.subject.name) return `${sel.market_concept} (for ${sel.subject.name})`;
  return sel.market_concept;
};

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

// A NAMED subject the grounder could not identify AT ALL (tier none, zero candidates). Such a leg must
// abstain rather than answer from its other anchors — a resolved competition would otherwise substitute ITS
// events for the unidentified subject's ("Granollers/Zeballos to win in Cincinnati" must clarify, not serve
// the other Cincinnati matches). The entity clarification (with suggestions) already sits in clarifications;
// execute surfaces it once this leg stops counting as resolved.
const subjectUnidentified = (leg: ResolvedLegScope, s: Subject): boolean =>
  (s.kind === "team" || s.kind === "player") && subjectEntity(leg, s)?.tier === "none";

// A selector's Line + subject -> the deterministic SELECT spec (value, never a market binding). The line VALUE is
// carried RAW (number or string) as `lineValue`; SELECT decides how to read it from the picked market's
// betOfferType (a numeric rung for handicaps/over-unders, a combo token for correct-score/HT-FT) — never guessed
// from the value's JSON type. The side (over/under, yes/no) rides in SEPARATELY as `dir` from the selector's
// `direction` (set at the call site, not here) — omitted when the query names no side, so every side rides along.
function selSpec(
  line: Line | LineRange | undefined,
  odds: { min?: number; max?: number } | undefined,
  subject?: string,
  subjectId?: number,
  sort?: "low" | "high",
  count?: number,
  lineSort?: "low" | "high",
): SelectSpec {
  const base: SelectSpec = {
    ...(subjectId != null ? { subjectId } : {}),
    ...(subject ? { subject } : {}),
    ...(odds?.min != null ? { oddsMin: odds.min } : {}),
    ...(odds?.max != null ? { oddsMax: odds.max } : {}),
    ...(sort ? { sort } : {}),
    ...(count != null ? { count } : {}),
    ...(lineSort ? { lineSort } : {}),
  };
  if (line === undefined) return base;
  // A RANGE bounds which fixtures qualify (by headline line); a scalar/token is the rung to select. The two
  // never co-occur — the extractor emits one shape or the other.
  if (typeof line === "object") {
    return { ...base, ...(line.min != null ? { lineMin: line.min } : {}), ...(line.max != null ? { lineMax: line.max } : {}) };
  }
  return { ...base, lineValue: line };
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
export async function* runPipeline(query: string, opts: { until?: string; tz?: string } = {}): AsyncGenerator<StageEvent> {
  // Per-query LLM usage: each stage runs inside usageStore so bedrock-call records its tokens here (cost.ts).
  // Stamp every `done` envelope with the running total so the frontend can show per-query token/cost.
  const calls: RawCall[] = [];
  const withCost = (e: ResponseEnvelope): ResponseEnvelope => { e.cost = summarizeCost(calls); return e; };

  yield { stage: "resolving" };
  const plan = await usageStore.run(calls, () => extract(query));
  emit({ kind: "stage", stage: "extract", out: plan });
  if (opts.until === "extract") return;
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
    yield { stage: "done", envelope: withCost({ summary: "", events: [], subjects: [], results: [], legs: [], additional: [], notes: [], clarificationNeeded: incomplete.question }) };
    return;
  }

  // Sport self-correction: the extractor's sport is a prior. If it's blind to a team/player the query names,
  // let the entity's real catalog home override it before the unsupported-sport stop below (see recover-sport.ts).
  const fix = recoverSport(plan);
  if (fix.kind === "switch") plan.sport = fix.sport;
  else if (fix.kind === "clarify") {
    const names = fix.sports.map((s) => s.replace(/-/g, " ")).join(" or ");
    yield { stage: "done", envelope: withCost({ summary: "", events: [], subjects: [], results: [], legs: [], additional: [], notes: [], clarificationNeeded: `That name matches more than one sport — did you mean ${names}? Add the sport or a league to your search.` }) };
    return;
  }

  if (plan.sport === "other" || !getSport(plan.sport)) {
    const what = plan.sport === "other" ? "that sport" : plan.sport;
    yield { stage: "done", envelope: withCost({ summary: "", events: [], subjects: [], results: [], legs: [], additional: [], notes: [], clarificationNeeded: `We don't support ${what} yet. Try searching for another sport, or check back later as we continue adding more.` }) };
    return;
  }

  yield { stage: "routing" };
  const scope = groundScope(plan);
  emit({ kind: "stage", stage: "ground", out: scope });
  if (opts.until === "ground") return;
  const settled = await usageStore.run(calls, () => resolveEntities(query, scope));
  emit({ kind: "stage", stage: "entities", out: settled });
  // The entity gate may have settled a name in ANOTHER sport's catalog (cross-sport widening), which means the
  // extractor's sport was wrong. The entity already carries the right ids; only planRecall's squad lookup still
  // reads plan.sport, so bring it along. AFTER the emit — `plan` is the same object the extract stage captured,
  // so assigning before it rewrites that trace row and hides what the extractor actually said.
  plan.sport = settled.sport;
  if (opts.until === "entities") return;

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
  emit({ kind: "stage", stage: "recall", out: r });
  if (opts.until === "recall") return;

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
    const scoped = scopeMenu(data, leg, { tz: opts.tz }); // narrow the (possibly fixture-restricted) data to this group's leg scope
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
    emit({ kind: "stage", stage: "scopeMenu", out: scoped });
    emit({ kind: "stage", stage: "filter", out: fr });
    idxs.forEach((i) => { keyByIdx[i] = key; });
    // "main" legs name no market — they skip the LLM pick entirely and fan out into every main market below.
    // Only the named legs go to resolveMarkets (keep the pick-index alignment to THOSE legs).
    // An unidentified-subject leg abstains (see subjectUnidentified): none-pick now, no market call spent.
    idxs.forEach((i) => { if (subjectUnidentified(settled.legs[i]!, plan.selectors[i]!.subject)) pickByIdx[i] = { match: "none" }; });
    const llmIdxs = idxs.filter((i) => plan.selectors[i]!.market_concept !== "main" && pickByIdx[i] == null);
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
  emit({ kind: "stage", stage: "market", out: pickByIdx });

  // Relational subjects need the fixture's home/away — from THIS leg's picked betoffer's event, within the
  // group's NARROWED events (so "home"/"away" binds to the right match, never another leg's).
  const eventOf = (offers: BetOffer[], events: KEvent[]) => {
    const eid = offers.find((b) => b.eventId != null)?.eventId;
    return events.find((e) => e.id === eid) ?? events[0];
  };

  // Merge the events a selection's picked outcome(s) sit on into the subject's tile entry (one event per
  // fixture on a multi-fixture leg; deduped across legs sharing the subject).
  const addSubjectEvents = (entry: EnvelopeSubject | undefined, offers: BetOffer[], selection?: Selection) => {
    if (!entry || !selection) return;
    for (const id of selection.selectedIds ?? (selection.outcomeId != null ? [selection.outcomeId] : [])) {
      const eid = offers.find((b) => b.outcomes?.some((o) => o.id === id))?.eventId;
      if (eid != null && !entry.eventIds.includes(eid)) entry.eventIds.push(eid);
    }
  };

  yield { stage: "searching" };

  const legsOut: ResolvedLeg[] = [];
  const legsUnderstood: EnvelopeLeg[] = []; // "We understood" echo, one per selector in query order
  const subjectsOut = new Map<number, EnvelopeSubject>(); // grounded leg subjects (tile identities), deduped by id
  for (let i = 0; i < plan.selectors.length; i++) {
    const sel = plan.selectors[i]!;
    const leg = settled.legs[i]!;
    const { scoped, fr } = groupData.get(keyByIdx[i]!)!;
    const subj = selectSubject(sel.subject); // subject AS ASKED (raw name / "home"|"away"; undefined for whole-match)
    // Shared echo fields for this selector; `matched` + `market` are branch-specific (set at each push below).
    // ponytail: `matched` is the resolve-side "found market + a non-fallback outcome"; execute's data-level prune
    // can still drop a leg whose ids don't land — rare (execute is fed exactly what select resolved against).
    // "We understood" echo. A line RANGE is rendered for the human ("line above 8.5"); a scalar/token rides as-is.
    const lineEcho =
      sel.line == null ? undefined
        : typeof sel.line === "object"
          ? [sel.line.min != null ? `above ${sel.line.min}` : "", sel.line.max != null ? `below ${sel.line.max}` : ""].filter(Boolean).join(" and ")
          : sel.line;
    const under = { ...(subj ? { subject: subj } : {}), phrase: sel.market_concept, ...(lineEcho != null ? { line: lineEcho } : {}) };
    // Unidentified named subject -> abstain (covers "main" browses too): a no-fixture leg naming the subject,
    // no selection. execute renders the sentence and, with the leg unresolved, surfaces the entity clarification.
    if (subjectUnidentified(leg, sel.subject)) {
      legsOut.push({ phrase: sel.market_concept, pick: { match: "none" }, unavailable: { kind: "no-fixture", ...(subj ? { scope: subj } : {}) } });
      legsUnderstood.push({ ...under, matched: false });
      continue;
    }
    const spec: SelectSpec = {
      ...selSpec(sel.line, sel.odds, subj, subjectParticipantId(leg, sel.subject), sel.odds_sort, sel.count, sel.line_sort),
      ...(sel.direction ? { dir: sel.direction } : {}),
      ...(pickByIdx[i]?.outcomeLabel ? { outcomeLabel: pickByIdx[i]!.outcomeLabel } : {}),
    };
    // Tile identity: the leg's confidently-grounded named PLAYER (team tiles dropped — events[] carries teams).
    // One entry per player across all legs; eventIds merge in below if a selection lands on concrete outcomes.
    let subjEntry: EnvelopeSubject | undefined;
    if (sel.subject.kind === "player" && spec.subjectId != null) {
      subjEntry = subjectsOut.get(spec.subjectId);
      if (!subjEntry) {
        const name = subjectName(leg, sel.subject);
        if (name) subjectsOut.set(spec.subjectId, subjEntry = { kind: sel.subject.kind, id: spec.subjectId, name, eventIds: [] });
      }
    }
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
        addSubjectEvents(subjEntry, mainOffers, selection);
        legsOut.push({ phrase: label, pick: { label, match: "exact" }, ...(selection ? { selection } : {}), ...(spec.subjectId != null ? { subjectId: spec.subjectId } : {}) });
      }
      legsUnderstood.push({ ...under, matched });
      continue;
    }

    const pick = pickByIdx[i]!;
    const selection = pick.match !== "none" ? selectFor(offersForPick(fr.offers, pick.label)) : undefined;
    addSubjectEvents(subjEntry, fr.offers, selection);
    // The stated line isn't always on the ladder — select flags the NEAREST offered rung (a preference, never
    // a drop). Say so, or "texans -3" answered with -1.5 reads as a wrong answer instead of a substitute.
    // Bands are exempt: "2+" resolving to "over 1.5" IS the exact conversion, not a substitute.
    const bandDir = sel.direction === "at_least" || sel.direction === "at_most";
    if (!bandDir && typeof sel.line === "number" && selection?.line != null && !selection.fallback && selection.line !== sel.line)
      extraNotes.add(`No ${sel.line} line for "${sel.market_concept}" right now — showing the nearest offered (${selection.line}).`);
    // A `none` pick has no result: distinguish "the scope found no fixture at all" (a fixture-grain leg with an
    // empty scoped slate) from "a fixture existed but no market fit the concept" — execute renders each differently.
    const namedTeams = [...(sel.scope.teams ?? []), ...(sel.subject.kind === "team" ? [sel.subject.name] : [])];
    const wantedFixture = sel.scope.level === "fixture" || namedTeams.length > 0 || !!sel.scope.time;
    const unavailable = pick.match === "none"
      ? (scoped.events.length === 0 && wantedFixture
          ? { kind: "no-fixture" as const, ...(namedTeams.length ? { scope: [...new Set(namedTeams)].join(" vs ") } : {}) }
          : { kind: "no-market" as const })
      : undefined;
    legsOut.push({ phrase: sel.market_concept, pick, ...(selection ? { selection } : {}), ...(spec.subjectId != null ? { subjectId: spec.subjectId } : {}), ...(unavailable ? { unavailable } : {}) });
    legsUnderstood.push({ ...under, matched: !!selection && !selection.fallback, ...(pick.label ? { market: pick.label } : {}) });
  }
  emit({ kind: "stage", stage: "select", out: legsOut });

  // execute gets only the REFERENCED data (union of the groups' narrowed events/offers), never the broad fetch —
  // so a leg's result can never carry another leg's event. execute prunes further to picked-outcome events.
  const execEvents = new Map<number, KEvent>();
  const execOffers = new Set<BetOffer>();
  for (const { scoped } of groupData.values()) {
    for (const e of scoped.events) if (e.id != null) execEvents.set(e.id, e);
    for (const b of scoped.offers) execOffers.add(b);
  }

  // Price the user's OWN resolved legs together as one EXACT betslip (same-event legs via the correlated
  // priceCombo endpoint, cross-event legs multiply); omitted when <2 legs combine. Skipped on an all-main
  // browse: the "picks" are our own main-market fan-out, not user selections, so combining them is noise
  // (this also spares the onDemandPricing calls for same-event pick groups). Also skipped when <2 legs hold
  // a selection: a single leg's multi-fixture selectedIds are one answer PER fixture, not conjuncts — combining
  // them turns "PL home teams to win" into a forced accumulator and drops every per-match card.
  const noMarketBrowse = !!recallInput.onlyMain;
  const pickedLegs = legsOut.filter((l) => l.selection?.outcomeId != null || l.selection?.selectedIds?.length).length;
  const betslip = noMarketBrowse || pickedLegs < 2 ? undefined : await buildBetslip(legsOut, [...execOffers], [...execEvents.values()], onDemandPricing, recallInput.lang);

  // Query-level combined-odds bound ("only if the combined odds clear 2.0"). Checked ONCE against the priced
  // betslip, here rather than per leg — a per-selector bound deletes whichever leg it lands on (the Arsenal-at-1.2
  // case). A miss is REPORTED with the real price and the legs are kept: the user asked for a parlay, so the
  // useful answer is "here it is, it prices at 1.84" — not an empty screen.
  const cOdds = plan.combined_odds;
  if (cOdds && betslip) {
    const price = betslip.odds / 1000;
    if ((cOdds.min != null && price < cOdds.min) || (cOdds.max != null && price > cOdds.max)) {
      const want = [cOdds.min != null ? `above ${cOdds.min}` : "", cOdds.max != null ? `below ${cOdds.max}` : ""].filter(Boolean).join(" and ");
      extraNotes.add(`These selections combine to ${price.toFixed(2)}, not ${want}. Swap a leg or adjust the price you're after.`);
    }
  }

  const envelope = execute({
    legs: legsOut,
    data: { events: [...execEvents.values()], betOffers: [...execOffers] },
    clarifications: settled.clarifications,
    notes: [...extraNotes],
    truncated: r.truncated,
    fetchFailed: r.failed,
    ...(betslip ? { betslip } : {}),
  });
  envelope.legs = legsUnderstood; // the per-selector "We understood" echo (execute groups by event and loses order)
  envelope.subjects = envelope.results.length >= 3 ? [] : [...subjectsOut.values()]; // player tiles, only as a no-results fallback
  emit({ kind: "stage", stage: "execute", out: envelope });
  yield { stage: "done", envelope: withCost(envelope) };
}

// resolveQuery — the non-streaming entry: drain runPipeline and return the final envelope. Existing callers
// (eval, probes) keep their `Promise<ResponseEnvelope>` contract; the generator always emits exactly one `done`.
export async function resolveQuery(query: string, opts: { tz?: string } = {}): Promise<ResponseEnvelope> {
  let envelope: ResponseEnvelope | undefined;
  for await (const evt of runPipeline(query, opts)) {
    if (evt.stage === "done") envelope = evt.envelope;
  }
  return envelope!;
}
