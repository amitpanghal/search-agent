// resolve-entities — the entity gate. The grounder is precision-biased: when it can't confidently resolve an
// ENTITY (region/competition/team/player) it returns a tier + candidate list, never a forced guess. This stage
// settles those cells with ONE request to Jev (TypeSafe's decision model, jev-call.ts): a `choice` question
// per cell over its candidates plus `none`, answered with a probability per option. A pick is trusted only at
// or above JEV_ENTITY_THRESHOLD on the chosen option's probability; everything else — below threshold, `none`,
// no candidates, a failed request — is asked back to the user by this file, deterministically. Pipeline:
//
//   extract → groundScope → resolveEntities → recall(live menu) → filter → resolve(market) → select → execute
//
// Deterministic grounder first → model only on doubtful tiers → clarify on genuine collision → recall fetches
// only confident ids. Output is SettledEntities (no marketIds, no combos). History, so nobody re-adds it: the
// Qwen decider (Bedrock, with a prompt file of its own) that sat here also had a rewrite action — reword the
// phrase, re-ground, try again. Jev has no text output, so it went with the call; the one captured rewrite
// ("Spurs" → "Tottenham Hotspur") did not rescue its cell either. The stage makes no Bedrock call at all.
//
//   - `decideWithJev(query, cells)` — the ONLY model request, made ONCE: `pick` or nothing per cell.
//   - `resolveEntities(query, scope)` — the DETERMINISTIC orchestrator: build entity cells, decide, collapse
//     picks to confident cells, raise clarifications.
// Replayable: tests inject a decider (`DecideFn`) or stub `fetch`, through the same deterministic orchestrator.

import {
  groundCompetition, groundTeam, groundPlayer,
  type ResolvedScope, type EntityResolution, type ScopeTier, type Candidate,
} from "./ground-scope";
import { loadScopeCatalog, type ScopeCatalog } from "./scope-catalog";
import { fold } from "./lexical";
import { userSports } from "./sports";
import { jevChoice, envNumber, type JevQuestion } from "./jev-call";
import type { CellRef, SettledEntities } from "./live-menu-types";

const ENTITY_CAP = 5; // entity candidates shown to the model
const SUGGEST_CAP = 5; // ids a clarify may suggest
// An ENTITY cell is built only at these doubtful tiers; confident/variants/main passes through. A `none` entity
// IS built: it has no own candidates, but cross-sport widening may still find it rows; with none at all it
// clarifies directly ("We couldn't identify …") without reaching the model.
const SENT_TIERS = new Set<ScopeTier>(["ambiguous", "shortlist", "none"]);

// ---- public types ----

// The model's only action: a pick. A cell with no decision (below threshold, `none`, no candidates, a failed
// request) clarifies — there is no rewrite-and-retry, Jev has no text output.
export type Decision = { ref: CellRef; action: "pick"; id: number };

// `candidates` is the capped id+name list shown to the model AND the pick-validation set (a pick id must be one
// of these — guards ids the model was never offered). `entity` is the full grounding (so a pick collapses back
// to a confident cell with relation meta intact).
export type Cell = {
  ref: CellRef;
  text: string;
  tier: ScopeTier;
  ids: number[];
  candidates: { id: number; name: string }[];
  entity: EntityResolution;
};

// The (only) non-deterministic step, injectable so tests can REPLAY canned decisions with no model call.
export type DecideFn = (query: string, cells: Cell[]) => Promise<Decision[]> | Decision[];

// ---- builder: gate + caps (entity-only) ----

// Same-named twins get their game appended so the model/clarify can tell them apart: esports lists "Team Liquid"
// once per game, so an unresolved head-to-head reaches here as N identical "Team Liquid" candidates. Label only on
// a name collision, by the candidate's non-sport-root group ("Dota 2"). No-ops for unique names and for entities
// without groups (players/competitions carry no groupIds).
function labelCandidates(cands: Candidate[], cat: ScopeCatalog): { id: number; name: string }[] {
  const count = new Map<string, number>();
  for (const c of cands) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  const gameOf = (c: Candidate): string => (c.groupIds ?? [])
    .filter((id) => id !== cat.sportRootId).map((id) => cat.groupById.get(id)?.name).filter(Boolean).join(", ")
    // competitions carry no groupIds; their branch name separates same-named twins ("Cincinnati (ATP)" vs "(WTA)")
    || (c.branch != null && c.branch !== c.id ? (cat.branchById.get(c.branch)?.name ?? "") : "");
  return cands.map((c) => {
    const g = (count.get(c.name) ?? 0) > 1 ? gameOf(c) : "";
    return { id: c.id, name: g ? `${c.name} (${g})` : c.name };
  });
}

