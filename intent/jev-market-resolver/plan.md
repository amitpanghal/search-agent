# Plan: Jev picks the market

- **Spec:** intent/jev-market-resolver/spec.md (Status: accepted, 2026-09-22)
- **Intent:** intent/jev-market-resolver/intent.md
- **Branch:** `sdlc-jev` directly, at the product owner's instruction (as the disambiguator was); one step = one commit.
- **Date:** 2026-09-22

## Context

The market stage (`resolveMarkets`, `src/resolver/resolve-market.ts`) is the last non-extract Bedrock call: one Qwen
call per menu group, ~$0.00077 and 1.7–2.5 s per query. The spec moves it to Jev (TypeSafe, transport already in
`src/resolver/jev-call.ts`): one request per query, `choice` questions only, `none` below a threshold or when Jev
does not answer, Qwen out of the stage. Everything downstream (`toPick`, `MarketPick`, `select`, `execute`) is
unchanged. Three paid runs (a Qwen baseline of the market gate, a Jev replay, one live probe) each need an explicit
OK first (the **Ask before paid runs** rule); every code step is shipped resolver code (the **Human-gated resolver
code** rule), so the full new prompt text and question templates are in this plan, not improvised at build time.

## Steps

### Step 1 — Spec amendment (fact): rules once in `state`, short per-question instructions
Files: `intent/jev-market-resolver/spec.md` (Data / API contracts + one Decisions line).
The contract says every question carries the rulebook as `instructions`. That repeats ~1.2k tokens 4× per bet; the
2026-09-21 measurement that produced the intent's numbers put the rules ONCE in `state.rules` and kept per-question
instructions to one line. Amend the contract to that shape; Decisions: *"rules once in `state.rules`; per-question
`instructions` are one-line templates in code. Decided by: engineer (factual)."* Commit `spec: amend — rules once in state`.

### Step 2 — Paid baseline of the market gate on Qwen (criterion 12), before any code
Files: `intent/jev-market-resolver/spec.md` (Decisions line with the count).
Ask for the OK, then run once: `npx tsx src/eval/market-resolve-gate.ts` (3 cells × ≤4 phrasings ≈ 1¢). Paste the
`Market-resolve gate …: N/3` line under Decisions as the Qwen baseline. Commit `spec: Qwen market-gate baseline N/3`.

### Step 3 — Rulebook rewrite + Jev decider + fixture + tests (criteria 1–5, 7, 8, 10)
Files: `src/resolver/resolve-market-prompt.md`, `src/resolver/resolve-market.ts`, `src/eval/live-menu-gate.ts:80–92`,
`NEW` `src/eval/market-picks.capture.json`, `src/resolver/invariants.test.ts`.

**3a. `resolve-market-prompt.md` — whole file replaced** (old text = the file at `3c6750e`). New text, in full:

```
You match each bet to the one market on a LIVE menu that settles it, and you say how well it fits.

The menu lists the markets actually offered right now, one per ref, some with their outcomes. A bet is a short
phrase; it may end with "(for <name>)", naming whose bet it is. The original request is background for a bet's
details (its side, threshold, sub-unit, time); the request itself is not a bet.

How well a market fits:
- exact: a bet on this market wins in exactly the scenarios the bet describes.
- close: no exact market exists, and this one wins in the same scenarios less precisely — a near-synonym, or a
  wider or narrower version of the same outcome in the same direction. A market that also needs another condition
  to win is a different bet, not close.
- none: nothing on the menu settles the bet — the candidates win in the opposite scenario, or are the same topic
  but a different bet. Choosing none is always allowed, and is the right answer when the fit is doubtful.

Rules that decide between look-alikes:
- Twins: a market scoped to a part (a half, a period, a group, a stage) is a different market from the whole-match
  or whole-competition one.
- Plain winner: a plain "who wins" bet is settled by the head-to-head result market alone. A market that adds a
  condition (a handicap, spread, margin or total) or a themed special is a different bet.
- Margin: a bet on winning by a stated amount is settled by the margin or handicap family, whose side at the
  matching line wins in exactly the asked scenarios; the plain result market cannot settle it. The exact line is
  chosen later; you choose the family.
- Variants: the variant is part of the market's identity ("Winner", "Top 2" and "Top 4" are different markets).
  Match the bet's precise outcome.
- Family asks: when the bet names a family of markets that differ only by variant, and names no single variant,
  pick the member a bettor most likely wants, label it close, and list the other members as related.
- Grain: "(for <player>)" means that player's own market — a label naming the player — not the match total and
  not another player's. "(for <team>)" means the team-scoped twin of a statistic when the menu has one
  ("<statistic> by <team>"); when it has none, the team is the bet's side within the market and the pick proceeds
  as normal.
- Ladders vs bands: an over/under threshold ("over 8.5") is settled by the plain over/under market of that
  statistic; an inclusive count ("8 or more", "8+", "at least 8") by the "N+" band market. The exact rung is
  chosen later; you choose the family.
- Sub-unit winner: winning a division, group or conference is settled by that sub-unit's own Winner market, not
  the overall Winner.
- Outcomes: when a bet names one of a market's listed outcomes, that market fits and the outcome is that listed
  string, verbatim.

Related markets: for each bet, the other markets on the same fixture this bettor most likely wants next, ranked by
closeness to the bet's intent.
```
Sport-agnostic check: "Total Runs by <team>" → "<statistic> by <team>"; "Group …/First Half" → "a half, a period,
a group, a stage". No sport, team or market name remains.

