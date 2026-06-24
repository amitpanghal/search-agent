// e2e-urls — re-run the two motivating queries and LOG every outbound HTTP URL (Kambi feed + Anthropic),
// grouped per query, by wrapping global fetch.
//   tsx scripts/e2e-urls.ts
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveQuery } from "../src/resolver/resolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
for (const line of existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
}

const urls: string[] = [];
const orig = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = init?.method ?? (typeof input !== "string" ? input?.method : undefined) ?? "GET";
  urls.push(`${method} ${url}`);
  return orig(input as any, init);
}) as typeof fetch;

const QUERIES = [
  "Mbappé most goals in WC26 and to score in his next game",
  "Kane 1st goalscorer in his next game and golden ball in WC26",
];

async function main() {
  for (const q of QUERIES) {
    urls.length = 0;
    console.log("\n========================================");
    console.log("RAW QUERY:", JSON.stringify(q));
    try { await resolveQuery(q); } catch (e) { console.error("ERROR:", (e as Error).message); }
    console.log(`-- ${urls.length} request(s):`);
    urls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));
  }
}
main();
