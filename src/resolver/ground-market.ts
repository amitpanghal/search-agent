// groundMarket: the market grounding stage (decision 20). Maps a selector's text `market_concept`
// to real catalog criterion id(s) — the star hub (decision 4) — and TIERS the answer instead of
// forcing one id. Pipeline:
//   - EXACT alias-key fast-path: a curated `criterion_concept` alias keyed on the whole concept
//     short-circuits (confident). Only the exact key fires here.
//   - exact catalog-name match (layered; confident; E8-safe — matches the catalog's own names,
//     never gold accept[]). Tries the bare text, then a settlement-suffix-stripped index (reaches
//     markets that only exist as "... (Settled using Opta data)"), then — for a player subject —
//     the catalog's two registers "Player X"/"Player's X". Bare-first, so a prop ("to score")
//     matches its own name before any "player" prefix is tried. Runs ABOVE the subset-alias
//     fallback (decision 25): the catalog's own name outranks a loose subset alias, so a long market
//     that is itself a catalog entry ("Match to go into Extra Time") is never shadowed by a shorter
//     subset alias ("extra time" -> "Extra Time").
//   - subset-alias fallback: the most-specific `criterion_concept` alias whose key-tokens are all in
//     the concept ("to score a brace" -> "brace") fires only after the exact paths miss.
//   - vector tail, now the decision-20 chain on an alias/name miss:
//       1. HARD subject pre-filter — restrict candidates to the query subject's bucket (the
//          load-bearing cut: a `player` query never sees team/match criterions, nor v.v.).
//       2. cosine within the bucket, then an IDF-weighted lexical token-cover BONUS folded in (gateScore =
//          cosine + bonus): a candidate whose name literally contains the query's RARE content tokens is
//          boosted, so a token-identical near-miss ("goal in stoppage time" ⊆ "Goal scored - Stoppage
//          Time") the raw cosine under-scores can still clear threshold. The bonus only adds — never drops
//          a confident hit. Alongside, a BM25 retrieval channel nominates the top lexical names into the
//          pool — surfacing a true market cosine ranked below the candidate cut (Q23) — but a cold nominee
//          can reach at most the `shortlist` tier, so this added recall never mints a false confident.
//       3. (Ranking is cosine + the lexical bonus only. The period / specificity / scope / line→boType
//          penalties and the period-collapse + outright/yesno tie-break were REMOVED 2026-06-11 — an
//          ablation over the 346-query set showed all six net-harmful or inert; see scripts/ablate-layers.ts.)
//       4. tier by stat-type core: one clear winner (gap > ε) → `confident`; survivors sharing a
//          core → `variants` (returns ALL their ids — this is how the home/away side-split is
//          produced); a different-core rival within ε → `ambiguous` (the executor clarifies).
//       5. recall floor: if nothing cleared THRESHOLD but the best is ≥ FLOOR, return the top-few as a
//          `shortlist` (clarify) instead of abstaining; only below FLOOR do we return `none`.
//   - named-team per-side divert (post-step, any method): a query naming ONE team that lands on a
//     match-level total with per-side twins ("Arsenal total goals" → match "Total Goals") is swapped
//     to the twins ("Total Goals by Home/Away Team"). No twins ("Arsenal to win") → left unchanged.
//
// Precision bias (E5): on an unbreakable collision, or below FLOOR, never guesses a single id. Three
// non-confident outcomes the executor/harness handle loudly: `ambiguous` (a near-tie), `shortlist` (a
// sub-threshold recall-floor set), and `none` (ids: [], below FLOOR — a genuine abstain).
//
// Async because the vector path awaits the embedding API. Memoized by `text|bucket|lineClass` so the
// --release reruns don't re-embed temp-0 text and so a different line (different gate) isn't aliased.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog, catalogSubset, type Subject, type Catalog, type MarketAlias, type Level } from "./catalog";
import { eligibleCombos } from "./combos";
import { embed, EMBED_MODEL } from "./embed";
import { normalize } from "../eval/structural-scorer";
import type { QueryPlan } from "./schema";

const HERE = dirname(fileURLToPath(import.meta.url));

type ResolvedPlan = Extract<QueryPlan, { status: "resolved" }>;
export type SubjectKind = ResolvedPlan["selectors"][number]["subject"]["kind"];
type SelectorLine = NonNullable<ResolvedPlan["selectors"][number]["line"]>;

export type GroundMethod = "alias" | "name" | "vector" | "none" | "main" | "combo";
// `shortlist` is the recall-floor tier: below the confident THRESHOLD but above FLOOR we return the
// top-few candidates for the executor to clarify against, instead of silently abstaining. Like
// `ambiguous` it is a non-pass (the scorer greens only confident|variants), but it carries up to
// SHORTLIST_CAP ids, not a near-tie cluster.
export type Tier = "confident" | "variants" | "ambiguous" | "shortlist";

