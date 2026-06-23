// THROWAWAY trace harness (gitignored). Mirrors resolve.ts's resolveQuery chain EXACTLY, but logs the raw
// payload/response at every stage, the offering-API fetch URLs (not their bodies), and per-LLM-call token usage
// + $ cost. Live: hits Anthropic (Haiku 4.5) + the Kambi feed. Run: npx tsx scripts/.pipeline-trace.ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";
import { groundScope, type ScopeUnit, type EntityResolution } from "../src/resolver/ground-scope";
import { resolveEntities } from "../src/resolver/resolve-entities";
import { planRecall } from "../src/resolver/plan-recall";
import { recall, variantOf } from "../src/resolver/recall";
import { filterBySubject } from "../src/resolver/filter";
import { resolveMarkets } from "../src/resolver/resolve-market";
import type { MarketPick } from "../src/resolver/live-menu-types";
import { select, type SelectSpec } from "../src/resolver/select";
import { execute } from "../src/resolver/execute";
import { fold } from "../src/resolver/lexical";
import type { BetOffer } from "../src/resolver/offering-client";
import type { Subject, Line } from "../src/resolver/schema";
import type { ResolvedLeg } from "../src/resolver/live-menu-types";

// ---- .env load (ANTHROPIC_API_KEY etc.) ----
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(ROOT, ".env"))) for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, ""); }

// ---- Haiku 4.5 pricing ($/MTok) ----
const PRICE = { in: 1.0, out: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };
type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
const costOf = (u: Usage) => ((u.input_tokens ?? 0) * PRICE.in + (u.output_tokens ?? 0) * PRICE.out + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / 1e6;

// ---- fetch wrapper: capture offering-API URLs (no body) + Anthropic token usage ----
let stage = "init";
let llmCalls: { stage: string; model: string; usage: Usage; cost: number }[] = [];
let fetchUrls: { stage: string; url: string }[] = [];
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const res = await origFetch(input, init);
  if (url.includes("offering-api") || url.includes("kambicdn")) {
    fetchUrls.push({ stage, url }); // requirement: log full fetch URL, NOT the response body
  } else if (url.includes("api.anthropic.com") && url.includes("/messages")) {
    try { const body: any = await res.clone().json(); if (body?.usage) llmCalls.push({ stage, model: body.model, usage: body.usage, cost: costOf(body.usage) }); } catch { /* non-JSON */ }
  }
  return res;
}) as typeof fetch;

// ---- pretty logging ----
const hr = (s: string) => console.log(`\n${"─".repeat(100)}\n${s}\n${"─".repeat(100)}`);
const raw = (label: string, obj: unknown) => console.log(`\n▸ ${label}:\n${JSON.stringify(obj, null, 2)}`);

// ---- helpers copied verbatim from resolve.ts (they are module-local there) ----
const filterSubject = (s: Subject): string | undefined => (s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined);
const selectSubject = (s: Subject): string | undefined => (s.kind === "team" ? s.name : s.kind === "player" ? s.name : s.kind === "either_match_team" ? s.side : undefined);
const confidentId = (r: EntityResolution | null | undefined): number | undefined => (r && r.tier === "confident" ? r.candidates[0]?.id : undefined);
function subjectParticipantId(unit: ScopeUnit, s: Subject, i: number): number | undefined {
  if (s.kind === "player") return confidentId(unit.subjectPlayers[i]);
  if (s.kind === "team") { const t = unit.teams.find((e) => fold(e.text) === fold(s.name)) ?? unit.teams.find((e) => fold(e.candidates[0]?.name ?? "") === fold(s.name)); return confidentId(t); }
  return undefined;
}
function selSpec(line: Line | undefined, subject?: string, subjectId?: number): SelectSpec {
  const base: SelectSpec = { ...(subjectId != null ? { subjectId } : {}), ...(subject ? { subject } : {}) };
  if (!line) return base;
  if (line.kind === "numeric") return { ...base, line: line.value, dir: line.direction };
  if (line.kind === "binary") return { ...base, dir: line.direction };
  return { ...base, selection: line.value };
}
const offersForPick = (offers: BetOffer[], criterionId?: number, variant?: string): BetOffer[] => offers.filter((b) => b.criterion?.id === criterionId && variantOf(b) === (variant ?? ""));

