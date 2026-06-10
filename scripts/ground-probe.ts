// Targeted grounding probe (NO LLM): ground a hand-picked case list and print tier + ids→names + the
// raw-cosine top-k, plus where the by-construction TARGET lands in the pool — so grounding-failure cases
// can be diagnosed (and re-checked before/after a change). Read-only; loads .env for the Voyage key.
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

type Case = { c: string; s?: SubjectKind; l?: "n" | "b"; lvl?: "fixture" | "competition"; target?: number; note: string };
// The 7 Tier-1 grounding failures (faithful extractor concept, grounder mishandled). Params copied from the
// cached extractor plans (tier1-extractor-cache.json); target = the by-construction gold id.
const CASES: Case[] = [
  { c: "to score first", s: "either_match_team", lvl: "fixture", target: 1001828740, note: "#1 → Correct Score (want Team to score first)" },
  { c: "penalty to be given", s: "event", lvl: "fixture", target: 1001263163, note: "#2 → combo junk (want Penalty Kick awarded)" },
  { c: "to win the World Cup", s: "team", lvl: "competition", target: 1001159600, note: "#3 → To qualify for the World Cup (want To Win The Trophy)" },
  { c: "to go to extra time", s: "event", lvl: "fixture", target: 1001581856, note: "#4 alias-shadow → Extra Time (want Match to go into Extra Time)" },
  { c: "match to reach extra time", s: "event", lvl: "fixture", target: 1001581856, note: "#4b vector-bypass (no alias) — can cosine find it?" },
  { c: "to score with a header", s: "player", l: "b", lvl: "fixture", target: 2100041189, note: "#5 → To score from a header (want To score a header)" },
  { c: "tackles", s: "player", lvl: "fixture", target: 1001809658, note: "#6 → tackles gained & not gained (want tackles completed)" },
  { c: "times caught offside", s: "player", lvl: "fixture", target: 1001809659, note: "#7 → ET/competition variants (want offside infringements)" },
];

function opts(cse: Case): GroundOpts {
  const o: GroundOpts = {};
  if (cse.s) o.subjectKind = cse.s;
  if (cse.lvl) o.level = cse.lvl;
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
    console.log(`\n■ "${cse.c}" [${cse.s ?? ""}${cse.l ? "/" + cse.l : ""}${cse.lvl ? "/" + cse.lvl : ""}]  — ${cse.note}`);
    console.log(`  → ${r.method}/${r.tier ?? "-"}${r.score != null ? ` score=${r.score.toFixed(3)}` : ""}`);
    console.log(`  → ids: ${r.ids.length ? r.ids.map((id) => `${id} (${nm(id)})`).join("  |  ") : "— none —"}`);
    if (cse.target != null) {
      const inIds = r.ids.includes(cse.target);
      const rank = r.candidates?.findIndex((c) => c.id === cse.target) ?? -1;
      const tScore = rank >= 0 ? r.candidates![rank]!.score.toFixed(3) : "—";
      console.log(`  → TARGET ${cse.target} (${nm(cse.target)}): ${inIds ? "RETURNED ✓" : rank >= 0 ? `in pool @rank ${rank + 1} (cos ${tScore})` : "NOT in top-8 pool"}`);
    }
    if (r.candidates?.length) {
      console.log(`  raw-cosine top-${r.candidates.length}:`);
      for (const c of r.candidates) console.log(`      ${c.score.toFixed(3)}  ${c.id === cse.target ? "★ " : ""}${c.id} ${c.name}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
