// groundMarket: the market grounding stage (decision 20). Maps a selector's text `market_concept`
// to real catalog criterion id(s) — the star hub (decision 4) — and TIERS the answer instead of
// forcing one id. Pipeline:
//   - alias fast-path: a curated `criterion_concept` alias short-circuits (confident).
//   - exact catalog-name match (layered; confident; E8-safe — matches the catalog's own names,
//     never gold accept[]). Tries the bare text, then a settlement-suffix-stripped index (reaches
//     markets that only exist as "... (Settled using Opta data)"), then — for a player subject —
//     the catalog's two registers "Player X"/"Player's X". Bare-first, so a prop ("to score")
//     matches its own name before any "player" prefix is tried.
//   - vector tail, now the decision-20 chain on an alias/name miss:
//       1. HARD subject pre-filter — restrict candidates to the query subject's bucket (the
//          load-bearing cut: a `player` query never sees team/match criterions, nor v.v.).
//       2. cosine within the bucket.
//       3. line→boType HARD gate (a numeric over/under line can only ground an over/under market;
//          a yes/no can only ground a yes/no one) + period & specificity SOFT penalties (down-rank,
//          never drop; specificity demotes a name padded with words the query never asked for).
//       4. tier by stat-type core: one clear winner (gap > ε) → `confident`; survivors sharing a
//          core → `variants` (returns ALL their ids — this is how the home/away side-split is
//          produced); a different-core rival within ε → `ambiguous` (the executor clarifies).
//   - named-team per-side divert (post-step, any method): a query naming ONE team that lands on a
//     match-level total with per-side twins ("Arsenal total goals" → match "Total Goals") is swapped
//     to the twins ("Total Goals by Home/Away Team"). No twins ("Arsenal to win") → left unchanged.
//
// Precision bias (E5): below threshold, or an unbreakable collision, never guesses a single id.
// `none` (ids: []) and `ambiguous` are both non-passes the executor/harness handle loudly.
//
// Async because the vector path awaits the embedding API. Memoized by `text|bucket|lineClass` so the
// --release reruns don't re-embed temp-0 text and so a different line (different gate) isn't aliased.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog, type Subject } from "./catalog";
import { embed, EMBED_MODEL } from "./embed";
import { normalize } from "../eval/structural-scorer";
import type { QueryPlan } from "./schema";

const HERE = dirname(fileURLToPath(import.meta.url));

type ResolvedPlan = Extract<QueryPlan, { status: "resolved" }>;
export type SubjectKind = ResolvedPlan["selectors"][number]["subject"]["kind"];
type SelectorLine = NonNullable<ResolvedPlan["selectors"][number]["line"]>;

export type GroundMethod = "alias" | "name" | "vector" | "none";
export type Tier = "confident" | "variants" | "ambiguous";

export type GroundOpts = { subjectKind?: SubjectKind; line?: SelectorLine };

export type GroundResult = {
  ids: number[]; // [] iff method === "none"
  method: GroundMethod;
  tier?: Tier; // present iff ids.length > 0
  score?: number; // adjusted cosine of the winning candidate (vector path only)
  candidates?: { id: number; name: string; score: number }[]; // in-bucket top-k, for triage
};

const NONE: GroundResult = { ids: [], method: "none" };

// ---- knobs (decision 20 "still uncalibrated"; each fails safe — abstain / over-clarify) ----
// THRESHOLD: a cosine win must clear this to count as a grounding; below it we abstain (E5).
// EPSILON: the near-tie band. A different-core rival within ε of the top → `ambiguous`, not a guess.
// PERIOD_PENALTY: a period-mismatched candidate loses this much score for ranking/tiering only.
// SPEC_PENALTY: per query-absent CONTENT word, a candidate name loses this much (ranking/tiering only)
//   — the scoped Option-1 rerank that demotes an over-specified false friend ("Any Team to win without
//   conceding a goal" for "to win the tournament"). Set to EPSILON so one unrequested content word ≈ one
//   near-tie band of doubt; SPEC_CAP ceilings it so a very long name can't be obliterated. Uncalibrated.
const THRESHOLD = 0.55;
const EPSILON = 0.03;
const PERIOD_PENALTY = 0.05;
const SPEC_PENALTY = 0.03;
const SPEC_CAP = 5;
const TOP_K = 8;

// ---- subject bucket (decision 20 step 1) ----
function bucketFor(kind?: SubjectKind): Subject | null {
  if (kind === "player") return "player";
  if (kind === "team" || kind === "either_match_team") return "team_or_match";
  // event + no-hint -> search BOTH buckets: an "event" outcome can land on a team market
  // ("Winner") OR a player award ("Golden Ball Winner"), so it must not be team-only.
  return null;
}

// ---- line → boType gate (decision 20 step 3, HARD) ----
// The betoffertypes that realize each line shape. A numeric over/under needs an over/under-style
// line type (incl. the player-occurrence line); a binary needs yes/no — or `outright`, since a
// named subject's outright (to win the group/tournament, to reach a stage) is itself a yes/no, and
// Kambi tags those markets `outright`, sometimes without `yesno`. A `selection` (HT/FT, correct
// score) has no single clean boType, so it imposes no gate. `null` = no constraint.
const NUMERIC_BOTYPES = new Set(["overunder", "asianoverunder", "playeroccurrenceline"]);
const BINARY_BOTYPES = new Set(["yesno", "outright"]);

function requiredBoTypes(line?: SelectorLine): Set<string> | null {
  if (!line) return null;
  if (line.kind === "numeric") return NUMERIC_BOTYPES;
  if (line.kind === "binary") return BINARY_BOTYPES;
  return null; // selection -> no gate
}

function lineClass(line?: SelectorLine): string {
  return line ? line.kind : "none";
}

// A candidate passes the gate if it offers a required boType — OR if its boTypeNames are unknown
// (empty), in which case we can't gate it out (fail toward keeping, consistent with the catalog's
// "leak rather than wrongly drop" stance; criterions whose only mappings were unnamed boTypes 5/15).
function passesGate(boTypeNames: string[], required: Set<string> | null): boolean {
  if (!required) return true;
  if (boTypeNames.length === 0) return true;
  return boTypeNames.some((b) => required.has(b));
}

// ---- period facet (decision 20 steps 3 & 4): text-derived, no structured field exists ----
type Period = "full" | "first_half" | "second_half" | "extra_time";

function lc(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function periodOf(text: string): Period {
  const t = lc(text);
  if (/\bincluding extra time\b|\bextra time\b|\bet\b/.test(t)) return "extra_time";
  if (/\b1st half\b|\bfirst half\b/.test(t)) return "first_half";
  if (/\b2nd half\b|\bsecond half\b/.test(t)) return "second_half";
  return "full"; // intervals/regular time fall here; they separate by core string instead
}

// ---- query-coverage specificity penalty (decision 20, Option 1 — the deferred rerank, scoped) ----
// Raw cosine rewards semantic closeness, but a long, over-specified name can out-cosine the tight true
// twin: "Any Team to win without conceding a goal" (0.584) beats "To Win The Trophy" (0.553) for the
// query "to win the tournament". Penalize a candidate for the CONTENT words in its name the query never
// mentioned — the constraints it didn't ask for ("team", "without", "conceding", "goal"). Like the period
// penalty this touches `adj` (ranking/tiering) only, never `raw` (the THRESHOLD), so it can reorder
// survivors but never drops one from the pool nor resurrects a below-threshold name — the same fail-safe
// envelope. Function words aren't content, and a word the query DID use is free, so a pure synonym swap
// ("competition"/"trophy" vs "tournament") costs ≤1 and leaves genuine twins clustered.
const SPEC_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "by", "for", "and", "or", "with", "is", "are", "be", "s", "any", "all", "their",
]);

function specificityPenalty(queryText: string, name: string): number {
  const q = new Set(lc(queryText).split(" ").filter(Boolean));
  let extra = 0;
  for (const tok of lc(stripSettle(name)).split(" ")) {
    if (!tok || SPEC_STOPWORDS.has(tok) || q.has(tok)) continue;
    extra++;
  }
  return Math.min(extra, SPEC_CAP) * SPEC_PENALTY;
}

