// groundScope: the scope-grounding stage. Maps the extractor's free-text scope (sport · region ·
// competition · teams · players) to real Kambi ids, returning recall-first CANDIDATES + a TIER per entity
// (never a forced guess) — the same precision bias as the market grounder. A downstream LLM disambiguator
// (deferred) settles ambiguity; planFetch then emits the concrete fetch plan.
//
// Lexical-first, NO embeddings (short proper nouns; embeddings blur the "2026"-vs-"2022" tokens we need).
// Each entity type resolves against its OWN, non-overlapping index (built in scope-catalog from the slim
// scope-index.json join): region -> branch whitelist, competition -> the 303-node group whitelist,
// teams/players -> the participant index. The extractor owns the region-vs-team routing ("Italy to win" ->
// teams; "Italian Serie A" -> region); the grounder never re-disambiguates that.
//
// Adaptive cascade — resolving one entity SCOPES the next:
//   region  (confident) ──hard-scope──▶ competition candidates restricted to the branch subtree
//   competition (confident) ──hard-scope──▶ player pool restricted to that competition's roster
//   confident teams in scope ──────────▶ player pool also accepts that club/country's players (the homonym
//                                          cut: "Bruno Fernandes" + Portugal in scope -> the Portugal one)
// Anything not confidently scoped stays recall-first (top-k, tier `ambiguous`/`shortlist`) for the LLM.
//
// Per-leg-scope redesign: each selector carries its OWN scope, so groundScope runs the cascade PER leg and
// returns one ResolvedLegScope per selector (index-aligned with plan.selectors). A memo cache keyed by entity
// text + scope context means a value repeated across legs (the same competition on every leg) is grounded once
// — and identical legs share the SAME EntityResolution reference, the substrate the Phase 4 entity gate dedups on.

import type { QueryPlan, Scope } from "./schema";
import { loadScopeCatalog, type ScopeCatalog } from "./scope-catalog";
import { fold, contentTokens, buildLexicon, type Lexicon } from "./lexical";

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

// ---- per-corpus lexicons (lexical.ts, corpus = SCOPE names, not the market catalog) ----
let compLexCache: Lexicon | undefined;
function compLex(cat: ScopeCatalog): Lexicon {
  return (compLexCache ??= buildLexicon(cat.groups.map((g) => g.name)));
}
let branchLexCache: Lexicon | undefined;
function branchLex(cat: ScopeCatalog): Lexicon {
  return (branchLexCache ??= buildLexicon(cat.branches.map((b) => b.name)));
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

// ---- competition: lexical-first over the whitelist, region-hard-scoped, major-ness tie-break ----
export function groundCompetition(text: string, regionBranch: number | null, cat: ScopeCatalog): EntityResolution {
  const folded0 = fold(text);
  const text2 = cat.competitionAliases.get(folded0) ?? text; // short-form -> a real competition name
  const folded = fold(text2);
  const lex = compLex(cat);
  const major = (id: number): number => cat.roster.get(id)?.length ?? 0;
  const cand = (id: number, score: number): Candidate => {
    const g = cat.groupById.get(id);
    return { id, name: g?.name ?? "", score, branch: g?.branch ?? null };
  };

  // pool: the 303 whitelist, region-hard-scoped to the branch subtree when region is confident. If the cut
  // empties the pool (the named comp isn't under the region — a conflict), ignore the cut and fall back to
  // the full pool (the disambiguator owns the conflict); never silently return nothing.
  let pool = cat.groups;
  if (regionBranch != null) {
    const cut = cat.groups.filter((g) => g.branch === regionBranch);
    if (cut.length) pool = cut;
  }

  const scored = pool.map((g) => ({ g, cover: lex.lexicalCover(text2, g.name) })).filter((x) => x.cover > 0);
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
    if (hits.length > 1) return { text, tier: "shortlist", candidates: hits.map((t) => cand(t.id, 0.8)) };
  }
  return { text, tier: "none", candidates: [] };
}

