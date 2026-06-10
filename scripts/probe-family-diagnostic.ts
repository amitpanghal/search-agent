// Same-family diagnostic over the extractor→ground probe (Sprint 4). PURELY a re-read of CAPTURED data:
// the grounding results already logged in tier_1_automation.md (PROBE block), the extractor cache, and the
// catalog. It calls NO model (no Haiku, no Voyage) — it re-grades the SAME 400 outcomes a second way.
//
//   npx tsx scripts/probe-family-diagnostic.ts
//
// It does NOT move the pass/fail line. The headline stays the strict, E8-clean 52/400. On top of it, every
// MISS is tagged by a catalog property the grounder never sees: does anything the query grounded to share
// the TARGET's stat-family — same stat + period + subject? That separates "defensible sibling" misses
// (the catalog surfaced a same-family neighbour) from "grounded elsewhere" and "extractor punted".
//
//   strict miss  →  { same-family near-miss | grounded elsewhere | abstained | extractor punt }
//
// "Family" is computed INDEPENDENTLY of ground-market.ts (the point: a grounder-blind catalog property).
// familyKey = subject + statCore(name), where statCore mirrors the grounder's: drop the subject marker and
// the non-semantic settlement parenthetical, collapse home/away polarity, KEEP the stat noun and period
// (so a 1st-half sibling is a DIFFERENT family from the full match — "same period" is part of the test).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, "planning", "queries", "tier_1_automation.md");
const QUERIES = join(ROOT, "data", "football", "tier1-extractor-queries.json");
const CACHE = join(ROOT, "data", "football", "tier1-extractor-cache.json");

// --- stat-family key (grounder-blind catalog property; mirrors ground-market.ts baseStatCore) ---
// "Same family" = same stat + same period + same subject, per-side aggregation FOLDED to match-level. So
// name minus: settlement parenthetical, subject marker, AND the whole "by (the) home/away team" phrase —
// "Total Corners by Home Team", "...by Away Team" and "Total Corners" all key alike (siblings). The stat
// noun and the period qualifier are KEPT, so a 1st-half/extra-time market is a DIFFERENT family from the
// full match ("same period" is part of the test). Deliberately re-derived here, not imported, so the
// family label is computed independently of the grounder it is grading.
function statCore(name: string): string {
  let t = name.toLowerCase().replace(/\(settled[^)]*\)/gi, "");
  t = t.replace(/^(the\s+)?(players?|player s)\s+/, ""); // leading "Player('s) X"
  t = t.replace(/\s+by\s+(the\s+)?players?$/, ""); // trailing "X by (the) player"
  t = t.replace(/\b(by\s+(the\s+)?)?(home|away)\s+team\b/g, " "); // fold per-side aggregation to match-level
  t = t.replace(/\b(home|away)\b\s*/g, ""); // any residual side word
  return t.replace(/\s+/g, " ").trim();
}
const familyKey = (c: Criterion) => `${c.subject}::${statCore(c.name)}`;

