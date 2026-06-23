# Live-menu build plan — phased (option B: land the cut together)

> **Date:** 2026-06-22
> **Theory:** [live-menu-resolution-theory.md](live-menu-resolution-theory.md) · **Trim sub-plan:** [entity-disambiguator-trim-plan.md](entity-disambiguator-trim-plan.md)
> **Status:** design proposal, not started.
> **One line:** build the whole new post-fetch half in-tree first (each module proven by the existing
> probes), then remove the old market half and rewire in **one clean cut**. No shim, no back-compat — the
> app is incomplete and unused, so we delete rather than deprecate.

---

## 1. Why option (B), and why it is safe here

We chose **(B) — land the cut together with the new resolve** over (A) the remove-first-with-a-shim path.
(B) leaves no throwaway shim and no half-working middle state in the repo. Its only real downside — one big,
hard-to-debug change — is removed by sequencing: we **build the new half first** (Phases 0–5) and prove each
module against the probes that already validated this design, *then* do the removal + rewire as one change
(Phase 6). By the time the cut lands, everything it switches to is already built *and* covered end-to-end by
an offline gate (Phase 5).

Free hand (no users, incomplete app): we **delete** old code, **rename** files for clarity, and carry **no
back-compat**.

## 2. Target pipeline

```
extract → groundScope → resolveEntities → recall(live menu) → filter → resolve(market: exact|close|none) → select(line/subject) → execute
```

Two facts from the current code shape the work:

- **RECALL plumbing already exists** — `offering-client.ts` exposes `betOffersByGroup` / `betOffersByEvents` /
  `betOffersByParticipants`, and both probes call them. RECALL is assembly, not new infra.
- **The eval gate grades the *old* market path** — `run.ts`, `scope-scorer.ts`, `disambig-replay.ts`,
  `structural-scorer.ts` assert pre-fetch `marketIds` / `criterion`. The cut breaks these, so re-homing them
  is part of the work — the post-fetch market gate is built *before* the cut (Phase 5), the entity-resolution
  gate re-homed *after* it (Phase 7) — not an afterthought.

## 3. What this deletes (at the cut — Phase 6)

| Removed | Replaced by |
|---|---|
| market half of `disambiguate.ts` — `applyCorrection` (line/subject rewriter), market cells, combos, relevel, `sideTwins`, `marketIds` | `resolveEntities` (entity-only) + post-fetch resolve/select |
| `ground-market.ts` (703 lines) — pre-fetch market grounding | `recall.ts` + `resolve-market.ts` against the live menu |
| `combos.ts`, `related-markets.ts` | combos/suggestions resolve from the live menu |
| market / line / subject rules in `disambiguator-prompt.md` | entity-only prompt + new `resolve-market` prompt |
| `marketIds` / `criterion` pre-commit in `plan-fetch.ts` | "endpoint + ids" only; market decided post-fetch |

## 4. Phases

### Phase 0 — Lock the new types (keystone)
Define the shared shapes end-to-end **before** building any module, so the cut never fights type drift.
- `SettledEntities` (replaces `SettledScope`; drops `marketIds` / `combos`).
- `Menu` — the live list as `(criterion + variant)` labels, ids only.
- `MarketPick { criterionId, variant, label: "exact" | "close" | "none" }`.
- `Selection { line?, subject?, outcomeId?, fallback? }`.
- New executor input (today it takes a `FetchPlan` with committed `marketIds` — that field goes away).

### Phase 1 — RECALL in-tree
Thin `recall.ts`: confident entity ids + coarse grain → the right `offering-client` call → the live menu.
Union in one call where the endpoint allows. No deletions. Tested standalone.

### Phase 2 — FILTER + RESOLVE(market) in-tree
**Coverage audit gates this phase.** Before relying on the filter, confirm across *all* market types where the
subject's name lives — structured `participant` field vs free-text market label (`Total Goals by USA`) vs
home/away. The filter is the one step with **no LLM and no fallback**, so its "can't drop the right answer"
claim has to be *earned here*, not assumed: a wrong lookup silently drops the right market before the model
ever sees it.
Port `scripts/.contract-probe.ts` into real modules:
- deterministic subject/coverage filter (drop markets that don't price the subject) — `filter.ts`.
- LLM resolve → `(criterion + variant)` + `exact | close | none` — `resolve-market.ts` + prompt.
Behavior already proven by the probe (confident-wrong ≈ 1 in 180).

### Phase 3 — SELECT in-tree
Port `scripts/.select-probe.ts`: deterministic line + subject lookup against the picked market's real
outcomes; nearest-line and not-offered fallbacks. `select.ts`. **Zero LLM.**

### Phase 4 — EXECUTE path in-tree
The executor today is built around committed `marketIds` *and* does the fetch — but RECALL (Phase 1) now owns
the fetch, so the remaining execute work is thin: consume a `Selection` (picked market + outcome/line/subject)
and assemble the final result. Build that Selection-consuming execute as a **new path in-tree, wired to
nothing**, tested standalone. This is a structural split of `executor.ts` (682 lines, today marketId-shaped),
not a field swap — sizing it as its own phase keeps the reshape out of the cut.

### Phase 5 — Post-fetch market gate (before the cut)
Build the post-fetch gate **now, before the cut**, so the cut is validated *as it lands* rather than after:
resolve-label correctness + select correctness, run against a **captured** live menu so it is deterministic
and offline. The Phase 1–4 module tests fold in here. This is the end-to-end safety net that spans the cut.
*(The entity-resolution gate can only re-home after `resolveEntities` exists, so it stays post-cut — Phase 7.)*

> *— end of Phase 5: the whole new half exists, is wired to nothing, **and** has an offline end-to-end gate
> proving it. This is what makes (B) safe — the cut switches to something already built *and* covered. —*

### Phase 6 — THE CUT (one change)
- Trim `disambiguate.ts` → `resolveEntities` (entity-only) per the trim sub-plan; rename the file.
- Delete `ground-market.ts`, `combos.ts`, `related-markets.ts` (salvage any filter helpers into Phase 2).
- Slim `plan-fetch.ts` → "endpoint + ids" only.
- Rewire the orchestrator to the target pipeline; switch execution to the Phase 4 `Selection` path and delete
  the old `marketId`-fed executor branch.
- Trim `disambiguator-prompt.md` to entity rules only.

### Phase 7 — Re-home the entity-resolution gate
Keep the scope replay (`disambig-replay.ts` → entity-only); fixtures that asserted `marketIds` already moved to
the post-fetch market gate (Phase 5).

### Phase 8 — Guards & hardening (theory §10)
- Inverse-direction guard on any `close` pick (the Japan `none ↔ close` wobble).
- Payload measurement at match grain (confirm labels-only + filter is small enough; prune only if numbers say).
- *(Filter coverage audit moved up to gate Phase 2.)*

### Phase 9 — Cleanup & freshness
- Delete the scratch probes once their logic lives in `src`.
- Keep `scope-index.json` fresh against the live feed so the candidate set doesn't drift.

## 5. Risk shape

The only "big" change is **the cut (Phase 6)**, and Phases 0–5 shrink it to mostly deletion + wiring: every
piece it switches to is already built (Phases 0–4) *and* covered end-to-end by an offline gate (Phase 5)
before the cut lands. Removal is concentrated in one place (Phase 6), not spread across the build, so there is
never a half-working market path.

## 6. Out of scope (separate axes — theory §11)

Deep entity-resolution edge cases beyond the §3 gate · time-window / "which fixture" · bracket / half-of-draw
· multi-subject fetch routing.
