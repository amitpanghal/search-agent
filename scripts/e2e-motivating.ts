// e2e-motivating — Phase 6 end-to-end check. Run the two mixed-grain motivating queries through the REAL
// resolveQuery (live Kambi feed + Haiku calls) and print the envelope grouped by event. Verifies both legs
// resolve AND that a competition leg and a fixture leg land on DIFFERENT events (no cross-leg leak).
//   tsx scripts/e2e-motivating.ts
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

const QUERIES = [
  "Mbappé most goals in WC26 and to score in his next game",
  "Kane 1st goalscorer in his next game and golden ball in WC26",
];

async function main() {
  for (const q of QUERIES) {
    console.log("\n========================================");
    console.log("QUERY:", q);
    try {
      const env = await resolveQuery(q);
      console.log("clarificationNeeded:", env.clarificationNeeded);
      if (env.notes.length) console.log("notes:", env.notes);
      console.log(`results (events): ${env.results.length}`);
      for (const r of env.results) {
        const lvl = r.event.tags?.includes("COMPETITION") ? "COMPETITION" : r.event.tags?.includes("MATCH") ? "MATCH" : "?";
        console.log(`  [${lvl}] ${r.event.name}  (group=${r.event.group})`);
        for (const h of r.highlighted) {
          console.log(`      - ${h.betOffer.criterion.label} -> ${h.outcomes.map((o) => `${o.label} @${o.odds}`).join(", ")}`);
        }
      }
    } catch (e) {
      console.error("ERROR:", (e as Error).stack ?? (e as Error).message);
    }
  }
}
main();
