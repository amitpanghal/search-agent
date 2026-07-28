// fetch-groups.ts — fetch the Kambi offering group tree and drop it where the scope build reads it.
//   tsx scripts/fetch-groups.ts             → writes data/<sport>/groups.json for every sport
//   tsx scripts/fetch-groups.ts <out.json>  → writes the tree to one path (dry-run / inspection)
//
// The tree is the SAME for every sport (build-scope-index walks it from each sport's root), so we fetch
// once and copy it into each data/<sport>/ dir. Response shape is {group:{...}} — build-scope-index
// already unwraps that.
//
// MARKET MATTERS: the operator/market in GROUPS_URL scopes WHICH competitions exist in the tree, and the
// tree is the competition whitelist. This is the kambi/GB tree — the full one the catalog came from.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { curlJson } from "./curl-fetch";
import { SPORTS } from "../src/resolver/sports";

const GROUPS_URL = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi/group.json?channel_id=1&client_id=200&lang=en_GB&market=GB";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const tree = await curlJson(GROUPS_URL);
  const blob = JSON.stringify(tree) + "\n";

  const single = process.argv[2];
  if (single) {
    writeFileSync(single, blob);
    console.log(`wrote ${single} (${blob.length} bytes)`);
    return;
  }
  for (const s of Object.values(SPORTS)) {
    writeFileSync(join(HERE, "..", "data", s.slug, "groups.json"), blob);
    console.log(`wrote data/${s.slug}/groups.json (${blob.length} bytes)`);
  }
}

main();
