// bo-types — the single source of truth for the sport-agnostic betOfferType buckets.
//
// Loads data/betoffertypes.json (the 22 coarse market-type buckets, `{ id, label, gloss }`) and exposes
// everything the pipeline needs from it: the enum tuple for the extractor schema, token<->id mapping for the
// fetch/prune use-sites, and the prompt reference block injected into extractor-prompt.md's `{{BO_TYPES}}`
// placeholder. The DATA FILE — not the prompt — is the source of truth; edit the buckets there.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type BoType = { id: number; label: string; gloss: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(
  readFileSync(join(HERE, "..", "..", "data", "betoffertypes.json"), "utf8"),
) as Record<string, BoType>;

// The bucket tokens (the object keys), as a non-empty tuple so `z.enum` accepts them. A hallucinated token
// cannot leak: the schema validates against exactly these.
export const BO_TYPE_KEYS = Object.keys(CATALOG) as [string, ...string[]];

const ID_BY_KEY = new Map<string, number>(Object.entries(CATALOG).map(([k, v]) => [k, v.id]));

// token -> numeric betOfferType id (the feed's `betOfferType.id` / the `type=` fetch param). `undefined` for
// an unknown token — callers drop those (fail-open).
export const boTypeId = (key: string): number | undefined => ID_BY_KEY.get(key);

// a list of tokens -> the set of their ids (unknown tokens dropped). Empty in -> empty set.
export const boTypeIdSet = (keys: string[]): Set<number> => {
  const out = new Set<number>();
  for (const k of keys) {
    const id = ID_BY_KEY.get(k);
    if (id != null) out.add(id);
  }
  return out;
};

// The reference block injected into the extractor prompt's `{{BO_TYPES}}` placeholder: one `- token — Label:
// gloss` line per bucket, in catalog order.
export const BO_TYPE_REFERENCE = Object.entries(CATALOG)
  .map(([k, v]) => `- ${k} — ${v.label}: ${v.gloss}`)
  .join("\n");
