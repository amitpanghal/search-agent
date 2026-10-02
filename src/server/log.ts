// Logging — one JSON line per search and one per click, written to stdout; the platform ships stdout to
// CloudWatch (design: planning/logging.md). The query record is built AFTER the request from what the pipeline
// already emits into the trace store (trace.ts) plus the final envelope, so the pipeline itself is untouched.
// Compact on purpose: no prompts, no full envelope, no full menu — only what analytics and eval replay need.

import type { TraceEvent } from "../resolver/shared/trace";
import type { ResponseEnvelope, EnvelopeHighlighted, ResponseEvent } from "../resolver/result/execute";
import type { ResolvedScope, EntityResolution } from "../resolver/grounding/ground-scope";
import type { MarketPick } from "../resolver/shared/live-menu-types";
import type { RecallResult } from "../resolver/grounding/recall";
import type { FilterResult } from "../resolver/market/filter";
import type { QueryPlan } from "../resolver/extractor/schema";
import { EXTRACTION_MODEL } from "../resolver/extractor/extract";

// ponytail: one operator today. The frontend will send `offering` later; read it from the request body then.
export const OFFERING = "kambi";

export const writeLog = (record: object): void => console.log(JSON.stringify(record));

// The query is kept as typed, except emails and any run of 9+ digits (phone and card numbers). An ISO date has
// only 8 digits, so it survives.
export const scrub = (s: string): string =>
  s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[redacted]").replace(/\+?\d(?:[\s()-]*\d){8,}/g, "[redacted]");

// A result card, reduced to what a click joins against: ids, labels, odds.
const card = (h: EnvelopeHighlighted, events: ResponseEvent[]) => {
  const ev = events.find((e) => e.id === h.eventId);
  return {
    eventId: h.eventId,
    event: ev?.name,
    start: ev?.start,
    betOfferId: h.betOffer.id,
    criterion: h.betOffer.criterion.englishLabel ?? h.betOffer.criterion.label,
    outcomes: h.outcomes.map((o) => ({
      id: o.id,
      label: o.englishLabel ?? o.label,
      ...(o.participant ? { participant: o.participant } : {}),
      odds: o.odds,
      ...(o.line != null ? { line: o.line } : {}),
      ...(o.selected ? { selected: true } : {}),
    })),
  };
};

export type QueryLogInput = {
  queryId: string;
  t0: number; // ms, when the POST arrived
  query: string | null;
  tz?: string;
  locale?: string;
  trace: TraceEvent[];
  envelope?: ResponseEnvelope;
  error?: string;
  errorClass?: string;
};

export function queryRecord(q: QueryLogInput, end = Date.now()) {
  const stages = q.trace.flatMap((e) => (e.kind === "stage" ? [e] : []));
  const out = <T>(stage: string) => stages.find((e) => e.stage === stage)?.out as T | undefined;
  const env = q.envelope;

  // Each stage emits when it ENDS, so a stage's time is the gap since the previous emit. scopeMenu/filter run once
  // per leg group and take no real time; they fold into `market`.
  const timing: Record<string, number> = {};
  let prev = q.t0;
  for (const e of stages)
    if (e.stage !== "scopeMenu" && e.stage !== "filter") {
      timing[e.stage] = e.t - prev;
      prev = e.t;
    }
  timing.total = end - q.t0;

  // Final grounding: the entity step's settled scope when it ran, else the grounder's.
  const scope = out<ResolvedScope>("entities") ?? out<ResolvedScope>("ground");
  const cells = new Map<string, { text: string; type: string; tier: string; ids: number[] }>();
  for (const leg of scope?.legs ?? []) {
    const slots: [string, (EntityResolution | null)[]][] = [
      ["region", [leg.region]],
      ["competition", [leg.competition]],
      ["team", leg.teams],
      ["player", [...leg.players, leg.subjectPlayer]],
    ];
    for (const [type, rs] of slots)
      for (const r of rs)
        if (r) cells.set(`${type}:${r.text}`, { text: r.text, type, tier: r.tier, ids: r.candidates.map((c) => c.id) });
  }

  // Per leg: what the picker chose among. The market stage is index-aligned with the plan's selectors; each filter
  // emit is one leg group's menu and names its selectors in `legs`.
  const plan = out<QueryPlan>("extract");
  const picks = out<(MarketPick | undefined)[]>("market") ?? [];
  const menus = stages.filter((e) => e.stage === "filter").map((e) => e.out as FilterResult & { legs: number[] });
  const legs = (plan?.selectors ?? []).map((s, i) => {
    const p = picks[i];
    const labels = p ? menus.find((m) => m.legs.includes(i))?.menu.map((m) => m.label) : undefined;
    return {
      phrase: s.market_concept,
      pick: p?.label ?? null,
      match: p?.match ?? null,
      matched: env?.legs[i]?.matched ?? null,
      ...(labels ? { labels } : {}),
    };
  });

  const recall = out<RecallResult>("recall");
  const llm = q.trace.flatMap((e) => (e.kind === "llm-resp" ? [e] : []));
  const outcome = q.error
    ? "error"
    : !env?.results.length
      ? env?.clarificationNeeded
        ? "clarify"
        : "empty"
      : env.clarificationNeeded || env.legs.some((l) => !l.matched)
        ? "partial"
        : "answered";

  return {
    type: "query",
    ts: new Date(q.t0).toISOString(),
    queryId: q.queryId,
    offering: OFFERING,
    query: q.query == null ? null : scrub(q.query),
    tz: q.tz ?? null,
    locale: q.locale ?? null,
    commit: process.env.COMMIT || null,
    model: EXTRACTION_MODEL,
    provider: process.env.LLM_PROVIDER === "openai" ? "openai" : "bedrock",
    extract: plan ?? null,
    ground: scope ? { sport: scope.sport, cells: [...cells.values()] } : null,
    entitiesLlm: llm.some((e) => e.tool === "settle_cells"),
    recall: recall
      ? {
          feedCalls: q.trace.filter((e) => e.kind === "kambi-req").length,
          events: recall.data.events.length,
          offers: recall.data.betOffers.length,
          truncated: recall.truncated,
          failed: recall.failed,
        }
      : null,
    legs,
    shown: env ? env.results.flatMap((r) => r.highlighted.map((h) => card(h, env.events))) : [],
    additional: env ? env.additional.map((h) => card(h, env.events)) : [],
    betslip: env?.betslip
      ? {
          odds: env.betslip.odds,
          parts: env.betslip.parts.map((p) => ({ eventId: p.eventId, outcomeIds: p.legs.map((l) => l.outcomeId) })),
        }
      : null,
    outcome,
    errorClass: q.errorClass ?? null,
    message: q.error ?? env?.clarificationNeeded ?? null,
    timing,
    llm: {
      calls: llm.length,
      inputTokens: llm.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: llm.reduce((s, e) => s + e.outputTokens, 0),
      stopReasons: llm.map((e) => e.stopReason ?? null),
    },
    cost: env?.cost ?? null,
  };
}
