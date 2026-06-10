// Sprint 6 (decision 27) — Phase 1 step 2: generate per-criterion DOC-VIEWS.
//
// A doc-view is an extra terse phrasing of a market, embedded as an ADDITIONAL vector so grounding's weak
// cosine tail (golds at raw 0.32-0.47) can match a user query that shares no words with the official catalog
// name. CLUSTER-CONTRASTIVE generation (decision #6): Opus (`claude-opus-4-8`) sees a whole same-category
// cluster of sibling markets and writes views that DISTINGUISH each member from its siblings; a mechanical
// COLLISION FILTER then embeds every view and drops any a distinct-FAMILY sibling beats (by > ε) over its
// own market's name. Facet variants (period/side/settlement/line — same `familyKey`) are NOT made to compete
// in the filter (the grounder disambiguates those at query time). View ASSIGNMENT is finer (`viewKey`): only
// settlement/register twins SHARE authored views; home/away/period each get their OWN side-specific views.
//
// Anchoring rule (#5/#6): a view contributes only TEXT here -> later only its VECTOR (build-market-index,
// step 3); `statCore`/`specificityPenalty`/period/`lexicalCover` stay derived from the canonical name. Opus
// is blind to the eval set + failure list (clean-room, #3) — it only ever sees catalog names.
//
//   npx tsx scripts/gen-doc-views.ts [--dry-run] [--force] [--category <substr>] [--ids 1,2,3] [--limit-clusters N]
//
// LLM-free reruns (project rule): raw Opus output is cached per batch in doc-views-gen-cache.json, so only
// new/changed clusters call Opus. --dry-run builds the clusters + prints one sample prompt and calls NO API.
// Writes data/football/criterion-doc-views.json: { model, builtAt, count, views: { [id]: string[] } }.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadCatalog, type Criterion } from "../src/resolver/catalog";
import { statCore, periodCore } from "../src/resolver/ground-market";
import { normalize } from "../src/eval/structural-scorer";
import { embed } from "../src/resolver/embed";

const GEN_MODEL = "claude-opus-4-8";
const MAX_MEMBERS_PER_CALL = 24; // chunk large categories; the chunk is the contrast set for generation

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT = join(ROOT, "planning", "prompts", "genDocViewsPrompt.md");
const OUT = join(ROOT, "data", "football", "criterion-doc-views.json");
const CACHE = join(ROOT, "data", "football", "doc-views-gen-cache.json");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || process.env[m[1]]) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

// The system prompt lives in a committed md file (like extractor-prompt.md) so it is reviewable + versioned.
// We read only the fenced "## System prompt" block so the worked examples / notes around it stay docs.
function systemPrompt(): string {
  const md = readFileSync(PROMPT, "utf8");
  const m = md.match(/## System prompt\s*```([\s\S]*?)```/);
  if (!m || !m[1]) throw new Error("Could not find the fenced System prompt block in genDocViewsPrompt.md");
  return m[1].trim();
}

// ---- clustering: one cluster per (subject, primary category); members = distinct statCores ----
// A criterion joins exactly ONE cluster (its first category) so nothing is generated twice. Within a cluster,
// side/settlement twins collapse to a single member (shared statCore); twinIds carries them so they all
// receive the survivor views. The representative is the shortest name (the most canonical of the twins).
type Member = { id: number; name: string; core: string; fkey: string; twinIds: number[] };
type Cluster = { key: string; subject: string; category: string; members: Member[] };

// Sibling-grouping key for the collision filter: the market FAMILY, with facet parameters stripped — period
// (periodCore), line/window template tokens ({0}, time spans), settlement/dead-heat parentheticals, and
// alternate-line direction. Markets that differ ONLY by such a facet share a key and are treated as TWINS
// (kept sharing), not siblings — the grounder already disambiguates these facets at query time (periodCore
// collapse, line->boType gate), so they must not annihilate each other's views here. Distinct STAT types
// (total / most / first / handicap / race-to) keep different keys and are still distinguished by the filter.
// Dedup key for view ASSIGNMENT (finer than the filter's familyKey): fold ONLY settlement parentheticals and
// the player-name register ("Player's X" / "X by the player") — variants with identical meaning AND identical
// natural phrasing, so they safely share authored views. It KEEPS home/away (and period/line): "Home Team To
// Score" and "Away Team To Score" are DIFFERENT markets needing DIFFERENT side-specific views — folding them
// (as statCore does) copies home's "home side nets" onto the away market. (Revises decision #6's "side-split
// keeps sharing": that holds only for side-neutral views, but inherently-side-specific markets can't be.)
function viewKey(name: string): string {
  return normalize(name.replace(/\(settled[^)]*\)/gi, ""))
    .replace(/^player(\ss)?\s/, "")
    .replace(/\sby(\sthe)?\splayer$/, "")
    .trim();
}