**3b. `resolve-market.ts`.** Remove the `bedrockToolCall` import (line 11), `INPUT_SCHEMA` (22), `callModel` (82),
`picksByLeg` (96). Keep `TOOL_NAME = "pick"`, `systemPrompt()` (now the rules text), `RawPick`, `DecideFn`, `toPick`
(54) untouched. Change:
- `export type DecideManyFn = (bets: { phrase: string; menu: Menu }[], query?: string) => Promise<RawPick[]>;`
- `resolveMarkets(bets, decideFn = decideWithJev, query?)`: `[]` for no bets; a bet with an empty menu is
  `{ match: "none", reason: "empty menu" }` without asking; the rest go to `decideFn`; map with `toPick(raw, bet.menu)`.
- `resolveMarket(phrase, menu, decideFn?)` wraps `[{ phrase, menu }]` (gates unchanged).
- `NEW` `decideWithJev: DecideManyFn` — ONE `jevChoice(TOOL_NAME, state, questions)`:

```
state = {
  query,                                   // background
  rules: systemPrompt(),                   // the rulebook, once
  menu: [{ ref, label, outcomes? }],       // union of the bets' menus, deduped by label; ref = index into this list
  bets: [{ leg, phrase, refs: number[] }], // refs = the union indices of THIS bet's own filtered menu
}
questions, per bet b (keys "pick:b", "fit:b", "next:b", "outcome:b"), all type "choice":
  pick:b     criteria { "<ref>": label, …, none: "No market on the menu settles this bet" }
  fit:b      criteria { exact: "a market on the menu wins in exactly the bet's scenarios",
                        close: "only a less precise market of the same outcome and direction exists" }
  next:b     criteria { "<ref>": label, … }                       // this bet's refs
  outcome:b  criteria { "<outcome>": outcome, …, none: "The bet names no listed outcome" }
             — only when at least one of this bet's menu items has `outcomes`; options = union of those strings
instructions (templates in code; <leg> and <phrase> filled per bet):
  pick:    Bet <leg>: "<phrase>". Which menu market settles this bet? Apply state.rules. Answer none when no
           market on the menu settles it.
  fit:     Bet <leg>: "<phrase>". Does the menu hold a market that settles this bet exactly (exact), or only one
           that settles it less precisely, as state.rules define close?
  next:    Bet <leg>: "<phrase>". Which other market on the same fixture would a bettor who placed this bet most
           likely add next?
  outcome: Bet <leg>: "<phrase>". Which listed outcome does this bet name? Answer none when it names no listed outcome.
```
Decode per bet: `a = answers["pick:b"]`; `none` / missing / `probabilities[choice] < envNumber("JEV_MARKET_THRESHOLD",
0.8, 0, 1)` → `{ ref: null, match: "none" }`. Else `ref = Number(a.choice)` mapped back from the union index to the
bet's own menu index; `match = answers["fit:b"]?.choice === "exact" ? "exact" : "close"`; `outcome =
answers["outcome:b"]?.choice`, `none` → null (`toPick` keeps it only if in the item's `outcomes`); `related` =
`next:b` probabilities sorted descending, keys → own-menu refs, drop the pick and unknown refs, first 3. A `null`
reply (any transport failure) → every bet `{ ref: null, match: "none" }`. A bet whose menu exceeds 254 refs splits its
`pick`/`next` questions into chunks (`pick:b:0`, `pick:b:1`, …) merged by probability — `// ponytail: never seen
above 128 labels; chunking keeps every item askable instead of dropping any`. The provisional threshold default is
`0.8` (the entity stage's); step 6 sets it from the replay. Header comment rewritten: Jev, one request, no Bedrock.

**3c. `live-menu-gate.ts:80–92`** — `replayMany` becomes `async (bets) => golds.map((g, i) => … bets[i]!.menu …)`
and the batched call passes `[{ phrase, menu }, { phrase, menu }]`. Behaviour unchanged.

**3d. `NEW` `src/eval/market-picks.capture.json`** — the 6 captured requests from the 2026-09-21 traces
(`…/446848fd…/scratchpad/{andorra,baltimore}.jsonl`, `llm-req`/`llm-resp` with `tool: "pick"`), copied before they
vanish: `{ captured: "2026-09-21", cases: [{ query, leg, phrase, menu: [{ label, outcomes? }], qwen: { label, match,
outcome?, related: string[] } }] }` — 7 bets (Andorra: `who wins (for Andorra)`→Full Time, `both teams to score`→Both
Teams To Score, `correct score`→Correct Score; Baltimore: `to win (for Baltimore)`→Moneyline, `to score a HR (for
Kazuma)`→Player to Hit a Home Run…, `strikeouts (for Shane Bazz)`→3+ Strikeouts…, `total runs`→Total Runs).
Consumed by the tests below and by the step-6 replay.

**3e. `invariants.test.ts`** — delete the `picksByLeg` test (line 387). Add, with the existing `stubFetch` /
`withEnv` / `reply` helpers (lines 566–583) and `jevEnv` plus `JEV_MARKET_THRESHOLD: undefined`:
- `market: Jev picks each bet from its own menu in ONE request` — Andorra bets 0 and 1 with their two captured
  menus; canned reply → `Full Time` / `Both Teams To Score`; `fetch.mock.callCount() === 1`; body has
  `pick:0 … outcome:1`; `pick:0`'s criteria are bet 0's refs + `none` only. (1, 6)
- `market: exact or close is the fit question's more probable option` — fit exact 0.9 → `exact`; close 0.7 → `close`. (2)
- `market: below threshold, none, or an unknown ref is none` — 0.79 / `none` / ref 999 → `{ match: "none" }`. (3)
- `market: a named outcome comes back verbatim, an unlisted one is dropped` — `Correct Score` + `3-2` kept; `9-9` dropped. (4)
- `market: related is the next question's top three, pick excluded` — canned `next` probabilities. (5)
- `market: Jev failures retry once on 429/529 and otherwise answer none, never throw` — 429→200 picks; 529→529,
  thrown fetch, malformed body → all `none`, no rejection, one `llm-resp` each. (7)
