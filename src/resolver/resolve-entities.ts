// resolve-entities — the entity gate (build plan Phase 6, trim of the old disambiguate.ts). The grounder is
// precision-biased: when it can't confidently resolve an ENTITY (region/competition/team/player) it returns a
// tier + candidate list, never a forced guess. This LLM layer reads the raw query plus those candidate sets
// and either PICKS the right id, RE-EXPRESSES a cell to try again, or CLARIFIES (asks the user). Pipeline:
//
//   extract → groundScope → resolveEntities → recall(live menu) → filter → resolve(market) → select → execute
//
// The MARKET half of the old disambiguate is gone (markets resolve from the live menu AFTER fetch); this file
// keeps only its entity work: deterministic grounder first → LLM only on doubtful tiers → clarify on genuine
// collision → recall fetches only confident ids. Output is SettledEntities (no marketIds, no combos).
//
//   - `decide(query, cells)` — the ONLY LLM call, made ONCE. Stateless: one action per cell, `pick` or
//     `reexpress`. The model has no clarify action: a cell it cannot settle (and whose re-ground stays
//     doubtful) is asked back to the user by this file, deterministically. A second model call used to sit
//     here to re-read the re-grounded candidates; it only ever converted a clarify into a silent rescue pick,
//     so it was dropped — the cost of a round trip on every doubtful tail for an occasional saved user turn.
//   - `resolveEntities(query, scope)` — the DETERMINISTIC orchestrator: build entity cells, call `decide`,
//     re-ground any reexpress, collapse picks to confident cells, raise clarifications.
// Replayable: eval injects a captured `decide()` through the deterministic orchestrator with no model call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  groundRegion, groundCompetition, groundTeam, groundPlayer, constrainTo,
  type ResolvedScope, type EntityResolution, type ScopeTier, type Candidate,
} from "./ground-scope";
import { loadScopeCatalog, type ScopeCatalog } from "./scope-catalog";
import { builtSports } from "./sports";
import { bedrockToolCall } from "./bedrock-call";
import type { CellRef, SettledEntities } from "./live-menu-types";

const HERE = dirname(fileURLToPath(import.meta.url));

const ENTITY_CAP = 5; // entity candidates shown to the model
const SUGGEST_CAP = 5; // ids a clarify may suggest
// An ENTITY cell is sent to the resolver only at these doubtful tiers; confident/variants/main passes through.
// A `none` entity IS sent (empty candidate list) so it can still re-express.
const SENT_TIERS = new Set<ScopeTier>(["ambiguous", "shortlist", "none"]);

// ---- public types ----

export type Decision =
  | { ref: CellRef; action: "pick"; id: number }
  | { ref: CellRef; action: "reexpress"; phrase: string };

// `candidates` is the capped id+name list shown to the model AND the pick-validation set (a pick id must be one
// of these — guards hallucinated ids). `entity` is the full grounding (so a pick collapses back to a confident
// cell with relation meta intact). `reground` re-runs the (sync) grounder over a re-expressed phrase.
export type Cell = {
  ref: CellRef;
  text: string;
  tier: ScopeTier;
  ids: number[];
  candidates: { id: number; name: string }[];
  entity: EntityResolution;
  reground: (phrase: string) => Cell;
};

// The (only) non-deterministic step, injectable so eval can REPLAY captured decisions with no model call.
export type DecideFn = (query: string, cells: Cell[]) => Promise<Decision[]> | Decision[];

// ---- builder: gate + caps + reground closures (entity-only) ----

// An entity cell wraps the grounder call so its reground returns a fresh Cell. `ground` closes over the
// entity's structural context (a competition over its region branch, a player over its comp/team scope).
// Same-named twins get their game appended so the LLM/clarify can tell them apart: esports lists "Team Liquid"
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

// id -> the sport whose catalog holds it, for ids that came from a catalog OTHER than the plan's.
export type ForeignIds = Map<number, { sport: string; cand: Candidate }>;

function crossSportRows(name: string, skip: string, out: ForeignIds, competitor: boolean): { id: number; name: string; rank: number }[] {
  const bySport: { rank: number; rows: { id: number; name: string; rank: number }[] }[] = [];
  for (const sport of builtSports()) {
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
        rows.push({ id: c.id, name: c.name, rank: 0 }); // per-sport rank is stamped on the way out
      }
    }
    if (rows.length) bySport.push({ rank, rows });
  }
  return bySport.sort((a, b) => a.rank - b.rank).flatMap((s) => s.rows.slice(0, XS_PER_SPORT).map((r) => ({ ...r, rank: s.rank })));
}

