# Plan: Jev settles the disambiguator's entity cells

- **Intent:** ./intent.md
- **Spec:** ./spec.md (Status: accepted, 2026-09-22)
- **Date:** 2026-09-22
- **Branch:** `feature/jev-disambiguator`, cut from `origin/sdlc-jev` (the integration branch, AGENTS.md)

## Context

The entity gate (`resolveEntities`, `src/resolver/resolve-entities.ts:364`) sends every doubtful cell to one
Qwen call on Bedrock (`decide`, line 246: system prompt `disambiguator-prompt.md`, forced tool
`settle_cells`, zod schema `DecideOut`) and gets back `pick` or `reexpress` per cell; an undecided cell
clarifies deterministically in `runPass` (line 315). The spec replaces that one call with one Jev request
(TypeSafe `POST https://api.typesafe.ai/v1/systemone`, a `choice` question per cell), commits a pick only when
`probabilities[choice] >= JEV_ENTITY_THRESHOLD` (default 0.8), and turns everything else into today's
clarify. Qwen, its prompt and `reexpress` leave the stage entirely (spec Decisions, product owner).

What the code already gives us, so nothing new is invented:
- `DecideFn` (line 63) is injectable and `runPass` already treats a missing decision as a clarify, so the Jev
  decider only has to return the picks it trusts; `validPick` (line 271) keeps guarding ids.
- `bedrock-call.ts:36,53,60` shows the exact `emit` + `usageStore` pattern the transport mirrors, and
  `cost.ts:22` already maps `settle_cells` → stage `entities`, so a Jev row with `tool: "settle_cells"` lands
  in the right row of the envelope for free.
- `Cell.reground` (line 59), the `ground` closures (`buildEntityCell` param, `rg`/`settled`/`constrainTo` in
  `buildEntityCells`, lines 201–213) and `groundRegion` exist only to serve `reexpress`: nothing else in the
  repo references them (grep), so they go with it, as the spec's "plan mode decides" line allows.

The Jev contract and the test fixtures are the ones recorded in the 2026-09-21 replay (session transcript,
script `jev()` → `fetch(..., { headers: { Authorization: "Bearer <key>" }, body: { model, state, questions } })`,
reply read as `answers[ref].choice`, `.probabilities`, `.confidence`, `usage.input_tokens`):

| Cell | Query | Candidates (id: name) | Jev answer |
|---|---|---|---|
| `subject:0` "Saka" | "Saka" | 1005184672: Bukayo Saka, 1030173441: Mathis Saka | choice `"1005184672"`, confidence 0.97, probabilities `{ "1005184672": 0.98, "none": 0.02, "1030173441": 0.00 }`, 697 ms, input_tokens 460 |
| `competition:0` "Premier League" | "winner Premier League" | 1000094985: Premier League (England), 1000171537: (Ukraine), 1000251645: (Armenia), + Egypt, Kazakhstan | choice `"1000094985"`, probability 1.00, 294 ms, 649 tok |
| `team:0` "Tottenham Hotspur" | "Arsenal to win and Tottenham Hotspur to win" | 5 esports clones + 1003385961: Tottenham (trotting) | choice `"1003385961"`, confidence 0.70, probabilities `{ "1003385961": 0.75, "none": 0.19, "1008202005": 0.03 }`, 314 ms, 787 tok |

Two cosmetic facts, no amendment needed: the spec's line numbers drift by 2–3 (`clarifyFor` is line 285,
`resolveEntities` 364, `Decision` 45), and the Saka criterion quotes 0.97, which is the reply's `confidence`;
the chosen option's probability the threshold reads was 0.98. Both values clear 0.8; the stub replays the
recorded reply verbatim.

**One line beyond the spec's enumerated failures, flagged for approval:** the transport passes
`signal: AbortSignal.timeout(3000)` to `fetch`. Without it a stalled connection hangs the whole query, which is
worse than every failure criterion 4 lists; with it, a stall is a network error and clarifies like the rest.
Strike it if unwanted.

## The Jev instructions (a new model-facing prompt — the Human-gated resolver code rule)

Per cell, with `<kind>` = the cell's slot word from its ref (`region`, `competition`, `team`, `player`,
`subject`) and `<text>` = the cell's text, exactly as measured on 2026-09-21 (changing the wording would make
the replay results meaningless):

```
Which candidate is the <kind> the query means by "<text>"? Judge by meaning, not string overlap. Answer none if no candidate fits or two candidates fit equally.
```

