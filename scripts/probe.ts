// probe — run one or many queries through the LIVE prod pipeline (runPipeline) and dump a per-stage +
// per-API trace. The go-to tool for investigating WHY a query resolved the way it did.
//
//   npm run probe -- "Arsenal to win" "over 2.5 goals"     # both queries, summary log
//   npm run probe -- --file queries.txt --log=full         # one query per line, raw payloads
//   npm run probe -- "Kane top scorer" --until=ground      # stop after grounding (no Kambi, no paid market LLM)
//   npm run probe -- "..." --apis=kambi --out run.jsonl    # only feed traffic, also save the full trace
//
// Flags: --log=silent|summary|full (default summary) · --apis=llm,kambi (default both) ·
//   --until=extract|ground|entities|recall · --out FILE (full JSONL trace) · --full-payloads · --fail-fast ·
//   --tz ZONE (IANA zone for time windows; defaults to this machine's zone — pass UTC to reproduce no-tz clients)
//
// LIVE = paid (Bedrock + Kambi). Run via `npm run probe` so --env-file=.env supplies AWS creds + BEDROCK_MODEL.

import { parseArgs } from "node:util";
import { readFileSync, appendFileSync } from "node:fs";
import { runPipeline } from "../src/resolver/resolve";
import { traceStore, type TraceEvent } from "../src/resolver/trace";
import type { ResponseEnvelope } from "../src/resolver/execute";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    log: { type: "string", default: "summary" },
    apis: { type: "string", default: "llm,kambi" },
    until: { type: "string" },
    out: { type: "string" },
    "full-payloads": { type: "boolean", default: false },
    "fail-fast": { type: "boolean", default: false },
    selftest: { type: "boolean", default: false },
    tz: { type: "string", default: Intl.DateTimeFormat().resolvedOptions().timeZone },
  },
});

const UNTIL = ["extract", "ground", "entities", "recall"]; // the pre-paid-call stop points runPipeline honours
if (values.until && !UNTIL.includes(values.until)) { console.error(`--until must be one of: ${UNTIL.join(", ")}`); process.exit(1); }
const level = values.log as "silent" | "summary" | "full";
const apis = new Set(values.apis!.split(",").map((s) => s.trim()));
const full = values["full-payloads"]!;
const stageOf: Record<string, string> = { emit_query_plan: "extract", settle_cells: "entities", pick: "market" };
const BASE = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi";

// JSON with big arrays capped — a 2000-betoffer menu becomes 3 items + a marker, so a stage one-liner stays a
// line — and circular refs downgraded to a marker instead of throwing.
const safe = (o: unknown, whole = false): string => {
  try {
    return whole ? JSON.stringify(o, null, 2)
      : JSON.stringify(o, (_k, v) => (Array.isArray(v) && v.length > 6 ? [...v.slice(0, 3), `…+${v.length - 3}`] : v));
  } catch { return "[unserializable]"; }
};
const indent = (s: string, p = "    "): string => s.split("\n").map((l) => p + l).join("\n");
const shortUrl = (u: string): string => u.replace(BASE, "…");

// Offline self-check of the two non-trivial bits (array-capping + circular survival). No pipeline, no paid call.
if (values.selftest) {
  const capped = safe({ a: Array.from({ length: 100 }, (_, i) => i) });
  console.assert(capped.includes("…+97"), "safe() should cap big arrays");
  const circ: Record<string, unknown> = {}; circ.self = circ;
  console.assert(safe(circ) === "[unserializable]", "safe() should survive circular refs");
  console.log("probe self-check OK");
  process.exit(0);
}

