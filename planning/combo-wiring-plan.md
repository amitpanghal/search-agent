# Plan — wire combined markets ("combos") through disambiguate → planFetch (additive, deterministic)

## Context

Today the grounder can assemble a ready-made **combined market** (e.g. "Home Team to Win and Both Teams
To Score") from a query's leg concepts — `assembleCombos()` in
[`ground-market.ts`](../src/resolver/ground-market.ts). But the disambiguator path calls `groundScopeMarkets()`
(per-selector `groundMarket` only) and never touches combos, so they're dropped: the executor only ever sees
the separate legs. The "combined" half of a query like *"BTTS **and** over 2.5 in the next game"* is lost.

We want combos carried end-to-end, **additively** — surface the combined market **alongside** the separate
legs and let the bettor choose; do **not** suppress legs. The layer stays **deterministic** (no LLM):

- Combos are assembled by token-cover over leg **concept text** and are **always grounded confident/variants**
  (a hard ≥0.8 cover gate; never ambiguous/shortlist), so they would never be sent to the disambiguator
  anyway. They just need a pass-through channel.
- The only LLM-recoverable miss is an *eligible* combo that falls below the cover floor (a tiny surface — only
  ~6 combos are ever offered; the other ~288 catalog combo rows are filtered out by `offer-registry.json` and
  are correctly unreachable). **LLM-assisted combo recall is explicitly deferred** until the offered set grows
  (more sports/leagues).

Outcome: `SettledScope` gains a `combos` sidecar; `planFetch` emits it; the executor fetches the legs **and**
the combined market, with a `covers` hint so the UI can group them.

## Approach

### A. `ground-market.ts` — combo assembly returns which legs it covers
Refactor `assembleCombos(legConcepts)` to return a richer result that also reports the **covered leg indices**.
Make it **strictly additive** — extend `GroundResult`, do **not** invent a narrower shape that drops `method`:
```ts
export type AssembledCombo = GroundResult & { covers: number[] };
// covers = indices of legs whose contentTokens intersect the matched combo's core token set
```
- **Keep `method: "combo"`.** An earlier draft proposed `{ ids; tier; covers }` (dropping `method`) and updating
  "the two consumers". That breaks `npx tsc --noEmit`: there are ~6 `groundPlan().combos` consumers, and
  [`scripts/dual-probe.ts`](../scripts/dual-probe.ts) (`+COMBO ${c.method}/${c.tier}`) reads `.method`.
  `GroundResult & { covers }` keeps `method`/`tier`/`ids`, so **every** existing consumer stays compatible with
  zero edits — `run.ts` (ignores `combos`), [`scripts/combo-probe.ts`](../scripts/combo-probe.ts) (reads `.ids`),
  `dual-probe.ts` (`.method`/`.tier`), `wc36-recheck.ts` (`.tier`/`.ids`), and the scratch stage-probes. Only the
  `GroundedPlan.combos` **type** widens (`GroundResult[]` → `AssembledCombo[]`); `comboCovers()` is untouched.
- Reuse the existing `comboIndex()` (each `ComboEntry` already holds `core: Set<string>`), `comboPool()` /
  `lex().idfCover()` for the ≥`LEX_COVER_FLOOR` gate (unchanged), and `contentTokens()` (from `lexical.ts`)
  per leg to compute `covers`.
- **`covers` honors the same NEGATION filter as `comboPool`** (ground-market.ts `comboPool`): a leg whose concept
  starts with no/not/without is excluded from the cover pool, so it must also be excluded from `covers`. Otherwise
  a negated leg gets falsely marked covered and the coherence gate (B) waits on a leg the combo doesn't represent
  — e.g. `contentTokens("no draw")` = `{no, draw}` would "cover" a `draw`-bearing core. Compute `covers` over the
  **non-negated** legs only.
- `covers` is a **token-intersection heuristic**, not an exact mapping (any shared content token marks a leg
  covered — a leg sharing only "team" would count). Fine for the ~6 offered combos; don't over-state it as precise.

### B. `disambiguate.ts` — attach combos to `SettledScope` (post-settlement, coherence-gated)
- Extend the type:
  ```ts
  export type SettledScope = ResolvedScope & {
    marketIds: (number[] | null)[];
    clarifications: { ref: CellRef; question: string; suggest?: number[] }[];
    combos: { ids: number[]; covers: number[] }[];   // NEW — additive combined markets
  };
  ```
- **Assign `settled.combos` explicitly, like `marketIds`/`clarifications`.** The only `SettledScope` producer is
  `structuredClone(scope) as SettledScope` (disambiguate.ts:348). The `as` cast means tsc will **not** flag a
  missing `combos` field — it would just be `undefined` at runtime and `planFetch`'s read (C) would throw. So set
  `settled.combos = []` right after the clone (alongside the `marketIds`/`clarifications` seeds), then overwrite.
- Compute combos **unconditionally at the end of `disambiguate()`** — *outside* the `if (cells.length)` guard, not
  "inside the `applyOutcomes` flow". The V1 fixture (D) is two **confident** legs → `buildCells` sends nothing →
  `cells.length === 0` → `runPasses`/`applyOutcomes` never run. `marketIds` is already seeded at the top of
  `disambiguate` (disambiguate.ts:351) regardless of cells, so the combo step reads settled status fine — but if
  it lived in the cells branch the V1 fixture would get **no combo**. Place it after the `if (cells.length)` block.
- Compute combos from the unit's **original leg concepts** (`scope.units[0].selectors.map(s => s.market_concept)`)
  via the new `assembleCombos`, then apply a **coherence gate**: keep a combo only if **every covered leg settled**
  (i.e. `settled.marketIds[idx] != null` for each `idx` in `covers`). Drop combos that span a leg which ended in
  `clarify`/unresolved. Assign `settled.combos = kept.map(c => ({ ids: c.ids, covers: c.covers }))`.
- **No** `decide`/`runPasses`/prompt changes — combos never go through the LLM. Single-unit this sprint
  (mirrors `marketIds`); multi-unit deferred.
- *(Re-express-aware concepts — assembling on a leg's re-expressed phrase instead of the original — is a small
  optional enhancement; original concepts already carry the combo tokens for the ~6 offered combos, so V1 uses
  originals and skips the `runPasses` plumbing.)*

### C. `plan-fetch.ts` — emit combos
- Add to `FetchPlan`: `combos?: { ids: number[]; covers: number[] }[]`.
- In `planFetch(scope)`, read `scope.combos ?? []` (the `?? []` guards a `SettledScope` built by some future path
  that skipped the B assignment — cheap insurance given the `as`-cast caveat in B) and attach to the (single)
  unit's plan. Leave `postFilters.criterion` (the per-leg markets) unchanged — combos are a **separate** field so
  the executor keeps legs and the combined market distinct and can group via `covers`.

### D. Fixtures + deterministic replay
- Extend `DisambigFixture.gold` with `combos?: { ids: number[]; covers: number[] }[]`.
- Add one combo fixture to [`disambig-fixtures.ts`](../src/eval/disambig-fixtures.ts) using a **real eligible
  combo** — two event legs whose concepts assemble a combined market. **Prefer `["home win","both teams to
  score"]` → "Home Team to Win and Both Teams To Score"** over `["draw","both teams to score"]`: `"both teams to
  score"` is a catalog name (grounds confident), but `"draw"` may land ambiguous/shortlist against Match Odds.
- **Verify both legs ground `confident` — not just the combo cover.** The zero-Haiku claim rests on both legs being
  confident → `buildCells` sends nothing → `decide` is never called. `combo-probe.ts` only checks token **cover**;
  it says nothing about per-leg **tier**. So during implementation run `groundScopeMarkets` (or `dual-probe.ts`) on
  the candidate plan and confirm **both** tiers are `confident`/`variants` before locking the fixture — if either
  leg is ambiguous/shortlist, a cell *is* sent, the fixture needs real `pass1` decisions, and the additive/no-Haiku
  story breaks. Use `combo-probe.ts` only to confirm the exact combo **id** + cover.
- Both legs confident → no `decide` call → the fixture exercises the **additive combo attach + covers + coherence
  gate + planFetch.combos** with zero Haiku.
- In [`disambig-replay.ts`](../src/eval/disambig-replay.ts), also assert `settled.combos` and
  `planFetch(...).combos` match the fixture's gold combos.

### E. `probe-pipeline.ts` — show the new channel
- In [`scripts/probe-pipeline.ts`](../scripts/probe-pipeline.ts), print stage-3 `settled.combos` and stage-4
  `plan.combos` (with catalog names + `covers`), so a live run shows the combined market surfaced alongside the
  legs.

### F. Docs
- Update the "Explicitly deferred" combo note in [`disambiguator-plan.md`](./disambiguator-plan.md): combos are
  now wired additively (deterministic, pass-through); LLM-assisted combo recall remains deferred.

## Critical files
- `src/resolver/ground-market.ts` — `assembleCombos` returns `covers` (reuse `comboIndex`, `contentTokens`).
- `src/resolver/disambiguate.ts` — `SettledScope.combos`; assemble + coherence-gate post-settlement.
- `src/resolver/plan-fetch.ts` — `FetchPlan.combos`; emit from `scope.combos`.
- `src/eval/disambig-fixtures.ts` + `src/eval/disambig-replay.ts` — combo fixture + replay assertion.
- `scripts/probe-pipeline.ts` — print combos. `scripts/combo-probe.ts` — confirm fixture combo (read-only).

## Out of scope (deferred)
- **LLM-assisted combo recall** (recall-first combo shortlist → LLM pick/decline) — revisit when the offered
  combo set grows with more sports/leagues.
- Recovering the ~288 non-offered combo rows (a `offer-registry.json` / data problem; surfacing them = an
  unbettable result).
- Re-express-aware combo concepts; multi-unit combos (`units.length > 1`).

## Verification
1. `npx tsc --noEmit` — clean (note: the A type stays `GroundResult & { covers }`, so this also guards against the
   dropped-`method` regression that would break `dual-probe.ts`).
2. `npx tsx scripts/combo-probe.ts` — combo recall unchanged; use it to confirm the fixture's combo **id** + cover.
   For the **per-leg tier** (both must be confident), check `dual-probe.ts`/`groundScopeMarkets` separately (D) —
   `combo-probe.ts` does not report tier.
3. `npm run eval` — green, including the new combo fixture (replay asserts `settled.combos` +
   `planFetch.combos`; no Haiku in that path).
4. `npx tsx scripts/probe-pipeline.ts "home win and both teams to score in the next world cup game"` — live
   extract + grounding shows the combined market in stage-3 `combos` and stage-4 `plan.combos`, **alongside** the
   two separate legs (additive, legs not suppressed). (Avoid a `"draw and …"` phrasing here — `"draw"` may ground
   non-confident and pull in a real Haiku `decide` call, muddying the deterministic demo.)