// ---- stat-type core (decision 20 step 4) ----
// name − subject marker − home/away polarity − non-semantic (settlement-source) suffix. Period and
// the stat noun are SEMANTIC and stay, so a full-match vs a 1st-half twin keep DISTINCT cores. The
// home/away polarity is collapsed (not removed) so "...by Home Team"/"...by Away Team" share a core
// ("...by team") yet stay distinct from a no-side match total.
function statCore(name: string): string {
  let t = lc(name.replace(/\(settled[^)]*\)/gi, "")); // drop settlement-source parenthetical
  t = t.replace(/^(the\s+)?(players?|player s)\s+/, ""); // leading player subject marker
  t = t.replace(/\s+by\s+(the\s+)?players?$/, ""); // trailing "... by (the) player"
  t = t.replace(/\b(home|away)\b\s*/g, ""); // collapse side polarity, keep surrounding "by team"
  return t.replace(/\s+/g, " ").trim();
}

// statCore with the per-side OWNERSHIP phrase removed entirely, so a per-side market keys to the
// SAME string as its match-level sibling: "Total Goals by Home Team" and "Total Goals" both -> "total
// goals". (statCore alone only drops the home/away word, leaving "...by team" — distinct from the
// match total.) This is the pairing key for the named-team divert.
function baseStatCore(name: string): string {
  const stripped = name.replace(/\b(by\s+(the\s+)?)?(home|away)\s+team\b/gi, " ");
  return statCore(stripped);
}

// ---- vector index (built by `npm run build:index`, loaded once) ----
type IndexEntry = { id: number; name: string; subject: Subject; boTypeNames: string[]; vec: number[] };
type VectorIndex = { dim: number; entries: IndexEntry[]; bySubject: Record<Subject, IndexEntry[]> };

// undefined = not loaded yet; null = absent/unusable -> vector path off, alias/name paths still work.
let indexCache: VectorIndex | null | undefined;

