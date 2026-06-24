// time-window — resolve the executor's raw time PHRASE (+ anchor) into a concrete [from,to] window and a
// kickoff-of-day band, then filter events by it. The offering API ignores from/to on every endpoint (verified),
// so time is 100% client-side. Phrases use FIXED conventions (weekend = Fri 18:00 → end of Sun, so late-Friday kickoffs count;
// a named weekday = the next occurrence of that day; "after 8pm" = kickoff >= 20:00;
// late/early = the last/first kickoff that day); a phrase we can't parse is left UNRESOLVED for the clarify
// gate (Phase 5). Dates are handled in UTC to match `event.start` (e.g. "2026-06-18T16:00:00Z").

import type { Scope } from "./schema";
import type { KEvent } from "./offering-client";

type TimeField = NonNullable<Scope["time"]>;
type Kickoff = { afterHour?: number; beforeHour?: number; relative?: "late" | "early" };
export type FixturePick = { order: "earliest" | "latest"; count: number };
export type TimeWindow = { from?: Date; to?: Date; kickoff?: Kickoff; pick?: FixturePick; unresolved?: boolean };

const startOfUTCDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
const endOfUTCDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const addHours = (d: Date, n: number) => new Date(d.getTime() + n * 3600000);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; // index = getUTCDay()

// The weekend window containing `base` (when base is Fri-eve/Sat/Sun) else the upcoming one. Starts FRIDAY
// EVENING (18:00 UTC) so late-Friday tournament kickoffs fold into "the weekend", and runs to end of Sunday.
const WEEKEND_FRI_HOUR = 18; // Friday 18:00 UTC — evening/late Friday kickoffs onward count as weekend
function weekendOf(base: Date): [Date, Date] {
  const dow = base.getUTCDay(); // 0=Sun .. 6=Sat
  const sat = dow === 6 ? startOfUTCDay(base) : dow === 0 ? startOfUTCDay(addDays(base, -1)) : startOfUTCDay(addDays(base, 6 - dow));
  const friEve = addHours(startOfUTCDay(addDays(sat, -1)), WEEKEND_FRI_HOUR);
  return [friEve, endOfUTCDay(addDays(sat, 1))];
}

// `base` = the anchor instant ("now" or tournament start). `now` is always current time (relative phrases like
// "next two days" are always from now, even when the field is tournament-anchored). The extractor now emits a
// CANONICAL TOKEN (today/tonight/tomorrow/weekend/next_<N>_hours|days|weeks) — the LLM owns the synonym mapping
// ("this evening" → today), so this is an exact token match, not a fuzzy free-text parse. An unknown token →
// null → the clarify gate (the safety net).
function parseDateWindow(value: string, base: Date, now: Date): [Date, Date] | null {
  const v = value.toLowerCase().trim();
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^next_(\d+)_(hour|day|week)s?$/))) {
    const n = Number(m[1]);
    return [now, m[2] === "hour" ? addHours(now, n) : m[2] === "week" ? addDays(now, n * 7) : addDays(now, n)];
  }
  if (v === "tomorrow") { const t = addDays(now, 1); return [startOfUTCDay(t), endOfUTCDay(t)]; }
  if (v === "today" || v === "tonight") return [now, endOfUTCDay(now)];
  if (v === "weekend") return weekendOf(base); // "opening weekend" (base=tournament start) / "this weekend" (base=now)
  // a named weekday -> its NEXT occurrence (today counts if today is that day); floor a same-day window to `now`
  // so already-kicked-off games drop, matching the `today` token. The extractor owns "Sun"/"on Saturday" -> token.
  const wd = WEEKDAYS.indexOf(v);
  if (wd >= 0) {
    const d = addDays(now, (wd - now.getUTCDay() + 7) % 7);
    return [(wd - now.getUTCDay() + 7) % 7 === 0 ? now : startOfUTCDay(d), endOfUTCDay(d)];
  }
  return null; // unknown token
}

