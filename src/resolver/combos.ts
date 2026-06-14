// Eligible-combo set (Sprint 7): the combined catalog rows that are actually offered, the only rows the
// grounder's combo-assembly pass (ground-market.ts `assembleCombos`) is allowed to surface. A "combined"
// market joins two outcomes in its name ("Home Team to Win AND Both Teams To Score", "…Winner & Top
// Goalscorer"). 293 such rows exist in the catalog but only ~5 are EVER offered — the rest are legacy/
// off-season tail (Sprint 5). The offer-registry (`offer-registry.json`, ever-offered ⇒ real) is the filter
// that keeps the ~288 dead combos out, exactly as the WC26-subset hook filters the catalog — so this needs no
// live-menu fetch. Depends only on the catalog + registry (no ground-market import) to stay acyclic; the
// caller computes the side-stripped core tokens / twin pairing from these rows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "football");

export type EligibleCombo = { id: number; name: string };

// A name is "combined" iff it joins outcomes with a top-level "and" / "&". The same split the extractor
// applies to a query (prompt Step 3), read off the catalog name instead.
function isCombined(name: string): boolean {
  return / and | & /i.test(name);
}

let cache: EligibleCombo[] | undefined;

// Combined catalog rows ∩ ever-offered registry. Tiny (~5); memoized.
export function eligibleCombos(): EligibleCombo[] {
  if (cache) return cache;
  let ever: Set<number>;
  try {
    const reg = JSON.parse(readFileSync(join(DATA, "offer-registry.json"), "utf8"));
    ever = new Set(Object.keys(reg.criterions ?? {}).map(Number));
  } catch {
    ever = new Set(); // no registry ⇒ no eligible combos (fail safe: feature inert, never surfaces a dead combo)
  }
  return (cache = loadCatalog().list.filter((c) => ever.has(c.id) && isCombined(c.name)).map((c) => ({ id: c.id, name: c.name })));
}
