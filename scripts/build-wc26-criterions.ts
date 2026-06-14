// build-wc26-criterions.ts — materialize the WC-2026 criterion set as full catalog rows.
//   npx tsx scripts/build-wc26-criterions.ts   (also run via `npm run refresh:wc26`)
// Population = every criterion observed on the WC-2026 group in offer-stats.json (written by
// refresh-wc26.ts) — i.e. WC26-group-scoped, not the cross-competition offer-registry.
// Each row reuses the full catalog's fields (name/categoryNames/boTypeNames/shown*/subject/side)
// and gets its `level` from the same offer-stats entry. `level` is omitted when the criterion was
// only seen on untagged events. Observed ids with no catalog row (quarantined per-player rows) are
// skipped and reported.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "football");
const read = (f: string): any => JSON.parse(readFileSync(join(DATA, f), "utf8"));

const stats = read("offer-stats.json") as { groupId: number | string; stats: Record<string, { level?: string }> };
const catalog = read("football_criterions.json") as { version: string; criterions: any[] };

const byId = new Map<number, any>(catalog.criterions.map((c) => [c.id, c]));
const levelOf = (id: number): "fixture" | "competition" | undefined => {
  const lvl = stats.stats[String(id)]?.level;
  return lvl === "fixture" || lvl === "competition" ? lvl : undefined;
};

const out: any[] = [];
const skipped: number[] = [];
for (const key of Object.keys(stats.stats)) {
  const id = Number(key);
  const c = byId.get(id);
  if (!c) {
    skipped.push(id); // quarantined / no catalog row -> can't fill fields
    continue;
  }
  const level = levelOf(id);
  out.push({
    id: c.id,
    sport: c.sport,
    name: c.name,
    categoryNames: c.categoryNames,
    boTypeNames: c.boTypeNames,
    shownInLive: c.shownInLive,
    shownInPreMatch: c.shownInPreMatch,
    subject: c.subject,
    side: c.side,
    ...(level ? { level } : {}),
  });
}
out.sort((a, b) => a.id - b.id);

const artifact = {
  builtAt: new Date().toISOString(),
  source: {
    population: `offer-stats.json (WC-2026 group ${stats.groupId} observed criterions)`,
    levelFrom: `offer-stats.json (group ${stats.groupId})`,
    fieldsFrom: `football_criterions.json (catalog ${catalog.version})`,
  },
  counts: {
    observed: Object.keys(stats.stats).length,
    written: out.length,
    skipped: skipped.length,
    withLevel: out.filter((c) => c.level).length,
    levelFixture: out.filter((c) => c.level === "fixture").length,
    levelCompetition: out.filter((c) => c.level === "competition").length,
  },
  criterions: out,
};

writeFileSync(join(DATA, "WC26_criterions.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(`wrote data/football/WC26_criterions.json`);
console.log(`  observed=${artifact.counts.observed}  written=${out.length}  skipped(no catalog row)=${skipped.length}`);
console.log(`  withLevel=${artifact.counts.withLevel}  fixture=${artifact.counts.levelFixture}  competition=${artifact.counts.levelCompetition}  none=${out.length - artifact.counts.withLevel}`);
if (skipped.length) console.log(`  skipped ids: ${skipped.slice(0, 15).join(", ")}${skipped.length > 15 ? " …" : ""}`);
