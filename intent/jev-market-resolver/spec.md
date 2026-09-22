# Spec: Jev picks the market

- **Intent:** ./intent.md
- **Date:** 2026-09-22
- **Status:** accepted

## Summary

`resolveMarkets` (`src/resolver/resolve-market.ts:69`) keeps its contract — bet phrases plus a filtered menu in,
one `MarketPick` per bet out — and its injectable decider. Its default decider `callModel` (line 82, Bedrock)
is replaced by a Jev-backed one built on the transport that already ships for the entity stage (`jevChoice`,
`src/resolver/jev-call.ts:46`): for every bet a `pick` question over that bet's own menu refs plus `none`, a
two-option `fit` question (`exact` | `close`), a `next` question for related markets, and the outcome answer;
all bets of a query travel in ONE request whose `state` carries the union menu, so the orchestrator
(`resolve.ts:268–307`) stops firing one call per menu group and makes a single call after the groups are
prepared. A pick counts only at or above a probability threshold; below it, on `none`, or when Jev does not
answer, the bet is `{ match: "none" }` — today's "no market" leg. `bedrockToolCall`, the tool schema and
`picksByLeg` leave `resolve-market.ts`; the rulebook `resolve-market-prompt.md` is rewritten as the Jev
question text. The market gate in `npm run eval` runs on Jev unchanged in code.

Two facts differ from the intent: only **6** captured `pick` requests (7 bets: Andorra 3, Baltimore 4, traces of
2026-09-21) exist, not 29; and the market gate grades **3** gold cells (`gold.seed.jsonl`; the corpus has no `id`
cell). Both are recorded under Decisions; the intent's number is corrected with a Decisions line there.

## Acceptance criteria

1. **Jev picks, from the bet's own menu.** A query whose legs name a market produces one Jev request with tool
   name `pick` (the `STAGE` map `pick → market`, `cost.ts:26`, is unchanged) and, per bet, a `choice` question
   whose options are that bet's filtered menu refs plus `none`. A pick whose chosen option's probability is at or
   above `JEV_MARKET_THRESHOLD` (`NEW` env, read with `envNumber`, `jev-call.ts:24`) becomes a `MarketPick`
   through today's `toPick` (`resolve-market.ts:54`): `label` = the menu item's label, `match` from criterion 2.
   Observable: the probe trace shows one `[llm pick]` row with a `jev-` model id and the `market` stage row shows
   the labels. Test (stubbed global `fetch`, canned answers): the Andorra bets `who wins (for Andorra)`, `both
   teams to score`, `correct score` against the captured menus resolve to `Full Time`, `Both Teams To Score`,
   `Correct Score` — the picks Qwen made on 2026-09-21.
2. **`exact` or `close` from a two-option question.** Each bet also carries a `choice` question with options
   `exact` and `close`; the pick's `match` is the more probable option. Observable: the envelope leg's
   `pick.match`; `Family asks` (a bet naming a whole family) still returns `close` plus the family as `related`.
   Test: canned `fit` answer `exact` 0.9 → `match: "exact"`; `close` 0.7 → `match: "close"`.
3. **Below the threshold, `none` — never a guess.** A pick below `JEV_MARKET_THRESHOLD`, a `none` choice, or a
   ref the menu does not carry yields `{ match: "none" }`, and the leg renders today's no-market message
   (`execute.ts:216`, `noPickReason`). Observable: the envelope leg has no `pick.label` and its `unavailable.kind`
   is `no-market`. Test: canned pick at threshold − 0.01 → `none`; canned `none` → `none`; canned ref 999 → `none`.
