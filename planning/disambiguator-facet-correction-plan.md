# Disambiguator facet-correction — line + subject (v1)

> **Status:** design proposal (show-and-ask). Extends the existing resolver
> ([`disambiguate.ts`](../src/resolver/disambiguate.ts)); no new LLM call. Builds on the
> recall-resolve architecture ([`recall-resolve-plan.md`](./recall-resolve-plan.md)).

## Goal

Today the resolver picks the **market** but the **line** and **subject** are the extractor's guesses,
carried through and never re-judged — so when the extractor mis-types them the query dies as a **silent
no-result** (population quantified in [Build order §0](#build-order) before any code). v1 lets the resolver
also **correct the line and subject** to fit the market it picked, and **clarify** when no market can
satisfy the line.

**In scope (v1):** line shape (binary↔numeric↔selection), line value (the win/draw/loss pair), subject
re-bind (event→team). **Deferred (v2):** level (match vs tournament), near-synonym abstain.

## Principle

The resolver is the one stage that sees the **full sentence** *and* the **chosen market**. So it — not the
cold extractor — should make the (criterion, line, subject) tuple coherent. **Mechanism = Option A:** the
existing `decide()` call returns the corrections alongside its pick; it costs no new round-trip.

## The three v1 behaviours (worked examples)

Fixture USA vs Australia (Australia = away).

| Query | Extractor gave | Resolver does | Result |
|---|---|---|---|
| **B** "Australia win at half time then draw" | pick-context: HT/FT; `line: binary yes` | pick HT/FT **+ line `selection "win/draw"`** | "Australia / Draw" |
| **A** "draw at half time then Australia win" | HT/FT; `subject: event` | pick HT/FT **+ subject `team Australia`** | "Draw / Australia" |
| **Assist** "Kane to assist over 2.5" | candidates only binary "To Assist"; `line: numeric over 2.5` | no market can price it → **clarify** | "No over/under assists market — want the yes/no 'to assist'?" |

## §0 result — failure population (quantified 2026-06-19)

Counted from the captured eval/probe data (no extractor re-run): the full-pipeline HT/FT probe
([`scripts/.htft-app-out.txt`](../scripts/.htft-app-out.txt)) plus the `EvaledQueries.md` failure log.

**Both v1 behaviours have a real, captured target — they are not hypothetical:**
- **B (line correction)** — "Australia win at half time then draw" extracts as **one** selector, subject
  `team Australia` (right), but `line: binary yes` (wrong). It picks HT/FT correctly, then the executor
  **returns no-results** (`price-or-line`: HT/FT has no `OT_YES`). A **confirmed silent no-result today.**
- **A (subject correction)** — "draw at half time then Australia win" extracts as **one** selector,
  `line: selection "draw/win"` (right) but `subject: event` (wrong). It picks HT/FT, but with no team
  bound the executor returns **all three** "Draw / *" outcomes, not "Draw / Australia". A **confirmed
  degraded (wrong-subset) result today.**

**But the population is narrow and the scope honesty matters:**
- All v1-addressable cases in captured data are **HT/FT** (2 cases: A + B above). Each phrasing needs
  **only one** of the two corrections — never both.
- The most natural phrasing, **"half time draw then Australia to win", extracts as TWO selectors**
  (`half time draw` + `to win`) → returns Half Time **and** Full Time as separate markets, never the
  combined HT/FT. v1's per-cell correction **cannot fix this** (it can't re-merge selectors — needs
  multi-unit, [`ScenariosLeft.md §1`](./ScenariosLeft.md)). So v1 fixes **2 of 3** phrasings of the same bet.
- The rest of the documented failure set is **out of scope**: ~6 near-synonym / level / false-friend
  **wrong-market** picks (Q13, Q21, Q29, Q43, Q49, Q51, "shut out") and ~2 extractor drops/crashes (Q40,
  KE-1). None are line/subject mis-types the resolver could fix.

**Go/no-go read:** v1 is a **genuine but small** win — two captured HT/FT fixes — with a known gap (the
split phrasing still breaks, so users get inconsistent behaviour across phrasings of the same bet). Build
it scoped as the HT/FT single-selector coherence fix; do **not** sell it as a general facet-correction win.

## Design decisions

### 1. Output shape — extend `pick` with optional corrections
Add two optional fields to the Pass-1/Pass-2 `pick` action ([`zPick`](../src/resolver/disambiguate.ts:215)):
```ts
zPick = { ref, action:"pick", id, line?: SelLine, subject?: Subject }
```
- `line` — a corrected line (e.g. `{kind:"selection", value:"win/draw"}`), **only** when the extractor's
  line clashes with the picked market.
- `subject` — a corrected subject (e.g. `{kind:"team", name:"Australia"}`), **only** when the extractor's
  subject clashes (event on a team-specific market while a team is in scope).
- The **clarify** path (already Pass-2) covers "no candidate can price the line" — reached via the existing
  reexpress→clarify flow, no new action.

### 2. No outcome-shape labels — lean on names + query
We do **not** add a per-candidate `numeric/binary/selection` label. That is the `answerType` label
**already probed and rejected** (recall-resolve §4: names + full query let the model judge line-fit; the
label forced wrong picks on abstain). Instead:
- Upgrade the line context the model sees from **kind-only** to **kind + value + direction** (small change
  to [`userMessage`](../src/resolver/disambiguate.ts:247)), so it can normalise a value (the win/draw pair).
- A reconciliation **rule** in the prompt: "make the line and subject consistent with the market you
  picked; if no candidate can price the line, don't force it — re-express / clarify." Sport-agnostic.

### 3. Anchor / override guard (don't meddle with good facets)
Same philosophy the resolver already uses for picks ("anchor on the default, override only on evidence"):
- **Keep the extractor's line** unless it genuinely clashes with the picked market (a numeric "shots over
  2.5" → numeric Shots market = no clash → no correction).
- **Keep the extractor's subject** unless the market is team-specific and the subject is `event` with a
  team in scope.

### 4. Validation (no hallucinated corrections — mirror the `pick` id guard)
- **subject:** a corrected `team` name must match a scope team (resolvable via the existing
  `teamIdByName` source); else **drop the correction** and fall back to the extractor's subject. (For HT/FT
  that fallback still degrades gracefully — the narrow-and-show resolver shows the draw subset.)