function loadIndex(): VectorIndex | null {
  if (indexCache !== undefined) return indexCache;
  const file = join(HERE, "index", `criterion-vectors.${EMBED_MODEL}.json`);
  if (!existsSync(file)) {
    console.warn(`[ground-market] no vector index at ${file} — run \`npm run build:index\`. Vector grounding disabled.`);
    return (indexCache = null);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.model !== EMBED_MODEL) {
    console.warn(`[ground-market] index built for "${raw.model}", expected "${EMBED_MODEL}" — rebuild. Vector grounding disabled.`);
    return (indexCache = null);
  }
  // E11: a stale index vs a rebuilt catalog yields wrong ids silently — warn loudly (don't disable;
  // the operator rebuilds). We just re-embedded both, so this is a guard, not an expected path.
  const catVersion = loadCatalog().version;
  if (catVersion && raw.catalogVersion && raw.catalogVersion !== catVersion) {
    console.warn(`[ground-market] index catalogVersion "${raw.catalogVersion}" != catalog "${catVersion}" — STALE, run \`npm run build:index\`.`);
  }
  const entries = raw.criterions as IndexEntry[];
  const bySubject: Record<Subject, IndexEntry[]> = { player: [], team_or_match: [] };
  for (const e of entries) (bySubject[e.subject] ??= []).push(e);
  return (indexCache = { dim: raw.dim, entries, bySubject });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

type Scored = { id: number; name: string; raw: number; adj: number; boTypeNames: string[]; core: string };

async function vectorGround(text: string, opts: GroundOpts): Promise<GroundResult> {
  const idx = loadIndex();
  if (!idx) return NONE;
  const [qv] = await embed([text], "query");
  if (!qv) return NONE;
  if (qv.length !== idx.dim) {
    console.warn(`[ground-market] query dim ${qv.length} != index dim ${idx.dim} — rebuild index.`);
    return NONE;
  }

  const bucket = bucketFor(opts.subjectKind);
  const pool = bucket ? idx.bySubject[bucket] : idx.entries;
  const required = requiredBoTypes(opts.line);
  const qPeriod = periodOf(text);

  // score the whole bucket (raw cosine), keep top-k for triage before any gating
  const allScored = pool
    .map((e) => ({ id: e.id, name: e.name, raw: cosine(qv, e.vec), boTypeNames: e.boTypeNames }))
    .sort((a, b) => b.raw - a.raw);
  const candidates = allScored.slice(0, TOP_K).map(({ id, name, raw }) => ({ id, name, score: raw }));

  // HARD line→boType gate, then period + specificity SOFT penalties, then the threshold cut (penalties
  // touch `adj` — ranking/tiering — only; the threshold still gates on raw). `isBinary` gates the yes/no tie-break below.
  const isBinary = opts.line?.kind === "binary";
  const survivors: Scored[] = allScored
    .filter((s) => passesGate(s.boTypeNames, required))
    .map((s) => ({
      ...s,
      adj: s.raw - (periodOf(s.name) === qPeriod ? 0 : PERIOD_PENALTY) - specificityPenalty(text, s.name),
      core: statCore(s.name),
    }))
    .filter((s) => s.raw >= THRESHOLD)
    .sort((a, b) => b.adj - a.adj);

  if (survivors.length === 0) return { ids: [], method: "none", candidates };

  const top = survivors[0]!;
  const byId = loadCatalog().byId;
  const catsOf = (id: number): string[] => byId.get(id)?.categoryNames ?? [];
  const topCats = new Set(catsOf(top.id));

  // same-market cluster: identical stat-core AND ≥1 shared category (corroboration — guards an
  // accidental core-string collision from merging two genuinely different markets).
  const sameCore = survivors.filter((s) => s.core === top.core && (s.id === top.id || catsOf(s.id).some((c) => topCats.has(c))));
  const sameCoreIds = new Set(sameCore.map((s) => s.id));
  const nearestDiff = survivors.find((s) => !sameCoreIds.has(s.id));

  // a different-market rival within ε of the top is a collision → clarify, don't guess — UNLESS a yes/no
  // tie-break resolves it (binary line only): when the WHOLE near-tie cluster is outright-type and only
  // some members ALSO offer `yesno`, that subset is the truer single-subject yes/no, so prefer it (e.g.
  // "to reach the semi-finals": the `outright`-only "Teams to reach the Semi-Finals" yields to the
  // `outright`+`yesno` "To reach the Semi Final"). The `allOutright` guard is essential — it stops a
  // `yesno`-only false-friend (one that LACKS `outright`, e.g. "Any Team to win without conceding a goal"
  // for "to win the tournament") from triggering the preference and crowning itself a false confident.
  if (nearestDiff && top.adj - nearestDiff.adj <= EPSILON) {
    const cluster = survivors.filter((s) => top.adj - s.adj <= EPSILON);
    if (isBinary) {
      const yesno = cluster.filter((s) => s.boTypeNames.includes("yesno"));
      const allOutright = cluster.every((s) => s.boTypeNames.includes("outright"));
      if (allOutright && yesno.length > 0 && yesno.length < cluster.length) {
        const cores = new Set(yesno.map((s) => s.core));
        const ids = yesno.map((s) => s.id);
        const tier = cores.size > 1 ? "ambiguous" : ids.length > 1 ? "variants" : "confident";
        return { ids, method: "vector", tier, score: yesno[0]!.adj, candidates };
      }
    }
    return { ids: cluster.map((s) => s.id), method: "vector", tier: "ambiguous", score: top.adj, candidates };
  }

  const ids = sameCore.map((s) => s.id);
  return { ids, method: "vector", tier: ids.length > 1 ? "variants" : "confident", score: top.adj, candidates };
}

// ---- named-team per-side divert (decision 20, Option 1) ----
// `baseStatCore(per-side name)` -> the per-side criterion ids that realize that stat. Built once
// from the catalog's `side` tag (set by build-catalog from the "by Home/Away Team" marker).
let perSideCache: Map<string, number[]> | undefined;
function perSideIndex(): Map<string, number[]> {
  if (perSideCache) return perSideCache;
  const m = new Map<string, number[]>();
  for (const c of loadCatalog().list) {
    if (c.side == null) continue;
    const key = baseStatCore(c.name);
    const arr = m.get(key);
    if (arr) arr.push(c.id);
    else m.set(key, [c.id]);
  }
  return (perSideCache = m);
}

// A query that names ONE team ("Arsenal total goals") should resolve to that team's per-side market,
// not the whole-match total. So when a single named-team query lands cleanly on a MATCH-level
// criterion that has per-side twins (same base-core + a shared category), swap in the twins — the
// home/away side-split the executor binds to the named team. No twins (e.g. "Arsenal to win" ->
// "Winner") => unchanged, so match-/competition-level team markets are never dropped.
function applyPerSideDivert(res: GroundResult, opts: GroundOpts): GroundResult {
  if (opts.subjectKind !== "team" || res.ids.length !== 1) return res; // only a single clean hit
  const cat = loadCatalog();
  const top = cat.byId.get(res.ids[0]!);
  if (!top || top.side != null) return res; // unknown id, or already a per-side market
  const twinIds = perSideIndex().get(baseStatCore(top.name));
  if (!twinIds?.length) return res;
  const topCats = new Set(top.categoryNames);
  const ids = twinIds.filter((id) => cat.byId.get(id)?.categoryNames.some((cn) => topCats.has(cn))).sort((a, b) => a - b);
  if (!ids.length) return res;
  return { ids, method: res.method, tier: ids.length > 1 ? "variants" : "confident", candidates: res.candidates };
}

// ---- layered exact-name resolution (decision 20 step 2) ----
// Settlement-suffix strip: drop the non-semantic "(settled ...)" parenthetical (the same one
// statCore removes) so a query can exact-match a market that ONLY exists in its Opta-settled form —
// e.g. "to score or assist" -> "To Score Or Assist (Settled using Opta data)". Folds an Opta twin
// into its base market; verified to only ever merge same-market twins, never two different markets.
function stripSettle(name: string): string {
  return name.replace(/\(settled[^)]*\)/gi, "");
}

