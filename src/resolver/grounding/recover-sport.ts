// Sport self-correction. The extractor's `sport` is a PRIOR, not truth: on thin context it guesses (boxing for
// two table-tennis players; `other` for a lacrosse club), the entity then grounds `none`, and the query dies.
// Fix: if a team/player name the extractor's sport is BLIND to grounds `confident` in exactly one other sport,
// adopt that sport. Zero-LLM, reuses the scope grounders. Runs once, right after extract().
//
// Why "blind" (tier `none`) and not a weak match is the trigger: generic names invert the tier signal —
// "Barcelona" is only `shortlist` in football (FC Barcelona + twins dilute it) but `confident` in virtual-sports
// (one edition); "Bundesliga" is `confident` only in ice-hockey. So switching on "confident elsewhere" would
// hijack the RIGHT sport to an obscure one. An anchor therefore votes to switch ONLY when the extractor's sport
// has NO match for it at all (both team and player index = `none`); any partial match counts as "seen" and keeps
// the extractor's sport. Competitions never vote against a NAMED sport — the same inversion, worse: football knows
// "Premier League" only weakly, lacrosse strongly; "CPL" is cricket's Caribbean Premier League, yet only football
// (Canadian Premier League) knows the acronym.
//
// LEAGUES UNDER `other`: there is no sport to protect, and a league-only query used to stop dead ("Czech Liga Pro
// matches tonight"). So under `other` a league that exactly ONE sport knows — strong there, unknown to every other —
// is placed like a team; any other league abstains, never stops. Measured on the gold's 87 leagues: 24 of the 25
// that one sport knows point at the right sport (the miss is CPL); widening to "strong in one, weak elsewhere"
// would add Premier League -> lacrosse and European Championship -> beach volley.
//
// CORROBORATION VETO: one blind anchor used to outvote a confident one. "Crvena Zvezda vs Bayern Munich, total
// points over 160.5" is basketball; Crvena Zvezda grounds `confident` there so it merely abstained, while Bayern
// Munich (basketball-blind, football-confident) cast the only vote and flipped the plan to football — a correct
// sport destroyed by the weaker signal. So an anchor that grounds STRONG in the extractor's own sport now vetoes
// switching outright: that sport is corroborated by real evidence and no other anchor may override it.
//
// SQUAD: a team is read WITH its leg's squad (the grounder's own withSquad). Bare "Växjö" finds the MEN's sides
// (Växjö Lakers HC, Växjö IBK: ice hockey + floorball); "Växjö women" finds the two (W) teams (football +
// floorball). The appended word can match on its own ("women" -> trotting's "Honky Tonk Women", winter-sports'
// "Alpine Skiing … Women"), so a WEAK hit only counts when a candidate shares a word with the bare name (a STRONG
// hit always counts: aliases). The twin is tried across ALL sports before the bare name, which is used only when
// no sport knows the twin at all — else football would claim "Lund women" through the men's Lunds BK, a side a
// women's fixture can never have.
//
// `other` = NO PRIOR, so the names decide — but only on PRECISE evidence. A query is about ONE sport, so the
// question is which sports place EVERY named anchor: "Växjö women to win at Lund" -> Växjö women {football,
// floorball} ∩ Lund women {floorball} = floorball. With no extractor sport left to guard it, the inversion above
// bites harder: a name its real sport lists only WEAKLY (England (W) behind its U19 twin in football, FC Barcelona
// among twins) would be switched silently to the one sport that happens to list it strongly (field hockey,
// handball). So an anchor with a weak hit in any sport outside its strong homes stops the rescue (keep = the
// honest unsupported-sport stop, as before this rule). One shared sport switches; two or more is a TIE.
//
// TIE — the one network call here, no LLM. "Växjö women to win on Saturday" fits Växjö DFF (W) (football) AND
// Växjö IBK (W) (floorball), and both play that Saturday (verified live 2026-09-30). The query still runs for ONE
// sport: one participant call covers every tied sport (feed ids are global), an event belongs to the sport whose
// root group is on its `path`, and it counts only when it fits a leg's level and asked time window. The sport whose
// biggest such event carries the most pre-match markets (`nonLiveBoCount`: 15 vs 5 there) wins — the feed's own
// measure of how big a match is; kickoff order was the alternative and says nothing about which match the user
// meant. A note names the other sides that have an event, so the user can add the sport. Nobody plays in the
// window -> most markets overall, and the normal no-fixture message shows alongside the note. A failed fetch (the
// feed 404s when none of the ids has an offer) degrades to "no events", like recall's failedTask.

import type { QueryPlan } from "../extractor/schema";
import {
  groundTeam,
  groundPlayer,
  groundCompetition,
  withSquad,
  type Candidate,
  type EntityResolution,
  type ScopeTier,
} from "./ground-scope";
import { resolveTimeWindow, eventMatchesTime, hasWindow } from "./time-window";
import { loadScopeCatalog, type ScopeCatalog } from "../catalog/scope-catalog";
import { userSports, getSport } from "../catalog/sports";
import { contentTokens } from "../shared/lexical";
import { betOffersByParticipants, levelOf, type BetOfferResponse, type KEvent } from "../shared/offering-client";

