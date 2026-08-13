// groundScope: the scope-grounding stage. Maps the extractor's free-text scope (sport · region ·
// competition · teams · players) to real Kambi ids, returning recall-first CANDIDATES + a TIER per entity
// (never a forced guess). A downstream LLM entity gate settles what's left ambiguous.
//
// Lexical-first, NO embeddings (short proper nouns; embeddings blur the "2026"-vs-"2022" tokens we need).
// Each entity type resolves against its OWN, non-overlapping index (built in scope-catalog from the slim
// scope-index.json join): region -> branch whitelist, competition -> the group whitelist, teams/players ->
// the participant index. The extractor owns the region-vs-team routing ("Italy to win" -> teams; "Italian
// Serie A" -> region); the grounder never re-disambiguates that.
//
// JOINT RESOLUTION (replaces the old fixed region→teams→players→competition cascade, where information could
// only ever flow forward — so a named player could never disambiguate a team). Three order-free phases:
//
//   1. SEED      every mention grounds by NAME ALONE -> a candidate set. No cross-talk, no ordering.
//   2. CONSTRAIN per leg, iterate to fixpoint: prune each mention's candidates to those structurally LINKED
//                to at least one candidate of every other mention (shared league/group/club/branch ids).
//   3. MERGE     one query names one entity: across legs, the smallest surviving set for a mention wins
//                (a leg that pinned "Toronto" via its player pins it for the bare leg too).
//
// The EDGE LADDER is what makes pruning safe: a STRONG link (direct membership — the player's clubId IS this
// team) is tried first, then a WEAK one (shared league). A constraint that would empty a set is SKIPPED, never
// applied — so stale roster data degrades to the weaker signal instead of deleting the right answer.
//
// This one loop subsumes three former special cases: the head-to-head twin lock (team↔team), the competition
// anchor allow-set (player↔competition), and the team→player homonym cut — all now just edges.
//
// Each selector carries its OWN scope, so this returns one ResolvedLegScope per selector (index-aligned with
// plan.selectors). Mentions are seeded once per (slot, text), so a value repeated across legs is grounded once
// and identical legs share the SAME EntityResolution reference — the substrate the entity gate dedups on.

import type { QueryPlan, Scope } from "./schema";
import { loadScopeCatalog, type ScopeCatalog } from "./scope-catalog";
import { fold, contentTokens, buildLexicon, type Lexicon } from "./lexical";
import { getSport } from "./sports";

export type ScopeTier = "confident" | "variants" | "ambiguous" | "shortlist" | "none";

// One candidate id + its relation meta (so planFetch needs no second lookup).
export type Candidate = {
  id: number;
  name: string;
  score: number;
  clubId?: number | null;
  countryTeamId?: number | null;
  competitionIds?: number[];
  groupIds?: number[];
  ntVariant?: string | null;
  branch?: number | null; // for region/competition candidates: the football-root branch they sit under
};

// A resolved scope cell (no `kind` / no `method` — kind is implied by which slot it sits in).
export type EntityResolution = { text: string; tier: ScopeTier; candidates: Candidate[] };

// One grounded leg — the per-selector scope mapped to ids (index-aligned with plan.selectors). Replaces the old
// flat ResolvedScope + single ScopeUnit: every selector now carries its own region/competition/teams/.../level.
export type ResolvedLegScope = {
  region: EntityResolution | null;
  competition: EntityResolution | null;
  level: "fixture" | "competition";
  stage: Scope["stage"];
  time: Scope["time"];
  playState: Scope["play_state"]; // live/prematch restriction, carried to planFetch
  teams: EntityResolution[];
  players: EntityResolution[];
  playerRoles: Scope["players"][number]["role"][]; // role per player, index-aligned with `players`
  // The named player that OWNS this leg's market (the selector subject), grounded — null where the subject isn't
  // a named player. Distinct from `players` (which scope WHICH fixture): the market owner planFetch filters to.
  subjectPlayer: EntityResolution | null;
};

export type ResolvedScope = {
  sport: string;
  legs: ResolvedLegScope[]; // index-aligned with plan.selectors
};

