// offering-client — the shared, low-level Kambi Offering API client (executor plan, Phase 0 prerequisite).
// The live-fetch primitives were first proven in `scripts/probe-offers.ts`; they are lifted here so the
// executor AND the probe import ONE implementation (no rewrite, no drift). Read-only public-CDN GETs (no
// auth). NOTE the cap: every BET-OFFER response is capped at 2000 betoffers and the truncation is SILENT
// (read `range.total` to detect it) — added in a later phase; the EVENT endpoint is never capped.

export const BASE = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi";
export const Q = "lang=en_GB&market=GB";

// Event level from the Kambi tags: COMPETITION = a tournament-wide outright, MATCH = a single fixture.
export type Level = "fixture" | "competition";
export const levelOf = (tags: string[] = []): Level | null =>
  tags.includes("COMPETITION") ? "competition" : tags.includes("MATCH") ? "fixture" : null;

// A "main"/headline market carries the MAIN tag. NOTE the distinct "MAIN_LINE" tag (an over/under's main line)
// must NOT match here — only the exact "MAIN" tag marks a bare-event main market.
export const isMain = (tags: string[] = []): boolean => tags.includes("MAIN");

export async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

export function* batches<T>(a: T[], n: number): Generator<T[]> {
  for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n);
}

// A team/player on an event. NOTE: present on BET-OFFER responses (includeParticipants) but NOT on the
// /event/group response (which carries homeName/awayName instead) — verified live 2026-06-18.
export type KParticipant = { participantId?: number; name?: string; englishName?: string; termKey?: string; home?: boolean; participantType?: string };

// A Kambi event — only the fields the executor reads. `start` is the UTC kickoff (`originalStartDate` appears
// only on rescheduled events); `state` (NOT_STARTED / STARTED / …) drives the prematch/live split; `tags`
// carry the MATCH/COMPETITION level; `homeName`/`awayName`/`participants` name the teams.
export type KEvent = {
  id: number;
  name?: string;
  englishName?: string;
  homeName?: string;
  awayName?: string;
  start?: string;
  originalStartDate?: string;
  state?: string;
  tags?: string[];
  group?: string;
  groupId?: number;
  sport?: string;
  path?: { id: number; name?: string }[];
  participants?: KParticipant[];
};

// Events only, never capped — the planning / fan-out source (and the tournament-start anchor for time).
export async function eventsByGroup(groupId: number | string): Promise<KEvent[]> {
  const resp = await getJson(`${BASE}/event/group/${groupId}?${Q}`);
  return (resp.events ?? []) as KEvent[];
}

// ---- bet-offer responses (capped at 2000; `range.total` detects truncation when present — refined in Phase 3) ----

export type KOutcome = {
  id?: number;
  label?: string;
  englishLabel?: string; // un-localized label (never reversed) — the reliable key when `type` is OT_UNTYPED
  participant?: string;
  participantId?: number; // the team/player the outcome is ABOUT (drives playerOutcomeIds / opponent filters)
  eventParticipantId?: number; // a player's TEAM (the event participant they belong to)
  odds?: number; // integer millis (1800 = 1.80)
  line?: number;
  type?: string;
  homeScore?: string; // Correct Score: numeric home goals (reversal-immune, beats the localized label)
  awayScore?: string; // Correct Score: numeric away goals
  status?: string;
};
export type BetOffer = {
  id?: number;
  eventId?: number;
  closed?: boolean;
  criterion?: { id?: number; label?: string; englishLabel?: string; lifetime?: string };
  betOfferType?: { id?: number; name?: string; englishName?: string };
  tags?: string[];
  outcomes?: KOutcome[];
};
export type BetOfferRange = { start?: number; size?: number; total?: number };
// Every bet-offer endpoint returns this SAME shape — the seam the executor is built on.
export type BetOfferResponse = { betOffers: BetOffer[]; events: KEvent[]; range?: BetOfferRange };

export type GroupBetOfferOpts = { type?: number[]; onlyMain?: boolean; onlyCompetitions?: boolean; excludeLive?: boolean; excludePrematch?: boolean; maxNumberEvents?: number };
export type EventBetOfferOpts = { type?: number[]; onlyMain?: boolean };
export type ParticipantBetOfferOpts = { type?: number[] };

// Serialize the server-side filters. `type` is comma-separated boType ids (verified to accept a list).
function boParams(o: GroupBetOfferOpts & { excludePrePacks?: boolean }): string {
  const p: string[] = [];
  if (o.type?.length) p.push(`type=${o.type.join(",")}`);
  if (o.onlyMain) p.push("onlyMain=true");
  if (o.onlyCompetitions) p.push("onlyCompetitions=true");
  if (o.excludeLive) p.push("excludeLive=true");
  if (o.excludePrematch) p.push("excludePrematch=true");
  if (o.maxNumberEvents != null) p.push(`maxNumberEvents=${o.maxNumberEvents}`);
  if (o.excludePrePacks) p.push("excludePrePacks=true");
  return p.length ? "&" + p.join("&") : "";
}

const normBo = (r: any): BetOfferResponse => ({ betOffers: r.betOffers ?? [], events: r.events ?? [], range: r.range });

// /betoffer/group/{id} — supports type, onlyMain, onlyCompetitions, excludeLive/Prematch, maxNumberEvents.
export async function betOffersByGroup(groupId: number | string, opts: GroupBetOfferOpts = {}): Promise<BetOfferResponse> {
  return normBo(await getJson(`${BASE}/betoffer/group/${groupId}?${Q}&includeParticipants=true${boParams(opts)}`));
}
// /betoffer/event/{ids} — supports type, onlyMain; excludePrePacks is ALWAYS sent (drops bet-builder pre-packs).
export async function betOffersByEvents(eventIds: number[], opts: EventBetOfferOpts = {}): Promise<BetOfferResponse> {
  return normBo(await getJson(`${BASE}/betoffer/event/${eventIds.join("%2C")}?${Q}&includeParticipants=true${boParams({ ...opts, excludePrePacks: true })}`));
}
// /betoffer/participant/{ids} — `type` is the ONLY server filter that bites here (onlyMain/level/playState ignored).
export async function betOffersByParticipants(ids: number[], opts: ParticipantBetOfferOpts = {}): Promise<BetOfferResponse> {
  return normBo(await getJson(`${BASE}/betoffer/participant/${ids.join("%2C")}?${Q}&includeParticipants=true${boParams(opts)}`));
}
