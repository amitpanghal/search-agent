// concat-feeds.ts — union all basketball feed files into one blob for the normalizer.
// Usage: tsx scripts/basketball/concat-feeds.ts
// Output: data/basketball/basketball_participants_raw.json
//
// Deduplication is by participant id (first occurrence wins). Feeds share national-team players
// who appear in multiple league files — their NBA-feed entry is kept, later duplicates dropped.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "data", "basketball");
const OUT = join(DATA, "basketball_participants_raw.json");

// Skip output artifacts that live alongside the source feeds.
const SKIP = new Set(["basketball_participants.json", "basketball_participants_raw.json", "scope-index.json", "scope-aliases.json"]);

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