function familyKey(name: string): string {
  return periodCore(name)
    .replace(/\([^)]*\)/g, " ") // settlement / dead-heat parentheticals: (Draw: No Corner), ({0})
    .replace(/\{[^}]*\}/g, " ") // line/window template tokens: {0} {1}
    .replace(/\b\d+\s*:\s*\d+\b/g, " ") // bare time-window tokens: 0:00, 9:59
    .replace(/\b(high|low)\s+alternate\s+line\b/g, " ")
    .replace(/\balternate\s+line\b|\binterval\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ") // separators / punctuation (also clears periodCore's dangling '-')
    .replace(/\s+/g, " ")
    .trim();
}

export function buildClusters(list: Criterion[]): Cluster[] {
  const groups = new Map<string, Criterion[]>();
  for (const c of list) {
    const category = c.categoryNames[0] ?? "(uncategorized)";
    const key = `${c.subject} :: ${category}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  const clusters: Cluster[] = [];
  for (const [key, members] of groups) {
    const byView = new Map<string, Criterion[]>();
    for (const c of members) {
      const vk = viewKey(c.name);
      (byView.get(vk) ?? byView.set(vk, []).get(vk)!).push(c);
    }
    const dedup: Member[] = [];
    for (const [, twins] of byView) {
      const rep = [...twins].sort((a, b) => a.name.length - b.name.length)[0]!;
      dedup.push({ id: rep.id, name: rep.name, core: statCore(rep.name), fkey: familyKey(rep.name), twinIds: twins.map((t) => t.id) });
    }
    const first = members[0]!;
    clusters.push({ key, subject: first.subject, category: first.categoryNames[0] ?? "(uncategorized)", members: dedup });
  }
  return clusters.sort((a, b) => b.members.length - a.members.length);
}

const chunk = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---- Opus call (mirrors extract.ts: forced tool use, validated output; no temperature/thinking on Opus 4.8) ----
const ViewsOut = z.object({
  views: z.array(z.object({ ref: z.number().int(), paraphrases: z.array(z.string()) })),
});
const INPUT_SCHEMA: Anthropic.Tool.InputSchema = (() => {
  const s = z.toJSONSchema(ViewsOut) as Record<string, unknown>;
  delete s.$schema;
  return s as Anthropic.Tool.InputSchema;
})();

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (export it or put it in .env).");
    client = new Anthropic();
  }
  return client;
}

function userMessage(subject: string, category: string, members: Member[]): string {
  const rows = members.map((m, ref) => `  { "ref": ${ref}, "name": ${JSON.stringify(m.name)} }`).join(",\n");
  return (
    `Category: ${category}   (subject: ${subject})\n` +
    `Markets in this cluster — write distinguishing views for EACH, keeping them distinct from the others:\n\n` +
    `[\n${rows}\n]`
  );
}

// Returns id -> raw (pre-filter) views for one chunk of members.
async function genBatch(sys: string, subject: string, category: string, members: Member[]): Promise<Record<number, string[]>> {
  const msg = await anthropic().messages.create({
    model: GEN_MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "emit_doc_views", description: "Emit the doc-views for each market in the cluster.", input_schema: INPUT_SCHEMA }],
    tool_choice: { type: "tool", name: "emit_doc_views" },
    messages: [{ role: "user", content: userMessage(subject, category, members) }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Generator returned no tool_use block.");
  const parsed = ViewsOut.safeParse(block.input);
  if (!parsed.success) throw new Error(`Generator output failed validation: ${parsed.error.message}`);
  const out: Record<number, string[]> = {};
  for (const { ref, paraphrases } of parsed.data.views) {
    const m = members[ref];
    if (!m) continue; // ignore an out-of-range ref rather than crash
    const clean = [...new Set(paraphrases.map((p) => p.trim()).filter(Boolean))];
    out[m.id] = [...(out[m.id] ?? []), ...clean];
  }
  return out;
}

// ---- collision filter ----
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const norm = (a: number[]) => Math.sqrt(dot(a, a)) || 1;
const cosine = (a: number[], b: number[]) => dot(a, b) / (norm(a) * norm(b));

// Keep a view unless a DISTINCT-FAMILY sibling beats its own market's name by more than EPS_MARGIN. Same-
// family members (twins differing only by a facet — period/side/settlement/line) are excluded from the
// sibling set, so they keep sharing views; the grounder disambiguates those facets at query time. The
// ε-margin lets near-ties survive — safe in phase 1 (shortlist-capped, never confident; decision #5), and
// the strict separation test is deferred to phase 2 (#9). A survivor never points MORE than ε past a sibling.
const EPS_MARGIN = 0.02;
export function filterCluster(cluster: Cluster, raw: Record<number, string[]>, vec: Map<string, number[]>): Record<number, string[]> {
  const kept: Record<number, string[]> = {};
  for (const m of cluster.members) {
    const ownVec = vec.get(m.name);
    const views = raw[m.id];
    if (!ownVec || !views) continue;
    const siblings = cluster.members.filter((s) => s.fkey !== m.fkey).map((s) => vec.get(s.name)).filter((v): v is number[] => !!v);
    const survivors = views.filter((v) => {
      const vv = vec.get(v);
      if (!vv) return false;
      const own = cosine(vv, ownVec);
      return siblings.every((s) => own + EPS_MARGIN >= cosine(vv, s));
    });
    if (survivors.length) kept[m.id] = survivors;
  }
  return kept;
}

// ---- io ----
type Cache = Record<string, Record<number, string[]>>; // batchKey -> id -> raw views
type Output = { model: string; builtAt: string; count: number; views: Record<string, string[]> };

const readJson = <T,>(p: string, fallback: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const batchKey = (cluster: Cluster, members: Member[]) => `${cluster.key} # ${members.map((m) => m.id).sort((a, b) => a - b).join(",")}`;

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const dryRun = has("--dry-run");
  const emitPlan = has("--emit-plan");
  const force = has("--force");
  const catFilter = val("--category")?.toLowerCase();
  const idFilter = val("--ids")?.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  const limit = val("--limit-clusters") ? Number(val("--limit-clusters")) : undefined;

  const cat = loadCatalog();
  let clusters = buildClusters(cat.list);
  if (catFilter) clusters = clusters.filter((c) => c.category.toLowerCase().includes(catFilter));
  if (idFilter?.length) clusters = clusters.filter((c) => c.members.some((m) => m.twinIds.some((id) => idFilter.includes(id))));
  if (limit) clusters = clusters.slice(0, limit);

  const totalMembers = clusters.reduce((s, c) => s + c.members.length, 0);
  const totalIds = clusters.reduce((s, c) => s + c.members.reduce((t, m) => t + m.twinIds.length, 0), 0);
  const totalBatches = clusters.reduce((s, c) => s + Math.ceil(c.members.length / MAX_MEMBERS_PER_CALL), 0);
  console.log(`Clusters: ${clusters.length} | distinct members: ${totalMembers} | criterions covered (incl. twins): ${totalIds} | Opus batches: ${totalBatches}`);
  const sizes = clusters.map((c) => c.members.length);
  console.log(`Cluster sizes — max ${Math.max(...sizes, 0)}, median ${sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0}, singletons ${clusters.filter((c) => c.members.length === 1).length}`);

  // --emit-plan: write the batch plan (one entry per Opus batch, with the exact cache key the pipeline uses)
  // so cold blind subagents can author one batch each. After they write their outFiles, run
  // scripts/ingest-doc-view-batches.ts to prime the cache, then `gen:doc-views` runs filter-only (no Opus).
  if (emitPlan) {
    const dir = join(ROOT, ".docviews"); // repo-local: background subagents are sandboxed to the repo (can't write /tmp)
    mkdirSync(dir, { recursive: true });
    const plan: { i: number; key: string; subject: string; category: string; members: { ref: number; id: number; name: string }[]; outFile: string }[] = [];
    let i = 0;
    for (const cluster of clusters) {
      for (const members of chunk(cluster.members, MAX_MEMBERS_PER_CALL)) {
        plan.push({
          i, key: batchKey(cluster, members), subject: cluster.subject, category: cluster.category,
          members: members.map((m, ref) => ({ ref, id: m.id, name: m.name })),
          outFile: join(dir, `batch-${i}.json`),
        });
        i++;
      }
    }
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan, null, 1));
    console.log(`Wrote ${plan.length} batches → ${planPath} (one cold subagent per batch authors its outFile).`);
    return;
  }

  if (dryRun) {
    const sample = clusters.find((c) => c.members.length > 1) ?? clusters[0];
    if (sample) {
      console.log(`\n--- sample SYSTEM prompt ---\n${systemPrompt()}`);
      console.log(`\n--- sample USER message (cluster "${sample.key}") ---\n${userMessage(sample.subject, sample.category, sample.members.slice(0, MAX_MEMBERS_PER_CALL))}`);
    }
    console.log(`\n[dry-run] no API calls made.`);
    return;
  }

  const sys = systemPrompt();
  const cache = readJson<Cache>(CACHE, {});
  const output = readJson<Output>(OUT, { model: GEN_MODEL, builtAt: "", count: 0, views: {} });
  let cacheDirty = false;

  for (const [ci, cluster] of clusters.entries()) {
    const allIds = cluster.members.flatMap((m) => m.twinIds);
    if (!force && allIds.every((id) => output.views[String(id)])) continue; // already done

    // 1. raw views per member (Opus, cached per batch).
    const raw: Record<number, string[]> = {};
    for (const members of chunk(cluster.members, MAX_MEMBERS_PER_CALL)) {
      const key = batchKey(cluster, members);
      let batch = !force ? cache[key] : undefined;
      if (!batch) {
        process.stdout.write(`[${ci + 1}/${clusters.length}] ${cluster.key} (${members.length}) ... `);
        batch = await genBatch(sys, cluster.subject, cluster.category, members);
        cache[key] = batch;
        cacheDirty = true;
        writeFileSync(CACHE, JSON.stringify(cache, null, 1)); // resumable mid-run
        console.log(`${Object.values(batch).reduce((s, v) => s + v.length, 0)} raw views`);
      }
      Object.assign(raw, batch);
    }

    // 2. embed names + views (one batch per cluster), then collision-filter.
    const texts = [...new Set([...cluster.members.map((m) => m.name), ...Object.values(raw).flat()])];
    const vecs = await embed(texts, "document");
    const vec = new Map(texts.map((t, i) => [t, vecs[i]!]));
    const kept = filterCluster(cluster, raw, vec);

    // 3. write survivors to every twin id (anchoring: text only).
    let nViews = 0;
    for (const m of cluster.members) {
      const survivors = kept[m.id] ?? [];
      nViews += survivors.length;
      for (const id of m.twinIds) output.views[String(id)] = survivors;
    }
    const generated = Object.values(raw).reduce((s, v) => s + v.length, 0);
    console.log(`  -> ${cluster.key}: ${nViews}/${generated} views survived the collision filter across ${cluster.members.length} members`);
    output.builtAt = new Date().toISOString();
    output.count = Object.keys(output.views).length;
    writeFileSync(OUT, JSON.stringify(output, null, 1));
  }

  if (!cacheDirty) console.log("(no new Opus calls — all batches served from cache)");
  console.log(`Wrote ${OUT} — ${output.count} criterions carry doc-views.`);
}

// Run main() only when executed directly (not when imported, e.g. by the pilot filter harness).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