function buildEntityCell(ref: CellRef, res: EntityResolution, ground: (phrase: string) => EntityResolution, cat: ScopeCatalog, foreign: ForeignIds, competitor: boolean, widen: boolean): Cell {
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
    // grounding uses the reexpressed phrase, but the cell keeps the USER: clarify quotes their words, and
    // resolve.ts subject-matching folds e.text — a model rewrite must not replace either.
    reground: (phrase) => ({ ...buildEntityCell(ref, ground(phrase), ground, cat, foreign, competitor, widen), text: res.text }),
  };
}

// Where a grounded entity sits in the per-leg scope, so a settled pick fans back to every leg that referenced it.
type Slot = "region" | "competition" | "team" | "player" | "subject";
type Placement = { legIdx: number; slot: Slot; idx: number };

// Build the gated cells across ALL legs, DEDUPED by distinct grounded entity. Phase 3's memo cache makes an
// entity repeated across legs the SAME EntityResolution reference, so identity dedup == "one cell per distinct
// entity": gate it once, record every placement, then fan the pick back per leg in applyOutcomes (never re-ask
// the same clarification per leg). Returns the cells (for the single decide batch) + ref->placements (writeback).
function buildEntityCells(scope: ResolvedScope, foreign: ForeignIds): { cells: Cell[]; places: Map<CellRef, Placement[]> } {
  const scat = loadScopeCatalog(scope.sport);
  const cells: Cell[] = [];
  const places = new Map<CellRef, Placement[]>();
  const refByEntity = new Map<EntityResolution, CellRef>(); // identity dedup: a shared grounding -> its one cell
  const count: Record<Slot, number> = { region: 0, competition: 0, team: 0, player: 0, subject: 0 };

  const add = (slot: Slot, res: EntityResolution | null, legIdx: number, idx: number, ground: (p: string) => EntityResolution) => {
    if (!res || !SENT_TIERS.has(res.tier)) return; // confident/variants: already settled in the clone, no cell
    let ref = refByEntity.get(res);
    if (ref === undefined) {
      ref = `${slot}:${count[slot]++}` as CellRef;
      refByEntity.set(res, ref);
      places.set(ref, []);
      const competitor = slot === "team" || slot === "player" || slot === "subject";
      cells.push(buildEntityCell(ref, res, ground, scat, foreign, competitor, competitor || slot === "competition"));
    }
    places.get(ref)!.push({ legIdx, slot, idx });
  };

  // A re-expressed phrase re-grounds by NAME, then gets the same relational narrowing the seed pass applied in
  // groundScope — constrained against this leg's already-settled entities (the doubtful cell being regrounded is
  // not confident, so it never constrains itself).
  scope.legs.forEach((leg, legIdx) => {
    const settled = [leg.region, leg.competition, ...leg.teams, ...leg.players, leg.subjectPlayer]
      .filter((x): x is EntityResolution => x !== null && x.tier === "confident");
    const rg = (fn: (p: string) => EntityResolution) => (p: string) => constrainTo(fn(p), settled, scat);
    add("region", leg.region, legIdx, 0, rg((p) => groundRegion(p, scat)));
    add("competition", leg.competition, legIdx, 0, rg((p) => groundCompetition(p, scat)));
    leg.teams.forEach((t, i) => add("team", t, legIdx, i, rg((p) => groundTeam(p, scat))));
    leg.players.forEach((pl, i) => add("player", pl, legIdx, i, rg((p) => groundPlayer(p, scat))));
    // Market-owner player (the leg's subject) settles in the SAME batch — gated and re-grounded like a player.
    add("subject", leg.subjectPlayer, legIdx, 0, rg((p) => groundPlayer(p, scat)));
  });
  return { cells, places };
}

// ---- decide(): the one LLM call, forced tool use ----

const zPick = z.object({ ref: z.string(), action: z.literal("pick"), id: z.number() });
const zReexpress = z.object({ ref: z.string(), action: z.literal("reexpress"), phrase: z.string().min(1) });
const DecisionItem = z.discriminatedUnion("action", [zPick, zReexpress]);
const DecideOut = z.object({ decisions: z.array(DecisionItem) });

