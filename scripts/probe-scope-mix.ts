// probe-scope-mix — isolate why "next game" is dropped on a mixed outright+fixture query.
// Extraction only, no fetch. Prints level + time + per-selector for each variant.
//   tsx scripts/probe-scope-mix.ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
}
let inT = 0, outT = 0, cw = 0, cr = 0;
const proto = Object.getPrototypeOf(new Anthropic().messages) as { create: (...a: any[]) => any };
const orig = proto.create;
proto.create = async function (this: unknown, b: any, o?: unknown) {
  const r = await orig.call(this, b, o); const u = r?.usage ?? {};
  inT += u.input_tokens ?? 0; outT += u.output_tokens ?? 0; cw += u.cache_creation_input_tokens ?? 0; cr += u.cache_read_input_tokens ?? 0;
  return r;
};
import { extract } from "../src/resolver/extract";

const VARIANTS: [string, string][] = [
  ["fixture only", "France winning odds of its next game"],
  ["mixed (outright first)", "Top scorer in WC 26 odds for Mbappe and France winning odds of its next game"],
  ["mixed (fixture first)", "France winning odds of its next game and top scorer in WC 26 odds for Mbappe"],
  ["mixed, France leg = HT/FT", "Top scorer in WC 26 for Mbappe and France HT/FT in its next game"],
  ["two fixture legs, next game", "Mbappe to score and France to win, both in their next game"],
];

async function main() {
  for (const [tag, q] of VARIANTS) {
    const p = await extract(q);
    console.log(`\n[${tag}] ${q}`);
    console.log(`  level=${JSON.stringify(p.event_scope.level)}  time=${JSON.stringify(p.event_scope.time)}`);
    p.selectors.forEach((s: any, i) => console.log(`  sel${i}: ${JSON.stringify(s.subject)} concept=${JSON.stringify(s.market_concept)} line=${JSON.stringify(s.line)}`));
  }
  console.log(`\n--- in=${inT} out=${outT} cacheW=${cw} cacheR=${cr} cost=$${(inT*1e-6+outT*5e-6+cw*1.25e-6+cr*0.1e-6).toFixed(6)} ---`);
}
main().catch((e) => { console.error(e); process.exit(1); });
