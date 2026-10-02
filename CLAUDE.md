# search-agent

Turns one free-text betting question ("Arsenal to win and over 2.5 goals tonight") into a concrete set of
priced bet offers from Kambi's live offering feed. One search endpoint (`POST /query`, Server-Sent Events)
plus a click-log endpoint and a health route, one pipeline, no database.

The hard part is not the HTTP. It is that the **market** a user means ("both teams to score", "draw no bet",
"top scorer") only exists as a label inside the live feed, and that feed changes daily. So the resolver never
guesses a market up front: it fetches by **entity** (team / player / competition), then decides the market
against the menu that actually came back.

## Read this first

- **`docs/ARCHITECTURE.md`** and **`docs/adr/`** — the why, one record per component: what each stage does,
  its contract, the decisions behind it, its invariants and limits.
- **`.claude/skills/resolver-pipeline`** — the stage map: the 13 stages in order, which folder and file owns
  which, the shared types, the injection points, and the invariants. Read it **before** editing anything in
  `src/resolver`.
- **`.claude/skills/code-standards`** — how code is written here: files, naming, comments, types, tests,
  formatting. Read it before writing or reviewing code.
- **`.claude/skills/probe`** — how to run one query through the live pipeline and read the per-stage trace.
  This is the debugging tool.
- **`.claude/skills/eval`** — the ship gate: running/reading `npm run eval`, editing the gold set, and the
  free `--from` replay.
- **`.claude/skills/catalog`** — building the per-sport entity catalogs, `sports.ts` overrides, aliases.
- **`planning/limitations.md`** — what the resolver deliberately does not handle yet. Check here before
  calling something a bug.
- **`docs/OFFERING_API.md`**, **`docs/BetOffer.md`** — the Kambi feed: endpoints, and what a bet offer looks
  like. No auth needed; it is a public feed.
- **`docs/DEPLOY-DEV.md`**, **`docs/DEPLOY-PROD.md`** — the deploy runbooks (a container on AWS ECS
  Fargate): dev as built, production as planned.

## Commands, cheapest first

