// scripts/refresh-wc26.ts — one job: fetch the WC-2026 group's live offering and rebuild the WC26 feed.
//   npm run refresh:wc26            # default group 2010133908 (WC-2026)
//   npx tsx scripts/refresh-wc26.ts <groupId>
//
// Pipeline:
//   1. GET /event/group/{group}  → every event (ALL states — no NOT_STARTED filter; we want max
//      criterion coverage for the WC group, in-play/finished included). A single group has no esports.
//   2. Batched GET /betoffer/event/{ids} (2 fixture / 6 other per call) to stay under the ~2000-betoffer
//      hard cap — the group endpoint can't return a whole group, so we go events-first + small batches.
//   3. Per criterion, count the fixture (MATCH) and competition (COMPETITION) events it appears in and
//      derive `level` = whichever it shows up in proportionally more → write data/football/offer-stats.json
//      (this is the producer that artifact previously lacked).
//   4. Run build-wc26-criterions.ts → data/football/WC26_criterions.json (WC26-group-scoped population).
//
// Offering host (eu.offering-api…) serves node fetch fine — only the feeds-eu criterion host TLS-blocks node.
// Public-CDN GETs, no auth. Needs the Bash sandbox DISABLED to reach the network.

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "football");
const BASE = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi";
const Q = "lang=en_GB&market=GB";
const GROUP = process.argv[2] ?? "2010133908";

type Ev = { id: number; tags?: string[]; state?: string };
type Bo = { eventId?: number; criterion?: { id?: number } };
type Level = "fixture" | "competition";

const levelOf = (tags: string[] = []): Level | null =>
  tags.includes("COMPETITION") ? "competition" : tags.includes("MATCH") ? "fixture" : null;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.json();
}
function* batches<T>(a: T[], n: number): Generator<T[]> {
  for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n);
}

async function main(): Promise<void> {
  const events: Ev[] = (await getJson(`${BASE}/event/group/${GROUP}?${Q}`)).events ?? [];
  const level = new Map<number, Level>(); // only MATCH / COMPETITION events carry a level
  for (const e of events) {
    const l = levelOf(e.tags);
    if (l) level.set(e.id, l);
  }
  const matchIds = events.filter((e) => level.get(e.id) === "fixture").map((e) => e.id);
  const restIds = events.filter((e) => level.get(e.id) !== "fixture").map((e) => e.id); // comp + untagged
  const nFix = matchIds.length;
  const nComp = events.filter((e) => level.get(e.id) === "competition").length;
  process.stderr.write(`group ${GROUP}: ${events.length} events (all states) — ${nFix} fixture + ${nComp} competition + ${events.length - nFix - nComp} other\n`);

  // criterion id -> set of (fixture / competition) event ids it was offered in
  const fixSeen = new Map<number, Set<number>>();
  const compSeen = new Map<number, Set<number>>();
  const seen = new Set<number>();
  let totalBO = 0;
  const see = (m: Map<number, Set<number>>, cid: number, eid: number) => {
    let s = m.get(cid);
    if (!s) m.set(cid, (s = new Set()));
    s.add(eid);
  };
  const pull = async (ids: number[], size: number, lbl: string) => {
    let done = 0;
    for (const b of batches(ids, size)) {
      let resp: any;
      try {
        resp = await getJson(`${BASE}/betoffer/event/${b.join("%2C")}?excludePrePacks=true&${Q}`);
      } catch (e) {
        process.stderr.write(`\n  ! ${lbl} batch failed (${(e as Error).message})\n`);
        done += b.length;
        continue;
      }
      const bos: Bo[] = resp.betOffers ?? [];
      totalBO += bos.length;
      for (const bo of bos) {
        const cid = bo.criterion?.id;
        const eid = bo.eventId;
        if (cid == null || eid == null) continue;
        seen.add(cid);
        const l = level.get(eid);
        if (l === "fixture") see(fixSeen, cid, eid);
        else if (l === "competition") see(compSeen, cid, eid);
      }
      done += b.length;
      process.stderr.write(`\r  ${lbl}: ${done}/${ids.length} events, ${totalBO} betoffers`);
    }
    process.stderr.write("\n");
  };
  await pull(matchIds, 2, "fixture");
  await pull(restIds, 6, "other");

  // Per-criterion level = the level it appears in proportionally more (freq = events-seen / events-of-level).
  const stats: Record<string, { level?: Level; fixtureFreq: number; compFreq: number; fixtureEvents: number; compEvents: number }> = {};
  for (const cid of [...seen].sort((a, b) => a - b)) {
    const fix = fixSeen.get(cid)?.size ?? 0;
    const comp = compSeen.get(cid)?.size ?? 0;
    const fixtureFreq = nFix ? fix / nFix : 0;
    const compFreq = nComp ? comp / nComp : 0;
    const lvl: Level | undefined = fix === 0 && comp === 0 ? undefined : fixtureFreq >= compFreq ? "fixture" : "competition";
    stats[String(cid)] = { ...(lvl ? { level: lvl } : {}), fixtureFreq, compFreq, fixtureEvents: fix, compEvents: comp };
  }

  const artifact = {
    source: "kambi",
    groupId: Number(GROUP),
    pulledAt: new Date().toISOString(),
    nFixtureEvents: nFix,
    nCompEvents: nComp,
    nDistinctCriterions: seen.size,
    totalBetOffers: totalBO,
    stats,
  };
  writeFileSync(join(DATA, "offer-stats.json"), JSON.stringify(artifact, null, 1) + "\n");
  const withLevel = Object.values(stats).filter((s) => s.level).length;
  process.stderr.write(`\nwrote data/football/offer-stats.json — ${seen.size} criterions (${withLevel} leveled), ${totalBO} betoffers\n`);

  process.stderr.write(`\n--- build:wc26 ---\n`);
  execSync("npm run build:wc26", { cwd: ROOT, stdio: "inherit" });
}

main().catch((e) => {
  process.stderr.write(`refresh-wc26 failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
