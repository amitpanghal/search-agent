// EXECUTE — build plan Phase 4. The THIN final step. RECALL fetched and FILTER / RESOLVE / SELECT already
// decided, so execute just ASSEMBLES the answer from the picked outcomes in the live data — no fetching, no
// market decision. It consumes an ExecuteInput (resolved legs + the data they were resolved against) and
// produces a ResponseEnvelope: one `results` card per event with a pick (its highlighted betoffers, each with the
// single SELECTED outcome — theory §1, §4), plus a top-level `events[]` holding every referenced event block ONCE
// (result events + betslip-leg events, deduped by id). Events with no pick never appear — the grouping IS the
// prune. A leg fully priced into the betslip drops its standalone result card (the combo card answers it). A card
// joins its event via highlighted[].eventId; `additional` (related-market suggestions) is a flat, query-scoped
// list capped at 3.
//
// odds / line are passed through RAW (integer millis, exactly as the feed sends them — 1800 = 1.80, -500 =
// -0.5); formatting to decimals is the consumer's job. (SELECT still matches lines in decimals internally.)

import type { BetOffer, KEvent, KOutcome, KParticipant } from "./offering-client";
import type { ExecuteInput, EnvelopeLeg } from "./live-menu-types";
import type { Combination } from "./combinations";
import type { QueryCost } from "./cost";
import { marketLabelOf } from "./recall";
import { isNamedOutcome, subjectOutcomes } from "./select";
import { fold } from "./lexical";

export type CoarseLiveState = "PREMATCH" | "LIVE" | "FINISHED";

export type EnvelopeParticipant = {
  participantId: number;
  name: string;
  englishName?: string;
  termKey: string;
  participantType: "TEAM" | "PARTICIPANT" | "LABEL" | "UNKNOWN";
  home?: boolean;
};

export type EnvelopeOutcome = {
  id?: number; // raw Kambi feed outcome id — the betslip selection id (omitted only if the feed sent none)
  label: string;
  englishLabel?: string;
  odds: number; // RAW integer millis (1800 = 1.80) — passed straight through, never divided
  line?: number; // RAW integer millis (-500 = -0.5)
  participant?: string;
  participantId?: number;
  eventParticipantId?: number;
  type?: string;
  status: "OPEN" | "SUSPENDED" | "CLOSED" | "SETTLED";
  selected?: boolean; // true on the one outcome matching the query's line/side; the rest are the alternatives
};

export type EnvelopeBetOffer = {
  id: number;
  criterion: { id: number; label: string; englishLabel?: string; lifetime?: string };
  betOfferType: { id: number; name: string; englishName?: string };
  tags: string[];
  description?: string; // the variant text ("Winner", "Top 2") that distinguishes members of one criterion family
};

// A highlighted (or additional) market, tagged with the event it settles on. `eventId` is the join key into the
// envelope's top-level `events[]`: results/additional carry only market data, and the consumer looks the event up
// by this id — so each event block is stored ONCE (never re-embedded per card).
export type EnvelopeHighlighted = { eventId: number; betOffer: EnvelopeBetOffer; outcomes: EnvelopeOutcome[] };

// One event block, stored once in the envelope's `events[]` (covers BOTH result events and betslip-leg
// events). `state` is the coarse live state ("PREMATCH" | "LIVE" | "FINISHED"); the rest mirrors the feed event.
export type ResponseEvent = {
  id: number;
  name: string;
  homeName?: string;
  awayName?: string;
  start: string;
  group: string;
  sport: string;
  tags: string[];
  participants: EnvelopeParticipant[];
  state: string;
};

// A result card = one event's picked markets. The event itself lives in `events[]`; join via highlighted[].eventId.
export type EnvelopeResult = { highlighted: EnvelopeHighlighted[] };

// A leg's grounded subject — the frontend's tile identity (player tile / team tile). Deduped by id: one entry
// (one tile) per entity even when it subjects several legs. Only CONFIDENT groundings appear (a tile navigates
// to the entity's page, which needs the real id). Event tiles come from `events[]`, not here. `eventIds` joins
// into `events[]`: every event the subject's resolved pick(s) landed on (one per fixture for a multi-fixture
// leg, merged across legs); empty when the subject's leg(s) resolved no outcome.
export type EnvelopeSubject = { kind: "player" | "team"; id: number; name: string; eventIds: number[] };

