// The runPipeline dependency-doubles: REAL deterministic logic, the three LLM steps served from the content cache
// (subagent-fulfilled), and recall fetching the LIVE feed FRESH on every run (never cached). Fed to
// `runPipeline(query, HARNESS_DEPS)` so the rig exercises the genuine pipeline (groundScope, recall, scopeMenu,
// filterBySubject, resolveMarkets, select, execute) end-to-end with ZERO LLM API — only the LLM boundaries are
// swapped for cached subagent output.

import { QueryPlan } from "../resolver/schema";
import { normalizePlan } from "../resolver/normalize-plan";
import { resolveEntities, type Cell, type Decision } from "../resolver/resolve-entities";
import { resolveMarkets, type RawPick } from "../resolver/resolve-market";
import { recall as realRecall, type RecallInput, type RecallResult } from "../resolver/recall";
import type { ResolvedScope } from "../resolver/ground-scope";
import type { Menu } from "../resolver/live-menu-types";
import { lookup } from "./llm-cache";

// EXTRACT double: the cached plan, run through the REAL normalize + zod validation (so a captured plan is held to
// exactly the contract `extract()` enforces). Keyed by the raw query.
const extractDouble = async (query: string): Promise<QueryPlan> => {
  const raw = lookup<unknown>("extract", { query });
  normalizePlan(raw);
  return QueryPlan.parse(raw);
};

// ENTITIES double: the REAL resolveEntities orchestrator, its ONE LLM call (`decide`) served from cache. The cell
// key drops the non-serialisable `reground`/`entity` and keeps what the model actually reads (ref/text/tier/candidates).
const cachedDecide = async (query: string, cells: Cell[], pass: 1 | 2): Promise<Decision[]> => {
  const seen = cells.map((c) => ({ ref: c.ref, text: c.text, tier: c.tier, candidates: c.candidates }));
  return lookup<Decision[]>("entities", { query, cells: seen, pass });
};
const entitiesDouble = (query: string, scope: ResolvedScope) => resolveEntities(query, scope, cachedDecide);

// MARKETS double: the REAL resolveMarkets, its batched decider served from cache (keyed by the phrases + the menu
// labels they were picked against — so editing FILTER changes the menu and correctly forces a re-capture).
const cachedPick = async (phrases: string[], menu: Menu): Promise<RawPick[]> => lookup<RawPick[]>("markets", { phrases, menu });
const marketsDouble = (phrases: string[], menu: Menu) => resolveMarkets(phrases, menu, cachedPick);

// RECALL double: a FRESH live fetch every run — the rig never caches the feed, so each test sees current data.
// Only the three LLM steps above are cached; the API response is not. Network is in-process, so this fetches INLINE
// (no subagent / pending dance, unlike the LLM steps).
const recallDouble = (input: RecallInput): Promise<RecallResult> => realRecall(input);

// The dependency set handed to runPipeline(query, HARNESS_DEPS). Shapes match the real exports, so it slots into
// the one DI seam with no behaviour change to production (default deps stay the real functions).
export const HARNESS_DEPS = {
  extract: extractDouble,
  recall: recallDouble,
  resolveEntities: entitiesDouble,
  resolveMarkets: marketsDouble,
};