// CROSS-SPORT WIDENING. The extractor's `sport` is a guess, and when it is wrong the whole candidate list is
// drawn from the wrong catalog: "Giron" under sport=football offers only Girona, so the model settled a tennis
// player onto a Spanish club. Whenever this sport cannot PLACE the name (tier `none`/`shortlist`), add the rows
// every OTHER catalog holds for it. The model then picks from rows that EXIST instead of the best of a wrong
// list — asked to expand these names from memory it answered "FC Girona" for Giron and invented a "New York
// Valkyries", 1 of 6 right. The pick IS the entity and its sport rides along, so `resolveEntities` corrects
// `sport` for free, in the LLM call it was already making. Measured on the 14 sport-failing gold rows: 11
// corrected, 0 wrong switches, including "Arizona Cardinals" over "St. Louis Cardinals" — a pair no tier rule
// can separate, since the catalog evidence is identical for the right answer and the wrong one.
//
// DON'T re-add a "· <sport>" suffix to these rows (tried, measured, reverted). It makes the widened rows the
// only annotated entries in the list and the model reads that as odd-one-out: with the tag, an exact-match
// "Czech Liga Pro · table-tennis" sitting at rank 1 was passed over for football's "Liga Pro"; without it, the
// same row is picked. It also cost the "X gegen Y" pair, which resolves both sides correctly untagged. Twins
// stay separable by their full names ("Arizona" vs "St. Louis" Cardinals) — the tag was never carrying that.
//
// Known ceiling: a surname-only anchor now commits where it used to clarify — "Rocha" settles on Francisco
// Rocha when the fixture is Henrique Rocha. Right sport, wrong person. Constrain the pick to the OTHER anchor's
// fixtures if that starts to matter.
const PLACED = new Set<ScopeTier>(["confident", "variants", "ambiguous"]);
const TIER_ORDER: ScopeTier[] = ["confident", "variants", "ambiguous", "shortlist"];
const XS_PER_SPORT = 2; // per-sport quota: a flat top-N lets one sport crowd out the rest (33 "Tigers" rows push
const XS_CAP = 8;       // the baseball one to rank 8). Quota'd, the right row never fell past 5.

// The query literally names the plan's sport ("… basketball winner"): the sport is the USER's word, not an
// extractor guess, so offering other sports' catalogs contradicts the query. Widening (and with it the
// cross-sport sport-adoption below) exists to rescue a GUESSED sport — a stated one locks the home catalog.
// ponytail: strict slug-substring ("ice-hockey" fires only on "ice hockey" verbatim); add sport aliases
// ("soccer", "mma") if a stated sport ever misses.
export function queryNamesSport(query: string, sport: string): boolean {
  return fold(query).includes(fold(sport.replace(/-/g, " ")));
}

// id -> the sport whose catalog holds it, for ids that came from a catalog OTHER than the plan's.
export type ForeignIds = Map<number, { sport: string; cand: Candidate }>;

function crossSportRows(name: string, skip: string, out: ForeignIds, competitor: boolean): { id: number; name: string; rank: number }[] {
  const bySport: { rank: number; rows: { id: number; name: string; rank: number }[] }[] = [];
  // userSports, not builtSports: the sim catalogs (z-sports/virtual-sports) hold twins that REUSE the real
  // participant ids, so a correct pick gets tagged foreign-to-a-sim-catalog and the sport-adoption below
  // flips a right plan to the junk sport. They contribute nothing widening needs.
  for (const sport of userSports()) {
    if (sport === skip) continue;
    const cat = loadScopeCatalog(sport);
    const rows: { id: number; name: string; rank: number }[] = [];
    let rank = Infinity;
    // Match like against like: a COMPETITION cell must search the other catalogs' competition index, not their
    // team index — widening "NPC" against teams matched an esports side called "NPC Team" and settled on it.
    const grounders = competitor ? [groundTeam, groundPlayer] : [groundCompetition];
    for (const res of grounders.map((g) => g(name, cat))) {
      // ANY match counts: a real team named by nickname often reaches only `shortlist` in its own sport
      // ("Valkyries" is shortlist in basketball and nothing anywhere else) — require more and it never shows.
      if (res.tier === "none") continue;
      rank = Math.min(rank, TIER_ORDER.indexOf(res.tier));
      for (const c of res.candidates.slice(0, XS_PER_SPORT)) {
        out.set(c.id, { sport, cand: c });
        // The team and the player grounder both hit the same row: drop the repeat HERE, before the quota, so it
        // never spends a slot a distinct entity could have used. `out` still records every hit.
        if (!rows.some((r) => r.id === c.id)) rows.push({ id: c.id, name: c.name, rank: 0 }); // rank stamped on the way out
      }
    }
    if (rows.length) bySport.push({ rank, rows });
  }
  return bySport.sort((a, b) => a.rank - b.rank).flatMap((s) => s.rows.slice(0, XS_PER_SPORT).map((r) => ({ ...r, rank: s.rank })));
}