// Ablation switches (MEASUREMENT ONLY; default undefined = every layer ON = production behavior). Each
// flag DISABLES one post-cosine layer so scripts/ablate-layers.ts can measure its contribution. The 6
// net-harmful/inert layers found by the 2026-06-11 ablation were since DELETED (specificity, scope,
// yesno-tiebreak, period-penalty, line-gate, period-collapse); only the two survivors stay toggleable.
export type AblationFlag = "lexical" | "bm25";
export type GroundOpts = { subjectKind?: SubjectKind; line?: SelectorLine; level?: Level; period?: Period; side?: "home" | "away"; ablate?: Set<AblationFlag> };

export type GroundResult = {
  ids: number[]; // [] iff method is "none" or "main"
  method: GroundMethod;
  tier?: Tier; // present iff ids.length > 0
  score?: number; // adjusted cosine of the winning candidate (vector path only)
  candidates?: { id: number; name: string; score: number }[]; // in-bucket top-k, for triage
};

const NONE: GroundResult = { ids: [], method: "none" };
// Marketless sentinel: the extractor emits market_concept "main" when a query names no market. It is
// NOT a static catalog criterion — the executor resolves it to each event's main betoffer — so we
// short-circuit here rather than vector-search "main" into junk. Distinct from NONE (a real miss).
const MAIN: GroundResult = { ids: [], method: "main" };

// ---- knobs (decision 20 "still uncalibrated"; each fails safe — abstain / over-clarify) ----
// THRESHOLD: a cosine win must clear this to count as a grounding; below it we abstain (E5).
// EPSILON: the near-tie band. A different-core rival within ε of the top → `ambiguous`, not a guess.
// (The period / specificity / scope / line→boType penalties were REMOVED 2026-06-11 — an ablation over the
// 346-query set showed they were net-harmful or inert; dropping all six = +8 recall, flat precision. See
// scripts/ablate-layers.ts. Ranking is now cosine + the lexical bonus only.)
const THRESHOLD = 0.55;
const EPSILON = 0.03;
const TOP_K = 8;
// Recall floor (the shortlist band): a gateScore in [FLOOR, THRESHOLD) returns the top-SHORTLIST_CAP
// candidates as a `shortlist` (clarify) instead of `none`; below FLOOR we still abstain. FLOOR is set
// low because score alone can't separate a present near-miss (match result ~0.41) from a plausible-but-
// absent one (corners ~0.38) — we lean to surfacing, accepting a weak shortlist the executor rejects.
const FLOOR = 0.35;
const SHORTLIST_CAP = 3;
// Lexical token-cover bonus: raw cosine under-weights exact token matches, so a candidate whose name
// contains the query's content tokens ("goal in stoppage time" ⊆ "Goal scored - Stoppage Time") is
// boosted by up to LEX_WEIGHT. Added to gateScore (raw + bonus), so it can only PROMOTE — never drop a
// confident hit. Bounded, so a full-cover false friend at low cosine still can't manufacture a confident.
// The cover is now IDF-WEIGHTED (corpusStats): a rare distinctive token ("stoppage" — 15 names) counts
// far more than a common one ("team" — 557), so the bonus tracks meaningful overlap, not word count.
const LEX_WEIGHT = 0.1;
// BM25 pool-expansion (the recall channel). A sparse BM25 retrieval runs ALONGSIDE cosine and nominates
// its top names into the candidate pool — even ones whose cosine fell below the raw≥FLOOR−LEX_WEIGHT cut
// (the Q23 "to score first" → "Team to score First Goal in respective match" recall miss, cosine < 0.25).
// A nominee is admitted past the FLOOR only if it covers ≥ LEX_COVER_FLOOR of the query's IDF mass, and it
// can reach at most the `shortlist` tier (its cold cosine keeps gate < THRESHOLD) — recall never mints a
// confident. Set high (near-full cover) so a PARTIAL rare-token match can't sneak in: a crossbar market
// whose boilerplate "(which does not result in a goal)" matches only "result" for the query "match result"
// covers 0.70 — below this — so it's excluded and the cosine candidate (Match Odds) keeps the shortlist.
// BM25_K1/B are the standard term-saturation/length-norm knobs (mild on 3–5 word names).
const LEX_COVER_FLOOR = 0.8;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ---- subject bucket (decision 20 step 1) ----
function bucketFor(kind?: SubjectKind): Subject | null {
  if (kind === "player") return "player";
  if (kind === "team" || kind === "either_match_team") return "team_or_match";
  // event + no-hint -> search BOTH buckets: an "event" outcome can land on a team market
  // ("Winner") OR a player award ("Golden Ball Winner"), so it must not be team-only.
  return null;
}

// `line` no longer gates grounding (the line→boType soft penalty was removed in the 2026-06-11 ablation
// cleanup); it survives only as a memo-key component so a different line shape doesn't alias a cache entry.
function lineClass(line?: SelectorLine): string {
  return line ? line.kind : "none";
}

