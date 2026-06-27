// In-memory scope catalog — loads data/<sport>/scope-index.json (the slim groups ⋈ participants join)
// plus data/<sport>/scope-aliases.json, builds derived lookup indexes at load, and memoizes per sport.
// Mirrors catalog.ts (which does the same for market criterions).
//
// Scope grounding only (sport · region · competition · team · player). The market criterion catalog stays
// in catalog.ts; the two are independent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fold } from "./lexical";

const HERE = dirname(fileURLToPath(import.meta.url));

export type ScopeGroup = { id: number; name: string; sport: string; parent: number | null; branch: number | null };
export type ScopeBranch = { id: number; name: string };
export type ScopeTeam = { id: number; name: string; competitionIds: number[]; groupIds: number[]; ntVariant: string | null };
export type ScopePlayer = { id: number; name: string; clubId: number | null; countryTeamId: number | null; competitionIds: number[] };

export type ScopeCatalog = {
  sport: string;
  version: string;
  sportRootId: number;
  // competition pool + lookups
  groups: ScopeGroup[];
  groupById: Map<number, ScopeGroup>;
  competitionByName: Map<string, number[]>; // folded group name -> group id(s)
  // region branches + name lookup
  branches: ScopeBranch[];
  branchById: Map<number, ScopeBranch>;
  branchByName: Map<string, number[]>; // folded branch name -> branch id(s)
  // teams (clubs incl. national teams)
  teams: ScopeTeam[];
  teamById: Map<number, ScopeTeam>;
  teamByName: Map<string, number[]>; // folded club name -> club id(s)
  // players
  players: ScopePlayer[];
  playerById: Map<number, ScopePlayer>;
  playerByFull: Map<string, number[]>; // folded full name -> player id(s)
  playerByLast: Map<string, number[]>; // folded last-name token -> player id(s)
  // roster inversion: competition group id OR national-team id -> player ids
  roster: Map<number, number[]>;
  // curated alias lexicon (scope-aliases.json), all keys folded
  competitionAliases: Map<string, string>; // folded short-form -> competition NAME
  regionAliases: Map<string, string>; // folded place adjective/short-form -> branch NAME
  markers: Map<string, string>; // folded surface marker -> normalized token
};

function pushKey(map: Map<string, number[]>, key: string, id: number): void {
  if (!key) return;
  const arr = map.get(key);
  if (arr) arr.push(id);
  else map.set(key, [id]);
}

function lastToken(folded: string): string {
  const toks = folded.split(" ").filter(Boolean);
  return toks[toks.length - 1] ?? "";
}

function loadAliases(dataDir: string): Pick<ScopeCatalog, "competitionAliases" | "regionAliases" | "markers"> {
  let raw: { competitions?: Record<string, string>; regions?: Record<string, string>; markers?: Record<string, string> };
  try {
    raw = JSON.parse(readFileSync(join(dataDir, "scope-aliases.json"), "utf8"));
  } catch {
    raw = {};
  }
  const fold2 = (o: Record<string, string> | undefined): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(o ?? {})) m.set(fold(k), v);
    return m;
  };
  return { competitionAliases: fold2(raw.competitions), regionAliases: fold2(raw.regions), markers: fold2(raw.markers) };
}

function emptyBlob(sport: string): ScopeCatalog {
  return {
    sport,
    version: "",
    sportRootId: 0,
    groups: [],
    groupById: new Map(),
    competitionByName: new Map(),
    branches: [],
    branchById: new Map(),
    branchByName: new Map(),
    teams: [],
    teamById: new Map(),
    teamByName: new Map(),
    players: [],
    playerById: new Map(),
    playerByFull: new Map(),
    playerByLast: new Map(),
    roster: new Map(),
    competitionAliases: new Map(),
    regionAliases: new Map(),
    markers: new Map(),
  };
}

const catalogCache = new Map<string, ScopeCatalog>();

export function loadScopeCatalog(sport: string): ScopeCatalog {
  const slug = sport.toLowerCase();
  const hit = catalogCache.get(slug);
  if (hit) return hit;

  const dataDir = join(HERE, "..", "..", "data", slug);
  let idx: { version: string; sportRootId: number; groups: ScopeGroup[]; branches: ScopeBranch[]; teams: ScopeTeam[]; players: ScopePlayer[] };
  try {
    idx = JSON.parse(readFileSync(join(dataDir, "scope-index.json"), "utf8"));
  } catch {
    // sport not yet built — return empty catalog so grounding yields nothing
    const empty = emptyBlob(slug);
    catalogCache.set(slug, empty);
    return empty;
  }

  const groupById = new Map<number, ScopeGroup>();
  const competitionByName = new Map<string, number[]>();
  for (const g of idx.groups) {
    groupById.set(g.id, g);
    pushKey(competitionByName, fold(g.name), g.id);
  }

  const branchById = new Map<number, ScopeBranch>();
  const branchByName = new Map<string, number[]>();
  for (const b of idx.branches) {
    branchById.set(b.id, b);
    pushKey(branchByName, fold(b.name), b.id);
  }

  const teamById = new Map<number, ScopeTeam>();
  const teamByName = new Map<string, number[]>();
  for (const t of idx.teams) {
    teamById.set(t.id, t);
    pushKey(teamByName, fold(t.name), t.id);
  }

  const playerById = new Map<number, ScopePlayer>();
  const playerByFull = new Map<string, number[]>();
  const playerByLast = new Map<string, number[]>();
  const roster = new Map<number, number[]>();
  for (const p of idx.players) {
    playerById.set(p.id, p);
    const f = fold(p.name);
    pushKey(playerByFull, f, p.id);
    pushKey(playerByLast, lastToken(f), p.id);
    const enrol = (cid: number): void => {
      const arr = roster.get(cid);
      if (arr) arr.push(p.id);
      else roster.set(cid, [p.id]);
    };
    for (const cid of p.competitionIds) enrol(cid);
    if (p.countryTeamId) enrol(p.countryTeamId);
  }

  const catalog: ScopeCatalog = {
    sport: slug,
    version: idx.version,
    sportRootId: idx.sportRootId,
    groups: idx.groups,
    groupById,
    competitionByName,
    branches: idx.branches,
    branchById,
    branchByName,
    teams: idx.teams,
    teamById,
    teamByName,
    players: idx.players,
    playerById,
    playerByFull,
    playerByLast,
    roster,
    ...loadAliases(dataDir),
  };
  catalogCache.set(slug, catalog);
  return catalog;
}
