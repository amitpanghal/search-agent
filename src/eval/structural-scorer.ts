// Structural scorer for scorer.spec.md's costly facets (status, sport, market-found, binding,
// line/odds); event_scope facets are tracked as soft notes only (E5).
//
// The market axis grades in one of two modes:
//   - TEXT (Sprint 1, default): lenient text containment of `market_concept` vs each gold cell's
//     accept[] (so accept[] is load-bearing, not just diagnostic).
//   - ID (Sprint 3 E13, when `grounded` is supplied): the harness pre-grounds each selector to a
//     tiered id-set; pairing + market-found pass iff the gold id(s) are *contained* in the returned
//     ids AND the tier is clean (confident|variants). A containing-but-clarify (`ambiguous` near-tie or
//     `shortlist` recall-floor) result is an "ask the user" miss — failure, never a green pass
//     (containment alone is deliberately not enough).
//   - OFFER (an `offer` gold cell, ID mode): the stated subject has NO exact market, so the *expected*
//     outcome is a `shortlist` that surfaces the real alternatives (g001's "Bruno corners" — a player
//     with no corners-count market — offers the player corner markets). Passes iff the grounding is a
//     `shortlist` containing the offer set: here a shortlist is the RIGHT answer, not a clarify-miss.
// Everything else (binding, line, odds, event_scope) is text in both modes.

import type { GoldRecord } from "./gold-record";
import type { QueryPlan } from "../resolver/schema";

// The market-grounding shape the ID-mode market axis consumes. Formerly imported from ground-market.ts,
// deleted at the Phase 6 cut (market is now resolved post-fetch). The type is relocated here, its sole
// consumer, so the ID-mode block keeps compiling. There is no live producer today: run.ts grades the market
// axis in TEXT mode, and criterion-id resolution is graded by the separate live gate (market-resolve-gate.ts);
// `grounded` is the optional hook that keeps the ID-mode logic available.
export type GroundResult = {
  ids: number[]; // [] iff method is "none"
  method: string; // "none" => the leg abstained
  tier?: "confident" | "variants" | "ambiguous" | "shortlist"; // present iff ids.length > 0; clean = confident|variants
};

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
  fixture_pick?: { order: "earliest" | "latest"; count: number } | null;
};

function lineEqual(p: PredLine | undefined, g: GoldLine | undefined): boolean {
  if (p === undefined && g === undefined) return true;
  if (p === undefined || g === undefined) return false;
  // NUMBER rung -> exact value; STRING named pick -> loose accept-list match (gold holds a Grounded cell).
  if (typeof p === "number") return typeof g === "number" && p === g;
  return typeof g !== "number" && looseMatch(p, g.accept);
}

function oddsEqual(a: OddsVal | undefined, b: OddsVal | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.min === b.min && a.max === b.max;
}

// Grounded market axis (E13 containment): true iff every gold id is present in the returned set.
// A single gold id normalizes to [id]; a `variants` return (multiple ids) still passes as long as it
// *contains* the gold id(s) — this is how the side-split pair {1001159967,1001159633} passes. The
// tier check (clean vs ambiguous) is the caller's; containment alone is deliberately not enough (an
// ambiguous tie that happens to contain the gold id must not score green).
export function idsContainGold(pred: number[] | null, gold: number | number[]): boolean {
  if (!pred) return false;
  const want = Array.isArray(gold) ? gold : [gold];
  const have = new Set(pred);
  return want.every((id) => have.has(id));
}

