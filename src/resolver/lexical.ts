// Shared lexical toolkit — the tokenizer + IDF/BM25 machinery, extracted from ground-market.ts so the
// market grounder AND the scope grounder share ONE implementation. The only difference between the two
// callers is the CORPUS the word-rarity (IDF) is weighted over: `buildLexicon(names)` is parameterized on
// the name list, so the market grounder passes criterion names and the scope grounder passes competition /
// participant names. Criterion-name IDF is meaningless for matching a competition name (and vice-versa), so
// each caller gets its own correctly-weighted lexicon over identical, shared tokenization code.
//
// `contentTokens` is corpus-INDEPENDENT (a pure tokenizer) so it is a standalone export; everything that
// needs word rarity (`idfCover`/`lexicalCover`/`bm25`) lives on the `Lexicon` returned by `buildLexicon`.
//
// Extracted verbatim from ground-market.ts (no behavior change — the market path is guarded by the eval
// market gate): the market-specific bits kept here (`stripSettle`, the goalscorer DECOMPOUND) are inert on
// scope names (a competition name has no "(settled …)" suffix, no "goalscorer" compound), so sharing them
// is safe. `fold()` (below) does diacritic-folding, for participant-name matching.

export { normalize } from "../eval/structural-scorer";

// Diacritic-FOLDING normalize. The criterion/participant feeds disagree on
// diacritics ("Müller" vs "Muller"), so NFD + stripping the combining marks folds both to the same ASCII.
// Deliberately distinct from the runtime `normalize` (which maps non-ascii to spaces): fold is right for
// matching proper names, normalize is right for the query path.
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// lowercase, drop apostrophes, non-alnum -> space. The base normalizer for the lexical channel.
export function lc(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Drop the non-semantic "(settled …)" parenthetical (a criterion-name quirk; a no-op on scope names).
export function stripSettle(name: string): string {
  return name.replace(/\(settled[^)]*\)/gi, "");
}

// Function-word stoplist: tokens that carry no content, dropped from the IDF cover and BM25 so only
// meaningful words count.
const SPEC_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "by", "for", "and", "or", "with", "is", "are", "be", "s", "any", "all", "their",
]);

// Symmetric stem: drop a trailing "s" on tokens >3 chars so assist≈assists, card≈cards.
function stem(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

// Decompound known football compounds the catalog spells two ways ("Goal Scorer" vs "Goalscorer") so a
// one-word query token splits to match the two-word names. Inert on competition/participant names.
const DECOMPOUND: Record<string, string[]> = { goalscorer: ["goal", "scorer"], goalscorers: ["goal", "scorer"] };

export function tokenize(s: string): string[] {
  return lc(stripSettle(s)).split(" ").filter(Boolean).flatMap((t) => DECOMPOUND[t] ?? [t]);
}

// The query/name CONTENT tokens (stopwords dropped, lightly singularized). Corpus-independent.
export function contentTokens(s: string): Set<string> {
  return new Set(tokenize(s).filter((t) => !SPEC_STOPWORDS.has(t)).map(stem));
}

// BM25 term-saturation / length-norm knobs (standard; mild on short proper-noun names).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// A corpus-bound lexicon: IDF + BM25 weighted over a specific name list. Built once per corpus.
export type Lexicon = {
  // share of the WANT set's IDF mass the HAVE set covers (0..1)
  idfCover(have: Set<string>, want: Set<string>): number;
  // idfCover with want = query tokens, have = candidate name tokens
  lexicalCover(queryText: string, name: string): number;
  // BM25 of a name against a set of query tokens
  bm25(queryTokens: Set<string>, name: string): number;
};

// Build a Lexicon over `names`. Each name is one "document"; df is over the stemmed content tokens, so the
// cover, the BM25 score and df all tokenize identically. Smoothed idf = log((N+1)/(df+0.5)); an unseen token
// gets the maximal weight (maximally distinctive). avgdl feeds BM25's length normalization.
export function buildLexicon(names: string[]): Lexicon {
  const N = names.length || 1;
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const name of names) {
    const toks = contentTokens(name);
    totalLen += toks.size;
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 0.5)));
  const avgdl = totalLen / N;
  const maxIdf = Math.log((N + 1) / 0.5);
  const idfWeight = (t: string): number => idf.get(t) ?? maxIdf;

  const idfCover = (have: Set<string>, want: Set<string>): number => {
    if (!want.size) return 0;
    let num = 0;
    let den = 0;
    for (const t of want) {
      const w = idfWeight(t);
      den += w;
      if (have.has(t)) num += w;
    }
    return den === 0 ? 0 : num / den;
  };

  const lexicalCover = (queryText: string, name: string): number => idfCover(contentTokens(name), contentTokens(queryText));

  const bm25 = (queryTokens: Set<string>, name: string): number => {
    const doc = contentTokens(name);
    const dl = doc.size || 1;
    let score = 0;
    for (const t of queryTokens) {
      if (!doc.has(t)) continue; // deduped tokens -> tf = 1
      score += (idfWeight(t) * (BM25_K1 + 1)) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
    }
    return score;
  };

  return { idfCover, lexicalCover, bm25 };
}
