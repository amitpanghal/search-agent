// sweep-offerings — Phase 2 of planning/extractor-rebuild-plan.md. Builds a per-sport FACT SHEET from the
// live feed + the built catalogs, so the corpus, the alias tables and the extractor's rules are written
// against what the offering actually carries instead of guesswork.
//
//   npm run sweep                      # every built sport -> .sweep/<sport>.json + a summary table
//   npm run sweep -- tennis football   # just these
//
// Kambi only: NO LLM, no cost. Per sport it reads the sport-root event list, picks the groups that actually
// have events, and pulls their menus — the root menu alone is capped at 2000 offers, which truncates the
// dense sports (tennis 545 families) and would under-report exactly the ones we most need to see.
//
// Collects, per sport: competition names (catalog) vs the groups the feed is really serving (gaps both ways),
// the market families with their betOfferType + grain, the betOfferType mix, and the event-name shape
// ("A - B" vs "B @ A") — the last one is the root cause of the home/away side inversion the probes found.

import { mkdirSync, writeFileSync } from "node:fs";
import { eventsByGroup, betOffersByGroup, levelOf, type BetOffer, type KEvent } from "../src/resolver/offering-client";
import { marketLabelOf } from "../src/resolver/recall";
import { loadScopeCatalog } from "../src/resolver/scope-catalog";
import { builtSports } from "../src/resolver/sports";

const OUT = ".sweep";
const GROUPS_PER_SPORT = 12; // busiest groups by event count — covers each sport's real offering without a full fan-out

type Family = { label: string; type: string; level: string; offers: number; events: number; sampleOutcomes: string[] };
type Sheet = {
  sport: string;
  rootId: number;
  catalogGroups: number;
  feedGroupsSampled: { id: number; name: string; events: number; inCatalog: boolean }[];
  missingFromCatalog: { id: number; name: string; events: number }[];
  eventNameShape: { dash: number; at: number; other: number; samples: string[] };
  betOfferTypes: Record<string, number>;
  families: Family[];
  // Raw material for authoring corpus queries (Phase 4): real upcoming fixtures and real participant names, so
  // a test query names something the feed can actually resolve instead of a plausible-sounding invention.
  sampleFixtures: { name: string; home?: string; away?: string; start: string; group: string }[];
  sampleParticipants: string[];
};

const shapeOf = (name: string): "dash" | "at" | "other" =>
  / - /.test(name) ? "dash" : / @ /.test(name) ? "at" : "other";

