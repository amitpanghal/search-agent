# Spec: Jev settles the disambiguator's entity cells

- **Intent:** ./intent.md
- **Date:** 2026-09-22
- **Status:** accepted

## Summary

`resolveEntities` (`src/resolver/resolve-entities.ts:362`) keeps its shape and its injectable decider
(`DecideFn`, line 63; `runPass`, line 297; `validPick`, line 271). Its default decider becomes a Jev-backed
one and the Bedrock decider is deleted: one `choice` question per doubtful cell, candidates as the options plus
`none`, sent in a single request to TypeSafe's REST endpoint through a `NEW` transport `src/resolver/jev-call.ts`
that mirrors `bedrock-call.ts` (trace `emit`, usage into `usageStore`). A Jev pick is accepted only when its
top probability reaches a threshold; every other cell — below threshold, `none`, no candidates, or a Jev
failure — becomes a clarify through today's `clarifyFor` (line 283), with no Bedrock call anywhere in the
stage. The Bedrock decider (`decide`, line 246), its prompt `disambiguator-prompt.md` and the `reexpress`
action it alone produced are removed. Cost rows carry Jev's real token counts at Jev's price.

## Acceptance criteria

1. **Jev settles a confident cell.** A query whose grounding leaves a doubtful cell (tier `ambiguous`, `shortlist` or `none`, `SENT_TIERS`, `resolve-entities.ts:41`) produces
   one Jev request for all such cells, and a cell whose top option probability is at or above the threshold
   settles on that candidate exactly as a Bedrock `pick` does today (`settleOutcome`, line 275, via
   `validPick`). Observable: the probe trace shows `[llm settle_cells]` with a `jev-` model id, and the
   `entities` stage row shows the cell `confident` on the picked id. Test: stubbed `fetch` returning the
   recorded 2026-09-21 answers for the "Saka" cell (Bukayo Saka 0.97) → the settled leg carries id
   1005184672.
2. **Below the threshold, a clarify — never a Bedrock call.** A cell whose Jev top probability is below the
   threshold, or whose Jev choice is `none`, or that arrives with no candidates, is asked back to the user
   through today's `clarifyFor` (`resolve-entities.ts:283`): the same question wording and the same capped
   `suggest` list as an undecided cell gets today. `bedrockToolCall` is never invoked from this stage. Observable: the Tottenham replay (five clones plus the trotting horse; Jev 0.75) ends in one
   clarification naming the five own rows; the probe trace shows one Jev row and no Bedrock row for
   `settle_cells`. Test: stubbed Jev answer at 0.75 → one clarification with 5 distinct `suggest` ids, zero
   Bedrock calls (spy on the Bedrock decider).
3. **Qwen is gone from the stage.** `src/resolver/disambiguator-prompt.md` no longer exists, `resolve-entities.ts`
   imports nothing from `bedrock-call.ts`, and a `Decision` has one action, `pick`. Observable: every probe
   trace shows `[llm settle_cells]` only with the Jev model id, never with `BEDROCK_MODEL`; a missing
   `JEV_ACCESS_KEY` fails the query with an error naming the variable, the way a missing AWS key does today
   (`bedrock-call.ts:17`). Test: with the key unset, `resolveEntities` on a doubtful cell rejects with an
   error mentioning `JEV_ACCESS_KEY` and a stubbed `fetch` records zero calls; the 33 existing invariants and
   `npm run gate:live-menu` stay green.
4. **A Jev failure never fails the query.** On HTTP 429 or 529 the transport retries once after a backoff; on
   a second failure, any other non-2xx status, a network error or a malformed body, every cell of the
   request becomes a clarify as in criterion 2, and no error reaches the caller. Not a manual session: proven
   by the unit test with stubbed `fetch` sequences (429 then 200 → settled by Jev; 529 then 529 → all cells
   clarify; thrown `fetch` → all cells clarify).
5. **Cost and trace rows are real.** For every Jev request one `llm-req` and one `llm-resp` trace event are
   emitted (`trace.ts:8–9`, `tool: "settle_cells"`, model = the Jev model id) and one usage row lands in
   `usageStore` (`cost.ts:19`), so the envelope's `cost.calls` shows `stage: "entities"` with Jev's
   `usage.input_tokens` / `usage.output_tokens` and `cost = inputTokens × JEV_PRICE_IN / 1e6` (`NEW` env,
   USD per 1M input tokens; Jev output is free). Observable: the probe's `✔ done` line and the envelope's
   `cost` block. Test: `summarizeCost` on a row carrying a Jev price yields that cost; the Bedrock rows are
   priced as today.
