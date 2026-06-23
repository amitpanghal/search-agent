// Scope-grounding scorer — the SEPARATE deterministic grounder gate (no LLM). For each gold with entity
// cells, it builds a synthetic plan from the gold's OWN entity text (so a flaky extractor LLM can't redden
// a grounder test — exactly the "region fed as given" principle, extended to all scope entities), runs the
// real `groundScope` cascade, and grades each cell two ways:
//   - recall@k:            the gold id(s) appear in the returned candidate set.
//   - confident-precision: when the grounder returns a CLEAN tier (confident|variants), it must contain the
//                          gold id (a confident-WRONG entity is the dangerous miss — always a hard fail).
// A gold cell may declare an expected clarify tier (ambiguous|shortlist) for a genuinely under-specified
// entity (bare "World Cup"): there the right answer is the grounder SURFACING that ambiguity with the gold
// id(s) recalled — a confident guess would be wrong. The LLM disambiguator (which settles a clarify) is
// out of this gate, so a correctly-surfaced clarify PASSES on recall.

import type { GoldRecord } from "./gold-record";
import type { QueryPlan } from "../resolver/schema";
import { groundScope, type EntityResolution, type ScopeTier } from "../resolver/ground-scope";

export type EntityType = "region" | "competition" | "team" | "player";

export type EntityGrade = {
  rec: string; // gold record id
  type: EntityType;
  text: string;
  goldIds: number[];
  expectedTier: ScopeTier;
  gotTier: ScopeTier;
  candIds: number[];
  recall: boolean; // all gold ids in candidates
  cleanTier: boolean; // got confident|variants
  pass: boolean;
  reason?: string;
};

type GoldScope = GoldRecord["expect"]["event_scope"];
type GroundedCell = { id: number | number[]; accept: string[]; tier?: ScopeTier };

const idsOf = (cell: GroundedCell): number[] => (Array.isArray(cell.id) ? cell.id : [cell.id]);
const textOf = (cell: GroundedCell): string => cell.accept[0] ?? "";

// Build a QueryPlan straight from the gold's entity text — the deterministic input to groundScope.
function syntheticPlan(es: GoldScope): QueryPlan {
  return {
    status: "resolved",
    sport: "FOOTBALL",
    event_scope: {
      teams: es.teams.map(textOf),
      players: es.players.map((p) => ({ name: textOf(p.name), role: p.role })),
      competition: es.competition ? textOf(es.competition) : null,
      region: null, // fed via opts.region below (region-as-given)
      level: es.level,
      stage: es.stage,
      time: es.time ? { ...es.time, fixture_pick: null } : null, // gold mirror predates fixture_pick; default null

      play_state: null, // scope rows don't exercise play_state; fixed null
    },
    selectors: [{ subject: { kind: "event" }, market_concept: "main" }],
  };
}

function gradeCell(rec: string, type: EntityType, cell: GroundedCell, res: EntityResolution): EntityGrade {
  const goldIds = idsOf(cell);
  const expectedTier = cell.tier ?? "confident";
  const candIds = res.candidates.map((c) => c.id);
  const recall = goldIds.every((id) => candIds.includes(id));
  const cleanTier = res.tier === "confident" || res.tier === "variants";

  let pass: boolean;
  let reason: string | undefined;
  if (expectedTier === "confident" || expectedTier === "variants") {
    pass = cleanTier && recall;
    if (!cleanTier) reason = `expected a clean tier, got ${res.tier}`;
    else if (!recall) reason = `confident-WRONG: ${JSON.stringify(candIds)} ⊉ gold ${JSON.stringify(goldIds)}`;
  } else {
    const clarify = res.tier === "ambiguous" || res.tier === "shortlist";
    pass = clarify && recall;
    if (!clarify) reason = `expected a clarify (${expectedTier}), got ${res.tier}`;
    else if (!recall) reason = `recall miss: ${JSON.stringify(candIds)} ⊉ gold ${JSON.stringify(goldIds)}`;
  }
  return { rec, type, text: textOf(cell), goldIds, expectedTier, gotTier: res.tier, candIds, recall, cleanTier, pass, reason };
}

// Grade every entity cell of one gold record. Empty if the record carries no scope entities.
export function gradeScope(gold: GoldRecord): EntityGrade[] {
  const es = gold.expect.event_scope;
  const hasEntities = es.region != null || es.competition != null || es.teams.length > 0 || es.players.length > 0;
  if (!hasEntities) return [];

  const regionText = es.region ? textOf(es.region) : undefined;
  const resolved = groundScope(syntheticPlan(es), { region: regionText });
  const unit = resolved.units[0]!;
  const grades: EntityGrade[] = [];

  if (es.region && resolved.region) grades.push(gradeCell(gold.id, "region", es.region, resolved.region));
  if (es.competition && resolved.competition) grades.push(gradeCell(gold.id, "competition", es.competition, resolved.competition));
  es.teams.forEach((t, i) => { if (unit.teams[i]) grades.push(gradeCell(gold.id, "team", t, unit.teams[i]!)); });
  es.players.forEach((p, i) => { if (unit.players[i]) grades.push(gradeCell(gold.id, "player", p.name, unit.players[i]!)); });
  return grades;
}

// ---- aggregate report over a gold set ----
export type EntityReport = { grades: EntityGrade[]; pass: boolean };

export function gradeAll(gold: GoldRecord[]): EntityReport {
  const grades = gold.flatMap(gradeScope);
  return { grades, pass: grades.every((g) => g.pass) };
}

export function printEntityReport(report: EntityReport): void {
  const { grades } = report;
  console.log("Entity grounding (deterministic grounder gate; region fed as given):");
  if (!grades.length) {
    console.log("  (no entity gold cells)\n");
    return;
  }
  const types: EntityType[] = ["region", "competition", "team", "player"];
  for (const t of types) {
    const cells = grades.filter((g) => g.type === t);
    if (!cells.length) continue;
    const recall = cells.filter((g) => g.recall).length;
    const clean = cells.filter((g) => g.cleanTier);
    const cleanOk = clean.filter((g) => g.recall).length;
    const prec = clean.length ? `${cleanOk}/${clean.length} (${Math.round((cleanOk / clean.length) * 100)}%)` : "n/a";
    console.log(`  ${t.padEnd(11)} recall@k ${recall}/${cells.length} (${Math.round((recall / cells.length) * 100)}%) | confident-precision ${prec}`);
  }
  const fails = grades.filter((g) => !g.pass);
  if (fails.length) {
    console.log("  failures:");
    for (const f of fails) console.log(`    x ${f.rec} ${f.type} "${f.text}" [expect ${f.expectedTier}, got ${f.gotTier}]: ${f.reason}`);
  }
  console.log(report.pass ? "ENTITY GATE: PASS (no recall miss / confident-wrong)\n" : "ENTITY GATE: FAIL\n");
}
