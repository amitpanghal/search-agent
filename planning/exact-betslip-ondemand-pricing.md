# Exact betslip — price the user's own legs via `onDemandPricing` (Bet-builder Phase 2)

## Decision

Alongside the related prepack combos (`combinations`, Phase 1), surface the user's **own** resolved legs as one
**priced betslip**. Same-event legs are priced by the feed's `onDemandPricing` endpoint (their combined odds is
**not** the product — correlated pricing); cross-event legs multiply. Legs that can't combine are dropped from the
betslip but still shown as results. The betslip is a **separate top-level envelope field**, actionable (carries
outcome ids), and rendered inline with the results by the frontend — not in the related-combos list.

> Scope is deliberately narrow (v1). Multi-betslip rescue of mutually-exclusive legs, dropped-leg notes,
> `combinableOutcomeIds` ("suggest a leg"), and betslip↔coupon dedup are **explicitly deferred** (see Deferred).

## API contract (probed live 2026-07-10, event 1028276829)

`GET {BASE}/onDemandPricing/event/{eventId}/outcome/{id1}%2C{id2}...?lang=…&market=GB`

- **Combinable** → `200`:
  ```json
  { "eventId": 1028276829, "selectedOutcomeIds": [.., ..],
    "selectedOdds": { "decimal": 41000, ... }, "combinableOutcomeIds": [ ...many... ] }
  ```
  `selectedOdds.decimal` is RAW millis (`41000` = 41.00) — same convention as the rest of the code.
- **Not combinable** (e.g. Full Time `1` + Full Time `X`) → `400`
  `{"error":{"message":"Combination is not supported by the selected strategy."}}`.
- **Proof the API is required for same-event:** the two probed legs priced at **41.00**, but `4.10 × 4.80 = 19.68`.
  Same-event odds ≠ product → we cannot fake it by multiplying.

Combinability signal is simply **HTTP 200 vs non-200**.

## Algorithm (v1)

Pure builder in `combinations.ts`, invoked from the orchestrator right where `pickCombinations` runs:

1. Take selected outcomes from **fixture-level legs only** (`leg.level === "fixture"`). Competition/outright picks
   are excluded — they have no match event to price against and don't combine. They still appear as results.
2. Group the remaining selected outcomes by `eventId`.
3. **Same-event group (≥2 picks)** → `priceCombo(eventId, outcomeIds, lang)`:
   - `200` → group contributes `selectedOdds.decimal`; its legs are in.
   - non-`200` (400 **or** transient) → drop that group's legs from the betslip (no subset probing).
4. **Single-pick event** → contributes that outcome's own odds.
5. **Betslip odds = product** of all survivors (same-game API odds × single-leg odds). Cross-event = multiply.
6. **< 2 legs survive → no betslip** (omit the field).
7. **No dropped-leg notes** — the per-leg `outcomeId` lets the frontend show what's in vs out.

All `priceCombo` calls are fired with `Promise.all` (one round-trip, not N). The betslip lands in the final
`done` envelope — **no streaming** (the generator makes streaming a cheap, low-regret change later if measured
latency warrants it).

## Types

- New envelope field `betslip?: Combination` — a **single object**, separate from `combinations[]`.
- Reuse `Combination`: `tag: "EXACT"`, `id` made **optional** and omitted (no coupon id).
- `CombinationLeg` gains `outcomeId?: number`; every betslip leg is `matched: true`.

## Files & changes

### `src/resolver/offering-client.ts`
Add the pricing GET (reuses `qs(lang)`, which already emits `lang=…&market=GB`, [offering-client.ts:15](../src/resolver/offering-client.ts:15)):
```ts
// combined price in RAW millis on 200; null on any non-200 (400 = not combinable, or a transient error)
export async function onDemandPricing(eventId: number, outcomeIds: number[], lang = DEFAULT_LOCALE): Promise<number | null>
```
Use a status-tolerant fetch (do **not** throw on 400) — the generic `getJson` throws on non-2xx, so this needs its
own `fetch` + `res.ok` check returning `null` otherwise, reading `selectedOdds.decimal` on success.

### `src/resolver/combinations.ts`
- Extend `CombinationLeg` with `outcomeId?: number`; make `Combination.id` optional.
- Add the pure builder, e.g.
  `buildBetslip(legsOut, offers, events, priceCombo, lang): Promise<Combination | undefined>` — implements the
  Algorithm above. Groups by event, awaits `Promise.all` of `priceCombo` per same-event group, multiplies
  survivors, applies the <2-leg floor. Reuses `priceOf`-style RAW-millis math.

