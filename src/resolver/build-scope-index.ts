// build-scope-index.ts — build-time scope-index rebuild. Run: `npm run build:scope:football` / `build:scope:basketball`.
//
// A PURE LOCAL JOIN (no API) of groups.json ⋈ <sport>_participants.json into
// the slim, version-stamped artifact data/<sport>/scope-index.json that the scope grounder loads. Holds
// only the fields used downstream:
//   - groups[]   : the participant-referenced WHITELIST (the competition-grounding pool). Each group
//                  is annotated with its `branch` — the sport-root child it descends from — so the region
//                  hard-scope is an O(1) field check (no stored subtree map). Drops every noise branch
//                  (Esports/Marcatore/Kings League/…) for free: they are referenced by no club/player.
//   - branches[] : the sport-root children that contain >=1 whitelisted descendant — the region targets
//                  (usually a country, sometimes a cross-country comp like Champions League). Region grounding
//                  resolves a region word to one of these, then hard-scopes competition candidates to it.
//   - teams[]    : every club (incl. national teams, which carry an ntVariant) -> {name, competitionIds,
//                  groupIds, ntVariant} for team grounding.
//   - players[]  : every player -> {name, clubId, countryTeamId, competitionIds} for player grounding.
// The derived indexes (folded name maps, the roster inversion) are built at LOAD time in scope-catalog.ts —
// the build step writes the slim list, scope-catalog builds byName/bySubject — so the artifact stays the
// slim join and the tokenizer/inversion never go stale on disk.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSport, SPORTS } from "./sports";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- input feed shapes (only the fields we read) ----
type RawGroupNode = { id: number; name: string; sport: string; groups?: RawGroupNode[] };
type Club = { id: number; name: string; competitionIds?: number[]; groupIds?: number[]; ntVariant?: string | null };
type Player = { id: number; name: string; clubId?: number | null; competitionIds?: number[]; countryTeamId?: number | null };

// ---- output shapes ----
type OutGroup = { id: number; name: string; sport: string; parent: number | null; branch: number | null };
type OutBranch = { id: number; name: string };
type OutTeam = { id: number; name: string; competitionIds: number[]; groupIds: number[]; ntVariant: string | null };
type OutPlayer = { id: number; name: string; clubId: number | null; countryTeamId: number | null; competitionIds: number[] };

type FlatNode = { id: number; name: string; sport: string; parent: number | null };

function main(): void {
  const sportSlug = process.argv[2] ?? "football";
  const config = getSport(sportSlug);
  if (!config) throw new Error(`Unknown sport: "${sportSlug}". Known: ${Object.keys(SPORTS).join(", ")}`);

  const DATA = join(HERE, "..", "..", "data", config.slug);
  const read = (f: string): any => JSON.parse(readFileSync(join(DATA, f), "utf8"));
  const SPORT_ROOT = config.sportRootId;

  const rawGroupsFeed = read("groups.json") as { groups?: RawGroupNode[] } | { group: { id?: number; groups?: RawGroupNode[] } };
  const groupsFeed = "group" in rawGroupsFeed ? rawGroupsFeed.group : rawGroupsFeed;
  const participants = read(config.participantsFile) as { clubs: Club[]; players: Player[] };

  // ---- flatten the group tree, capturing parent pointers ----
  const flat = new Map<number, FlatNode>();
  (function walk(node: { groups?: RawGroupNode[] }, parent: number | null): void {
    for (const g of node.groups ?? []) {
      flat.set(g.id, { id: g.id, name: g.name, sport: g.sport, parent });
      walk(g, g.id);
    }
  })(groupsFeed, null);

  // The sport-root child a node descends from (its region branch), or null if not under the sport root.
  function branchOf(id: number): number | null {
    let n = flat.get(id);
    if (!n) return null;
    while (n.parent != null && n.parent !== SPORT_ROOT) n = flat.get(n.parent)!;
    return n.parent === SPORT_ROOT ? n.id : null;
  }

  // ---- participant-referenced whitelist (the noise-free competition pool) ----
  // competitionIds ∪ groupIds ∪ countryTeamId; only those that are real group-tree nodes survive
  // (countryTeamId points at a national-TEAM participant, not a group, so it drops out here).
  const refs = new Set<number>();
  for (const c of participants.clubs) {
    for (const x of c.competitionIds ?? []) refs.add(x);
    for (const x of c.groupIds ?? []) refs.add(x);
  }
  for (const p of participants.players) {
    for (const x of p.competitionIds ?? []) refs.add(x);
    if (p.countryTeamId) refs.add(p.countryTeamId);
  }

  const groups: OutGroup[] = [];
  for (const id of refs) {
    const n = flat.get(id);
    if (!n) continue; // not a group node (e.g. a countryTeamId participant)
    groups.push({ id: n.id, name: n.name, sport: n.sport, parent: n.parent, branch: branchOf(n.id) });
  }
  groups.sort((a, b) => a.id - b.id);

  // ---- region branches: sport-root children with >=1 whitelisted descendant ----
  const branchIds = new Set<number>();
  for (const g of groups) if (g.branch != null) branchIds.add(g.branch);
  const branches: OutBranch[] = [...branchIds]
    .map((id) => ({ id, name: flat.get(id)!.name }))
    .sort((a, b) => a.id - b.id);

  // ---- team index source (all clubs; national teams carry an ntVariant) ----
  const teams: OutTeam[] = participants.clubs
    .map((c) => ({
      id: c.id,
      name: c.name,
      competitionIds: c.competitionIds ?? [],
      groupIds: c.groupIds ?? [],
      ntVariant: c.ntVariant ?? null,
    }))
    .sort((a, b) => a.id - b.id);

  // ---- player index source ----
  const players: OutPlayer[] = participants.players
    .map((p) => ({
      id: p.id,
      name: p.name,
      clubId: p.clubId ?? null,
      countryTeamId: p.countryTeamId ?? null,
      competitionIds: p.competitionIds ?? [],
    }))
    .sort((a, b) => a.id - b.id);

  // Content version: hash the slim (id, name) pairs across all four structures.
  const version = createHash("sha256")
    .update(
      [
        ...groups.map((g) => `g${g.id}\t${g.name}`),
        ...branches.map((b) => `b${b.id}`),
        ...teams.map((t) => `t${t.id}\t${t.name}`),
        ...players.map((p) => `p${p.id}\t${p.name}`),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 12);

  const nationalTeams = teams.filter((t) => t.ntVariant).length;
  const out = {
    version,
    builtAt: new Date().toISOString(),
    sport: config.slug,
    sportRootId: SPORT_ROOT,
    source: { feed: `groups.json ⋈ ${config.participantsFile}` },
    counts: {
      whitelistGroups: groups.length,
      branches: branches.length,
      teams: teams.length,
      nationalTeams,
      players: players.length,
    },
    groups,
    branches,
    teams,
    players,
  };

  writeFileSync(join(DATA, "scope-index.json"), JSON.stringify(out) + "\n");

  // ---- report ----
  console.log(`[${config.slug}] scope index rebuilt — version ${version}`);
  console.log(`  whitelist groups=${groups.length}  branches=${branches.length}`);
  console.log(`  teams=${teams.length}  (national=${nationalTeams})  players=${players.length}`);
  const sampleBranches = branches.slice(0, 4).map((b) => b.name).join(", ");
  console.log(`  first branches: ${sampleBranches || "(none)"}`);
  console.log(`  wrote data/${config.slug}/scope-index.json`);
}

main();