- **line:** must parse to a valid `Line` (any kind); else drop. **No win/draw/loss gate** — a non-HT/FT
  selection (e.g. correct-score `"2-1"`) is a legitimate correction, and the executor's
  [`htftTypes`](../src/resolver/executor.ts:257) already returns null and falls back to a plain label
  match for it. Gating on the win/draw/loss tokens would wrongly drop those.

### 5. Flow to the executor — write onto the cloned selectors (no planFetch change)
`disambiguate` already `structuredClone`s the scope. The orchestrator writes a settled correction onto
`settled.units[0].selectors[i].line` / `.subject`. **planFetch already reads `sel.line` and `sel.subject`**
([plan-fetch.ts:228](../src/resolver/plan-fetch.ts:228)), so the corrected values flow to the executor with
**no planFetch edit**. The executor's narrow-and-show HT/FT resolver then maps them as today.

### 6. Known limitation — exact-hit markets are out of reach (accepted)
The correction rides on the resolver's `pick`, but an **exact alias / exact catalog-name** market never
reaches the resolver — it's skipped at [disambiguate.ts:198](../src/resolver/disambiguate.ts:198) (the only
LLM-free path). So if an HT/FT phrase grounds by an exact hit, its mistyped line/subject are **not**
corrected. **We accept this** rather than re-routing exact hits through the LLM: the gate exists precisely
to keep confident hits cheap, and an exact alias is a deliberate, curated mapping. If §0 shows a real
exact-hit HT/FT miss, the fix is an alias-table edit, not a resolver change.

## Code changes (contained to the resolver)

- **[`disambiguate.ts`](../src/resolver/disambiguate.ts)**
  - `zPick`: add optional `line` / `subject` (Pass-1 and Pass-2 schemas).
  - `userMessage`: send the full line (kind + value + direction), not just `lineKind`.
  - `Outcome` (`settle-market`): carry optional `line` / `subject`; `applyOutcomes` writes them onto the
    cloned selectors after validation.
  - validation helpers (subject-in-scope, line-parse) beside `validPick`.
- **[`disambiguator-prompt.md`](../src/resolver/disambiguator-prompt.md)** — add the reconciliation rule
  (line + subject), sport-agnostic, mechanics-only example. **Draft → show → finalise** (prompt discipline).
- **No change** to `plan-fetch.ts` (reads corrected selectors) or `executor.ts` (narrow-and-show already in).

## Eval

- New replay fixtures (captured `decide()` decisions → orchestrator, no Haiku): **B** (line→"win/draw"),
  **A** (subject→Australia), **Assist** (clarify). Assert the corrected `line`/`subject` reach
  `planFetch` and the executor returns the expected pick(s) / clarify.
- **Regression:** clean cases must be untouched — "Haaland shots over 2.5" (numeric→numeric, no
  correction), "BTTS" (exact), a confident criterion pick. Prove picks don't shift (the `answerType` A/B
  methodology).
- 1× ship gate only (skip the 5×) unless reproducibility is asked for.

## Risks to validate during build
- **answerType-adjacent risk:** the reconciliation context must inform **only** the line/subject, never
  re-rank the criterion pick. Watch pick-accuracy in the regression set.
- **Haiku reliability** on the value normalization (the win/draw pair) — it's better-conditioned than the
  extractor (knows the market), but confirm on a small battery before declaring v1 done.

## Build order
0. **Quantify the failure population (gate — do this first).** Count, over the gold/eval set, how many
   failures are **line/subject mis-types the resolver could fix** vs **wrong-market picks** (out of scope
   here) vs other. Reuse captured plans (don't re-run the extractor). If the line/subject share is only a
   couple of HT/FT queries, scope v1 honestly as a narrow fix; if it's broad, the general mechanism is
   justified. **Decide go/no-go before step 1.**
1. `zPick` + schema + `Outcome`/`applyOutcomes` plumbing (pure, unit-testable).
2. `userMessage` line upgrade + validation helpers.
3. Prompt reconciliation rule — **draft, show, finalise**.
4. Fixtures + deterministic replay in `npm run eval`.
5. Live probe (`probe-disambig.ts`) on B / A / Assist + the regression set.

## v2 (deferred, separate plan)
- **Level** — prefer match-level over tournament-aggregate / clarify.
- **Near-synonym abstain** — clarify instead of forcing a false-friend pick.
