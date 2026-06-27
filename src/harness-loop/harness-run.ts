// harness-run — the rig runner. Runs each batch query through the REAL runPipeline with HARNESS_DEPS (cached LLM
// steps + live-cached recall), grades the final envelope (grader.ts), and prints a per-category scoreboard.
//
//   tsx src/harness-loop/harness-run.ts --batch 001 [--limit N]
//
// An LLM cache miss aborts that query as PEND and is recorded to pending-llm.json (exit 3). Fulfil the misses with
// temp-0 Haiku subagents (write each into llm-cache/ under its key), then re-run — now hits, free. No API key.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../resolver/resolve";
import type { ResponseEnvelope } from "../resolver/execute";
import { HARNESS_DEPS } from "./pipeline-doubles";
import { CacheMiss, flushPending } from "./llm-cache";
import { grade } from "./grader";
import type { BatchQuery, GradeResult } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

function loadBatch(name: string): BatchQuery[] {
  const p = join(HERE, "batches", `batch-${name}.jsonl`);
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as BatchQuery);
}

async function drain(query: string): Promise<ResponseEnvelope> {
  let env: ResponseEnvelope | undefined;
  for await (const evt of runPipeline(query, HARNESS_DEPS)) if (evt.stage === "done") env = evt.envelope;
  return env!;
}

// When captureDir is set, freeze each query's final envelope + verdict to <dir>/<id>.json — the exact payload
// the frontend would render, for the offline screenshot suite (src/harness-loop/report/generate.ts).
async function runOne(q: BatchQuery, captureDir?: string): Promise<GradeResult> {
  try {
    const envelope = await drain(q.q);
    const result = grade(q, envelope);
    if (captureDir) {
      const record = { id: q.id, query: q.q, category: q.category, grade: { pass: result.pass, reasons: result.reasons }, envelope };
      writeFileSync(join(captureDir, `${q.id}.json`), JSON.stringify(record, null, 2));
    }
    return result;
  } catch (e) {
    if (e instanceof CacheMiss) return { id: q.id, category: q.category, pass: false, pending: true, reasons: [`LLM miss: ${e.req.kind}`], gotIds: [] };
    return { id: q.id, category: q.category, pass: false, pending: false, reasons: [`error: ${(e as Error).message}`], gotIds: [] };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const batch = flag(args, "--batch") ?? "001";
  const limit = flag(args, "--limit");
  const captureDir = flag(args, "--capture");
  if (captureDir) mkdirSync(captureDir, { recursive: true });
  let queries = loadBatch(batch);
  if (limit) queries = queries.slice(0, Number(limit));

  const results: GradeResult[] = [];
  for (const q of queries) results.push(await runOne(q, captureDir));

  for (const r of results) {
    const tag = r.pending ? "PEND" : r.pass ? "PASS" : "FAIL";
    console.log(`[${tag}] ${r.id} (${r.category})  ${r.gotIds.length ? `ids=[${r.gotIds.join(",")}] ` : ""}${r.reasons.join("; ")}`);
  }

  const scored = results.filter((r) => !r.pending);
  const pend = results.filter((r) => r.pending);
  const pass = scored.filter((r) => r.pass).length;
  console.log(`\nbatch ${batch}: scored ${pass}/${scored.length} pass${pend.length ? `  |  ${pend.length} pending (LLM cache miss)` : ""}`);

  const misses = flushPending();
  if (misses.length) {
    const byKind = misses.reduce<Record<string, number>>((a, m) => ((a[m.kind] = (a[m.kind] ?? 0) + 1), a), {});
    console.log(`${misses.length} LLM cache miss(es) -> pending-llm.json  (${Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(", ")}). Fulfil + re-run.`);
    process.exit(3); // capture incomplete (distinct from a graded failure)
  }
  process.exit(scored.length && scored.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
