// In-memory scope catalog — loads the build-time data/football/scope-index.json (the slim groups ⋈
// participants join) plus the curated data/football/scope-aliases.json, builds the derived lookup indexes
// at load, and memoizes. Mirrors catalog.ts (which does the same for market criterions): the build script
// writes the slim lists; the loader builds the byName / roster maps here so the tokenizer & inversion can
// never go stale on disk.
//
// Scope grounding only (sport · region · competition · team · player). The market criterion catalog stays
// in catalog.ts; the two are independent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fold } from "./lexical";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "data", "football");

export type ScopeGroup = { id: number; name: string; sport: string; parent: number | null; branch: number | null };
export type ScopeBranch = { id: number; name: string };
export type ScopeTeam = { id: number; name: string; competitionIds: number[]; groupIds: number[]; ntVariant: string | null };
export type ScopePlayer = { id: number; name: string; clubId: number | null; countryTeamId: number | null; competitionIds: number[] };

export type ScopeCatalog = {
  version: string;
  footballRootId: number;
  // competition pool (303-node whitelist) + lookups
  groups: ScopeGroup[];
  groupById: Map<number, ScopeGroup>;
  competitionByName: Map<string, number[]>; // folded group name -> group id(s) (names collide, e.g. "premier league" x8)
  // region branches + name lookup
  branches: ScopeBranch[];
  branchById: Map<number, ScopeBranch>;
  branchByName: Map<string, number[]>; // folded branch name -> branch id(s)
  // teams (clubs incl. national teams)
  teams: ScopeTeam[];
  teamById: Map<number, ScopeTeam>;
  teamByName: Map<string, number[]>; // folded club name -> club id(s) (1 collision in the feed)
  // players
  players: ScopePlayer[];
  playerById: Map<number, ScopePlayer>;
  playerByFull: Map<string, number[]>; // folded full name -> player id(s)
  playerByLast: Map<string, number[]>; // folded last-name token -> player id(s) (the mononym/surname fallback)
  // roster inversion: competition group id OR national-team id -> player ids (player hard-scope)
  roster: Map<number, number[]>;
  // curated alias lexicon (scope-aliases.json), all keys folded
  competitionAliases: Map<string, string>; // folded short-form -> competition NAME (resolved lexically downstream)
  regionAliases: Map<string, string>; // folded place adjective/short-form -> branch NAME
  markers: Map<string, string>; // folded surface marker -> normalized token ("(w)" -> "women", "u23" -> "u23")
};

function readJson(file: string): any {
  return JSON.parse(readFileSync(join(DATA, file), "utf8"));
}

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

function loadAliases(): Pick<ScopeCatalog, "competitionAliases" | "regionAliases" | "markers"> {
  const raw = readJson("scope-aliases.json") as {
    competitions?: Record<string, string>;
    regions?: Record<string, string>;
    markers?: Record<string, string>;
  };
  const fold2 = (o: Record<string, string> | undefined): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(o ?? {})) m.set(fold(k), v);
    return m;
  };
  return { competitionAliases: fold2(raw.competitions), regionAliases: fold2(raw.regions), markers: fold2(raw.markers) };
}

let cached: ScopeCatalog | null = null;

export function loadScopeCatalog(): ScopeCatalog {
  if (cached) return cached;
  const idx = readJson("scope-index.json") as {
    version: string;
    footballRootId: number;
    groups: ScopeGroup[];
    branches: ScopeBranch[];
    teams: ScopeTeam[];
    players: ScopePlayer[];
  };

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

  cached = {
    version: idx.version,
    footballRootId: idx.footballRootId,
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
    ...loadAliases(),
  };
  return cached;
}
