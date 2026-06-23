// THROWAWAY smoke (build plan Phase 6): the NEW orchestrator end-to-end on real queries. Full chain with
// real LLM calls — extract -> groundScope -> resolveEntities -> recall -> filter -> resolve -> select ->
// execute. Needs ANTHROPIC_API_KEY + network.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveQuery } from "../src/resolver/resolve";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const queries = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const deck = queries.length ? queries : ["Spain to win the World Cup", "Mbappe to win the golden boot"];
  for (const q of deck) {
    console.log(`\n${"=".repeat(80)}\nQUERY: "${q}"`);
    try {
      const ans = await resolveQuery(q);
      console.log(`kind: ${ans.kind}`);
      if (ans.kind === "results") {
        for (const l of ans.legs) {
          console.log(`  • [${l.match}] ${l.market ?? "—"}  ->  ${l.outcome ? `${l.outcome.label}${l.outcome.line != null ? ` @${l.outcome.line}` : ""}${l.outcome.participant ? ` (${l.outcome.participant})` : ""} = ${l.outcome.odds ?? "?"}` : "(no outcome)"}${l.note ? `  [${l.note}]` : ""}`);
        }
        if (ans.notes.length) console.log(`  notes: ${ans.notes.join(" | ")}`);
      } else {
        console.log(`  clarifications: ${ans.clarifications.map((c) => `${c.ref}: ${c.question}`).join(" | ")}`);
      }
    } catch (e) {
      console.log(`  THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main().catch((e) => { console.error(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });
