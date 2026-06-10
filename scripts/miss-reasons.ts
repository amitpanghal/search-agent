// Shared miss-reason tagger — used by classify-misses.ts (breakdown) and build-tightening-docs.ts (the
// tightening/ tables). Heuristic, precision-ordered: tags WHY a reachable gold is ranked below the pool cut,
// from the evidence (gold name, extractor concept, the names ranked above it). Plain-English reason + fix.

export type Miss = {
  q: string; id: number; gold: string; subject: string; rank: number;
  concept?: string; goldScore?: number; top3?: string[]; justAbove?: string[]; allConcepts?: string[];
};

const STOP = new Set("the a an to of in on at by for and or with is are be s any all their most least total number".split(" "));
export const toks = (s: string) => s.toLowerCase().replace(/\(settled[^)]*\)/gi, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
const periodOf = (s: string) => /1st half|first half/i.test(s) ? "1h" : /2nd half|second half/i.test(s) ? "2h" : /extra time|including extra/i.test(s) ? "et" : "full";
const sideOf = (s: string) => /\bhome\b/i.test(s) ? "home" : /\baway\b/i.test(s) ? "away" : "none";
export const topName = (m: Miss) => (m.top3?.[0] ?? "").replace(/\s*\[[\d.]+\]$/, "");
const isExotic = (n: string) => /without |excluding|including play|fantasy|female |all three|quadruple|literally|wooden|nationality|chairperson|attendance|joint head|assistant|transfer|olimpico|beer|combination of|squad for|promoted teams|clean sheets/i.test(n);
const isCombo = (m: Miss) => /\s&\s|\sand\s|combination of|scorecast|wincast/i.test(m.gold);
const seasonScoped = (n: string) => /competition|tournament|league|season|playoff|during the/i.test(n);

export function classify(m: Miss): { reason: string; fix: string } {
  const g = m.gold, t = topName(m), tg = toks(g), tt = toks(t), tc = toks(m.concept ?? "");
  const shared = tg.filter((x) => tt.includes(x));
  if (isCombo(m)) return { reason: "Combined market — extractor split the query into single legs, so the combined catalog row never gets a concept of its own", fix: "Stage-2 live-menu recombination (deferred); not a grounder fix" };
  if (isExotic(g)) return { reason: "Exotic / out-of-scope market (excluded-team, playoffs-only, novelty) — generic siblings out-rank a market nobody phrases plainly", fix: "Quarantine like Class C, or leave to Stage 2" };
  if (seasonScoped(g) && !seasonScoped(t)) return { reason: "Season/competition-scoped gold buried under its identical match-level twin", fix: "Level-awareness (decision 23): concept must carry season scope, or scope demotes the match twin" };
  if (shared.length >= 1 && periodOf(g) !== periodOf(t)) return { reason: "A different PERIOD of the same stat sits on top (full vs 1st-half/extra-time)", fix: "Period facet: concept must name the period (family gate does NOT cover period)" };
  if (shared.length >= 1 && sideOf(g) !== sideOf(t) && (sideOf(g) !== "none" || sideOf(t) !== "none")) return { reason: "A different SIDE of the same stat sits on top (home vs away vs match-total)", fix: "Per-side divert / concept must name the side" };
  if (tt.length && tt.every((x) => tg.includes(x)) && tg.length > tt.length) return { reason: "A broader/simpler version out-cosines the more specific gold (gold has an extra qualifier the query under-weights)", fix: "Specificity/coverage tuning; or concept under-specifies the qualifier" };
  const goldKey = tg.filter((x) => !tc.includes(x));
  if (shared.length === 0 && goldKey.length >= 1) return { reason: "Concept's words point at a DIFFERENT stat than the gold's name — a vocabulary gap", fix: "Lexicon alias to bridge the wording, or extractor normalization" };
  const concGoldShare = tg.filter((x) => tc.includes(x));
  if (concGoldShare.length >= 2) return { reason: "Gold's NAME literally contains the query's words, but cosine ranked it low and BM25 didn't pull it into the pool", fix: "BM25 nominee depth / lexical-cover floor (recall channel)" };
  return { reason: "Near-synonym crowding — different-meaning siblings (most/total, suffered/conceded/won, win/qualify, first/next) the embedding can't separate", fix: "Stat-core tightening + lexical disambiguation (doc-views help only here)" };
}
