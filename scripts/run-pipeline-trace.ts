// run-pipeline-trace — instrumented end-to-end run of the live-menu pipeline.
//
//   tsx scripts/run-pipeline-trace.ts "your query here"
//
// Mirrors resolve.ts/resolveQuery EXACTLY (same stage functions, same order, same helper logic),
// but prints the raw input + output of every stage. Two instrumentation seams, both non-invasive:
//   - Anthropic Messages.prototype.create is wrapped -> captures the full LLM request body, the full
//     tool_use response, and token usage (the modules all share one prototype, so one patch covers
//     extract / resolveEntities / resolveMarkets).
//   - global fetch is wrapped -> logs the FULL Kambi offering-API URL for every fetch (never the body).
// LLM cost is computed from usage with Claude Haiku 4.5 pricing.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, ".."); // scripts -> repo root

// ---- .env (same loader as src/eval/run.ts) -------------------------------------------------------
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!key || process.env[key]) continue;
    process.env[key] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (put it in .env or export it).");
  process.exit(1);
}

// ---- Haiku 4.5 pricing (USD per token) — from the claude-api skill -------------------------------
//   input $1.00/MTok, output $5.00/MTok, cache-write (5m ephemeral) 1.25x, cache-read 0.1x.
const PRICE = {
  input: 1.0 / 1e6,
  output: 5.0 / 1e6,
  cacheWrite: 1.25 / 1e6,
  cacheRead: 0.1 / 1e6,
};

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
type LlmCall = { stage: string; model: string; request: unknown; toolInput: unknown; usage: Usage };

const llmCalls: LlmCall[] = [];
const apiFetches: { stage: string; method: string; url: string }[] = [];
let currentStage = "(init)";

// ---- seam 1: wrap Messages.prototype.create (shared by all module clients) ------------------------
const probeClient = new Anthropic();
const msgProto = Object.getPrototypeOf(probeClient.messages) as { create: (...a: any[]) => any };
const origCreate = msgProto.create;
msgProto.create = async function (this: unknown, body: any, options?: unknown) {
  const res = await origCreate.call(this, body, options);
  const toolUse = (res?.content ?? []).find((b: any) => b?.type === "tool_use");
  llmCalls.push({
    stage: currentStage,
    model: body?.model ?? res?.model ?? "?",
    request: body,
    toolInput: toolUse?.input,
    usage: res?.usage ?? {},
  });
  return res;
};

// ---- seam 2: wrap global fetch — log Kambi offering URLs only (never the body) -------------------
const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.includes("kambicdn")) {
    apiFetches.push({ stage: currentStage, method: (init?.method ?? "GET").toUpperCase(), url });
  }
  return origFetch(input as any, init);
} as typeof fetch;

// ---- pipeline imports (the REAL stage functions) -------------------------------------------------
import { extract } from "../src/resolver/extract";
import { groundScope, type ScopeUnit, type EntityResolution } from "../src/resolver/ground-scope";
import { resolveEntities } from "../src/resolver/resolve-entities";
import { planRecall } from "../src/resolver/plan-recall";
import { recall, variantOf } from "../src/resolver/recall";
import { filterBySubject } from "../src/resolver/filter";
import { boTypeIdSet } from "../src/resolver/bo-types";
import { resolveMarkets } from "../src/resolver/resolve-market";
import { select, type SelectSpec } from "../src/resolver/select";
import { execute } from "../src/resolver/execute";
import { fold } from "../src/resolver/lexical";
import { resolveTimeWindow, filterEventsByTime, hasWindow } from "../src/resolver/time-window";
import type { BetOffer, KEvent } from "../src/resolver/offering-client";
import type { Subject, Line } from "../src/resolver/schema";
import type { ResolvedLeg, MarketPick } from "../src/resolver/live-menu-types";

// ---- helpers copied VERBATIM from resolve.ts (so the chain matches the orchestrator exactly) -----
const filterSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined;
const selectSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : s.kind === "either_match_team" ? s.side : undefined;
const confidentId = (r: EntityResolution | null | undefined): number | undefined =>
  r && r.tier === "confident" ? r.candidates[0]?.id : undefined;
