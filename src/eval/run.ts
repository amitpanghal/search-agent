// Structural eval harness (CLI).
//   npm run eval                  -> all gold records, 1x each
//   npm run eval -- --runs 3      -> 3x each; query passes only if all 3 pass (the measuring default)
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
import { recoverSport } from "../resolver/recover-sport";
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

// `--from <probe.jsonl>`: replay plans already captured by `npm run probe --until=extract` instead of calling
// the model. Same scorer, same report, zero cost — this is how a baseline gets re-scored after the GOLD changes
// (only a prompt/model change needs fresh extractions).
let replay: Map<string, QueryPlan> | null = null;
function loadReplay(path: string): Map<string, QueryPlan> {
  const m = new Map<string, QueryPlan>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { query: string; trace?: { stage?: string; out?: QueryPlan }[] };
    const plan = row.trace?.find((t) => t.stage === "extract")?.out;
    if (plan) m.set(row.query, plan);
  }
  return m;
}

// Bedrock throttles a ~300-row deck: a first 8-way run lost 55 rows (18%) to "Too many requests", which scores
// as a failure and quietly poisons the baseline. Retry the throttle with backoff so a rate limit costs time,
// never a data point. Only this runner retries — the shared bedrock-call boundary is untouched.
const THROTTLE = /too many requests|throttl|rate ?limit/i;
// 8 tries ≈ 2 min of backoff. 5 was tuned against the incumbent model's quota; a model with a tighter
// per-account limit (Claude on a fresh account) blew straight through it — a first Haiku run lost 133 of 298
// rows and scored 94/298, which says nothing about the model and everything about the quota.
async function extractRetrying(query: string, tries = 8): Promise<QueryPlan> {
  for (let i = 0; ; i++) {
    try {
      return withRecoveredSport(await extract(query));
    } catch (e) {
      if (i >= tries - 1 || !THROTTLE.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i + Math.random() * 500));
    }
  }
}

// Grade what PRODUCTION produces. resolve.ts runs recoverSport() immediately after extract() — a deterministic,
// zero-LLM correction that re-homes a sport the extractor guessed wrong ("Wells vs Orolbai" -> tennis, when the
// names only ground in ufc-mma). Scoring raw extract() output marked those as sport failures even though no user
// would ever see one, which would have sent the prompt rewrite chasing entity knowledge no rule can teach.
export function withRecoveredSport(plan: QueryPlan): QueryPlan {
  const fix = recoverSport(plan);
  return fix.kind === "switch" ? { ...plan, sport: fix.sport } : plan;
}

