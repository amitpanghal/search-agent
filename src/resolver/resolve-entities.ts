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
//   - `decide(query, cells, pass)` — the ONLY LLM call. Stateless: one action per cell. Per-pass tool schema
//     (Pass 1 = pick|reexpress, Pass 2 = pick|clarify) so the model can't emit an illegal action.
//   - `resolveEntities(query, scope)` — the DETERMINISTIC orchestrator: build entity cells, call `decide` per
//     pass, re-ground any reexpress, collapse picks to confident cells, raise clarifications.
// Replayable: eval injects a captured `decide()` through the deterministic orchestrator with no Haiku call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  groundRegion, groundCompetition, groundTeam, groundPlayer, compUnion,
  type ResolvedScope, type EntityResolution, type ScopeTier,
} from "./ground-scope";
import { loadScopeCatalog } from "./scope-catalog";
import { fold } from "./lexical";
import type { CellRef, SettledEntities } from "./live-menu-types";

const HERE = dirname(fileURLToPath(import.meta.url));

// Model = Haiku, temp 0 (mirror extract.ts). Swappable — bumping to Sonnet later is one line.
export const ENTITY_MODEL = "claude-haiku-4-5-20251001";

const ENTITY_CAP = 5; // entity candidates shown to the model
const SUGGEST_CAP = 5; // ids a clarify may suggest
// An ENTITY cell is sent to the resolver only at these doubtful tiers; confident/variants/main passes through.
// A `none` entity IS sent (empty candidate list) so it can still re-express.
const SENT_TIERS = new Set<ScopeTier>(["ambiguous", "shortlist", "none"]);

// ---- public types ----

export type Decision =
  | { ref: CellRef; action: "pick"; id: number }
  | { ref: CellRef; action: "reexpress"; phrase: string } // Pass 1 only
  | { ref: CellRef; action: "clarify"; question: string; suggest?: number[] }; // Pass 2 only

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

// The (only) non-deterministic step, injectable so eval can REPLAY captured decisions with no Haiku call.
export type DecideFn = (query: string, cells: Cell[], pass: 1 | 2) => Promise<Decision[]> | Decision[];

// ---- builder: gate + caps + reground closures (entity-only) ----

// An entity cell wraps the grounder call so its reground returns a fresh Cell. `ground` closes over the
// entity's structural context (a competition over its region branch, a player over its comp/team scope).
function buildEntityCell(ref: CellRef, res: EntityResolution, ground: (phrase: string) => EntityResolution): Cell {
  return {
    ref,
    text: res.text,
    tier: res.tier,
    ids: res.candidates.map((c) => c.id),
    candidates: res.candidates.slice(0, ENTITY_CAP).map((c) => ({ id: c.id, name: c.name })),
    entity: res,
    reground: (phrase) => buildEntityCell(ref, ground(phrase), ground),
  };
}

// Where a grounded entity sits in the per-leg scope, so a settled pick fans back to every leg that referenced it.
type Slot = "region" | "competition" | "team" | "player" | "subject";
type Placement = { legIdx: number; slot: Slot; idx: number };

