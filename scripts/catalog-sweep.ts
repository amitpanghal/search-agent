// Tier-1 catalog round-trip sweep (Sprint 4, decision 25). The cheap, no-LLM half of the
// self-improving test loop: for every KEPT criterion, feed a user-style market concept built FROM
// its own name and assert it grounds back to that id. The answer key is the catalog row the concept
// was built from — by-construction, so the grounder never writes its own key (dodges E8 circularity).
//
//   npx tsx scripts/catalog-sweep.ts            # run the sweep, print the report, (re)write the log
//   npx tsx scripts/catalog-sweep.ts --no-log   # skip rewriting planning/queries/tier_1_automation.md
//
// Two passes, reported APART (the overfitting tell — floor-green + paraphrase-red = a hand-fit head):
//   - Verbatim floor (all 2486): the name itself, subject-prefix stripped. Mostly exercises the
//     alias/exact-name head; catches index gaps, quarantine errors, catastrophic collisions, alias shadows.
//   - Paraphrase batch (head): a mild paraphrase per head criterion (data/football/tier1-paraphrases.json).
//     This is the real test — it exercises the voyage-3 vector tail, the layer that regresses.
//
// Reuses ground-snapshot.ts's dotenv loader + `groundMarket` wiring and the scorer's `idsContainGold`
// (E13 containment) — no new harness, no duplicated grounding/scoring logic. Asserts 0 quarantine leaks.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundMarket, type GroundResult, type SubjectKind } from "../src/resolver/ground-market";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { idsContainGold, normalize } from "../src/eval/structural-scorer";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, "planning", "queries", "tier_1_automation.md");
const PARAPHRASES = join(ROOT, "data", "football", "tier1-paraphrases.json");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// ---- one test = a concept + the criterion id it was built FROM (the by-construction label) ----
// Three PASS classes: `clean` (grounded to the exact source id, confident|variants), `twin` (grounded to
// the SAME market under a sibling id — a settlement/register duplicate), and `narrowed` (the source id is
// present but in a non-confident `ambiguous`/`shortlist` set — the executor clarifies, but grounding did
// NOT lose it). The rest are shortcomings (the source id absent or grounded elsewhere).
type Class = "clean" | "twin" | "narrowed" | "none" | "below" | "ambiguous" | "wrong-id" | "wrong-bucket";
type Test = { concept: string; kind: SubjectKind; gold: Criterion; res: GroundResult; cls: Class; contained: boolean };

// Drop the non-semantic Opta settlement parenthetical (mirrors ground-market's stripSettle) so the
// concept reads like a user phrasing, not a feed artifact. Resolution still round-trips it (the
// settlement-stripped exact-name index reaches the same id).
const stripSettle = (s: string) => s.replace(/\(settled[^)]*\)/gi, "").replace(/\s+/g, " ").trim();