async function runQuery(rec: GoldRecord, n: number): Promise<QueryReport> {
  const outcomes: RunOutcome[] = [];
  for (let r = 0; r < n; r++) {
    try {
      // A replayed capture is raw extract() output, so it needs the same production correction applied.
      const cached = replay?.get(rec.query);
      const plan = cached ? withRecoveredSport(cached) : await extractRetrying(rec.query);
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

// Run at most `max` extractions at once. The deck went from 18 football rows to ~300 across 37 sports, and
// sequential 1x runs put a prompt edit ~15 minutes away from its measurement — too slow to iterate against.
// Order is preserved: callers await the promises in index order, so the report still streams top-to-bottom.
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
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

// Which FACET each failure message is about. The per-tag view answers "does this row pass end to end", which
// is the ship question — but it hides a fix: teaching `combined_odds` took its facet from 6 failures to 0 while
// the tag stayed at a flat 0/6, because every one of those rows also carries `multi-leg` and fails on that.
// Tuning one rule at a time needs the narrower question: did the facet I aimed at move, and did another break?
const FACETS: [string, RegExp][] = [
  ["sport", /^sport:/],
  ["market", /^market not found|^unexpected market|^market (ambiguous|shortlist|not grounded)|^offer not surfaced|^expected-none|^marketless:/],
  ["binding", /^binding /],
  ["line", /^line:/],
  ["line_sort", /^line_sort:/],
  ["direction", /^direction:/],
  ["odds", /^odds:/],
  ["odds_sort", /^odds_sort:/],
  ["combined_odds", /^combined_odds:/],
  ["competition", /^competition:|^unexpected competition/],
  ["teams", /^team missing|^unexpected team/],
  ["players", /^player missing|^player role/],
  ["time", /^time:/],
  ["level", /^level:/],
  ["stage", /^stage:/],
  ["play_state", /^play_state:/],
  ["error", /^extraction error/],
];

function printFacetSummary(reports: QueryReport[]): void {
  const counts = new Map<string, number>();
  for (const rep of reports) {
    const seen = new Set<string>(); // one row counts once per facet, however many legs repeat the message
    for (const o of rep.outcomes) {
      for (const f of o.result.failures) {
        const facet = FACETS.find(([, re]) => re.test(f))?.[0] ?? "other";
        if (seen.has(facet)) continue;
        seen.add(facet);
        counts.set(facet, (counts.get(facet) ?? 0) + 1);
      }
    }
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  console.log(`Rows failing, by facet (of ${reports.length}):`);
  console.log(rows.length ? rows.map(([f, n]) => `  ${f.padEnd(14)} ${n}`).join("\n") : "  (none)");
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
  const from = flagValue(args, "--from");
  if (from) replay = loadReplay(from);

  if (!replay && (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.BEDROCK_MODEL)) {
    console.error("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and BEDROCK_MODEL must be set. Export them, or copy .env.example -> .env.");
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

  // Repeats per query; a row passes only if ALL runs pass. The extractor is genuinely noisy run-to-run
  // (two identical 1x runs of this gate gave 6/11 and 5/11), so a single run can't tell a prompt delta from
  // a coin flip. `--runs 3` is the measuring default for the tuning gold; holdout stays 1x; `--release` (5x)
  // is the final sign-off.
  const n = replay ? 1 : Number(flagValue(args, "--runs")) || (release ? 5 : 1);
  console.log(replay ? `Structural eval — REPLAY of ${from} (${replay.size} captured plans, no model call)` : `Structural eval — model ${EXTRACTION_MODEL}, ${n}x per query (temp 0)`);
  console.log(`Gold: ${gold.length} record(s) | schema ${meta.schemaVersion ?? "?"} | catalog ${meta.catalogVersion ?? "?"}`);
  console.log("Mode: TEXT market axis (extraction); criterion-id resolution graded by the live market gate.\n");

  // The market/extractor ship gate runs the LLM on gradeMarket rows; pure-scope rows (gradeMarket:false)
  // are graded only by the deterministic entity gate below.
  // Replay grades exactly the rows the capture covers — a gold row the sweep never ran is out of scope for it,
  // not a failure of the extractor.
  const marketGold = gold.filter((g) => g.gradeMarket !== false && (!replay || replay.has(g.query)));
  const limit = limiter(Number(flagValue(args, "--jobs")) || 4);
  const pending = marketGold.map((rec) => limit(() => runQuery(rec, n)));
  const reports: QueryReport[] = [];
  for (const p of pending) {
    const rep = await p;
    reports.push(rep);
    printReport(rep, n);
  }

  const stats = computeTagStats(reports);
  printTagSummary(stats);
  printFacetSummary(reports);
  const gatePass = printShipGate(reports, stats);

  // Separate deterministic grounder gate (no LLM): entity grounding graded on the gold's own scope text,
  // region fed as given. Independent of the extractor/market ship gate above; the run fails if either gate fails.
  console.log("");
  const entity = gradeAll(gold);
  printEntityReport(entity);

  // Live market-resolution gate: resolve each gold `id` cell against the captured snapshot menu and assert the
  // pick is exact on a gold criterion id (market-resolve-gate.ts). Replaces the old disambiguator/marketIds
  // replay — market is resolved post-fetch now. Independent of the gates above.
  // Replay has no model, and this gate resolves markets LIVE against the snapshot menu — skip it rather than
  // spend on a stage the replayed capture says nothing about.
  console.log("");
  const market = replay ? { pass: true, lines: ["Market-resolution gate: SKIPPED (--from replay)"] } : await runMarketResolveGate(gold);
  for (const l of market.lines) console.log(l);

  process.exit(gatePass && entity.pass && market.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
