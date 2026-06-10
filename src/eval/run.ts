// Structural eval harness (CLI).
//   npm run eval                  -> all gold records, 1x each
//   npm run eval -- --release     -> 5x each; query passes only if all 5 pass (E10) (Always ask permission before running this)
//   npm run eval -- --id g001     -> a single record
//   npm run eval -- --query "..." -> ad-hoc extraction, no grading (eyeball the extractor)
//   npm run eval -- --ground "..."-> ad-hoc market grounding, no extraction (eyeball the grounder)
//                  [--subject player|team|either_match_team|event] [--line numeric|binary|selection]
//
// Grades the extractor output on the costly structural facets and reports per-tag pass-rates +
// a ship gate (critical tags = 100%, soft tags ~90% aggregate). Exits non-zero on any critical
// miss (CI-usable). The market axis is graded by criterion id: each selector is pre-grounded
// (text -> id) before scoring (Sprint 2); the other id-graded axes still wait for grounding.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GoldRecord } from "./gold-record";
import { BEHAVIOR_TAGS, CRITICAL_TAGS, SOFT_TAGS, BEHAVIOR_TAG_IDS, type BehaviorTag } from "./behavior-tags";
import { extract, EXTRACTION_MODEL } from "../resolver/extract";
import { scoreRun, type RunResult } from "./structural-scorer";
import type { QueryPlan } from "../resolver/schema";
import { groundMarket, type GroundOpts, type GroundResult, type SubjectKind } from "../resolver/ground-market";
import { loadCatalog } from "../resolver/catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", ".."); // src/eval -> repo root (where .env lives)
const SOFT_BAR = 0.9;

type RunOutcome = { result: RunResult; plan?: QueryPlan };
type QueryReport = { rec: GoldRecord; outcomes: RunOutcome[]; passes: number; passed: boolean };
type TagStat = { total: number; passed: number };

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

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