export type ResponseEnvelope = {
  summary: string;
  events: ResponseEvent[]; // every event referenced by a result OR a betslip leg, stored once (deduped by id)
  subjects: EnvelopeSubject[]; // grounded leg subjects for tiles, deduped by id; orchestrator fills it
  results: EnvelopeResult[];
  legs: EnvelopeLeg[]; // "We understood" echo — one per selector in QUERY order (see EnvelopeLeg); orchestrator fills it
  additional: EnvelopeHighlighted[]; // query-scoped related-market suggestions, flat + globally capped at 3
  notes: string[];
  clarificationNeeded: string | null;
  betslip?: Combination; // the user's own resolved legs priced together; omitted when <2 combinable legs
  cost?: QueryCost; // per-query LLM token usage + Bedrock cost, attached by runPipeline (see cost.ts)
};

// ---- raw -> envelope mappers (NO unit conversion: odds/line stay integer millis) ----
const PTYPES = new Set(["TEAM", "PARTICIPANT", "LABEL"]);
const toParticipant = (p: KParticipant): EnvelopeParticipant => ({
  participantId: p.participantId ?? 0,
  name: p.name ?? "",
  ...(p.englishName ? { englishName: p.englishName } : {}),
  termKey: p.termKey ?? "",
  participantType: (PTYPES.has(p.participantType ?? "") ? p.participantType : "UNKNOWN") as EnvelopeParticipant["participantType"],
  ...(p.home != null ? { home: p.home } : {}),
});

const STATUSES = new Set(["OPEN", "SUSPENDED", "CLOSED", "SETTLED"]);
const toOutcome = (o: KOutcome): EnvelopeOutcome => ({
  ...(o.id != null ? { id: o.id } : {}),
  label: o.label ?? "",
  ...(o.englishLabel ? { englishLabel: o.englishLabel } : {}),
  odds: o.odds ?? 0,
  ...(o.line != null ? { line: o.line } : {}),
  ...(o.participant ? { participant: o.participant } : {}),
  ...(o.participantId != null ? { participantId: o.participantId } : {}),
  ...(o.eventParticipantId != null ? { eventParticipantId: o.eventParticipantId } : {}),
  ...(o.type ? { type: o.type } : {}),
  status: (STATUSES.has(o.status ?? "") ? o.status : "OPEN") as EnvelopeOutcome["status"],
});

const toBetOffer = (b: BetOffer): EnvelopeBetOffer => ({
  id: b.id ?? 0,
  criterion: {
    id: b.criterion?.id ?? 0,
    label: b.criterion?.label ?? "",
    ...(b.criterion?.englishLabel ? { englishLabel: b.criterion.englishLabel } : {}),
    ...(b.criterion?.lifetime ? { lifetime: b.criterion.lifetime } : {}),
  },
  betOfferType: {
    id: b.betOfferType?.id ?? 0,
    name: b.betOfferType?.name ?? "",
    ...(b.betOfferType?.englishName ? { englishName: b.betOfferType.englishName } : {}),
  },
  tags: b.tags ?? [],
  ...(b.description ? { description: b.description } : {}),
});

// Kambi state -> coarse: STARTED = in play, FINISHED = done, anything else (NOT_STARTED) = prematch.
const liveStateOf = (e: KEvent): CoarseLiveState => (e.state === "STARTED" ? "LIVE" : e.state === "FINISHED" ? "FINISHED" : "PREMATCH");

const toEventBlock = (e: KEvent): ResponseEvent => ({
  id: e.id,
  name: e.name ?? "",
  ...(e.homeName ? { homeName: e.homeName } : {}),
  ...(e.awayName ? { awayName: e.awayName } : {}),
  start: e.start ?? "",
  group: e.group ?? "",
  sport: e.sport ?? "",
  tags: e.tags ?? [],
  participants: (e.participants ?? []).map(toParticipant),
  state: liveStateOf(e),
});

