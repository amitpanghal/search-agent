// Online trace — one ad-hoc query through the REAL pipeline (REAL LLM + recall fetch), printing every
// stage's input/output. Does NOT use llm-cache or subagent doubles.
//
//   tsx --env-file=.env src/harness-loop/_online-trace-once.ts "your query"
//
// Kambi URLs are logged in full; recall responses are summarized (counts + menu labels), not the raw body.
// Never use it unlike user asks to, ask before using and stating clearly that it will call the LLM API.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../resolver/extract";
import { checkComplete } from "../resolver/check-complete";
import { groundScope, type EntityResolution, type ResolvedLegScope } from "../resolver/ground-scope";
import { resolveEntities } from "../resolver/resolve-entities";
import { planRecall } from "../resolver/plan-recall";
import { recall, scopeMenu, marketLabelOf } from "../resolver/recall";
import { filterBySubject } from "../resolver/filter";
import { resolveMarkets } from "../resolver/resolve-market";
import { select, type SelectSpec } from "../resolver/select";
import { execute, type ResponseEnvelope } from "../resolver/execute";
import { fold } from "../resolver/lexical";
import { isMain, type BetOffer, type KEvent } from "../resolver/offering-client";
import { getSport } from "../resolver/sports";
import type { Subject, Line } from "../resolver/schema";
import type { ResolvedLeg, MarketPick } from "../resolver/live-menu-types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

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

const apiFetches: { stage: string; method: string; url: string }[] = [];
let currentStage = "(init)";
const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: unknown, init?: RequestInit) {
  const url = typeof input === "string" ? input : (input as Request)?.url ?? String(input);
  if (url.includes("kambicdn")) {
    apiFetches.push({ stage: currentStage, method: (init?.method ?? "GET").toUpperCase(), url });
  }
  return origFetch(input as Parameters<typeof fetch>[0], init);
} as typeof fetch;

const RULE = "=".repeat(100);
function banner(title: string) {
  console.log("\n" + RULE);
  console.log(title);
  console.log(RULE);
}
function raw(label: string, obj: unknown) {
  console.log(`\n${label}\n${"-".repeat(label.length)}`);
  console.log(JSON.stringify(obj, null, 2));
}

// ---- helpers copied from resolve.ts -----------------------------------------------------------
const filterSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : undefined;
const selectSubject = (s: Subject): string | undefined =>
  s.kind === "team" ? s.name : s.kind === "player" ? s.name : s.kind === "either_match_team" ? s.side : undefined;
const betPhrase = (sel: { subject: Subject; market_concept: string }): string =>
  sel.subject.kind === "player" ? `${sel.market_concept} (for one player)` : sel.market_concept;
const confidentId = (r: EntityResolution | null | undefined): number | undefined =>
  r && r.tier === "confident" ? r.candidates[0]?.id : undefined;
function subjectEntity(leg: ResolvedLegScope, s: Subject): EntityResolution | null | undefined {
  if (s.kind === "player") return leg.subjectPlayer;
  if (s.kind === "team") {
    return leg.teams.find((e) => fold(e.text) === fold(s.name))
      ?? leg.teams.find((e) => fold(e.candidates[0]?.name ?? "") === fold(s.name));
  }
  return undefined;
}
const subjectParticipantId = (leg: ResolvedLegScope, s: Subject): number | undefined =>
  confidentId(subjectEntity(leg, s));