// ---- trace one query through the exact resolveQuery pipeline ----
async function trace(query: string): Promise<void> {
  llmCalls = []; fetchUrls = [];
  console.log(`\n\n${"█".repeat(100)}\n█  QUERY: "${query}"\n${"█".repeat(100)}`);

  // STAGE 1: extract (LLM)
  hr("STAGE 1 — extract  (LLM: Haiku)");
  raw("PAYLOAD (user message → model; ~11KB system prompt is constant + prompt-cached, not shown)", { messages: [{ role: "user", content: query }] });
  stage = "extract"; const plan = await extract(query);
  raw("RESPONSE (validated QueryPlan)", plan);

  // STAGE 2: groundScope (deterministic, lexical)
  hr("STAGE 2 — groundScope  (deterministic, no LLM)");
  stage = "groundScope"; const scope = groundScope(plan);
  raw("RESPONSE (ResolvedScope)", scope);

  // STAGE 3: resolveEntities (LLM only if entities are ambiguous)
  hr("STAGE 3 — resolveEntities  (LLM: Haiku, only when entities are ambiguous)");
  raw("PAYLOAD (the grounded scope from stage 2)", scope);
  stage = "resolveEntities"; const settled = await resolveEntities(query, scope);
  raw("RESPONSE (SettledEntities)", settled);

  // STAGE 4: planRecall (deterministic)
  hr("STAGE 4 — planRecall  (deterministic, no LLM)");
  stage = "planRecall"; const recallInput = planRecall(settled);
  raw("RESPONSE (RecallInput: endpoint + ids + grain, NO market type bound)", recallInput);

  // STAGE 5: recall (network fetch → live menu)
  hr("STAGE 5 — recall  (fetches the live feed; URLs below, bodies NOT logged)");
  stage = "recall"; const r = await recall(recallInput);
  console.log(`\n▸ OFFERING-API FETCH URLs (${fetchUrls.filter((u) => u.stage === "recall").length}):`);
  for (const u of fetchUrls.filter((x) => x.stage === "recall")) console.log(`   ${u.url}`);
  const ev = r.data.events[0];
  raw("RESPONSE SUMMARY (raw bet-offer bodies omitted per request)", { betOffers: r.data.betOffers.length, events: r.data.events.length, firstEvent: ev ? { id: ev.id, name: ev.name, home: ev.homeName, away: ev.awayName } : null });

  // per-selector flow (mirrors resolveQuery): legs are GROUPED by filter subject so legs sharing a menu resolve
  // in ONE batched resolveMarkets call (Q2). Filter runs once per group; select runs per leg in original order.
  const ctx = { home: ev?.homeName, away: ev?.awayName };
  const unit = settled.units[0]!;
  const EVENT_KEY = " event";
  const groups = new Map<string, number[]>();
  for (const [i, sel] of unit.selectors.entries()) { const key = filterSubject(sel.subject) ?? EVENT_KEY; let a = groups.get(key); if (!a) groups.set(key, (a = [])); a.push(i); }
  const filtered = new Map<string, ReturnType<typeof filterBySubject>>();
  const pickByIdx: MarketPick[] = new Array(unit.selectors.length);
  let g = 0;
  for (const [key, idxs] of groups) {
    hr(`GROUP ${g++} — subject=${JSON.stringify(key === EVENT_KEY ? undefined : key)}  ·  legs [${idxs.join(", ")}]`);
    // STAGE 6: filter (deterministic, once per group)
    stage = `filter[${key}]`;
    const fr = filterBySubject(r.data.betOffers, r.data.events, filterSubject(unit.selectors[idxs[0]!]!.subject));
    filtered.set(key, fr);
    console.log(`\n  ▸ STAGE 6 filter (deterministic): menu kept ${fr.menu.length} markets`);
    raw("  FILTERED MENU (the exact labels the resolver will see)", fr.menu.map((m, j) => `${j}: ${m.label}`));
    // STAGE 7: resolveMarket — ONE call for ALL legs in this group
    const phrases = idxs.map((i) => unit.selectors[i]!.market_concept);
    console.log(`\n  ▸ STAGE 7 resolveMarkets (LLM: Haiku) — ${phrases.length} leg(s) in ONE call`);
    raw("  PAYLOAD (all bets + the single numbered menu above)", { bets: phrases });
    stage = `resolveMarket[${key}]`; const picks = await resolveMarkets(phrases, fr.menu);
    raw("  RESPONSE (MarketPick per leg)", picks);
    idxs.forEach((i, k) => (pickByIdx[i] = picks[k]!));
  }

  const legs: ResolvedLeg[] = [];
  for (const [i, sel] of unit.selectors.entries()) {
    const pick = pickByIdx[i]!;
    hr(`SELECT leg ${i} — "${sel.market_concept}"  ·  pick=${pick.match}`);
    let selection;
    if (pick.match !== "none") {
      const { offers } = filtered.get(filterSubject(sel.subject) ?? EVENT_KEY)!;
      const slice = { events: r.data.events, betOffers: offersForPick(offers, pick.criterionId, pick.variant) };
      const spec = selSpec(sel.line, selectSubject(sel.subject), subjectParticipantId(unit, sel.subject, i));
      stage = `select#${i}`; selection = select(slice, spec, ctx);
      console.log(`\n  ▸ STAGE 8 select (deterministic, no LLM): ${slice.betOffers.flatMap((b) => b.outcomes ?? []).length} outcomes on the picked market`);
      raw("  SELECT spec (value + direction + subject id)", spec);
      raw("  RESPONSE (Selection)", selection);
    } else {
      console.log(`\n  ▸ STAGE 8 select — SKIPPED (market pick was "none")`);
    }
    legs.push({ phrase: sel.market_concept, pick, ...(selection ? { selection } : {}) });
  }

  // STAGE 9: execute (deterministic)
  hr("STAGE 9 — execute  (deterministic, no LLM)");
  stage = "execute"; const answer = execute({ legs, data: r.data, clarifications: settled.clarifications });
  raw("RESPONSE (LiveAnswer — the final result)", answer);

  // ---- cost report ----
  hr("LLM COST REPORT (Haiku 4.5 — in $1.00 / out $5.00 / cacheWrite $1.25 / cacheRead $0.10 per MTok)");
  let tin = 0, tout = 0, tcw = 0, tcr = 0, tcost = 0;
  console.log(`\n  ${"stage".padEnd(20)}${"in".padStart(8)}${"cacheRd".padStart(9)}${"cacheWr".padStart(9)}${"out".padStart(8)}${"cost $".padStart(12)}`);
  for (const c of llmCalls) {
    const u = c.usage; tin += u.input_tokens ?? 0; tout += u.output_tokens ?? 0; tcw += u.cache_creation_input_tokens ?? 0; tcr += u.cache_read_input_tokens ?? 0; tcost += c.cost;
    console.log(`  ${c.stage.padEnd(20)}${String(u.input_tokens ?? 0).padStart(8)}${String(u.cache_read_input_tokens ?? 0).padStart(9)}${String(u.cache_creation_input_tokens ?? 0).padStart(9)}${String(u.output_tokens ?? 0).padStart(8)}${("$" + c.cost.toFixed(6)).padStart(12)}`);
  }
  console.log(`  ${"─".repeat(66)}`);
  console.log(`  ${("TOTAL (" + llmCalls.length + " calls)").padEnd(20)}${String(tin).padStart(8)}${String(tcr).padStart(9)}${String(tcw).padStart(9)}${String(tout).padStart(8)}${("$" + tcost.toFixed(6)).padStart(12)}`);
  console.log(`\n  Tokens: ${tin + tcr + tcw} input (${tin} fresh + ${tcr} cache-read + ${tcw} cache-write) · ${tout} output`);
  console.log(`  TOTAL COST: $${tcost.toFixed(6)}  (≈ $${(tcost * 1000).toFixed(4)} per 1000 such queries)`);
}

async function main(): Promise<void> {
  const queries = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const deck = queries.length ? queries : ["outright winner odds for World Cup 2026", "back France to win the tournament and reach the final as well"];
  for (const q of deck) await trace(q);
}
main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
