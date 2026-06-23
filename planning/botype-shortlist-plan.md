# betOfferType shortlist to shrink the resolve payload

## Status (updated 2026-06-22) — read first

**Done & validated this session (data + prompt wording only; no code wired yet):**
- `data/betoffertypes.json` created — the sport-agnostic catalog (`{ id, label, gloss }`, **22 types**).
  Labels fixed to the live feed (id 3 = **Correct Score**, not "Result"; id 2 = Match Result; id 4 = Outright
  Winner) and 3 phantom types dropped (`scorecast 16`, `wincast 20`, `matchparlay 999999` — not in the Kambi
  reference `docs/BetOffer.md`, never seen in the feed). Each `gloss` describes the type by STRUCTURE/intent
  (no sport idioms) and cross-references the one distinction the model gets wrong unaided: a single named
  individual's own prop → `playeroccurrenceline` vs many-competitor / team markets → `scorer` / `yesno`.
- Old `data/football/football_betoffertypes.json` removed.
- The exact prompt subsection wording is settled — copy it **verbatim** from "Files to change → extractor-prompt.md" below.
- Extractor behaviour validated live: `npx tsx scripts/.botype-extract-probe.ts` → **10/10** (incl. the
  multi-leg showcase; "Mbappé to score" → `playeroccurrenceline`, "correct score" → `result`, "who will win"
  → `outright`). The probe is a faithful stand-in for production (same model, same real prompt, same tool
  schema + the injected `bo_types`).

**Left to do (the code wiring — NONE started):** `src/resolver/bo-types.ts` (new) + 7 edits
(`schema.ts`, `extract.ts`, `extractor-prompt.md`, `recall.ts`, `plan-recall.ts`, `resolve.ts`, `filter.ts`),
then the Verification section. Decide up front whether to ship the server-side `type=` fetch shrink or
client-side pruning only (see Design point 4).

## Context

The `resolve` (market-resolution LLM) stage is handed the whole filtered live menu. For a single
fixture this is large: on `"Stack France winning HT/FT with Mbappé scoring twice in next game"` the
France leg sees **137** menu items and the Mbappé leg **35**, out of **1726** fetched offers. The menu
is labels-only, but it is still big input per leg and grows with multi-leg / busy fixtures.

Every offer already carries a coarse `betOfferType` (`{ id, name }`), and there is a **sport-agnostic
catalog of 22 types** (`data/betoffertypes.json` — `{ id, label, gloss }`; the 3 phantom types not in the
Kambi reference were dropped, labels fixed to match the live feed, and a sport-neutral `gloss` added per
type so the extractor can map query wording to a bucket). The fetch layer already supports a server-side
`type=` filter (`offering-client.ts`, `recall.ts` `Task.params.type`) — it is simply never populated
(the pipeline is deliberately "market-deferred"). We want to use the type buckets to cut the payload
**without** re-introducing a hard pre-fetch market commitment.

Design decision (agreed with user): the extractor does **not** pick the exact type. It looks at the 26
buckets and returns an **over-inclusive shortlist** — drop only the buckets that clearly cannot hold the
market, keep everything plausible, omit when unsure. This keeps the "never under-drop the right answer"
property the Filter stage earns today.

Measured effect on the example query:
- Fetch: participant call sent with `type=` = union of legs' buckets → far fewer than 1726 offers.
- France `"HT/FT"` → `["htft"]`: **137 → 1** (tight, clean-mapping case).
- Mbappé `"to score twice"` → player-prop buckets: **35 → 22** (catch-all bucket, modest — by design).

## Goal / non-goals

- **Goal:** add an optional per-selector `bo_types` shortlist; use it (a) server-side on the fetch as the
  union of all legs, and (b) client-side to prune each leg's resolve menu.
- **Non-goal:** exact market selection at extract time (still the resolver's job); per-sport tokens or
  examples baked into the prompt rule; any change to entity grounding or the resolver prompt.

## Design

1. **Tokens, not ids.** The extractor emits bucket **tokens** (`"htft"`, `"playeroccurrenceline"`),
   schema-validated against the catalog (a hallucinated token cannot leak), text-valued like the rest of
   the plan. Token→id mapping happens at the use sites.
2. **Single source of truth.** One new module loads `betoffertypes.json` and exposes the enum
   keys, a token→id map, and the prompt reference block. The data file, not the prompt, is the source.
3. **Sport-agnostic prompt.** The rule states only the generic mechanism; the 22-bucket vocabulary
   (`- token — Label: gloss`, where the gloss describes each type by its STRUCTURE/intent, not by sport
   examples) is **injected** at load time into a `{{BO_TYPES}}` placeholder. No sport idioms or token names
   in the rule, no inline examples (rules-not-examples discipline). The glosses cross-reference each other on
   the one distinction the model gets wrong unaided — a single named individual's own prop
   (`playeroccurrenceline`) vs many-competitor / team markets (`scorer`, `yesno`).
4. **Server-side (fetch) = union, over-inclusive.** Shrinks the *download* only; Filter + Resolve still see
   everything fetched, so a slightly-wrong shortlist costs recall headroom, never a silent wrong answer.
5. **Client-side (per leg) = prune the menu, with an empty-guard.** Keep only offers whose
   `betOfferType.id` is in that leg-group's union of buckets. **Guard:** if the prune would empty a
   non-empty subject menu, ignore it — a bad shortlist can never strand a leg.
6. **Fail-open parse.** In `normalizePlan`, drop unknown/empty `bo_types` rather than reject the plan.

## Files to change (1 new, 7 edits)

**New — `src/resolver/bo-types.ts`**
Loads `data/betoffertypes.json`; exports `BO_TYPE_KEYS` (enum tuple — cast `Object.keys(..)` to
`[string, ...string[]]` so `z.enum` accepts it), `boTypeId(key)`, `boTypeIdSet(keys)`, and
`BO_TYPE_REFERENCE` (the `"- token — Label: gloss"` block for the prompt).

**`src/resolver/schema.ts`** — add to `Selector`:
`bo_types: z.array(z.enum(BO_TYPE_KEYS)).optional()` (import `BO_TYPE_KEYS` from `./bo-types`). Over-inclusive
by design; omitted = keep all buckets.

**`src/resolver/extract.ts`**
- Build the system prompt with the injected list:
  `readFileSync(...).replace("{{BO_TYPES}}", BO_TYPE_REFERENCE)`.
- In `normalizePlan`'s selector loop, keep only known tokens and drop the field if empty (fail-open, same
  spirit as the existing `odds`/`attrFilter` sanitizers).