4. **A named outcome comes back verbatim.** When the bet names one of the picked item's listed outcomes
   (`MenuItem.outcomes`, `live-menu-types.ts:43`), the pick carries `outcomeLabel` equal to that listed string;
   an outcome string that is not in the picked item's list is dropped (today's check, `resolve-market.ts:58`).
   Observable: the Andorra `correct score` leg resolves with `outcomeLabel: "3-2"` and `select` binds that
   outcome. Test: canned outcome `3-2` on `Correct Score` → `outcomeLabel: "3-2"`; canned outcome `9-9` → no
   `outcomeLabel`. How (plan's call): outcomes as expanded options of the pick question, or one `outcome`
   question per bet over the union of the menu's listed outcomes — either way inside the one request.
5. **Related markets from their own question.** Each bet's `related` is the top three options of its `next`
   question by probability, excluding the picked ref, as menu labels (`MarketPick.related`,
   `live-menu-types.ts:59`, at most 3). The runner-up probabilities of the `pick` question are never used for
   this. Observable: a single-leg query shows up to three `additional` markets; a multi-leg query shows one per
   leg, which is what `execute`'s existing round-robin budget of 3 (`execute.ts:291`) already produces from
   per-leg lists. Test: canned `next` answer with probabilities → `related` = the three highest labels, pick
   excluded.
6. **One request per query.** All bets of one query, across every menu group the orchestrator builds
   (`resolve.ts:268–307`), go in one Jev request: the `state` carries the union of the groups' menus (deduped by
   label) and each bet's question lists only its own group's refs. `main` legs and unidentified-subject legs
   skip the call as today (`resolve.ts:296–298`); a query with no named-market leg makes no request.
   Observable: the envelope's `cost.calls` has exactly one `stage: "market"` row for the Baltimore query (four
   groups today, four rows); the probe trace shows one `[llm pick]`. Test: two bets with two different menus
   through `resolveMarkets` → exactly one `fetch` call, and each bet's pick is a label from its own menu.
7. **Jev not answering means `none`, not an error.** On HTTP 429 or 529 the transport retries once
   (`jev-call.ts:55–61`); after a second failure, any other non-2xx, a network error, a timeout or a malformed
   body, every bet of the request is `{ match: "none" }` and the query still answers. Not a manual session:
   proven by the unit test with stubbed `fetch` sequences (429 → 200 settles; 529 → 529 → all `none`; thrown
   `fetch` → all `none`), and the caller sees no rejection.
8. **Qwen is gone from the stage.** `resolve-market.ts` imports nothing from `bedrock-call.ts`; `INPUT_SCHEMA`
   (line 22), `callModel` (line 82) and `picksByLeg` (line 96, with its test at `invariants.test.ts:387`) are
   removed; `resolve-market-prompt.md` holds the Jev question text. A missing `JEV_ACCESS_KEY` fails the query
   with an error naming the variable (`jev-call.ts:48`), as a missing AWS key does for the extractor. Observable:
   every probe trace shows `[llm pick]` only with the Jev model id, never `BEDROCK_MODEL`. Test: key unset →
   `resolveMarkets` rejects with an error mentioning `JEV_ACCESS_KEY` and stubbed `fetch` records zero calls;
   the remaining invariants and `npm run gate:live-menu` stay green.
9. **The deploy knows the key.** `render.yaml` declares `JEV_ACCESS_KEY` (`sync: false`) beside the AWS keys
   (`render.yaml:15–23`), and `.env.example` documents `JEV_MARKET_THRESHOLD`. Observable: a Render blueprint
   deploy prompts for the Jev key and a market query answers. Test: an invariant that every `JEV_*` /
   `BEDROCK_*` / `AWS_*` name read in `src/` (`process.env.X` or `envNumber("X")`) appears in `.env.example`, and
   the four secrets plus `JEV_ACCESS_KEY` appear in `render.yaml`.
10. **Cost and trace rows are real.** The one request emits one `llm-req` and one `llm-resp` (`trace.ts:8–9`,
    tool `pick`) and one usage row priced from `JEV_PRICE_IN` (`jev-call.ts:67`), so `cost.calls` shows
    `stage: "market"` with Jev's token counts and no `pick` row priced from `BEDROCK_PRICE_*`. Observable: the
    probe's `✔ done` line and the envelope's `cost` block. Test: after a stubbed request, `usageStore` holds one
    row with `tool: "pick"` and `priceIn` set.