// Level eligibility, shared by every resolution path (vector pool, name/alias hits, per-side twins):
// a candidate passes when the query named no level, or its observed level is unobserved (unset) or
// equals the query's. Only the OPPOSITE concrete level is excluded — fixture never sees competition,
// and vice-versa. No-op when the query carries no level.
const levelOk = (cand: Level | undefined, want: Level | undefined): boolean => !want || cand == null || cand === want;
const keepLevel = (ids: number[], cat: Catalog, want: Level | undefined): number[] =>
  ids.filter((id) => levelOk(cat.byId.get(id)?.level, want));

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

// period-stripped stat core: statCore with the period qualifier removed, so a market and its OWN period
// variant share a key ("offside infringements - Including Extra Time" ≡ "offside infringements"). Exported
// for scripts/gen-doc-views.ts (cluster keying); the in-grounder period-collapse that used it was removed.
export function periodCore(name: string): string {
  return statCore(name)
    .replace(/\bincluding\b/g, " ")
    .replace(/\b(1st|2nd|first|second) half\b/g, " ")
    .replace(/\bextra time\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Function-word stoplist for the lexical channel: tokens that carry no content, dropped from the IDF
// token-cover and BM25 so only meaningful words count. (Also formerly fed a specificity penalty, removed
// in the 2026-06-11 ablation cleanup — it demoted real golds more than false friends, costing net recall.)
const SPEC_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "by", "for", "and", "or", "with", "is", "are", "be", "s", "any", "all", "their",
]);

// ---- lexical token cover (the lexical booster) + BM25 retrieval (the recall channel) ----
// Both read the query's CONTENT tokens (stopwords dropped, lightly singularized). Symmetric stem (drop a
// trailing "s" on tokens >3 chars) so assist≈assists, card≈cards.
function stem(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}
// The catalog spells the same concept two ways — "Top Goal Scorer" (15 names) vs "...Top Goalscorer" (29) —
// so a one-word query token must split to match the two-word names. Decompound the known football compounds
// so the IDF cover and BM25 see the same tokens on both sides. Fixes a real catalog inconsistency, not one
// query: without it "top goalscorer" under-covers the true "Top Goal Scorer".
const DECOMPOUND: Record<string, string[]> = { goalscorer: ["goal", "scorer"], goalscorers: ["goal", "scorer"] };
function tokenize(s: string): string[] {
  return lc(stripSettle(s)).split(" ").filter(Boolean).flatMap((t) => DECOMPOUND[t] ?? [t]);
}
function contentTokens(s: string): Set<string> {
  return new Set(tokenize(s).filter((t) => !SPEC_STOPWORDS.has(t)).map(stem));
}

// Corpus statistics for the lexical channel (IDF + BM25's avg doc length), memoized over criterion names.
// Raw cosine has no notion of word RARITY — matching "team" (in 557 names) and "stoppage" (in 15) score
// the same. IDF fixes that. Each criterion name is one "document"; df is over the stemmed content tokens,
// so the booster, the BM25 score and df all tokenize identically. Global (whole catalog, not per-bucket):
// rarity is a corpus property. Smoothed idf = log((N+1)/(df+0.5)); an unseen query token gets the maximal
// weight (it's maximally distinctive). avgdl feeds BM25's length normalization.
type CorpusStats = { idf: Map<string, number>; avgdl: number; maxIdf: number };
let corpusCache: CorpusStats | undefined;
function corpusStats(): CorpusStats {
  if (corpusCache) return corpusCache;
  const names = loadCatalog().list;
  const N = names.length || 1;
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const c of names) {
    const toks = contentTokens(c.name);
    totalLen += toks.size;
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 0.5)));
  return (corpusCache = { idf, avgdl: totalLen / N, maxIdf: Math.log((N + 1) / 0.5) });
}
function idfWeight(t: string): number {
  const { idf, maxIdf } = corpusStats();
  return idf.get(t) ?? maxIdf;
}

// IDF-weighted token cover: the share of the QUERY's IDF mass the candidate name covers. Replaces the old
// flat fraction so a rare distinctive token ("stoppage", "nil") dominates a common one ("team", "match").
// Stays in 0..1, so `LEX_WEIGHT * cover` is a bounded nudge in cosine units — the confident THRESHOLD is
// still anchored on cosine, never manufactured by lexical overlap alone. Rescues "goal in stoppage time"
// against "Goal scored - Stoppage Time" where raw cosine stalls below threshold.
// IDF cover: the share of the WANT set's IDF mass that the HAVE set covers (0..1). Shared by the per-candidate
// lexical booster (lexicalCover: want = query tokens, have = candidate name) and the combo-assembly pass
// (assembleCombos: want = combo core tokens, have = pooled leg tokens).
function idfCover(have: Set<string>, want: Set<string>): number {
  if (!want.size) return 0;
  let num = 0;
  let den = 0;
  for (const t of want) {
    const w = idfWeight(t);
    den += w;
    if (have.has(t)) num += w;
  }
  return den === 0 ? 0 : num / den;
}

