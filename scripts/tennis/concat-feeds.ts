// concat-feeds.ts — union all tennis feed files into one blob for the normalizer.
// Usage: tsx scripts/tennis/concat-feeds.ts
// Output: data/tennis/tennis_participants_raw.json
//
// Deduplication is by participant id (first occurrence wins). Feeds share players
// who appear in multiple tour files — their first-encountered entry is kept.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "data", "tennis");
const OUT = join(DATA, "tennis_participants_raw.json");

const SKIP = new Set(["tennis_participants.json", "tennis_participants_raw.json", "scope-index.json", "scope-aliases.json", "groups.json"]);

type RawParticipant = { id: number; [k: string]: unknown };
type Feed = { participants?: RawParticipant[] };

const seen = new Set<number>();
const participants: RawParticipant[] = [];

for (const file of readdirSync(DATA).sort()) {
  if (!file.endsWith(".json") || SKIP.has(file)) continue;
  const feed = JSON.parse(readFileSync(join(DATA, file), "utf8")) as Feed;
  const all = feed.participants ?? [];
  let added = 0;
  for (const p of all) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      participants.push(p);
      added++;
    }
  }
  console.log(`  ${file}: +${added} unique  (${all.length} total, ${all.length - added} dupes)`);
}

writeFileSync(OUT, JSON.stringify({ participants }) + "\n");
console.log(`\ntotal unique: ${participants.length}`);
console.log(`wrote: ${OUT}`);
