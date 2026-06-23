# Plan: Make SELECT bet-offer aware (structure-driven, type-keyed)

## Context

Today the SELECT stage ([src/resolver/select.ts](../src/resolver/select.ts)) receives a **flat
`KOutcome[]`** — the picked market's outcomes already flattened by `outcomesForPick`
(resolve.ts:59). Because it loses the bet-offer boundary, it has to guess each market's shape from
fragile `label` strings ("Over", "Yes", "1") and needs hand-written guards (e.g. the "is
`participant` literally Yes/No?" check at select.ts:37-40).

We verified against the official Kambi spec (`docs/BetOffer.md`) plus two live probes
(`scripts/.betoffer-type-probe.ts`, `scripts/.outcome-shape-verify.ts`) that:

- **Every outcome carries a stable `type` enum** (`OT_OVER`, `OT_UNDER`, `OT_YES`, `OT_NO`,
  `OT_ONE`/`OT_CROSS`/`OT_TWO`, `OT_ONE_ONE`…, `OT_PLAYER_PARTICIPANT`, `OT_UNTYPED`). This is a far
  more reliable key than the localized `label`.
- Outcomes also carry **`englishLabel`** (un-localized, never reversed) and, for Correct Score,
  **`homeScore`/`awayScore`** numeric fields — and **`eventParticipantId`** (a player's team).
  None of these are in our `KOutcome` type yet.
- A few bet-offer types are **polymorphic** (type 2 1X2 has participant *and* static-label styles;
  type 13 Head-to-Head has Yes/No *and* participant styles; type 4 "Outright" is usually
  named-participants but can model Yes/No as pseudo-participants). So the structural invariant lives
  at the **`outcome.type`** level, not at `betOfferType` — you must read `outcome.type`.

**Goal:** pass SELECT the picked market as `{ events, betOffers }` (Kambi's own shape) and rewrite it
as one **type-keyed gate funnel**, so the market structure is read, not guessed. This deletes most of
the label-sniffing, adds correct-score / HT-FT (combo) support, and is more deterministic.

## Corrections baked in (from the spec verification)

1. **Do NOT route "owner-yes" by `betOfferType`.** An earlier sketch used `OWNER_YES = {4,18}`; the
   spec shows type 4 is "Outright" (usually named participants). Keep detecting the affirmative from
   the **outcome shape** (an `OT_YES` outcome / a `Yes` label), as today.
2. **Direction → `outcome.type`** (not lowercased label): `over → {OT_OVER, OT_OVER_EXACT}`,
   `under → OT_UNDER`, `yes → OT_YES`, `no → OT_NO`. (Feed currently uses `OT_OVER`; keep the
   `OT_OVER_EXACT` alias the spec documents.) **`OT_UNTYPED` counts as "no usable type", exactly
   like an absent `type`** — verified against the live snapshot, ~55% of outcomes are `OT_UNTYPED`
   (the 109 type-4 outright `Yes`/`No` outcomes, the Asian-Handicap team sides, …). So direction
   must fall back to the `label` for those, or they get silently dropped. The fallback is an EXACT
   lowercased label match (`"over"`/`"under"`/`"yes"`/`"no"`), never a substring — so `"Over 1.5"`
   is *not* direction `over` (that line-in-label family stays out of scope; see Notes).
3. **Combo / score markets** (`line.kind === "selection"`, currently dropped at resolve.ts:56):
   pick Correct Score by numeric `homeScore`/`awayScore`, and HT/FT + Double Chance by
   `outcome.type` / `englishLabel` — never the reversible `label`.
4. **Static-label 1X2/handicap** (no `participantId` on outcomes): map a team subject to home/away via
   the **event participants in the slice**, then to `OT_ONE`/`OT_TWO`. Needs `events` in the slice.
5. **Handicap line sign is type-dependent**: type 1/7 = opposite signs per team (use the team's own
   outcome line); type 11 = same line from home perspective (negate for the away side). Detect from
   the data (do the sides' lines share a sign?) — no `betOfferType` hard-coding required.

## Changes

### Phase 1 — data model (small, low-risk)

- **`src/resolver/offering-client.ts`** (KOutcome, line 56): add optional fields
  `englishLabel?: string`, `homeScore?: string`, `awayScore?: string`, `eventParticipantId?: number`.
  They arrive straight from the API (no `normBo`/normalizer to touch — `normBo` only wraps
  `betOffers`/`events`).
- **`src/resolver/select.ts`** `SelectSpec`: add `selection?: string` (the combo token, e.g. `"2-1"`,
  `"1/1"`, `"X2"`).
- **`src/resolver/live-menu-types.ts`**: no shape change (the `Selection` output is unchanged —
  `outcomeId` / `line` / `subject` / `fallback`).

### Phase 2 — rewrite `select` as a bet-offer-aware funnel

Change the signature:

```ts
type Slice = { events: KEvent[]; betOffers: BetOffer[] };   // the picked market only
export function select(slice: Slice, spec: SelectSpec, ctx?: { home?; away? }): Selection
```

Internals — flatten once into `Cand = { o: KOutcome; bo: BetOffer }` (keep the parent offer for the
handicap-sign check + event lookup), then run gates **only when the spec carries that field**:

1. **SUBJECT gate** (which side):
   - `spec.subjectId` → keep `o.participantId === subjectId`.
     - empty + an affirmative (`OT_YES`/`Yes`) exists → owner-bound, keep all (Yes picked at step 5).
     - empty + named participants exist → `fallback: "subject-absent"`.
     - empty + no participantId anywhere (static-label market) → map id→home/away via the slice's
       event participants, then keep `OT_ONE`/`OT_TWO`.
   - `spec.subject` `"home"/"away"` → `o.participantId` of that side if present, else `OT_ONE`/`OT_TWO`.
   - `spec.subject` name → diacritic-folded `participant` match (reuse `fold` from
     `src/resolver/lexical.ts`).
2. **DIRECTION gate**: keep `o.type ∈ DIR_TYPE[spec.dir]`. Treat `OT_UNTYPED` (and an absent
   `type`) as "type uninformative" and fall back to an EXACT lowercased `label` match for those
   outcomes — see correction #2. This is load-bearing, not a rare safety net: the untyped tail is
   ~half the feed (e.g. owner-yes outrights price `Yes`/`No` as `OT_UNTYPED`). Concretely:
   `dir(o) = DIR_OF_TYPE[o.type] ?? (o.label?.toLowerCase() as Dir | undefined)`, then keep
   `dir(o) === spec.dir`.
3. **LINE gate** (numeric): exact `line` match → else nearest offered (`fallback: "nearest-line"`) →
   else `fallback: "line-absent"`. Handicap: if the candidate sides share a line sign (type-11 style),
   negate the away side before comparing.
4. **COMBO gate** (`spec.selection`): Correct Score → match `homeScore`/`awayScore`; HT/FT + Double
   Chance → match `outcome.type` (preferred) or `englishLabel`; miss → `fallback: "subject-absent"`.
5. **AFFIRMATIVE / single** (no narrowing fields left): owner-bound → the `OT_YES`/`Yes` outcome;
   else the single survivor (1X2 win, outright).

Keep the existing `lineOf` helper and the `Selection` return contract (so `execute` is untouched).
This removes the `isOneXTwo`, `hasNamedParticipants`, the "byId empty → is there a Yes?" heuristic,
and the single-named-outcome shortcut (select.ts:36-72) — they fall out of the funnel.

**Worked checks** (must pass):
- "France -1.5 handicap" (type 1) → subjectId France → line -1.5 matches `line:-1500`. ✅
- "Barcola over 2.5 shots" (type 127) → participantId Barcola → `OT_OVER` → line 2.5. ✅
- "Iraq to win at least one half" (type 18) → no participant, `OT_YES` present → owner-bound → Yes. ✅
- "correct score 2-1" (type 3) → `homeScore:"2"`, `awayScore:"1"`. ✅ (immune to AWAY_HOME reversal)

### Phase 3 — wire the callers

- **`src/resolver/resolve.ts`**: replace `outcomesForPick` (flatten) with an offers-by-pick filter
  returning `BetOffer[]`, build `slice = { events: r.data.events, betOffers }`, and call
  `select(slice, spec, ctx)` (resolve.ts:100-101). Extend `selSpec` (resolve.ts:51) to map
  `line.kind === "selection"` → `{ selection: line.value }` instead of dropping it (resolve.ts:56).
- **`src/eval/live-menu-gate.ts`**: change `offersFor(label)` (lines 99-103) to return the filtered
  `BetOffer[]`/slice instead of flat outcomes; update the 3 `select(...)` calls (115, 124, 152).
  `SDECK`/`IDECK` specs stay the same.
- **`scripts/.pipeline-trace.ts`** (scratch, gitignored): mirror the same slice change so the trace
  keeps working (lines 67, 138-140).

### Phase 4 — tests

Add gate cases (in `live-menu-gate.ts`) for the newly-covered shapes, replaying captured menus:
- Correct Score by `homeScore`/`awayScore`; HT/FT by `outcome.type`.
- Player line over/under (type 127) including a 1-outcome betoffer (under not offered → fallback).
- Type-11 away-side handicap sign.
- Owner-yes detection still works via outcome shape (not betOfferType).
- **DIRECTION gate falls back to label on `OT_UNTYPED`**: a `{dir:"yes"}` query against an untyped
  `Yes` outcome (a type-4 outright) still selects it (would be dropped under a missing-only fallback).

Check the captured fixture (`scripts/capture-live-menu.ts` output) already carries `englishLabel`/
`homeScore`/`awayScore`; if it was trimmed, re-capture so the new gate cases have the fields.

## Files to modify

| File | Change |
|---|---|
| `src/resolver/offering-client.ts` | add 4 optional fields to `KOutcome` |
| `src/resolver/select.ts` | new `{events,betOffers}` signature + gate funnel; add `selection` to `SelectSpec` |
| `src/resolver/resolve.ts` | slice builder, `select(slice,…)` call, `selSpec` selection mapping |
| `src/eval/live-menu-gate.ts` | `offersFor`→slice; update 3 select calls; new test cases |
| `scripts/.pipeline-trace.ts` | mirror slice change (scratch) |

`src/resolver/execute.ts` — **no change** (consumes `Selection.outcomeId`; index already keyed by
`o.id`). `src/resolver/filter.ts` — no change.

## Verification

1. `npx tsc --noEmit` — types compile with the new fields/signature.
2. `npm run gate:live-menu` — the offline replay gate (extended decks) is all-green.
3. `npx tsx scripts/.pipeline-trace.ts "<query>"` for a handicap, a player over/under, a correct
   score, and an owner-yes query — confirm SELECT picks the right `outcomeId`/line/side.
4. Ship gate **1×** (`npm run eval`) per standing guidance — no 5× release run unless asked.
5. Spot-check live: re-run `scripts/.outcome-shape-verify.ts` to confirm field assumptions still hold.

## Notes / risks

- **Combo gate is the fuzziest** new piece: it depends on the extractor's `selection` value format
  matching the feed. Mitigation: match on `homeScore`/`awayScore` and `outcome.type` first (fully
  deterministic), fall back to `englishLabel` only as a last resort. Worth a quick probe of real
  HT/FT and correct-score tokens before trusting the string path.
- **Minimal-by-design**: gates run only when the spec field is present, so no new combinatorial code;
  the funnel is the same 5 steps as today, just type-keyed. Net change is expected to *remove* lines
  from `select.ts`, not add.
- `betOfferType` stays a secondary/sanity signal (handicap-sign sanity, shape completeness), never the
  primary key — `outcome.type` is.
- **Line-in-label markets are OUT OF SCOPE** (a known gap, same as today's code). Some
  competition-grain player totals (betOfferType 13, e.g. "Number of goals scored by the player in the
  Competition") return `OT_UNTYPED` outcomes labelled `"Over 1.5"` / `"Under 1.5"` with **no** numeric
  `line` field — both the direction gate (untyped) and the line gate (no `line`) miss them. The
  `OT_UNTYPED`→label fallback above does NOT rescue these (exact match: `"over 1.5" !== "over"`).
  Either parse the label (`/^(over|under) (\d+(?:\.\d+)?)$/` → dir + line) or accept the gap — but do
  not claim player over/under is fully covered.
