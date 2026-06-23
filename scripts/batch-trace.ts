// batch-trace — compact end-to-end probe for MANY queries.
//
//   tsx scripts/batch-trace.ts            (runs the built-in list)
//   tsx scripts/batch-trace.ts "q1" "q2"  (runs given queries)
//
// Drives the REAL resolveQuery (so orchestration == production), and captures — non-invasively —
// the two LLM tool-calls (extract plan + market picks) and every Kambi fetch, then prints a SHORT
// per-query block: extracted plan, recall summary, market picks, final envelope, cost.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
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
loadDotEnv();
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }

const PRICE = { input: 1.0 / 1e6, output: 5.0 / 1e6, cacheWrite: 1.25 / 1e6, cacheRead: 0.1 / 1e6 };
type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
type Call = { tool: string; input: any; usage: Usage };

let calls: Call[] = [];
let fetches: { url: string; events?: number; betOffers?: number; names?: string[] }[] = [];

// seam 1: capture every Anthropic tool-call (extract uses tool 'emit_query_plan', resolve uses 'pick')
const probe = new Anthropic();
const proto = Object.getPrototypeOf(probe.messages) as { create: (...a: any[]) => any };
const orig = proto.create;
proto.create = async function (this: unknown, body: any, opts?: unknown) {
  const res = await orig.call(this, body, opts);
  const tu = (res?.content ?? []).find((b: any) => b?.type === "tool_use");
  calls.push({ tool: body?.tools?.[0]?.name ?? "?", input: tu?.input, usage: res?.usage ?? {} });
  return res;
};

// seam 2: capture Kambi fetches + cheap body stats (events / betOffers / fixture names)
const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const res = await origFetch(input as any, init);
  if (url.includes("kambicdn")) {
    const rec: (typeof fetches)[number] = { url };
    try {
      const j: any = await res.clone().json();
      const evs = j.events ?? (j.event ? [j.event] : undefined);
      if (Array.isArray(evs)) { rec.events = evs.length; rec.names = evs.slice(0, 6).map((e: any) => e.name ?? `${e.homeName} - ${e.awayName}`); }
      if (Array.isArray(j.betOffers)) rec.betOffers = j.betOffers.length;
    } catch { /* non-JSON */ }
    fetches.push(rec);
  }
  return res;
} as typeof fetch;

import { resolveQuery } from "../src/resolver/resolve";

const DEFAULT = [
  "Lionel Messi anytime goalscorer odds above 2.0 Argentina vs Jordan Sunday",
  "Harry Kane shots on target over 2.5 England Round of 32 next week",
  "Kylian Mbappé to score or assist live odds France this weekend",
  "Erling Haaland anytime scorer plus Norway to win under 3.0 odds",
  "Cristiano Ronaldo over 3.5 shots Portugal Round of 32 odds above 1.8",
  "Mexico vs Czechia both teams to score odds above 1.7 tomorrow night",
  "Germany to win in 90 minutes odds under 1.5 Round of 32 Monday",
  "Over 2.5 goals Argentina vs Jordan live in-play odds Sunday kickoff",
  "World Cup Round of 32 correct score 2-1 odds value late kickoff this week",
  "Brazil double chance odds above 1.3 next match Round of 32",
];

const j = (x: unknown) => JSON.stringify(x);
function cost(u: Usage) {
  return (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output +
    (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead;
}

async function main() {
  const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  let grand = 0;
  for (const [n, q] of queries.entries()) {
    calls = []; fetches = [];
    console.log("\n" + "=".repeat(100));
    console.log(`Q${n + 1}: ${q}`);
    console.log("=".repeat(100));
    let envelope: any, err: any;
    try { envelope = await resolveQuery(q); } catch (e) { err = e; }

    // STAGE 1 — extracted plan
    const plan = calls.find((c) => c.tool === "emit_query_plan")?.input?.plan;
    if (plan) {
      const es = plan.event_scope ?? {};
      console.log("\n[1] EXTRACT plan");
      console.log(`    sport=${plan.sport} comp=${j(es.competition)} level=${es.level} region=${j(es.region)}`);
      console.log(`    teams=${j(es.teams)} players=${j(es.players)} stage=${j(es.stage)}`);
      console.log(`    time=${j(es.time)} play_state=${j(es.play_state)}`);
      (plan.selectors ?? []).forEach((s: any, i: number) =>
        console.log(`    sel[${i}] subject=${j(s.subject)} concept=${j(s.market_concept)} line=${j(s.line)} odds=${j(s.odds)}${s.bo_types ? " bo_types=" + j(s.bo_types) : ""}`));
    } else console.log("\n[1] EXTRACT plan — (not captured)");

    // STAGE 5 — recall
    console.log("\n[5] RECALL fetches");
    fetches.forEach((f) => console.log(`    ${f.events != null ? `events=${f.events}` : ""}${f.betOffers != null ? ` betOffers=${f.betOffers}` : ""}  ${f.names ? "[" + f.names.join(" | ") + "]" : ""}\n      ${f.url}`));

    // STAGE 7 — market picks
    const pickCall = calls.find((c) => c.tool === "pick");
    console.log("\n[7] RESOLVE market picks");
    if (pickCall) (pickCall.input?.picks ?? []).forEach((p: any) => console.log(`    leg ${p.leg}: ref=${j(p.ref)} match=${p.match} — ${p.reason}`));
    else console.log("    (no resolve call — recall returned nothing, or short-circuited)");

    // STAGE 9 — final envelope
    console.log("\n[9] FINAL envelope");
    if (err) console.log("    ERROR: " + (err?.message ?? err));
    else console.log(JSON.stringify(envelope, null, 2).split("\n").map((l) => "    " + l).join("\n"));

    const c = calls.reduce((s, x) => s + cost(x.usage), 0);
    grand += c;
    console.log(`\n[$] llmCalls=${calls.length} fetches=${fetches.length} cost=$${c.toFixed(6)}`);
  }
  console.log("\n" + "=".repeat(100));
  console.log(`GRAND TOTAL cost=$${grand.toFixed(6)} over ${queries.length} queries`);
}
main().catch((e) => { console.error("BATCH ERROR:", e); process.exit(1); });