// ---- knobs (precision-biased; each fails toward clarify, never a false confident) ----
const TOP_K = 5; // entity candidate cap (the disambiguator's per-entity limit)
// COVER_FLOOR: a competition candidate must cover (near-)ALL of the query's IDF mass to be a real
// candidate; this is what makes "World Cup 2026" land ONLY on WC26 (the rare "2026" token excludes the
// other editions) while bare "World Cup" keeps every edition.
const COVER_FLOOR = 0.99;
// SHORTLIST_FLOOR: a partial cover in [this, COVER_FLOOR) yields a `shortlist` (clarify) instead of `none`.
const SHORTLIST_FLOOR = 0.45;
// MAJOR_RATIO: an exact-name competition hit is confident UNLESS a fully-covering rival is this-many-times
// more major (roster size) — that's a minor comp literally named like a major one ("World Cup" = the niche
// Kings League comp, but WC26 has ~16x the roster), so the bare query is edition-ambiguous, not confident.
const MAJOR_RATIO = 3;

// National-team ntVariant selection from a surface marker; default senior_men (the catalog's senior NT row).
const NT_VARIANT: Record<string, string> = { u23: "youth_men_u23", u21: "youth_men_u21", u20: "youth_men_u20" };

// Club "twins" — a gendered/reserve/youth side shares its base name with the senior men's club and differs only
// by a marker token in the name ("(W)"->w, "II"/"III", "U21", "Youth"…). The senior side carries no marker. When
// the query names no variant, these are a deterministic pick (the senior), NOT a question for the LLM. fold (not
// stem) so markers stay literal. Single-letter markers kept to the unambiguous women's "w"; "b" reserves are left
// out as too collision-prone. ponytail: static marker list; broaden only against a measured miss.
const VARIANT_MARKERS = new Set<string>([
  "w", "women", "ladies", "feminine",
  "ii", "iii", "reserve", "reserves",
  "u16", "u17", "u18", "u19", "u20", "u21", "u23", "youth", "academy", "junior",
]);
const hasVariantMarker = (s: string): boolean => fold(s).split(" ").some((t) => VARIANT_MARKERS.has(t));

// ---- per-corpus lexicons (lexical.ts, corpus = SCOPE names, not the market catalog) ----
const compLexCache = new Map<string, Lexicon>();
function compLex(cat: ScopeCatalog): Lexicon {
  let l = compLexCache.get(cat.sport);
  if (!l) compLexCache.set(cat.sport, (l = buildLexicon(cat.groups.map((g) => g.name))));
  return l;
}
const branchLexCache = new Map<string, Lexicon>();
function branchLex(cat: ScopeCatalog): Lexicon {
  let l = branchLexCache.get(cat.sport);
  if (!l) branchLexCache.set(cat.sport, (l = buildLexicon(cat.branches.map((b) => b.name))));
  return l;
}

function markerOf(text: string, cat: ScopeCatalog): string | null {
  for (const t of fold(text).split(" ").filter(Boolean)) {
    const m = cat.markers.get(t);
    if (m) return m;
  }
  return null;
}

// ---- region: resolve a place word to a top-level branch (country or cross-country comp) ----
export function groundRegion(text: string, cat: ScopeCatalog): EntityResolution {
  const branchName = (id: number): string => cat.branchById.get(id)?.name ?? "";
  const mk = (ids: number[], tier: ScopeTier, score = 1): EntityResolution => ({
    text,
    tier,
    candidates: ids.slice(0, TOP_K).map((id) => ({ id, name: branchName(id), score, branch: id })),
  });

  // alias: a place adjective / short-form ("Italian" -> "Italy") to a branch name, then exact-match.
  const folded = fold(text);
  const aliased = cat.regionAliases.get(folded);
  const key = aliased ? fold(aliased) : folded;
  const exact = cat.branchByName.get(key) ?? [];
  if (exact.length === 1) return mk(exact, "confident");
  if (exact.length > 1) return mk(exact, "ambiguous");

  // fuzzy fallback (rare — regions are usually clean country names): cover over branch names.
  const lex = branchLex(cat);
  const scored = cat.branches
    .map((b) => ({ id: b.id, cover: lex.lexicalCover(key, b.name) }))
    .filter((x) => x.cover >= SHORTLIST_FLOOR)
    .sort((a, b) => b.cover - a.cover);
  if (!scored.length) return { text, tier: "none", candidates: [] };
  const top = scored[0]!;
  if (scored.length === 1 || top.cover - (scored[1]?.cover ?? 0) > 1e-6) {
    return mk([top.id], top.cover >= COVER_FLOOR ? "confident" : "shortlist", top.cover);
  }
  return { text, tier: "shortlist", candidates: scored.slice(0, TOP_K).map((x) => ({ id: x.id, name: branchName(x.id), score: x.cover, branch: x.id })) };
}

