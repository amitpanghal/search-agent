// Structural scorer: the TEXT-mode subset of scorer.spec.md, gradeable on the raw
// extractor output BEFORE grounding exists. Catalog-id checks are replaced by lenient
// text matching against each gold cell's accept[] (so accept[] is load-bearing here,
// not just diagnostic). Costly facets (status, sport, market-found, binding, line/odds)
// gate the pass; event_scope facets are tracked as soft notes only (E5).

import type { GoldRecord } from "./gold-record";
import type { QueryPlan } from "../resolver/schema";

// ---- text matching (lenient containment, confirmed with user) ----

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function looseMatch(text: string, accept: string[]): boolean {
  const t = normalize(text);
  if (!t) return false;
  return accept.some((a) => {
    const n = normalize(a);
    if (!n) return false;
    return t === n || t.includes(n) || n.includes(t);
  });
}

// ---- result shape ----

export type RunResult = {
  pass: boolean; // strict pass on the costly facets
  failures: string[]; // costly-facet failures (empty iff pass)
  soft: string[]; // event_scope diagnostics (non-blocking)
};

// ---- narrowed structural types (local, to avoid cross-module type identity issues) ----

type ResolvedPlan = Extract<QueryPlan, { status: "resolved" }>;
type ResolvedGold = Extract<GoldRecord["expect"], { status: "resolved" }>;
type PredSelector = ResolvedPlan["selectors"][number];
type GoldSelector = ResolvedGold["selectors"][number];

type PredLine = NonNullable<PredSelector["line"]>;
type GoldLine = NonNullable<GoldSelector["line"]>;
type OddsVal = { min?: number; max?: number };
type StageVal = { round: string | null; ordinal: "first" | "last" | null; conditional: boolean };
type TimeVal = {
  date_window: { value: string; anchor: "tournament" | "now" } | null;
  kickoff_time_of_day: string | null;
};

function lineEqual(p: PredLine | undefined, g: GoldLine | undefined): boolean {
  if (!p && !g) return true;
  if (!p || !g) return false;
  if (p.kind !== g.kind) return false;
  if (p.kind === "numeric" && g.kind === "numeric") {
    return p.value === g.value && p.direction === g.direction;
  }
  if (p.kind === "binary" && g.kind === "binary") return p.direction === g.direction;
  if (p.kind === "selection" && g.kind === "selection") return looseMatch(p.value, g.value.accept);
  return false;
}

function oddsEqual(a: OddsVal | undefined, b: OddsVal | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.min === b.min && a.max === b.max;
}

function bindingFailure(g: GoldSelector, p: PredSelector): string | null {
  if (g.subject.kind !== p.subject.kind) {
    return `binding kind: expected "${g.subject.kind}", got "${p.subject.kind}"`;
  }
  if (g.subject.kind === "player" || g.subject.kind === "team") {
    const want = g.subject.name.accept;
    if (p.subject.kind === "player" || p.subject.kind === "team") {
      if (!looseMatch(p.subject.name, want)) {
        return `binding name: expected ~${JSON.stringify(want)}, got "${p.subject.name}"`;
      }
    }
  }
  return null;
}

function stageNote(g: StageVal | null, p: StageVal | null): string | null {
  if (!g && !p) return null;
  if (!g || !p) return `stage: expected ${JSON.stringify(g)}, got ${JSON.stringify(p)}`;
  const diffs: string[] = [];
  const gr = g.round ? normalize(g.round) : null;
  const pr = p.round ? normalize(p.round) : null;
  const roundOk = gr === pr || (!!gr && !!pr && (gr.includes(pr) || pr.includes(gr)));
  if (!roundOk) diffs.push(`round ${JSON.stringify(p.round)} vs ${JSON.stringify(g.round)}`);
  if (g.ordinal !== p.ordinal) diffs.push(`ordinal ${p.ordinal} vs ${g.ordinal}`);
  if (g.conditional !== p.conditional) diffs.push(`conditional ${p.conditional} vs ${g.conditional}`);
  return diffs.length ? `stage: ${diffs.join(", ")}` : null;
}

function timeNote(g: TimeVal | null, p: TimeVal | null): string | null {
  if (!g && !p) return null;
  if (!g || !p) return `time: expected ${JSON.stringify(g)}, got ${JSON.stringify(p)}`;
  const diffs: string[] = [];
  const gw = g.date_window;
  const pw = p.date_window;
  if (!!gw !== !!pw) {
    diffs.push(`date_window ${JSON.stringify(pw)} vs ${JSON.stringify(gw)}`);
  } else if (gw && pw && gw.anchor !== pw.anchor) {
    diffs.push(`anchor ${pw.anchor} vs ${gw.anchor}`);
  }
  if (!!g.kickoff_time_of_day !== !!p.kickoff_time_of_day) {
    diffs.push(`kickoff ${JSON.stringify(p.kickoff_time_of_day)} vs ${JSON.stringify(g.kickoff_time_of_day)}`);
  }
  return diffs.length ? `time: ${diffs.join(", ")}` : null;
}

