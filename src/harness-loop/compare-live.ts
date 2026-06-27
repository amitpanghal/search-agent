// compare-live.ts — run all probe captures through the real pipeline and diff against cached envelopes.
// Usage: npx tsx --env-file=.env src/harness-loop/compare-live.ts [--batch probe]
//
// For each capture in report/<batch>/, calls runPipeline live, then prints a structured diff:
//   MATCH  — same criterion ids, same event ids, empty/non-empty agrees
//   DRIFT  — results present in both but criterion/event ids differ (e.g. odds changed, market relabelled)
//   EMPTY→RESULT / RESULT→EMPTY — one side has results, the other doesn't
//   BOTH_EMPTY — both returned nothing (fixture not in feed, clarify, etc.)

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../resolver/resolve";
import type { ResponseEnvelope } from "../resolver/execute";

const HERE = dirname(fileURLToPath(import.meta.url));

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const batchName = flag(process.argv, "--batch") ?? "probe";
const batchDir = join(HERE, "report", batchName);

interface CaptureRecord {
  id: string;
  query: string;
  category: string;
  grade: { pass: boolean; reasons: string[] };
  envelope: ResponseEnvelope;
}

function loadCaptures(): CaptureRecord[] {
  return readdirSync(batchDir)
    .filter((f) => f.endsWith(".json") && f !== "report.json")
    .sort()
    .map((f) => JSON.parse(readFileSync(join(batchDir, f), "utf8")) as CaptureRecord);
}

function criterionIds(env: ResponseEnvelope): number[] {
  return env.results.flatMap((r) => r.highlighted.map((h) => h.betOffer.criterion.id));
}

function criterionLabels(env: ResponseEnvelope): string[] {
  return env.results.flatMap((r) =>
    r.highlighted.map((h) => `${h.betOffer.criterion.label} [${h.betOffer.criterion.id}]`),
  );
}

function eventIds(env: ResponseEnvelope): number[] {
  return env.results.map((r) => r.event.id);
}

function eventNames(env: ResponseEnvelope): string[] {
  return env.results.map((r) => r.event.name);
}

function outcomeLabels(env: ResponseEnvelope): string[] {
  return env.results.flatMap((r) =>
    r.highlighted.flatMap((h) => h.outcomes.map((o) => o.label)),
  );
}

function isEmpty(env: ResponseEnvelope) {
  return env.results.length === 0;
}

function setsEqual(a: number[], b: number[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function col(c: string, s: string) { return c + s + RESET; }

const captures = loadCaptures();
console.log(`\n${BOLD}Live vs harness comparison — batch: ${batchName}${RESET}`);
console.log(`${DIM}${captures.length} queries  |  running against live API…${RESET}\n`);

let nMatch = 0, nDrift = 0, nMismatch = 0, nBothEmpty = 0;

for (const cap of captures) {
  process.stdout.write(`${DIM}[${cap.id}]${RESET} ${cap.query.slice(0, 70)}… `);

  let liveEnv: ResponseEnvelope = { summary: "", results: [], notes: [], clarificationNeeded: null };
  try {
    for await (const evt of runPipeline(cap.query)) {
      if (evt.stage === "done") liveEnv = evt.envelope;
    }
  } catch (err) {
    console.log(col(RED, "ERROR") + ` ${String(err)}`);
    nMismatch++;
    continue;
  }

  const harnessEnv = cap.envelope;
  const hEmpty = isEmpty(harnessEnv);
  const lEmpty = isEmpty(liveEnv);

  if (hEmpty && lEmpty) {
    console.log(col(DIM, "BOTH_EMPTY"));
    nBothEmpty++;
    continue;
  }
  if (hEmpty && !lEmpty) {
    console.log(col(YELLOW, "EMPTY→RESULT") + ` live returned ${liveEnv.results.length} result(s)`);
    for (const lbl of criterionLabels(liveEnv)) console.log(`  ${DIM}live:${RESET} ${lbl}`);
    nMismatch++;
    continue;
  }
  if (!hEmpty && lEmpty) {
    console.log(col(RED, "RESULT→EMPTY") + ` harness had ${harnessEnv.results.length} result(s), live returned nothing`);
    for (const lbl of criterionLabels(harnessEnv)) console.log(`  ${DIM}harness:${RESET} ${lbl}`);
    nMismatch++;
    continue;
  }

  // Both non-empty — compare criterion ids and event ids
  const hCrit = criterionIds(harnessEnv);
  const lCrit = criterionIds(liveEnv);
  const hEvt = eventIds(harnessEnv);
  const lEvt = eventIds(liveEnv);

  const critMatch = setsEqual(hCrit, lCrit);
  const evtMatch = setsEqual(hEvt, lEvt);

  if (critMatch && evtMatch) {
    // Check if odds changed (informational only)
    const hOdds = harnessEnv.results.flatMap((r) =>
      r.highlighted.flatMap((h) => h.outcomes.map((o) => o.odds)),
    );
    const lOdds = liveEnv.results.flatMap((r) =>
      r.highlighted.flatMap((h) => h.outcomes.map((o) => o.odds)),
    );
    const oddsDrifted = hOdds.some((o, i) => o !== lOdds[i]);
    if (oddsDrifted) {
      console.log(col(GREEN, "MATCH") + col(DIM, "  (odds moved)"));
    } else {
      console.log(col(GREEN, "MATCH"));
    }
    nMatch++;
  } else {
    console.log(col(YELLOW, "DRIFT"));
    if (!evtMatch) {
      console.log(`  ${DIM}events  harness:${RESET} ${eventNames(harnessEnv).join(", ")}`);
      console.log(`  ${DIM}events  live:${RESET}    ${eventNames(liveEnv).join(", ")}`);
    }
    if (!critMatch) {
      const onlyHarness = hCrit.filter((id) => !lCrit.includes(id));
      const onlyLive = lCrit.filter((id) => !hCrit.includes(id));
      if (onlyHarness.length) {
        console.log(`  ${DIM}crit only in harness:${RESET} ${criterionLabels(harnessEnv).filter((_, i) => onlyHarness.includes(hCrit[i]!)).join(", ")}`);
      }
      if (onlyLive.length) {
        console.log(`  ${DIM}crit only in live:${RESET}    ${criterionLabels(liveEnv).filter((_, i) => onlyLive.includes(lCrit[i]!)).join(", ")}`);
      }
    }
    nDrift++;
  }
}

console.log(`\n${BOLD}Summary${RESET}`);
console.log(`  ${col(GREEN, "MATCH")}       ${nMatch}`);
console.log(`  ${col(DIM, "BOTH_EMPTY")}  ${nBothEmpty}`);
console.log(`  ${col(YELLOW, "DRIFT")}       ${nDrift}`);
console.log(`  ${col(RED, "MISMATCH")}    ${nMismatch}`);
console.log(`  ${DIM}Total${RESET}       ${captures.length}\n`);