function subjectName(leg: ResolvedLegScope, s: Subject): string | undefined {
  const e = subjectEntity(leg, s);
  return e && e.tier === "confident" ? e.candidates[0]?.name : undefined;
}
function selSpec(
  line: Line | undefined,
  odds: { min?: number; max?: number } | undefined,
  subject?: string,
  subjectId?: number,
  sort?: "low" | "high",
  count?: number,
): SelectSpec {
  const base: SelectSpec = {
    ...(subjectId != null ? { subjectId } : {}),
    ...(subject ? { subject } : {}),
    ...(odds?.min != null ? { oddsMin: odds.min } : {}),
    ...(odds?.max != null ? { oddsMax: odds.max } : {}),
    ...(sort ? { sort } : {}),
    ...(count != null ? { count } : {}),
  };
  return line === undefined ? base : { ...base, lineValue: line };
}
const offersForPick = (offers: BetOffer[], label?: string): BetOffer[] =>
  label == null ? [] : offers.filter((b) => marketLabelOf(b) === label);

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('usage: tsx --env-file=.env src/harness-loop/_offline-trace-once.ts "your query"');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  banner("PIPELINE TRACE (real LLM + recall fetch; no harness cache)");
  console.log(`query: ${JSON.stringify(query)}`);

  // STAGE 1: extract
  banner("STAGE 1 — extract(query)  [LLM]");
  raw("INPUT", query);
  currentStage = "extract";
  const plan = await extract(query);
  raw("OUTPUT (QueryPlan)", plan);

  // STAGE 2: checkComplete
  banner("STAGE 2 — checkComplete(plan)  [deterministic gate]");
  raw("INPUT (QueryPlan)", plan);
  currentStage = "checkComplete";
  const incomplete = checkComplete(plan);
  raw("OUTPUT", incomplete ?? { ok: true });
  if (incomplete) {
    const env: ResponseEnvelope = { summary: "", results: [], notes: [], clarificationNeeded: incomplete.question };
    raw("EARLY STOP — ResponseEnvelope", env);
    return;
  }

  if (!getSport(plan.sport)) {
    raw("EARLY STOP — unsupported sport", plan.sport);
    return;
  }

  // STAGE 3: groundScope
  banner("STAGE 3 — groundScope(plan)  [deterministic]");
  raw("INPUT (QueryPlan)", plan);
  currentStage = "groundScope";
  const scope = groundScope(plan);
  raw("OUTPUT (ResolvedScope)", scope);

  // STAGE 4: resolveEntities
  banner("STAGE 4 — resolveEntities(query, scope)  [LLM on doubtful tiers]");
  raw("INPUT.query", query);
  raw("INPUT.scope", scope);
  currentStage = "resolveEntities";
  const settled = await resolveEntities(query, scope);
  raw("OUTPUT (SettledEntities)", settled);

  // STAGE 5: planRecall
  banner("STAGE 5 — planRecall(settled, plan)  [deterministic]");
  raw("INPUT.settled", settled);
  raw("INPUT.plan", plan);
  currentStage = "planRecall";
  const recallInput = planRecall(settled, plan);
  raw("OUTPUT (RecallInput)", recallInput);

  if (!recallInput.participantIds?.length && !recallInput.groupIds?.length && !recallInput.eventIds?.length) {
    if (settled.clarifications.length > 0) {
      const env = execute({ legs: [], data: { betOffers: [], events: [] }, clarifications: settled.clarifications });
      raw("EARLY STOP — clarifications only", env);
      return;
    }
  }

  // STAGE 6: recall
  banner("STAGE 6 — recall(recallInput)  [network fetch]");
  raw("INPUT (RecallInput)", recallInput);
  currentStage = "recall";
  const fetchMark = apiFetches.length;
  const r = await recall(recallInput);
  console.log("\nAPI FETCHES (full URLs)");
  console.log("-".repeat(24));
  apiFetches.slice(fetchMark).forEach((f, i) => console.log(`  [${i}] ${f.method} ${f.url}`));
  raw("OUTPUT.endpoint", r.endpoint);
  raw("OUTPUT.truncated", r.truncated);
  raw("OUTPUT.failed", r.failed);
  raw("OUTPUT.data summary", { events: r.data.events.length, betOffers: r.data.betOffers.length });
  raw(`OUTPUT.menu (${r.menu.length} items)`, r.menu);

  // Grouping (resolve.ts)
  const sigOf = (i: number): string => {
    const leg = settled.legs[i]!;
    const sel = plan.selectors[i]!;
    const teamIds = leg.teams.filter((t) => t.tier === "confident").flatMap((t) => t.candidates.map((c) => c.id)).sort((a, b) => a - b);
    return JSON.stringify([
      filterSubject(sel.subject) ?? "",
      sel.subject.kind === "either_match_team" ? sel.subject.side ?? "" : "",
      subjectParticipantId(leg, sel.subject) ?? 0,
      leg.level,
      confidentId(leg.competition) ?? 0,
      teamIds,
      leg.time,
      leg.stage,
      leg.playState,
    ]);
  };
  const groups = new Map<string, number[]>();
  plan.selectors.forEach((_, i) => {
    const key = sigOf(i);
    let idxs = groups.get(key);
    if (!idxs) groups.set(key, (idxs = []));
    idxs.push(i);
  });
  banner("SELECTOR GROUPING");
  raw("groups", [...groups.entries()].map(([k, idxs]) => ({ signature: k, selectorIdxs: idxs })));

  type GroupData = { scoped: ReturnType<typeof scopeMenu>; fr: ReturnType<typeof filterBySubject> };
  const groupData = new Map<string, GroupData>();
  const keyByIdx: string[] = new Array(plan.selectors.length);
  const pickByIdx: MarketPick[] = new Array(plan.selectors.length);

  for (const [key, idxs] of groups) {
    const leg = settled.legs[idxs[0]!]!;
    const sel0 = plan.selectors[idxs[0]!]!;

    banner(`GROUP ${key} — scopeMenu + filter + resolveMarkets`);
    currentStage = `scopeMenu[${key}]`;
    raw("scopeMenu INPUT.leg", leg);
    const scoped = scopeMenu(r.data, leg);
    raw("scopeMenu OUTPUT", {
      menu: scoped.menu,
      offers: scoped.offers.length,
      events: scoped.events.length,
      eventIds: scoped.eventIds,
      timeUnresolved: scoped.timeUnresolved,
      timeApplied: scoped.timeApplied,
    });

    const subjId = subjectParticipantId(leg, sel0.subject);
    const subjSide = sel0.subject.kind === "either_match_team" ? sel0.subject.side : undefined;
    currentStage = `filterBySubject[${key}]`;
    raw("filterBySubject INPUT", {
      filterSubject: subjectName(leg, sel0.subject),
      subjectId: subjId,
      subjSide,
    });
    const fr = filterBySubject(scoped.offers, scoped.events, subjectName(leg, sel0.subject), subjId, subjSide);
    raw("filterBySubject OUTPUT.menu", fr.menu);
    raw("filterBySubject OUTPUT summary", { offers: fr.offers.length });
    groupData.set(key, { scoped, fr });

    const llmIdxs = idxs.filter((i) => plan.selectors[i]!.market_concept !== "main");
    if (llmIdxs.length) {
      const phrases = llmIdxs.map((i) => betPhrase(plan.selectors[i]!));
      currentStage = `resolveMarkets[${key}]`;
      raw("resolveMarkets INPUT.phrases", phrases);
      raw("resolveMarkets INPUT.menu", fr.menu);
      const picks = await resolveMarkets(phrases, fr.menu);
      raw("resolveMarkets OUTPUT (MarketPick[])", picks);
      llmIdxs.forEach((i, k) => { pickByIdx[i] = picks[k]!; });
    }
    idxs.forEach((i) => { keyByIdx[i] = key; });
  }

  const eventOf = (offers: BetOffer[], events: KEvent[]) => {
    const eid = offers.find((b) => b.eventId != null)?.eventId;
    return events.find((e) => e.id === eid) ?? events[0];
  };

  banner("STAGE — select(...) per leg");
  const legsOut: ResolvedLeg[] = [];
  for (let i = 0; i < plan.selectors.length; i++) {
    const sel = plan.selectors[i]!;
    const leg = settled.legs[i]!;
    const { scoped, fr } = groupData.get(keyByIdx[i]!)!;
    console.log(`\n--- leg ${i}: ${JSON.stringify(sel.market_concept)} ---`);
    const spec: SelectSpec = {
      ...selSpec(sel.line, sel.odds, selectSubject(sel.subject), subjectParticipantId(leg, sel.subject), sel.odds_sort, sel.count),
      ...(pickByIdx[i]?.outcomeLabel ? { outcomeLabel: pickByIdx[i]!.outcomeLabel } : {}),
    };
    const selectFor = (picked: BetOffer[]) =>
      select({ events: scoped.events, betOffers: picked }, spec, {
        home: eventOf(picked, scoped.events)?.homeName,
        away: eventOf(picked, scoped.events)?.awayName,
      });

    if (sel.market_concept === "main") {
      const mainOffers = fr.offers.filter((b) => isMain(b.tags) && b.criterion?.id != null);
      for (const label of new Set(mainOffers.map(marketLabelOf))) {
        currentStage = `select[leg ${i} main]`;
        const selection = selectFor(offersForPick(mainOffers, label));
        raw(`select OUTPUT (main market "${label}")`, selection);
        legsOut.push({ phrase: label, pick: { label, match: "exact" }, ...(selection ? { selection } : {}) });
      }
      continue;
    }

    const pick = pickByIdx[i]!;
    currentStage = `select[leg ${i}]`;
    raw("select INPUT.spec", spec);
    raw("select INPUT.pick", pick);
    const selection = pick.match !== "none" ? selectFor(offersForPick(fr.offers, pick.label)) : undefined;
    raw("select OUTPUT", selection ?? { skipped: "pick.match === none" });
    const wantedFixture = sel.scope.level === "fixture" || !!sel.scope.teams?.length || !!sel.scope.time;
    const unavailable = pick.match === "none"
      ? (scoped.events.length === 0 && wantedFixture
          ? { kind: "no-fixture" as const, ...(sel.scope.teams?.[0] ? { scope: sel.scope.teams[0] } : {}) }
          : { kind: "no-market" as const })
      : undefined;
    legsOut.push({ phrase: sel.market_concept, pick, ...(selection ? { selection } : {}), ...(unavailable ? { unavailable } : {}) });
  }

  banner("STAGE — execute(...)");
  const execEvents = new Map<number, KEvent>();
  const execOffers = new Set<BetOffer>();
  for (const { scoped } of groupData.values()) {
    for (const e of scoped.events) if (e.id != null) execEvents.set(e.id, e);
    for (const b of scoped.offers) execOffers.add(b);
  }
  currentStage = "execute";
  const envelope = execute({
    legs: legsOut,
    data: { events: [...execEvents.values()], betOffers: [...execOffers] },
    clarifications: settled.clarifications,
    truncated: r.truncated,
    fetchFailed: r.failed,
  });
  raw("OUTPUT — ResponseEnvelope", envelope);

  banner("ALL KAMBI API URLS");
  apiFetches.forEach((f, i) => console.log(`  [${i}] (${f.stage}) ${f.method} ${f.url}`));
}

main().catch((e) => {
  console.error("\nPIPELINE ERROR:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
