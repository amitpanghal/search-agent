// RECALL — build plan Phase 1, and the new HOME of all data fetching. Resolved entity ids + coarse grain ->
// the right offering-client call(s) -> the live menu. The endpoint and ids are driven entirely by ENTITIES +
// grain, never the market (theory §1-2): the market is decided AFTER the fetch.
//
// This file owns the fetch ENGINE that used to live in executor.ts — `runTask` / `runTasks` / `fanOutGroup` /
// `fetchEventOffers` / `resolveExecutionWindow` / the 2000-cap detection. executor no longer fetches; it
// consumes what recall returns (and re-exports the engine for existing probes until the Phase-9 cleanup).
//
// Read-only public-CDN GETs. Wired to the new pipeline at the Phase-6 cut.

import {
  betOffersByGroup,
  betOffersByEvents,
  betOffersByParticipants,
  eventsByGroup,
  levelOf,
  batches,
  type BetOffer,
  type KEvent,
  type Level,
} from "./offering-client";
import { filterEventsByTime, hasWindow, applyFixturePick, resolveTimeWindow, type TimeWindow } from "./time-window";
import type { ResolvedLegScope } from "./ground-scope";
import type { Menu, MenuItem } from "./live-menu-types";

// ============================================================================
// Fetch engine (moved verbatim from executor.ts — behaviour unchanged).
// ============================================================================

// The uniform unit `runTasks` consumes. `params` are the SERVER-side filters for this endpoint; the
// client-side filters (level, playState on participant, opponent, time, …) stay in the FetchPlan's
// postFilters and are applied later by postFilter.
export type Task = {
  endpoint: "group" | "participant";
  ids: number[];
  params: { type?: number[]; onlyMain?: boolean; onlyCompetitions?: boolean; excludeLive?: boolean; excludePrematch?: boolean };
  // group only: how to pre-filter the full event list before batching when the group call caps.
  fanout?: { levels: ("fixture" | "competition")[]; playState?: "live" | "prematch" };
};

// What a task returned, kept WITH its task so postFilter knows the provenance. `truncated` flags a
// silently-capped response: prefer `range.total`, else fall back to "hit the 2000 cap exactly" (range is often
// absent — verified live).
export type TaskResult = { task: Task; betOffers: BetOffer[]; events: KEvent[]; total: number; returned: number; truncated: boolean; failed?: boolean };

// An empty, FAILED result — a fetch that errored (offering API 4xx/5xx, network) must never sink the whole
// query: it comes back empty + flagged so callers can note it and still answer (never a thrown crash).
const failedTask = (task: Task): TaskResult => ({ task, betOffers: [], events: [], total: 0, returned: 0, truncated: false, failed: true });

const CAP = 2000;

// A bet-offer response is silently truncated when `range.total` exceeds what came back; when `range` is absent
// (small responses omit it — verified live), the only signal is hitting the cap exactly.
export const isTruncated = (returned: number, total?: number): boolean => (total != null ? total > returned : returned >= CAP);

async function runTask(task: Task): Promise<TaskResult> {
  try {
    const res =
      task.endpoint === "group"
        ? await betOffersByGroup(task.ids[0]!, task.params)
        : await betOffersByParticipants(task.ids, { type: task.params.type });
    const returned = res.betOffers.length;
    const total = res.range?.total ?? returned;
    return { task, betOffers: res.betOffers, events: res.events, total, returned, truncated: isTruncated(returned, res.range?.total) };
  } catch {
    return failedTask(task); // e.g. a participant id the offering API 404s — degrade, don't throw.
  }
}

// The fan-out workhorse: fetch ALL offers for a set of events, batched under the cap and run in parallel.
// Batch size is conservative (~810 offers/match untyped, ~518 typed -> stay under 2000). `truncated` flips if
// any single batch itself caps (a batch with an unusually offer-dense event).
export async function fetchEventOffers(eventIds: number[], opts: { type?: number[]; onlyMain?: boolean } = {}, pool = 6): Promise<{ betOffers: BetOffer[]; events: KEvent[]; truncated: boolean }> {
  const size = opts.type?.length ? 3 : 2;
  const chunks = [...batches(eventIds, size)];
  const betOffers: BetOffer[] = [];
  const evById = new Map<number, KEvent>();
  let truncated = false;
  for (let i = 0; i < chunks.length; i += pool) {
    const responses = await Promise.all(chunks.slice(i, i + pool).map((c) => betOffersByEvents(c, { type: opts.type, onlyMain: opts.onlyMain })));
    for (const r of responses) {
      betOffers.push(...r.betOffers);
      for (const e of r.events) evById.set(e.id, e);
      if (isTruncated(r.betOffers.length, r.range?.total)) truncated = true;
    }
  }
  return { betOffers, events: [...evById.values()], truncated };
}

