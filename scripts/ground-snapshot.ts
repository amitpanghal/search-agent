// Grounding regression harness: snapshot the grounding of a representative concept set, then diff a
// later index against it. Catches a global re-embed silently breaking a confident ground (what v1's
// "Winner" 0.557→0.487 regression was). Enrichment only affects the VECTOR path, so the set leans on
// vector-reaching concepts across all three subject buckets, plus a few alias/name anchors.
//   npx tsx scripts/ground-snapshot.ts capture   # writes the baseline snapshot (run on the OLD index)
//   npx tsx scripts/ground-snapshot.ts diff      # re-grounds + diffs vs the snapshot (run on the NEW index)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundMarket, type GroundOpts, type SubjectKind } from "../src/resolver/ground-market";
import { loadCatalog } from "../src/resolver/catalog";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(ROOT, "scripts", "grounding-snapshot.json");
function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// { c: concept, s: subject, l: "n"(numeric o0.5) | "b"(binary yes) | undefined }
type Case = { c: string; s?: SubjectKind; l?: "n" | "b" };
const CASES: Case[] = [
  // event (both buckets — most exposed to enrichment)
  { c: "match result", s: "event" }, { c: "first goalscorer", s: "event", l: "b" },
  { c: "goal in stoppage time", s: "event" }, { c: "Golden Boot", s: "event" },
  { c: "top assist", s: "event" }, { c: "outright winner", s: "event", l: "b" },
  { c: "most cards in tournament", s: "event", l: "b" }, { c: "top goalscorer", s: "event" },
  { c: "winning margin", s: "event" }, { c: "correct score", s: "event" },
  { c: "both teams to score", s: "event", l: "b" }, { c: "total cards", s: "event", l: "n" },
  { c: "half time result", s: "event" }, { c: "to win the tournament", s: "event", l: "b" },
  { c: "to reach the final", s: "event", l: "b" },
  // player
  { c: "corners", s: "player" }, { c: "aerial duels won", s: "player" },
  { c: "shots on target", s: "player", l: "n" }, { c: "shots", s: "player", l: "n" },
  { c: "assists", s: "player" }, { c: "fouls won", s: "player" }, { c: "tackles", s: "player" },
  { c: "passes completed", s: "player" }, { c: "offsides", s: "player" },
  { c: "to score", s: "player", l: "b" }, { c: "anytime scorer", s: "player", l: "b" },
  // team / match
  { c: "total goals", s: "either_match_team", l: "n" }, { c: "total corners", s: "team", l: "n" },
  { c: "clean sheet", s: "team", l: "b" }, { c: "win to nil", s: "team" },
  { c: "team to score first", s: "team" }, { c: "double chance", s: "team" },
];

function opts(cse: Case): GroundOpts {
  const o: GroundOpts = {};
  if (cse.s) o.subjectKind = cse.s;
  if (cse.l === "n") o.line = { kind: "numeric", value: 0.5, direction: "over" };
  else if (cse.l === "b") o.line = { kind: "binary", direction: "yes" };
  return o;
}
type Snap = { c: string; s?: string; l?: string; method: string; tier?: string; ids: number[]; score?: number };
const key = (c: Case) => `${c.c}|${c.s ?? ""}|${c.l ?? ""}`;

async function groundAll(): Promise<Map<string, Snap>> {
  const out = new Map<string, Snap>();
  for (const cse of CASES) {
    const r = await groundMarket(cse.c, opts(cse));
    out.set(key(cse), { c: cse.c, s: cse.s, l: cse.l, method: r.method, tier: r.tier, ids: [...r.ids].sort(), score: r.score });
  }
  return out;
}
const isConfident = (s?: string) => s === "confident" || s === "variants";

async function main(): Promise<void> {
  loadDotEnv();
  const mode = process.argv[2];
  const cur = await groundAll();
  if (mode === "capture") {
    writeFileSync(SNAP, JSON.stringify([...cur.values()], null, 1));
    console.log(`captured ${cur.size} groundings -> ${SNAP}`);
    return;
  }
  if (mode !== "diff") { console.error("usage: ground-snapshot.ts capture|diff"); process.exit(2); }
  const cat = loadCatalog();
  const nm = (ids: number[]) => ids.map((id) => cat.byId.get(id)?.name ?? "?").join(" | ") || "—";
  const old = new Map((JSON.parse(readFileSync(SNAP, "utf8")) as Snap[]).map((s) => [`${s.c}|${s.s ?? ""}|${s.l ?? ""}`, s]));
  const regressions: string[] = [], wins: string[] = [], changed: string[] = [];
  for (const [k, n] of cur) {
    const o = old.get(k);
    if (!o) continue;
    const same = o.method === n.method && o.tier === n.tier && JSON.stringify(o.ids) === JSON.stringify(n.ids);
    if (same) continue;
    const line = `  ${n.c} [${n.s ?? ""}${n.l ? "/" + n.l : ""}]\n      OLD ${o.method}/${o.tier ?? "-"} ${JSON.stringify(o.ids)} [${nm(o.ids)}]\n      NEW ${n.method}/${n.tier ?? "-"} ${JSON.stringify(n.ids)} [${nm(n.ids)}]`;
    if (isConfident(o.tier) && (!isConfident(n.tier) || JSON.stringify(o.ids) !== JSON.stringify(n.ids))) regressions.push(line);
    else if (!isConfident(o.tier) && isConfident(n.tier)) wins.push(line);
    else changed.push(line);
  }
  const sec = (t: string, a: string[]) => console.log(`\n${t} (${a.length})${a.length ? "\n" + a.join("\n") : ""}`);
  sec("REGRESSIONS (confident lost or confident ids changed)", regressions);
  sec("WINS (gained a confident ground)", wins);
  sec("OTHER CHANGES (shortlist/none/score shifts)", changed);
  console.log(`\n${cur.size} cases | ${regressions.length} regressions | ${wins.length} wins | ${changed.length} other`);
  if (regressions.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
