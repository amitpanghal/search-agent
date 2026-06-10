// scripts/probe-offers.ts — Sprint 5 (decision 26): accumulating offer-observation registry.
//
//   npx tsx scripts/probe-offers.ts <groupId> [label]   # pull ONE group, merge into the registry
//   npx tsx scripts/probe-offers.ts --all               # enumerate EVERY in-season football competition
//                                                        # (esports excluded) and merge them all
//
// Events-first → batched /betoffer/event (under the ~2000-betoffer cap). Each betoffer carries criterion.id;
// the parent event's MATCH/COMPETITION tag = the level. Only NOT_STARTED (prematch) events are counted —
// in-play TRIMS the menu, so a started event would wrongly suggest markets are "absent".
//
// The registry is the catalog-hygiene signal: trust PRESENCE (ever-offered ⇒ live), never absence-from-a-
// snapshot. Each run is idempotent per group (re-pulling a group REPLACES its contribution); criterion
// entries are never deleted (ever-seen ⇒ not legacy). Noise = catalog ids NEVER in the registry after broad +
// sustained coverage — we only REPORT that count; quarantine is a later, reviewed step gated on the
// seasonal-cycle coverage bar. Also emits a gap report (offered ids MISSING from our catalog). Read-only
// public-CDN GETs (no auth); the registry is the only artifact written.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REG = join(ROOT, "data", "football", "offer-registry.json");
const BASE = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi";
const Q = "lang=en_GB&market=GB";

type Ev = { id: number; tags?: string[]; state?: string };
type Bo = { eventId?: number; criterion?: { id?: number; label?: string } };
type Level = "fixture" | "competition";
type Contribution = { fixtureEvents: number; compEvents: number };
type CritEntry = { firstSeen: string; lastSeen: string; byComp: Record<string, Contribution>; label?: string };
type Registry = {
  updatedAt: string;
  competitions: Record<string, { label: string; lastPulled: string; nFixtureEvents: number; nCompEvents: number }>;
  criterions: Record<string, CritEntry>;
};
type PullResult = { perCrit: Map<number, Contribution>; labels: Map<number, string>; nFix: number; nComp: number };

const levelOf = (tags: string[] = []): Level | null =>
  tags.includes("COMPETITION") ? "competition" : tags.includes("MATCH") ? "fixture" : null;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function* batches<T>(a: T[], n: number): Generator<T[]> {
  for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n);
}

async function pullGroup(groupId: string, label: string, quiet = false): Promise<PullResult> {
  const events: Ev[] = (await getJson(`${BASE}/event/group/${groupId}?${Q}`)).events ?? [];
  const level = new Map<number, Level>();
  for (const e of events) {
    if (e.state !== "NOT_STARTED") continue; // prematch only — in-play trims the menu
    const l = levelOf(e.tags);
    if (l) level.set(e.id, l);
  }
  const matchIds = [...level].filter(([, l]) => l === "fixture").map(([id]) => id);
  const compIds = [...level].filter(([, l]) => l === "competition").map(([id]) => id);
  if (!quiet) process.stderr.write(`${label}: ${level.size} prematch events (${matchIds.length} fixture + ${compIds.length} competition)\n`);

  const fixSeen = new Map<number, Set<number>>();
  const compSeen = new Map<number, Set<number>>();
  const labels = new Map<number, string>();
  const see = (m: Map<number, Set<number>>, cid: number, eid: number) => {
    let s = m.get(cid);
    if (!s) m.set(cid, (s = new Set()));
    s.add(eid);
  };
  let total = 0;
  const pull = async (ids: number[], size: number, lbl: string) => {
    let done = 0;
    for (const b of batches(ids, size)) {
      let resp: any;
      try {
        resp = await getJson(`${BASE}/betoffer/event/${b.join("%2C")}?excludePrePacks=true&${Q}`);
      } catch (e) {
        if (!quiet) process.stderr.write(`\n  ! ${lbl} batch failed (${(e as Error).message})\n`);
        done += b.length;
        continue;
      }
      const bos: Bo[] = resp.betOffers ?? [];
      total += bos.length;
      for (const bo of bos) {
        const cid = bo.criterion?.id;
        const eid = bo.eventId;
        if (cid == null || eid == null) continue;
        if (bo.criterion?.label && !labels.has(cid)) labels.set(cid, bo.criterion.label);
        const l = level.get(eid);
        if (l === "fixture") see(fixSeen, cid, eid);
        else if (l === "competition") see(compSeen, cid, eid);
      }
      done += b.length;
      if (!quiet) process.stderr.write(`\r  ${lbl}: ${done}/${ids.length} events, ${total} betoffers`);
    }
    if (!quiet) process.stderr.write("\n");
  };
  await pull(matchIds, 2, "fixture");
  await pull(compIds, 6, "competition");

  const perCrit = new Map<number, Contribution>();
  for (const id of new Set([...fixSeen.keys(), ...compSeen.keys()]))
    perCrit.set(id, { fixtureEvents: fixSeen.get(id)?.size ?? 0, compEvents: compSeen.get(id)?.size ?? 0 });
  return { perCrit, labels, nFix: matchIds.length, nComp: compIds.length };
}

