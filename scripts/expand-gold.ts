// expand-gold — Phase 5 of planning/extractor-rebuild-plan.md.
//
//   npm run gold           # planning/corpus/gold-expect.jsonl -> src/eval/gold.corpus.jsonl
//
// A full GoldRecord is ~25 lines of JSON, most of it the same scope skeleton repeated on every leg. Authoring
// ~300 of them by hand would be 7000 lines of ceremony where only a handful of facets per row carry meaning.
// So the corpus expectations are authored COMPACTLY (one line per query, only what differs from the defaults)
// and expanded here. Query, tags and the default sport come from planning/corpus/corpus.jsonl, so a corpus row
// and its expectation can never drift apart.
//
// Compact row (every field but `id` optional):
//   { "id":"t001", "sport":"tennis", "main":true, "combined_odds":{"min":2.5},
//     -- shared scope, repeated onto every leg (a leg may override any of them) --
//     "comp":"Cincinnati", "region":"Italy", "teams":["Giron"], "players":[["Odegaard","starts"]],
//     "level":"competition", "stage":"round 1", "time":"w:tonight,k:after 5pm", "play":"live",
//     "legs":[ { "m":["total games"], "subj":"team:Giron", "line":22.5, "dir":"over",
//                "odds":{"min":2}, "osort":"low", "lsort":"high" } ] }
//
//   subj   "event" (default) | "team:Name" | "player:Name" | "player" (generic per-player market)
//          | "either" | "either:home" | "either:away" | "soft:player/event"
//   m      accept phrasings for market_concept — graded by lenient containment either way, so include the
//          DISTINGUISHING noun ("winning margin", not "margin" alone, which "margin of victory" also contains)
//   line   number = a rung to select · string = a named pick (correct score, HT/FT) · {min?,max?} = a bound
//          on which fixtures qualify
//   time   comma-separated: w:<window> (anchor now) · wt:<window> (anchor tournament) · k:<band> · p:earliest:1

import { readFileSync, writeFileSync } from "node:fs";
import { GoldRecord } from "../src/eval/gold-record";

const CORPUS = "planning/corpus/corpus.jsonl";
const EXPECT = "planning/corpus/gold-expect.jsonl";
const OUT = "src/eval/gold.corpus.jsonl";

type CorpusRow = { id: string; sport: string; query: string; tags: string[] };
type Role = "plays" | "starts" | "captain";
// Any entity/market/line cell may be a list of accepted phrasings: "MLS" and "Major League Soccer" are the
// same competition, and the scorer must not fail an extraction for picking the other one.
type Names = string | string[];
type Player = Names | [Names, Role];
type Bound = { min?: number; max?: number };
type Scope = {
  comp?: Names | null;
  region?: Names | null;
  teams?: Names[];
  players?: Player[];
  level?: "fixture" | "competition";
  stage?: string | null;
  time?: string | null;
  play?: "live" | "prematch" | null;
};
type Leg = Scope & {
  m?: string[];
  subj?: string;
  line?: number | Names | Bound;
  dir?: "over" | "under" | "yes" | "no";
  odds?: Bound;
  osort?: "low" | "high";
  lsort?: "low" | "high";
};
type Compact = Scope & { id: string; sport?: Names; main?: true; combined_odds?: Bound; legs?: Leg[] };

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch (e) {
        throw new Error(`${path}: bad JSON near line ${i + 1} — ${(e as Error).message}\n  ${l.slice(0, 120)}`);
      }
    });

function subjectOf(spec = "event"): Record<string, unknown> {
  const at = spec.indexOf(":"); // first colon only — a name may contain one ("EMPIRE :3")
  const kind = at < 0 ? spec : spec.slice(0, at);
  const arg = at < 0 ? undefined : spec.slice(at + 1);
  switch (kind) {
    case "event":
      return { kind: "event" };
    case "team":
      return { kind: "team", name: { accept: [arg!] } };
    case "player":
      return arg ? { kind: "player", name: { accept: [arg] } } : { kind: "player" };
    case "either":
      return { kind: "either_match_team" };
    case "soft":
      return { kind: "soft", kinds: arg!.split("/") };
    default:
      throw new Error(`unknown subj "${spec}"`);
  }
}

// "w:tonight,k:after 5pm" -> the gold Time cell. The scorer grades PRESENCE + anchor + fixture_pick, never the
// window's text, so the token is kept human-readable rather than canonicalised.
function timeOf(spec: string | null | undefined): Record<string, unknown> | null {
  if (!spec) return null;
  const t: Record<string, unknown> = { date_window: null, kickoff_time_of_day: null, fixture_pick: null };
  for (const part of spec.split(",")) {
    const [tag, ...rest] = part.split(":");
    const val = rest.join(":").trim();
    if (tag === "w") t.date_window = { value: val, anchor: "now" };
    else if (tag === "wt") t.date_window = { value: val, anchor: "tournament" };
    else if (tag === "k") t.kickoff_time_of_day = val;
    else if (tag === "p") {
      const [order, count] = val.split(":");
      t.fixture_pick = { order, count: Number(count ?? 1) };
    } else throw new Error(`unknown time token "${part}"`);
  }
  return t;
}

