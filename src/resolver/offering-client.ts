// offering-client — the shared, low-level Kambi Offering API client (executor plan, Phase 0 prerequisite).
// The live-fetch primitives were first proven in `scripts/probe-offers.ts`; they are lifted here so the
// executor AND the probe import ONE implementation (no rewrite, no drift). Read-only public-CDN GETs (no
// auth). NOTE the cap: every BET-OFFER response is capped at 2000 betoffers and the truncation is SILENT
// (read `range.total` to detect it) — added in a later phase; the EVENT endpoint is never capped.

export const BASE = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi";

// The query string every offering call carries: a localized `lang` + a FIXED `market`. Only `lang` varies per
// query — `market` stays GB so the OFFERING (which markets/odds exist) is identical across languages and only
// the label TEXT changes. The feed returns `englishLabel` regardless of `lang`, so the resolver's identity
// (marketLabelOf) and its decision logic (select/filter) read englishLabel and stay locale-immune; only the
// displayed `label` follows `lang`.
export const DEFAULT_LOCALE = "en_GB";
const qs = (lang: string = DEFAULT_LOCALE) => `lang=${lang}&market=GB`;
export const Q = qs(); // back-compat: the default (English) query string, still imported by probes

// Map the extractor's free-text language name ("Swedish") to a supported Kambi locale. This table IS the
// supported-locale enum — owned entirely in code, so the extractor can never emit a bad locale. Unknown or
// absent language -> en_GB (English labels, never a broken `lang=`). Add a language by adding one line.
const LOCALES: Record<string, string> = {
  english: "en_GB",
  swedish: "sv_SE",
};
export const localeOf = (language?: string): string => LOCALES[(language ?? "").trim().toLowerCase()] ?? DEFAULT_LOCALE;

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
export async function eventsByGroup(groupId: number | string, lang: string = DEFAULT_LOCALE): Promise<KEvent[]> {
  const resp = await getJson(`${BASE}/event/group/${groupId}?${qs(lang)}`);
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
  description?: string; // variant text ("Winner", "Top 2") distinguishing members of one criterion family (see variantOf)
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
export async function betOffersByGroup(groupId: number | string, opts: GroupBetOfferOpts = {}, lang: string = DEFAULT_LOCALE): Promise<BetOfferResponse> {
  return normBo(await getJson(`${BASE}/betoffer/group/${groupId}?${qs(lang)}&includeParticipants=true${boParams(opts)}`));
}
// /betoffer/event/{ids} — supports type, onlyMain; excludePrePacks is ALWAYS sent (drops bet-builder pre-packs).
export async function betOffersByEvents(eventIds: number[], opts: EventBetOfferOpts = {}, lang: string = DEFAULT_LOCALE): Promise<BetOfferResponse> {
  return normBo(await getJson(`${BASE}/betoffer/event/${eventIds.join("%2C")}?${qs(lang)}&includeParticipants=true${boParams({ ...opts, excludePrePacks: true })}`));
}
// /betoffer/participant/{ids} — `type` is the ONLY server filter that bites here (onlyMain/level/playState ignored).
export async function betOffersByParticipants(ids: number[], opts: ParticipantBetOfferOpts = {}, lang: string = DEFAULT_LOCALE): Promise<BetOfferResponse> {
  return normBo(await getJson(`${BASE}/betoffer/participant/${ids.join("%2C")}?${qs(lang)}&includeParticipants=true${boParams(opts)}`));
}

// ---- prepack coupons (bet-builder Phase 1): PRE-CONFIGURED combinations, a whole betslip already priced ----
// A coupon is a set of legs joined by AND with ONE combined price. `AUTO` = machine-generated, `CUSTOM` =
// operator-curated (and the only kind that may span >1 event). The response is SELF-CONTAINED: its own
// `betOffers` label every leg (criterion / outcome / participant / line), and every leg's outcome id lives in
// the SAME id space as the normal feed — so a coupon leg matches a resolved pick by raw outcome id. Read-only.
export type PrePackOutcomeRef = { id: number; betOfferId?: number };
// A coupon row is one leg-group. TWO shapes seen live: `type:"SIMPLE"` carries ONE outcome directly on `outcome`
// (group null) — the usual shape for cross-event CUSTOM specials; `type:"BET_BUILDER"` nests its outcomes under
// `group.groups[].outcomes[]`. `odds` is that row's own (combined) price; the coupon's TOTAL is on prePackCouponBets.
export type PrePackRow = {
  id?: number;
  eventId?: number;
  type?: string;
  odds?: { decimal?: number };
  outcome?: PrePackOutcomeRef; // SIMPLE row: the single outcome (group is absent)
  group?: { groups?: { outcomes?: PrePackOutcomeRef[] }[]; outcomes?: PrePackOutcomeRef[] };
};
export type PrePackCoupon = {
  id: number;
  status?: string;
  prePackCouponRows?: PrePackRow[];
  prePackCouponBets?: { odds?: { decimal?: number } }[]; // the actual bet = rows combined; carries the combined price
  prePackCouponTags?: string[]; // ["AUTO"] | ["CUSTOM"]
};
export type PrePackResponse = { prePackCoupons: PrePackCoupon[]; betOffers: BetOffer[]; events: KEvent[] };

// /prepackcoupon/eventgroup/{ids} — pre-built coupons for whole competition(s) (comma-separated group ids). One
// cheap call returns a few hundred coupons across the group's imminent events, each self-labelled by `betOffers`.
export async function prePackByGroups(groupIds: number[], lang: string = DEFAULT_LOCALE): Promise<PrePackResponse> {
  const r = await getJson(`${BASE}/prepackcoupon/eventgroup/${groupIds.join("%2C")}?${qs(lang)}`);
  return { prePackCoupons: r.prePackCoupons ?? [], betOffers: r.betOffers ?? [], events: r.events ?? [] };
}