11. **The replay table, pasted.** Before the threshold default is fixed, one Jev replay (no Bedrock) runs over:
    the 7 captured bets with their captured menus; the 3 gate cells against the snapshot menu
    (`src/eval/live-menu.snapshot.json`); and at least one built-to-fail case per family — wrong direction,
    plain winner beside a handicap twin, a sub-part twin (1st half / group) — whose right answer is `none` or
    the twin. The table (phrase, menu size, Jev pick, its probability, the `fit` probabilities, Qwen's captured
    answer where one exists, right/wrong) is pasted in the pull request body or, with no pull request, under
    `## Decisions` here, with the chosen `JEV_MARKET_THRESHOLD` default. Every right pick sits at or above the
    default; every wrong or should-be-`none` case sits below it. Review checks the paste and the gap.
12. **The gate holds on Jev.** `npm run eval`'s market-resolution gate (`market-resolve-gate.ts`, code
    unchanged, comments updated) passes on Jev at least as many of its 3 cells as one Qwen run of the gate
    alone before the switch; both counts are pasted with criterion 11.
13. **One live comparison, pasted.** One paid probe of a multi-leg query on live fixtures (the Baltimore or
    Andorra text, or a current equivalent with ≥3 legs across ≥2 groups), run with an explicit OK: the pull
    request body (or Decisions here) pastes the `[llm pick]` line (model, milliseconds, tokens, cost) and the
    `market` stage row. The picks equal the picks Qwen made for the same bets or are `none`; the request
    finishes within 1,500 ms; and its cost divided by the number of bets is at or below $0.0003.

## Affected surfaces

- `src/resolver/resolve-market.ts` — `callModel`, `INPUT_SCHEMA`, `picksByLeg` and the `bedrockToolCall` import
  go; a `NEW` Jev decider becomes the default. `toPick` (line 54) is unchanged. `resolveMarkets` takes bets with
  their own menus (`DecideManyFn` changes shape, see contracts) or a `NEW` sibling entry point does — plan
  mode's call; `resolveMarket` (line 77) stays for the gates' singular replay.
- `src/resolver/resolve.ts:268–307` — the per-group `pickJobs.push(resolveMarkets(...))` becomes collect-then-one-call
  after the loop; results map back to leg indices as today (line 306).
- `src/resolver/resolve-market-prompt.md` — rewritten as Jev question text: the same rules (`exact`/`close`/
  `none`, Twins, Plain winner, Margin, Variants, Grain, Ladders vs bands, Sub-unit winner, Context, Outcomes,
  Family asks), stated positively and briefly, with no sport-specific market name. A new model-facing prompt:
  shown in full in the plan before it is written (the **Human-gated resolver code** rule).
- `src/resolver/jev-call.ts:1–2` — header no longer says "the entity gate and nothing else"; no code change
  expected (the `choice` type, `Reply` shape, retry and pricing are reused as they are).
- `src/resolver/bedrock-call.ts:1–3` — header: one Bedrock step (extract).
- `src/eval/market-resolve-gate.ts:13,117` — comments: needs `JEV_ACCESS_KEY`, not AWS creds.
- `.env.example` — header line 1 and the Jev block (line 15): `NEW` `JEV_MARKET_THRESHOLD=<default from the
  replay>`. `render.yaml:15–23` — `NEW` `JEV_ACCESS_KEY` (`sync: false`), `JEV_MODEL` optional.
- `AGENTS.md:148` ("Bedrock … for the extractor and market calls"; "Jev for the entity gate"),
  `.claude/skills/resolver-pipeline/SKILL.md` (lines 33–36, the stage 9 row at 49, lines 111–113),
  `.claude/skills/eval/SKILL.md:22`, `.claude/skills/probe/SKILL.md:65–66` — updated in the same change to say
  the market stage is Jev and only the extractor is Bedrock (the skills-and-documents rule in AGENTS.md).
  `docs/GETTING-STARTED.md` and `docs/PROMPTING.md` do not describe the market stage; no change.