// A capped GROUP task -> fan out: the never-capped event list, pre-filtered by level/playState (region/comp are
// already the group; time/stage narrow later), then batched events. `maxEvents` is a safety backstop (the
// broad-query gate is the real guard) — exceeding it fans the first N and marks the result incomplete.
async function fanOutGroup(task: Task, maxEvents?: number, window?: TimeWindow): Promise<TaskResult> {
  try {
    const all = await eventsByGroup(task.ids[0]!);
    const want = new Set(task.fanout?.levels ?? []);
    const ps = task.fanout?.playState;
    let picked = all.filter((e) => {
      const el = levelOf(e.tags);
      if (want.size && el && !want.has(el)) return false;
      if (ps === "prematch" && e.state !== "NOT_STARTED") return false;
      if (ps === "live" && e.state === "NOT_STARTED") return false;
      return true;
    });
    if (hasWindow(window)) picked = filterEventsByTime(picked, window!); // time-scope the event list BEFORE batching
    let capped = false;
    if (maxEvents != null && picked.length > maxEvents) { picked = picked.slice(0, maxEvents); capped = true; }
    const { betOffers, events, truncated } = await fetchEventOffers(picked.map((e) => e.id), { type: task.params.type, onlyMain: task.params.onlyMain });
    const evById = new Map<number, KEvent>();
    for (const e of picked) evById.set(e.id, e); // keep the source events' tags/state
    for (const e of events) evById.set(e.id, e); // overlay the batch events' richer participants
    return { task, betOffers, events: [...evById.values()], total: betOffers.length, returned: betOffers.length, truncated: truncated || capped };
  } catch {
    return failedTask(task); // a group/event fan-out fetch errored — degrade to empty + flagged, don't throw.
  }
}

// Run tasks on a small parallel pool (~5). A truncated GROUP task fans out to complete it; a truncated
// PARTICIPANT task is a tripwire — kept partial (no events-by-participant endpoint), surfaced as a note by
// postFilter. `maxFanoutEvents` bounds the fan-out (default: unbounded).
export async function runTasks(tasks: Task[], opts: { pool?: number; maxFanoutEvents?: number; window?: TimeWindow } = {}): Promise<TaskResult[]> {
  const pool = opts.pool ?? 5;
  const out: TaskResult[] = [];
  for (let i = 0; i < tasks.length; i += pool) {
    const results = await Promise.all(tasks.slice(i, i + pool).map(runTask));
    for (const res of results) {
      if (res.truncated && res.task.endpoint === "group") out.push(await fanOutGroup(res.task, opts.maxFanoutEvents, opts.window));
      else out.push(res);
    }
  }
  return out;
}

// ============================================================================
// RECALL — the new market-deferred entry (build plan Phase 1).
// ============================================================================

// Coarse grain (theory §1): competition-level outrights vs a single fixture. With a NAMED participant the
// participant endpoint is used regardless (Model P); grain only steers the GROUP call's options + fan-out.
export type Grain = "competition" | "match";

// The BROAD fetch inputs RECALL needs (per-leg-scope: the UNION across legs; no market, no criterion). Per-leg
// time / grain / co-occurrence narrowing happens AFTER the fetch, in scopeMenu — never here.
export type RecallInput = {
  levels: Level[]; // union of leg levels — drives the group fan-out (covers both grains when legs differ)
  groupIds?: number[]; // competition group ids (no participant named); >1 ⇒ parallel group fetches, split by event.groupId
  participantIds?: number[]; // team/player ids — when present, the participant endpoint wins (Model P)
  eventIds?: number[]; // explicit fixtures, when already pinned
  playState?: "live" | "prematch"; // bound server-side ONLY when every leg agrees (else broad; scopeMenu filters)
  maxFanoutEvents?: number;
  boTypes?: number[]; // union of the selectors' bo_types ids — the server-side `type=` fetch shrink
  onlyMain?: boolean; // EVERY leg is the bare-event "main" market -> server-side onlyMain shrink (group/event only; the participant endpoint ignores it, so a per-leg client-side MAIN-tag filter covers that case downstream)
};