function subjectParticipantId(unit: ScopeUnit, s: Subject, i: number): number | undefined {
  if (s.kind === "player") return confidentId(unit.subjectPlayers[i]);
  if (s.kind === "team") {
    const t =
      unit.teams.find((e) => fold(e.text) === fold(s.name)) ??
      unit.teams.find((e) => fold(e.candidates[0]?.name ?? "") === fold(s.name));
    return confidentId(t);
  }
  return undefined;
}
function selSpec(line: Line | undefined, odds: { min?: number; max?: number } | undefined, subject?: string, subjectId?: number): SelectSpec {
  const base: SelectSpec = {
    ...(subjectId != null ? { subjectId } : {}),
    ...(subject ? { subject } : {}),
    ...(odds?.min != null ? { oddsMin: odds.min } : {}),
    ...(odds?.max != null ? { oddsMax: odds.max } : {}),
  };
  if (!line) return base;
  if (line.kind === "numeric") return { ...base, line: line.value, dir: line.direction };
  if (line.kind === "binary") return { ...base, dir: line.direction };
  return { ...base, selection: line.value };
}
const offersForPick = (offers: BetOffer[], criterionId?: number, variant?: string): BetOffer[] =>
  offers.filter((b) => b.criterion?.id === criterionId && variantOf(b) === (variant ?? ""));

// ---- pretty printing -----------------------------------------------------------------------------
const RULE = "=".repeat(100);
const sub = (s: string) => "-".repeat(s.length);
function banner(title: string) {
  console.log("\n" + RULE);
  console.log(title);
  console.log(RULE);
}
function raw(label: string, obj: unknown) {
  console.log(`\n${label}\n${sub(label)}`);
  console.log(JSON.stringify(obj, null, 2));
}
function fmtUsd(n: number) {
  return "$" + n.toFixed(6);
}
function callCost(u: Usage) {
  const i = u.input_tokens ?? 0;
  const o = u.output_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  return {
    i,
    o,
    cw,
    cr,
    cost: i * PRICE.input + o * PRICE.output + cw * PRICE.cacheWrite + cr * PRICE.cacheRead,
  };
}