function buildEntityCell(ref: CellRef, res: EntityResolution, cat: ScopeCatalog, foreign: ForeignIds, competitor: boolean, widen: boolean): Cell {
  const own = labelCandidates(res.candidates.slice(0, ENTITY_CAP), cat);
  // Region cells are excluded: a place name is a competitor in half the catalogs ("Italy" is a team) and
  // widening it would offer a national side for a scope word.
  const wide = widen && !PLACED.has(res.tier) ? crossSportRows(res.text, cat.sport, foreign, competitor) : [];
  return {
    ref,
    text: res.text,
    tier: res.tier,
    ids: res.candidates.map((c) => c.id),
    candidates: [...own.map((c) => ({ ...c, rank: TIER_ORDER.indexOf(res.tier) })), ...wide]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, own.length + XS_CAP)
      .map(({ id, name }) => ({ id, name })),
    entity: res,
  };
}

// Where a grounded entity sits in the per-leg scope, so a settled pick fans back to every leg that referenced it.
type Slot = "region" | "competition" | "team" | "player" | "subject";
type Placement = { legIdx: number; slot: Slot; idx: number };

// Build the gated cells across ALL legs, DEDUPED by distinct grounded entity. Phase 3's memo cache makes an
// entity repeated across legs the SAME EntityResolution reference, so identity dedup == "one cell per distinct
// entity": gate it once, record every placement, then fan the pick back per leg in applyOutcomes (never re-ask
// the same clarification per leg). Returns the cells (for the single decide batch) + ref->placements (writeback).
function buildEntityCells(scope: ResolvedScope, foreign: ForeignIds, widenOk: boolean): { cells: Cell[]; places: Map<CellRef, Placement[]> } {
  const scat = loadScopeCatalog(scope.sport);
  const cells: Cell[] = [];
  const places = new Map<CellRef, Placement[]>();
  const refByEntity = new Map<EntityResolution, CellRef>(); // identity dedup: a shared grounding -> its one cell
  const count: Record<Slot, number> = { region: 0, competition: 0, team: 0, player: 0, subject: 0 };

  const add = (slot: Slot, res: EntityResolution | null, legIdx: number, idx: number) => {
    if (!res || !SENT_TIERS.has(res.tier)) return; // confident/variants: already settled in the clone, no cell
    let ref = refByEntity.get(res);
    if (ref === undefined) {
      ref = `${slot}:${count[slot]++}` as CellRef;
      refByEntity.set(res, ref);
      places.set(ref, []);
      const competitor = slot === "team" || slot === "player" || slot === "subject";
      cells.push(buildEntityCell(ref, res, scat, foreign, competitor, widenOk && (competitor || slot === "competition")));
    }
    places.get(ref)!.push({ legIdx, slot, idx });
  };

  scope.legs.forEach((leg, legIdx) => {
    add("region", leg.region, legIdx, 0);
    add("competition", leg.competition, legIdx, 0);
    leg.teams.forEach((t, i) => add("team", t, legIdx, i));
    leg.players.forEach((pl, i) => add("player", pl, legIdx, i));
    // Market-owner player (the leg's subject) settles in the SAME batch — gated like a player.
    add("subject", leg.subjectPlayer, legIdx, 0);
  });
  return { cells, places };
}

// ---- decideWithJev(): the one model request, a `choice` question per cell ----

const TOOL_NAME = "settle_cells";
const NONE = "None of these is what the query means";
// The measured wording (2026-09-21 replay: Saka 0.98, Premier League 1.00, the Tottenham horse 0.75 → clarify).
// `kind` is the cell's slot word as-is ("subject" included): that is what was measured, so it stays.
const instructions = (kind: string, text: string): string =>
  `Which candidate is the ${kind} the query means by "${text}"? Judge by meaning, not string overlap. Answer none if no candidate fits or two candidates fit equally.`;