export type RecallResult = {
  endpoint: "group" | "participant" | "event";
  menu: Menu;
  data: { betOffers: BetOffer[]; events: KEvent[] };
  truncated: boolean;
  failed: boolean; // a group/participant fetch errored (degraded to empty via failedTask, never thrown)
};

// The betoffer `description` ("Winner", "Top 4", …) — the market's VARIANT, part of its identity (theory §4).
// NOTE: the live API returns this field but offering-client's BetOffer type does not declare it yet (probes cast too).
export const variantOf = (b: BetOffer): string => String((b as Record<string, unknown>).description ?? "").trim();

// The single display label fed to the resolver AND the market's identity: criterion englishLabel + variant.
// englishLabel (not the localized `label`) keeps the identity locale-stable, and it distinguishes markets that
// SHARE a criterion id but differ in label (the "to score at least 2/3/4 goals" family). Exported so FILTER and
// the re-slice (offersForPick) reuse the exact same identity text — no drift between menu, pick, and slice.
export const marketLabelOf = (b: BetOffer): string => {
  const v = variantOf(b);
  return `${b.criterion?.englishLabel ?? b.criterion?.label ?? "?"}${v ? ` — ${v}` : ""}`;
};

// Dedupe a betoffer list into the live menu: one item per distinct LABEL (criterion englishLabel + variant —
// see marketLabelOf). Labels only — no odds or outcomes (theory §6). Across multiple fixtures the same market
// collapses to one item (fixture-pick is a separate concern); `eventId` keeps the first fixture seen as an
// example. The label IS the identity: same label ⇒ same market — so the at-least-N family splits into one item
// per threshold, while over/under lines stay collapsed (their label is constant; the line lives on the outcomes).
export function buildMenu(offers: BetOffer[]): Menu {
  const seen = new Map<string, MenuItem>();
  for (const b of offers) {
    if (b.criterion?.id == null) continue; // an offer with no criterion isn't a real market
    const label = marketLabelOf(b);
    if (!seen.has(label)) seen.set(label, { label, ...(b.eventId != null ? { eventId: b.eventId } : {}) });
  }
  return [...seen.values()];
}

// A fixture co-occurs a set of named teams when its TEAM participants include ALL of them (match by id).
// Lenient: a fixture with no listed team participants is kept (never dropped on missing data — same discipline
// as the time filter). COMPETITION events bundle many teams, so this is only ever applied to MATCH fixtures.
function fixtureHasAllTeams(e: KEvent, teamIds: number[]): boolean {
  const ids = new Set(
    (e.participants ?? []).filter((p) => p.participantType === "TEAM" && p.participantId != null).map((p) => p.participantId!),
  );
  if (ids.size === 0) return true;
  return teamIds.every((id) => ids.has(id));
}

// Build the BROAD RecallResult — NO narrowing (finalize is deleted): per-leg time/grain/co-occurrence narrowing
// is scopeMenu's job now. The menu here is the broad menu; the orchestrator rebuilds a narrowed one per leg.
function out(endpoint: RecallResult["endpoint"], betOffers: BetOffer[], events: KEvent[], truncated: boolean, failed = false): RecallResult {
  return { endpoint, menu: buildMenu(betOffers), data: { betOffers, events }, truncated, failed };
}

