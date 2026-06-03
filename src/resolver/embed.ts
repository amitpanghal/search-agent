// The single embedding seam for grounding's vector tail (Stage B). Voyage REST via Node's global
// `fetch` — zero new deps. Same model both sides (build the criterion-name vectors AND embed the
// incoming query through here) so cosine compares within one vector space (project memory:
// voyage-3). This `embed()` is the swap point: a later local in-process model replaces this file
// and nothing upstream changes.
//
// Voyage REST: POST /v1/embeddings, bearer VOYAGE_API_KEY, body { input, model, input_type }.
// `input_type` = "document" for the catalog names, "query" for the incoming market text — Voyage
// prepends a retrieval prompt per side (verified against current docs, 2026-06).

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
export const EMBED_MODEL = "voyage-3";

// Voyage caps a request at 1000 inputs; we stay well under so the per-request token ceiling is a
// non-issue for short criterion names and the failure blast radius is one small chunk.
const BATCH = 128;

export type InputType = "document" | "query";

type VoyageRow = { embedding?: number[]; index?: number };
type VoyageResponse = { data?: VoyageRow[] };

export async function embed(texts: string[], inputType: InputType): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set (needed for grounding's vector path).");
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: batch, model: EMBED_MODEL, input_type: inputType }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage embeddings ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as VoyageResponse;
    const rows = json.data;
    if (!rows || rows.length !== batch.length) {
      throw new Error(`Voyage returned ${rows?.length ?? 0} embeddings for ${batch.length} inputs.`);
    }
    // Order is not guaranteed by the API, so re-sort by `index` before mapping back to inputs.
    for (const row of [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
      const v = row.embedding;
      if (!Array.isArray(v) || v.length === 0) {
        throw new Error("Voyage returned an empty embedding vector.");
      }
      out.push(v);
    }
  }
  return out;
}
