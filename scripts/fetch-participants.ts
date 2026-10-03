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
// Same-name TEAM twins: Kambi can carry two ids for one team and price only one of them — the NEW id for the
// national teams it migrated (Spain 1003666473 holds the Nations League fixtures, 1000000186 three outrights),
// the OLD id for clubs (Lyon's new id is an empty row with no offers; verified live 2026-10-03). The normalizer
// keeps one twin, so each twin is stamped with `liveBetOffers`, its live bet-offer count, and the priced one wins.
// See docs/adr/catalog-twins.md.
//
// Needs data/<sport>/groups.json first (run fetch-groups.ts). Feeds operator is `kambi` and takes no query.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSport, BUILD_DIR, GROUPS_PATH } from "../src/resolver/catalog/sports";
import { betOffersByParticipants } from "../src/resolver/shared/offering-client";
import { curlJsonOrNull, closeBrowser } from "./curl-fetch";

const FEED = (id: number) => `https://feeds-eu.offering-api.kambicdn.com/feeds/api/kambi/participant/group/${id}.json`;
// Live betoffer-group menu with participants — the clean player source for `participantsFrom:"betoffer"` sports.
const BETOFFER_GROUP = (id: number) =>
  `https://eu.offering-api.kambicdn.com/offering/v2018/kambi/betoffer/group/${id}.json?lang=en_GB&market=GB&client_id=200&channel_id=1&includeParticipants=true`;

// Reshape a betoffer-group response into the participant blob the normalizer's individual path reads.
// Each distinct outcome participantId → one PARTICIPANT row; its competitions are the groupIds of the
// events it has offers in. Clean single players by construction (no LABEL, no dead ids). ponytail: no
// combo strip — the flip-worthy sports (darts/snooker/cycling) have zero; add one if flipping golf/tennis.
function participantsFromBetOffers(bo: { betOffers?: any[]; events?: any[] }): Participant[] {
  const eventGroup = new Map<number, number>();
  for (const e of bo.events ?? []) if (e.id && e.groupId) eventGroup.set(e.id, e.groupId);
  const byId = new Map<number, { name: string; groups: Set<number> }>();
  for (const b of bo.betOffers ?? []) {
    const g = eventGroup.get(b.eventId);
    for (const o of b.outcomes ?? []) {
      if (!o.participantId || !o.participant) continue;
      const rec = byId.get(o.participantId) ?? { name: o.participant, groups: new Set<number>() };
      if (g) rec.groups.add(g);
      byId.set(o.participantId, rec);
    }
  }
  return [...byId].map(([id, r]) => ({
    id,
    type: "PARTICIPANT",
    names: [{ locale: "en_GB", name: r.name }],
    groupIds: [...r.groups],
  }));
}
const TIMEOUT_MS = 120_000; // client abort → treat the group as too-big, split into children (NCAA feeds are slow: ~31s)
const CONCURRENCY = 4; // ponytail: pool the sport's direct children; kept modest so slow feeds don't get transient errors under load

type Node = { id: number; name?: string; groups?: Node[] };
type Participant = { id: number; type?: string; names?: { locale?: string; name?: string }[]; [k: string]: unknown };

// GET a feed via a headless browser (every non-browser fingerprint is 410'd — see curl-fetch.ts), retried `attempts` times.
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
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

function findNode(root: Node, id: number): Node | null {
  if (root.id === id) return root;
  for (const g of root.groups ?? []) {
    const f = findNode(g, id);
    if (f) return f;
  }
  return null;
}

// Twin checks go one at a time with a gap: 866 checks fired four at a time drew a 429 (rate limit) from the
// offering host on 2026-10-03, and the host publishes no limit to pace against. ponytail: a fixed pace of about
// 3 calls/s (football's ~866 ids take ~5 min); slow it further if the log ever counts a 429.
const TWIN_CHECK_GAP_MS = 250;