// period-blind variant: statCore with the period qualifier ALSO removed, so a full-match grounding and a
// 1st-half/extra-time sibling of the same stat key alike. Only used as a SENSITIVITY count on top of the
// strict same-family line — it surfaces "same stat, wrong period" misses (a softer, still-related neighbour).
const periodBlind = (name: string) =>
  statCore(name)
    .replace(/\bincluding\b/g, " ")
    .replace(/\b(1st|2nd|first|second) half\b/g, " ")
    .replace(/\bextra time\b/g, " ")
    .replace(/\binterval\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const familyKeyPB = (c: Criterion) => `${c.subject}::${periodBlind(c.name)}`;

// --- parse the PROBE failing table out of the log (captured grounding results, no re-grounding) ---
// groundedIds = every id surfaced for the query (union over its selectors). confidentIds = the subset that
// came from a confident|variants selector (the grounder COMMITTED, not just shortlisted) — so a same-family
// hit can be split into "confidently grounded a sibling" vs "a sibling merely appeared in a clarify set".
type FailRow = { query: string; groundedIds: number[]; confidentIds: number[]; punt: boolean };
function parseFailRows(): FailRow[] {
  const md = readFileSync(LOG, "utf8");
  const probe = md.match(/<!-- PROBE:START -->[\s\S]*?<!-- PROBE:END -->/)?.[0] ?? "";
  const failBlock = probe.split(/### Passing queries/)[0] ?? "";
  const ids = (s: string) => [...s.matchAll(/\b(\d{7,})\b/g)].map((m) => Number(m[1]));
  const rows: FailRow[] = [];
  for (const raw of failBlock.split("\n")) {
    if (!raw.startsWith("| ✗")) continue; // data rows only (error-row continuations don't start with "| ✗")
    // | ✗ cls | query | concept | grounding |  — query/concept non-greedy; grounding is the greedy tail.
    const m = raw.match(/^\|\s*✗[^|]*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*([\s\S]*?)\s*\|\s*$/);
    if (!m) {
      // multi-line validation-error rows don't close with "|" on this line; grab the query, mark a punt.
      const e = raw.match(/^\|\s*✗[^|]*\|\s*(.*?)\s*\|/);
      if (e) rows.push({ query: (e[1] ?? "").replace(/\\\|/g, "|"), groundedIds: [], confidentIds: [], punt: true });
      continue;
    }
    const query = (m[1] ?? "").replace(/\\\|/g, "|");
    const punt = /\[unsupported\]|\[error/.test(m[2] ?? ""); // extractor produced no groundable concept
    const groundCell = m[3] ?? "";
    // split the flattened cell back into per-selector segments; a segment's tier governs all its ids.
    const confidentIds: number[] = [];
    for (const seg of groundCell.split("  ·  ")) {
      if (/\/(confident|variants)→/.test(seg)) confidentIds.push(...ids(seg));
    }
    rows.push({ query, groundedIds: ids(groundCell), confidentIds, punt });
  }
  return rows;
}

function main(): void {
  const cat = loadCatalog();
  const queries = (JSON.parse(readFileSync(QUERIES, "utf8")).queries as { id: number; q: string }[]) ?? [];
  const idByQuery = new Map(queries.map((x) => [x.q, x.id]));
  const cache: Record<string, { status?: string }> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

  const fails = parseFailRows();
  type Bucket = "same-family" | "elsewhere" | "abstained" | "punt";
  const tally: Record<Bucket, number> = { "same-family": 0, elsewhere: 0, abstained: 0, punt: 0 };
  let confidentSib = 0; // of the same-family misses, how many were a CONFIDENT sibling grounding
  let periodBlindSib = 0; // of the ELSEWHERE misses, how many are the same stat at a different period
  const sameFamily: { query: string; target: string; sib: string; confident: boolean }[] = [];
  const unmatched: string[] = [];

  for (const r of fails) {
    const targetId = idByQuery.get(r.query);
    const target = targetId != null ? cat.byId.get(targetId) : undefined;
    if (!target) {
      unmatched.push(r.query);
      continue;
    }
    // extractor punt = no groundable concept (status not "resolved", or validation error)
    const status = cache[r.query]?.status;
    if (r.punt || (status && status !== "resolved")) {
      tally.punt++;
      continue;
    }
    if (r.groundedIds.length === 0) {
      tally.abstained++;
      continue;
    }
    const want = familyKey(target);
    const isSib = (id: number) => {
      const c = cat.byId.get(id);
      return c ? familyKey(c) === want : false;
    };
    const sibId = r.groundedIds.find(isSib);
    if (sibId != null) {
      const confident = r.confidentIds.some(isSib);
      tally["same-family"]++;
      if (confident) confidentSib++;
      const sib = cat.byId.get(sibId)!;
      sameFamily.push({ query: r.query, target: `${target.id} "${target.name}"`, sib: `${sib.id} "${sib.name}"`, confident });
    } else {
      tally.elsewhere++;
      // sensitivity: of the elsewhere misses, was a surfaced id the SAME stat at a different period?
      const wantPB = familyKeyPB(target);
      if (r.groundedIds.some((id) => { const c = cat.byId.get(id); return c ? familyKeyPB(c) === wantPB : false; })) periodBlindSib++;
    }
  }

  const total = fails.length;
  const strictPass = queries.length - total; // 400 minus misses
  console.log(`\n=== Same-family diagnostic over the extractor->ground probe ===`);
  console.log(`Strict pass line (unchanged, E8-clean): ${strictPass}/${queries.length}\n`);
  console.log(`Of ${total} strict misses:`);
  console.log(`  same-family near-miss : ${tally["same-family"]}  (grounded a same stat/period/subject sibling; ${confidentSib} confidently, ${tally["same-family"] - confidentSib} in a clarify set)`);
  console.log(`  grounded elsewhere    : ${tally.elsewhere}  (committed/surfaced a DIFFERENT family; of these ${periodBlindSib} are the same stat at a different period)`);
  console.log(`  abstained (no ground) : ${tally.abstained}  (resolved, but grounding returned nothing)`);
  console.log(`  extractor punt        : ${tally.punt}  (unsupported / validation error -- no groundable concept)`);
  const accounted = tally["same-family"] + tally.elsewhere + tally.abstained + tally.punt;
  console.log(`  -- total accounted     : ${accounted}/${total}${unmatched.length ? `  (+${unmatched.length} unmatched query strings)` : ""}`);

  console.log(`\nSame-family near-misses (${sameFamily.length}) -- strict miss, but the catalog surfaced a sibling:`);
  for (const s of sameFamily) console.log(`  - [${s.confident ? "confident" : "clarify-set"}] "${s.query}"\n      target  ${s.target}\n      sibling ${s.sib}`);
  if (unmatched.length) console.log(`\n[warn] ${unmatched.length} table queries not found in queries.json: ${unmatched.slice(0, 5).join(" | ")}...`);
}

main();