function lexicalCover(queryText: string, name: string): number {
  return idfCover(contentTokens(name), contentTokens(queryText));
}

// BM25 over criterion names — the sparse RETRIEVAL channel running alongside cosine. Cosine ranks by
// meaning; BM25 ranks by rare-word overlap, so it surfaces a true market whose NAME literally contains the
// query's words even when cosine buried it below the candidate cut (Q23). Its top-K NOMINATE candidates
// into the pool; it never sets the grounding score (that stays cosine + bounded idf-cover), so it can only
// ADD recall. Standard BM25(k1,b); on short names TF≈1 and length-norm is mild, so it tracks idf-cover
// closely but stays faithful/robust if names lengthen.
function bm25(queryTokens: Set<string>, name: string): number {
  const { avgdl } = corpusStats();
  const doc = contentTokens(name);
  const dl = doc.size || 1;
  let score = 0;
  for (const t of queryTokens) {
    if (!doc.has(t)) continue; // deduped tokens → tf = 1
    score += (idfWeight(t) * (BM25_K1 + 1)) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
  }
  return score;
}

// ---- stat-type core (decision 20 step 4) ----
// name − subject marker − home/away polarity − non-semantic (settlement-source) suffix. Period and
// the stat noun are SEMANTIC and stay, so a full-match vs a 1st-half twin keep DISTINCT cores. The
// home/away polarity is collapsed (not removed) so "...by Home Team"/"...by Away Team" share a core
// ("...by team") yet stay distinct from a no-side match total.
export function statCore(name: string): string {
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
  // Index follows the catalog subset (CATALOG_SUBSET, default off): drop vectors for any id the
  // restricted catalog no longer carries, so the cosine/BM25 pool sees the same smaller market set.
  const subset = catalogSubset();
  const entries = (raw.criterions as IndexEntry[]).filter((e) => !subset || subset.has(e.id));
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

type Scored = { id: number; name: string; raw: number; gate: number; adj: number; boTypeNames: string[]; core: string; cover: number; bm25: number };

// Query-embedding cache (keyed by the embedded text). Embeddings are deterministic per text+model, so
// this is harmless in production; it lets the ablation harness re-ground the same concept across many
// layer-configs with a SINGLE Voyage pass (one embed per unique concept, reused by every variant).
const qEmbedCache = new Map<string, number[]>();
async function embedQuery(text: string): Promise<number[] | undefined> {
  const hit = qEmbedCache.get(text);
  if (hit) return hit;
  const [qv] = await embed([text], "query");
  if (qv) qEmbedCache.set(text, qv);
  return qv;
}

async function vectorGround(text: string, opts: GroundOpts): Promise<GroundResult> {
  const idx = loadIndex();
  if (!idx) return NONE;
  const qv = await embedQuery(text);
  if (!qv) return NONE;
  if (qv.length !== idx.dim) {
    console.warn(`[ground-market] query dim ${qv.length} != index dim ${idx.dim} — rebuild index.`);
    return NONE;
  }

  const byId = loadCatalog().byId;
  const bucket = bucketFor(opts.subjectKind);
  const pool0 = bucket ? idx.bySubject[bucket] : idx.entries;
  // Drop candidates at the opposite concrete level (see levelOk) before any scoring.
  const pool = opts.level ? pool0.filter((e) => levelOk(byId.get(e.id)?.level, opts.level)) : pool0;

  // score the whole bucket (raw cosine), keep top-k for triage before any gating
  const allScored = pool
    .map((e) => ({ id: e.id, name: e.name, raw: cosine(qv, e.vec), boTypeNames: e.boTypeNames }))
    .sort((a, b) => b.raw - a.raw);
  const candidates = allScored.slice(0, TOP_K).map(({ id, name, raw }) => ({ id, name, score: raw }));

  // BM25 retrieval channel: rank the whole bucket by sparse rare-word overlap and nominate its top-K, so a
  // lexically-strong true market the cosine ranked below the candidate cut still enters the pool (recall).
  // Nominees are admitted past the raw pre-filter and the FLOOR below, but their cold cosine keeps gate <
  // THRESHOLD — they can reach `shortlist`, never `confident`, so recall can't manufacture a false confident.
  const qTokens = contentTokens(text);
  const nominees = opts.ablate?.has("bm25")
    ? new Set<number>()
    : new Set(
        pool
          .map((e) => ({ id: e.id, s: bm25(qTokens, e.name) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, TOP_K)
          .map((x) => x.id),
      );

  // Score = raw cosine + the IDF-weighted lexical-cover bonus (promotes a token-identical near-miss the
  // cosine under-scores, e.g. "goal in stoppage time" ⊆ "Goal scored - Stoppage Time"). `adj` (ranking) now
  // equals `gate` — the period/specificity/scope/line→boType penalties were removed (2026-06-11 ablation:
  // net-harmful or inert). The confident cut is on `gate` (the lexical bonus can lift a near-miss over
  // THRESHOLD); the recall floor keeps [FLOOR, THRESHOLD) as a shortlist; below FLOOR we abstain. A candidate
  // enters if cosine is warm (raw ≥ FLOOR−LEX_WEIGHT) OR it's a BM25 nominee; the FLOOR then admits a cold
  // nominee only when it covers ≥ LEX_COVER_FLOOR of the query's IDF mass (a strong literal match to clarify).
  const gated: Scored[] = allScored
    .filter((s) => s.raw >= FLOOR - LEX_WEIGHT || nominees.has(s.id))
    .map((s) => {
      const cover = lexicalCover(text, s.name);
      const bonus = opts.ablate?.has("lexical") ? 0 : LEX_WEIGHT * cover;
      const gate = s.raw + bonus;
      return { ...s, cover, bm25: bm25(qTokens, s.name), gate, adj: gate, core: statCore(s.name) };
    })
    .filter((s) => s.gate >= FLOOR || (nominees.has(s.id) && s.cover >= LEX_COVER_FLOOR))
    .sort((a, b) => b.adj - a.adj);

  if (gated.length === 0) return { ids: [], method: "none", candidates };

  // recall floor: nothing cleared the confident THRESHOLD → return the top-few as a `shortlist` (clarify),
  // neither a guess nor silence. A STRONG lexical rescue (near-full IDF cover ≥ LEX_COVER_FLOOR — a true
  // market the cosine buried, Q23) leads the clarify set; everything else is ordered by cosine-anchored adj.
  // So a partial-cover rare-token false friend ("...does not result in a goal" for "match result", cover
  // 0.70) can't hijack the shortlist, while a full-cover buried market still surfaces. Capped at SHORTLIST_CAP.
  const confident = gated.filter((s) => s.gate >= THRESHOLD);
  if (confident.length === 0) {
    // Strong rescues lead, but ORDER WITHIN each group by its trustworthy signal: a strong group (near-full
    // cover) is a lexical collision where cosine is unreliable ("to score first" hits ~8 score-first markets
    // at cover 1.0), so order it by BM25 — the most exact name leads. The non-strong group has no real lexical
    // signal ("match result"), so order it by cosine-anchored adj. This keeps Match Odds atop its shortlist
    // while letting the score-first family lead theirs, most-exact first.
    // Period is now folded into the embed text (withPeriod), so period-matched candidates already lead on
    // cosine/adj — no separate period tie-break needed. Strong rescues still lead, ordered by BM25.
    const strong = (s: Scored) => s.cover >= LEX_COVER_FLOOR;
    const ranked = [...gated]
      .sort((a, b) =>
        strong(a) !== strong(b)
          ? strong(a) ? -1 : 1
          : strong(a) ? b.bm25 - a.bm25 : b.adj - a.adj,
      )
      .slice(0, SHORTLIST_CAP);
    return { ids: ranked.map((s) => s.id), method: "vector", tier: "shortlist", score: ranked[0]!.adj, candidates };
  }

  const top = confident[0]!;
  const catsOf = (id: number): string[] => byId.get(id)?.categoryNames ?? [];
  const topCats = new Set(catsOf(top.id));

  // same-market cluster: identical stat-core AND ≥1 shared category (corroboration — guards an
  // accidental core-string collision from merging two genuinely different markets).
  const sameCore = confident.filter((s) => s.core === top.core && (s.id === top.id || catsOf(s.id).some((c) => topCats.has(c))));
  const sameCoreIds = new Set(sameCore.map((s) => s.id));
  const nearestDiff = confident.find((s) => !sameCoreIds.has(s.id));

  // a different-market rival within ε of the top is a collision → clarify, don't guess (the outright/yesno
  // tie-break that used to resolve some of these was removed in the 2026-06-11 ablation cleanup — inert).
  if (nearestDiff && top.adj - nearestDiff.adj <= EPSILON) {
    const cluster = confident.filter((s) => top.adj - s.adj <= EPSILON);
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

// A query about a team's side-specific stat ("Arsenal total goals", "Brazil to win to nil") should
// resolve to the per-side home/away twins, which the executor binds to the right side. Two paths,
// both gated to a team-ish subject (a named `team` OR a bare `either_match_team`):
//   (a) SWAP — a clean single MATCH-level hit that has per-side twins (same base-core + a shared
//       category) is replaced by those twins ("total goals" -> Total Goals by Home/Away Team).
//   (b) DIRECT — a stat that exists ONLY per-side, with no match-level sibling to land on first
//       ("to win to nil"): match the concept's base-core straight against the per-side index, so the
//       twins are reachable even though the match-level resolution returned none.
// No twins ("Arsenal to win" -> "Winner") => unchanged, so match-level team markets aren't dropped.
function applyPerSideDivert(res: GroundResult, key: string, opts: GroundOpts): GroundResult {
  if (opts.subjectKind !== "team" && opts.subjectKind !== "either_match_team") return res;
  const cat = loadCatalog();

  // Narrow per-side twins to the query: drop the wrong level (hard), then to the named side ("home
  // team" -> home only); with no side named ("Arsenal" — could be either) keep both for the executor to
  // bind. Side falls back to all if the tag is missing, so a mis-tagged twin is never dropped to nothing.
  const pick = (ids: number[]): number[] => {
    const lvl = keepLevel(ids, cat, opts.level);
    if (!opts.side) return lvl;
    const only = lvl.filter((id) => cat.byId.get(id)?.side === opts.side);
    return only.length ? only : lvl;
  };
  // Same-category per-side twins of a match-level market (shared category = corroboration guard),
  // narrowed to the named side. [] if the market is already per-side or has no twins.
  const twinsOf = (id: number): number[] => {
    const m = cat.byId.get(id);
    if (!m || m.side != null) return [];
    const twinIds = perSideIndex().get(baseStatCore(m.name));
    if (!twinIds?.length) return [];
    const mCats = new Set(m.categoryNames);
    return pick(twinIds.filter((t) => cat.byId.get(t)?.categoryNames.some((cn) => mCats.has(cn))));
  };

  // (a) swap a clean confident match-level hit for its per-side twins.
  if (res.ids.length === 1 && res.tier !== "shortlist") {
    const ids = twinsOf(res.ids[0]!).sort((a, b) => a - b);
    if (!ids.length) return res;
    return { ids, method: res.method, tier: ids.length > 1 ? "variants" : "confident", candidates: res.candidates };
  }

  // (b) per-side-only stat with no match-level sibling: match the concept's base-core directly.
  if (res.ids.length === 0) {
    const twinIds = perSideIndex().get(baseStatCore(key));
    if (twinIds?.length) {
      const ids = pick([...twinIds]).sort((a, b) => a - b);
      if (ids.length) return { ids, method: "name", tier: ids.length > 1 ? "variants" : "confident", candidates: res.candidates };
    }
  }

  // (c) shortlist: the base is unsure but a team WAS the subject — surface the per-side twins of any
  // shortlisted market that has them, staying a shortlist (no false confidence) so the side variant the
  // executor needs is in the candidate set. Fires only when it actually introduces a per-side market.
  if (res.tier === "shortlist") {
    const out = res.ids.flatMap((id) => { const t = twinsOf(id); return t.length ? t : [id]; });
    const ids = [...new Set(out)];
    if (ids.some((id) => cat.byId.get(id)?.side != null)) return { ...res, ids };
  }
  return res;
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

// ---- recall-ceiling instrumentation (additive; NOT in any grounding path) ----
// Embed the query and return the FULL in-bucket cosine ranking — every candidate the vector tail could
// ever see, in raw-cosine order, with NO gate/tier/penalty applied. A probe reads the gold's rank here to
// measure recall@k: the ceiling a doc-view (embedding enrichment) could win, since enrichment only reorders
// this cosine ranking. Mirrors vectorGround's scoring head (same bucket, same raw cosine) so the ranking is
// faithful, but is a separate read-only function — it never affects what groundMarket returns. `event`/no
// hint scores BOTH buckets, exactly like the live pool. Abbrevs are expanded so the query text matches the
// live path. Returns [] if the index/embedding is unavailable.
export async function candidatePool(text: string, opts: GroundOpts = {}): Promise<{ id: number; name: string; score: number }[]> {
  const idx = loadIndex();
  if (!idx) return [];
  const [qv] = await embed([expandAbbrevs(text, loadCatalog().abbreviations)], "query");
  if (!qv || qv.length !== idx.dim) return [];
  const pool = bucketFor(opts.subjectKind) ? idx.bySubject[bucketFor(opts.subjectKind)!] : idx.entries;
  return pool
    .map((e) => ({ id: e.id, name: e.name, score: cosine(qv, e.vec) }))
    .sort((a, b) => b.score - a.score);
}

// ---- public entry ----

const memo = new Map<string, GroundResult>();

// Whole-word acronym expansion (sport betting vocabulary lives in the grounding layer, not the
// sport-agnostic extractor prompt). "second-half BTTS" → "second half both teams to score" so the
// opaque acronym reaches the right family; the period facet then picks the 2nd-half variant. Only
// rewrites when a token actually expands, so non-acronym concepts pass through unchanged.
function expandAbbrevs(text: string, abbr: Catalog["abbreviations"]): string {
  if (!abbr.size) return text;
  const toks = normalize(text).split(" ").filter(Boolean);
  if (!toks.some((t) => abbr.has(t))) return text;
  return toks.map((t) => abbr.get(t) ?? t).join(" ");
}

// Fold the extractor's period facet back into the embed text. The catalog carries period in the NAME
// string ("Correct Score - 2nd Half"); the plan carries it in a separate field — so a bare concept
// ("correct score") cosine-ties its full-match twin and the period never breaks the tie. Appending the
// period value (the enum's own words, e.g. "second_half" -> "second half") lets the period-specific name
// out-cosine its full-match sibling. No-op when no period is emitted or it's `full` (whole match).
function withPeriod(text: string, period?: Period): string {
  return period && period !== "full" ? `${text} ${period.replace(/_/g, " ")}` : text;
}

export async function groundMarket(text: string, opts: GroundOpts = {}): Promise<GroundResult> {
  const expanded = expandAbbrevs(withPeriod(text, opts.period), loadCatalog().abbreviations);
  const key = normalize(expanded);
  if (!key) return NONE;
  if (key === "main") return MAIN; // marketless sentinel → executor's main betoffer; never vector-grounds
  // key on the raw subjectKind, not the bucket: `team` and `event` share a bucket but `team` triggers
  // the per-side divert, so they must not alias to the same memo entry. period + level are in the key for
  // the same reason: both feed `adj` (period & scope penalties), so the same concept/subject/line at a
  // different period or fixture/competition level is a different grounding and must not share a cache entry.
  const ablateKey = opts.ablate?.size ? [...opts.ablate].sort().join(",") : "";
  const memoKey = `${key}|${opts.subjectKind ?? ""}|${lineClass(opts.line)}|${opts.period ?? ""}|${opts.level ?? ""}|${opts.side ?? ""}|${ablateKey}`;
  const hit = memo.get(memoKey);
  if (hit) return hit;
  const res = applyPerSideDivert(await resolveMarket(key, expanded, opts), key, opts);
  memo.set(memoKey, res);
  return res;
}

// Token-subset alias fallback: the most-specific criterion_concept alias whose every key-token
// appears in the concept's tokens. Single-token keys ("brace") match the exact token only
// ("braces" ≠ "brace"), so the curated, distinctive keys can't over-fire. criterion_concept only.
// Level-scoped aliases (decision 23) are EXACT-only — skipped here — so "to win" can't subset-steal
// "to win to nil" (which must reach the per-side Win-to-Nil divert, not Match Odds).
function subsetAlias(cat: Catalog, key: string): MarketAlias | undefined {
  const tokens = new Set(key.split(" ").filter(Boolean));
  if (!tokens.size) return undefined;
  let best: { alias: MarketAlias; n: number } | undefined;
  for (const [k, alias] of cat.marketAliases) {
    if (alias.type !== "criterion_concept" || alias.level != null) continue;
    const kt = k.split(" ").filter(Boolean);
    if (kt.length && kt.every((t) => tokens.has(t)) && (!best || kt.length > best.n)) {
      best = { alias, n: kt.length };
    }
  }
  return best?.alias;
}

async function resolveMarket(key: string, text: string, opts: GroundOpts): Promise<GroundResult> {
  const cat = loadCatalog();

  // Resolve a criterion_concept alias to id(s), honoring its level scope (decision 23): a level-scoped
  // alias fires only when the query's level matches — "to win" -> Match Odds for a fixture, but stays a
  // tournament-outright cosine for a competition (or unknown level). A non-criterion_concept alias is the
  // wrong granularity (a category/botype scope hint), so it resolves to nothing here and falls through.
  const aliasIds = (a: MarketAlias | undefined): number[] =>
    a?.type === "criterion_concept" && (a.level == null || a.level === opts.level) ? cat.byName.get(normalize(a.name)) ?? [] : [];

  // 1. EXACT alias-key fast-path — a curated bare-phrase alias short-circuits (confident). Only the exact
  // key fires here; the token-subset fallback is deferred to step 3 so it can never outrank an exact name.
  const exactAlias = keepLevel(aliasIds(cat.marketAliases.get(key)), cat, opts.level);
  if (exactAlias.length) return { ids: exactAlias, method: "alias", tier: exactAlias.length > 1 ? "variants" : "confident" };

  // 2. exact catalog-name match (layered: bare -> player registers -> settlement-stripped). E8-safe.
  // The catalog's OWN name outranks a loose subset alias (decision 25): a long market that is itself a
  // catalog entry ("Match to go into Extra Time") must ground to itself, never be shadowed by a shorter
  // subset alias ("extra time" -> "Extra Time"). Putting exact-name above the subset fallback enforces that.
  const exact = keepLevel(exactNameIds(key, opts) ?? [], cat, opts.level);
  if (exact.length) return { ids: exact, method: "name", tier: exact.length > 1 ? "variants" : "confident" };

  // 3. subset-alias fallback — the most-specific criterion_concept alias whose every key-token appears in
  // the concept ("to score a brace" -> key "brace"); most-specific (most key-tokens) wins. Fires only now
  // that no exact alias key and no exact catalog name matched, so a curated phrasing still resolves while
  // the catalog's own names keep precedence.
  const subset = keepLevel(aliasIds(subsetAlias(cat, key)), cat, opts.level);
  if (subset.length) return { ids: subset, method: "alias", tier: subset.length > 1 ? "variants" : "confident" };

  // 4. vector tail — the decision-20 subject→cosine→gate→tier chain.
  return vectorGround(text, opts);
}

// ---- combined-market assembly (Sprint 7) ----
// The extractor is catalog-blind and splits a top-level "X and Y" into one selector per leg, so a combined
// catalog row ("Home Team to Win and Both Teams To Score") is never reached by per-leg grounding. This pass
// re-surfaces it from the catalog — no extractor change, no live-menu fetch, no re-embed. It is ADDITIVE
// (returned alongside the legs), driven by the small ever-offered combo set (`eligibleCombos`, registry-
// filtered so the ~288 legacy combo rows can't leak), matched by IDF token cover over the legs.

// One eligible combo: its outcome id(s) and the side-stripped core tokens its name reduces to. Per-side combos
// ("…Win and BTTS" home/away) collapse to a single entry holding both twin ids — paired via the existing
// per-side divert index (`perSideIndex`), so no new side logic.
type ComboEntry = { ids: number[]; core: Set<string> };
let comboIndexCache: ComboEntry[] | undefined;
function comboIndex(): ComboEntry[] {
  if (comboIndexCache) return comboIndexCache;
  const seen = new Set<string>();
  const out: ComboEntry[] = [];
  for (const { id, name } of eligibleCombos()) {
    const core = baseStatCore(name); // drops the "Home/Away Team" prefix so twins share a key
    const twins = perSideIndex().get(core);
    const ids = (twins?.length ? [...twins] : [id]).sort((a, b) => a - b);
    const key = ids.join(",");
    if (seen.has(key)) continue; // the home + away rows reduce to the same core → one entry
    seen.add(key);
    out.push({ ids, core: contentTokens(core) });
  }
  return (comboIndexCache = out);
}

// Surface any eligible combined market whose side-stripped core is (near-)fully covered by the UNION of the
// query's leg concepts. Gated to ≥2 legs (a 1-selector query that IS a combo grounds normally through the
// name/vector path) and the LEX_COVER_FLOOR near-full-cover bar — so the legs that justify the combo must
// actually be present (a lone "both teams to score" can't covet "…Win and BTTS": the "win" tokens are
// missing). Per-side combos return their home/away twin pair as `variants`; the executor binds the side
// against the live event, exactly like decision-20's per-side divert. Pure token cover — no embed.
// The leg token pool the combo cover is measured against. A NEGATED leg ("no draw") must not seed a positive
// combo — its tokens are dropped, so "no draw and both teams score" can't match "Draw and BTTS" on the bare
// token "draw". (Token cover is blind to polarity; this is the one principled exception.)
const NEGATION = /^(no|not|without)\b/i;
function comboPool(legConcepts: string[]): Set<string> {
  const pool = new Set<string>();
  for (const c of legConcepts) {
    if (NEGATION.test(c.trim())) continue;
    for (const t of contentTokens(c)) pool.add(t);
  }
  return pool;
}

export function assembleCombos(legConcepts: string[]): GroundResult[] {
  if (legConcepts.length < 2) return [];
  const pool = comboPool(legConcepts);
  const out: GroundResult[] = [];
  for (const combo of comboIndex()) {
    if (idfCover(pool, combo.core) >= LEX_COVER_FLOOR) {
      out.push({ ids: combo.ids, method: "combo", tier: combo.ids.length > 1 ? "variants" : "confident" });
    }
  }
  return out;
}

// Diagnostic (probe/tuning only; NOT in any grounding path): the IDF cover of EVERY eligible combo by the
// leg pool, gate aside — so a probe can see the separation between a true combo and the near-miss tail and
// validate the LEX_COVER_FLOOR bar. Read-only.
export function comboCovers(legConcepts: string[]): { ids: number[]; cover: number }[] {
  const pool = comboPool(legConcepts);
  return comboIndex().map((combo) => ({ ids: combo.ids, cover: idfCover(pool, combo.core) }));
}

// Query-level grounding: ground every selector as today, then run the combo-assembly pass over the whole leg
// set. `combos` is ADDITIVE (per-selector grounding is byte-identical), so a caller sees the legs AND any
// ready-made combined market. The eval harness grades `perSelector`; combo grading is a later step.
export type PlanLeg = { concept: string; subjectKind?: SubjectKind; line?: SelectorLine; period?: Period; side?: "home" | "away" };
export type GroundedPlan = { perSelector: (GroundResult | null)[]; combos: GroundResult[] };
export async function groundPlan(legs: PlanLeg[], level?: Level): Promise<GroundedPlan> {
  const perSelector: (GroundResult | null)[] = [];
  for (const leg of legs) {
    const g = await groundMarket(leg.concept, { subjectKind: leg.subjectKind, line: leg.line, level, period: leg.period, side: leg.side });
    perSelector.push(g.ids.length ? g : null);
  }
  return { perSelector, combos: assembleCombos(legs.map((l) => l.concept)) };
}