function loadGold(): GoldRecord[] {
  const text = readFileSync(join(HERE, "gold.seed.jsonl"), "utf8");
  const out: GoldRecord[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`gold.seed.jsonl line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }
    const parsed = GoldRecord.safeParse(obj);
    if (!parsed.success) {
      throw new Error(`gold.seed.jsonl line ${i + 1}: schema error — ${parsed.error.message}`);
    }
    out.push(parsed.data);
  }
  return out;
}

function loadMeta(): { schemaVersion?: string; catalogVersion?: string } {
  try {
    return JSON.parse(readFileSync(join(HERE, "gold.meta.json"), "utf8"));
  } catch {
    return {};
  }
}

// Pre-ground each selector's text market_concept to a criterion id-set + tier so the scorer can
// grade the market axis by id under E13 (scoring stays sync). A selector that grounds to nothing
// becomes null. Abstentions have no selectors -> nothing to ground.
async function groundSelectors(plan: QueryPlan): Promise<(GroundResult | null)[] | undefined> {
  if (plan.status !== "resolved") return undefined;
  const grounded: (GroundResult | null)[] = [];
  const level = plan.event_scope.level;
  for (const sel of plan.selectors) {
    const g = await groundMarket(sel.market_concept, { subjectKind: sel.subject.kind, line: sel.line, level, period: sel.period });
    grounded.push(g.ids.length ? g : null);
  }
  return grounded;
}

async function runQuery(rec: GoldRecord, n: number): Promise<QueryReport> {
  const outcomes: RunOutcome[] = [];
  for (let r = 0; r < n; r++) {
    try {
      const plan = await extract(rec.query);
      const grounded = await groundSelectors(plan);
      outcomes.push({ result: scoreRun(rec, plan, grounded), plan });
    } catch (e) {
      outcomes.push({ result: { pass: false, failures: [`extraction error: ${(e as Error).message}`], soft: [] } });
    }
  }
  const passes = outcomes.filter((o) => o.result.pass).length;
  return { rec, outcomes, passes, passed: passes === n };
}

function indent(s: string, pad: string): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function printReport(rep: QueryReport, n: number): void {
  console.log(`[${rep.passed ? "PASS" : "FAIL"}] ${rep.rec.id} (${rep.passes}/${n})  tags: ${rep.rec.tags.join(", ")}`);
  console.log(`       ${rep.rec.query}`);

  if (!rep.passed) {
    const fails = new Set<string>();
    for (const o of rep.outcomes) for (const f of o.result.failures) fails.add(f);
    for (const f of fails) console.log(`   x ${f}`);
    const withPlan = rep.outcomes.find((o) => o.plan);
    if (withPlan?.plan) {
      console.log("   raw plan (triage):");
      console.log(indent(JSON.stringify(withPlan.plan, null, 2), "     "));
    }
  }

  const softs = new Set<string>();
  for (const o of rep.outcomes) for (const s of o.result.soft) softs.add(s);
  for (const s of softs) console.log(`   . ${s}`);
  console.log("");
}

function computeTagStats(reports: QueryReport[]): Map<BehaviorTag, TagStat> {
  const stats = new Map<BehaviorTag, TagStat>();
  for (const rep of reports) {
    for (const tag of rep.rec.tags) {
      const s = stats.get(tag) ?? { total: 0, passed: 0 };
      s.total += 1;
      if (rep.passed) s.passed += 1;
      stats.set(tag, s);
    }
  }
  return stats;
}

function pct(s: TagStat): string {
  return `${s.passed}/${s.total} (${Math.round((s.passed / s.total) * 100)}%)`;
}

function printTagSummary(stats: Map<BehaviorTag, TagStat>): void {
  console.log("Per-tag pass-rate:");
  console.log("  Critical (must be 100%):");
  for (const t of CRITICAL_TAGS) {
    const s = stats.get(t);
    if (s) console.log(`    ${t}: ${pct(s)}`);
  }
  console.log("  Soft (aggregate ~90%):");
  for (const t of SOFT_TAGS) {
    const s = stats.get(t);
    if (s) console.log(`    ${t}: ${pct(s)}`);
  }
  const uncovered = BEHAVIOR_TAG_IDS.filter((t) => !stats.has(t));
  if (uncovered.length) console.log(`  Uncovered (coverage gap): ${uncovered.join(", ")}`);
  console.log("");
}

function printShipGate(reports: QueryReport[], stats: Map<BehaviorTag, TagStat>): boolean {
  const criticalMisses: string[] = [];
  for (const t of CRITICAL_TAGS) {
    const s = stats.get(t);
    if (s && s.passed < s.total) criticalMisses.push(`${t} ${pct(s)}`);
  }

  let softPassed = 0;
  let softTotal = 0;
  for (const t of SOFT_TAGS) {
    const s = stats.get(t);
    if (!s) continue;
    softPassed += s.passed;
    softTotal += s.total;
  }
  const softRate = softTotal ? softPassed / softTotal : 1;

  const passedQueries = reports.filter((r) => r.passed).length;
  console.log(`Queries passed: ${passedQueries}/${reports.length}`);
  console.log(`Soft aggregate: ${softTotal ? `${softPassed}/${softTotal} (${Math.round(softRate * 100)}%)` : "n/a"} (bar ~${SOFT_BAR * 100}%)`);

  const gatePass = criticalMisses.length === 0;
  if (gatePass) {
    console.log("SHIP GATE: PASS (no critical-tag miss)");
    if (softRate < SOFT_BAR) console.log(`  note: soft aggregate below ${SOFT_BAR * 100}% — tracked, not blocking.`);
  } else {
    console.log("SHIP GATE: FAIL");
    console.log(`  critical misses: ${criticalMisses.join("; ")}`);
  }
  return gatePass;
}

async function adHoc(query: string): Promise<void> {
  console.log(`Query: ${query}`);
  console.log(`Model: ${EXTRACTION_MODEL}\n`);
  const plan = await extract(query);
  console.log(JSON.stringify(plan, null, 2));
}

function buildGroundOpts(subject?: string, lineKind?: string): GroundOpts {
  const opts: GroundOpts = {};
  if (subject !== undefined) {
    const valid: SubjectKind[] = ["player", "team", "either_match_team", "event"];
    if (!valid.includes(subject as SubjectKind)) {
      console.error(`--subject must be one of: ${valid.join(", ")}`);
      process.exit(2);
    }
    opts.subjectKind = subject as SubjectKind;
  }
  if (lineKind !== undefined) {
    if (lineKind === "numeric") opts.line = { kind: "numeric", value: 0, direction: "over" };
    else if (lineKind === "binary") opts.line = { kind: "binary", direction: "yes" };
    else if (lineKind === "selection") opts.line = { kind: "selection", value: "x" };
    else {
      console.error("--line must be one of: numeric, binary, selection");
      process.exit(2);
    }
  }
  return opts;
}

async function adHocGround(text: string, opts: GroundOpts): Promise<void> {
  const tags = [opts.subjectKind ? `subject=${opts.subjectKind}` : "", opts.line ? `line=${opts.line.kind}` : ""].filter(Boolean);
  console.log(`Ground: ${text}${tags.length ? `  [${tags.join(", ")}]` : ""}`);
  const r = await groundMarket(text, opts);
  if (!r.ids.length) {
    console.log(`  -> none (${r.method})`);
  } else {
    const cat = loadCatalog();
    const names = r.ids.map((id) => cat.byId.get(id)?.name ?? "?");
    const score = r.score != null ? `, score ${r.score.toFixed(3)}` : "";
    console.log(`  -> ${JSON.stringify(r.ids)}  [${names.join(", ")}]  (${r.method}/${r.tier ?? "?"}${score})`);
  }
  if (r.candidates?.length) {
    console.log("  candidates (in-bucket top-k, pre-gate):");
    for (const c of r.candidates) console.log(`    ${c.score.toFixed(3)}  ${c.id}  ${c.name}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const query = flagValue(args, "--query");
  const ground = flagValue(args, "--ground");
  const onlyId = flagValue(args, "--id");
  const release = args.includes("--release");

  // Grounding needs no LLM call, so eyeballing it does not require ANTHROPIC_API_KEY.
  if (ground !== undefined) {
    await adHocGround(ground, buildGroundOpts(flagValue(args, "--subject"), flagValue(args, "--line")));
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Export it, or copy .env.example -> .env.");
    process.exit(2);
  }

  if (query) {
    await adHoc(query);
    return;
  }

  const meta = loadMeta();
  let gold = loadGold();
  if (onlyId) gold = gold.filter((g) => g.id === onlyId);
  if (gold.length === 0) {
    console.error(onlyId ? `No gold record with id "${onlyId}".` : "No gold records found.");
    process.exit(2);
  }

  const n = release ? 5 : 1;
  console.log(`Structural eval — model ${EXTRACTION_MODEL}, ${n}x per query (temp 0)`);
  console.log(`Gold: ${gold.length} record(s) | schema ${meta.schemaVersion ?? "?"} | catalog ${meta.catalogVersion ?? "?"}`);
  console.log("Mode: GROUNDED (market axis by id; tiered, subject-filtered); other axes text vs accept[].\n");

  const reports: QueryReport[] = [];
  for (const rec of gold) {
    const rep = await runQuery(rec, n);
    reports.push(rep);
    printReport(rep, n);
  }

  const stats = computeTagStats(reports);
  printTagSummary(stats);
  const gatePass = printShipGate(reports, stats);
  process.exit(gatePass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
