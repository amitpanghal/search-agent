// Structural eval harness (CLI).
//   npm run eval                  -> all gold records, 1x each
//   npm run eval -- --release     -> 5x each; query passes only if all 5 pass (E10) (Always ask permission before running this)
//   npm run eval -- --id g001     -> a single record
//   npm run eval -- --last 10     -> only the last N gold records (by file order)
//   npm run eval -- --query "..." -> ad-hoc extraction, no grading (eyeball the extractor)
//   npm run eval -- --ground "..."-> ad-hoc market RESOLVE vs the captured snapshot menu (eyeball the resolver)
//                  [--grain match|competition]
//
// Grades the extractor output on the costly structural facets and reports per-tag pass-rates +
// a ship gate (critical tags = 100%, soft tags ~90% aggregate). Exits non-zero on any critical
// miss (CI-usable). The market axis is graded by TEXT here (the extractor's job is the concept wording);
// criterion-id resolution moved post-fetch and is graded by the separate live gate (market-resolve-gate.ts).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GoldRecord, loadGold } from "./gold-record";
import { BEHAVIOR_TAGS, CRITICAL_TAGS, SOFT_TAGS, BEHAVIOR_TAG_IDS, type BehaviorTag } from "./behavior-tags";
import { extract, EXTRACTION_MODEL } from "../resolver/extract";
import { scoreRun, type RunResult } from "./structural-scorer";
import { gradeAll, printEntityReport } from "./scope-scorer";
import { runMarketResolveGate, resolveEyeball } from "./market-resolve-gate";
import type { QueryPlan } from "../resolver/schema";

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
      // TEXT mode (no `grounded`): the extractor gate grades the concept WORDING; criterion-id resolution is
      // graded post-fetch by the separate live market gate below.
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
  // `scope-*` tags are graded by the separate deterministic entity gate (not this LLM market gate), so
  // their absence here is expected — exclude them from the market-gate coverage-gap report.
  const uncovered = BEHAVIOR_TAG_IDS.filter((t) => !stats.has(t) && !t.startsWith("scope-"));
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
  const ground = flagValue(args, "--ground");
  const onlyId = flagValue(args, "--id");
  const last = flagValue(args, "--last");
  const release = args.includes("--release");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Export it, or copy .env.example -> .env.");
    process.exit(2);
  }

  // Eyeball the post-fetch resolver: resolve a concept against the captured snapshot menu (needs the LLM key).
  if (ground !== undefined) {
    await resolveEyeball(ground, flagValue(args, "--grain") === "competition" ? "competition" : "match");
    return;
  }

  if (query) {
    await adHoc(query);
    return;
  }

  const meta = loadMeta();
  let gold = loadGold();
  if (onlyId) gold = gold.filter((g) => g.id === onlyId);
  if (last) gold = gold.slice(-Number(last));
  if (gold.length === 0) {
    console.error(onlyId ? `No gold record with id "${onlyId}".` : "No gold records found.");
    process.exit(2);
  }

  const n = release ? 5 : 1;
  console.log(`Structural eval — model ${EXTRACTION_MODEL}, ${n}x per query (temp 0)`);
  console.log(`Gold: ${gold.length} record(s) | schema ${meta.schemaVersion ?? "?"} | catalog ${meta.catalogVersion ?? "?"}`);
  console.log("Mode: TEXT market axis (extraction); criterion-id resolution graded by the live market gate.\n");

  // The market/extractor ship gate runs the LLM on gradeMarket rows; pure-scope rows (gradeMarket:false)
  // are graded only by the deterministic entity gate below.
  const marketGold = gold.filter((g) => g.gradeMarket !== false);
  const reports: QueryReport[] = [];
  for (const rec of marketGold) {
    const rep = await runQuery(rec, n);
    reports.push(rep);
    printReport(rep, n);
  }

  const stats = computeTagStats(reports);
  printTagSummary(stats);
  const gatePass = printShipGate(reports, stats);

  // Separate deterministic grounder gate (no LLM): entity grounding graded on the gold's own scope text,
  // region fed as given. Independent of the extractor/market ship gate above; the run fails if either gate fails.
  console.log("");
  const entity = gradeAll(gold);
  printEntityReport(entity);

  // Live market-resolution gate: resolve each gold `id` cell against the captured snapshot menu and assert the
  // pick is exact on a gold criterion id (market-resolve-gate.ts). Replaces the old disambiguator/marketIds
  // replay — market is resolved post-fetch now. Independent of the gates above.
  console.log("");
  const market = await runMarketResolveGate(gold);
  for (const l of market.lines) console.log(l);

  process.exit(gatePass && entity.pass && market.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