// One tied sport: its root group (to claim the fetched events) and what the query's names ground to there.
export type SportCandidate = { sport: string; rootId: number; ids: number[]; names: string[] };

export type SportFix =
  | { kind: "keep" }
  | { kind: "switch"; sport: string }
  | { kind: "clarify"; sports: string[] }
  | { kind: "tie"; candidates: SportCandidate[] };

type Anchor = { name: string; squad: string | null }; // squad = the leg's; players never carry one
type Homes = { strong: Map<string, Candidate[]>; weak: Set<string> }; // sport -> what it grounds; weak = seen only

const SEEN = new Set<ScopeTier>(["confident", "variants", "ambiguous", "shortlist"]); // any match = sport sees it
const STRONG = new Set<ScopeTier>(["confident", "variants"]); // switch target: exact-ish
const LIST = new Intl.ListFormat("en", { type: "conjunction" });

const humanOf = (sport: string): string => sport.replace(/-/g, " ");

// Does this grounding actually know `name`? STRONG always (aliases rename); a weak hit only through a shared word,
// so the appended squad word alone never counts (see header).
function knows(r: EntityResolution, name: string): boolean {
  if (STRONG.has(r.tier)) return true;
  if (!SEEN.has(r.tier)) return false;
  const words = contentTokens(name);
  return r.candidates.some((c) => [...contentTokens(c.name)].some((w) => words.has(w)));
}

// `text` in `cat`, team and player index — only the groundings that know `name`.
const readingsOf = (text: string, name: string, cat: ScopeCatalog): EntityResolution[] =>
  [groundTeam(text, cat), groundPlayer(text, cat)].filter((r) => knows(r, name));
// The same read over the competition index — a league, under `other` only (see header).
const leagueReadingsOf = (text: string, name: string, cat: ScopeCatalog): EntityResolution[] =>
  [groundCompetition(text, cat)].filter((r) => knows(r, name));

// `a` in the extractor's own sport: the squad twin when this sport knows it, else the bare name read exactly as
// before the squad rule (every grounding, any tier).
function groundingsOf(a: Anchor, sport: string): EntityResolution[] {
  const cat = loadScopeCatalog(sport);
  const twin = a.squad ? readingsOf(withSquad(a.name, a.squad), a.name, cat) : [];
  return twin.length ? twin : [groundTeam(a.name, cat), groundPlayer(a.name, cat)];
}

const tierIn = (a: Anchor, sport: string, tiers: Set<ScopeTier>): boolean =>
  groundingsOf(a, sport).some((r) => tiers.has(r.tier));

// Every built sport's reading of `text`: STRONG homes with what they ground to (a tie fetches those ids), and the
// sports that only know it weakly. ponytail: O(all-catalogs) lexical scan, only on the blind-anchor path;
// loadScopeCatalog memoizes per sport. Index the participant names if this ever shows.
function scanHomes(text: string, name: string, read = readingsOf): Homes {
  const homes: Homes = { strong: new Map(), weak: new Set() };
  for (const sport of userSports()) {
    const known = read(text, name, loadScopeCatalog(sport));
    const hits = known.filter((r) => STRONG.has(r.tier)).flatMap((r) => r.candidates);
    if (hits.length) homes.strong.set(sport, hits);
    else if (known.length) homes.weak.add(sport);
  }
  return homes;
}

// Where `a` could live: the squad twin across every sport first, the bare name only if no sport knows it (header).
function homesOf(a: Anchor): Homes {
  const twin = scanHomes(withSquad(a.name, a.squad), a.name);
  return !a.squad || twin.strong.size || twin.weak.size ? twin : scanHomes(a.name, a.name);
}

// Specific anchors only (teams + players, scope + subject), teams with their leg's squad. Competitions are
// read separately, under `other` only — see header.
function anchorsOf(plan: QueryPlan): Anchor[] {
  const anchors = new Map<string, Anchor>();
  const add = (name: string, squad: string | null) => anchors.set(`${name}|${squad ?? ""}`, { name, squad });
  for (const sel of plan.selectors) {
    const { squad } = sel.scope;
    if (sel.subject.kind === "team" && sel.subject.name) add(sel.subject.name, squad);
    if (sel.subject.kind === "player" && sel.subject.name) add(sel.subject.name, null);
    for (const t of sel.scope.teams) add(t, squad);
    for (const p of sel.scope.players) add(p.name, null);
  }
  return [...anchors.values()];
}

function candidateOf(sport: string, placed: Homes[]): SportCandidate {
  const hits = placed.flatMap((h) => h.strong.get(sport) ?? []);
  return {
    sport,
    rootId: loadScopeCatalog(sport).sportRootId,
    ids: [...new Set(hits.map((c) => c.id))],
    names: [...new Set(hits.map((c) => c.name))],
  };
}