// A related-market SUGGESTION should echo the answer's subject, not re-list every player. Trim a related
// betoffer's outcomes for display:
//   - participant-keyed field (one outcome per player/team, incl. player props that also carry a line) + a named
//     subject -> cut to the asked subject; DROPPED (null) when it doesn't price them (off-topic to the answer).
//   - subjectless team LINE ladder (over/under, handicap) -> kept whole; the alternative lines ARE the value.
//   - any other long field (correct score, a subjectless outright) -> capped to the most-likely N by odds.
// A small market (<= cap) and a no-subject query both pass through untouched.
const ADDL_OUTCOME_CAP = 8;
const trimRelatedOutcomes = (outcomes: KOutcome[], subj: { subjectId?: number; subject?: string }): KOutcome[] | null => {
  if (outcomes.some(isNamedOutcome) && (subj.subjectId != null || subj.subject)) {
    const mine = subjectOutcomes(outcomes, subj);
    return mine.length ? mine : null;
  }
  if (outcomes.some((o) => o.line != null)) return outcomes;
  return outcomes.length > ADDL_OUTCOME_CAP
    ? [...outcomes].sort((a, b) => (a.odds ?? Infinity) - (b.odds ?? Infinity)).slice(0, ADDL_OUTCOME_CAP)
    : outcomes;
};

// Sentence for a leg that produced no pick, sized to how much the query pinned down. no-market: the fixture was
// found but the concept isn't offered. no-fixture: we know the scope (teams joined by " vs "); two teams => the
// matchup isn't live, one team => nudge for an opponent/competition (which also disambiguates the sport).
const noPickReason = (unavailable: { kind: "no-fixture" | "no-market"; scope?: string } | undefined, phrase: string): string => {
  if (unavailable?.kind !== "no-fixture")
    return `No "${phrase}" market is available. It may not be offered for the selected game or event.`;
  const { scope } = unavailable;
  if (scope?.includes(" vs ")) return `We couldn't find a ${scope} match on the schedule right now.`;
  if (scope) return `We couldn't find an upcoming match for ${scope}. Try adding the opponent or competition to narrow your search.`;
  return `No event matched your search, so we couldn't find anything for "${phrase}".`;
};