- `src/resolver/invariants.test.ts` — tests for criteria 1–10 with a stubbed global `fetch`; the `picksByLeg`
  test (line 387) removed with the function.

## Policy constraints

- **code-conventions, Human-gated resolver code.** `resolve-market.ts`, `resolve.ts` and the rulebook are shipped
  resolver code and a prompt: the plan is approved (`/plan-spec`) before edits, and the rewritten question text
  is shown in full, old → new, in the plan before it exists.
- **code-conventions, Sport-agnostic prompts.** The rewritten rules name no sport, team or market; the two
  sport-flavoured illustrations in today's text ("Total Runs by <team>", "Group …") become generic
  ("<statistic> by <team>", "a sub-part of the competition or match").
- **code-conventions, Never branch on phrasing.** Commit, `none`, `exact`/`close` and `related` key on returned
  probabilities and enumerated menu refs, never on the query text or a label's words.
- **code-conventions, the smallest-diff rule.** One decider replacing one, the dead schema and leg-binding helper
  deleted, one orchestrator change from N calls to one, env and comment lines, tests. No change to menu building
  (`buildMenu`, `recall.ts:221`), `filterBySubject`, `select`, `execute`, or `MarketPick`.
- **code-conventions, Never drop a row on missing data.** No bet is dropped: every bet gets a pick or `none`; a
  menu item is never removed to fit a question (a menu over 255 options is a plan-mode fact to handle, see
  Decisions).
- **code-conventions, Ask before paid runs.** Criteria 11, 12 and 13 are paid (Jev replay: pennies; one Qwen run
  of the gate: about a cent; one live probe) and each runs once, with an explicit OK, its output saved and
  pasted. Everything else is offline with stubbed `fetch`.
- **code-conventions, Fix at the right layer.** A wrong pick found in the replay is fixed in the question text or
  the threshold, never by reshaping the extractor's `market_concept` or `betPhrase` (out of scope).
- **code-conventions, Fold diacritics on both sides.** Not applicable: refs are indices; the outcome check is
  verbatim against the menu's own strings, as today.
- **resolver-pipeline, the stage contract and market identity.** Stage 9 keeps `phrases + filtered menu → one
  MarketPick per phrase`; the pick's `label` stays the `marketLabelOf` string so menu, pick and `offersForPick`
  stay in lockstep; `resolveMarkets` may always return `none`; the model id stays env-driven (`JEV_MODEL`).
- **resolver-pipeline, precision bias.** Abstain over wrong: the threshold and the `none` option implement it;
  a transport failure degrades to `none`, never to a guess.
- **eval, the market gate.** It stays the ship gate for market-type resolution and stays paid (now Jev
  pennies); `--from` replays skip it as today (`run.ts:372`). The gold set is unchanged; its 3 `id` cells are
  thin, and growing them is a separate intent.
- **probe, read the trace.** The Jev request emits the same `llm-req` / `llm-resp` events, so `npm run probe`
  shows `[llm pick]` with the Jev model id; `--until=recall` still stops before it.
- `catalog` was not read: no catalog or grounding change.

## Data / API contracts

