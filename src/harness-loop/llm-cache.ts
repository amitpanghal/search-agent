// Content-addressed LLM cache + pending-miss ledger — the only thing in the rig that ever needs a subagent.
//
// Each LLM step is keyed by hash(kind + its exact input). A HIT returns the captured output (free, deterministic).
// A MISS records the request to an in-memory ledger and THROWS CacheMiss: the run aborts that one query, the
// orchestrator (Claude Code) spawns a temp-0 Haiku subagent to produce the output, writes it via `putCached`,
// and re-runs — now a hit. While you fix deterministic code the inputs don't change, so every step stays a hit
// and the loop re-runs for free; only the layer you edited (and anything downstream whose input shifted) misses.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, "llm-cache");
const PENDING_FILE = join(HERE, "pending-llm.json");

export type LlmKind = "extract" | "entities" | "markets";

// A miss the tsx run couldn't answer: `kind` picks the prompt, `input` is everything the subagent needs to
// reproduce the real call's output, `key` is where to write the answer back.
export type PendingReq = { key: string; kind: LlmKind; input: unknown };

export class CacheMiss extends Error {
  constructor(public readonly req: PendingReq) {
    super(`LLM cache miss: ${req.kind} (${req.key})`);
    this.name = "CacheMiss";
  }
}

// Content key for any cached call — the LLM steps AND the recall data-cache (where `kind` is "recall").
export const cacheKeyFor = (kind: string, input: unknown): string =>
  `${kind}-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;

const readCache = (key: string): unknown => {
  const p = join(CACHE_DIR, `${key}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
};

// Raw cache read by key — the recall data-cache reads through this, then fetches LIVE inline on a miss (no
// subagent / pending dance, unlike the LLM steps below).
export const getCached = (key: string): unknown => readCache(key);

const pending = new Map<string, PendingReq>();

// Look up a cached LLM output by (kind, input). Hit -> the captured value; miss -> record + throw CacheMiss.
export function lookup<T>(kind: LlmKind, input: unknown): T {
  const key = cacheKeyFor(kind, input);
  const hit = readCache(key);
  if (hit !== undefined) return hit as T;
  const req: PendingReq = { key, kind, input };
  pending.set(key, req);
  throw new CacheMiss(req);
}

// Write a subagent's output into the cache under the miss's key (fulfilling a PendingReq).
export function putCached(key: string, value: unknown): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
}

// Persist the misses collected this run to pending-llm.json (the contract the orchestrator fulfils), and return
// them. Empty => every step was a cache hit (the run is complete / free).
export function flushPending(): PendingReq[] {
  const reqs = [...pending.values()];
  writeFileSync(PENDING_FILE, JSON.stringify(reqs, null, 2));
  return reqs;
}