export function execute(input: ExecuteInput): ResponseEnvelope {
  const { data } = input;
  const clarifications = input.clarifications ?? [];

  // index once: outcomeId -> (outcome, its offer); eventId -> event
  const outcomeById = new Map<number, { o: KOutcome; b: BetOffer }>();
  const eventById = new Map<number, KEvent>();
  for (const e of data.events) if (e.id != null) eventById.set(e.id, e);
  for (const b of data.betOffers) for (const o of b.outcomes ?? []) if (o.id != null) outcomeById.set(o.id, { o, b });

  // Outcomes already priced INTO the betslip: a leg fully covered here is answered by the combo card, so its
  // standalone result card is dropped (the combined odds IS its price). A partially covered leg keeps its card.
  const comboIds = new Set((input.betslip?.legs ?? []).map((l) => l.outcomeId));

  // group resolved legs by EVENT (insertion order preserved). A leg becomes a RESULT only when it picked a
  // market AND select returned a concrete outcome — the prune falls out: an event with no pick never appears.
  const byEvent = new Map<number, { event: KEvent; highlighted: EnvelopeHighlighted[]; byBo: Map<number, { b: BetOffer; outs: EnvelopeOutcome[] }>; additional: EnvelopeHighlighted[]; addBos: Set<number> }>();
  const notes: string[] = [...(input.notes ?? [])]; // caller-built notes (e.g. unresolved time) ride along
  const noPick: string[] = []; // clarify sentences for legs with no pick (no-fixture vs no-market)
  let resolvedLegs = 0; // legs that produced ≥1 outcome (drives the "independent markets" caveat — count LEGS)
  const pendingRelated: { related: string[]; eventIds: Set<number>; subj: { subjectId?: number; subject?: string } }[] = [];

  for (const leg of input.legs) {
    const { phrase, pick, selection, unavailable } = leg;
    if (pick.match === "none" || pick.label == null) {
      noPick.push(noPickReason(unavailable, phrase));
      continue;
    }

    // The participant's pool for this leg: every line+side SELECT returned (`outcomeIds`), the query's match
    // flagged `selected`. Combo/outright legs carry only the single `outcomeId` -> fall back to that. The absent
    // fallbacks carry neither -> honest note, no result.
    const ids = selection?.outcomeIds?.length ? selection.outcomeIds : selection?.outcomeId != null ? [selection.outcomeId] : [];
    // Which outcomes are the query's PICK (flagged `selected`): a relational multi-fixture leg picks one per
    // fixture (`selectedIds`); every other leg picks the single `outcomeId`. A set so each is flagged in place.
    const selectedSet = new Set<number>(selection?.selectedIds?.length ? selection.selectedIds : selection?.outcomeId != null ? [selection.outcomeId] : []);
    // Fully combined into the betslip -> no independent result card. Still counts as resolved (its answer is
    // the combo card); its event block is re-attached after grouping (see the betslip-events loop below).
    if (selectedSet.size && [...selectedSet].every((id) => comboIds.has(id))) { resolvedLegs++; continue; }
    const founds = ids.map((id) => outcomeById.get(id)).filter((x): x is { o: KOutcome; b: BetOffer } => x != null);
    if (!founds.length) {
      const who = selection?.subject ?? "that selection";
      if (selection?.fallback === "subject-absent") notes.push(`${who} isn't priced in the "${phrase}" market. Try another market or choose a different subject.`);
      else if (selection?.fallback === "line-absent") notes.push(`That line isn't available for "${phrase}". It may not be offered for this event or market.`);
      else if (selection?.fallback === "odds-absent") notes.push(`No outcome is available in that price range for "${phrase}". Try a different price range or market.`);
      else notes.push(`We couldn't find a settling outcome for "${phrase}". The market may settle differently than expected.`);
      continue;
    }
    // A single leg's pool can span MULTIPLE fixtures (a "main" market like Match Result over the next N
    // events). Group each outcome under ITS OWN betoffer's event — not the selected outcome's — else every
    // fixture's offers collapse into one event block. Different lines are different betoffers; the query's
    // match is flagged wherever it lands.
    let placed = 0;
    for (const f of founds) {
      const e = f.b.eventId != null ? eventById.get(f.b.eventId) : undefined;
      if (!e) continue;
      let g = byEvent.get(e.id);
      if (!g) byEvent.set(e.id, (g = { event: e, highlighted: [], byBo: new Map(), additional: [], addBos: new Set() }));
      let grp = g.byBo.get(f.b.id ?? 0);
      if (!grp) {
        g.byBo.set(f.b.id ?? 0, (grp = { b: f.b, outs: [] }));
        g.highlighted.push({ eventId: e.id, betOffer: toBetOffer(f.b), outcomes: grp.outs });
      }
      grp.outs.push({ ...toOutcome(f.o), ...(f.o.id != null && selectedSet.has(f.o.id) ? { selected: true } : {}) });
      placed++;
    }
    if (!placed) {
      notes.push(`The selected outcome for "${phrase}" isn't linked to a live event. It may no longer be available or isn't included in the current live data.`);
      continue;
    }
    resolvedLegs += 1;

    if (pick.related?.length) {
      const eventIds = new Set(founds.map(f => f.b.eventId).filter((id): id is number => id != null && eventById.has(id)));
      const subj = { ...(leg.subjectId != null ? { subjectId: leg.subjectId } : {}), ...(selection?.subject ? { subject: selection.subject } : {}) };
      pendingRelated.push({ related: pick.related, eventIds, subj });
    }
  }

  // Round-robin across legs, rank by rank, until the global related-market budget (3) is spent.
  // Guarantees >=1 per leg (best-effort) while keeping the total cap hard.
  if (pendingRelated.length) {
    let relBudget = 3;
    const maxRank = Math.max(...pendingRelated.map(p => p.related.length));
    outer: for (let rank = 0; rank < maxRank; rank++) {
      for (const { related, eventIds, subj } of pendingRelated) {
        if (relBudget <= 0) break outer;
        const relLabel = related[rank];
        if (relLabel == null) continue;
        // The betoffers this label matches. Combo markets ("A || B") leave `participant` null and carry the
        // competitor names in the LABEL, so trimRelatedOutcomes's subject gate is blind to them. Prefer within
        // the matched family: if any row names the subject, drop the rows that don't, so a Haaland query never
        // shows "Marmoush || Semenyo". When no row names anyone (Over/Under, Yes/No) nothing is dropped, and a
        // subject we only know by id (no name text) leaves the family untouched.
        const fam = data.betOffers.filter((b) => marketLabelOf(b) === relLabel && b.eventId != null && eventIds.has(b.eventId));
        const s = subj.subject ? fold(subj.subject) : "";
        const named = s ? fam.filter((b) => (b.outcomes ?? []).some((o) => fold(o.englishLabel ?? o.label ?? "").includes(s))) : [];
        for (const b of named.length ? named : fam) {
          // Spend the budget per ROW, not per label: one label ("Either Player To Score") matches a betoffer
          // per player pairing per event, so decrementing once per label let a single label ship dozens of rows
          // under a documented cap of 3.
          if (relBudget <= 0) break;
          const g = b.eventId != null ? byEvent.get(b.eventId) : undefined;
          if (!g) continue;
          const boId = b.id ?? 0;
          if (g.byBo.has(boId) || g.addBos.has(boId)) continue;
          const outs = trimRelatedOutcomes(b.outcomes ?? [], subj);
          if (outs == null) continue; // participant-keyed market that doesn't price the subject -> off-topic, drop
          g.addBos.add(boId);
          g.additional.push({ eventId: g.event.id, betOffer: toBetOffer(b), outcomes: outs.map(toOutcome) });
          relBudget--;
        }
      }
    }
  }

  // One card per event with a pick (highlighted only — the event block lives in `events`). `additional` is now
  // query-scoped: flatten each event's related markets into one array (the round-robin above already capped the
  // TOTAL at 3). `events` holds every result event, then any betslip-leg event not already shown (a fully
  // combined leg has no result card, but the frontend still needs its event block for the event tile).
  const groups = [...byEvent.values()];
  const results: EnvelopeResult[] = groups.map((g) => ({ highlighted: g.highlighted }));
  const additional: EnvelopeHighlighted[] = groups.flatMap((g) => g.additional);
  const events: ResponseEvent[] = groups.map((g) => toEventBlock(g.event));
  const shownIds = new Set(events.map((e) => e.id));
  for (const l of input.betslip?.legs ?? []) {
    if (l.eventId == null || shownIds.has(l.eventId)) continue;
    const e = eventById.get(l.eventId);
    if (e) { shownIds.add(l.eventId); events.push(toEventBlock(e)); }
  }

  // 2+ independent market LEGS are not a joint bet -> the same caveat the old union note carried. Count LEGS,
  // not highlighted entries: one over/under leg now spans several line-betoffers.
  // if (resolvedLegs >= 2) notes.push("These markets don't all appear on the same games. We're showing each market separately instead of filtering to games that contain every selected market.");

  // Global fetch caveats (state a fact + a next step, never hedge): the broad fetch was capped, or a request errored.
  if (input.truncated) notes.push("Your search matches a large number of results. We're showing the most relevant markets first. Add a team, league, or kickoff time to narrow your search.");
  if (input.fetchFailed) notes.push("Some live data is temporarily unavailable. We're showing everything that loaded successfully while the remaining data catches up.");

  // carried entity clarifications + any leg whose market wasn't offered (each already a full sentence), folded
  // into one string (null = clean).
  // Entity doubt is moot when EVERY leg placed a real outcome without it; clarification refs are
  // entity-cells, not legs, so all-legs-resolved is the finest drop expressible here.
  const allLegsResolved = input.legs.length > 0 && resolvedLegs === input.legs.length;
  const reasons = [...(allLegsResolved ? [] : clarifications.map((c) => c.question)), ...new Set(noPick)];
  const clarificationNeeded = reasons.length ? reasons.join(" ") : null;

  return {
    summary: "",
    events,
    subjects: [], // filled by the orchestrator (it holds the grounded subjects); [] on execute-only callers/tests
    results,
    legs: [], // filled by the orchestrator (it holds the per-selector plan); [] on execute-only callers/tests
    additional,
    notes: [...new Set(notes)],
    clarificationNeeded,
    ...(input.betslip ? { betslip: input.betslip } : {}),
  };
}