// ==================================================================================================
async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('usage: tsx scripts/run-pipeline-trace.ts "your query"');
    process.exit(1);
  }

  banner("PIPELINE TRACE");
  console.log(`query: ${JSON.stringify(query)}`);
  console.log(`models: extract / resolveEntities / resolveMarkets all = claude-haiku-4-5-20251001`);

  // ---- STAGE 1: extract (LLM) --------------------------------------------------------------------
  banner("STAGE 1 — extract(query)  [LLM: Haiku, forced tool 'emit_query_plan']");
  raw("INPUT (raw user query)", query);
  currentStage = "extract";
  const plan = await extract(query);
  raw("OUTPUT (validated QueryPlan)", plan);

  // ---- STAGE 2: groundScope (deterministic) ------------------------------------------------------
  banner("STAGE 2 — groundScope(plan)  [deterministic, no LLM, no fetch]");
  raw("INPUT (QueryPlan)", plan);
  currentStage = "groundScope";
  const scope = groundScope(plan);
  raw("OUTPUT (ResolvedScope)", scope);

  // ---- STAGE 3: resolveEntities (LLM, 0-2 passes) ------------------------------------------------
  banner("STAGE 3 — resolveEntities(query, scope)  [LLM: Haiku entity gate, only on doubtful tiers]");
  raw("INPUT.query", query);
  raw("INPUT.scope (ResolvedScope)", scope);
  currentStage = "resolveEntities";
  const settled = await resolveEntities(query, scope);
  raw("OUTPUT (SettledEntities)", settled);

  // ---- STAGE 4: planRecall (deterministic) -------------------------------------------------------
  banner("STAGE 4 — planRecall(settled)  [deterministic, no LLM, no fetch]");
  raw("INPUT (SettledEntities)", settled);
  currentStage = "planRecall";
  const recallInput = planRecall(settled);
  raw("OUTPUT (RecallInput)", recallInput);

  // ---- STAGE 5: recall (FETCH) -------------------------------------------------------------------
  banner("STAGE 5 — recall(recallInput)  [FETCHES live menu — URLs logged, API bodies NOT]");
  raw("INPUT (RecallInput)", recallInput);
  currentStage = "recall";
  const fetchMark = apiFetches.length;
  const r = await recall(recallInput);
  console.log("\nAPI FETCHES ISSUED (full URLs; responses intentionally NOT logged)");
  console.log(sub("API FETCHES ISSUED (full URLs; responses intentionally NOT logged)"));
  apiFetches.slice(fetchMark).forEach((f, k) => console.log(`  [${k}] ${f.method} ${f.url}`));
  raw("OUTPUT.endpoint", r.endpoint);
  raw("OUTPUT.truncated", r.truncated);
  console.log(
    `\nOUTPUT.data summary (API bodies suppressed per request): events=${r.data.events.length} betOffers=${r.data.betOffers.length}`,
  );
  raw(`OUTPUT.menu (live menu — ${r.menu.length} distinct markets, labels only)`, r.menu);

  // ---- TIME post-filter (verbatim from resolve.ts) ----------------------------------------------
  if (settled.time) {
    banner("TIME POST-FILTER — resolveTimeWindow(settled.time) -> filterEventsByTime(r.data.events)");
    const startMs = (e: KEvent) => (e.start ? Date.parse(e.start) : e.originalStartDate ? Date.parse(e.originalStartDate) : NaN);
    const starts = r.data.events.map(startMs).filter((n) => !Number.isNaN(n));
    const tournamentStart = starts.length ? new Date(Math.min(...starts)) : undefined;
    const window = resolveTimeWindow(settled.time, { now: new Date(), tournamentStart });
    raw("TIME INPUT.settled.time", settled.time);
    raw("TIME OUTPUT.window (resolved [from,to] / kickoff / pick)", window);
    if (hasWindow(window) || window.pick) {
      const before = r.data.events.length;
      let kept = filterEventsByTime(r.data.events, window);
      if (window.pick) {
        const ordered = kept.filter((e) => !Number.isNaN(startMs(e))).sort((a, b) => startMs(a) - startMs(b));
        kept = window.pick.order === "earliest" ? ordered.slice(0, window.pick.count) : ordered.slice(-window.pick.count);
      }
      const keep = new Set(kept.map((e) => e.id));
      r.data.events = kept;
      r.data.betOffers = r.data.betOffers.filter((b) => b.eventId == null || keep.has(b.eventId));
      console.log(`TIME FILTER: events ${before} -> ${r.data.events.length}; betOffers now ${r.data.betOffers.length}`);
    } else {
      console.log("TIME FILTER: no concrete window (unresolved or empty) -> events unchanged");
    }
  }

  // ---- post-recall setup (verbatim from resolve.ts) ---------------------------------------------
  const ev = r.data.events[0];
  const ctx = { home: ev?.homeName, away: ev?.awayName };
  const unit = settled.units[0]!;
  banner("FIXTURE CONTEXT (resolve.ts: r.data.events[0])");
  raw("ctx (home/away used for relational subjects)", ctx);

  // group selectors by FILTER subject (verbatim)
  const EVENT_KEY = " event";
  const groups = new Map<string, number[]>();
  for (const [i, sel] of unit.selectors.entries()) {
    const key = filterSubject(sel.subject) ?? EVENT_KEY;
    let idxs = groups.get(key);
    if (!idxs) groups.set(key, (idxs = []));
    idxs.push(i);
  }
  banner("SELECTOR GROUPING (legs sharing a FILTER subject share one filtered menu + one LLM call)");
  raw(
    "groups (filterSubject -> selector indices)",
    [...groups.entries()].map(([k, idxs]) => ({ filterSubject: k, selectorIdxs: idxs })),
  );

  // ---- STAGE 6+7: per group -> FILTER (deterministic) + resolveMarkets (LLM) ---------------------
  const filtered = new Map<string, ReturnType<typeof filterBySubject>>();
  const pickByIdx: MarketPick[] = new Array(unit.selectors.length);
  for (const [key, idxs] of groups) {
    banner(`GROUP "${key}" — selectors [${idxs.join(", ")}]`);

    const keepTypes = boTypeIdSet(idxs.flatMap((i) => unit.selectors[i]!.bo_types ?? []));
    console.log("\nSTAGE 6 — filterBySubject(...)  [deterministic]");
    raw("FILTER INPUT.filterSubject", filterSubject(unit.selectors[idxs[0]!]!.subject) ?? null);
    raw("FILTER INPUT.keepTypes (bo_type ids; empty = keep all)", [...keepTypes]);
    currentStage = `filter[${key}]`;
    const fr = filterBySubject(
      r.data.betOffers,
      r.data.events,
      filterSubject(unit.selectors[idxs[0]!]!.subject),
      keepTypes,
    );
    filtered.set(key, fr);
    console.log(`\nFILTER OUTPUT: kept ${fr.offers.length} betOffers -> ${fr.menu.length} menu items`);
    raw("FILTER OUTPUT.menu (filtered live menu handed to RESOLVE)", fr.menu);

    const phrases = idxs.map((i) => unit.selectors[i]!.market_concept);
    console.log("\nSTAGE 7 — resolveMarkets(phrases, menu)  [LLM: Haiku, forced tool 'pick']");
    raw("RESOLVE INPUT.phrases (one per leg)", phrases);
    raw(
      "RESOLVE INPUT.menu (ref: label — exactly what the model sees)",
      fr.menu.map((m, i) => `${i}: ${m.label}`),
    );
    currentStage = `resolveMarkets[${key}]`;
    const picks = await resolveMarkets(phrases, fr.menu);
    raw("RESOLVE OUTPUT (MarketPick[] — criterionId+variant+match+reason)", picks);
    idxs.forEach((i, k) => (pickByIdx[i] = picks[k]!));
  }

  // ---- STAGE 8: SELECT per leg (deterministic) --------------------------------------------------
  banner("STAGE 8 — select(...) per leg  [deterministic, pulls the concrete outcome]");
  const legs: ResolvedLeg[] = [];
  for (const [i, sel] of unit.selectors.entries()) {
    const pick = pickByIdx[i]!;
    console.log(`\n--- leg ${i}: ${JSON.stringify(sel.market_concept)} ---`);
    let selection;
    if (pick.match !== "none") {
      const { offers } = filtered.get(filterSubject(sel.subject) ?? EVENT_KEY)!;
      const sliceOffers = offersForPick(offers, pick.criterionId, pick.variant);
      const spec = selSpec(sel.line, sel.odds, selectSubject(sel.subject), subjectParticipantId(unit, sel.subject, i));
      raw("SELECT INPUT.spec (SelectSpec)", spec);
      raw(
        "SELECT INPUT.candidate outcomes (from picked market's offers)",
        sliceOffers.flatMap((b) =>
          (b.outcomes ?? []).map((o) => ({
            id: o.id,
            label: o.label,
            englishLabel: o.englishLabel,
            type: o.type,
            participant: o.participant,
            participantId: o.participantId,
            odds: o.odds,
            line: o.line,
          })),
        ),
      );
      currentStage = `select[leg ${i}]`;
      selection = select({ events: r.data.events, betOffers: sliceOffers }, spec, ctx);
      raw("SELECT OUTPUT (Selection)", selection);
    } else {
      console.log("pick.match === 'none' -> SELECT skipped for this leg");
    }
    legs.push({ phrase: sel.market_concept, pick, ...(selection ? { selection } : {}) });
  }

  // ---- STAGE 9: execute (deterministic) ---------------------------------------------------------
  banner("STAGE 9 — execute({ legs, data, clarifications })  [deterministic; assembles final answer]");
  raw("EXECUTE INPUT.legs (resolved legs; API data suppressed)", legs);
  raw("EXECUTE INPUT.clarifications", settled.clarifications);
  currentStage = "execute";
  const answer = execute({ legs, data: r.data, clarifications: settled.clarifications });
  raw("OUTPUT — FINAL LiveAnswer", answer);

  // ---- LLM COST LEDGER ---------------------------------------------------------------------------
  banner("LLM COST LEDGER  (Claude Haiku 4.5: in $1.00/MTok, out $5.00/MTok, cache-write 1.25x, cache-read 0.1x)");
  let tI = 0,
    tO = 0,
    tCW = 0,
    tCR = 0,
    tCost = 0;
  console.log(
    "\n#  stage                          in     out   cacheW  cacheR     cost",
  );
  console.log(sub("#  stage                          in     out   cacheW  cacheR     cost"));
  llmCalls.forEach((c, k) => {
    const x = callCost(c.usage);
    tI += x.i;
    tO += x.o;
    tCW += x.cw;
    tCR += x.cr;
    tCost += x.cost;
    console.log(
      `${String(k).padEnd(2)} ${c.stage.padEnd(30)} ${String(x.i).padStart(5)} ${String(x.o).padStart(5)} ` +
        `${String(x.cw).padStart(7)} ${String(x.cr).padStart(7)}  ${fmtUsd(x.cost)}`,
    );
  });
  console.log(sub("#  stage                          in     out   cacheW  cacheR     cost"));
  console.log(
    `   ${"TOTAL".padEnd(30)} ${String(tI).padStart(5)} ${String(tO).padStart(5)} ${String(tCW).padStart(7)} ${String(tCR).padStart(7)}  ${fmtUsd(tCost)}`,
  );
  console.log(
    `\n   total LLM calls: ${llmCalls.length}   total tokens (in+out+cacheW+cacheR): ${tI + tO + tCW + tCR}   total cost: ${fmtUsd(tCost)}`,
  );
  console.log(`   total Kambi API fetches: ${apiFetches.length}`);

  // full LLM request/response dump (kept last so the trace reads top-to-bottom first)
  banner("RAW LLM PAYLOADS & RESPONSES (every Anthropic call, full)");
  llmCalls.forEach((c, k) => {
    console.log(`\n########## LLM CALL ${k} — stage="${c.stage}" model=${c.model} ##########`);
    raw("REQUEST (messages.create body)", c.request);
    raw("RESPONSE tool_use.input (the structured output)", c.toolInput);
    raw("RESPONSE usage", c.usage);
  });
}

main().catch((e) => {
  console.error("\nPIPELINE ERROR:", e);
  process.exit(1);
});