// idempotent per-group merge: drop this group's prior contribution everywhere, then re-add this pull's.
function mergeGroup(reg: Registry, groupId: string, label: string, res: PullResult, now: string): void {
  for (const e of Object.values(reg.criterions)) delete e.byComp[groupId];
  reg.competitions[groupId] = { label, lastPulled: now, nFixtureEvents: res.nFix, nCompEvents: res.nComp };
  for (const [id, contrib] of res.perCrit) {
    const k = String(id);
    const e = reg.criterions[k] ?? (reg.criterions[k] = { firstSeen: now, lastSeen: now, byComp: {} });
    e.byComp[groupId] = contrib;
    e.lastSeen = now;
    const lab = res.labels.get(id);
    if (lab) e.label = lab;
  }
}

function loadRegistry(): Registry {
  if (existsSync(REG)) return JSON.parse(readFileSync(REG, "utf8"));
  return { updatedAt: "", competitions: {}, criterions: {} };
}

// enumerate every football leaf competition (eventCount>0, no child groups), excluding synthetic esports.
async function footballComps(): Promise<{ id: string; label: string; ev: number }[]> {
  const root = (await getJson(`${BASE}/group?${Q}`)).group;
  const findFb = (n: any): any => {
    if (!n) return null;
    if (n.termKey === "football" || n.englishName === "Football" || n.name === "Football") return n;
    for (const c of n.groups ?? []) {
      const r = findFb(c);
      if (r) return r;
    }
    return null;
  };
  const fb = findFb(root);
  if (!fb) return [];
  const leaves: { id: string; label: string; ev: number }[] = [];
  const walk = (n: any, path: string) => {
    const nm = n.englishName || n.name;
    const p = path ? `${path} / ${nm}` : nm;
    const kids = n.groups ?? [];
    if ((n.eventCount || 0) > 0 && kids.length === 0) leaves.push({ id: String(n.id), label: p.replace(/^Football \/ /, ""), ev: n.eventCount || 0 });
    for (const c of kids) walk(c, p);
  };
  walk(fb, "");
  return leaves.filter((g) => !/esports/i.test(g.label));
}

function report(reg: Registry): void {
  const cat = JSON.parse(readFileSync(join(ROOT, "data", "football", "football_criterions.json"), "utf8"));
  const known = new Set<number>(cat.criterions.map((c: any) => c.id));
  const everSeenInCat = Object.keys(reg.criterions).map(Number).filter((id) => known.has(id)).length;
  const neverSeen = cat.criterions.length - everSeenInCat;
  const totFix = Object.values(reg.competitions).reduce((n, c) => n + c.nFixtureEvents, 0);
  const totComp = Object.values(reg.competitions).reduce((n, c) => n + c.nCompEvents, 0);
  const gaps = Object.entries(reg.criterions).filter(([id]) => !known.has(Number(id)));
  console.log(`\nregistry → data/football/offer-registry.json`);
  console.log(`groups: ${Object.keys(reg.competitions).length} | events: ${totFix} fixture + ${totComp} competition`);
  console.log(`\ncatalog hygiene (trust PRESENCE, not absence — do NOT quarantine yet):`);
  console.log(`  ever-offered (in catalog): ${everSeenInCat}/${cat.criterions.length}`);
  console.log(`  never-seen so far (legacy CANDIDATES — needs seasonal-cycle coverage before any action): ${neverSeen}`);
  console.log(`\ngap report — offered live but MISSING from our catalog: ${gaps.length}`);
  for (const [id, e] of gaps.slice(0, 20)) console.log(`  ${id} "${e.label ?? "?"}"`);
  if (gaps.length > 20) console.log(`  … and ${gaps.length - 20} more`);
}

async function main(): Promise<void> {
  const reg = loadRegistry();
  const now = new Date().toISOString();
  if (process.argv.includes("--all")) {
    const comps = await footballComps();
    process.stderr.write(`enumerated ${comps.length} football competitions (esports excluded)\n`);
    let i = 0;
    for (const c of comps) {
      i++;
      process.stderr.write(`[${i}/${comps.length}] ${c.label} (${c.ev} ev) … `);
      try {
        const res = await pullGroup(c.id, c.label, true);
        mergeGroup(reg, c.id, c.label, res, now);
        process.stderr.write(`${res.perCrit.size} criterions\n`);
      } catch (e) {
        process.stderr.write(`FAILED ${(e as Error).message}\n`);
      }
    }
  } else {
    const groupId = process.argv[2] ?? "2010133908";
    const label = process.argv[3] ?? groupId;
    const res = await pullGroup(groupId, label);
    mergeGroup(reg, groupId, label, res, now);
  }
  reg.updatedAt = now;
  writeFileSync(REG, JSON.stringify(reg, null, 1) + "\n");
  report(reg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