- `market: a missing JEV_ACCESS_KEY rejects by name and makes no request`. (8)
- `market: one request emits one llm-req/llm-resp pair and one priced usage row` — `tool: "pick"`, model
  `jev-latest`, `usageStore` row `{ tool: "pick", inputTokens, outputTokens: 0, priceIn: 0.042, priceOut: 0 }`. (10)
Red first: the tests import `decideWithJev` and the new `resolveMarkets` shape, so they fail to compile before 3b.
Commit `build: step 3 — Jev picks the market`.

### Step 4 — Orchestrator: one request per query (criterion 6)
Files: `src/resolver/resolve.ts:268–307`.
Replace `pickJobs: { idxs, picks: Promise }[]` with `jobs: { idxs: number[]; bets: { phrase; menu }[] }[]` collected
inside the loop (line 299 becomes a push of `{ idxs: llmIdxs, bets: llmIdxs.map(i => ({ phrase: betPhrase(…),
menu: fr.menu })) }`); after the loop, if any bet, ONE `usageStore.run(calls, () => resolveMarkets(allBets,
undefined, query))`, then map results back to leg indices in job order (line 306's logic, flattened). Drop the
"unbounded fan-out" ponytail comment (line 296–297) — there is no fan-out now. Proof: the step-3 one-request test plus
the live probe's single `market` cost row (step 7). Free gates green. Commit `build: step 4 — one Jev request per query`.

### Step 5 — Config, deploy, documents, skills (criterion 9 + the skills-and-documents rule)
Files: `.env.example`, `render.yaml`, `src/resolver/invariants.test.ts`, `src/resolver/bedrock-call.ts:1–3`,
`src/resolver/jev-call.ts:1–2`, `src/eval/market-resolve-gate.ts:13,117`, `AGENTS.md:148`,
`.claude/skills/resolver-pipeline/SKILL.md` (lines 33–36, 49, 111–113; `metadata.version` 1.1 → 1.2),
`.claude/skills/eval/SKILL.md:22`, `.claude/skills/probe/SKILL.md:65–66`.
- `.env.example`: header line 1 → "AWS credentials for the Bedrock extractor, and the Jev key for the entity gate
  and the market pick"; Jev block comment (line 15) names both stages; `NEW` `JEV_MARKET_THRESHOLD=0.8` with a
  one-line comment (value revisited in step 6).
- `render.yaml`: `NEW` `- key: JEV_ACCESS_KEY` / `sync: false` and `- key: JEV_MODEL` / `sync: false` under the
  AWS keys; the header comment says "Bedrock and Jev creds".
- `invariants.test.ts`: `config: every model env name read in src/ is documented, and the deploy declares the
  secrets` — grep `src/**/*.ts` for `process.env.(AWS|BEDROCK|JEV)_\w+` and `envNumber("(AWS|BEDROCK|JEV)_\w+"`,
  assert each appears as `NAME=` in `.env.example`; assert `render.yaml` contains the five keys
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `BEDROCK_MODEL`, `JEV_ACCESS_KEY`. Red before the
  yaml/env edits (JEV_ACCESS_KEY missing from render.yaml), green after.
- Headers/comments: `bedrock-call.ts` "the one Bedrock step (extract)"; `jev-call.ts` "used by the entity gate
  and the market pick"; `market-resolve-gate.ts` "needs JEV_ACCESS_KEY".
- `AGENTS.md:148`: Bedrock for the extractor only; Jev for the entity gate and the market pick.
- resolver-pipeline SKILL: LLM paragraph (33–36) → "extract is the one Bedrock call; stages 4 and 9 are one Jev
  `choice` request each (`JEV_ENTITY_THRESHOLD`, `JEV_MARKET_THRESHOLD`)"; stage 9 row → `Jev`, "ONE request per
  query, per-bet menus"; files list (111–113): prompt file now holds the Jev rules. eval SKILL:22 → "(Jev, paid —
  pennies)". probe SKILL:65–66 → "`[llm …]` rows are the model boundary (Bedrock for extract, Jev for entities and
  market)".
Commit `build: step 5 — config, deploy and documents name Jev for the market`.

### Step 6 — Paid Jev replay; set the threshold default (criterion 11)
Files: scratchpad script (not committed); `intent/jev-market-resolver/spec.md` (Decisions: the table + default);
`src/resolver/resolve-market.ts` and `.env.example` only if the default moves off 0.8.
Ask for the OK (Jev only, ~15 requests, under 1¢). The script imports `resolveMarkets` and runs, printing per case
the phrase, menu size, pick label, pick probability, fit probabilities, Qwen's captured answer, right/wrong:
- the 7 captured bets from `market-picks.capture.json`, each against its own menu, all in one request per query
  (Andorra 3 bets, Baltimore 4);
- the 3 gate cells against the snapshot menus (`filterBySubject(snap.match…).menu`): `both teams to score`, `BTTS`,
  `draw`, `draw no bet` (event subject, bare phrasing, as `market-resolve-gate.ts` builds them);
- built-to-fail / look-alike cases on the snapshot (verify labels against the menu when building): wrong
  direction — `Turkey to finish bottom of the group` [competition] → `none`; plain winner beside handicap twins —
  `USA to win` [match] → `Full Time`, not `Handicap`/`Asian Handicap`/`Draw No Bet`; sub-part twin present —
  `first half total goals over 1.5` [match] → `Total Goals - 1st Half`; sub-part twin absent — `Turkey to win the
  2nd half to nil` [match] → `none` (`Turkey to Win to Nil` is whole-match); margin — `Turkey to win by 2 or more`
  [match] → `Handicap` or `Asian Handicap` family.
Read the table: every right pick at or above the default, every wrong/`none` case below it. Set
`JEV_MARKET_THRESHOLD`'s default to the value that sits in the gap (keep 0.8 if it does); append the table and the
default under `## Decisions` with `Product owner to confirm.` If the table shows no gap, stop: that is a spec
judgement for the product owner (criterion 11 cannot be met as written). Commit `spec: Jev replay table, threshold <v>`.

### Step 7 — Paid gate on Jev + one live probe (criteria 12, 13), then verify
Files: `intent/jev-market-resolver/spec.md` (Decisions: the pastes).
Ask for the OK. (a) `npx tsx src/eval/market-resolve-gate.ts` on Jev → paste `N/3` next to the Qwen baseline.
(b) `npm run probe -- "<multi-leg query on live fixtures, ≥3 legs across ≥2 groups>" --out <scratchpad>/live.jsonl`
(one Qwen extract, one Jev request, Kambi) → paste the `[llm pick]` line (model, ms, tokens, cost) and the
`market` stage row; check picks = Qwen's captured picks or `none`, request ≤ 1,500 ms, cost ÷ bets ≤ $0.0003, and
`cost.calls` has exactly one `market` row. Optional and free: `npm run eval -- --from
<today's extract capture>` to show the extractor and entity gates unchanged. Commit `spec: gate and live probe
evidence`. Then `/build-plan verify`: PASS/FAIL per criterion.

## Criteria to proof

| # | Files that change | Proof |
|---|---|---|
| 1 | `resolve-market.ts`, `resolve-market-prompt.md` | `invariants.test.ts` — `market: Jev picks each bet from its own menu in ONE request` |
| 2 | `resolve-market.ts` | `invariants.test.ts` — `market: exact or close is the fit question's more probable option` |
| 3 | `resolve-market.ts` | `invariants.test.ts` — `market: below threshold, none, or an unknown ref is none` |
| 4 | `resolve-market.ts` | `invariants.test.ts` — `market: a named outcome comes back verbatim, an unlisted one is dropped` |
| 5 | `resolve-market.ts` | `invariants.test.ts` — `market: related is the next question's top three, pick excluded` |
| 6 | `resolve-market.ts`, `resolve.ts` | the step-3 one-request test (decider level) + the step-7 probe's single `market` cost row (orchestrator level) |
| 7 | `resolve-market.ts` | `invariants.test.ts` — `market: Jev failures retry once on 429/529 and otherwise answer none, never throw` |
| 8 | `resolve-market.ts`, `invariants.test.ts` | `market: a missing JEV_ACCESS_KEY rejects by name and makes no request`; `npm test` + `npm run gate:live-menu` green |
| 9 | `.env.example`, `render.yaml`, `invariants.test.ts` | `config: every model env name read in src/ is documented, and the deploy declares the secrets` |
| 10 | `resolve-market.ts` | `invariants.test.ts` — `market: one request emits one llm-req/llm-resp pair and one priced usage row` |
| 11 | `spec.md` Decisions (+ threshold default) | the pasted replay table (step 6) — no unit test; the paste is the proof |
| 12 | `spec.md` Decisions | pasted gate counts, Qwen (step 2) vs Jev (step 7) — no unit test; the paste is the proof |
| 13 | `spec.md` Decisions | pasted `[llm pick]` line + `market` row (step 7) — no unit test; the paste is the proof |

## Checks

Free, after every code step (3, 4, 5): `npm run typecheck` · `npm test` · `npm run gate:live-menu`.
Paid, once each, with an explicit OK in the chat, output saved and pasted: step 2 `npx tsx
src/eval/market-resolve-gate.ts` (Qwen) · step 6 the Jev replay script · step 7 the same gate on Jev and one
`npm run probe -- "…" --out …`. `npm run eval -- --from <capture>` is free and optional.
House rules in play: **Ask before paid runs**, **Human-gated resolver code** (this plan is the approval record; the
prompt text above is the old→new), **Sport-agnostic prompts**, **Never branch on phrasing**, **the smallest-diff
rule**, **Never drop a row on missing data**, and the skills-and-documents rule (step 5).

## Decisions

- 2026-09-22 — Step 3 also touched one line of `src/resolver/resolve.ts` (the `resolveMarkets` call site, line 299):
  the new per-bet-menu signature would otherwise leave the orchestrator uncompilable between steps 3 and 4, and a
  red type check is never committed. Step 4 still owns the collect-then-one-call change. Plan fact; decided by:
  engineer.