function toInputSchema(s: z.ZodType): Record<string, unknown> {
  const j = z.toJSONSchema(s) as Record<string, unknown>;
  delete j.$schema;
  return j;
}
const DECIDE_SCHEMA = toInputSchema(DecideOut);
const TOOL_NAME = "settle_cells";

let cachedPrompt: string | undefined;
function systemPrompt(): string {
  return (cachedPrompt ??= readFileSync(join(HERE, "disambiguator-prompt.md"), "utf8"));
}

// The model sees the raw query (so confident entities appear as words) and each cell's candidates as id+name.
// Candidate ORDER matters: the first is the grounder's top pick and the resolver anchors on it; tier/score stay
// hidden so it doesn't over-trust the rank.
function userMessage(query: string, cells: Cell[]): string {
  const payload = { query, cells: cells.map((c) => ({ ref: c.ref, text: c.text, candidates: c.candidates })) };
  return JSON.stringify(payload, null, 2);
}

export async function decide(query: string, cells: Cell[]): Promise<Decision[]> {
  const raw = await bedrockToolCall(
    systemPrompt(),
    userMessage(query, cells),
    TOOL_NAME,
    DECIDE_SCHEMA,
    1024,
  ) as { decisions?: unknown };
  const items = Array.isArray(raw.decisions) ? (raw.decisions as Array<Record<string, unknown>>) : [];
  // Per-decision parse, NOT all-or-nothing: keep every well-formed action, drop only the malformed ones (a
  // dropped cell clarifies, same as an undecided one).
  return items.flatMap((d) => { const p = DecisionItem.safeParse(d); return p.success ? [p.data as Decision] : []; });
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
    ? `We couldn't identify "${cell.text}". Try rewording it, or choose one of these suggestions. (${cands.map((c) => c.name).join(", ")})`
    : `We couldn't identify "${cell.text}". Try rewording it with a team, player, league, or market name.`;
  return { kind: "clarify", ref: cell.ref, question, suggest: cands.map((c) => c.id) };
}

// ONE call, then deterministic settlement. A cell settles three ways: a valid pick; a re-express whose
// re-ground lands confident/variants; otherwise clarify. A re-express that lands doubtful-but-non-empty
// clarifies with the FRESH candidates — the rewrite found a better list, so those are the better choices to
// offer the user, even though nothing here commits to one of them.
async function runPass(query: string, cells: Cell[], decideFn: DecideFn, foreign: ForeignIds): Promise<Outcome[]> {
  const decisions = firstByRef(await decideFn(query, cells));
  const outcomes: Outcome[] = [];
  for (const cell of cells) {
    const d = decisions.get(cell.ref);
    if (d?.action === "pick" && validPick(cell, d.id)) {
      outcomes.push(settleOutcome(cell, [d.id], foreign));
      continue;
    }
    let open = cell; // undecided/invalid decisions clarify on the ORIGINAL cell
    if (d?.action === "reexpress" && d.phrase.trim()) {
      const fresh = cell.reground(d.phrase);
      if (fresh.tier === "confident" || fresh.tier === "variants") {
        outcomes.push(settleOutcome(fresh, fresh.ids, foreign));
        continue;
      }
      if (fresh.candidates.length) open = fresh;
    }
    outcomes.push(clarifyFor(open));
  }
  return outcomes;
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

// resolveEntities: the deterministic orchestrator. Returns a cloned ResolvedScope with entity picks collapsed
// to confident + a clarifications sidecar. A clarify is terminal for its cell; recall fetches only confident ids.
export async function resolveEntities(query: string, scope: ResolvedScope, decideFn: DecideFn = decide): Promise<SettledEntities> {
  const settled = structuredClone(scope) as SettledEntities;
  settled.clarifications = [];
  const foreign: ForeignIds = new Map();
  const { cells, places } = buildEntityCells(scope, foreign);
  if (!cells.length) return settled;
  const outcomes = await runPass(query, cells, decideFn, foreign);
  applyOutcomes(settled, outcomes, places);
  // A pick from another catalog means the extractor's sport was wrong. Adopt it only when EVERY cross-sport
  // pick agrees — disagreeing anchors mean we misread the query, and guessing there is how a correct plan dies.
  const picks = new Set(outcomes.flatMap((o) =>
    o.kind === "settle-entity" ? o.resolution.candidates.map((c) => foreign.get(c.id)?.sport).filter((x): x is string => !!x) : []));
  if (picks.size === 1) settled.sport = [...picks][0]!;
  return settled;
}
