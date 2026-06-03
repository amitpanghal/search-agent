// In-memory catalog (decision 10: no SQLite yet). This is the same structure SQLite would
// later hydrate at step 2; `groundMarket` reads it. Two halves:
//   - the criterion rows from football_criterions.json — the rebuilt artifact from
//     `npm run build:catalog` (full criterion⋈category join, post-quarantine, subject-tagged,
//     version-stamped). Indexed by id, by normalized name, and bucketed by subject.
//   - one merged market-alias map from aliases.json (curated) + derived-aliases.json (generated)
//
// Scope: market grounding only. Players/groups/competitions are NOT loaded here (Sprint 2 scope).
// Alias keys are normalized with the scorer's `normalize` so grounding and grading agree on
// what two strings "are the same". Loaded once and memoized.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalize } from "../eval/structural-scorer";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "data", "football");

// The pre-filter bucket (decision 20): `player` markets vs `team_or_match` markets. Tagged at
// catalog-build time from category membership; `groundMarket` restricts the cosine candidate set
// to the query subject's bucket before scoring.
export type Subject = "player" | "team_or_match";

// Per-side ownership of a team_or_match market ("... by Home/Away Team"). Drives the named-team
// divert (decision 20): a single-team query lands on its per-side twins, not the match total.
export type Side = "home" | "away" | null;

export type Criterion = {
  id: number;
  sport: string;
  name: string;
  categoryNames: string[];
  boTypeNames: string[];
  shownInLive: boolean;
  shownInPreMatch: boolean;
  subject: Subject;
  side: Side;
};

// A market alias points at one of three concept granularities. Only `criterion_concept` names a
// single criterion (resolved to an id by exact criterion-name). `category_concept` and `botype`
// are coarser — they are SCOPING hints for the vector path, not groundings on their own.
export type MarketAlias =
  | { type: "criterion_concept"; name: string }
  | { type: "category_concept"; id: number; boTypeId?: number; name?: string }
  | { type: "botype"; id: number; label?: string };

export type Catalog = {
  byId: Map<number, Criterion>;
  list: Criterion[];
  byName: Map<string, number[]>; // normalized criterion name -> id(s); a handful of names collide
  bySubject: Record<Subject, Criterion[]>; // pre-filter buckets (decision 20)
  version: string; // content hash stamped by build-catalog; build-market-index records it (E11)
  marketAliases: Map<string, MarketAlias>; // normalized alias key -> concept
};

function readJson(file: string): any {
  return JSON.parse(readFileSync(join(DATA, file), "utf8"));
}

function loadCriterions(): Pick<Catalog, "byId" | "list" | "byName" | "bySubject" | "version"> {
  const raw = readJson("football_criterions.json");
  const list: Criterion[] = (raw.criterions as any[]).map((c) => ({
    id: c.id,
    sport: c.sport,
    name: c.name,
    categoryNames: c.categoryNames ?? [],
    boTypeNames: c.boTypeNames ?? [],
    shownInLive: !!c.shownInLive,
    shownInPreMatch: !!c.shownInPreMatch,
    subject: c.subject === "player" ? "player" : "team_or_match",
    side: c.side === "home" ? "home" : c.side === "away" ? "away" : null,
  }));

  const byId = new Map<number, Criterion>();
  const byName = new Map<string, number[]>();
  const bySubject: Record<Subject, Criterion[]> = { player: [], team_or_match: [] };
  for (const c of list) {
    byId.set(c.id, c);
    const key = normalize(c.name);
    byName.set(key, [...(byName.get(key) ?? []), c.id]);
    bySubject[c.subject].push(c);
  }
  return { byId, list, byName, bySubject, version: typeof raw.version === "string" ? raw.version : "" };
}

function coerceAlias(v: unknown): MarketAlias | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case "criterion_concept":
      return typeof o.name === "string" ? { type: "criterion_concept", name: o.name } : null;
    case "category_concept":
      return typeof o.id === "number"
        ? { type: "category_concept", id: o.id, boTypeId: o.boTypeId as number | undefined, name: o.name as string | undefined }
        : null;
    case "botype":
      return typeof o.id === "number" ? { type: "botype", id: o.id, label: o.label as string | undefined } : null;
    default:
      return null;
  }
}

function loadMarketAliases(): Map<string, MarketAlias> {
  const map = new Map<string, MarketAlias>();
  // Generated table first, then the curated table overrides on any key collision.
  for (const file of ["derived-aliases.json", "aliases.json"]) {
    const markets = (readJson(file).markets ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(markets)) {
      const alias = coerceAlias(v);
      if (alias) map.set(normalize(k), alias);
    }
  }
  return map;
}

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  cached = { ...loadCriterions(), marketAliases: loadMarketAliases() };
  return cached;
}
