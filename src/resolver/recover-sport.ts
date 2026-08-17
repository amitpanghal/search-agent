// Sport self-correction. The extractor's `sport` is a PRIOR, not truth: on thin context it guesses (boxing for
// two table-tennis players; `other` for a lacrosse club), the entity then grounds `none`, and the query dies.
// Fix: if a team/player name the extractor's sport is BLIND to grounds `confident` in exactly one other sport,
// adopt that sport. Deterministic, zero-LLM, reuses the scope grounders. Runs once, right after extract().
//
// Why "blind" (tier `none`) and not a weak match is the trigger: generic names invert the tier signal —
// "Barcelona" is only `shortlist` in football (FC Barcelona + twins dilute it) but `confident` in virtual-sports
// (one edition); "Bundesliga" is `confident` only in ice-hockey. So switching on "confident elsewhere" would
// hijack the RIGHT sport to an obscure one. An anchor therefore votes to switch ONLY when the extractor's sport
// has NO match for it at all (both team and player index = `none`); any partial match counts as "seen" and keeps
// the extractor's sport. Competitions are excluded entirely — the same inversion, worse — so they never switch.
//
// CORROBORATION VETO: one blind anchor used to outvote a confident one. "Crvena Zvezda vs Bayern Munich, total
// points over 160.5" is basketball; Crvena Zvezda grounds `confident` there so it merely abstained, while Bayern
// Munich (basketball-blind, football-confident) cast the only vote and flipped the plan to football — a correct
// sport destroyed by the weaker signal. So an anchor that grounds STRONG in the extractor's own sport now vetoes
// switching outright: that sport is corroborated by real evidence and no other anchor may override it.

import type { QueryPlan } from "./schema";
import { groundTeam, groundPlayer, type ScopeTier } from "./ground-scope";
import { loadScopeCatalog } from "./scope-catalog";
import { builtSports, getSport } from "./sports";

export type SportFix =
  | { kind: "keep" }
  | { kind: "switch"; sport: string }
  | { kind: "clarify"; sports: string[] };

const SEEN = new Set<ScopeTier>(["confident", "variants", "ambiguous", "shortlist"]); // any match = sport sees it
const STRONG = new Set<ScopeTier>(["confident", "variants"]);                          // switch target: exact-ish

// Does `sport` ground `name` at one of `tiers` (team OR player index)? An empty catalog (`other`) yields false.
function tierIn(name: string, sport: string, tiers: Set<ScopeTier>): boolean {
  const cat = loadScopeCatalog(sport);
  return tiers.has(groundTeam(name, cat).tier) || tiers.has(groundPlayer(name, cat).tier);
}

// The built sports that ground `name` confident (team OR player). ponytail: O(all-catalogs) lexical scan, only
// on the blind-anchor path; loadScopeCatalog memoizes per sport. Index the participant names if this ever shows.
function strongSports(name: string): string[] {
  return builtSports().filter((s) => {
    const cat = loadScopeCatalog(s);
    return STRONG.has(groundTeam(name, cat).tier) || STRONG.has(groundPlayer(name, cat).tier);
  });
}

// Specific anchors only (teams + players, scope + subject). Competitions excluded — see header.
function anchorsOf(plan: QueryPlan): Set<string> {
  const anchors = new Set<string>();
  for (const sel of plan.selectors) {
    if ((sel.subject.kind === "team" || sel.subject.kind === "player") && sel.subject.name) anchors.add(sel.subject.name);
    for (const t of sel.scope.teams) anchors.add(t);
    for (const p of sel.scope.players) anchors.add(p.name);
  }
  return anchors;
}

export function recoverSport(plan: QueryPlan): SportFix {
  const anchors = anchorsOf(plan);

  const valid = !!getSport(plan.sport); // `other`/unknown grounds nothing -> every anchor is a blind spot
  const votes = new Set<string>();
  for (const name of anchors) {
    if (valid && tierIn(name, plan.sport, STRONG)) return { kind: "keep" }; // corroborated -> veto, see header
    if (valid && tierIn(name, plan.sport, SEEN)) continue;              // extractor's sport sees it -> trust it
    const strong = strongSports(name).filter((s) => s !== plan.sport); // blind spot -> who owns this name?
    if (strong.length === 1) votes.add(strong[0]!);                    // exactly one confident home -> vote it
    // ponytail: an anchor confident in >=2 sports (shared name) abstains, not clarifies; add a 2-home clarify
    // only if a real query needs it.
  }

  if (votes.size === 1) return { kind: "switch", sport: [...votes][0]! };
  if (votes.size >= 2) return { kind: "clarify", sports: [...votes] }; // anchors point at different sports
  return { kind: "keep" };                                             // nothing recovered -> fail honestly, as today
}