function parseKickoff(value: string): Kickoff | null {
  const v = value.toLowerCase().trim();
  let m: RegExpMatchArray | null;
  const to24 = (n: number, ap?: string) => (ap === "pm" && n < 12 ? n + 12 : ap === "am" && n === 12 ? 0 : n);
  if ((m = v.match(/\bafter\s+(\d{1,2})\s*(am|pm)?\b/))) return { afterHour: to24(Number(m[1]), m[2]) };
  if ((m = v.match(/\bbefore\s+(\d{1,2})\s*(am|pm)?\b/))) return { beforeHour: to24(Number(m[1]), m[2]) };
  // Day-part bands (a small closed set, same UTC convention as the date tokens): "this evening", "afternoon
  // kick-offs", "morning games". An hour band, not an exact time.
  if (/\bmorning\b/.test(v)) return { beforeHour: 12 };
  if (/\bafternoon\b/.test(v)) return { afterHour: 12, beforeHour: 18 };
  if (/\bevening\b/.test(v)) return { afterHour: 17 };
  if (/\bnight\b/.test(v)) return { afterHour: 20 };
  if (/\blate\b/.test(v)) return { relative: "late" };
  if (/\bearly\b/.test(v)) return { relative: "early" };
  return null;
}

// Resolve to a concrete window. `tournamentStart` is required for a `tournament`-anchored phrase; absent (the
// participant path has no full event list) -> the date window is IGNORED (kickoff still applies) [Decided].
export function resolveTimeWindow(time: TimeField, ctx: { now: Date; tournamentStart?: Date }): TimeWindow {
  const w: TimeWindow = {};
  if (time.date_window) {
    const base = time.date_window.anchor === "tournament" ? ctx.tournamentStart : ctx.now;
    if (base) {
      const r = parseDateWindow(time.date_window.value, base, ctx.now);
      if (r) [w.from, w.to] = r;
      else w.unresolved = true; // a phrase we don't understand -> clarify (Phase 5)
    }
    // tournament anchor + no start -> ignored (no from/to, not flagged): a rare far-fetched case [Decided]
  }
  if (time.kickoff_time_of_day) {
    const k = parseKickoff(time.kickoff_time_of_day);
    if (k) w.kickoff = k; else w.unresolved = true;
  }
  if (time.fixture_pick) {
    w.pick = time.fixture_pick;
    if (!w.from) w.from = ctx.now; // lower-bound at now so "earliest"/"latest" never reach past fixtures
  }
  return w;
}

const startOf = (e: KEvent): Date | null => (e.start ? new Date(e.start) : e.originalStartDate ? new Date(e.originalStartDate) : null);
const dateKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;

// Does an event fall in the window + kickoff band? Lenient: an event with no start is kept (never dropped on
// missing data). `late`/`early` are relative to the day's other events (the last/first kickoff that date).
export function eventMatchesTime(e: KEvent, w: TimeWindow, all: KEvent[]): boolean {
  const s = startOf(e);
  if (!s) return true;
  if (w.from && s < w.from) return false;
  if (w.to && s > w.to) return false;
  const k = w.kickoff;
  if (k) {
    const h = s.getUTCHours();
    if (k.afterHour != null && h < k.afterHour) return false;
    if (k.beforeHour != null && h >= k.beforeHour) return false;
    if (k.relative) {
      const sameDay = all.map(startOf).filter((x): x is Date => x != null && dateKey(x) === dateKey(s)).map((x) => x.getUTCHours());
      if (sameDay.length && h !== (k.relative === "late" ? Math.max(...sameDay) : Math.min(...sameDay))) return false;
    }
  }
  return true;
}

export const filterEventsByTime = (events: KEvent[], w: TimeWindow): KEvent[] => events.filter((e) => eventMatchesTime(e, w, events));
export const hasWindow = (w?: TimeWindow): boolean => !!w && (w.from != null || w.to != null || w.kickoff != null);

// "next game" / "his next 2" / "their last match" — keep the first/last N fixtures by KICKOFF. Operates on a
// list already narrowed to fixtures (the caller passes MATCH-tagged events only). Events with no start drop out
// (can't order them); ties at a chosen kickoff are all kept (a double-header at the same time both count). The
// `from=now` floor that resolveTimeWindow sets for a pick has usually already dropped past fixtures upstream.
export function applyFixturePick(events: KEvent[], pick: FixturePick): KEvent[] {
  const withStart = events.filter((e) => startOf(e) != null);
  const times = [...new Set(withStart.map((e) => +startOf(e)!))].sort((a, b) => a - b);
  const chosen = new Set(pick.order === "earliest" ? times.slice(0, pick.count) : times.slice(-pick.count));
  return withStart.filter((e) => chosen.has(+startOf(e)!));
}