// ---- competition: lexical-first over the whitelist, major-ness tie-break ----
// Name only. Region scoping and the player/team anchor allow-set are gone: both are now `branch` / league LINKS
// applied by the constraint pass, which (unlike the old hard pool cuts) can never prune the pool to nothing.
export function groundCompetition(text: string, cat: ScopeCatalog): EntityResolution {
  const folded0 = fold(text);
  const text2 = cat.competitionAliases.get(folded0) ?? text; // short-form -> a real competition name
  const folded = fold(text2);
  const lex = compLex(cat);
  const major = (id: number): number => cat.roster.get(id)?.length ?? 0;
  const cand = (id: number, score: number): Candidate => {
    const g = cat.groupById.get(id);
    return { id, name: g?.name ?? "", score, branch: g?.branch ?? null };
  };

  const pool = cat.groups;

  const decide = (want: Set<string>): EntityResolution => {
    const scored = pool.map((g) => ({ g, cover: lex.idfCover(contentTokens(g.name), want) })).filter((x) => x.cover > 0);
    if (!scored.length) return { text, tier: "none", candidates: [] };

    const full = scored.filter((x) => x.cover >= COVER_FLOOR); // (near-)full coverage of the query's IDF mass
    if (!full.length) {
      // no full cover -> best-effort shortlist (clarify) if the top is at least plausible, else abstain.
      const ranked = scored.sort((a, b) => b.cover - a.cover || major(b.g.id) - major(a.g.id));
      if (ranked[0]!.cover < SHORTLIST_FLOOR) return { text, tier: "none", candidates: [] };
      return { text, tier: "shortlist", candidates: ranked.slice(0, TOP_K).map((x) => cand(x.g.id, x.cover)) };
    }

    // rank full-cover candidates by major-ness (roster), then tighter name (fewer extra tokens via cover).
    const ranked = full.sort((a, b) => major(b.g.id) - major(a.g.id) || b.cover - a.cover);
    if (ranked.length === 1) return { text, tier: "confident", candidates: [cand(ranked[0]!.g.id, ranked[0]!.cover)] };

    // a UNIQUE exact-name match is confident unless a substantially-more-major rival exists (edition trap).
    const exact = full.filter((x) => fold(x.g.name) === folded);
    if (exact.length === 1) {
      const e = exact[0]!;
      const rival = full.some((x) => x.g.id !== e.g.id && major(x.g.id) > MAJOR_RATIO * major(e.g.id));
      if (!rival) return { text, tier: "confident", candidates: [cand(e.g.id, e.cover)] };
    }

    // genuine multi-candidate (cross-edition / cross-country / collision) -> ambiguous, top-k by major-ness.
    return { text, tier: "ambiguous", candidates: ranked.slice(0, TOP_K).map((x) => cand(x.g.id, x.cover)) };
  };

  const want = contentTokens(text2);
  const res = decide(want);
  if (res.tier !== "none") return res;

  // Fallback on `none`: a single-sport catalog stores events WITHOUT the sport word ("World Championship",
  // not "World CHESS Championship") and without a year. Those tokens are in NO competition name, so they
  // score as maximal-IDF unseen terms and crater coverage. Drop them — guarded by df=0, so a sport whose
  // competitions really use the word (rugby's "Rugby Championship") is untouched — and ground once more.
  const vocab = new Set<string>();
  for (const g of cat.groups) for (const t of contentTokens(g.name)) vocab.add(t);
  const sportToks = contentTokens(cat.sport.replace(/-/g, " "));
  const pruned = new Set([...want].filter((t) => vocab.has(t) || !(sportToks.has(t) || /^\d{4}$/.test(t))));
  return pruned.size < want.size ? decide(pruned) : res;
}

