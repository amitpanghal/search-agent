// Targeted grounding probe: ground a hand-picked case list and print tier + ids→names + the raw-cosine
// top-k, so the recall-miss cases that aren't in the 32-case regression snapshot (Q23/Q26/Q27) can be
// eyeballed before/after a change. Read-only; loads .env for the Voyage key like ground-snapshot.
//   npx tsx scripts/ground-probe.ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundMarket, type GroundOpts, type SubjectKind } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";

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

type Case = { c: string; s?: SubjectKind; l?: "n" | "b"; note: string };
const CASES: Case[] = [
  { c: "to score first", s: "either_match_team", l: "b", note: "Q23 recall miss — want 'Team to score First Goal...' surfaced" },
  { c: "match result", s: "event", note: "Q26 sel-3 — want Match Odds present (semantic, not lexical)" },
  { c: "dribbles completed", s: "player", l: "n", note: "Q26 sel-2 / KE-5 — boType gate; expect still hard-dropped" },
  { c: "free kick specials", s: "player", note: "Q27 — want a clarify shortlist of direct-free-kick markets" },
  { c: "to win the tournament", s: "event", l: "b", note: "false-friend guard — must NOT regress to a wrong confident" },
];

function opts(cse: Case): GroundOpts {
  const o: GroundOpts = {};
  if (cse.s) o.subjectKind = cse.s;
  if (cse.l === "n") o.line = { kind: "numeric", value: 3.5, direction: "over" };
  else if (cse.l === "b") o.line = { kind: "binary", direction: "yes" };
  return o;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cat = loadCatalog();
  const nm = (id: number) => cat.byId.get(id)?.name ?? `?${id}`;
  for (const cse of CASES) {
    const r = await groundMarket(cse.c, opts(cse));
    console.log(`\n■ "${cse.c}" [${cse.s ?? ""}${cse.l ? "/" + cse.l : ""}]  — ${cse.note}`);
    console.log(`  → ${r.method}/${r.tier ?? "-"}${r.score != null ? ` score=${r.score.toFixed(3)}` : ""}`);
    console.log(`  → ids: ${r.ids.length ? r.ids.map((id) => `${id} (${nm(id)})`).join("  |  ") : "— none —"}`);
    if (r.candidates?.length) {
      console.log(`  raw-cosine top-${r.candidates.length}:`);
      for (const c of r.candidates) console.log(`      ${c.score.toFixed(3)}  ${c.name}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