export function recoverSport(plan: QueryPlan): SportFix {
  const valid = !!getSport(plan.sport); // `other`/unknown grounds nothing -> every anchor is a blind spot
  const votes = new Set<string>();
  const placed: Homes[] = []; // `other` only: each placed anchor's homes, for the shared-sport check
  for (const a of anchorsOf(plan)) {
    if (valid && tierIn(a, plan.sport, STRONG)) return { kind: "keep" }; // corroborated -> veto, see header
    if (valid && tierIn(a, plan.sport, SEEN)) continue; // extractor's sport sees it -> trust it
    const homes = homesOf(a); // blind spot -> who owns this name? (never plan.sport: it didn't even SEE it)
    if (!valid && homes.weak.size) return { kind: "keep" }; // imprecise under no prior -> the honest stop, see header
    if (homes.strong.size === 1) votes.add([...homes.strong.keys()][0]!); // exactly one confident home -> vote it
    if (!valid && homes.strong.size) placed.push(homes);
    // ponytail: under a NAMED sport, an anchor confident in >=2 other sports abstains, not clarifies; add a
    // 2-home clarify only if a real query needs it. Under `other` it still counts, via the shared check below.
  }
  // `other` only: a league exactly one sport knows is placed like a team; any other league abstains (header).
  const leagues = new Map<string, string>(); // read with the leg's squad -> the name as written
  if (!valid)
    for (const s of plan.selectors)
      if (s.scope.competition) leagues.set(withSquad(s.scope.competition, s.scope.squad), s.scope.competition);
  for (const [text, name] of leagues) {
    const homes = scanHomes(text, name, leagueReadingsOf);
    if (homes.strong.size !== 1 || homes.weak.size) continue;
    placed.push(homes);
    votes.add([...homes.strong.keys()][0]!);
  }

  if (placed.length) {
    const shared = [...placed[0]!.strong.keys()].filter((s) => placed.every((h) => h.strong.has(s)));
    if (shared.length === 1) return { kind: "switch", sport: shared[0]! };
    if (shared.length >= 2) return { kind: "tie", candidates: shared.map((s) => candidateOf(s, placed)) };
  }
  if (votes.size === 1) return { kind: "switch", sport: [...votes][0]! };
  if (votes.size >= 2) return { kind: "clarify", sports: [...votes] }; // anchors point at different sports
  return { kind: "keep" }; // nothing recovered -> fail honestly, as today
}

// Settle a TIE by the live feed (see header). Returns the sport to run, and a note naming the other sides that have
// an event (none -> no note).
export async function breakSportTie(
  plan: QueryPlan,
  candidates: SportCandidate[],
  opts: { now?: Date; tz?: string } = {},
  fetchFn: (ids: number[]) => Promise<BetOfferResponse> = betOffersByParticipants,
): Promise<{ sport: string; note?: string }> {
  // A 404 (no offer for any id) or a feed error degrades to "no events", as recall's failedTask does: the pipeline
  // still runs the first candidate and shows its honest no-fixture / fetch-failed answer.
  const events = await fetchFn([...new Set(candidates.flatMap((c) => c.ids))]).then(
    (r) => r.events,
    () => [] as KEvent[],
  );
  const now = opts.now ?? new Date();
  const legs = plan.selectors.map((sel) => ({
    level: sel.scope.level,
    window: sel.scope.time ? resolveTimeWindow(sel.scope.time, { now, tz: opts.tz }) : undefined,
  }));
  // Fits a leg: its level (an event with no level tag is kept — lenient) and its window; no window, or one we can't
  // read, takes every event. `mine` is this sport's events only, so "late"/"early" is judged within the sport.
  const fits = (e: KEvent, mine: KEvent[]): boolean =>
    legs.some(
      ({ level, window }) =>
        (levelOf(e.tags) ?? level) === level && (!window || !hasWindow(window) || eventMatchesTime(e, window, mine)),
    );
  const most = (es: KEvent[]): number => Math.max(-1, ...es.map((e) => e.nonLiveBoCount ?? 0)); // -1 = no event
  const sized = candidates.map((c) => {
    const mine = events.filter((e) => e.path?.some((p) => p.id === c.rootId));
    return { c, size: [most(mine.filter((e) => fits(e, mine))), most(mine)] as const };
  });
  // Biggest fitting event first, then biggest overall; an exact tie keeps the first (userSports order).
  const best = sized.reduce((a, b) =>
    b.size[0] > a.size[0] || (b.size[0] === a.size[0] && b.size[1] > a.size[1]) ? b : a,
  ).c;
  const others = sized
    .filter(({ c, size }) => c !== best && size[1] >= 0)
    .map(({ c }) => `${c.names.join(" / ")} in ${humanOf(c.sport)}`);
  if (!others.length) return { sport: best.sport };
  const those = others.length > 1 ? "those" : "that";
  return {
    sport: best.sport,
    note: `Showing ${humanOf(best.sport)}. This search also matches ${LIST.format(others)} — add the sport to your search to see ${those} instead.`,
  };
}