async function sweepSport(sport: string): Promise<Sheet | { sport: string; error: string }> {
  const cat = loadScopeCatalog(sport);
  if (!cat.sportRootId) return { sport, error: "no sportRootId in catalog" };

  let rootEvents: KEvent[] = [];
  try {
    rootEvents = await eventsByGroup(cat.sportRootId);
  } catch (e) {
    return { sport, error: `event/group/${cat.sportRootId}: ${(e as Error).message}` };
  }
  if (!rootEvents.length) return { sport, error: "no live events under the sport root" };

  // the groups actually serving events, busiest first
  const byGroup = new Map<number, number>();
  for (const e of rootEvents) if (e.groupId != null) byGroup.set(e.groupId, (byGroup.get(e.groupId) ?? 0) + 1);
  const ranked = [...byGroup].sort((a, b) => b[1] - a[1]).slice(0, GROUPS_PER_SPORT);

  const menus = await Promise.all(
    ranked.map(([gid]) => betOffersByGroup(gid).catch(() => ({ betOffers: [] as BetOffer[], events: [] as KEvent[] }))),
  );

  // one event index across every menu, so a betoffer can be tied back to ITS OWN fixture (grain + name shape)
  const evById = new Map<number, KEvent>();
  for (const e of rootEvents) if (e.id != null) evById.set(e.id, e);
  for (const m of menus) for (const e of m.events) if (e.id != null) evById.set(e.id, e);

  const offers: BetOffer[] = [];
  const seen = new Set<number>();
  for (const m of menus) for (const b of m.betOffers) if (b.id == null || !seen.has(b.id)) { if (b.id != null) seen.add(b.id); offers.push(b); }

  const fams = new Map<string, Family & { evIds: Set<number> }>();
  const types: Record<string, number> = {};
  for (const b of offers) {
    const type = b.betOfferType?.englishName ?? b.betOfferType?.name ?? "?";
    types[type] = (types[type] ?? 0) + 1;
    const label = marketLabelOf(b);
    let f = fams.get(label);
    if (!f) {
      fams.set(label, (f = {
        label,
        type,
        level: levelOf(evById.get(b.eventId ?? -1)?.tags) ?? "?",
        offers: 0,
        events: 0,
        evIds: new Set<number>(),
        // un-localized labels; the participant shows which families are per-player (the prop/total twin split)
        sampleOutcomes: (b.outcomes ?? []).slice(0, 4).map((o) => `${o.englishLabel ?? o.label ?? "?"}${o.participant ? ` [${o.participant}]` : ""}`),
      }));
    }
    f.offers++;
    if (b.eventId != null) f.evIds.add(b.eventId);
  }

  const shape = { dash: 0, at: 0, other: 0, samples: [] as string[] };
  for (const e of rootEvents) {
    const n = e.name ?? "";
    if (!n) continue;
    shape[shapeOf(n)]++;
    if (shape.samples.length < 3) shape.samples.push(n);
  }

  const groupName = (id: number) => cat.groupById.get(id)?.name ?? menus.flatMap((m) => m.events).find((e) => e.groupId === id)?.group ?? String(id);
  const sampled = ranked.map(([id, events]) => ({ id, name: groupName(id), events, inCatalog: !!cat.groupById.get(id) }));

  // Upcoming fixtures only (a finished game makes a useless corpus query), soonest first.
  const now = Date.now();
  const sampleFixtures = rootEvents
    .filter((e) => e.start && Date.parse(e.start) > now)
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))
    .slice(0, 10)
    .map((e) => ({ name: e.name ?? "", ...(e.homeName ? { home: e.homeName } : {}), ...(e.awayName ? { away: e.awayName } : {}), start: e.start ?? "", group: e.group ?? "" }));
  // Real participant names off the menus — the ones player-prop and outright queries have to name.
  const parts = new Set<string>();
  for (const b of offers)
    for (const o of b.outcomes ?? []) {
      const p = (o.participant ?? "").trim();
      if (p && p !== "Yes" && p !== "No" && p !== (o.englishLabel ?? o.label) && parts.size < 40) parts.add(p);
    }

  return {
    sport,
    rootId: cat.sportRootId,
    catalogGroups: cat.groups.length,
    sampleFixtures,
    sampleParticipants: [...parts],
    feedGroupsSampled: sampled,
    missingFromCatalog: sampled.filter((g) => !g.inCatalog).map(({ id, name, events }) => ({ id, name, events })),
    eventNameShape: shape,
    betOfferTypes: types,
    families: [...fams.values()]
      .map(({ evIds, ...f }) => ({ ...f, events: evIds.size }))
      .sort((a, b) => b.offers - a.offers),
  };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const sports = only.length ? only : builtSports();
  mkdirSync(OUT, { recursive: true });

  const rows: string[] = [];
  for (const sport of sports) {
    const sheet = await sweepSport(sport);
    if ("error" in sheet) {
      rows.push(`${sport.padEnd(20)} ERROR ${sheet.error}`);
      console.log(`${sport.padEnd(20)} ERROR ${sheet.error}`);
      continue;
    }
    writeFileSync(`${OUT}/${sport}.json`, JSON.stringify(sheet, null, 2));
    const s = sheet.eventNameShape;
    const line =
      `${sport.padEnd(20)} groups=${String(sheet.feedGroupsSampled.length).padStart(2)}/${String(sheet.catalogGroups).padStart(3)}` +
      ` families=${String(sheet.families.length).padStart(4)} types=${String(Object.keys(sheet.betOfferTypes).length).padStart(2)}` +
      ` name=${s.dash}dash/${s.at}at/${s.other}other` +
      (sheet.missingFromCatalog.length ? `  MISSING-FROM-CATALOG: ${sheet.missingFromCatalog.map((g) => g.name).join(", ")}` : "");
    rows.push(line);
    console.log(line);
  }
  console.log(`\n${rows.length} sport(s) swept -> ${OUT}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