// RECALL: deterministic endpoint + ids -> the BROAD live data, via the fetch engine above (cap detection + group
// fan-out). Endpoint by Model P — a named participant wins; else the competition group(s). No criterion `type=`
// bound (market deferred), and NO time/grain/co-occurrence narrowing here — that is per-leg, in scopeMenu.
export async function recall(input: RecallInput): Promise<RecallResult> {
  const typeP = input.boTypes?.length ? { type: input.boTypes } : {};
  const mainP = input.onlyMain ? { onlyMain: true } : {}; // all-main shrink; participant ignores it (filtered client-side downstream)
  // explicit fixtures -> the event endpoint (via the fan-out batcher)
  if (input.eventIds?.length) {
    const r = await fetchEventOffers(input.eventIds, { ...typeP, ...mainP });
    return out("event", r.betOffers, r.events, r.truncated);
  }
  // Model P: a named participant -> participant endpoint (even for competition-grain markets like the Golden Boot)
  if (input.participantIds?.length) {
    const task: Task = { endpoint: "participant", ids: input.participantIds, params: typeP };
    const [res] = await runTasks([task], { maxFanoutEvents: input.maxFanoutEvents });
    return out("participant", res!.betOffers, res!.events, res!.truncated, res!.failed ?? false);
  }
  // else the competition group(s): ONE task per group, run in parallel (each keeps its own cap/fan-out handling).
  // event.groupId differentiates them so scopeMenu can separate the legs. onlyCompetitions only when EVERY leg is
  // competition-grain; the fan-out covers the UNION of levels.
  if (!input.groupIds?.length) throw new Error("recall: need groupIds, participantIds, or eventIds");
  const onlyComp = input.levels.length === 1 && input.levels[0] === "competition";
  const params: Task["params"] = {
    ...typeP,
    ...mainP,
    ...(onlyComp ? { onlyCompetitions: true } : {}),
    ...(input.playState === "live" ? { excludePrematch: true } : input.playState === "prematch" ? { excludeLive: true } : {}),
  };
  const fanout: NonNullable<Task["fanout"]> = { levels: input.levels, ...(input.playState ? { playState: input.playState } : {}) };
  const tasks: Task[] = input.groupIds.map((id) => ({ endpoint: "group", ids: [id], params, fanout }));
  const results = await runTasks(tasks, { maxFanoutEvents: input.maxFanoutEvents });
  const evById = new Map<number, KEvent>();
  for (const r of results) for (const e of r.events) evById.set(e.id, e);
  return out("group", results.flatMap((r) => r.betOffers), [...evById.values()], results.some((r) => r.truncated), results.some((r) => r.failed));
}

// scopeMenu — narrow the BROAD recall data to ONE leg's scope, then build that leg's menu (replaces finalize's
// global narrowing). Every filter is per-leg: grain (the leg's level tag), competition (event.groupId), a per-leg
// live/prematch cut (when the broad fetch couldn't bind it), then the MATCH-only filters — head-to-head
// co-occurrence and the time window + "next game" pick. COMPETITION outrights + untagged events pass the
// MATCH-only filters (same discipline finalize had), and a MISSING level/groupId is kept (never drop on missing
// data). Returns the menu + narrowed offers/events + kept event-ids (so one leg's events stay out of another's).
export type ScopedMenu = { menu: Menu; offers: BetOffer[]; events: KEvent[]; eventIds: number[]; timeUnresolved: boolean };
export function scopeMenu(
  data: { betOffers: BetOffer[]; events: KEvent[] },
  leg: ResolvedLegScope,
  opts: { now?: Date } = {},
): ScopedMenu {
  const compId = leg.competition?.tier === "confident" ? leg.competition.candidates[0]!.id : null;
  const teamIds = leg.teams.filter((t) => t.tier === "confident").flatMap((t) => t.candidates.map((c) => c.id));
  const window = leg.time ? resolveTimeWindow(leg.time, { now: opts.now ?? new Date() }) : undefined;

  let evs = data.events.filter((e) => {
    const el = levelOf(e.tags);
    if (el && el !== leg.level) return false; // grain (untagged kept)
    if (compId != null && e.groupId != null && e.groupId !== compId) return false; // competition (no-groupId kept)
    if (leg.playState === "prematch" && e.state !== "NOT_STARTED") return false;
    if (leg.playState === "live" && e.state === "NOT_STARTED") return false;
    return true;
  });
  // MATCH-only filters (COMPETITION + untagged always kept through these).
  const isMatch = (e: KEvent) => levelOf(e.tags) === "fixture";
  const others = evs.filter((e) => !isMatch(e));
  let matches = evs.filter(isMatch);
  if (teamIds.length >= 2) matches = matches.filter((e) => fixtureHasAllTeams(e, teamIds)); // head-to-head
  if (window && (hasWindow(window) || window.pick)) {
    matches = filterEventsByTime(matches, window);
    if (window.pick) matches = applyFixturePick(matches, window.pick);
  }
  evs = [...others, ...matches];
  const keep = new Set(evs.map((e) => e.id));
  const offers = data.betOffers.filter((b) => b.eventId == null || keep.has(b.eventId));
  return { menu: buildMenu(offers), offers, events: evs, eventIds: [...keep], timeUnresolved: !!window?.unresolved };
}