6. **One live comparison, pasted in the pull request.** One paid probe on a query
   whose grounding trips the disambiguator (the captured "winner Premier League" fires a 5-candidate
   competition cell), run with an explicit OK: the pull request body pastes the `[llm settle_cells]` line
   (model, milliseconds, tokens) and the `entities` stage row, and the settled id equals the Bedrock answer
   recorded for that cell on 2026-09-10 (Premier League (England), id 1000094985) or the cell clarifies.
   Review checks the paste is present and the id matches.

## Affected surfaces

- `NEW` `src/resolver/jev-call.ts` — the transport: `POST https://api.typesafe.ai/v1/systemone`, bearer
  `JEV_ACCESS_KEY`, body `{ model, state, questions }`, one retry with backoff on 429/529, `emit` +
  `usageStore` like `bedrock-call.ts:24–68`.
- `src/resolver/resolve-entities.ts` — the Bedrock decider `decide` (line 246), `DECIDE_SCHEMA` and the
  `bedrockToolCall` import are replaced by a `NEW` Jev decider as the default `DecideFn`. The `reexpress`
  variant of `Decision` (line 48) and its branch in `runPass` (lines 305–311) are removed; `Cell.reground`
  (line 59) goes with them if nothing else uses it (plan mode decides). An undecided cell already clarifies
  in `runPass` (line 315), so `clarifyFor`, `settleOutcome`, `adoptSport` are unchanged.
- `src/resolver/disambiguator-prompt.md` — deleted.
- `.claude/skills/resolver-pipeline/SKILL.md` (stage 4 row and the prompts list, lines 40 and 107) and
  `AGENTS.md` ("the three prompts" in Code style and Layout) — updated to name Jev and two prompts, in the
  same change (the skills-and-documents rule in AGENTS.md).
  The Jev question's `instructions` text is a new model-facing prompt: shown in full before it is written
  (the **Human-gated resolver code** rule) and kept sport-agnostic.
- `src/resolver/cost.ts` — `RawCall` gains a `NEW` optional per-call price so a Jev row is priced from
  `JEV_PRICE_IN` and Bedrock rows keep `BEDROCK_PRICE_*`.
- `.env.example` — `NEW` lines `JEV_ACCESS_KEY=`, `JEV_MODEL=jev-latest`, `JEV_ENTITY_THRESHOLD=0.8`,
  `JEV_PRICE_IN=0.042`; the comment on `BEDROCK_MODEL_SETTLE_CELLS` in `bedrock-call.ts:31` drops that stage.
- `src/resolver/invariants.test.ts` — the tests for criteria 1–5 with a stubbed global `fetch` and canned
  Jev answers recorded on 2026-09-21.

## Policy constraints

- **code-conventions, Human-gated resolver code.** `resolve-entities.ts` and `cost.ts` are shipped resolver
  code and the Jev `instructions` string is a prompt: the plan is approved (`/plan-spec`) before edits, and
  the instructions text is shown in full in the plan before it exists.
- **code-conventions, Sport-agnostic prompts.** The Jev instructions state the general rule (pick the
  candidate the query means; `none` when nothing fits or two fit equally) and name no sport, team or market.
- **code-conventions, Never branch on phrasing.** The commit/fallback decision keys on the returned
  probability and the enumerated candidate keys, never on the query text or a candidate's name.
- **code-conventions, the smallest-diff rule.** One transport file, one decider replacing one, the dead
  prompt and action deleted, one optional field on `RawCall`, env lines, tests. No change to grounding, widening, caps, `clarifyFor` wording or
  `SettledEntities`.
- **code-conventions, Never drop a row on missing data.** No cell is ever dropped: a cell Jev cannot settle
  is asked back to the user, never silently guessed or discarded.
- **code-conventions, Ask before paid runs.** Criterion 6 is one paid probe (one Bedrock extract call plus
  one Jev call) and runs only with an explicit OK; everything else is offline with stubbed `fetch`.
- **code-conventions, Fold diacritics on both sides.** Not applicable: candidates are keyed by id.
- **resolver-pipeline, the stage contract and precision bias.** `resolveEntities` keeps
  `ResolvedScope → SettledEntities` and its injectable `DecideFn`; "abstain over wrong" is preserved by the
  threshold and the clarify; the model id stays env-driven (`JEV_MODEL`), never hard-coded.
- **eval, the entity gate.** The deterministic entity gate grades grounding, which this change does not touch,
  so it stays at 100% by construction; run it for free with `npm run eval -- --from <capture>` rather than a
  paid full run. No gold row changes.
