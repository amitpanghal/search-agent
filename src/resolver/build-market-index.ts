// Build the criterion-name vector index for grounding's vector tail (Stage B).
//   npm run build:index   (needs VOYAGE_API_KEY; run `npm run build:catalog` first)
// Embeds every criterion name in the rebuilt, post-quarantine catalog with voyage-3 as a "document"
// and writes the cache that ground-market.ts cosines incoming queries against. Each entry carries the
// criterion's `subject` bucket and `boTypeNames` so the query-time subject pre-filter and line→boType
// gate (decision 20) run straight off the index. The artifact is stamped with the catalog `version`,
// so a stale index vs a rebuilt catalog is detectable at load (E11). Run once, or whenever the catalog
// or the embedding model change. The model is pinned into the FILENAME, so swapping models writes a new
// file rather than silently overwriting vectors from a different space. The index is derived and
// needs the API key to rebuild, so its directory is gitignored.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog } from "./catalog";
import { embed, EMBED_MODEL } from "./embed";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(HERE, "index");
const OUT = join(OUT_DIR, `criterion-vectors.${EMBED_MODEL}.json`);

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!key || process.env[key]) continue;
    process.env[key] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  if (!process.env.VOYAGE_API_KEY) {
    console.error("VOYAGE_API_KEY is not set. Add it to .env (see .env.example).");
    process.exit(2);
  }

  const cat = loadCatalog();
  const names = cat.list.map((c) => c.name);
  console.log(`Embedding ${names.length} criterion names with ${EMBED_MODEL} (input_type=document)...`);

  const vecs = await embed(names, "document");
  if (vecs.length !== cat.list.length) {
    throw new Error(`Embedded ${vecs.length} vectors for ${cat.list.length} criterions — mismatch.`);
  }
  const dim = vecs[0]?.length ?? 0;
  if (!dim || vecs.some((v) => v.length !== dim)) {
    throw new Error("Embedding vectors have inconsistent dimensions.");
  }

  const criterions = cat.list.map((c, i) => ({
    id: c.id,
    name: c.name,
    subject: c.subject,
    boTypeNames: c.boTypeNames,
    vec: vecs[i],
  }));
  const artifact = {
    model: EMBED_MODEL,
    dim,
    builtAt: new Date().toISOString(),
    catalogVersion: cat.version,
    count: criterions.length,
    criterions,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact));
  console.log(`Wrote ${OUT}\n  ${criterions.length} vectors, dim ${dim}, catalog ${cat.version}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
