// build-categories.ts — decorate the raw category feed into the catalog's category input.
// Run: `npm run build:categories` (pure local transform, NO API calls).
//
// The offering-api category response is grouped by UI surface (`categoryGroups[]` — retail pages,
// digital signage, player_props, *_us, …), the SAME category id reappears under many groups, and the
// mappings carry only a numeric `boType` (no name). This collapses all 28 groups into the flat shape
// build-catalog.ts consumes:
//   - dedupe categories by id (a category id is one logical category regardless of which UI group it
//     surfaces under — `categoryGroupName` is ignored, per the feed owner's guidance),
//   - union each id's mappings across groups, deduped by `criterionId|boType`,
//   - resolve `boType` (numeric) -> `boTypeName` (the betoffertypes KEY, e.g. 2 -> "onecrosstwo") so the
//     line->boType gate (decision 20) can read names off the catalog.
// Output overwrites data/football/football_categories.json (the input build-catalog.ts joins against).
//
// Category NAME = the feed's `name` (fetched with lang=en_GB — the proper English display label).
// NOT `englishName`: that field is sometimes an internal slug or a different label ("Total Goals" ->
// "totals", "Full Time" -> "Match"), and subject tagging keys off the display name ("Goal Scorer",
// "Player*"), so a wrong name there silently mis-buckets a whole category.
//
// boType ids absent from football_betoffertypes.json (today: 5 and 15 — rare, scattered across
// Other Bets / Penalty Shootout / Team Progress) can't be named without guessing, so we OMIT boTypeName
// for them and keep the numeric boType. build-catalog.ts already guards `if (m.boTypeName)`, so an
// un-named mapping still joins its criterion to the category — it just contributes no boType-gate signal.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "data", "football");
const read = (f: string): any => JSON.parse(readFileSync(join(DATA, f), "utf8"));

type RawMapping = { criterionId: number; boType: number };
type RawCategory = { id: number; name?: string; englishName?: string; mappings?: RawMapping[] };
type RawGroup = { categoryGroupName?: string; categories?: RawCategory[] };
type BoTypeEntry = { id: number; label?: string };

type OutMapping = { criterionId: number; boType: number; boTypeName?: string };
type OutCategory = { id: number; name: string; mappings: OutMapping[] };

function main(): void {
  const raw = read("football_categories.raw.json") as { categoryGroups?: RawGroup[] };
  const betoffertypes = read("football_betoffertypes.json") as Record<string, BoTypeEntry>;

  // boType numeric id -> betoffertypes key-name (e.g. 2 -> "onecrosstwo").
  const boTypeNameById = new Map<number, string>();
  for (const [key, info] of Object.entries(betoffertypes)) boTypeNameById.set(info.id, key);

  // Dedupe categories by id; union mappings deduped by criterionId|boType.
  const byId = new Map<number, { name: string; mappings: Map<string, OutMapping> }>();
  const nameConflicts: string[] = [];
  const unresolvedBoTypes = new Map<number, number>(); // boType id -> mapping count (no betoffertypes name)

  for (const g of raw.categoryGroups ?? []) {
    for (const c of g.categories ?? []) {
      const name = (c.name ?? c.englishName ?? "").trim();
      if (c.id == null || !name) continue;

      let entry = byId.get(c.id);
      if (!entry) {
        entry = { name, mappings: new Map() };
        byId.set(c.id, entry);
      } else if (entry.name !== name && nameConflicts.length < 20) {
        nameConflicts.push(`${c.id}: "${entry.name}" vs "${name}"`);
      }

      for (const m of c.mappings ?? []) {
        if (m.criterionId == null || m.boType == null) continue;
        const dedupeKey = `${m.criterionId}|${m.boType}`;
        if (entry.mappings.has(dedupeKey)) continue;
        const boTypeName = boTypeNameById.get(m.boType);
        if (boTypeName === undefined) unresolvedBoTypes.set(m.boType, (unresolvedBoTypes.get(m.boType) ?? 0) + 1);
        entry.mappings.set(
          dedupeKey,
          boTypeName === undefined ? { criterionId: m.criterionId, boType: m.boType } : { criterionId: m.criterionId, boType: m.boType, boTypeName },
        );
      }
    }
  }

  const categories: OutCategory[] = [...byId.entries()]
    .map(([id, e]) => ({
      id,
      name: e.name,
      mappings: [...e.mappings.values()].sort((a, b) => a.criterionId - b.criterionId || a.boType - b.boType),
    }))
    .sort((a, b) => a.id - b.id);

  const mappingCount = categories.reduce((n, c) => n + c.mappings.length, 0);
  const distinctCriterions = new Set<number>();
  for (const c of categories) for (const m of c.mappings) distinctCriterions.add(m.criterionId);

  const out = {
    sport: "FOOTBALL",
    counts: { categories: categories.length, mappings: mappingCount },
    categories,
  };
  writeFileSync(join(DATA, "football_categories.json"), JSON.stringify(out, null, 2) + "\n");

  // ---- report ----
  console.log(`categories decorated — ${categories.length} categories, ${mappingCount} mappings`);
  console.log(`  distinct criterions referenced: ${distinctCriterions.size}`);
  if (unresolvedBoTypes.size) {
    const summary = [...unresolvedBoTypes.entries()].sort((a, b) => a[0] - b[0]).map(([id, n]) => `${id} (${n} mappings)`).join(", ");
    console.log(`  ⚠ boType ids absent from betoffertypes — boTypeName omitted, numeric boType kept: ${summary}`);
  }
  if (nameConflicts.length) {
    console.log(`  ⚠ ${nameConflicts.length} category ids carried >1 name across groups (kept first-seen):`);
    for (const c of nameConflicts) console.log(`      ${c}`);
  }
  console.log(`  wrote data/football/football_categories.json`);
}

main();