// ---- team: full-name exact (ntVariant-aware) -> token-subset shortlist ----
export function groundTeam(text: string, cat: ScopeCatalog): EntityResolution {
  const folded = fold(text);
  const variant = NT_VARIANT[markerOf(text, cat) ?? ""] ?? "senior_men";
  const cand = (id: number, score: number): Candidate => {
    const t = cat.teamById.get(id)!;
    return { id, name: t.name, score, clubId: id, competitionIds: t.competitionIds, groupIds: t.groupIds, ntVariant: t.ntVariant };
  };

  const exact = cat.teamByName.get(folded) ?? [];
  if (exact.length) {
    // among national-team collisions, prefer the marker-implied variant (default senior_men).
    let ids = exact;
    const nt = exact.filter((id) => cat.teamById.get(id)?.ntVariant);
    if (nt.length) {
      const want = nt.filter((id) => cat.teamById.get(id)?.ntVariant === variant);
      ids = want.length ? want : exact;
    }
    if (ids.length === 1) return { text, tier: "confident", candidates: [cand(ids[0]!, 1)] };
    return { text, tier: "ambiguous", candidates: ids.slice(0, TOP_K).map((id) => cand(id, 1)) };
  }

  // fallback: token-subset (every query token present in the team name) -> shortlist. Bounded; team names
  // are short and ~unique, so this is the rare "Man United" -> "Manchester United" style rescue.
  const qTokens = [...contentTokens(text)];
  if (qTokens.length) {
    const hits = cat.teams
      .filter((t) => { const nt = contentTokens(t.name); return qTokens.every((q) => nt.has(q)); })
      .slice(0, TOP_K);
    if (hits.length === 1) return { text, tier: "confident", candidates: [cand(hits[0]!.id, 0.8)] };
    if (hits.length > 1) {
      // Deterministic twin collapse: when the query named no variant, drop the gendered/reserve/youth siblings
      // and keep the senior side — resolves at grounding, so the twin never reaches the entity LLM (pass or clarify).
      if (!hasVariantMarker(text)) {
        const seniors = hits.filter((t) => !hasVariantMarker(t.name));
        // Only a TRUE twin (same base name, differs only by a variant marker) collapses to the senior; a mere
        // city-mate ("Toronto Tempo (W)" vs "Toronto Raptors") is a different club → stays ambiguous.
        const base = (s: string) => fold(s).split(" ").filter((w) => !VARIANT_MARKERS.has(w)).join(" ");
        if (seniors.length === 1 && hits.every((t) => base(t.name) === base(seniors[0]!.name)))
          return { text, tier: "confident", candidates: [cand(seniors[0]!.id, 0.8)] };
      }
      return { text, tier: "shortlist", candidates: hits.map((t) => cand(t.id, 0.8)) };
    }
  }
  return { text, tier: "none", candidates: [] };
}

// ---- player: full-name exact -> last-name -> first-name fallback ----
// Name only. The old team/competition hard-scoping is gone — those are now club/league LINKS applied by the
// constraint pass, which narrows in BOTH directions (a player can now disambiguate a team, not just the reverse).
export function groundPlayer(text: string, cat: ScopeCatalog): EntityResolution {
  const folded = fold(text);
  const cand = (id: number, score: number): Candidate => {
    const p = cat.playerById.get(id)!;
    return { id, name: p.name, score, clubId: p.clubId, countryTeamId: p.countryTeamId, competitionIds: p.competitionIds };
  };

  // `weak` downgrades a multi-hit from a loose match (last/first-name fallback) to a shortlist, not ambiguous.
  const resolveSet = (ids: number[], weak: boolean): EntityResolution => {
    if (!ids.length) return { text, tier: "none", candidates: [] };
    if (ids.length === 1) return { text, tier: weak ? "shortlist" : "confident", candidates: [cand(ids[0]!, weak ? 0.7 : 1)] };
    return { text, tier: weak ? "shortlist" : "ambiguous", candidates: ids.slice(0, TOP_K).map((id) => cand(id, weak ? 0.7 : 1)) };
  };

  const full = cat.playerByFull.get(folded);
  if (full?.length) return resolveSet(full, false);

  // last-name / surname fallback (also catches a mononym typed with extra words).
  const last = folded.split(" ").filter(Boolean).pop() ?? "";
  const byLast = last ? cat.playerByLast.get(last) : undefined;
  if (byLast?.length) return resolveSet(byLast, true);

  // first-name / mononym fallback: player known by their first name where the catalog stores a trailing
  // token ("Gukesh" -> "Gukesh D"). Last resort, after full-name and last-name both miss. weak=true →
  // shortlist alone, confident when a team/league scope narrows it to one (via resolveSet).
  const first = folded.split(" ").filter(Boolean)[0] ?? "";
  const byFirst = first ? cat.playerByFirst.get(first) : undefined;
  if (byFirst?.length) return resolveSet(byFirst, true);

  return { text, tier: "none", candidates: [] };
}

