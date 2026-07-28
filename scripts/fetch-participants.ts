// fetch-participants.ts — fetch a sport's participants from the Kambi feeds API into the raw blob the
// normalizer / scope-build read.
//   tsx scripts/fetch-participants.ts <sport> [out.json]
//
// The feeds API returns a group's participants RECURSIVELY (verified: England ⊃ Premier League), but the
// whole-sport group times out (too big). So we fetch each group UNDER the sport root and only descend into
// a group's children when that group itself times out. Union, dedup by id (a player under two comps appears
// twice), write data/<sport>/<sport>_participants_raw.json — the same file scripts/<sport>/concat-feeds.ts
// produces, so the rest of the pipeline (normalize → build:scope) is unchanged.
//
// Needs data/<sport>/groups.json first (run fetch-groups.ts). Feeds operator is `kambi` and takes no query.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSport, SPORTS, BUILD_DIR, GROUPS_PATH } from "../src/resolver/sports";
import { curlJsonOrNull } from "./curl-fetch";

const FEED = (id: number) => `https://feeds-eu.offering-api.kambicdn.com/feeds/api/kambi/participant/group/${id}.json`;
const TIMEOUT_MS = 120_000; // client abort → treat the group as too-big, split into children (NCAA feeds are slow: ~31s)
const CONCURRENCY = 4;      // ponytail: pool the sport's direct children; kept modest so slow feeds don't get transient errors under load

type Node = { id: number; name?: string; groups?: Node[] };
type Participant = { id: number; [k: string]: unknown };

// GET a feed via curl (Node fetch is fingerprint-blocked — see curl-fetch.ts), retried `attempts` times.
// participants[] on 200 (even if empty), or null after all attempts fail → the caller splits into children
// (or skips a leaf). Containers pass attempts=1 (a fail just means "too big" → split); leaves retry, since a
// slow-but-valid leaf (NCAAB is ~31s and can't be split) must not be dropped on one unlucky timeout.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryFeed(id: number, attempts: number): Promise<Participant[] | null> {
  for (let a = 0; a < attempts; a++) {
    if (a > 0) await sleep(4000 * a); // backoff — a slow cold-cache leaf (NCAAB ~31s) that transiently fails succeeds once the CDN warms
    const d = await curlJsonOrNull(FEED(id), TIMEOUT_MS / 1000);
    if (d) return (d as { participants?: Participant[] }).participants ?? [];
  }
  return null;
}

// A group's whole subtree: one call if it fits, else split into children (which recurse).
async function fetchSubtree(node: Node, depth = 0): Promise<Participant[]> {
  const pad = "  ".repeat(depth);
  const direct = await tryFeed(node.id, node.groups?.length ? 1 : 4); // leaf can't split → retry with backoff (slow cold feeds like NCAAB)
  if (direct) {
    console.log(`${pad}ok ${node.name ?? node.id}: ${direct.length}`);
    return direct;
  }
  if (!node.groups?.length) {
    console.warn(`${pad}!! ${node.name ?? node.id}: failed, no children to split — skipped`);
    return [];
  }
  console.log(`${pad}>> ${node.name ?? node.id}: too big/failed, splitting into ${node.groups.length}`);
  const parts: Participant[] = [];
  for (const child of node.groups) parts.push(...(await fetchSubtree(child, depth + 1)));
  return parts;
}

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
    }),
  );
  return out;
}

function findNode(root: Node, id: number): Node | null {
  if (root.id === id) return root;
  for (const g of root.groups ?? []) { const f = findNode(g, id); if (f) return f; }
  return null;
}

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "football";
  const config = getSport(slug);
  if (!config) throw new Error(`Unknown sport "${slug}". Known: ${Object.keys(SPORTS).join(", ")}`);
  const DATA = BUILD_DIR; // flat scratch: <slug>_participants_raw.json (+ tour feeds); groups.json is shared

  // Reads the FRESH tree fetch-groups wrote. GROUPS_FILE overrides the path (testing / validation).
  const raw = JSON.parse(readFileSync(process.env.GROUPS_FILE ?? GROUPS_PATH, "utf8"));
  const root: Node = "group" in raw ? raw.group : raw; // offering API wraps in {group:...}
  const sportNode = findNode(root, config.sportRootId);
  if (!sportNode) throw new Error(`sport root ${config.sportRootId} not in groups.json — run fetch-groups.ts first`);

  const children = sportNode.groups ?? [];
  console.log(`[${config.slug}] fetching participants across ${children.length} groups under ${sportNode.name}…`);
  const perChild = await mapPool(children, CONCURRENCY, (c) => fetchSubtree(c));

  const out = process.argv[3] ?? join(DATA, `${config.slug}_participants_raw.json`);

  // Per-tour feed files (individual sports): build-scope-index reads <code>_participants.json to derive
  // each player's gender. Written next to `out` so a --out override keeps all outputs together.
  if (config.tourFeeds) {
    const outDir = dirname(out);
    children.forEach((c, i) => {
      const code = config.tourFeeds![c.name ?? ""];
      if (code) {
        writeFileSync(join(outDir, `${code}_participants.json`), JSON.stringify({ participants: perChild[i] }) + "\n");
        console.log(`  tour feed ${code}: ${perChild[i]!.length}`);
      }
    });
  }

  // dedup by id, keeping the RICHEST copy (most teamMembers). A team appears under many groups and
  // some copies come back rosterless; "first wins" could discard the squad, dropping national teams
  // (Brazil/England) whose rostered copy lost the fetch-order race.
  const parts = perChild.flat();
  const memberCount = (p: Participant): number => ((p as { teamMembers?: unknown[] }).teamMembers?.length ?? 0);
  const bestById = new Map<number, Participant>();
  for (const p of parts) {
    const prev = bestById.get(p.id);
    if (!prev || memberCount(p) > memberCount(prev)) bestById.set(p.id, p);
  }
  const participants = [...bestById.values()];

  writeFileSync(out, JSON.stringify({ participants }) + "\n");
  console.log(`\ntotal fetched: ${parts.length}, unique: ${participants.length}`);
  console.log(`wrote ${out}`);
}

main();