- **Jev request** (`jevChoice("pick", state, questions)`): `state = { query, rules, menu: [{ ref, label,
  outcomes? }], bets: [{ leg, phrase, refs }] }` — `rules` is the text of `resolve-market-prompt.md`, sent ONCE;
  `menu` is the union of the groups' filtered menus deduped by label, `refs` the indices each bet may pick from.
  `questions`: per bet `b`, `pick:b` (`choice`, criteria = that bet's refs as `"<ref>": label` plus `none`),
  `fit:b` (`choice`, criteria `exact` / `close`), `next:b` (`choice`, that bet's refs), and the outcome answer per
  criterion 4. Each question's `instructions` is a one-line template in code naming the bet (its leg, its phrase
  with the `(for <name>)` grain hint from `betPhrase`, `resolve.ts:53`) and pointing at `state.rules`. Only
  `choice` questions are used.
- **Reply** (`Reply`, `jev-call.ts:32`): `answers[key] = { choice, probabilities }`; `usage.input_tokens`.
- **`RawPick`** (`resolve-market.ts:45`) and **`MarketPick`** (`live-menu-types.ts:55`) unchanged.
- **`DecideManyFn`** becomes `(bets: { phrase: string; menu: Menu }[], query?: string) => Promise<RawPick[]>`
  (or a `NEW` sibling type if `resolveMarkets` keeps its shared-menu signature); `live-menu-gate.ts:80–92`
  adapts its replay decider accordingly. **`DecideFn`** (singular) unchanged.
- **Env:** `JEV_MARKET_THRESHOLD` (`NEW`; default recorded under Decisions after the replay); `JEV_ACCESS_KEY`,
  `JEV_MODEL`, `JEV_PRICE_IN` as today.

## Test plan

- **Unit, criteria 1–10** (`src/resolver/invariants.test.ts`, stubbed global `fetch`, no network, no model):
  Andorra bets → the three Qwen picks (1); `fit` 0.9/0.7 → exact/close (2); below threshold, `none`, bad ref →
  `none` (3); outcome `3-2` kept, `9-9` dropped (4); `next` top-3 minus pick (5); two menus → one `fetch`, picks
  from own menus (6); 429→200, 529→529, thrown `fetch` (7); key unset rejects naming `JEV_ACCESS_KEY` (8); env
  names ⊆ `.env.example`, secrets ⊆ `render.yaml` (9); one usage row `tool: "pick"` with `priceIn` (10). Canned
  answers use the 2026-09-21 Qwen picks as expected labels.
- **Type check:** `npm run typecheck`. **Existing gates:** `npm test`, `npm run gate:live-menu` (its replay
  deciders adapted, behaviour unchanged).
- **Paid, each once, with an OK:** (a) Qwen baseline `npx tsx src/eval/market-resolve-gate.ts` before the
  switch; (b) the Jev replay for criterion 11 from a scratchpad script over the captured traces and the
  snapshot; (c) `npm run eval` after the switch — extractor gate and entity gate unchanged, market gate on Jev
  (12); (d) `npm run probe -- "<multi-leg query>" --out <trace>` for criterion 13. Outputs pasted per criteria
  11–13.
- **By hand:** `POST /query` on `npm run serve` with a two-group query; read `cost.calls` (one `market` row) and
  the legs' `pick.match` / `pick.label` / `additional`.

## Out of scope

- The extractor on Jev; any change to `extractor-prompt-v2.md`, `market_concept` wording or `betPhrase`.
- Menu building and filtering (`recall.ts`, `filter.ts`), `select`, `execute`, `MarketPick`'s shape.
- Growing the gold set's `id` cells (the market gate stays at 3 cells; a separate intent).
- Slimming the entity stage's request (candidates serialised twice) — the disambiguator's own follow-up.
- Vercel AI Gateway, Cloudflare, or any new npm dependency; a `boolean` or `score` Jev question type.

## Decisions

- 2026-09-22 — The intent counts 29 captured `pick` requests; the repository and the session scratchpads hold
  6 (Andorra 2, Baltimore 4; 7 bets) — the 2026-09-10 traces are gone. The replay set is those 7 bets, the 3
  gate cells against the snapshot, and built-to-fail cases written against the snapshot menu; more captures need
  a paid probe batch and an OK. The intent's number is corrected with a Decisions line there. Decided by:
  engineer (factual).
- 2026-09-22 — The market gate grades 3 gold `id` cells (all in `gold.seed.jsonl`; the corpus has none), so
  "at or above today's pass rate" is a 3-cell comparison, taken with one paid Qwen run of the gate before the
  switch. Growing the gold set is a separate intent. Decided by: engineer (factual).
- 2026-09-22 — When Jev cannot answer (timeout, two throttles, network error, malformed body) every bet of the
  request is `none` and the query still answers with today's no-market message; the query does not fail. The
  product owner chose this over failing the query, accepting that the message can mislead when the market
  does exist. Decided by: product owner.
- 2026-09-22 — `exact` / `close` comes from a two-option `choice` question per bet; the label is the more
  probable option. No `boolean` question type, no second threshold: the replay table (criterion 11) shows the
  `fit` probabilities, and the plan adds an env boundary only if Qwen's captured `close` cases straddle 0.5.
  Decided by: engineer. Product owner to confirm.
- 2026-09-22 — Related markets come from a dedicated `next` question per bet, never from the `pick` question's
  runner-up probabilities (measured ~0 on 2026-09-21: a calibrated pick puts nothing on markets that do not
  settle the bet, and in a close call the runner-up is the competing twin). `execute`'s existing round-robin
  budget of 3 gives three for a single-leg query and one per leg otherwise. Decided by: engineer (factual).
- 2026-09-22 — Only the `choice` question type is used (pick, fit, next, outcome), so `JevQuestion`, `Reply`
  and `jevChoice` are reused unchanged. Decided by: engineer (factual).
- 2026-09-22 — The intent's "cost at or below $0.0003 per call" is read per bet: one request now carries every
  bet of the query (Baltimore measured $0.00054 for 4 bets, $0.000135 per bet). Decided by: engineer (factual).
- 2026-09-22 — A menu whose options would exceed Jev's 255-per-question cap (the snapshot's fullest menu is 101
  labels, 184 outcome-expanded; a live trace showed 244) is a plan-mode fact: the plan states what the decider
  does at the cap (outcomes as their own question is the intent's suggestion) and never drops a menu item
  silently. Decided by: engineer (factual).
- 2026-09-22 — `render.yaml` declares no Jev variable although the entity stage already needs one; with this
  change every market query needs it, so the key is added here rather than in a separate intent. Decided by:
  engineer (factual).
- 2026-09-22 — `JEV_MARKET_THRESHOLD`'s default is set from the replay table and recorded here, not chosen up
  front (the intent's constraint). Decided by: engineer. Product owner to confirm.
- 2026-09-22 — Written on the integration branch `sdlc-jev` at the product owner's instruction, as the
  disambiguator's spec was; accepted in the chat by the product owner on 2026-09-22, who also acts as engineer and tester on this initiative, so there is no spec pull request with reader boxes. Decided by: product owner.
- 2026-09-22 — Contract amended by the plan: the rulebook goes ONCE in `state.rules`, and each question's
  `instructions` is a one-line template in code (bet leg, phrase, pointer to the rules). The earlier wording
  repeated the ~1.2k-token rulebook in every question, 4× per bet; the 2026-09-21 measurement the intent rests
  on used rules-in-state. Decided by: engineer (factual).
- 2026-09-22 — Criterion 12 baseline, Qwen, one run of `npx tsx src/eval/market-resolve-gate.ts` before the
  switch: `Market-resolve gate (live resolve vs captured snapshot 2026-06-22): 3/3`. Decided by: engineer (factual).
- 2026-09-22 — Criterion 11, the Jev replay (one run, 5 requests, 76,552 input tokens ≈ $0.003, no Bedrock): 16 of 17
  cases as expected. Right picks sit at 0.90–1.00; the raw picks of the wrong / should-be-`none` cases at 0.30–0.62
  (Jev itself chose `none` at 0.56 for the absent 2nd-half twin; the threshold caught `Group Finishing Position —
  Winner` at 0.62 for "finish bottom of the group"). `JEV_MARKET_THRESHOLD` stays at its default **0.8**, inside the
  0.62–0.90 gap. The one miss is an abstain, not a wrong pick: "win by 2 or more (for Turkey)" split its mass
  between the `Handicap` and `Asian Handicap` twins (top 0.30) and fell to `none` — accepted as the safe side of
  the threshold. The fit question agreed with Qwen on every committed pick (min exact 0.67 on "3+ Strikeouts",
  where Qwen also hedged). Decided by: engineer. Product owner to confirm.

  | group | phrase | menu | pick | p(pick) | exact/close | outcome | expected (Qwen) | ok |
  |---|---|---|---|---|---|---|---|---|
  | group | phrase | menu | pick | p(pick) | exact/close | outcome | expected (Qwen) | ok |
  |---|---|---|---|---|---|---|---|---|
  | andorra to win its first game and BTTS a | who wins (for Andorra) | 28 | Full Time | 0.97 | 0.92/0.08 → exact | 1 | Full Time (Full Time exact) | ✓ |
  | andorra to win its first game and BTTS a | both teams to score | 36 | Both Teams To Score | 1.00 | 1.00/0.00 → exact | — | Both Teams To Score (Both Teams To Score exact) | ✓ |
  | andorra to win its first game and BTTS a | correct score | 36 | Correct Score | 1.00 | 0.99/0.01 → exact | 3-2 | Correct Score (Correct Score exact) | ✓ |
  | baltimore to win and Kazuma to score a H | to win (for Baltimore) | 48 | Moneyline | 1.00 | 0.99/0.01 → exact | — | Moneyline (Moneyline close) | ✓ |
  | baltimore to win and Kazuma to score a H | to score a HR (for Kazuma) | 19 | Player to Hit a Home Run… | 1.00 | 0.99/0.01 → exact | — | Player to Hit a Home Run… (Player to Hit a Home Run… exact) | ✓ |
  | baltimore to win and Kazuma to score a H | strikeouts (for Shane Bazz) | 6 | 3+ Strikeouts… | 0.90 | 0.67/0.33 → exact | — | 3+ Strikeouts… (3+ Strikeouts… exact) | ✓ |
  | baltimore to win and Kazuma to score a H | total runs | 51 | Total Runs | 0.99 | 0.89/0.11 → exact | — | Total Runs (Total Runs exact) | ✓ |
  | gate cells (snapshot match) | both teams to score | 101 | Both Teams To Score | 1.00 | 1.00/0.00 → exact | — | Both Teams To Score | ✓ |
  | gate cells (snapshot match) | BTTS | 101 | Both Teams To Score | 0.99 | 1.00/0.00 → exact | — | Both Teams To Score | ✓ |
  | gate cells (snapshot match) | draw | 101 | Full Time | 0.98 | 0.97/0.03 → exact | Draw | Full Time | Draw No Bet | ✓ |
  | gate cells (snapshot match) | draw no bet | 101 | Draw No Bet | 0.98 | 0.99/0.01 → exact | — | Full Time | Draw No Bet | ✓ |
  | look-alikes (snapshot match) | who wins (for USA) | 101 | Full Time | 1.00 | 0.99/0.01 → exact | 1 | Full Time | ✓ |
  | look-alikes (snapshot match) | first half total goals over 1.5 | 101 | Total Goals - 1st Half | 0.90 | 0.86/0.14 → exact | — | Total Goals - 1st Half | ✓ |
  | look-alikes (snapshot match) | win the 2nd half to nil (for Turkey) | 101 | none | 0.56 | 0.45/0.55 → none | — | none | ✓ |
  | look-alikes (snapshot match) | win by 2 or more (for Turkey) | 101 | none (raw Asian Handicap) | 0.30 | 0.25/0.75 → none | — | Handicap | Asian Handicap | ✗ |
  | wrong direction (snapshot competition) | finish bottom of the group (for Turkey) | 39 | none (raw Group Finishing Position — Winner) | 0.62 | 0.65/0.35 → none | — | none | ✓ |

- 2026-09-22 — The replay surfaced a latent wrong-side path: for "who wins (for Andorra)" the outcome question
  returned the result market's side code `"1"`, which `toPick` accepted (it is listed) and `select.ts:234` would
  bind to the HOME side over the grounded subject. Qwen's prompt suppressed the outcome on a plain win; the fix
  recorded on 2026-09-10 (`toPick` refuses the side codes `"1"`/`"2"`, `Draw` stays) lived on the `snipe` branch
  and never reached `sdlc-jev`. Applied here in `resolve-market.ts` with a test; criterion 4 reads "verbatim from
  the listed outcomes" and side codes are placeholders `buildMenu` adds, not outcomes a bet can name. Decided by:
  engineer (factual).