// Live bet-offer count for one participant id. Plain fetch through the runtime client, not the browser: the
// offering host serves Node, and a 404 must read as "no offers", which curlJsonOrNull folds into a failure.
// Any other failure is retried after a wait long enough to clear a rate limit (cleared within 15s when seen),
// then degrades to null so the caller can report it.
async function liveOfferCount(id: number, stats: { rateLimited: number }): Promise<number | null> {
  for (let a = 0; a < 3; a++) {
    if (a > 0) await sleep(30_000 * a);
    try {
      return (await betOffersByParticipants([id])).betOffers.length;
    } catch (e) {
      const message = (e as Error).message;
      if (message.startsWith("HTTP 404")) return 0; // Kambi prices nothing on this id: a real 0
      if (message.startsWith("HTTP 429")) stats.rateLimited++;
    }
  }
  return null;
}

// Stamp every TEAM that shares its English name with another TEAM with `liveBetOffers` (see the header).
async function markLiveTwins(participants: Participant[], slug: string): Promise<void> {
  const byName = new Map<string, Participant[]>();
  for (const p of participants) {
    const name = p.names?.find((n) => n.locale === "en_GB")?.name;
    if (p.type === "TEAM" && name) byName.set(name, [...(byName.get(name) ?? []), p]);
  }
  const twins = [...byName.values()].filter((g) => g.length > 1).flat();
  const stats = { rateLimited: 0 };
  const failed: number[] = [];
  const started = Date.now();
  for (const p of twins) {
    const n = await liveOfferCount(p.id, stats);
    if (n == null) failed.push(p.id);
    p.liveBetOffers = n ?? 0; // a failed check counts as 0, so the normalizer's roster tie-break decides the pair
    await sleep(TWIN_CHECK_GAP_MS);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `[${slug}] twin check: ${twins.length} same-name team ids in ${seconds}s, ${stats.rateLimited} rate-limited (429), ${failed.length} failed${failed.length ? `: ${failed.join(",")}` : ""}`,
  );
}

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "football";
  const config = getSport(slug);
  if (!config)
    throw new Error(`Unknown sport "${slug}" — not a top-level node in the offering tree (run fetch-groups first).`);
  const DATA = BUILD_DIR; // flat scratch: <slug>_participants_raw.json (+ tour feeds); groups.json is shared
  const out = process.argv[3] ?? join(DATA, `${config.slug}_participants_raw.json`);

  // Clean-source path: one betoffer-group call, reshape outcomes → participant blob. No tree, no crawl.
  if (config.participantsFrom === "betoffer") {
    const bo = await curlJsonOrNull(BETOFFER_GROUP(config.sportRootId), 90);
    if (!bo) throw new Error(`betoffer-group fetch failed for ${config.slug} (${config.sportRootId})`);
    const participants = participantsFromBetOffers(bo);
    writeFileSync(out, JSON.stringify({ participants }) + "\n");
    console.log(
      `[${config.slug}] betoffer-group: ${participants.length} players from ${(bo.events ?? []).length} events / ${(bo.betOffers ?? []).length} betOffers`,
    );
    console.log(`wrote ${out}`);
    return;
  }

  // Reads the FRESH tree fetch-groups wrote. GROUPS_FILE overrides the path (testing / validation).
  const raw = JSON.parse(readFileSync(process.env.GROUPS_FILE ?? GROUPS_PATH, "utf8"));
  const root: Node = "group" in raw ? raw.group : raw; // offering API wraps in {group:...}
  const sportNode = findNode(root, config.sportRootId);
  if (!sportNode) throw new Error(`sport root ${config.sportRootId} not in groups.json — run fetch-groups.ts first`);

  const children = sportNode.groups ?? [];
  console.log(`[${config.slug}] fetching participants across ${children.length} groups under ${sportNode.name}…`);
  const perChild = await mapPool(children, CONCURRENCY, (c) => fetchSubtree(c));

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
  const memberCount = (p: Participant): number => (p as { teamMembers?: unknown[] }).teamMembers?.length ?? 0;
  const bestById = new Map<number, Participant>();
  for (const p of parts) {
    const prev = bestById.get(p.id);
    if (!prev || memberCount(p) > memberCount(prev)) bestById.set(p.id, p);
  }
  const participants = [...bestById.values()];
  await markLiveTwins(participants, config.slug);

  writeFileSync(out, JSON.stringify({ participants }) + "\n");
  console.log(`\ntotal fetched: ${parts.length}, unique: ${participants.length}`);
  console.log(`wrote ${out}`);
}

main().finally(closeBrowser);