const queries = values.file
  ? readFileSync(values.file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : positionals;
if (!queries.length) {
  console.error('usage: npm run probe -- "query" ["query2" …] [--file q.txt] [--log=silent|summary|full]\n' +
    "        [--apis=llm,kambi] [--until=extract|ground|entities|recall] [--out FILE] [--full-payloads] [--fail-fast]");
  process.exit(1);
}

// One grounded entity → "text→tier(#id name)"; a scope/settled leg-list → "L0[fixture]: team→tier(#id), …".
const ent = (e: any): string => (e ? `${e.text}→${e.tier}${e.candidates?.[0] ? `(#${e.candidates[0].id} ${e.candidates[0].name ?? ""})` : ""}` : "");
const scopeLine = (out: any): string => (out.legs ?? []).map((lg: any, i: number) =>
  `L${i}[${lg.level}]: ${[...(lg.teams ?? []).map(ent), ent(lg.subjectPlayer), ent(lg.competition), ent(lg.region)].filter(Boolean).join(", ") || "—"}`).join(" | ");

// A crisp one-liner for stages whose shape we know; the rest fall back to capped JSON.
const stageLine = (stage: string, out: any): string => {
  switch (stage) {
    case "extract": return `${out.selectors?.length ?? 0} selector(s) · sport=${out.sport}`;
    case "ground": return scopeLine(out);
    case "entities": return `${scopeLine(out)}${out.clarifications?.length ? ` · ⚠${out.clarifications.length} clarify` : ""}`;
    case "recall": return `endpoint=${out.endpoint} · ${out.data?.betOffers?.length ?? 0} offers · ${out.data?.events?.length ?? 0} events · truncated=${out.truncated} · failed=${out.failed}`;
    case "scopeMenu": return `${out.offers?.length ?? 0} offers · ${out.events?.length ?? 0} events${out.timeUnresolved ? " · TIME-UNRESOLVED" : ""}`;
    case "filter": return `${out.menu?.items?.length ?? out.offers?.length ?? 0} markets kept`;
    case "market": return (out as any[]).map((p, i) => (p ? `#${i} "${p.phrase ?? ""}"→${p.label ?? "—"} (${p.match})` : `#${i} main`)).join(" · ");
    case "select": return (out as any[]).map((l) => (l.selection ? (l.selection.fallback ? `${l.pick?.label}: FALLBACK ${l.selection.fallback}` : `${l.pick?.label} ✓`) : `${l.pick?.label ?? "—"}: none`)).join(" · ");
    case "execute": return `${out.results?.length ?? 0} result(s) · ${out.events?.length ?? 0} event(s)${out.clarificationNeeded ? ` · CLARIFY: ${out.clarificationNeeded}` : ""}`;
    default: return safe(out).slice(0, 160);
  }
};

function render(query: string, trace: TraceEvent[], envelope: ResponseEnvelope | undefined, error: Error | undefined): void {
  console.log(`\n\x1b[1mQ:\x1b[0m "${query}"`);
  let prev = trace[0]?.t ?? Date.now();
  for (const e of trace) {
    const dt = `${String(e.t - prev).padStart(5)}ms`; prev = e.t;
    if (e.kind === "stage") {
      if (level === "silent") continue;
      if (level === "full") console.log(`  ${e.stage.padEnd(10)} ${dt}\n${indent(safe(e.out, full))}`);
      else console.log(`  ${e.stage.padEnd(10)} ${dt}  ${stageLine(e.stage, e.out)}`);
    } else if (e.kind === "llm-req" || e.kind === "llm-resp") {
      if (!apis.has("llm") || level === "silent") continue;
      if (e.kind === "llm-req") {
        if (level === "full") console.log(`  → llm ${stageOf[e.tool] ?? e.tool}  (system ${e.system.length}B${full ? `:\n${indent(e.system)}` : ""})\n    user:\n${indent(e.user)}\n    schema: ${safe(e.schema, full)}`);
        continue;
      }
      console.log(`  [llm ${stageOf[e.tool] ?? e.tool}] ${dt}  ${e.inputTokens}/${e.outputTokens} tok${e.stopReason === "max_tokens" ? "  \x1b[33m⚠ cut off (max_tokens)\x1b[0m" : ""}${level === "full" ? `\n${indent(safe(e.output, full))}` : ""}`);
    } else {
      if (!apis.has("kambi") || level === "silent") continue;
      if (e.kind === "kambi-req") { if (level === "full") console.log(`  → GET ${shortUrl(e.url)}`); continue; }
      console.log(`  [kambi] ${dt}  ${e.status}${e.ok ? "" : " ✗"} ${shortUrl(e.url)}`);
    }
  }

  if (error) {
    const last = trace[trace.length - 1];
    const where = last?.kind === "llm-req" ? ` (during llm ${stageOf[last.tool] ?? last.tool})`
      : last?.kind === "kambi-req" ? ` (during GET ${shortUrl(last.url)})`
      : last?.kind === "stage" ? ` (after ${last.stage})` : "";
    console.log(`  \x1b[31m✗ FAILED\x1b[0m · ${error.message}${where}`);
  } else if (values.until && !envelope) {
    console.log(`  \x1b[33m⏹ stopped\x1b[0m after --until=${values.until}`);
  } else {
    const c = envelope?.cost;
    const money = c?.totalCost ? `$${c.totalCost.toFixed(4)}` : "—";
    const total = trace.length ? trace[trace.length - 1]!.t - trace[0]!.t : 0;
    const tail = envelope?.clarificationNeeded ? `CLARIFY: ${envelope.clarificationNeeded}` : `${envelope?.results?.length ?? 0} result(s)`;
    console.log(`  \x1b[32m✔ done\x1b[0m · ${c?.totalInputTokens ?? 0}/${c?.totalOutputTokens ?? 0} tok · ${money} · ${total}ms · ${tail}`);
  }
}

async function runOne(query: string): Promise<{ trace: TraceEvent[]; envelope?: ResponseEnvelope; error?: Error }> {
  const trace: TraceEvent[] = [];
  let envelope: ResponseEnvelope | undefined;
  let error: Error | undefined;
  await traceStore.run(trace, async () => {
    try {
      for await (const ev of runPipeline(query, { tz: values.tz, ...(values.until ? { until: values.until } : {}) })) {
        if (ev.stage === "done") envelope = ev.envelope;
      }
    } catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
  });
  return { trace, envelope, error };
}

const results: { query: string; error?: Error; stopped: boolean }[] = [];
for (const q of queries) {
  const { trace, envelope, error } = await runOne(q);
  render(q, trace, envelope, error);
  if (values.out) {
    try { appendFileSync(values.out, JSON.stringify({ query: q, ok: !error, error: error?.message, trace, envelope }) + "\n"); }
    catch (e) { console.log(`  (--out write skipped: ${(e as Error).message})`); }
  }
  results.push({ query: q, error, stopped: !!values.until && !envelope && !error });
  if (error && values["fail-fast"]) break;
}

const failed = results.filter((r) => r.error);
const ok = results.filter((r) => !r.error && !r.stopped).length;
const stopped = results.filter((r) => r.stopped).length;
console.log(`\n\x1b[1m${results.length} run · ${ok} ok · ${stopped} stopped · ${failed.length} failed\x1b[0m`);
for (const f of failed) console.log(`  ✗ "${f.query}" — ${f.error!.message}`);
if (failed.length) process.exit(1);