**`src/resolver/extractor-prompt.md`** — two small, sport-agnostic edits only:
- (a) selector shape line: add `bo_types?` to `{ subject, market_concept, bo_types?, line?, … }`.
- (b) new subsection (rule + injected list, no examples, no tokens):
  ```markdown
  ### bo_types (optional) — candidate market-type buckets

  You are given a fixed list of coarse market-type buckets (token — name):

  {{BO_TYPES}}

  Return `bo_types`: every bucket token that could **plausibly** carry this market — a shortlist to
  narrow the search, not an exact pick. **Keep generously; drop a bucket only when it clearly cannot
  hold the market. When in doubt, or if nothing can be ruled out, omit the field** (= keep all
  buckets). Do not encode the line, period, or subject here — each has its own facet.
  ```
- (No worked-example edit — dropped to keep the prompt small.)

**`src/resolver/recall.ts`**
- `RecallInput`: add `boTypes?: number[]`.
- Thread into all three fetch paths (event / participant / group) as `params.type` /
  `fetchEventOffers(..., { type })` when present.

**`src/resolver/plan-recall.ts`**
- Collect the union of all selectors' `bo_types` → ids (`boTypeId`), set `boTypes` on the returned
  `RecallInput` for both the participant and group branches.

**`src/resolver/resolve.ts`**
- Per filter-group, compute `keepTypes = boTypeIdSet(idxs.flatMap(i => unit.selectors[i].bo_types ?? []))`
  (union across the group's legs) and pass it to `filterBySubject`.

**`src/resolver/filter.ts`**
- `filterBySubject(offers, events, subject?, keepTypes?: Set<number>)`: after the subject filter, keep only
  offers whose `betOfferType.id ∈ keepTypes`, **but** skip the prune if it would empty a non-empty set
  (the cardinal "never under-drop" guard). Rebuild the menu from the kept offers as today.

**Data dependency:** `data/betoffertypes.json` (sport-agnostic, `{ id, label, gloss }`) must be present.
`bo-types.ts` reads it at import. The old `data/football/football_betoffertypes.json` was removed (stale
labels, 3 phantom types); validated live via `scripts/.botype-extract-probe.ts` (10/10).

## Reuse (existing, do not rebuild)

- Server-side filter plumbing already exists: `Task.params.type` (`recall.ts:34`), the `type=` URL param
  (`offering-client.ts:86`), `fetchEventOffers(ids, { type })` (`recall.ts:71`).
- `betOfferType` is already on the `BetOffer` type (`offering-client.ts:71`).
- Selectors already flow onto the grounded unit (`ScopeUnit.selectors = plan.selectors`,
  `ground-scope.ts:285`) — no plumbing needed for the new field to reach `resolve.ts`/`plan-recall.ts`.
- `buildMenu` / `marketLabelOf` / `variantOf` (`recall.ts`) unchanged.

## Verification

1. **Typecheck:** `npm run typecheck`.
2. **No-LLM payload re-check:** re-run the scratch probes (`scripts/.payload-probe.ts`,
   `scripts/.botype-analysis.ts`) on the example query; confirm France leg menu drops (≈137 → 1) and
   Mbappé leg (≈35 → 22), and that the fetched-offer count falls.
3. **Ship-gate eval (1×):** `npm run eval` — confirm the new extractor field does not destabilize existing
   extractions or over-drop types. `bo_types` is optional and not a gold target, so the structural scorer
   should be unaffected; verify rather than assume. Do **not** run the 5× release unless asked.
4. **Safety spot-check:** a query whose market maps to a catch-all/ambiguous bucket (e.g. a both-teams /
   yes-no style market) should still resolve — confirm the empty-guard prevents any stranded leg.

## Risks / open items

- The extractor (the most fragile stage) gains a new job. Mitigation: over-inclusive "keep when unsure"
  rule + the client-side empty-guard + fail-open parse. Re-check with the eval after wiring.
- betOfferType buckets are coarse: catch-all types (e.g. `playeroccurrenceline`) give little reduction.
  Accepted — the win lands on clean-mapping markets; no payload regression elsewhere.
- Cleanup: remove the `scripts/.*` scratch probes after verification (already gitignored).
