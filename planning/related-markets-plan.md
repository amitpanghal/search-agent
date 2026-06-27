# Plan: "Related markets" via LLM-tagging the resolve-market call

## Context

We want a "closest suggestions" panel (per the design mock) that, for each matched leg,
surfaces 2–3 **related markets** — other markets the same bettor would plausibly also want
(e.g. "Saudi Arabia to win to nil" → "win at least one half", "win & both teams to score").

Key findings that shape the approach (validated against the real live feed via the harness):

1. **The related markets are already in hand.** The resolve-market LLM call already receives
   the full subject/fixture-filtered menu and picks one item. The *unpicked* items on the same
   fixture ARE the related pool — no new fetch, no new index, no new pipeline stage.
2. **"Show the rest of the menu" does not work.** Real menus range 4 → 147 items and contain
   junk (`Woodwork to be Hit`, `Own goal`, `Red Card`) and cross-fixture noise. Selection needs
   a relevance judgement, which is why we put it on the LLM (user-confirmed choice).
3. **The render slot already exists.** `EnvelopeResult.additional: EnvelopeHighlighted[]`
   ([execute.ts:196](src/resolver/execute.ts:196)) is typed but always `[]` today — the natural
   home for related markets, same shape as `highlighted`, no new envelope field.
4. **The grader ignores `additional`** ([grader.ts:13](src/harness-loop/grader.ts:13) reads only
   `highlighted`), so related markets cannot pollute target scoring.

The extractor does NOT and cannot drive this — it has no ambiguity signal for clean single-market
queries (confirmed: all four probe queries extracted as confident single kinds, zero `soft`).
Related markets are a resolve-time concern, not an extraction-time one.

## Approach

Extend the one existing resolve-market LLM call to also return related refs; carry them through
the data model as labels; render them into `additional`. No new LLM call, fetch, or stage.

### 1. Prompt — `src/resolver/resolve-market-prompt.md` (SHOW DIFF + GET SIGN-OFF before editing)

Add one short section (kept sport-agnostic; relevance defined by intent, not topic) and amend the
closing line. Exact addition:

```
### related markets (optional)

For EACH bet, after your pick, also return `related` — up to 3 menu `ref`s for OTHER markets the
same bettor would plausibly also want, most directly related FIRST. They must be on the SAME
fixture as your pick, and must never include the picked ref itself. Judge relevance by the bet's
INTENT, not mere topic overlap: a "win to nil" bet relates to clean-sheet or win-and-both-teams-to-
score markets, not to a "red card" or "woodwork" market that merely shares the menu. Return `[]`
when nothing on the menu is closely related. Pick refs from the menu only — never invent one.
```

Closing line changes from `…the `match` label, and a one-line `reason`.` →
`…the `match` label, a one-line `reason`, and its `related` refs (`[]` if none).`

### 2. Tool schema + mapping — `src/resolver/resolve-market.ts`

- `INPUT_SCHEMA.properties.picks.items.properties`: add
  `related: { type: "array", items: { type: "integer" }, description: "up to 3 menu refs for closely-related markets on the same fixture, most direct first; [] if none" }`.
  Leave `required` unchanged (related is optional).
- `RawPick` type: add `related?: number[]`.
- `callModel`: include `related` when rebuilding `RawPick` from `byLeg` (it already copies `ref/match/reason/outcome`).
- `toPick`: map related refs → menu labels with deterministic guards (belt-and-suspenders, same
  anti-hallucination discipline as the existing `outcome` handling): only when `match !== "none"`;
  drop the picked `ref`; drop refs not in `menu`; keep only refs whose `menu[r].eventId` equals the
  picked item's `eventId` (enforces "same fixture"); dedupe; cap at 3. Result → `MarketPick.related: string[]`.

### 3. Types — `src/resolver/live-menu-types.ts`

- `MarketPick`: add `related?: string[]` (menu labels — the same identity key `highlighted` uses).
  `ResolvedLeg` already carries `pick`, so related rides along unchanged.

### 4. Rendering — `src/resolver/execute.ts`

- `EnvelopeResult.additional` already exists — populate it (no type change).
- In the leg loop, after the `founds`/`highlighted` placement succeeds, for each label in
  `leg.pick.related`: find its betoffer(s) in `data.betOffers` via `marketLabelOf` (already used in
  resolve.ts; export/import or inline the same label derivation), scoped to the SAME event the pick
  landed in, and push an `EnvelopeHighlighted` (betoffer + its outcomes, NO `selected` flag) into
  that event block's `additional`. Dedupe by betOffer id and skip any betoffer already in
  `highlighted`. Reuse `toBetOffer` / `toOutcome`.
- Note: related offers are present in execute's `data` — `execOffers` is built from `scoped.offers`
  (resolve.ts:256), a superset of the filtered menu the related refs came from.

### 5. resolve.ts — no logic change

`pickByIdx[i]` already carries the full `MarketPick` (now incl. `related`) into `legsOut`. "main"
sentinel legs synthesize their own pick with no `related` (they already fan out all main markets) —
correct, leave as-is.

## Critical files

- `src/resolver/resolve-market-prompt.md` — prompt section (human-gated edit; diff shown above).
- `src/resolver/resolve-market.ts` — schema field, `RawPick`, `toPick` mapping + guards.
- `src/resolver/live-menu-types.ts` — `MarketPick.related`.
- `src/resolver/execute.ts` — render related into `additional`.

## Risks / guardrails

- **Novelty-tail bias** (cf. rejected reranker): an LLM ranking the pool may prefer combo/novelty
  markets over obvious neighbours. Mitigated by: cap 3, "most direct / by intent" instruction, and
  refs-from-menu-only (cannot hallucinate). Acceptable for a non-settling suggestion slot; watch in
  eval — combo/novelty markets crowding out obvious neighbours is the failure signal.
- **Same-fixture enforcement** is deterministic in `toPick` (eventId match), not left to the prompt,
  so the 147-item cross-fixture case can't leak another match's markets.
- Related is **only** for `exact`/`close` legs (a `none` leg has no pick to anchor to — falls out
  naturally since `toPick` skips `match === "none"`).

## Verification

1. `npx tsx src/harness-loop/harness-run.ts --batch ambig` — the four probe queries are already
   cached for extract; this will re-hit `markets` cache misses. Re-capture those market picks with a
   temp-0 Haiku subagent using the UPDATED prompt (the schema now includes `related`), write to
   `llm-cache/`, re-run.
2. Inspect the resulting envelopes (e.g. via `src/harness-loop/inspect.ts` or a probe) and confirm
   each matched leg's `results[].additional[]` carries 2–3 sensible same-fixture markets, and that
   `highlighted` / the grader's `gotIds` are unchanged (related must not appear there).
3. Spot-check the "to win to nil" case: expect related ≈ {win at least one half, win & both teams
   to score, both teams to score}; expect NOT {woodwork, own goal, red card}.
4. Confirm existing batches (003/004) still pass — related is purely additive (new `additional`
   field, grader ignores it), so no regression expected.