// Build the gated cells across ALL legs, DEDUPED by distinct grounded entity. Phase 3's memo cache makes an
// entity repeated across legs the SAME EntityResolution reference, so identity dedup == "one cell per distinct
// entity": gate it once, record every placement, then fan the pick back per leg in applyOutcomes (never re-ask
// the same clarification per leg). Returns the cells (for the single decide batch) + ref->placements (writeback).
function buildEntityCells(scope: ResolvedScope): { cells: Cell[]; places: Map<CellRef, Placement[]> } {
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
      cells.push(buildEntityCell(ref, res, ground));
    }
    places.get(ref)!.push({ legIdx, slot, idx });
  };

  // Per-leg confident scoping for the reground closures (the leg this entity belongs to; deduped legs share it).
  scope.legs.forEach((leg, legIdx) => {
    const regionBranch = leg.region?.tier === "confident" ? leg.region.candidates[0]!.id : null;
    const teamIds = leg.teams.filter((t) => t.tier === "confident").flatMap((t) => t.candidates.map((c) => c.id));
    // anchor allow-set for a re-expressed competition — mirrors groundScope: the leg's player leagues (else
    // team leagues, else null). compId is gone — players no longer narrow by competition (comp→player cut dropped).
    const playerComps = compUnion([...leg.players, leg.subjectPlayer]);
    const teamComps = compUnion(leg.teams);
    const allow = playerComps.size ? playerComps : (teamComps.size ? teamComps : null);
    add("region", leg.region, legIdx, 0, (p) => groundRegion(p, scat));
    add("competition", leg.competition, legIdx, 0, (p) => groundCompetition(p, regionBranch, scat, allow));
    leg.teams.forEach((t, i) => add("team", t, legIdx, i, (p) => groundTeam(p, scat)));
    leg.players.forEach((pl, i) => add("player", pl, legIdx, i, (p) => groundPlayer(p, { compId: null, teamIds }, scat)));
    // Market-owner player (the leg's subject) settles in the SAME batch — gated and re-grounded like a player.
    add("subject", leg.subjectPlayer, legIdx, 0, (p) => groundPlayer(p, { compId: null, teamIds }, scat));
  });
  return { cells, places };
}

// ---- decide(): the one LLM call, forced tool use, per-pass schema ----

const zPick = z.object({ ref: z.string(), action: z.literal("pick"), id: z.number() });
const zReexpress = z.object({ ref: z.string(), action: z.literal("reexpress"), phrase: z.string().min(1) });
const zClarify = z.object({ ref: z.string(), action: z.literal("clarify"), question: z.string().min(1), suggest: z.array(z.number()).optional() });
const Pass1Item = z.discriminatedUnion("action", [zPick, zReexpress]);
const Pass2Item = z.discriminatedUnion("action", [zPick, zClarify]);
const Pass1Out = z.object({ decisions: z.array(Pass1Item) });
const Pass2Out = z.object({ decisions: z.array(Pass2Item) });

function toInputSchema(s: z.ZodType): Anthropic.Tool.InputSchema {
  const j = z.toJSONSchema(s) as Record<string, unknown>;
  delete j.$schema;
  return j as Anthropic.Tool.InputSchema;
}
const PASS1_SCHEMA = toInputSchema(Pass1Out);
const PASS2_SCHEMA = toInputSchema(Pass2Out);
const TOOL_NAME = "settle_cells";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (export it or put it in .env).");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

let cachedPrompt: string | undefined;
function systemPrompt(): string {
  return (cachedPrompt ??= readFileSync(join(HERE, "disambiguator-prompt.md"), "utf8"));
}

// The model sees the raw query (so confident entities appear as words) and each cell's candidates as id+name.
// Candidate ORDER matters: the first is the grounder's top pick and the resolver anchors on it; tier/score stay
// hidden so it doesn't over-trust the rank.
function userMessage(query: string, cells: Cell[], pass: 1 | 2): string {
  const head = pass === 2
    ? "SECOND PASS. Each cell below was re-expressed and re-grounded but is still unresolved. For each cell either pick a candidate or clarify with the user.\n\n"
    : "";
  const payload = { query, cells: cells.map((c) => ({ ref: c.ref, text: c.text, candidates: c.candidates })) };
  return head + JSON.stringify(payload, null, 2);
}