// ---- player: full-name exact -> last-name fallback; hard-scoped under a confident competition/team ----
export function groundPlayer(
  text: string,
  scope: { compId: number | null; teamIds: number[] },
  cat: ScopeCatalog,
): EntityResolution {
  const folded = fold(text);
  const cand = (id: number, score: number): Candidate => {
    const p = cat.playerById.get(id)!;
    return { id, name: p.name, score, clubId: p.clubId, countryTeamId: p.countryTeamId, competitionIds: p.competitionIds };
  };
  const hasScope = scope.compId != null || scope.teamIds.length > 0;
  const inScope = (id: number): boolean => {
    const p = cat.playerById.get(id);
    if (!p) return false;
    if (scope.compId != null && p.competitionIds.includes(scope.compId)) return true;
    if (scope.teamIds.length && ((p.clubId != null && scope.teamIds.includes(p.clubId)) || (p.countryTeamId != null && scope.teamIds.includes(p.countryTeamId)))) return true;
    return false;
  };

  // Resolve an id set to a tier. When a scope is active, HARD-filter to it: a clean single survivor is
  // confident; >1 survivor is ambiguous. If NOTHING survives the scope (the player isn't in scope — a
  // conflict), fall through to the unscoped set as a clarify (the disambiguator owns it). `weak` downgrades
  // an unscoped multi-hit from a loose match (last-name fallback) to a shortlist rather than ambiguous.
  const resolveSet = (ids: number[], weak: boolean): EntityResolution => {
    if (!ids.length) return { text, tier: "none", candidates: [] };
    if (hasScope) {
      const scoped = ids.filter(inScope);
      if (scoped.length === 1) return { text, tier: "confident", candidates: [cand(scoped[0]!, 1)] };
      if (scoped.length > 1) return { text, tier: "ambiguous", candidates: scoped.slice(0, TOP_K).map((id) => cand(id, 1)) };
    }
    if (ids.length === 1) return { text, tier: weak ? "shortlist" : "confident", candidates: [cand(ids[0]!, weak ? 0.7 : 1)] };
    return { text, tier: weak ? "shortlist" : "ambiguous", candidates: ids.slice(0, TOP_K).map((id) => cand(id, weak ? 0.7 : 1)) };
  };

  const full = cat.playerByFull.get(folded);
  if (full?.length) return resolveSet(full, false);

  // last-name / surname fallback (also catches a mononym typed with extra words).
  const last = folded.split(" ").filter(Boolean).pop() ?? "";
  const byLast = last ? cat.playerByLast.get(last) : undefined;
  if (byLast?.length) return resolveSet(byLast, true);

  return { text, tier: "none", candidates: [] };
}

// ---- the cascade, run PER leg with a memo cache ----
// `opts.region` lets a caller (the eval gate) feed region as GIVEN, exactly as the market grounder is fed a
// clean market_concept — so a flaky extractor LLM can't redden a grounder test. Applied to every leg; falls
// back to each leg's own scope.region otherwise.
export function groundScope(plan: QueryPlan, opts: { region?: string | null } = {}): ResolvedScope {
  const cat = loadScopeCatalog();

  // Memo by entity text + scope context: a value repeated across legs (the same competition on every leg, a
  // shared team) is grounded once, and identical references are reused. Player/subject keys fold in compId +
  // teamIds because those change the result. ` ` joins parts (never present in folded text).
  const memo = new Map<string, EntityResolution>();
  const once = (key: string, fn: () => EntityResolution): EntityResolution => {
    let r = memo.get(key);
    if (r === undefined) memo.set(key, (r = fn()));
    return r;
  };

  const legs: ResolvedLegScope[] = plan.selectors.map((sel) => {
    const sc = sel.scope;

    const regionText = opts.region !== undefined ? opts.region : sc.region;
    const region = regionText ? once(`region ${fold(regionText)}`, () => groundRegion(regionText, cat)) : null;
    const regionBranch = region && region.tier === "confident" ? region.candidates[0]!.id : null;

    const competition = sc.competition
      ? once(`comp ${fold(sc.competition)} ${regionBranch}`, () => groundCompetition(sc.competition!, regionBranch, cat))
      : null;
    const compId = competition && competition.tier === "confident" ? competition.candidates[0]!.id : null;

    // teams first (a confident team scopes the player pool — the homonym cut), then players.
    const teams = sc.teams.map((t) => once(`team ${fold(t)}`, () => groundTeam(t, cat)));
    const teamIds = teams.filter((r) => r.tier === "confident").flatMap((r) => r.candidates.map((c) => c.id));
    const pKey = (name: string) => `player ${fold(name)} ${compId} ${[...teamIds].sort((a, b) => a - b).join(",")}`;
    const players = sc.players.map((p) => once(pKey(p.name), () => groundPlayer(p.name, { compId, teamIds }, cat)));

    // the market-OWNER player named on this leg's subject (recall: same player pool as scope.players).
    // Capture the name in a local const so the memo closure keeps the narrowing (TS drops property-narrowing
    // inside a closure).
    const subjName = sel.subject.kind === "player" ? sel.subject.name : undefined;
    const subjectPlayer = subjName
      ? once(pKey(subjName), () => groundPlayer(subjName, { compId, teamIds }, cat))
      : null;

    return {
      region,
      competition,
      level: sc.level,
      stage: sc.stage,
      time: sc.time,
      playState: sc.play_state,
      teams,
      players,
      playerRoles: sc.players.map((p) => p.role),
      subjectPlayer,
    };
  });

  return { sport: plan.sport, legs };
}