// Build a user-style concept from a criterion name. Player generics carry a "Player('s) X" register the
// catalog re-adds on lookup, so strip it to the bare stat ("Player's Shots on Target" -> "shots on
// target"); team/match names pass through as-is. event = the subject-agnostic bucket (searches both).
function conceptFor(c: Criterion): { concept: string; kind: SubjectKind } {
  let n = stripSettle(c.name);
  if (c.subject === "player") {
    n = n
      .replace(/^the\s+/i, "")
      .replace(/^player['’]?s?\s+/i, "")
      .replace(/\s+by\s+(the\s+)?player$/i, "")
      .trim();
    return { concept: n, kind: "player" };
  }
  return { concept: n, kind: "event" };
}

// Market identity for twin detection: the name with the non-semantic settlement parenthetical and the
// player register markers stripped, normalized. The catalog spells the player register two ways — the
// leading "Player('s) X" and the trailing Opta form "X By The Player" — so strip both (same as conceptFor
// and statCore). Home/away and period words are KEPT, so a twin folds only true duplicates (settled/non-
// settled, "Player X"/"Player's X"/"X By The Player") — never home vs away or full-time vs extra-time.
const marketKey = (name: string) =>
  normalize(stripSettle(name))
    .replace(/^player(\ss)?\s/, "")
    .replace(/\sby(\sthe)?\splayer$/, "")
    .trim();

function classify(gold: Criterion, res: GroundResult): { cls: Class; contained: boolean } {
  const contained = idsContainGold(res.ids, gold.id);
  if (res.method === "none" || res.ids.length === 0) return { cls: "none", contained };
  // gold present in a non-confident set (shortlist/ambiguous) = `narrowed` (a pass — surfaced, not lost).
  if (res.tier === "shortlist") return { cls: contained ? "narrowed" : "below", contained };
  if (res.tier === "ambiguous") return { cls: contained ? "narrowed" : "ambiguous", contained };
  if (contained) return { cls: "clean", contained }; // confident|variants containing the gold id
  // confident|variants on a NON-gold id: a settlement/register twin of the same market is still a pass.
  const top = loadCatalog().byId.get(res.ids[0]!);
  if (top && top.subject === gold.subject && marketKey(top.name) === marketKey(gold.name)) return { cls: "twin", contained };
  return { cls: top && top.subject !== gold.subject ? "wrong-bucket" : "wrong-id", contained };
}

// ---- routed fix-target (Stage B reads this; plain English per house style) ----
const STOP = new Set(["the", "a", "an", "to", "of", "in", "on", "at", "by", "for", "and", "or", "with", "is", "are", "be", "any", "all", "their", "s"]);
const content = (s: string) => new Set(normalize(s).split(" ").filter((t) => t && !STOP.has(t)));
function disjoint(a: string, b: string): boolean {
  const A = content(a);
  for (const t of content(b)) if (A.has(t)) return false;
  return true;
}

function routeFix(t: Test): string {
  switch (t.cls) {
    case "none":
    case "below":
      return disjoint(t.concept, t.gold.name)
        ? "GROUNDING / disjoint → propose alias (bridges a gap vectors fundamentally can't)"
        : "GROUNDING / near-miss below threshold → recalibrate threshold/FLOOR off the sweep distribution";
    case "ambiguous":
      return "TIER-LOGIC / distinct-core near-tie within ε — check stat-core merge or recalibrate ε";
    case "wrong-id":
      return "TIER-LOGIC or DATA / confident on a sibling — check stat-core / alias shadowing";
    case "wrong-bucket":
      return "DATA / cross-bucket cosine win — check the subject tag on the source or the winner";
    default:
      return "—";
  }
}

// ---- grounding -> readable names ----
function groundedNames(res: GroundResult): string {
  if (res.ids.length === 0) {
    const tail = res.score != null ? ` (best ${res.score.toFixed(3)})` : "";
    return `none${tail}`;
  }
  const byId = loadCatalog().byId;
  return res.ids.map((id) => `${id} "${byId.get(id)?.name ?? "?"}"`).join(" | ");
}

async function runOne(concept: string, kind: SubjectKind, gold: Criterion): Promise<Test> {
  const res = await groundMarket(concept, { subjectKind: kind });
  const { cls, contained } = classify(gold, res);
  return { concept, kind, gold, res, cls, contained };
}

// ---- the sweep ----
async function sweep(crits: Criterion[]): Promise<Test[]> {
  const out: Test[] = [];
  let done = 0;
  for (const c of crits) {
    const { concept, kind } = conceptFor(c);
    if (!normalize(concept)) continue; // a name that strips to nothing can't round-trip
    out.push(await runOne(concept, kind, c));
    if (++done % 250 === 0) process.stderr.write(`  …${done}/${crits.length}\n`);
  }
  return out;
}

type Para = { id: number; text: string };
function loadParaphrases(byId: Map<number, Criterion>): { tests: Para[]; missing: number[] } {
  if (!existsSync(PARAPHRASES)) return { tests: [], missing: [] };
  const raw = JSON.parse(readFileSync(PARAPHRASES, "utf8")) as { paraphrases?: Para[] };
  const tests: Para[] = [];
  const missing: number[] = [];
  for (const p of raw.paraphrases ?? []) {
    if (byId.has(p.id)) tests.push(p);
    else missing.push(p.id);
  }
  return { tests, missing };
}

// ---- report tallying ----
const CLASSES: Class[] = ["clean", "twin", "narrowed", "none", "below", "ambiguous", "wrong-id", "wrong-bucket"];
const PASS: Class[] = ["clean", "twin", "narrowed"]; // clean = exact id; twin = sibling id; narrowed = gold in a clarify set
const FAIL: Class[] = ["none", "below", "ambiguous", "wrong-id", "wrong-bucket"];
function tally(tests: Test[]): Record<Class, number> {
  const t = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<Class, number>;
  for (const x of tests) t[x.cls]++;
  return t;
}
const passCount = (t: Record<Class, number>) => PASS.reduce((n, c) => n + t[c], 0);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : "0.0");

async function main(): Promise<void> {
  loadDotEnv();
  const writeLog = !process.argv.includes("--no-log");
  const cat = loadCatalog();
  const artifact = JSON.parse(readFileSync(join(ROOT, "data", "football", "football_criterions.json"), "utf8")) as any;
  const counts = artifact.counts;
  const quarantinedIds = new Set<number>(artifact.quarantined.map((q: any) => q.id));
  const absent = counts.referenced - counts.kept - counts.quarantined;

  // pass 1 — verbatim floor over every kept criterion
  process.stderr.write(`Verbatim floor over ${cat.list.length} kept criterions…\n`);
  const floor = await sweep(cat.list);

  // pass 2 — head paraphrase batch (the vector tail)
  const para = loadParaphrases(cat.byId);
  const paraTests: Test[] = [];
  if (para.tests.length) {
    process.stderr.write(`Paraphrase batch (${para.tests.length} head markets)…\n`);
    for (const p of para.tests) paraTests.push(await runOne(p.text, conceptFor(cat.byId.get(p.id)!).kind, cat.byId.get(p.id)!));
  }

  // 0-leak guard (E13): no quarantined id may surface in ANY grounding result
  const leaks = new Set<number>();
  for (const t of [...floor, ...paraTests]) for (const id of t.res.ids) if (quarantinedIds.has(id)) leaks.add(id);

  // ---- stdout report ----
  const fTally = tally(floor);
  const fPass = passCount(fTally);
  console.log(
    `\nCatalog round-trip: ${fPass}/${floor.length} pass (${pct(fPass, floor.length)}%) [clean ${fTally.clean} + twin ${fTally.twin} + narrowed ${fTally.narrowed}] | ` +
      `ceilings: ${absent} absent, ${counts.quarantined} quarantined (${leaks.size} leaks)`,
  );
  console.log(`  verbatim floor: ` + CLASSES.map((c) => `${c} ${fTally[c]}`).join(", "));
  if (paraTests.length) {
    const pT = tally(paraTests);
    console.log(`  paraphrase batch: ${passCount(pT)}/${paraTests.length} pass (${pct(passCount(pT), paraTests.length)}%) — ` + CLASSES.map((c) => `${c} ${pT[c]}`).join(", "));
  } else {
    console.log(`  paraphrase batch: (none — author data/football/tier1-paraphrases.json)`);
  }
  console.log(`  aliases (growth guard): ${cat.marketAliases.size} merged (curated + derived)`);

  // grouped shortcomings, worked example each (house style)
  const shorts = [...floor, ...paraTests].filter((t) => !PASS.includes(t.cls));
  console.log(`\nShortcomings (${shorts.length}) — grouped by failure mode:`);
  for (const cls of FAIL) {
    const g = shorts.filter((t) => t.cls === cls);
    if (!g.length) continue;
    console.log(`\n  ${cls} (${g.length}):`);
    for (const t of g.slice(0, 8)) {
      console.log(`    ✗ "${t.concept}" [${t.kind}] → ${groundedNames(t.res)}`);
      console.log(`        from ${t.gold.id} "${t.gold.name}" | ${routeFix(t)}`);
    }
    if (g.length > 8) console.log(`    … and ${g.length - 8} more (full list in the log)`);
  }

  if (writeLog) {
    // Preserve the extractor→ground probe section (written by extractor-ground-probe.ts, an LLM test) so
    // this no-LLM sweep rewrite doesn't clobber it. The two Tier-1 tests share one log; each owns its block.
    const prev = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    const probe = prev.match(/<!-- PROBE:START -->[\s\S]*?<!-- PROBE:END -->/);
    const probeBlock = probe ? `\n${probe[0]}\n` : "";
    writeFileSync(LOG, renderLog({ floor, paraTests, fTally, counts, absent, leaks, aliasCount: cat.marketAliases.size }) + probeBlock);
    console.log(`\nlog → ${LOG}`);
  }
  if (leaks.size) {
    console.error(`\n❌ QUARANTINE LEAK: ${leaks.size} quarantined id(s) surfaced in results: ${[...leaks].join(", ")}`);
    process.exit(1);
  }
}

// ---- the EvaledQueries-format log (every test executed) ----
function statusLine(t: Test): string {
  if (t.cls === "clean") return `correct — grounded back to ${t.gold.id} (tier ${t.res.tier}).`;
  if (t.cls === "twin") return `correct — same market, settlement/register twin id ${t.res.ids[0]} (tier ${t.res.tier}).`;
  if (t.cls === "narrowed") return `correct (narrowed) — gold ${t.gold.id} present in the ${t.res.tier} clarify set, not lost.`;
  const tail = t.contained ? ` (gold id present but tier ${t.res.tier ?? t.res.method}, not clean)` : "";
  return `INCORRECT [${t.cls}]${tail} — ${routeFix(t)}.`;
}
function entry(n: number, t: Test): string {
  return [
    `### ${n}. \`${t.concept}\` [${t.kind}]`,
    `- **Source criterion:** ${t.gold.id} "${t.gold.name}" (${t.gold.subject})`,
    `- **Grounding:** ${t.res.method}/${t.res.tier ?? "—"} → ${groundedNames(t.res)}`,
    `- **Status:** ${statusLine(t)}`,
    "",
  ].join("\n");
}

function renderLog(d: {
  floor: Test[];
  paraTests: Test[];
  fTally: Record<Class, number>;
  counts: any;
  absent: number;
  leaks: Set<number>;
  aliasCount: number;
}): string {
  const { floor, paraTests, fTally, counts, absent, leaks, aliasCount } = d;
  const shorts = [...floor, ...paraTests].filter((t) => !PASS.includes(t.cls));
  const L: string[] = [];
  L.push("# Tier-1 Catalog Round-Trip — Automated Test Log");
  L.push("");
  L.push("> Generated by `scripts/catalog-sweep.ts` (Sprint 4, decision 25). Every test round-trips a");
  L.push("> user-style concept built FROM a kept criterion's name and asserts it grounds back to that id.");
  L.push("> The label is by-construction (the source catalog row), so it is E8-clean. Same format as");
  L.push("> [EvaledQueries.md](EvaledQueries.md): each entry logs the concept, its source criterion, what");
  L.push("> it grounded to, and a correct/incorrect status. **One entry per test, rewritten each run.**");
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("```");
  L.push(
    `Catalog round-trip: ${passCount(fTally)}/${floor.length} pass (${pct(passCount(fTally), floor.length)}%) [clean ${fTally.clean} + twin ${fTally.twin} + narrowed ${fTally.narrowed}] | ` +
      `ceilings: ${absent} absent, ${counts.quarantined} quarantined (${leaks.size} leaks)`,
  );
  L.push(`verbatim floor: ` + CLASSES.map((c) => `${c} ${fTally[c]}`).join(", "));
  if (paraTests.length) {
    const pT = tally(paraTests);
    L.push(`paraphrase batch: ${passCount(pT)}/${paraTests.length} pass (${pct(passCount(pT), paraTests.length)}%) — ` + CLASSES.map((c) => `${c} ${pT[c]}`).join(", "));
  } else {
    L.push(`paraphrase batch: none authored yet`);
  }
  L.push(`aliases (growth guard): ${aliasCount} merged (curated + derived)`);
  L.push("```");
  L.push("");
  L.push("- **clean** — grounded back to the source id at tier `confident|variants` (a pass).");
  L.push("- **twin** — grounded to the SAME market under a sibling id (settlement/register duplicate) — a pass.");
  L.push("- **narrowed** — the source id is present in a non-confident `ambiguous`/`shortlist` set (the executor clarifies, but grounding didn't lose it) — a pass.");
  L.push("- **below** — sub-threshold `shortlist` (recall floor) NOT containing the source; **none** — abstained below FLOOR.");
  L.push("- **ambiguous** — a different-core near-tie; **wrong-id** — confident on the wrong sibling;");
  L.push("  **wrong-bucket** — confident on a market in the other subject bucket.");
  L.push("- **absent** = referenced category ids with no criterion row (a data-feed gap, not a bug).");
  L.push("  **quarantined** = per-player pre-baked rows dropped at build; the sweep asserts **0 leak** into results.");
  L.push("");

  // Known Errors — every shortcoming, full detail, grouped
  L.push("## Known Errors (shortcomings)");
  L.push("");
  if (!shorts.length) L.push("_None — every test round-tripped clean._");
  for (const cls of FAIL) {
    const g = shorts.filter((t) => t.cls === cls);
    if (!g.length) continue;
    L.push(`### ${cls} (${g.length})`);
    L.push("");
    for (const t of g) {
      L.push(`- \`${t.concept}\` [${t.kind}] → ${groundedNames(t.res)}`);
      L.push(`  - from ${t.gold.id} "${t.gold.name}" — ${routeFix(t)}`);
    }
    L.push("");
  }

  // Paraphrase batch — full entries (the authored vector-tail tests)
  L.push("## Paraphrase batch — full entries");
  L.push("");
  if (!paraTests.length) L.push("_No paraphrases authored yet (data/football/tier1-paraphrases.json)._");
  paraTests.forEach((t, i) => L.push(entry(i + 1, t)));

  // Verbatim floor — full index (every test, one line)
  L.push("## Verbatim floor — full index (all tests)");
  L.push("");
  floor.forEach((t, i) => {
    const isPass = PASS.includes(t.cls);
    L.push(`${i + 1}. ${isPass ? "✓" : "✗"} \`${t.concept}\` [${t.kind}] → ${t.res.method}/${t.res.tier ?? "—"} [${t.cls}]${isPass ? "" : ` → ${groundedNames(t.res)}`}`);
  });
  L.push("");
  return L.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