`criteria` = `{ "<id>": "<name>", …, "none": "None of these is what the query means" }`.
`state` = `{ query, cells: [{ ref, text, candidates: [{ id, name }] }] }` (the spec's contract; the same
payload `userMessage` builds today, so the raw query and every cell stay visible to the model).

It names no sport, team or market (the Sport-agnostic prompts rule); the decision keys on the returned
probability and the enumerated ids, never on the query text (the Never branch on phrasing rule). The raw
slot word `subject` is kept because that is what scored 0.98; renaming it to `player` is an unmeasured tweak
for a later intent.

## Steps

1. **Per-row price on `RawCall`, red then green, one commit.**
   - `src/resolver/invariants.test.ts`: add `test("cost: a row carrying its own price is priced from the row; a
     plain row from BEDROCK_PRICE_*", …)`: set `process.env.BEDROCK_PRICE_IN="3"`, `_OUT="15"` (restore
     after); `summarizeCost([{ tool: "settle_cells", inputTokens: 460, outputTokens: 0, priceIn: 0.042,
     priceOut: 0 }, { tool: "pick", inputTokens: 0, outputTokens: 1_000_000 }])` → `calls[0].stage ===
     "entities"`, `calls[0].cost` ≈ `460 * 0.042 / 1e6`, `calls[1].cost === 15`. Red: `priceIn` is not a
     field (type error) and the cost comes out as `460 * 3 / 1e6`.
   - `src/resolver/cost.ts`: `RawCall` gains `priceIn?: number; priceOut?: number` (USD per 1M tokens);
     `costOf` takes the row and uses `c.priceIn ?? BEDROCK_PRICE_IN`, `c.priceOut ?? BEDROCK_PRICE_OUT`.
     Header comment: "Every Bedrock call funnels through bedrock-call.ts" → "Every model call funnels through
     bedrock-call.ts or jev-call.ts". Extend the self-check block with one priced row.
   - Files: `src/resolver/cost.ts`, `src/resolver/invariants.test.ts`. Commit: `build: step 1 — per-row
     price on RawCall`.