// The model sees the raw query (so confident entities appear as words) and each cell's candidates as id+name —
// once in `state`, once as that cell's options. Candidate ORDER matters: the first is the grounder's top pick,
// and order decides which rows survive the caps and which names a clarify offers; tier/score stay hidden. A
// pick is trusted only at or above JEV_ENTITY_THRESHOLD on the chosen option's probability — below it, or on
// `none`, the cell has no decision and runPass asks the user. Cells with no candidates never reach the model (a
// choice between `none` and nothing), and a transport failure (null) leaves every cell undecided.
export async function decideWithJev(query: string, cells: Cell[]): Promise<Decision[]> {
  const asked = cells.filter((c) => c.candidates.length);
  if (!asked.length) return [];
  const questions: Record<string, JevQuestion> = Object.fromEntries(asked.map((c) => [c.ref, {
    type: "choice",
    instructions: instructions(c.ref.split(":")[0]!, c.text),
    criteria: { ...Object.fromEntries(c.candidates.map((k) => [String(k.id), k.name])), none: NONE },
  }]));
  const state = { query, cells: asked.map((c) => ({ ref: c.ref, text: c.text, candidates: c.candidates })) };
  const res = await jevChoice(TOOL_NAME, state, questions);
  if (!res) return [];
  const threshold = envNumber("JEV_ENTITY_THRESHOLD", 0.8, 0, 1); // a blank or bad value must never become 0/NaN
  return asked.flatMap((c) => {
    const a = res.answers[c.ref];
    if (!a || a.choice === "none" || (a.probabilities[a.choice] ?? 0) < threshold) return [];
    return [{ ref: c.ref, action: "pick" as const, id: Number(a.choice) }];
  });
}

// ---- orchestrator: single-call loop + validation + SettledEntities assembly ----

type Outcome =
  | { kind: "settle-entity"; ref: CellRef; resolution: EntityResolution }
  | { kind: "clarify"; ref: CellRef; question: string; suggest?: number[] };

const firstByRef = (ds: Decision[]): Map<CellRef, Decision> => {
  const m = new Map<CellRef, Decision>();
  for (const d of ds) if (!m.has(d.ref)) m.set(d.ref, d);
  return m;
};
const validPick = (cell: Cell, id: number): boolean => cell.candidates.some((c) => c.id === id);

// A settled pick collapses an entity cell to a confident cell carrying the picked candidate(s) with full
// relation meta (so recall and select read clubId/countryTeamId/groupIds intact).
function settleOutcome(cell: Cell, ids: number[], foreign?: ForeignIds): Outcome {
  const own = cell.entity.candidates.filter((c) => ids.includes(c.id));
  // A cross-sport pick lives in no local candidate list — take the row from the catalog it actually came from.
  const picked = own.length ? own : ids.map((id) => foreign?.get(id)?.cand).filter((c): c is Candidate => !!c);
  return { kind: "settle-entity", ref: cell.ref, resolution: { text: cell.text, tier: "confident", candidates: picked } };
}

// The ONLY clarify author (the model has no clarify action). A canned two-part string — what's wrong + what to
// do — with the capped candidate names appended as the choices; the "pick one of the suggestions" half and the
// name list are both dropped when the cell has no candidates.
export function clarifyFor(cell: Cell): Outcome {
  const cands = cell.candidates.slice(0, SUGGEST_CAP);
  const question = cands.length
    ? `"${cell.text}" could mean more than one thing. Choose one of these, or reword your search. (${cands.map((c) => c.name).join(", ")})`
    : `We couldn't identify "${cell.text}". Try rewording it with a team, player, league, or market name.`;
  return { kind: "clarify", ref: cell.ref, question, suggest: cands.map((c) => c.id) };
}

// ONE request, then deterministic settlement: a valid pick settles the cell; anything else — no decision, or an
// id outside the candidate list — clarifies on the cell as the user phrased it.
async function runPass(query: string, cells: Cell[], decideFn: DecideFn, foreign: ForeignIds): Promise<Outcome[]> {
  const decisions = firstByRef(await decideFn(query, cells));
  return cells.map((cell) => {
    const d = decisions.get(cell.ref);
    return d && validPick(cell, d.id) ? settleOutcome(cell, [d.id], foreign) : clarifyFor(cell);
  });
}

