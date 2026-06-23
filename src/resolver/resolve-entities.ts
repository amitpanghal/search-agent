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
  groundRegion, groundCompetition, groundTeam, groundPlayer,
  type ResolvedScope, type EntityResolution, type ScopeTier,
} from "./ground-scope";
import { loadScopeCatalog } from "./scope-catalog";
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

function buildEntityCells(scope: ResolvedScope): Cell[] {
  const scat = loadScopeCatalog();
  const unit = scope.units[0]!;
  const cells: Cell[] = [];

  // Build-time confident scoping for the reground closures (per-cell, no cascade re-run).
  const regionBranch = scope.region?.tier === "confident" ? scope.region.candidates[0]!.id : null;
  const compId = scope.competition?.tier === "confident" ? scope.competition.candidates[0]!.id : null;
  const teamIds = unit.teams.filter((t) => t.tier === "confident").flatMap((t) => t.candidates.map((c) => c.id));

  const pushEntity = (ref: CellRef, res: EntityResolution | null, ground: (phrase: string) => EntityResolution) => {
    if (res && SENT_TIERS.has(res.tier)) cells.push(buildEntityCell(ref, res, ground));
  };
  pushEntity("region", scope.region, (p) => groundRegion(p, scat));
  pushEntity("competition", scope.competition, (p) => groundCompetition(p, regionBranch, scat));
  unit.teams.forEach((t, i) => pushEntity(`team:${i}`, t, (p) => groundTeam(p, scat)));
  unit.players.forEach((pl, i) => pushEntity(`player:${i}`, pl, (p) => groundPlayer(p, { compId, teamIds }, scat)));
  // Market-owner players (selector subjects) settle in the SAME batch — gated and re-grounded like a player cell.
  unit.subjectPlayers.forEach((sp, i) => pushEntity(`subject:${i}`, sp, (p) => groundPlayer(p, { compId, teamIds }, scat)));
  return cells;
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
    ? `I couldn't pin down "${cell.text}". Try rephrasing it more simply, or pick one of the suggestions.`
    : `I couldn't pin down "${cell.text}". Try rephrasing it more simply.`;

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
        outcomes.push({ kind: "clarify", ref: cell.ref, question: d.question, suggest: (d.suggest ?? []).filter((id) => validPick(cell, id)).slice(0, SUGGEST_CAP) });
      } else {
        outcomes.push({ kind: "clarify", ref: cell.ref, question: defaultQuestion(cell), suggest: cell.candidates.slice(0, SUGGEST_CAP).map((c) => c.id) });
      }
    }
  }
  return outcomes;
}

function setEntity(s: SettledEntities, ref: CellRef, res: EntityResolution): void {
  if (ref === "region") s.region = res;
  else if (ref === "competition") s.competition = res;
  else {
    const [kind, i] = ref.split(":");
    const idx = Number(i);
    if (kind === "team") s.units[0]!.teams[idx] = res;
    else if (kind === "player") s.units[0]!.players[idx] = res;
    else if (kind === "subject") s.units[0]!.subjectPlayers[idx] = res;
  }
}

function applyOutcomes(s: SettledEntities, outcomes: Outcome[]): void {
  for (const o of outcomes) {
    if (o.kind === "settle-entity") setEntity(s, o.ref, o.resolution);
    else s.clarifications.push({ ref: o.ref, question: o.question, ...(o.suggest?.length ? { suggest: o.suggest } : {}) });
  }
}

// resolveEntities: the deterministic orchestrator. Returns a cloned ResolvedScope with entity picks collapsed
// to confident + a clarifications sidecar. A clarify is terminal for its cell; recall fetches only confident ids.
export async function resolveEntities(query: string, scope: ResolvedScope, decideFn: DecideFn = decide): Promise<SettledEntities> {
  const settled = structuredClone(scope) as SettledEntities;
  settled.clarifications = [];
  const cells = buildEntityCells(scope);
  if (cells.length) applyOutcomes(settled, await runPasses(query, cells, decideFn));
  return settled;
}