2. **The transport, the Jev decider, the deletions, and their tests — red then green, one commit.**
   This is the gated step (the Human-gated resolver code rule): the plan is the approval; the instructions
   text above is the prompt shown in full.
   - **Tests first**, in `src/resolver/invariants.test.ts` after the existing entity-gate tests (line 508).
     Every test stubs the global fetch with Node's own mock, `t.mock.method(globalThis, "fetch", impl)`,
     which restores itself when the test ends; replies are `new Response(JSON.stringify(body), { status,
     headers })`; each test sets `process.env.JEV_ACCESS_KEY = "test"` and restores the previous value.
     `npm test` loads no `.env`, so any stray Bedrock call throws on the missing AWS key — that is the
     "zero Bedrock calls" proof. Red before the code: the default decider still calls Bedrock and throws.
     - `"entity gate: Jev settles confident cells in one request, with real trace and cost rows"` (criteria
       1, 5). Hand-built scope like the "lamine" test (line 450): `sport: "football"`, one leg with
       `subjectPlayer` = the Saka cell (tier `shortlist`, the two recorded candidates) and `competition` =
       the Premier League cell (tier `ambiguous`, the three recorded ids); query `"Saka winner Premier League
       football"` (names the sport, so no cross-sport widening: offline-cheap). Stub replies the recorded
       answers for `subject:0` and `competition:0`, `usage: { input_tokens: 1109, output_tokens: 0 }`. Run
       inside `traceStore.run([], …)` and `usageStore.run(rows, …)`. Assert: fetch called once; the request
       body has `model: "jev-latest"`, `questions["subject:0"].type === "choice"`, criteria keys
       `["1005184672","1030173441","none"]`; the leg's `subjectPlayer` is `confident` with id 1005184672 and
       `competition` confident with id 1000094985; no clarification; the trace holds exactly one `llm-req`
       and one `llm-resp` with `tool: "settle_cells"` and `model: "jev-latest"`; `rows` holds one
       `{ tool: "settle_cells", inputTokens: 1109, outputTokens: 0, priceIn: 0.042, priceOut: 0 }`.
     - `"entity gate: a Jev pick below the threshold clarifies, never a Bedrock call"` (criterion 2). Reuse
       the Tottenham plan of the test at line 472 (`groundScope(plan)`, widening fires). Stub the recorded
       0.75 reply for `team:0`. Assert: one clarification, `suggest` length 5 and 5 distinct ids, the leg's
       team not confident, fetch called once.
     - `"entity gate: a cell with no candidates clarifies without a Jev request"` (criterion 2, the empty
       case; spec Decision 5). Scope with one `none`-tier team cell, no candidates, query naming the sport.
       Assert: one clarification whose question starts `We couldn't identify`, fetch called zero times.
     - `"entity gate: a missing JEV_ACCESS_KEY fails the query by name and makes no request"` (criterion 3).
       `delete process.env.JEV_ACCESS_KEY`; Saka scope; `assert.rejects(resolveEntities(…), /JEV_ACCESS_KEY/)`;
       fetch called zero times.
     - `"entity gate: Jev failures retry once on 429/529 and otherwise clarify"` (criterion 4). One test, four
       stub sequences on the Saka scope: `[429 with Retry-After: 0, 200 recorded]` → settled, 2 calls;
       `[529, 529]` → clarify, 2 calls; `fetch` throws → clarify, 1 call; `[200 with body "not json"]` →
       clarify, 1 call. Each sequence also checks the trace has one `llm-resp` for the request.
   - **`NEW src/resolver/jev-call.ts`** — header comment says why (second transport, no text output, own key,
     own retry). Exports `jevChoice(toolName, state, questions): Promise<{ answers, usage } | null>`:
     - throws `Error("JEV_ACCESS_KEY must be set (see jev-call.ts header).")` when the key is unset — the
       one error that escapes, mirroring `bedrock-call.ts:17`;
     - `model = process.env.JEV_MODEL || "jev-latest"`; `emit({ kind: "llm-req", tool, model, system:
       <the instructions of the first question>, user: JSON.stringify(state), schema: questions })`;
     - `fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer
       ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, state, questions }),
       signal: AbortSignal.timeout(3000) })`; on status 429 or 529 wait `Retry-After` seconds if the header
       is present, else 500 ms, then one more attempt;
     - parse the body with a small zod schema (AGENTS.md: zod for every model-facing schema):
       `z.object({ answers: z.record(z.string(), z.object({ choice: z.string(), probabilities:
       z.record(z.string(), z.number()) })), usage: z.object({ input_tokens: z.number(), output_tokens:
       z.number().optional() }).optional() })` — lenient on what it does not read;
     - on success push `{ tool, inputTokens, outputTokens: output_tokens ?? 0, priceIn:
       Number(process.env.JEV_PRICE_IN ?? 0.042), priceOut: 0 }` to `usageStore` and `emit` `llm-resp` with
       the parsed output and the tokens; on any failure after the retry (non-2xx, thrown fetch, timeout,
       unparseable body) `emit` `llm-resp` with `output: { error: <message> }`, zero tokens, and return
       `null`. No exception classes, no logger: the probe trace is where a failure shows.
   - **`src/resolver/resolve-entities.ts`**:
     - drop the imports `readFileSync`, `fileURLToPath`, `dirname`, `join`, `z`, `bedrockToolCall`,
       `groundRegion`, `constrainTo`; add `import { jevChoice } from "./jev-call"`; drop `HERE`;
     - `Decision` becomes `{ ref: CellRef; action: "pick"; id: number }`; `Cell` loses `reground`;
       `buildEntityCell` loses its `ground` parameter and the `reground` field; `buildEntityCells` loses the
       `settled`/`rg` closures and passes no grounder (lines 201–213 shrink to the five `add` calls);
     - delete `zPick`, `zReexpress`, `DecisionItem`, `DecideOut`, `toInputSchema`, `DECIDE_SCHEMA`,
       `cachedPrompt`, `systemPrompt`, `userMessage`, `decide`; keep `TOOL_NAME = "settle_cells"`;
     - add `INSTRUCTIONS(kind, text)` (the string above) and `NONE = "None of these is what the query
       means"`, and `export async function decideWithJev(query, cells): Promise<Decision[]>`: cells with
       candidates → `questions[ref] = { type: "choice", instructions: INSTRUCTIONS(ref.split(":")[0], text),
       criteria: { ...Object.fromEntries(candidates.map((c) => [String(c.id), c.name])), none: NONE } }`;
       if no such cell, return `[]` without a request; `state = { query, cells: [...] }`; `const res =
       await jevChoice(TOOL_NAME, state, questions); if (!res) return [];` then per answer: skip `choice ===
       "none"`, skip when `probabilities[choice] < Number(process.env.JEV_ENTITY_THRESHOLD ?? 0.8)`, else
       `{ ref, action: "pick", id: Number(choice) }`;
     - `runPass`: remove the reexpress branch (lines 306–314) — pick-or-clarify;
     - `resolveEntities(…, decideFn: DecideFn = decideWithJev)`;
     - rewrite the header comment (lines 1–19: Jev, no reexpress, threshold, clarify) and the comment at
       lines 39–40 (a `none` cell has no candidates and clarifies directly, unless widening found rows).
   - Delete `src/resolver/disambiguator-prompt.md`.
   - `src/resolver/bedrock-call.ts`: line 2 "The three prod LLM steps (extract, resolve-entities,
     resolve-market)" → "The two Bedrock steps (extract, resolve-market); the entity gate goes through
     jev-call.ts"; line 31 drops `_SETTLE_CELLS`.
   - `.env.example`: append
     ```
     # TypeSafe Jev settles the entity gate (resolve-entities.ts via jev-call.ts). Key from console.typesafe.ai.
     JEV_ACCESS_KEY=
     JEV_MODEL=jev-latest
     # Commit a pick only when its probability reaches this; below it the user is asked (default 0.8).
     JEV_ENTITY_THRESHOLD=0.8
     # USD per 1M input tokens; Jev output is free.
     JEV_PRICE_IN=0.042
     ```
     and the first comment line gains "and the Jev key".
   - Run `npm test` → green, 39 tests; `npm run typecheck`; `npm run gate:live-menu`.
   - Files: `src/resolver/jev-call.ts` (new), `src/resolver/resolve-entities.ts`,
     `src/resolver/disambiguator-prompt.md` (deleted), `src/resolver/bedrock-call.ts`, `.env.example`,
     `src/resolver/invariants.test.ts`. Commit: `build: step 2 — Jev settles the entity cells`.

