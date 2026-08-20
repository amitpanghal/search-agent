# search-agent

Turns one free-text betting question ("Arsenal to win and over 2.5 goals tonight") into a concrete set of
priced bet offers from Kambi's live offering feed. One HTTP endpoint (`POST /query`, Server-Sent Events),
one pipeline, no database.

The hard part is not the HTTP. It is that the **market** a user means ("both teams to score", "draw no bet",
"top scorer") only exists as a label inside the live feed, and that feed changes daily. So the resolver never
guesses a market up front: it fetches by **entity** (team / player / competition), then decides the market
against the menu that actually came back.

## Read this first

- **`.claude/skills/resolver-pipeline`** — the stage map: all 11 stages, which file owns which, the shared
  types, and the invariants. Read it **before** editing anything in `src/resolver`.
- **`.claude/skills/probe`** — how to run one query through the live pipeline and read the per-stage trace.
  This is the debugging tool.
- **`.claude/skills/eval`** — the ship gate: running/reading `npm run eval`, editing the gold set, and the
  free `--from` replay.
- **`.claude/skills/catalog`** — building the per-sport entity catalogs, `sports.ts` overrides, aliases.
- **`planning/limitations.md`** — what the resolver deliberately does not handle yet. Check here before
  calling something a bug.
- **`docs/OFFERING_API.md`**, **`docs/BetOffer.md`** — the Kambi feed: endpoints, and what a bet offer looks
  like. No auth needed; it is a public feed.

## Commands, cheapest first

| Command | Costs | What it checks |
|---|---|---|
| `npm run typecheck` | free | types only (`tsc --noEmit`) |
| `npm test` | free | the deterministic invariants (`src/resolver/*.test.ts`, node's test runner via tsx) |
| `npm run gate:live-menu` | free | replays filter→select→execute against a captured menu snapshot — no network, no LLM |
| `npm run serve` | per request | the real server on `POST /query` |
| `npm run probe -- "query"` | **money** | one query through the live pipeline + full trace (see the probe skill) |
| `npm run eval` | **money** | the extractor gold set, 1× each. This is the ship gate |
| `npm run eval -- --from cap.jsonl` | free | re-score extractions already captured by probe — no model calls |
| `npm run eval -- --release` | **money ×5** | 5× each, for reproducibility. Ask first — rarely needed |
| `npm run catalogs` | free (feed only) | rebuilds every sport's entity catalog into `catalogData/` |
| `npm run sweep` | free (feed only) | per-sport offering fact sheets into `.sweep/` (gitignored) |

The three free ones are the loop to use while iterating. Reach for a paid one only when the question is
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

## Layout

```
src/resolver/     the pipeline — one file per stage, plus the three prompts (.md) and shared types
src/eval/         gold set + structural scorer + the two gates
src/server/       Hono app, POST /query as SSE. Thin: transport only
scripts/          probe.ts (debugging) and the catalog/feed builders
catalogData/      per-sport entity catalogs (scope-index = generated, scope-aliases = curated by hand)
docs/             the Kambi feed reference
planning/         design docs and decisions (see the warning below)
queries/          plain-text query lists for batch probes
```

Every source file opens with a comment explaining **why** it is the way it is. Those headers are the real
documentation — read the file top before changing it.

## Gotchas

- **Two extractor prompts existed.** Only `extractor-prompt-v2.md` is live (`extract.ts` loads it, or whatever
  `EXTRACTOR_PROMPT` points at). Some older comments still say `extractor-prompt.md`.
- **The extract cache is keyed by the query alone, not the prompt.** After any prompt or schema edit you must
  recapture, or you are grading stale output.
- **`planning/` mixes live plans with rejected ones.** Several documented approaches were built and dropped
  (vector embeddings, doc-view enrichment, a cross-encoder reranker, the static market catalog). Do not
  implement a plan from `planning/` without checking git history or asking whether it survived.
- **Time is client-side.** The feed ignores `from`/`to`, so all date and kickoff filtering happens in
  `time-window.ts`. The calendar is read in the **user's** timezone; the instants stay UTC. A missing `tz`
  falls back to UTC and changes answers.
- **Never drop a row on missing data.** Every filter is deliberately lenient — over-keeping is safe,
  over-dropping loses the right answer. `npm test` guards this.
- **Diacritics.** The feed stores accents inconsistently; fold both sides of any name match with `fold()`.

## Setup

Copy `.env.example` to `.env` and fill in the AWS Bedrock credentials. Node ≥ 20. Deploys to Render via
`render.yaml`; a GitHub Action rebuilds the catalogs daily and commits them.