// ---- the constraint engine (the one rule that replaced the cascade's special cases) ----

// The structural ids a candidate belongs to: its leagues, its groups, its club/country, its region branch.
// The SPORT-ROOT group is excluded on purpose — every team in a sport carries it, so keeping it would link
// everything to everything (and silently un-fix the esports head-to-head case this rule subsumes).
function links(c: Candidate, rootId: number): Set<number> {
  const s = new Set<number>();
  for (const id of c.competitionIds ?? []) s.add(id);
  for (const id of c.groupIds ?? []) if (id !== rootId) s.add(id);
  if (c.clubId != null && c.clubId !== c.id) s.add(c.clubId);
  if (c.countryTeamId != null) s.add(c.countryTeamId);
  if (c.branch != null) s.add(c.branch);
  return s;
}

// Arc-consistency to fixpoint over one leg's mentions. Prunes each candidate set to those linked to at least
// one candidate of every other set, STRONG links first (direct membership: this player's club IS this team),
// falling back to WEAK (shared league). A filter that would empty a set is skipped — that skip is what lets a
// stale/incomplete roster fall through to the weaker signal instead of deleting the correct answer.
// ponytail: O(passes · mentions² · candidates²) with mentions ≤ ~6 and candidates ≤ TOP_K — microseconds.
export function propagate(sets: Candidate[][], rootId: number): Candidate[][] {
  const cur = sets.map((s) => s.slice());
  const memo = new Map<Candidate, Set<number>>();
  const L = (c: Candidate): Set<number> => {
    let s = memo.get(c);
    if (!s) memo.set(c, (s = links(c, rootId)));
    return s;
  };
  const strong = (a: Candidate, b: Candidate): boolean => L(a).has(b.id) || L(b).has(a.id);
  const weak = (a: Candidate, b: Candidate): boolean => { const la = L(a); for (const x of L(b)) if (la.has(x)) return true; return false; };

  for (let pass = 0; pass <= cur.length; pass++) {
    let changed = false;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i]!.length <= 1) continue;
      for (let j = 0; j < cur.length; j++) {
        if (i === j || !cur[j]!.length) continue;
        const s = cur[i]!.filter((a) => cur[j]!.some((b) => strong(a, b)));
        const next = s.length ? s : cur[i]!.filter((a) => cur[j]!.some((b) => weak(a, b)));
        if (next.length && next.length < cur[i]!.length) { cur[i] = next; changed = true; }
      }
    }
    if (!changed) break;
  }
  return cur;
}

// Re-tier a mention after pruning: a set narrowed to exactly one is settled.
const retier = (r: EntityResolution, kept: Candidate[]): EntityResolution =>
  kept.length === r.candidates.length ? r
    : { text: r.text, tier: kept.length === 1 ? "confident" : r.tier, candidates: kept };

// Constrain ONE freshly-ground mention against already-settled ones (the entity gate's re-express path, so a
// re-grounded phrase gets the same relational narrowing the seed pass got).
export function constrainTo(res: EntityResolution, others: EntityResolution[], cat: ScopeCatalog): EntityResolution {
  if (res.candidates.length <= 1 || !others.length) return res;
  const kept = propagate([res.candidates, ...others.map((o) => o.candidates)], cat.sportRootId)[0]!;
  return retier(res, kept);
}