let strippedNameCache: Map<string, number[]> | undefined;
function byNameStripped(): Map<string, number[]> {
  if (strippedNameCache) return strippedNameCache;
  const m = new Map<string, number[]>();
  for (const c of loadCatalog().list) {
    const k = normalize(stripSettle(c.name));
    const arr = m.get(k);
    if (arr) arr.push(c.id);
    else m.set(k, [c.id]);
  }
  return (strippedNameCache = m);
}

// Resolve `key` to criterion id(s) by exact name, trying progressively looser forms. The catalog
// names its player stat generics "Player's X" (a query "fouls won" must become "player s fouls won"
// to hit) while props are "To X" (matched bare). So: the raw index first (bare, then the two player
// registers for a player subject), then the stripped index (same forms) to reach Opta-settled-only
// markets. Bare-first keeps a prop on its own name before any "player" prefix is tried. null = miss.
function exactNameIds(key: string, opts: GroundOpts): number[] | null {
  const forms = opts.subjectKind === "player" ? [key, `player ${key}`, `player s ${key}`] : [key];
  for (const idx of [loadCatalog().byName, byNameStripped()]) {
    for (const f of forms) {
      const ids = idx.get(f);
      if (ids?.length) return ids;
    }
  }
  return null;
}

// ---- public entry ----

const memo = new Map<string, GroundResult>();

export async function groundMarket(text: string, opts: GroundOpts = {}): Promise<GroundResult> {
  const key = normalize(text);
  if (!key) return NONE;
  // key on the raw subjectKind, not the bucket: `team` and `event` share a bucket but `team` triggers
  // the per-side divert, so they must not alias to the same memo entry.
  const memoKey = `${key}|${opts.subjectKind ?? ""}|${lineClass(opts.line)}`;
  const hit = memo.get(memoKey);
  if (hit) return hit;
  const res = applyPerSideDivert(await resolveMarket(key, text, opts), opts);
  memo.set(memoKey, res);
  return res;
}

async function resolveMarket(key: string, text: string, opts: GroundOpts): Promise<GroundResult> {
  const cat = loadCatalog();

  // 1. alias fast-path — only a criterion_concept grounds (a category/botype alias is the wrong
  // granularity and falls through to the vector path as a scope hint).
  const alias = cat.marketAliases.get(key);
  if (alias?.type === "criterion_concept") {
    const ids = cat.byName.get(normalize(alias.name)) ?? [];
    if (ids.length) return { ids, method: "alias", tier: ids.length > 1 ? "variants" : "confident" };
  }

  // 2. exact catalog-name match (layered: bare -> player registers -> settlement-stripped). E8-safe.
  const exact = exactNameIds(key, opts);
  if (exact?.length) return { ids: exact, method: "name", tier: exact.length > 1 ? "variants" : "confident" };

  // 3. vector tail — the decision-20 subject→cosine→gate→tier chain.
  return vectorGround(text, opts);
}
