// migrate-gold-perleg — one-shot: rewrite gold.seed.jsonl from the old single `event_scope` to per-leg `scope`
// (per-leg-scope Phase 7). Mechanical: copy each record's event_scope onto EVERY selector's `scope`, drop the
// top-level key. Single-grain golds (the existing corpus) get identical scope on each leg; hand-fix any genuine
// mixed-grain row afterward. The original is in git — diff to review.
//   tsx scripts/migrate-gold-perleg.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HERE, "..", "src", "eval", "gold.seed.jsonl");

const lines = readFileSync(PATH, "utf8").split("\n");
const out: string[] = [];
let migrated = 0;
for (const raw of lines) {
  const line = raw.trim();
  if (!line) continue;
  const obj = JSON.parse(line);
  const es = obj?.expect?.event_scope;
  if (es && Array.isArray(obj.expect.selectors)) {
    for (const sel of obj.expect.selectors) sel.scope = structuredClone(es);
    delete obj.expect.event_scope;
    migrated++;
  }
  out.push(JSON.stringify(obj));
}
writeFileSync(PATH, out.join("\n") + "\n");
console.log(`migrated ${migrated} gold record(s) -> per-leg scope (${out.length} rows written)`);
