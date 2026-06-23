// probe-extract-one — print the full QueryPlan for one query (extraction only, no fetch).
//   tsx scripts/probe-extract-one.ts "your query"
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

const q = process.argv.slice(2).join(" ").trim();
const plan = await extract(q);
console.log("QUERY:", JSON.stringify(q));
console.log("\nevent_scope.level =", JSON.stringify(plan.event_scope.level));
console.log("event_scope.time  =", JSON.stringify(plan.event_scope.time));
console.log("\nFULL PLAN:\n" + JSON.stringify(plan, null, 2));
console.log(`\n--- in=${inT} out=${outT} cacheW=${cw} cacheR=${cr} cost=$${(inT*1e-6+outT*5e-6+cw*1.25e-6+cr*0.1e-6).toFixed(6)} ---`);
