// fetch-groups.ts — fetch the Kambi offering group tree into the shared build scratch.
//   tsx scripts/fetch-groups.ts             → writes .catalog-build/groups.json (the shared tree)
//   tsx scripts/fetch-groups.ts <out.json>  → writes the tree to one path (dry-run / inspection)
//
// The tree is the SAME for every sport (build-scope-index walks it from each sport's root), so we fetch
// it ONCE into .catalog-build/groups.json and every sport's build reads that one file. Response shape is
// {group:{...}} — build-scope-index already unwraps that.
//
// MARKET MATTERS: the operator/market in GROUPS_URL scopes WHICH competitions exist in the tree, and the
// tree is the competition whitelist. This is the kambi/GB tree — the full one the catalog came from.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { curlJson, closeBrowser } from "./curl-fetch";
import { GROUPS_PATH } from "../src/resolver/sports";

const GROUPS_URL = "https://eu.offering-api.kambicdn.com/offering/v2018/kambi/group.json?channel_id=1&client_id=200&lang=en_GB&market=GB";

async function main(): Promise<void> {
  const tree = await curlJson(GROUPS_URL);
  const blob = JSON.stringify(tree) + "\n";
  const out = process.argv[2] ?? GROUPS_PATH; // one shared tree for every sport (build-catalogs reuses it)
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, blob);
  console.log(`wrote ${out} (${blob.length} bytes)`);
}

main().finally(closeBrowser);