// Fan a settled resolution back to every leg location that referenced the (deduped) cell.
function setEntity(s: SettledEntities, places: Placement[], res: EntityResolution): void {
  for (const pl of places) {
    const leg = s.legs[pl.legIdx]!;
    if (pl.slot === "region") leg.region = res;
    else if (pl.slot === "competition") leg.competition = res;
    else if (pl.slot === "team") leg.teams[pl.idx] = res;
    else if (pl.slot === "player") leg.players[pl.idx] = res;
    else leg.subjectPlayer = res;
  }
}

function applyOutcomes(s: SettledEntities, outcomes: Outcome[], places: Map<CellRef, Placement[]>): void {
  for (const o of outcomes) {
    if (o.kind === "settle-entity") setEntity(s, places.get(o.ref) ?? [], o.resolution);
    else s.clarifications.push({ ref: o.ref, question: o.question, ...(o.suggest?.length ? { suggest: o.suggest } : {}) });
  }
}

// Every candidate came from another sport's catalog (settleOutcome never mixes local and foreign rows).
const isForeign = (res: EntityResolution, foreign: ForeignIds): boolean =>
  res.candidates.length > 0 && res.candidates.every((c) => foreign.has(c.id));

// SPORT ADOPTION with a home-sport veto. Adopt a foreign pick's sport only when every foreign pick agrees AND
// nothing corroborates the home sport. Corroboration = any team/player settled in the HOME catalog: a local
// gate pick or an entity already confident at ground time (never a cell). One home-settled entity means the query makes sense here — a lone foreign pick must not drag the leg
// into another sport (the Lamine split: a football player + a basketball club on one leg). Regions and
// competitions don't vote — their names repeat across sports (the inversion recover-sport.ts documents).
export function adoptSport(outcomes: Outcome[], legs: ResolvedScope["legs"], foreign: ForeignIds): string | null {
  const sports = new Set(outcomes.flatMap((o) =>
    o.kind === "settle-entity" && isForeign(o.resolution, foreign)
      ? [foreign.get(o.resolution.candidates[0]!.id)!.sport] : []));
  if (sports.size !== 1) return null;
  const homeSettled = (r: EntityResolution | null): boolean =>
    !!r && (r.tier === "confident" || r.tier === "variants") && r.candidates.some((c) => !foreign.has(c.id));
  const home =
    outcomes.some((o) => o.kind === "settle-entity" && !isForeign(o.resolution, foreign)) ||
    legs.some((l) => [...l.teams, ...l.players, l.subjectPlayer].some(homeSettled));
  return home ? null : [...sports][0]!;
}

// resolveEntities: the deterministic orchestrator. Returns a cloned ResolvedScope with entity picks collapsed
// to confident + a clarifications sidecar. A clarify is terminal for its cell; recall fetches only confident ids.
export async function resolveEntities(query: string, scope: ResolvedScope, decideFn: DecideFn = decideWithJev): Promise<SettledEntities> {
  const settled = structuredClone(scope) as SettledEntities;
  settled.clarifications = [];
  settled.notes = [];
  const foreign: ForeignIds = new Map();
  const { cells, places } = buildEntityCells(scope, foreign, !queryNamesSport(query, scope.sport));
  if (!cells.length) return settled;
  const outcomes = await runPass(query, cells, decideFn, foreign);
  const adopted = adoptSport(outcomes, scope.legs, foreign);
  if (adopted) settled.sport = adopted;
  // A foreign pick we did NOT adopt would split the leg across two sports — demote it to a clarify on its
  // original cell (fail toward asking; the local candidates are the choices).
  const cellByRef = new Map(cells.map((c) => [c.ref, c]));
  const kept = adopted ? outcomes : outcomes.map((o) =>
    o.kind === "settle-entity" && isForeign(o.resolution, foreign) ? clarifyFor(cellByRef.get(o.ref)!) : o);
  // A pick from a WEAK shortlist is our best guess, not knowledge — say so and name the runners-up, so the
  // user can correct us without a blocking question (a result + hedge beats a silent wrong answer).
  for (const o of kept) {
    if (o.kind !== "settle-entity") continue;
    const cell = cellByRef.get(o.ref);
    if (!cell || cell.entity.tier !== "shortlist" || cell.entity.candidates.length < 2) continue;
    const picked = new Set(o.resolution.candidates.map((c) => c.id));
    const others = cell.entity.candidates.filter((c) => !picked.has(c.id)).slice(0, 3).map((c) => c.name);
    if (others.length) settled.notes.push(
      `Showing ${o.resolution.candidates[0]!.name} for "${cell.text}" — could also be ${others.join(", ")}. Add a team or competition to be exact.`);
  }
  applyOutcomes(settled, kept, places);
  return settled;
}
