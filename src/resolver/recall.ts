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
} from "./offering-client";
import { filterEventsByTime, hasWindow, applyFixturePick, type TimeWindow } from "./time-window";
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
  params: { type?: number[]; onlyCompetitions?: boolean; excludeLive?: boolean; excludePrematch?: boolean };
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
export async function fetchEventOffers(eventIds: number[], opts: { type?: number[] } = {}, pool = 6): Promise<{ betOffers: BetOffer[]; events: KEvent[]; truncated: boolean }> {
  const size = opts.type?.length ? 3 : 2;
  const chunks = [...batches(eventIds, size)];
  const betOffers: BetOffer[] = [];
  const evById = new Map<number, KEvent>();
  let truncated = false;
  for (let i = 0; i < chunks.length; i += pool) {
    const responses = await Promise.all(chunks.slice(i, i + pool).map((c) => betOffersByEvents(c, { type: opts.type })));
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
    const { betOffers, events, truncated } = await fetchEventOffers(picked.map((e) => e.id), { type: task.params.type });
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

// Confident entity ids + grain — the only inputs RECALL needs (no market, no criterion).
export type RecallInput = {
  grain: Grain;
  groupId?: number; // competition group id (used when no participant is named)
  participantIds?: number[]; // team/player ids — when present, the participant endpoint wins (Model P)
  eventIds?: number[]; // explicit fixtures, when already pinned
  playState?: "live" | "prematch";
  window?: TimeWindow; // already-resolved time window, applied during the group fan-out
  maxFanoutEvents?: number;
  boTypes?: number[]; // union of the selectors' bo_types ids — the server-side `type=` fetch shrink
};

export type RecallResult = {
  endpoint: "group" | "participant" | "event";
  menu: Menu;
  data: { betOffers: BetOffer[]; events: KEvent[] };
  truncated: boolean;
};

// The betoffer `description` ("Winner", "Top 4", …) — the market's VARIANT, part of its identity (theory §4).
// NOTE: the live API returns this field but offering-client's BetOffer type does not declare it yet (probes cast too).
export const variantOf = (b: BetOffer): string => String((b as Record<string, unknown>).description ?? "").trim();

// The single display label fed to the resolver: criterion label + variant. Exported so FILTER reuses the exact
// same label text it sees on the menu (no drift between menu identity and coverage matching).
export const marketLabelOf = (b: BetOffer): string => {
  const v = variantOf(b);
  return `${b.criterion?.label ?? "?"}${v ? ` — ${v}` : ""}`;
};

// Dedupe a betoffer list into the live menu: one item per distinct (criterion id + variant). Labels only — no
// odds or outcomes (theory §6). Across multiple fixtures the same market collapses to one item (fixture-pick is
// a separate concern); `eventId` keeps the first fixture seen as an example.
export function buildMenu(offers: BetOffer[]): Menu {
  const seen = new Map<string, MenuItem>();
  for (const b of offers) {
    if (b.criterion?.id == null) continue;
    const variant = variantOf(b);
    const key = `${b.criterion.id}|${variant}`;
    if (!seen.has(key)) {
      seen.set(key, {
        criterionId: b.criterion.id,
        variant,
        label: marketLabelOf(b),
        ...(b.eventId != null ? { eventId: b.eventId } : {}),
      });
    }
  }
  return [...seen.values()];
}

// Apply the resolved time window to the FETCHED result — endpoint-independent (every recall return funnels
// through here). The filter touches ONLY MATCH-tagged events (fixtures): COMPETITION outrights + untagged
// events are always kept (they carry a `start` too, so we gate on the tag, not the kickoff). MATCH events are
// date/kickoff-filtered, then narrowed to the picked fixtures ("next game"). Offers for dropped events go too,
// and the menu is rebuilt so menu/offers/events stay in lockstep. No window/pick -> passthrough.
export function finalize(
  endpoint: RecallResult["endpoint"],
  betOffers: BetOffer[],
  events: KEvent[],
  truncated: boolean,
  window?: TimeWindow,
): RecallResult {
  let evs = events;
  let offs = betOffers;
  if (window && (hasWindow(window) || window.pick)) {
    const isMatch = (e: KEvent) => levelOf(e.tags) === "fixture";
    const others = events.filter((e) => !isMatch(e)); // COMPETITION + untagged -> always kept
    let matches = filterEventsByTime(events.filter(isMatch), window);
    if (window.pick) matches = applyFixturePick(matches, window.pick);
    evs = [...others, ...matches];
    const keep = new Set(evs.map((e) => e.id));
    offs = betOffers.filter((b) => b.eventId == null || keep.has(b.eventId));
  }
  return { endpoint, menu: buildMenu(offs), data: { betOffers: offs, events: evs }, truncated };
}

// RECALL: deterministic endpoint + ids -> live menu, via the fetch engine above (cap detection + group
// fan-out). Endpoint by Model P — a named participant wins; else the competition group. No criterion `type=`
// bound (the market is deferred), so group calls fetch broad and rely on the fan-out for completeness.
export async function recall(input: RecallInput): Promise<RecallResult> {
  // explicit fixtures -> the event endpoint (via the fan-out batcher)
  if (input.eventIds?.length) {
    const r = await fetchEventOffers(input.eventIds, input.boTypes?.length ? { type: input.boTypes } : {});
    return finalize("event", r.betOffers, r.events, r.truncated, input.window);
  }
  // Model P: a named participant -> participant endpoint (even for competition-grain markets like the Golden Boot)
  if (input.participantIds?.length) {
    const task: Task = { endpoint: "participant", ids: input.participantIds, params: input.boTypes?.length ? { type: input.boTypes } : {} };
    const [res] = await runTasks([task], { window: input.window, maxFanoutEvents: input.maxFanoutEvents });
    return finalize("participant", res!.betOffers, res!.events, res!.truncated, input.window);
  }
  // else the competition group; grain sets onlyCompetitions + the fan-out level, playState sets exclude flags
  if (input.groupId == null) throw new Error("recall: need groupId, participantIds, or eventIds");
  const params: Task["params"] = {
    ...(input.boTypes?.length ? { type: input.boTypes } : {}),
    ...(input.grain === "competition" ? { onlyCompetitions: true } : {}),
    ...(input.playState === "live" ? { excludePrematch: true } : input.playState === "prematch" ? { excludeLive: true } : {}),
  };
  const fanout: NonNullable<Task["fanout"]> = {
    levels: input.grain === "competition" ? ["competition"] : ["fixture"],
    ...(input.playState ? { playState: input.playState } : {}),
  };
  const task: Task = { endpoint: "group", ids: [input.groupId], params, fanout };
  const [res] = await runTasks([task], { window: input.window, maxFanoutEvents: input.maxFanoutEvents });
  return finalize("group", res!.betOffers, res!.events, res!.truncated, input.window);
}