function softEventScope(g: ResolvedGold, p: ResolvedPlan): string[] {
  const soft: string[] = [];
  const ge = g.event_scope;
  const pe = p.event_scope;

  if (ge.level !== pe.level) soft.push(`level: expected ${ge.level}, got ${pe.level}`);

  for (const gt of ge.teams) {
    if (!pe.teams.some((t) => looseMatch(t, gt.accept))) {
      soft.push(`team missing: ~${JSON.stringify(gt.accept)}`);
    }
  }
  for (const pt of pe.teams) {
    if (!ge.teams.some((gt) => looseMatch(pt, gt.accept))) soft.push(`unexpected team: "${pt}"`);
  }

  if (ge.competition === null) {
    if (pe.competition !== null) soft.push(`unexpected competition: "${pe.competition}"`);
  } else if (pe.competition === null || !looseMatch(pe.competition, ge.competition.accept)) {
    soft.push(`competition: expected ~${JSON.stringify(ge.competition.accept)}, got ${JSON.stringify(pe.competition)}`);
  }

  for (const gp of ge.players) {
    const match = pe.players.find((pp) => looseMatch(pp.name, gp.name.accept));
    if (!match) soft.push(`player missing: ~${JSON.stringify(gp.name.accept)}`);
    else if (match.role !== gp.role) {
      soft.push(`player role: ~${JSON.stringify(gp.name.accept)} expected ${gp.role}, got ${match.role}`);
    }
  }

  const sn = stageNote(ge.stage, pe.stage);
  if (sn) soft.push(sn);
  const tn = timeNote(ge.time, pe.time);
  if (tn) soft.push(tn);

  return soft;
}

// ---- main entry ----

export function scoreRun(gold: GoldRecord, plan: QueryPlan): RunResult {
  const failures: string[] = [];
  const soft: string[] = [];
  const expect = gold.expect;

  // 1. status gate (hard)
  if (plan.status !== expect.status) {
    failures.push(`status: expected "${expect.status}", got "${plan.status}"`);
    return { pass: false, failures, soft };
  }

  // abstention buckets: status matched, grading ends here
  if (expect.status !== "resolved") {
    if (expect.status === "unsupported" && plan.status === "unsupported") {
      const want = expect.recognizedAs;
      const got = plan.recognizedAs;
      if (want && got && !looseMatch(got, [want]) && !looseMatch(want, [got])) {
        soft.push(`recognizedAs: expected ~"${want}", got "${got}"`);
      }
    }
    return { pass: true, failures, soft };
  }
  if (plan.status !== "resolved") {
    failures.push("internal: status narrowing failed");
    return { pass: false, failures, soft };
  }

  // 2. sport (costly)
  if (plan.sport !== expect.sport) {
    failures.push(`sport: expected "${expect.sport}", got "${plan.sport}"`);
  }

  // 3. selector pairing by market text (lenient containment vs gold accept[])
  const usedPred = new Set<number>();
  const pairs: { g: GoldSelector; p: PredSelector }[] = [];

  for (const [gi, g] of expect.selectors.entries()) {
    const acc = g.market_concept.accept;
    let matched: PredSelector | undefined;
    let matchedIdx = -1;
    for (const [pi, p] of plan.selectors.entries()) {
      if (usedPred.has(pi)) continue;
      if (acc.length > 0 && looseMatch(p.market_concept, acc)) {
        matched = p;
        matchedIdx = pi;
        break;
      }
    }
    if (matched) {
      usedPred.add(matchedIdx);
      pairs.push({ g, p: matched });
    } else {
      const why = acc.length === 0 ? " (empty accept[] — cannot text-grade; author it)" : "";
      failures.push(`market not found: gold[${gi}] (${g.subject.kind}) accept=${JSON.stringify(acc)}${why}`);
    }
  }

  for (const [pi, p] of plan.selectors.entries()) {
    if (!usedPred.has(pi)) failures.push(`unexpected market: "${p.market_concept}"`);
  }

  // 4. per aligned pair: binding (b) + line/odds (c). market-found (a) is true by pairing.
  for (const { g, p } of pairs) {
    const bind = bindingFailure(g, p);
    if (bind) failures.push(`${bind} [market "${p.market_concept}"]`);
    if (!lineEqual(p.line, g.line)) {
      failures.push(`line: "${p.market_concept}" expected ${JSON.stringify(g.line)}, got ${JSON.stringify(p.line)}`);
    }
    if (!oddsEqual(p.odds, g.odds)) {
      failures.push(`odds: "${p.market_concept}" expected ${JSON.stringify(g.odds)}, got ${JSON.stringify(p.odds)}`);
    }
  }

  // 5. event_scope (soft, tracked only)
  soft.push(...softEventScope(expect, plan));

  return { pass: failures.length === 0, failures, soft };
}