3. **The documents and the skill name Jev, one commit** (the skills-and-documents rule in AGENTS.md).
   - `AGENTS.md`: Code style line 143 and Layout line 172 "the three prompts" → "the two prompts"; the Data
     line adds "plain `fetch` to TypeSafe's Jev for the entity gate (`jev-call.ts`)"; Setup lines ("fill in
     the Bedrock credentials") add "and `JEV_ACCESS_KEY`".
   - `.claude/skills/resolver-pipeline/SKILL.md`: the LLM sentence above the table (lines 32–34) adds
     "stage 4 is the exception: one Jev `choice` request via `jev-call.ts`, model `JEV_MODEL`"; row 4 becomes
     `resolve-entities.ts` + `jev-call.ts` | Jev | `ResolvedScope` → `SettledEntities` (ONE request: a pick
     above `JEV_ENTITY_THRESHOLD` per cell; everything else clarifies deterministically); the Files list
     (line 107) drops `disambiguator-prompt.md` and adds `jev-call.ts`; add `metadata:\n  version: "1.1"` to
     the frontmatter (the skill has none; every body change ships with a bump — skill-maintenance).
   - `docs/GETTING-STARTED.md` and `docs/PROMPTING.md` do not describe the prompt list or stage 4 (grep), so
     they do not change; there is no `README.md`.
   - Gate: `npm run ai:eval:config` (the agent-config regression, on the Claude sign-in — not a Bedrock spend).
   - Files: `AGENTS.md`, `.claude/skills/resolver-pipeline/SKILL.md`. Commit: `build: step 3 — docs and skill
     name Jev`.

4. **Checks, the one paid probe, the pull request paste — no commit.**
   - Run every check below.
   - `npm run eval -- --from <an existing capture in scripts/.trace-out or the eval capture dir>` — free; the
     deterministic entity gate must read unchanged (it never calls `resolveEntities`: grep of `src/eval`).
   - Criterion 6, only after an explicit OK in the chat (the Ask before paid runs rule): `npm run probe --
     "winner Premier League" --until=entities --out scripts/.trace-out/jev-pl.jsonl`. One Bedrock extract
     call plus one Jev call. Paste into the pull request body the `[llm entities]` line (ms, tokens; model
     from the `llm-req` row at `--log full`) and the `entities` stage row; the settled competition id must be
     1000094985 or the cell must clarify.
   - Open the pull request against `sdlc-jev`, body linking `intent/jev-disambiguator/`.

## Criteria to proof

| Criterion | Files that change | Test that proves it |
|---|---|---|
| 1 — Jev settles a confident cell, one request for all cells | `jev-call.ts`, `resolve-entities.ts` | `invariants.test.ts` → "Jev settles confident cells in one request…": Saka → 1005184672, Premier League → 1000094985, fetch called once |
| 2 — below threshold / `none` / no candidates → today's clarify, no Bedrock | `resolve-entities.ts` | "a Jev pick below the threshold clarifies…" (Tottenham 0.75 → 1 clarify, 5 distinct `suggest`) and "a cell with no candidates clarifies without a Jev request" (0 fetch calls); no AWS env in `npm test`, so a Bedrock call would throw |
| 3 — Qwen gone: no prompt file, no `bedrock-call` import, `Decision` = `pick`; missing key fails by name | `resolve-entities.ts`, `disambiguator-prompt.md` (deleted), `bedrock-call.ts` | "a missing JEV_ACCESS_KEY fails the query by name…" (rejects, 0 fetch calls); the file facts are checked in review by `grep -n bedrock-call src/resolver/resolve-entities.ts` (empty) and `ls src/resolver/disambiguator-prompt.md` (gone); `npm test` 39 green, `npm run gate:live-menu` green |
| 4 — retry once on 429/529; every other failure → clarify, no error to the caller | `jev-call.ts` | "Jev failures retry once on 429/529 and otherwise clarify": 429→200 settles (2 calls), 529→529 clarifies (2 calls), thrown fetch clarifies (1 call), bad body clarifies (1 call) |
| 5 — one `llm-req` + one `llm-resp` per request; one `usageStore` row priced `inputTokens × JEV_PRICE_IN / 1e6` | `jev-call.ts`, `cost.ts` | the trace and `rows` asserts inside the criterion-1 test, plus "cost: a row carrying its own price…" (`summarizeCost`, Bedrock row still priced from `BEDROCK_PRICE_*`) |
| 6 — one live comparison pasted in the PR | pull request body | no automated test — by design a paid probe with an OK (step 4); review checks the paste is present and the id is 1000094985 or the cell clarified |

Criteria 1–5 have a test. Criterion 6 is evidence in the pull request by design (spec Test plan).

## Checks

- `npm test` — 39 tests (33 + step 1's cost test + 5), no `.env`, no network
- `npm run typecheck`
- `npm run gate:live-menu`
- `npm run eval -- --from <existing capture>` — free replay; entity gate unchanged
- `npm run ai:eval:config` — after step 3 (AGENTS.md and a skill changed)
- Paid, once, with an explicit OK: `npm run probe -- "winner Premier League" --until=entities --out …`
  (criterion 6); reuse the saved trace, never re-run
- Review greps: `grep -rn "reexpress\|reground\|disambiguator-prompt\|bedrockToolCall" src/resolver/resolve-entities.ts`
  → empty; `git diff sdlc-jev --stat` shows only the files the steps name

## Decisions

- 2026-09-22 — Test count corrected from 38 to 39: the plan's "33 + 5" left out the cost test step 1 adds, so
  the total after step 2 is 33 + 1 + 5. Found while building step 2; fixed here in the same commit. Decided
  by: engineer (factual).
- 2026-09-22 — Step 4's pull request replaced by a direct merge into `sdlc-jev` at the product owner's
  instruction, after the code review (`/code-review high`, 7 findings). Findings 1–5 and 7 fixed in the
  review-fixes commit: `JEV_ENTITY_THRESHOLD` and `JEV_PRICE_IN` parsed through `envNumber` (blank, non-numeric
  or out-of-range → default, never 0/NaN), Retry-After capped at 2 s, the throttled reply's body cancelled
  before the retry, the trace `system` field carries every cell's instructions, and one test pins the inclusive
  threshold, the env override and the fallbacks (40 tests). Finding 6 — candidates serialised twice per cell
  (`state` and `criteria`, ~half the stage's Jev tokens) — is the spec's prescribed shape and stays as a
  follow-up measurement. Live probes of 2026-09-22 (criterion 6): Premier League → 1000094985 at 1.00, 662 ms;
  Tottenham horse 0.50 → clarify; bad key → HTTP 401 → clarify; missing key → named error. Decided by: product
  owner (route), engineer (fixes).
