// time-window — resolve the executor's raw time PHRASE (+ anchor) into a concrete [from,to] window and a
// kickoff-of-day band, then filter events by it. The offering API ignores from/to on every endpoint (verified),
// so time is 100% client-side. Phrases use FIXED conventions (weekend = Fri 18:00 → end of Sun, so late-Friday kickoffs count;
// a named weekday = the next occurrence of that day; "after 8pm" = kickoff >= 20:00;
// late/early = the last/first kickoff that day); a phrase we can't parse is left UNRESOLVED for the clarify
// gate (Phase 5).
//
// TIMEZONE: the CALENDAR (day boundaries, weekday, hour bands) is read in the USER's zone; the INSTANTS stay
// UTC throughout, matching `event.start` (e.g. "2026-06-18T16:00:00Z"). Same split the client already uses —
// app-lib's DateUtil formats via `Intl` in the customer's zone, and queryBuilders puts `toISOString()` on the
// wire. Without it, "tonight after 8pm" for a UTC+2 user drops the 20:00-local game (18:00Z, hour 18 < 20) and
// keeps a 22:00Z one that is already tomorrow for them. `tz` absent -> UTC, i.e. the pre-tz behaviour.

import type { Scope } from "./schema";
import type { KEvent } from "./offering-client";

type TimeField = NonNullable<Scope["time"]>;
type Kickoff = { afterHour?: number; beforeHour?: number; relative?: "late" | "early" };
export type FixturePick = { order: "earliest" | "latest"; count: number };
export type TimeWindow = { from?: Date; to?: Date; kickoff?: Kickoff; pick?: FixturePick; unresolved?: boolean; unresolvedPhrase?: string; liveOk?: boolean; tz?: string };

