// EXECUTE — build plan Phase 4. The THIN final step. RECALL fetched and FILTER / RESOLVE / SELECT already
// decided, so execute just ASSEMBLES the answer from the picked outcomes in the live data — no fetching, no
// market decision. It consumes an ExecuteInput (resolved legs + the data they were resolved against) and
// produces a ResponseEnvelope: results grouped by EVENT, each carrying the picked betoffer with its single
// SELECTED outcome (theory §1, §4). Events with no pick never appear — the grouping IS the prune.
//
// odds / line are passed through RAW (integer millis, exactly as the feed sends them — 1800 = 1.80, -500 =
// -0.5); formatting to decimals is the consumer's job. (SELECT still matches lines in decimals internally.)

import type { BetOffer, KEvent, KOutcome, KParticipant } from "./offering-client";
import type { ExecuteInput } from "./live-menu-types";

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
};

export type EnvelopeHighlighted = { betOffer: EnvelopeBetOffer; outcomes: EnvelopeOutcome[] };

export type EnvelopeResult = {
  event: {
    id: number;
    name: string;
    homeName?: string;
    awayName?: string;
    start: string;
    group: string;
    sport: string;
    tags: string[];
    participants: EnvelopeParticipant[];
  };
  liveState?: CoarseLiveState;
  highlighted: EnvelopeHighlighted[];
  additional: EnvelopeHighlighted[];
};

export type ResponseEnvelope = {
  summary: string;
  results: EnvelopeResult[];
  notes: string[];
  clarificationNeeded: string | null;
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
});

// Kambi state -> coarse: STARTED = in play, FINISHED = done, anything else (NOT_STARTED) = prematch.
const liveStateOf = (e: KEvent): CoarseLiveState => (e.state === "STARTED" ? "LIVE" : e.state === "FINISHED" ? "FINISHED" : "PREMATCH");

const toEventBlock = (e: KEvent): EnvelopeResult["event"] => ({
  id: e.id,
  name: e.name ?? "",
  ...(e.homeName ? { homeName: e.homeName } : {}),
  ...(e.awayName ? { awayName: e.awayName } : {}),
  start: e.start ?? "",
  group: e.group ?? "",
  sport: e.sport ?? "",
  tags: e.tags ?? [],
  participants: (e.participants ?? []).map(toParticipant),
});

export function execute(input: ExecuteInput): ResponseEnvelope {
  const { data } = input;
  const clarifications = input.clarifications ?? [];

  // index once: outcomeId -> (outcome, its offer); eventId -> event
  const outcomeById = new Map<number, { o: KOutcome; b: BetOffer }>();
  const eventById = new Map<number, KEvent>();
  for (const e of data.events) if (e.id != null) eventById.set(e.id, e);
  for (const b of data.betOffers) for (const o of b.outcomes ?? []) if (o.id != null) outcomeById.set(o.id, { o, b });

  // group resolved legs by EVENT (insertion order preserved). A leg becomes a RESULT only when it picked a
  // market AND select returned a concrete outcome — the prune falls out: an event with no pick never appears.
  const byEvent = new Map<number, { event: KEvent; highlighted: EnvelopeHighlighted[] }>();
  const notes: string[] = [...(input.notes ?? [])]; // caller-built notes (e.g. unresolved time) ride along
  const noPick: string[] = []; // legs whose market wasn't offered -> clarify
  let resolvedLegs = 0; // legs that produced ≥1 outcome (drives the "independent markets" caveat — count LEGS)

  for (const leg of input.legs) {
    const { phrase, pick, selection } = leg;
    if (pick.match === "none" || pick.label == null) {
      noPick.push(phrase);
      continue;
    }

    // The participant's pool for this leg: every line+side SELECT returned (`outcomeIds`), the query's match
    // flagged `selected`. Combo/outright legs carry only the single `outcomeId` -> fall back to that. The absent
    // fallbacks carry neither -> honest note, no result.
    const ids = selection?.outcomeIds?.length ? selection.outcomeIds : selection?.outcomeId != null ? [selection.outcomeId] : [];
    const founds = ids.map((id) => outcomeById.get(id)).filter((x): x is { o: KOutcome; b: BetOffer } => x != null);
    if (!founds.length) {
      const who = selection?.subject ?? "that selection";
      if (selection?.fallback === "subject-absent") notes.push(`${who} is not offered for "${phrase}"`);
      else if (selection?.fallback === "line-absent") notes.push(`that line isn't offered for "${phrase}"`);
      else if (selection?.fallback === "odds-absent") notes.push(`no outcome in that price range for "${phrase}"`);
      else notes.push(`no settling outcome found for "${phrase}"`);
      continue;
    }

    // event comes off the SELECTED outcome's betoffer (the whole pool is one market on one fixture).
    const sel = founds.find((f) => f.o.id === selection?.outcomeId) ?? founds[0]!;
    const e = sel.b.eventId != null ? eventById.get(sel.b.eventId) : undefined;
    if (!e) {
      notes.push(`selected outcome for "${phrase}" has no event in the live data`);
      continue;
    }

    if (pick.match === "close") notes.push(`closest market for "${phrase}" — not an exact settle`);

    let g = byEvent.get(e.id);
    if (!g) byEvent.set(e.id, (g = { event: e, highlighted: [] }));
    // emit the pool grouped by betoffer (different lines are different betoffers); flag the query's match.
    const byBo = new Map<number, { b: BetOffer; outs: EnvelopeOutcome[] }>();
    for (const f of founds) {
      let grp = byBo.get(f.b.id ?? 0);
      if (!grp) byBo.set(f.b.id ?? 0, (grp = { b: f.b, outs: [] }));
      grp.outs.push({ ...toOutcome(f.o), ...(f.o.id === selection?.outcomeId ? { selected: true } : {}) });
    }
    for (const { b, outs } of byBo.values()) g.highlighted.push({ betOffer: toBetOffer(b), outcomes: outs });
    resolvedLegs += 1;
  }

  const results: EnvelopeResult[] = [...byEvent.values()].map((g) => ({
    event: toEventBlock(g.event),
    liveState: liveStateOf(g.event),
    highlighted: g.highlighted,
    additional: [],
  }));

  // 2+ independent market LEGS are not a joint bet -> the same caveat the old union note carried. Count LEGS,
  // not highlighted entries: one over/under leg now spans several line-betoffers.
  if (resolvedLegs >= 2) notes.push("showing each market on its own — not only the games that have all of these together");

  // Global fetch caveats (state a fact + a next step, never hedge): the broad fetch was capped, or a request errored.
  if (input.truncated) notes.push("This is a broad search — showing the top markets. Add a team, league, or time to see more.");
  if (input.fetchFailed) notes.push("Some live data is temporarily unavailable — showing what loaded.");

  // carried entity clarifications + any leg whose market wasn't offered, folded into one string (null = clean).
  const reasons = [...clarifications.map((c) => c.question), ...noPick.map((p) => `No market is offered for "${p}".`)];
  const clarificationNeeded = reasons.length ? reasons.join(" ") : null;

  return { summary: "", results, notes: [...new Set(notes)], clarificationNeeded };
}