| Command | Costs | What it checks |
|---|---|---|
| `npm run typecheck` | free | types only (`tsc --noEmit`) |
| `npm run lint` | free | Biome lint + format check (`biome.jsonc`); the pre-commit hook runs it on staged files |
| `npm run format` | free | Biome formats `src/` and `scripts/` in place |
| `npm test` | free | the deterministic invariants (`src/*/*.test.ts`, node's test runner via tsx) |
| `npm run gate:live-menu` | free | replays filter→select→execute against a captured menu snapshot — no network, no LLM |
| `npm run serve` | per request | the real server: `POST /query` (SSE), `POST /event` (click log), `GET /` (health) |
| `npm run dev` | per request | the same server, restarting on file changes |
| `npm run probe -- "query"` | **money** | one query through the live pipeline + full trace (see the probe skill) |
| `npm run eval` | **money** | the extractor gold set, 1× each. This is the ship gate |
| `npm run eval -- --from cap.jsonl` | free | re-score extractions already captured by probe — no model calls |
| `npm run eval -- --release` | **money ×5** | 5× each, for reproducibility. Ask first — rarely needed |
| `npm run catalogs` | free (feed only) | rebuilds every sport's entity catalog into `catalogData/` |
| `npm run sweep` | free (feed only) | per-sport offering fact sheets into `.sweep/` (gitignored) |

The free ones are the loop to use while iterating. Reach for a paid one only when the question is
genuinely about model behaviour.

## Rules

1. **Ask before any paid run.** Every `probe` / `eval` run hits Bedrock and Kambi for real money. Get an
   explicit OK first, keep it to one targeted run, and reuse the saved trace (`--out run.jsonl`) instead of
   re-running. Never loop paid calls. `--until=extract|ground|entities|recall` stops before the next paid call.
2. **Shipped resolver code is human-gated.** For any change to a pipeline stage, a prompt, the schema, or the
   grounder: explain the plan in plain English with a worked example, then **stop and ask** before editing.
   Prompt edits need the exact old→new diff shown first. Tests, scripts and docs need no gate.
3. **Fix at the right layer.** Before changing the extractor or a prompt, check what the extractor already
   returns — if the facts are there, the bug is downstream. Reshaping the extractor to fix a downstream
   problem breaks working extractions.
4. **Never branch on the exact phrasing you saw.** The same intent arrives in a hundred surface forms. Move
   the decision to where the facts are concrete and enumerable, and test the fix on a reworded variant.
5. **Prompt rules stay sport-agnostic.** Per-sport market names and idioms belong in the scope-alias files
   (`catalogData/<sport>-scope-aliases.json`), never hard-coded into a prompt rule.

## Errors and logging

- **Never swallow an error.** A `catch` either rethrows, or degrades to an explicit empty or flagged value
  with a one-line comment saying why degrading is safe here (pattern: `failedTask` in `recall.ts`).
- **Log only through `src/server/log.ts`:** one JSON record per query and one per click, to stdout. No
  `console.*` on the request path in `src/resolver` or `src/server`. Allowed: the boot line in
  `src/server/index.ts`, build-time output in `build-scope-index.ts`, and a file's own main-guarded
  self-check. Scripts and eval may print.
- **A failure the user must see goes into the envelope** (`clarificationNeeded`, or the SSE `error` event),
  never only into a log line.

## Layout

```
src/resolver/     the pipeline. resolve.ts is the orchestrator; the stages sit in folders, in pipeline order:
                  extractor/  grounding/ (incl. recall)  market/  result/ (select, combinations, execute);
                  shared/ (types, feed client, lexical, trace)  llm/ (transports, cost)  catalog/ (sport index)
src/eval/         gold decks, scorers, the eval gates (extractor, entity, market) and the free live-menu gate
src/server/       Hono app: POST /query as SSE, POST /event click log, GET / health; log.ts writes the records
scripts/          probe.ts (debugging) and the catalog/feed builders; catalog/ holds the Python normalizer
catalogData/      per-sport entity catalogs (scope-index = generated, scope-aliases = curated by hand)
docs/             ARCHITECTURE.md + adr/ (the why), DEPLOY-DEV/PROD.md (runbooks), OFFERING_API.md + BetOffer.md (the feed)
deploy/           the ECS task definition; the Dockerfile at the root builds the image
.githooks/        the pre-commit hook, wired by npm install; biome.jsonc and .github/dependabot.yml sit at the root
planning/         design docs and decisions (see the warning below)
queries/          plain-text query lists for batch probes
```

Every source file opens with a comment explaining **why** it is the way it is. Those headers are the real
documentation — read the file top before changing it.

## Gotchas

- **Two extractor prompts existed.** Only `extractor-prompt-v2.md` is live (`extract.ts` loads it, or whatever
  `EXTRACTOR_PROMPT` points at). Some older comments still say `extractor-prompt.md`.
- **There is no extraction cache.** Every eval or probe run pays per query. The free replay
  (`npm run eval -- --from cap.jsonl`) grades a capture, so after any prompt or schema edit recapture first, or
  you are grading stale output.
- **`planning/` mixes plans in every state** (shipped, in flight, superseded); what is live is in `docs/adr/`.
  Several approaches documented over time were built and dropped (vector embeddings, doc-view enrichment, a
  cross-encoder reranker, the static market catalog). Do not implement a plan from `planning/` without checking
  `docs/adr/` and git history, or asking.
- **Time is client-side.** The feed ignores `from`/`to`, so all date and kickoff filtering happens in
  `time-window.ts`. The calendar is read in the **user's** timezone; the instants stay UTC. A missing `tz`
  falls back to UTC and changes answers.
- **Never drop a row on missing data.** Every filter is deliberately lenient — over-keeping is safe,
  over-dropping loses the right answer. `npm test` guards this.
- **Diacritics.** The feed stores accents inconsistently; fold both sides of any name match with `fold()`.

## Setup

Copy `.env.example` to `.env`: AWS Bedrock credentials, or an OpenAI key with `LLM_PROVIDER=openai`. Node ≥ 20.
`npm install` also wires the pre-commit hook (`.githooks/`). Deploys as a container on AWS ECS Fargate
(`docs/DEPLOY-DEV.md`, `docs/DEPLOY-PROD.md`); `render.yaml` is the Render POC host. Catalogs are refreshed
locally with `npm run catalogs` and committed: the feed hosts refuse non-browser clients, so the scripts fetch
through Playwright's Chromium (`npx playwright install chromium` once) and CI cannot do it.