export const UTC = "UTC"; // fallback when a caller sends no tz — the pre-tz behaviour, unchanged

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
// Wall-clock parts of an instant READ IN `tz`. Intl is the only DST-correct source (it carries the zone's
// history of rules); `hourCycle: "h23"` keeps midnight at hour 0 rather than 24.
const partsOf = (d: Date, tz: string): Parts => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: g("year"), month: g("month"), day: g("day"), hour: g("hour"), minute: g("minute"), second: g("second") };
};
// The zone's UTC offset (ms) at instant `t`. Floor to the second: partsOf has no ms field, so the fraction
// would otherwise leak into the offset.
const offsetAt = (t: number, tz: string): number => {
  const p = partsOf(new Date(t), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
};
// A wall-clock time in `tz` -> the UTC instant. Two passes: on a DST-change day the first offset is read at the
// wrong instant (it is the pre- or post-shift one), and the second reads it at the corrected instant.
const fromWall = (y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): Date => {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  return new Date(guess - offsetAt(guess - offsetAt(guess, tz), tz));
};
// `d`'s calendar day IN `tz`, at wall-clock h:mi:s.ms.
const atWall = (d: Date, tz: string, h: number, mi = 0, s = 0, ms = 0): Date => {
  const p = partsOf(d, tz);
  return fromWall(p.year, p.month, p.day, h, mi, s, ms, tz);
};
const startOfDay = (d: Date, tz: string) => atWall(d, tz, 0);
const endOfDay = (d: Date, tz: string) => atWall(d, tz, 23, 59, 59, 999);
// Day arithmetic anchors on local NOON: ±24h from midnight can slip to the previous/next date when a DST shift
// falls in between, ±24h from noon never can.
const noon = (d: Date, tz: string) => atWall(d, tz, 12);
const dayOfWeek = (d: Date, tz: string): number => {
  const p = partsOf(d, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
};
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const addHours = (d: Date, n: number) => new Date(d.getTime() + n * 3600000);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; // index = day-of-week

// The weekend window containing `base` (when base is Fri-eve/Sat/Sun) else the upcoming one. Starts FRIDAY
// EVENING (18:00 local) so late-Friday tournament kickoffs fold into "the weekend", and runs to end of Sunday.
const WEEKEND_FRI_HOUR = 18; // Friday 18:00 in the user's zone — evening/late Friday kickoffs onward count as weekend
function weekendOf(base: Date, tz: string): [Date, Date] {
  const dow = dayOfWeek(base, tz); // 0=Sun .. 6=Sat
  const sat = addDays(noon(base, tz), dow === 6 ? 0 : dow === 0 ? -1 : 6 - dow);
  return [atWall(addDays(sat, -1), tz, WEEKEND_FRI_HOUR), endOfDay(addDays(sat, 1), tz)];
}

// `base` = the anchor instant ("now" or tournament start). `now` is always current time (relative phrases like
// "next two days" are always from now, even when the field is tournament-anchored). The extractor now emits a
// CANONICAL TOKEN (today/tonight/tomorrow/weekend/next_<N>_hours|days|weeks) — the LLM owns the synonym mapping
// ("this evening" → today), so this is an exact token match, not a fuzzy free-text parse. An unknown token →
// null → the clarify gate (the safety net).
function parseDateWindow(value: string, base: Date, now: Date, tz: string): [Date, Date] | null {
  const v = value.toLowerCase().trim();
  let m: RegExpMatchArray | null;
  // A DURATION from now ("next 3 hours/days"), not a calendar span — pure instant arithmetic, zone-independent.
  if ((m = v.match(/^next_(\d+)_(hour|day|week)s?$/))) {
    const n = Number(m[1]);
    return [now, m[2] === "hour" ? addHours(now, n) : m[2] === "week" ? addDays(now, n * 7) : addDays(now, n)];
  }
  if (v === "tomorrow") { const t = addDays(noon(now, tz), 1); return [startOfDay(t, tz), endOfDay(t, tz)]; }
  if (v === "today") return [now, endOfDay(now, tz)];
  // "tonight" runs into the small hours: an 8pm-in-Dallas tip-off is 2am for a European user and still
  // "tonight"; "today" keeps the strict calendar day.
  if (v === "tonight") return [now, atWall(addDays(noon(now, tz), 1), tz, 6)];
  if (v === "weekend") return weekendOf(base, tz); // "opening weekend" (base=tournament start) / "this weekend" (base=now)
  if (v === "next_weekend") return weekendOf(addDays(noon(base, tz), 7), tz); // the weekend after the coming one
  if (v === "this_week") return [now, endOfDay(addDays(noon(now, tz), (7 - dayOfWeek(now, tz)) % 7), tz)]; // rest of the calendar week, ends Sunday
  if (v === "this_month") { const p = partsOf(now, tz); return [now, fromWall(p.year, p.month, new Date(Date.UTC(p.year, p.month, 0)).getUTCDate(), 23, 59, 59, 999, tz)]; } // rest of the calendar month (Date.UTC(y,m,0) = its last day)
  if (v === "next_week") { const mon = addDays(noon(now, tz), ((8 - dayOfWeek(now, tz)) % 7) || 7); return [startOfDay(mon, tz), endOfDay(addDays(mon, 6), tz)]; }
  // a named weekday -> its NEXT occurrence (today counts if today is that day); floor a same-day window to `now`
  // so already-kicked-off games drop, matching the `today` token. The extractor owns "Sun"/"on Saturday" -> token.
  const wd = WEEKDAYS.indexOf(v);
  if (wd >= 0) {
    const delta = (wd - dayOfWeek(now, tz) + 7) % 7;
    const d = addDays(noon(now, tz), delta);
    return [delta === 0 ? now : startOfDay(d, tz), endOfDay(d, tz)];
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
// `tz` is the USER's zone (IANA name) — it decides where a day starts and what hour a kickoff reads as.
export function resolveTimeWindow(time: TimeField, ctx: { now: Date; tz?: string; tournamentStart?: Date }): TimeWindow {
  const tz = ctx.tz ?? UTC;
  const w: TimeWindow = { tz };
  if (time.date_window) {
    const base = time.date_window.anchor === "tournament" ? ctx.tournamentStart : ctx.now;
    if (base) {
      const r = parseDateWindow(time.date_window.value, base, ctx.now, tz);
      if (r) [w.from, w.to] = r;
      else { w.unresolved = true; w.unresolvedPhrase = time.date_window.value; } // a phrase we don't understand -> clarify (Phase 5)
    }
    // tournament anchor + no start -> ignored (no from/to, not flagged): a rare far-fetched case [Decided]
  }
  if (time.kickoff_time_of_day) {
    const k = parseKickoff(time.kickoff_time_of_day);
    if (k) w.kickoff = k; else { w.unresolved = true; w.unresolvedPhrase = time.kickoff_time_of_day; }
  }
  if (time.fixture_pick) {
    w.pick = time.fixture_pick;
    if (!w.from) w.from = ctx.now; // lower-bound at now so "earliest"/"latest" never reach past fixtures
  }
  // A now-floored window (from === now: today/tonight/next_N/same-day weekday) still covers the present, so an
  // in-progress match belongs in it — let live events bypass the `s < from` drop below. NOT for pick ("next game"
  // stays strictly upcoming) nor future-day windows (tomorrow/weekend), where a live game would be the wrong day.
  w.liveOk = w.from != null && +w.from === +ctx.now && !w.pick;
  return w;
}

const startOf = (e: KEvent): Date | null => (e.start ? new Date(e.start) : e.originalStartDate ? new Date(e.originalStartDate) : null);
const dateKey = (d: Date, tz: string) => { const p = partsOf(d, tz); return `${p.year}-${p.month}-${p.day}`; };

// Does an event fall in the window + kickoff band? Lenient: an event with no start is kept (never dropped on
// missing data). `late`/`early` are relative to the day's other events (the last/first kickoff that date).
// from/to are compared as plain UTC instants; only the HOUR band and the same-day grouping read `w.tz`.
export function eventMatchesTime(e: KEvent, w: TimeWindow, all: KEvent[]): boolean {
  const s = startOf(e);
  if (!s) return true;
  if (w.from && s < w.from && !(w.liveOk && e.state === "STARTED")) return false; // live match survives a now-floored window
  if (w.to && s > w.to) return false;
  const k = w.kickoff;
  if (k) {
    const tz = w.tz ?? UTC;
    const hourIn = (d: Date) => partsOf(d, tz).hour;
    const h = hourIn(s);
    if (k.afterHour != null && h < k.afterHour) return false;
    if (k.beforeHour != null && h >= k.beforeHour) return false;
    if (k.relative) {
      const sameDay = all.map(startOf).filter((x): x is Date => x != null && dateKey(x, tz) === dateKey(s, tz)).map(hourIn);
      if (sameDay.length && h !== (k.relative === "late" ? Math.max(...sameDay) : Math.min(...sameDay))) return false;
    }
  }
  return true;
}

export const filterEventsByTime = (events: KEvent[], w: TimeWindow): KEvent[] => events.filter((e) => eventMatchesTime(e, w, events));
export const hasWindow = (w?: TimeWindow): boolean => !!w && (w.from != null || w.to != null || w.kickoff != null);

// "next game" / "his next 2" / "their last match" — keep the first/last N fixtures by KICKOFF. Counts EVENTS,
// not kickoff slots: a competition-wide "next 3 events" wants exactly 3 fixtures, even when a WC group round
// runs several at the same instant. Operates on a list already narrowed to fixtures (the caller passes
// MATCH-tagged events only). Events with no start drop out (can't order them). The `from=now` floor that
// resolveTimeWindow sets for a pick has usually already dropped past fixtures upstream.
export function applyFixturePick(events: KEvent[], pick: FixturePick): KEvent[] {
  const sorted = events.filter((e) => startOf(e) != null).sort((a, b) => +startOf(a)! - +startOf(b)!);
  return pick.order === "earliest" ? sorted.slice(0, pick.count) : sorted.slice(-pick.count);
}