function bindingFailure(g: GoldSelector, p: PredSelector): string | null {
  if (g.subject.kind !== p.subject.kind) {
    return `binding kind: expected "${g.subject.kind}", got "${p.subject.kind}"`;
  }
  if (g.subject.kind === "player" || g.subject.kind === "team") {
    const want = g.subject.name.accept;
    if (p.subject.kind === "player" || p.subject.kind === "team") {
      if (!looseMatch(p.subject.name ?? "", want)) {
        return `binding name: expected ~${JSON.stringify(want)}, got "${p.subject.name ?? "(none)"}"`;
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
  const gf = g.fixture_pick ?? null;
  const pf = p.fixture_pick ?? null;
  if (!!gf !== !!pf || (gf && pf && (gf.order !== pf.order || gf.count !== pf.count))) {
    diffs.push(`fixture_pick ${JSON.stringify(pf)} vs ${JSON.stringify(gf)}`);
  }
  return diffs.length ? `time: ${diffs.join(", ")}` : null;
}

// All event_scope diffs, tagged by facet. On a market `resolved` plan every diff is a soft note (the
// market id is the costly facet); on a marketless `main`-sentinel plan the event_scope IS the answer,
// so the fixture-selecting facets are promoted to hard failures (decision 24 / Option A).
type ScopeFacet = "level" | "teams" | "competition" | "players" | "stage" | "time" | "play_state";
// play_state stays OUT of the hard set: even a marketless "live markets" query keeps it soft (like level).
const HARD_FIXTURE_FACETS = new Set<ScopeFacet>(["teams", "stage", "time"]);

// A marketless plan/gold is the lone `main` sentinel selector (decision 24): exactly one selector,
// concept "main" (gold encodes it as {main:true}). Detecting it on both sides lets the scorer grade
// this case the way the former `fixture_lookup` status did — the event_scope IS the deliverable.
function isGoldMarketless(e: ResolvedGold): boolean {
  return e.selectors.length === 1 && "main" in e.selectors[0]!.market_concept;
}
function isPlanMarketless(p: ResolvedPlan): boolean {
  return p.selectors.length === 1 && p.selectors[0]!.market_concept === "main";
}

function scopeDiffs(
  ge: ResolvedGold["selectors"][number]["scope"],
  pe: ResolvedPlan["selectors"][number]["scope"],
): { facet: ScopeFacet; msg: string }[] {
  const out: { facet: ScopeFacet; msg: string }[] = [];

  if (ge.level !== pe.level) out.push({ facet: "level", msg: `level: expected ${ge.level}, got ${pe.level}` });

  for (const gt of ge.teams) {
    if (!pe.teams.some((t) => looseMatch(t, gt.accept))) {
      out.push({ facet: "teams", msg: `team missing: ~${JSON.stringify(gt.accept)}` });
    }
  }
  for (const pt of pe.teams) {
    if (!ge.teams.some((gt) => looseMatch(pt, gt.accept))) out.push({ facet: "teams", msg: `unexpected team: "${pt}"` });
  }

  if (ge.competition === null) {
    if (pe.competition !== null) out.push({ facet: "competition", msg: `unexpected competition: "${pe.competition}"` });
  } else if (pe.competition === null || !looseMatch(pe.competition, ge.competition.accept)) {
    out.push({ facet: "competition", msg: `competition: expected ~${JSON.stringify(ge.competition.accept)}, got ${JSON.stringify(pe.competition)}` });
  }

  for (const gp of ge.players) {
    const match = pe.players.find((pp) => looseMatch(pp.name, gp.name.accept));
    if (!match) out.push({ facet: "players", msg: `player missing: ~${JSON.stringify(gp.name.accept)}` });
    else if (match.role !== gp.role) {
      out.push({ facet: "players", msg: `player role: ~${JSON.stringify(gp.name.accept)} expected ${gp.role}, got ${match.role}` });
    }
  }

  const sn = stageNote(ge.stage, pe.stage);
  if (sn) out.push({ facet: "stage", msg: sn });
  const tn = timeNote(ge.time, pe.time);
  if (tn) out.push({ facet: "time", msg: tn });

  if (ge.play_state !== pe.play_state) {
    out.push({ facet: "play_state", msg: `play_state: expected ${ge.play_state}, got ${pe.play_state}` });
  }

  return out;
}

// ---- main entry ----

export function scoreRun(
  gold: GoldRecord,
  plan: QueryPlan,
  grounded?: (GroundResult | null)[],
): RunResult {
  const failures: string[] = [];
  const soft: string[] = [];
  const expect = gold.expect;

  // No status gate: the extractor always resolves (it never abstains — an unsupported sport fails downstream
  // at grounding, not here). `sport` is graded loosely below (free text, any sport).

  // marketless sentinel (decision 24): a query naming no market resolves to a single
  // { subject: event, market_concept: "main" } selector (gold encodes it {main:true}). Grade it like
  // the former fixture_lookup — the event_scope IS the deliverable, so fixture-selecting facets
  // (teams/stage/time) are HARD; sport stays costly; the plan must itself be the lone `main` selector
  // (a fabricated market or extra selector here is the Option-A failure nothing downstream catches).
  if (isGoldMarketless(expect)) {
    if (!looseMatch(plan.sport, [expect.sport])) failures.push(`sport: expected ~"${expect.sport}", got "${plan.sport}"`);
    if (!isPlanMarketless(plan)) {
      failures.push(`marketless: expected a single "main" selector, got ${JSON.stringify(plan.selectors.map((s) => s.market_concept))}`);
    }
    for (const d of scopeDiffs(expect.selectors[0]!.scope, plan.selectors[0]!.scope)) {
      (HARD_FIXTURE_FACETS.has(d.facet) ? failures : soft).push(d.msg);
    }
    return { pass: failures.length === 0, failures, soft };
  }

  // 2. sport (costly) — loose text match (free-text sport, any sport; case/synonym-tolerant)
  if (!looseMatch(plan.sport, [expect.sport])) {
    failures.push(`sport: expected ~"${expect.sport}", got "${plan.sport}"`);
  }

  // 3. selector pairing + "market found". In ID mode (grounded supplied) a pair requires the gold
  // id(s) to be *contained* in a selector's returned ids AND a clean tier (confident|variants), per
  // E13; a containing-but-clarify (`ambiguous`|`shortlist`) selector is an "ask the user" miss (never green).
  // Text mode pairs by Sprint-1 lenient text vs gold accept[]. Binding/line/odds (step 4) run on the
  // pairs this produces.
  const idMode = grounded !== undefined;
  const usedPred = new Set<number>();
  const pairs: { g: GoldSelector; p: PredSelector }[] = [];

  for (const [gi, g] of expect.selectors.entries()) {
    const mc = g.market_concept;
    // exactly one of id|offer|none per the schema: offer => "no exact market, surface alternatives";
    // none => "no market and nothing to surface, must abstain (method none)".
    const offer: number[] | null = "offer" in mc ? mc.offer : null;
    const wantIds: number[] | null = "id" in mc ? (Array.isArray(mc.id) ? mc.id : [mc.id]) : null;
    const isNone = "none" in mc;
    let matched: PredSelector | undefined; // clean pair: contains gold id(s) + clean tier, or text-matched
    let matchedIdx = -1;
    let clarifyIdx = -1; // contains gold id(s) but tier is ambiguous|shortlist -> tracked miss, never green
    for (const [pi, p] of plan.selectors.entries()) {
      if (usedPred.has(pi)) continue;
      if (idMode) {
        const gr = grounded[pi];
        if (isNone) {
          // NONE outcome: pair by text, pass iff this leg ABSTAINED — id-less (groundPlan's perSelector nulls
          // every id-less leg, so a `none` reads as null here), method "none", or empty ids.
          if (mc.accept.length > 0 && looseMatch(p.market_concept, mc.accept) && (!gr || gr.method === "none" || gr.ids.length === 0)) {
            matched = p;
            matchedIdx = pi;
            break;
          }
          continue;
        }
        if (!gr) continue;
        if (offer) {
          // OFFER outcome: a market the stated subject doesn't have must be SURFACED as a `shortlist`
          // (clarify with the real alternatives), never confidently guessed. Here a shortlist is the pass.
          if (gr.tier === "shortlist" && idsContainGold(gr.ids, offer)) {
            matched = p;
            matchedIdx = pi;
            break;
          }
          continue;
        }
        if (!idsContainGold(gr.ids, wantIds!)) continue; // wantIds non-null here (offer === null)
        if (gr.tier !== "confident" && gr.tier !== "variants") {
          if (clarifyIdx < 0) clarifyIdx = pi; // ambiguous|shortlist: remember, keep looking for a clean-tier hit
          continue;
        }
      } else if (!(mc.accept.length > 0 && looseMatch(p.market_concept, mc.accept))) {
        continue;
      }
      matched = p;
      matchedIdx = pi;
      break;
    }
    if (matched) {
      usedPred.add(matchedIdx);
      pairs.push({ g, p: matched });
    } else if (idMode && offer) {
      failures.push(`offer not surfaced: gold[${gi}] (${g.subject.kind}) expected a shortlist offering ${JSON.stringify(offer)}`);
    } else if (idMode && isNone) {
      failures.push(`expected-none: gold[${gi}] (${g.subject.kind}) "${mc.accept[0] ?? g.subject.kind}" should ground to nothing (abstain), but it didn't`);
    } else if (idMode && clarifyIdx >= 0) {
      usedPred.add(clarifyIdx); // consume it so it isn't double-reported as an unexpected market
      const gr = grounded[clarifyIdx];
      failures.push(
        `market ${gr?.tier}: gold[${gi}] (${g.subject.kind}) id ${JSON.stringify(wantIds)} ⊆ ${JSON.stringify(gr?.ids ?? [])} but tier=${gr?.tier} (clarify — not a pass)`,
      );
    } else if (idMode) {
      failures.push(`market not grounded: gold[${gi}] (${g.subject.kind}) expected id ${JSON.stringify(wantIds)}`);
    } else {
      const acc = mc.accept;
      const why = acc.length === 0 ? " (empty accept[] — cannot text-grade; author it)" : "";
      failures.push(`market not found: gold[${gi}] (${g.subject.kind}) accept=${JSON.stringify(acc)}${why}`);
    }
  }

  for (const [pi, p] of plan.selectors.entries()) {
    if (usedPred.has(pi)) continue;
    if (idMode) {
      // A pred that grounded to `none` is already implied by the gold-side "not grounded"
      // failures; only a pred that grounded to a real-but-unwanted id adds new information.
      const got = grounded[pi]?.ids ?? null;
      if (got && got.length) failures.push(`unexpected market: "${p.market_concept}" grounded ${JSON.stringify(got)}`);
    } else {
      failures.push(`unexpected market: "${p.market_concept}"`);
    }
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
    // odds_sort: selector facet, hard like odds (both undefined -> equal -> no-op on existing rows).
    if (p.odds_sort !== g.odds_sort) {
      failures.push(`odds_sort: "${p.market_concept}" expected ${JSON.stringify(g.odds_sort)}, got ${JSON.stringify(p.odds_sort)}`);
    }
  }

  // 5. scope (soft, tracked only — on a market query the market id is the costly facet). Migrated golds repeat
  // scope per leg, so leg 0's scope is the representative diff (per-leg-pair diffs are a later refinement).
  soft.push(...scopeDiffs(expect.selectors[0]!.scope, plan.selectors[0]!.scope).map((d) => d.msg));

  return { pass: failures.length === 0, failures, soft };
}
