// Structural eval harness (CLI).
//   npm run eval                  -> all gold records, 1x each
//   npm run eval -- --release     -> 5x each; query passes only if all 5 pass (E10) (Always ask permission before running this)
//   npm run eval -- --id g001     -> a single record
//   npm run eval -- --query "..." -> ad-hoc extraction, no grading (eyeball the extractor)
//
// Grades the raw extractor output on the costly structural facets and reports per-tag
// pass-rates + a ship gate (critical tags = 100%, soft tags ~90% aggregate). Exits
// non-zero on any critical miss (CI-usable). The id-graded axes wait for grounding.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GoldRecord } from "./gold-record";
import { BEHAVIOR_TAGS, CRITICAL_TAGS, SOFT_TAGS, BEHAVIOR_TAG_IDS, type BehaviorTag } from "./behavior-tags";
import { extract, EXTRACTION_MODEL } from "../resolver/extract";
import { scoreRun, type RunResult } from "./structural-scorer";
import type { QueryPlan } from "../resolver/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
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

async function runQuery(rec: GoldRecord, n: number): Promise<QueryReport> {
  const outcomes: RunOutcome[] = [];
  for (let r = 0; r < n; r++) {
    try {
      const plan = await extract(rec.query);
      outcomes.push({ result: scoreRun(rec, plan), plan });
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

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const query = flagValue(args, "--query");
  const onlyId = flagValue(args, "--id");
  const release = args.includes("--release");

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
  console.log("Mode: STRUCTURAL (text vs accept[]); id-graded axes deferred to grounding.\n");

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