// Market families. The market axis is graded by lenient containment against accept[], so a row that lists only
// "to win" fails a perfectly good "who wins" — an authoring miss, not an extractor bug. These name the recurring
// families once so every row that uses one accepts the same spread of real phrasings.
// Deliberately NOT included in @WIN: a bare "winner", which would also swallow "outright winner", "toss winner"
// and "group winner" and let a competition-grain answer pass a fixture-grain row.
const FAMILIES: Record<string, string[]> = {
  "@WIN": ["to win", "match winner", "who wins", "moneyline", "to beat", "for the win"],
  "@FAV": ["favourite", "match winner", "who wins", "to win", "shortest price", "longest price"],
  "@OUTRIGHT": ["outright winner", "who wins", "to win", "tournament winner", "winner", "for the win"],
  "@MARGIN": ["winning margin", "margin of victory", "winning margin bands"],
  "@HCP": ["handicap", "spread", "point spread", "to cover", "line"],
  "@TOTAL": ["total", "total points", "over/under"],
  "@METHOD": ["winning method", "method of victory", "to win by", "by submission", "by knockout", "by decision"],
  "@DISTANCE": ["goes the distance", "to go the distance", "going the distance"],
  "@HTFT": ["half time full time", "half-time/full-time", "ht/ft"],
  "@CORRECT": ["correct score", "score betting", "set betting", "correct set score", "correct map score"],
};
const expandFamilies = (m: string[]): string[] => [...new Set(m.flatMap((x) => FAMILIES[x] ?? [x]))];

const cell = (n: Names): { accept: string[] } => ({ accept: Array.isArray(n) ? n : [n] });
const isRole = (p: Player): p is [Names, Role] => Array.isArray(p) && p.length === 2 && typeof p[1] === "string" && ["plays", "starts", "captain"].includes(p[1]);
// A bare {min?,max?} is a line RANGE; a number is a rung; anything else is a named pick (accept-list).
const lineOf = (v: Leg["line"]): unknown =>
  v === undefined || typeof v === "number" || (!Array.isArray(v) && typeof v === "object" && v !== null) ? v : cell(v as Names);

function scopeOf(shared: Scope, leg: Leg): Record<string, unknown> {
  const pick = <K extends keyof Scope>(k: K): Scope[K] => (leg[k] !== undefined ? leg[k] : shared[k]);
  const players = (pick("players") ?? []).map((p) =>
    isRole(p) ? { name: cell(p[0]), role: p[1] } : { name: cell(p as Names), role: "plays" },
  );
  const comp = pick("comp");
  const region = pick("region");
  return {
    teams: (pick("teams") ?? []).map(cell),
    players,
    competition: comp ? cell(comp) : null,
    region: region ? cell(region) : null,
    level: pick("level") ?? "fixture",
    stage: pick("stage") ?? null,
    time: timeOf(pick("time")),
    play_state: pick("play") ?? null,
  };
}

function expand(c: Compact, row: CorpusRow): unknown {
  const { id, sport, main, combined_odds, legs, ...shared } = c;
  if (main && legs) throw new Error(`${id}: "main" and "legs" are mutually exclusive`);
  const source: Leg[] = main ? [{}] : (legs ?? []);
  if (!source.length) throw new Error(`${id}: needs "legs" or "main"`);

  const selectors = source.map((leg) => {
    if (!main && !leg.m?.length) throw new Error(`${id}: every leg needs "m" (accept phrasings)`);
    return {
      subject: main ? { kind: "event" } : subjectOf(leg.subj),
      market_concept: main ? { main: true, accept: [] } : { accept: expandFamilies(leg.m!) },
      ...(leg.line !== undefined ? { line: lineOf(leg.line) } : {}),
      ...(leg.dir ? { direction: leg.dir } : {}),
      ...(leg.odds ? { odds: leg.odds } : {}),
      ...(leg.osort ? { odds_sort: leg.osort } : {}),
      ...(leg.lsort ? { line_sort: leg.lsort } : {}),
      scope: scopeOf(shared, leg),
    };
  });

  return {
    id,
    query: row.query,
    tags: row.tags,
    expect: { sport: sport ?? row.sport, ...(combined_odds ? { combined_odds } : {}), selectors },
  };
}

function main(): void {
  const corpus = new Map(readJsonl<CorpusRow>(CORPUS).map((r) => [r.id, r]));
  const compact = readJsonl<Compact>(EXPECT);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of compact) {
    const row = corpus.get(c.id);
    if (!row) throw new Error(`${c.id}: no such id in ${CORPUS}`);
    if (seen.has(c.id)) throw new Error(`${c.id}: duplicate expectation`);
    seen.add(c.id);
    const rec = expand(c, row);
    const parsed = GoldRecord.safeParse(rec);
    if (!parsed.success) throw new Error(`${c.id}: ${parsed.error.message}\n  ${JSON.stringify(rec)}`);
    out.push(JSON.stringify(rec));
  }

  writeFileSync(OUT, out.join("\n") + "\n");
  const legs = compact.reduce((n, c) => n + (c.main ? 1 : (c.legs?.length ?? 0)), 0);
  console.log(`${out.length} gold rows (${legs} selectors) -> ${OUT}`);
}

main();