### `src/resolver/live-menu-types.ts`
- Add `priceCombo` to the injectable boundary type (mirrors how `recall` is injected).
- Add `betslip?: Combination` to `ExecuteInput` so `execute` can spread it (like `combinations`).

### `src/resolver/resolve.ts`
- `PipelineDeps` ([:107](../src/resolver/resolve.ts:107)) + `REAL_DEPS` ([:113](../src/resolver/resolve.ts:113)) gain
  `priceCombo: onDemandPricing`.
- Right after `pickCombinations` ([:283](../src/resolver/resolve.ts:283)) — where `resolvedOutcomeIds`/`execOffers`/
  `execEvents` already exist — `await deps.priceCombo`-backed `buildBetslip(...)`, then pass the result into
  `execute` via `ExecuteInput.betslip`.
- Gather a leg's selected ids via `selection.selectedIds ?? (outcomeId != null ? [outcomeId] : [])`; leg order =
  query order.

### `src/resolver/execute.ts`
- Add `betslip?: Combination` to `ResponseEnvelope` ([:74](../src/resolver/execute.ts:74)).
- Spread it into the returned envelope when present ([:292](../src/resolver/execute.ts:292), beside `combinations`).
  `execute` stays thin — it does **not** fetch or price; it only forwards the object the orchestrator built.

### harness-loop rig (see the `harness-loop` skill)
Inject a **cached `priceCombo` double** keyed by `(eventId, sorted outcomeIds)` so the rig stays offline (no
network, no LLM). Capture the responses once for the batch queries that produce a betslip.

## Evidence

- **Live probe (above):** 200/400 combinability signal; `selectedOdds.decimal` RAW millis; same-event 41.00 vs
  product 19.68 → API required for same-event, multiply valid cross-event.
- **Fetch shape already in the client:** `qs()` sends `market=GB`; `BASE` is the same host as the endpoint
  ([offering-client.ts:7](../src/resolver/offering-client.ts:7), [:15](../src/resolver/offering-client.ts:15)).
- **Same insertion point as Phase 1:** `pickCombinations` already runs in the orchestrator off the resolved picks
  ([resolve.ts:283](../src/resolver/resolve.ts:283)); the betslip needs the identical inputs.

## Deferred (not in v1)

- **Multi-betslip** rescue of mutually-exclusive legs (Cartesian over per-event alternatives) — rare,
  contradictory query shape; add capped ("≤2 betslips, one conflicting 2-leg event") only if real queries hit it.
- **Subset probing** inside a failing same-event group — drop the whole group instead.
- **Dropped-leg notes** — rely on `outcomeId` linkage; add later only if users are confused.
- **`combinableOutcomeIds`** ("suggest a leg to add") — different feature.
- **Betslip↔related-coupon dedup** — accept an exact betslip that coincides with a related coupon.

## Risks

- **Transient error looks like "not combinable."** A non-200 that's a feed hiccup drops the group just like a
  400. User-visible outcome (legs shown separately) is the same and truthful, but we're not *certain* it was
  non-combinable. Accepted for v1 to keep `priceCombo: odds | null`.
- **Latency.** One extra feed round-trip (parallelized). Only same-event ≥2-pick groups call out; cross-event
  accas cost nothing. If measured latency hurts, add the intermediate `results` yield (streaming) — cheap because
  the orchestrator is already a generator.

## Verification

1. `npm run typecheck`.
2. **Live end-to-end** (LLM + feed) on a same-game combo — e.g. "Norway to win, Harry Kane to score and total
   goals over 2.5": assert `betslip` present, 3 legs on the one event, odds = API `selectedOdds.decimal` (not the
   product), each leg carries `outcomeId`.
3. **Cross-event acca** — assert odds = product of the single-leg odds, no `priceCombo` call needed.
4. **Not-combinable** — a query with two mutually-exclusive same-event legs: assert those legs drop from the
   betslip (still in results) and, if <2 remain, no `betslip` field.
5. **Competition-level** — an outright leg is excluded from the betslip.
6. **Harness-loop batch** (offline) once the cached `priceCombo` double is wired — no regressions elsewhere.
