// Sprint 5.1 step-0 sanity: run the REAL extractor (Haiku) over period-bearing queries with the new
// `period` prompt rule and print the emitted facet. Confirms (a) period is normalized to the enum from
// varied idioms, (b) market_concept stays RICH (period words NOT stripped), (c) no-period queries omit it.
// Standalone — does NOT touch tier1-extractor-cache.json (so the 355 probe cache is left stale on purpose).
//   npx tsx scripts/probe-period-facet.ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extract } from "../src/resolver/extract";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// query, expected period (for eyeballing only — not asserted)
const CASES: [string, string][] = [
  ["exact scoreline at the break", "first_half"],
  ["second half corners over 4.5", "second_half"],
  ["away goals before half time, how many", "first_half"],
  ["offside flags against lukaku, extra time counting", "extra_time"],
  ["total shots in the 120 minutes", "extra_time"],
  ["opening 45 goals", "first_half"],
  ["bookings after the break", "second_half"],
  ["first half both teams to score", "first_half"],
  ["a goal in the dying added minutes of extra time", "extra_time"],
  ["total goals", "(omit)"],
  ["mbappe shots on target", "(omit)"],
  ["who wins the second half", "second_half"],
];

async function main(): Promise<void> {
  loadDotEnv();
  console.log("query | subject | market_concept | period(LLM) | expect | line");
  console.log("--- | --- | --- | --- | --- | ---");
  for (const [q, expect] of CASES) {
    try {
      const plan = await extract(q);
      if (plan.status !== "resolved") { console.log(`${q} | — | (status:${plan.status}) | — | ${expect} | —`); continue; }
      for (const s of plan.selectors) {
        console.log(`${q} | ${s.subject.kind} | ${s.market_concept} | ${s.period ?? "—"} | ${expect} | ${s.line?.kind ?? "—"}`);
      }
    } catch (e) {
      console.log(`${q} | ERROR | ${(e as Error).message} | — | ${expect} | —`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
