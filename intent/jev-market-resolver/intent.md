# Intent: Jev picks the market

- **Date:** 2026-09-22
- **Source:** human
- **Status:** accepted
- **Jira:** none

## Problem / observed signal

After the fetch, the pipeline picks one market per bet from the live menu with one Qwen call on Bedrock per
menu group (`resolveMarkets`, `src/resolver/resolve-market.ts`, tool `pick`): the model reads the labels and
returns a ref, an `exact | close | none` label, an optional outcome and up to three related markets, guided by
a 7,070-character rulebook (`resolve-market-prompt.md`). Measured on the 2026-09-21 A/B traces: about $0.00077
per call (≈4.6k input tokens, mostly the fixed rulebook) and 1.7 to 2.5 s wall per query for the stage.

Replaying the same queries through TypeSafe's Jev on 2026-09-21 (`POST api.typesafe.ai/v1/systemone`, the
transport that already ships in `src/resolver/jev-call.ts` for the entity stage):

- "andorra to win its first game and BTTS and with a score line of 3-2" — 3 of 3 picks identical to Qwen
  (Full Time, Both Teams To Score, Correct Score), and Jev also returned the outcome 3-2 in the same pass;
  stage 2,501 ms / $0.00104 → 923 ms / $0.00052. A one-call variant (union menu as state, each bet's own
  filtered refs as its options) gave the same picks at 988 ms / $0.00040.
- "baltimore to win and Kazuma to score a HR, Shane Bazz to have atleast 3 strikeouts and total runs over 7.5"
  — 4 of 4 picks identical; stage 1,712 ms / $0.00202 (4 parallel Qwen calls) → 1,009 ms / $0.00054 (one Jev
  call, 12 questions), and Jev's related lists were tighter (Run Line, 2+ HR, Total Strikeouts).
- a 92-item menu, single pick — same ref as Qwen ("Full Time", 0.99) in 782 ms.

Two soft spots showed: on "at least 3 strikeouts" → "3+ Strikeouts" Qwen said `close` and Jev's
exact-probability was 0.39 (both hedge where the rule says exact); and the pick question's runner-up
probabilities are ~0, so `related` is not free — it needs its own "what would this bettor add next" question
(about 1,700 input tokens per bet on a ~90-label menu, ≈ $0.00007).

Since the entity stage moved to Jev (merged 2026-09-22, `8fd892e`), the market picker is the only non-extract
Bedrock call left. Its share is roughly $1,315 per million queries today, about $275 with Jev.

Evidence: local A/B traces (`andorra.jsonl`, `baltimore.jsonl` in the 2026-09-21 session scratchpad; probe
traces under `scripts/.trace-out/`, gitignored) and the session notes; the Jev replies themselves were not
saved. No user report.

## Desired outcome

For every bet, the market is picked by Jev from the live menu; the market stage makes no Bedrock call at all.
The stage makes one Jev request per query, whatever the number of legs. On the gold deck the picks are the same
as today's (`exact` on the same market, or `none`), a bet's named outcome is still returned when the menu lists
it, and related markets still come back: three for a single-leg query, one per leg otherwise. A pick Jev is not
confident in is `none`, exactly the "no market" answer the pipeline gives today. The stage answers in about
half the time and at a quarter of the cost.

## Non-goals

- The extractor stays on Qwen with no prompt change; it becomes the pipeline's only Bedrock call.
- No change to how the menu is built or filtered before the pick (`recall`, `scope-menu`, `filter`), nor to
  what the pick feeds downstream (`MarketPick`: label, match, outcomeLabel, related), so `select` and `execute`
  are untouched.
- No new npm dependency and no Vercel AI Gateway; the direct REST transport already in the repo is enough.
- No change to the extractor's `market_concept` phrasing or to `betPhrase`.

## Constraints known up front

- Jev has no text output and answers `choice` / `boolean` questions only, ≤255 options per question and 32k
  tokens of state. The single Qwen answer (ref + exact/close + outcome + related) becomes several questions; an
  outcome-expanded menu was measured at 244 options, near the cap, so outcomes may need their own question
  rather than expanded options.
- Jev is documented weak on negation-heavy, indirect instructions; the rulebook is written that way ("never…",
  "except when…"). Its rules cannot be pasted in wholesale; what carries over has to be measured, not assumed.
- The confidence threshold and the exact/close rule are set from a replay of the captured picks and
  built-to-fail cases (wrong direction, plain winner vs handicap twin, sub-part twins), not chosen up front.
- Shipped resolver code (the **Human-gated resolver code** rule): plan and approval before any edit.
- The market-resolution gate inside `npm run eval` (`src/eval/market-resolve-gate.ts`) calls the live picker;
  it must run on Jev and is a paid run (the **Ask before paid runs** rule). The 29 captured `pick` requests
  replay for pennies.
- `cost.ts` already prices Jev rows from their own `priceIn`; the `pick` rows must carry it so the cost block
  stays truthful.

## Success signal

- The market-resolution gate in `npm run eval` passes on Jev at or above its Qwen pass rate today (baseline
  taken from the last green run before the switch).
- A replay of the 29 captured `pick` requests matches Qwen's picks, or abstains, on every one; no
  confident-wrong pick.
- The replay shows a clear gap between right picks and wrong/none cases, and the threshold sits in it.
- `npm run gate:live-menu` and `npm test` stay green.
- Probe traces show the market stage at p50 about 1 s per query (today 1.7–2.5 s) and its cost rows at or
  below $0.0003 per call (today about $0.00077), with no `pick` row priced from `BEDROCK_PRICE_*`.
- One live A/B probe on a multi-leg query agrees with the Qwen picks or abstains.

## Decisions

- 2026-09-22 — Fact fix: "29 captured `pick` requests" → 6 (Andorra 2, Baltimore 4; 7 bets). The 2026-09-10
  traces no longer exist; only the 2026-09-21 A/B traces do. Found by /spec; no change to the outcome or scope.