export async function decide(query: string, cells: Cell[], pass: 1 | 2): Promise<Decision[]> {
  const msg = await client().messages.create({
    model: ENTITY_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [{ name: TOOL_NAME, description: "Return exactly one action per cell.", input_schema: pass === 1 ? PASS1_SCHEMA : PASS2_SCHEMA }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userMessage(query, cells, pass) }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    const text = msg.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
    throw new Error(`Entity resolver returned no tool_use block. Got: ${text || "(empty)"}`);
  }
  const raw = block.input as { decisions?: unknown };
  const items = Array.isArray(raw.decisions) ? (raw.decisions as Array<Record<string, unknown>>) : [];
  // Per-decision parse, NOT all-or-nothing: keep every well-formed action, drop only the malformed ones (a
  // dropped cell rides to Pass 2 / clarify as before).
  const item = pass === 1 ? Pass1Item : Pass2Item;
  return items.flatMap((d) => { const p = item.safeParse(d); return p.success ? [p.data as Decision] : []; });
}

// ---- orchestrator: two-pass loop + validation + SettledEntities assembly ----

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
function settleOutcome(cell: Cell, ids: number[]): Outcome {
  const picked = cell.entity.candidates.filter((c) => ids.includes(c.id));
  return { kind: "settle-entity", ref: cell.ref, resolution: { text: cell.text, tier: "confident", candidates: picked } };
}

// Fail-safe ONLY — fires when the model returns bad/empty Pass-2 output. A canned two-part string (what's
// wrong + what to do); the "pick one of the suggestions" half is dropped when there are no candidates.
export const defaultQuestion = (cell: Cell): string =>
  cell.candidates.length
    ? `We couldn't identify "${cell.text}". Try rewording it, or choose one of these suggestions.`
    : `We couldn't identify "${cell.text}". Try rewording it with a team, player, league, or market name.`;

// Append candidate names only when the LLM didn't already embed them. Check by first-name token (folded):
// if any candidate's first name appears in the question, the LLM included names — skip; otherwise append.
const appendNamesIfMissing = (q: string, cell: Cell): string => {
  const names = cell.candidates.slice(0, SUGGEST_CAP).map((c) => c.name);
  if (!names.length) return q;
  const qFolded = fold(q);
  const anyPresent = names.some((n) => qFolded.includes(fold(n.split(" ")[0]!)));
  return anyPresent ? q : `${q} (${names.join(", ")})`;
};

async function runPasses(query: string, cells: Cell[], decideFn: DecideFn): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const open: Cell[] = []; // cells that ride into Pass 2 (re-grounded-but-unresolved, or undecided/invalid)

  const d1 = firstByRef(await decideFn(query, cells, 1));
  for (const cell of cells) {
    const d = d1.get(cell.ref);
    if (d?.action === "pick" && validPick(cell, d.id)) {
      outcomes.push(settleOutcome(cell, [d.id]));
    } else if (d?.action === "reexpress" && d.phrase.trim()) {
      const fresh = cell.reground(d.phrase);
      // A re-ground that lands confident/variants is settled directly; only ambiguous/shortlist/none goes to Pass 2.
      if (fresh.tier === "confident" || fresh.tier === "variants") outcomes.push(settleOutcome(fresh, fresh.ids));
      else open.push(fresh);
    } else {
      open.push(cell); // undecided/invalid Pass-1 cell → ride into Pass 2 unchanged
    }
  }

  if (open.length) {
    const d2 = firstByRef(await decideFn(query, open, 2));
    for (const cell of open) {
      const d = d2.get(cell.ref);
      if (d?.action === "pick" && validPick(cell, d.id)) {
        outcomes.push(settleOutcome(cell, [d.id]));
      } else if (d?.action === "clarify" && d.question.trim()) {
        outcomes.push({ kind: "clarify", ref: cell.ref, question: appendNamesIfMissing(d.question, cell), suggest: (d.suggest ?? []).filter((id) => validPick(cell, id)).slice(0, SUGGEST_CAP) });
      } else {
        outcomes.push({ kind: "clarify", ref: cell.ref, question: appendNamesIfMissing(defaultQuestion(cell), cell), suggest: cell.candidates.slice(0, SUGGEST_CAP).map((c) => c.id) });
      }
    }
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
  const { cells, places } = buildEntityCells(scope);
  if (cells.length) applyOutcomes(settled, await runPasses(query, cells, decideFn), places);
  return settled;
}
