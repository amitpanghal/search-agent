# AGENTS.md

The always-loaded instruction set for every agent session (`CLAUDE.md` is `@AGENTS.md`, so Claude Code
and any other tool that reads `AGENTS.md` share it). Short rules here; the detail lives in the skills.

## What this is

search-agent turns one free-text betting question ("Arsenal to win and over 2.5 goals tonight") into a
concrete set of priced bet offers from Kambi's live offering feed. One HTTP endpoint (`POST /query`,
Server-Sent Events), one pipeline, no database.

The hard part is not the HTTP. It is that the **market** a user means ("both teams to score", "draw no
bet", "top scorer") only exists as a label inside the live feed, and that feed changes daily. So the
resolver never guesses a market up front: it fetches by **entity** (team / player / competition), then
decides the market against the menu that actually came back.

## Setup commands

- Install: `npm install` (Node ≥ 20; copy `.env.example` to `.env` and fill in the Bedrock credentials and
  `JEV_ACCESS_KEY`)
- Run tests (CI and agents): `npm test`
- Type check: `npm run typecheck`
- Lint: none — the type check is the bar
- Offline pipeline gate: `npm run gate:live-menu`

Agents run all of these before declaring a step done. A red result is a stop, not a note. Every other
command that touches a model or the feed costs money — see the table below and **Ask before paid runs**
in `code-conventions`.

## Commands, cheapest first

| Command | Costs | What it checks |
|---|---|---|
| `npm run typecheck` | free | types only (`tsc --noEmit`) |
| `npm test` | free | the deterministic invariants (`src/resolver/*.test.ts`, node's test runner via tsx) |
| `npm run gate:live-menu` | free | replays filter→select→execute against a captured menu snapshot — no network, no LLM |
| `npm run ai:eval:config` | your Claude sign-in | the agent CONFIG (this file + `.claude/**`): golden prompts replayed headlessly |
| `npm run serve` | per request | the real server on `POST /query` |
| `npm run probe -- "query"` | **money** | one query through the live pipeline + full trace (see the probe skill) |
| `npm run eval` | **money** | the extractor gold set, 1× each. This is the ship gate |
| `npm run eval -- --from cap.jsonl` | free | re-score extractions already captured by probe — no model calls |
| `npm run eval -- --release` | **money ×5** | 5× each, for reproducibility. Ask first — rarely needed |
| `npm run catalogs` | free (feed only) | rebuilds every sport's entity catalog into `catalogData/` |
| `npm run sweep` | free (feed only) | per-sport offering fact sheets into `.sweep/` (gitignored) |

The free ones are the loop to use while iterating. Reach for a paid one only when the question is
genuinely about model behaviour.

## Git & PRs

- **The integration branch is `sdlc-jev`** for the SDLC + Jev initiative, until that branch itself
  merges to `main`. Wherever the loop skills, `intent/README.md` or the guides say `main` or
  `origin/main`, read `sdlc-jev` / `origin/sdlc-jev`: feature branches are cut from `origin/sdlc-jev`
  after `git fetch`, every pull request targets `sdlc-jev`, and nobody edits `sdlc-jev` directly. When
  the initiative lands, one pull request `sdlc-jev` → `main` carries it all, and this line and the
  `branches:` filter in `.github/workflows/artifact-status.yml` go back to `main`.
- One feature, one branch, one worktree. Two implementations never share a working tree.
- **A branch already used by another worktree.** Git lets a branch be checked out in one worktree at a
  time, and a session's worktree under `.claude/worktrees/` keeps its branch after the session ends. When
  a step must continue on a branch another session made and `git switch` is refused with
  `fatal: '<branch>' is already used by worktree at <path>`: do not move to that worktree, do not remove
  it, do not ask. Cut a local branch under another name from the remote and work here,
  `git switch -c <step>/<slug> origin/<branch>`; push every commit onto the real branch with
  `git push origin HEAD:<branch>`. Tell the person in one line that this happened.
- Agents never run `git commit` unless the human asked for it in this turn.

## Feature artifacts & the development loop

- Feature work is tracked as version-controlled artifacts in `intent/<ticket>-<slug>/` (or
  `intent/<slug>/` when there is no ticket): `intent.md`
  (why — via `/intent`) → `spec.md` (what, with acceptance criteria + policy constraints — via `/spec`)
  → `plan.md` (how — via `/plan-spec`, which commits the approved plan before any code) → code (via
  `/build-plan`, one plan step per commit, then PASS/FAIL per criterion). The tester fills the spec's
  Test plan with `/spec-testplan`. See `intent/README.md`. Small changes may skip the chain.
- The full loop: signal (probe trace, eval regression, sweep finding, user report) → `/intent` → `/spec`
  → `/plan-spec` → `/build-plan` → PR review against `REVIEW.md` (Pass 3 checks the diff against the
  spec's acceptance criteria when the PR body links the intent dir) → recurring findings become
  `Skill gap:` lines → captured via the **skill-maintenance** skill → config changes to `AGENTS.md` /
  `.claude/**` are gated by `npm run ai:eval:config`. The CI stages (automatic review, config-evals in
  CI, maintain loop) are not switched on yet; until they are, `/build-plan verify` and a local
  `/code-review` are the review.
- `planning/` is **legacy**: design notes and decisions from before the loop, live plans mixed with
  rejected ones (vector embeddings, doc-view enrichment, a cross-encoder reranker, the static market
  catalog were all built and dropped). Read it for history, check git or ask before implementing anything
  from it, and start new work in `intent/`. `planning/limitations.md` is still the list of what the
  resolver deliberately does not handle — check it before calling something a bug.
- The playbook is the source of truth for the loop:
  https://claude.com/blog/the-ai-native-sdlc-playbook

## Project skills

Reusable, codebase-specific know-how lives as skills in `.claude/skills/`. Consult the relevant skill
before working in its area:

- **code-conventions** — the house rules the compiler does not catch: paid runs, the human gate on
  resolver code, fixing at the right layer, never branching on phrasing, sport-agnostic prompts, lenient
  filters, diacritics. The spec cites these; the review checks against them.
- **resolver-pipeline** — the stage map: all stages, which file owns which, the shared types, the
  invariants. Read it **before** editing anything in `src/resolver`.
- **probe** — how to run one query through the live pipeline and read the per-stage trace. This is the
  debugging tool, and a paid one.
- **eval** — the ship gate: running and reading `npm run eval`, editing the gold set, the free `--from`
  replay.
- **catalog** — building the per-sport entity catalogs, `sports.ts` overrides, aliases.
- **skill-maintenance** — when and how to propose or update skills. Whenever a review comment, a repeated
  correction, or a discovered gap reveals a reusable convention not yet captured in a skill, follow it.

Also read before touching the feed: `docs/OFFERING_API.md` and `docs/BetOffer.md` (the Kambi feed:
endpoints, and what a bet offer looks like; public, no auth).

**The documents describe the skills.** A pull request that changes a skill under `.claude/skills/` also
updates `README.md`, `docs/GETTING-STARTED.md` and `docs/PROMPTING.md` wherever they describe that skill,
in the same pull request. A skill change that leaves the documents behind makes them lie.

**Self-improving skills (always-on).** The rule `.claude/rules/skill-self-improvement/RULE.md` is loaded
every session. It makes the agent *propose* a new or improved skill whenever a reusable gap or a wrong
skill surfaces — and never write a `SKILL.md`/`RULE.md` without explicit approval. `skill-maintenance`
is the procedure it points to, and a turn-end hook (`.claude/hooks/skill-gap-reminder.sh`) nudges the
same reflection.

## Rules

One line each; the full rule, why, and how it is checked are in `code-conventions`. Cite them by name.

1. **Ask before paid runs.** Every `probe` / `eval` run hits Bedrock and Kambi for real money. Get an
   explicit OK first, keep it to one targeted run, reuse the saved trace (`--out run.jsonl`) instead of
   re-running, never loop paid calls. `--until=extract|ground|entities|recall` stops before the next paid
   call.
2. **Human-gated resolver code.** For any change to a pipeline stage, a prompt, the schema, or the
   grounder: explain the plan in plain English with a worked example, then **stop and ask** before
   editing. Prompt edits need the exact old→new diff shown first. Tests, scripts and docs need no gate.
3. **Fix at the right layer.** Before changing the extractor or a prompt, check what the extractor already
   returns — if the facts are there, the bug is downstream. Reshaping the extractor to fix a downstream
   problem breaks working extractions.
4. **Never branch on phrasing.** The same intent arrives in a hundred surface forms. Move the decision to
   where the facts are concrete and enumerable, and test the fix on a reworded variant.
5. **Sport-agnostic prompts.** Per-sport market names and idioms belong in the scope-alias files
   (`catalogData/<sport>-scope-aliases.json`), never hard-coded into a prompt rule.

## Code style

- Language: TypeScript, `strict` + `noUncheckedIndexedAccess`, ES2022 modules (`"type": "module"`), run
  with `tsx`; Node ≥ 20 (`engines`). Use `fileURLToPath(import.meta.url)`, never `__dirname`.
- Composition: `src/resolver/` is the pipeline, one file per stage plus the two prompts (`.md`) and
  shared types; `src/server/` is a thin Hono app (transport only); `src/eval/` the gold set, scorer and
  gates; `scripts/` the probe and catalog builders.
- Data: `zod` for every model-facing schema; `@aws-sdk/client-bedrock-runtime` Converse with forced tool
  use for the extractor and market calls (`bedrock-call.ts`); plain `fetch` to TypeSafe's Jev for the entity
  gate (`jev-call.ts`) and for the Kambi feed (`offering-client.ts`).
  No database, no ORM.
- Every source file opens with a comment explaining **why** it is the way it is. Those headers are the
  real documentation — read the file top before changing it.
- Dates and time: the feed ignores `from`/`to`, so all date and kickoff filtering is client-side in
  `time-window.ts`, read in the **user's** timezone with instants kept in UTC.

## Testing

- Runner: node's built-in test runner via tsx (`npm test`), files colocated as `src/resolver/*.test.ts`.
  They guard the deterministic invariants — above all that no filter ever drops a row on missing data.
- Free gates first: `npm run typecheck`, `npm test`, `npm run gate:live-menu`. Paid gates (`npm run eval`,
  `npm run probe`) only with an OK, and their saved traces are reused rather than re-run.
- A change a person can observe is verified by hand before it is declared done: a probe trace
  (`npm run probe -- "query"`) or a `POST /query` against `npm run serve`, read stage by stage. A passing
  unit test is not proof the answer is right.

## Observability

No error tracker yet. The signals are the per-query `cost` block in the response envelope (`cost.ts`),
probe traces (`--out`), and the eval reports. The maintain loop stays off until a tracker exists.

## Layout

```
src/resolver/     the pipeline — one file per stage, plus the two prompts (.md) and shared types
src/eval/         gold set + structural scorer + the two gates
src/server/       Hono app, POST /query as SSE. Thin: transport only
scripts/          probe.ts (debugging) and the catalog/feed builders
catalogData/      per-sport entity catalogs (scope-index = generated, scope-aliases = curated by hand)
docs/             the Kambi feed reference + the loop's guides (GETTING-STARTED, PROMPTING)
intent/           the feature artifact chain (intent → spec → plan), one folder per feature
planning/         legacy design docs and decisions (see the warning above)
queries/          plain-text query lists for batch probes
eval/config/      golden prompts for the agent-config regression harness
```

## Gotchas

- **Two extractor prompts existed.** Only `extractor-prompt-v2.md` is live (`extract.ts` loads it, or
  whatever `EXTRACTOR_PROMPT` points at). Some older comments still say `extractor-prompt.md`.
- **The extract cache is keyed by the query alone, not the prompt.** After any prompt or schema edit you
  must recapture, or you are grading stale output.
- **Time is client-side.** A missing `tz` falls back to UTC and changes answers.
- **Never drop a row on missing data.** Every filter is deliberately lenient — over-keeping is safe,
  over-dropping loses the right answer. `npm test` guards this.
- **Diacritics.** The feed stores accents inconsistently; fold both sides of any name match with `fold()`.
- **Bedrock has no backoff here.** `bedrock-call.ts` makes one call; a throttle kills the query. Run paid
  batches one process per query.

## Setup

Copy `.env.example` to `.env` and fill in the AWS Bedrock credentials and the Jev key (`JEV_ACCESS_KEY`).
Node ≥ 20. Deploys to Render via
`render.yaml`. Catalogs are refreshed locally with `npm run catalogs` and committed — the feed API sits
behind a proxy, so CI can't reach it.