- **probe, read the trace.** Jev calls emit the same `llm-req` / `llm-resp` events as Bedrock so
  `npm run probe` shows them as `[llm settle_cells]` rows with the Jev model id; captured cells are the
  offline fixtures.
- `catalog` was not read: no catalog or grounding change.

## Data / API contracts

- **Jev request** (`jev-call.ts`, `NEW`): `{ model: JEV_MODEL, state: { query, cells: [{ ref, text,
  candidates: [{ id, name }] }] }, questions: { [ref]: { type: "choice", instructions, criteria:
  { [id]: name, none: "…" } } } }`. **Response:** `answers[ref] = { type: "choice", choice, probabilities,
  confidence }`, `usage: { input_tokens, output_tokens }`. Only `choice`, `probabilities[choice]` and
  `usage` are read.
- **`Decision`** shrinks to `{ ref, action: "pick", id }`; `DecideFn` keeps its signature so tests can
  inject a decider.
- **`RawCall`** (`cost.ts:9`): `NEW` optional `priceIn?: number; priceOut?: number` (USD per 1M tokens);
  when present they price the row, else `BEDROCK_PRICE_*` as today.
- **Env:** `JEV_ACCESS_KEY` (required at call time); `JEV_MODEL` (default `jev-latest`);
  `JEV_ENTITY_THRESHOLD` (default `0.8`); `JEV_PRICE_IN` (default `0.042`).

## Test plan

- **Unit, criteria 1–5** (`src/resolver/invariants.test.ts`, stubbed global `fetch`, no network, no model):
  Saka cell at 0.97 → settled id 1005184672 (1); Tottenham cell at 0.75 → one clarify with 5 distinct
  `suggest`, zero Bedrock calls (2); key unset → rejects naming `JEV_ACCESS_KEY`, zero `fetch` calls (3);
  429→200 settles,
  529→529 and a thrown `fetch` both clarify (4); `summarizeCost` prices a `priceIn` row from the
  row and a plain row from `BEDROCK_PRICE_*` (5). The canned answers are the 2026-09-21 replay values.
- **Type check:** `npm run typecheck`. **Existing gates:** `npm test`, `npm run gate:live-menu`.
- **Free entity gate:** `npm run eval -- --from <existing capture>` — the deterministic entity gate reports
  unchanged.
- **By hand, paid, with an OK (criterion 6):** `npm run probe -- "winner Premier League"
  --until=entities --out <trace>` — read the `[llm settle_cells]` row (model, ms, tokens) and the `entities`
  stage row; paste both in the pull request body.

## Out of scope

- The market resolver and the extractor on Jev; the one-request union-menu design measured on 2026-09-21.
- Any prompt change to `extractor-prompt-v2.md` or `resolve-market-prompt.md`.
- Changes to how candidate lists are built (the dedupe intent), to clarify wording, or to `SettledEntities`.
- Vercel AI Gateway, Cloudflare, or any new npm dependency.

## Decisions

- 2026-09-22 — The commit threshold is `JEV_ENTITY_THRESHOLD`, default `0.8`, compared against the
  probability of the chosen option. On the four cells replayed on 2026-09-21 the three correct picks were
  0.97, 1.00 and 0.99 and the wrong one 0.75; 0.8 still separates them, with a margin of 0.05 below. It is an
  env value so it can move without a code change. The engineer proposed 0.9; the product owner set 0.8.
  Decided by: product owner.
- 2026-09-22 — Below the threshold the cell becomes a clarify, not a Bedrock call: the product owner wants
  the stage completely Jev-driven when the switch is on. The `reexpress` rescue is given up in that mode (the
  one captured rewrite, "Spurs" → "Tottenham Hotspur", did not rescue its cell either). Intent constraint
  amended the same day. Decided by: product owner.
- 2026-09-22 — No switch: Qwen is removed from the disambiguator stage entirely, with its prompt and the
  `reexpress` action; there is no Bedrock path left to fall back to. Intent amended the same day. Decided
  by: product owner.
- 2026-09-22 — The Jev model id and price are env values like `BEDROCK_MODEL` and `BEDROCK_PRICE_*`; a missing
  `JEV_ACCESS_KEY` is a configuration error and fails the query with a named error, as a missing AWS key does
  today. Decided by: engineer (factual).
- 2026-09-22 — Cells with no candidates never reach Jev (a `choice` question with only `none` has nothing to
  choose); they clarify directly. Decided by: engineer (factual).
- 2026-09-22 — Accepted in the chat by the product owner, who also acts as engineer and tester on this
  initiative; committed directly on the integration branch `sdlc-jev` at their instruction, so there is no spec
  pull request with reader boxes for this feature. Decided by: product owner.