// ---- seed → constrain → merge ----
// `opts.region` lets a caller (the eval gate) feed region as GIVEN, exactly as the market grounder is fed a
// clean market_concept — so a flaky extractor LLM can't redden a grounder test. Applied to every leg; falls
// back to each leg's own scope.region otherwise.
export function groundScope(plan: QueryPlan, opts: { region?: string | null } = {}): ResolvedScope {
  const cat = loadScopeCatalog(plan.sport);

  // Event-centric sports (F1): the named "competition" is really an EVENT (a Grand Prix / a championship) under
  // the sport-root group, so ground it straight to the root — recall then fetches every event under the sport
  // (their path carries the root id) and resolveMarkets picks race-vs-season by the disjoint criteria. Also pin
  // level to "competition": every F1 event is COMPETITION-tagged, so the grain filter must not drop them as
  // non-fixtures. One shared reference across legs (grounded once, like the memo path).
  // ponytail: named-GP precision deferred — only the imminent race is live, so a named non-live GP falls back to
  // the live one; add event-name matching in scopeMenu if multiple races are ever live at once.
  const eventCentricComp: EntityResolution | null = getSport(plan.sport)?.eventCentric
    ? { text: plan.sport, tier: "confident", candidates: [{ id: cat.sportRootId, name: plan.sport, score: 1 }] }
    : null;


  // ---- 1. SEED: every distinct (slot, text) grounds ONCE, by name alone. Legs sharing a mention share the
  // same EntityResolution reference — the identity the entity gate dedups its cells on.
  const seeded = new Map<string, EntityResolution>();
  const seed = (slot: string, text: string, fn: () => EntityResolution): EntityResolution => {
    const key = `${slot}:${fold(text)}`;
    let r = seeded.get(key);
    if (r === undefined) seeded.set(key, (r = fn()));
    return r;
  };

  type Mentions = {
    region: EntityResolution | null;
    competition: EntityResolution | null;
    teams: EntityResolution[];
    players: EntityResolution[];
    subjectPlayer: EntityResolution | null;
  };

  const mentions: Mentions[] = plan.selectors.map((sel) => {
    const sc = sel.scope;

    const regionText = opts.region !== undefined ? opts.region : sc.region;
    const region = regionText ? seed("region", regionText, () => groundRegion(regionText, cat)) : null;

    const comp = sc.competition;
    const competition = eventCentricComp ?? (comp ? seed("comp", comp, () => groundCompetition(comp, cat)) : null);

    const teams = sc.teams.map((t) => seed("team", t, () => groundTeam(t, cat)));
    // A TEAM named only as the market OWNER (subject), with scope.teams left empty, is still a scope anchor — ground
    // it and fold it into `teams` so recall/scopeMenu/filter/grouping treat it like any scope team (mirrors
    // subjectPlayer for players; same asymmetry check-complete handles for the gate). Skip if already in scope.teams.
    const subjTeam = sel.subject.kind === "team" ? sel.subject.name : undefined;
    if (subjTeam && !sc.teams.some((t) => fold(t) === fold(subjTeam))) {
      const name = subjTeam;
      teams.push(seed("team", name, () => groundTeam(name, cat)));
    }

    const players = sc.players.map((p) => seed("player", p.name, () => groundPlayer(p.name, cat)));
    // the market-OWNER player named on this leg's subject (recall: same player pool as scope.players).
    const subjName = sel.subject.kind === "player" ? sel.subject.name : undefined;
    const subjectPlayer = subjName ? seed("player", subjName, () => groundPlayer(subjName, cat)) : null;

    return { region, competition, teams, players, subjectPlayer };
  });

  // ---- 2. CONSTRAIN, per leg. The LEG is the unit of co-occurrence: two teams named on ONE leg play each
  // other, so they may narrow each other; two teams on DIFFERENT legs are unrelated and must not.
  // ---- 3. MERGE across legs. One query names one entity, so the smallest surviving set for a mention wins:
  // a leg that pinned "Toronto" via its player pins it for the bare "Toronto to win" leg too.
  const best = new Map<EntityResolution, Candidate[]>();
  for (const m of mentions) {
    const list = [m.region, m.competition, ...m.teams, ...m.players, m.subjectPlayer]
      .filter((x): x is EntityResolution => x !== null);
    const kept = propagate(list.map((r) => r.candidates), cat.sportRootId);
    list.forEach((r, i) => {
      const prev = best.get(r);
      if (!prev || kept[i]!.length < prev.length) best.set(r, kept[i]!);
    });
  }

  // One final resolution per distinct mention, so shared references STAY shared after pruning.
  const final = new Map<EntityResolution, EntityResolution>();
  const fin = <T extends EntityResolution | null>(r: T): T => {
    if (!r) return r;
    let f = final.get(r);
    if (f === undefined) final.set(r, (f = retier(r, best.get(r) ?? r.candidates)));
    return f as T;
  };

  const legs: ResolvedLegScope[] = plan.selectors.map((sel, i) => {
    const m = mentions[i]!;
    const sc = sel.scope;
    return {
      region: fin(m.region),
      competition: fin(m.competition),
      level: eventCentricComp ? "competition" : sc.level,
      stage: sc.stage,
      time: sc.time,
      playState: sc.play_state,
      teams: m.teams.map((t) => fin(t)),
      players: m.players.map((p) => fin(p)),
      playerRoles: sc.players.map((p) => p.role),
      subjectPlayer: fin(m.subjectPlayer),
    };
  });

  return { sport: plan.sport, legs };
}
