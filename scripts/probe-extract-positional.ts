// probe-extract-positional — what does the extractor emit for Double Chance / Correct Score / HT-FT?
// Pure extraction (no fetch). Prints each query's selectors so we can see the `line` token shape.
//   tsx scripts/probe-extract-positional.ts

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
}

// capture token usage at the SDK boundary
let inTok = 0, outTok = 0, cw = 0, cr = 0;
const proto = Object.getPrototypeOf(new Anthropic().messages) as { create: (...a: any[]) => any };
const orig = proto.create;
proto.create = async function (this: unknown, body: any, opt?: unknown) {
  const r = await orig.call(this, body, opt);
  const u = r?.usage ?? {};
  inTok += u.input_tokens ?? 0; outTok += u.output_tokens ?? 0;
  cw += u.cache_creation_input_tokens ?? 0; cr += u.cache_read_input_tokens ?? 0;
  return r;
};

import { extract } from "../src/resolver/extract";

const QUERIES = [
  // --- Double Chance ---
  ["DC", "France to win or draw in their next game"],
  ["DC", "Norway double chance win or draw next match"],
  ["DC", "Brazil not to lose their next game"],
  ["DC", "double chance home win or draw next game"],
  // --- Correct Score ---
  ["CS", "France to win 2-0 in their next game"],
  ["CS", "correct score 2-1 for France next game"],
  ["CS", "Norway vs France to finish 1-2"],
  ["CS", "France next game correct score 3-1"],
  // --- HT/FT sanity (known: selection win/win) ---
  ["HTFT", "Norway to win HT/FT next game"],
];

async function main() {
  for (const [tag, q] of QUERIES) {
    let plan: any;
    try { plan = await extract(q!); } catch (e) { console.log(`\n[${tag}] ${q}\n  ERROR: ${e}`); continue; }
    console.log(`\n[${tag}] ${q}`);
    console.log(`  teams=${JSON.stringify(plan.event_scope?.teams)}`);
    (plan.selectors ?? []).forEach((s: any, i: number) =>
      console.log(`  sel${i}: subject=${JSON.stringify(s.subject)} concept=${JSON.stringify(s.market_concept)} ` +
        `bo_types=${JSON.stringify(s.bo_types)} line=${JSON.stringify(s.line)}`));
  }
  const cost = inTok * 1e-6 + outTok * 5e-6 + cw * 1.25e-6 + cr * 0.1e-6;
  console.log(`\n--- ${QUERIES.length} extract calls | in=${inTok} out=${outTok} cacheW=${cw} cacheR=${cr} | cost=$${cost.toFixed(6)} ---`);
}
main().catch((e) => { console.error(e); process.exit(1); });
