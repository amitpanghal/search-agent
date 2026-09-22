# Prompting the pipeline — stage-by-stage examples and team roles

The [README](../README.md) explains *what* each stage of the loop is. This
guide is the practical companion: **what you actually type**, at which stage,
and **who on the team types it**.

Two ideas underpin every example here:

1. **The artifacts are the contract between stages.** `intent.md`, `spec.md`
   and `plan.md` are files in the repo, so every prompt references them with
   `@intent/<slug>/…` instead of re-explaining the feature from memory. A
   Claude session starts blank; the artifact is how the previous stage's
   decisions reach it — and how the automated reviewer (REVIEW.md Pass 3)
   later checks the diff against the *same* acceptance criteria you built to.
2. **Humans trigger and approve; automation runs and reports.** Stages 1–3
   start with a person typing a command. Stages 4–6 start with a GitHub
   event. Nothing in the loop merges, writes a skill, or accepts a plan
   without a human saying so.

Commands referenced below are current Claude Code built-ins
(`/plan`, `/goal`, `/loop`, `/code-review`, `@file`), verified against the
[Claude Code docs](https://code.claude.com/docs/en/commands) at the time of
writing. The two project commands (`/intent`, `/spec`) are the skills shipped
in this template.

Playbook reference: [The AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook).

---

## At a glance: who triggers what

```mermaid
flowchart LR
    subgraph PO["Product Owner"]
        direction TB
        PO1["/intent<br/>(problem, evidence,<br/>success signal)"]
        PO2["accept spec<br/>(scope, non-goals)"]
        PO6["triage maintain-loop<br/>intent PRs"]
    end
    subgraph ENG["Engineer"]
        direction TB
        E2["/spec<br/>(policy constraints)"]
        E3a["/plan-spec → approve<br/>→ plan.md"]
        E3b["/build-plan step | all<br/>(one commit per plan step)"]
        E5["@claude fix …<br/>merge"]
        E4["skill patch +<br/>golden eval case"]
    end
    subgraph QA["Tester"]
        direction TB
        Q2["testability review<br/>of acceptance criteria"]
        Q3["tests per criterion"]
        Q5["verify criteria on<br/>preview"]
        Q6["band tuning,<br/>success-signal check"]
    end
    subgraph AUTO["Pipeline (GitHub Actions)"]
        direction TB
        A5["claude-review.yml<br/>(REVIEW.md, 3 passes)"]
        A4["config-evals.yml"]
        A6["sentry-maintain-loop.yml"]
    end
    PO1 --> E2 --> PO2 --> E3a --> E3b --> A5 --> E5
    PO2 --> Q2 --> Q3 --> E3b
    A5 --> Q5 --> E5
    A5 -->|"Skill gap:"| E4 --> A4
    E5 -->|merge → prod| A6 --> PO6 --> E2
```

Stages 4–6 run in GitHub Actions only while the repository variable
`CLAUDE_CI` is `true` (README §3). In a fresh project it is unset, so those
rows are silent until the API key is in place; stages 1–3 work regardless.

| Stage | Trigger | Who types it | Where | Human gate |
|---|---|---|---|---|
| 1 · Plan | `/intent …` | Product Owner (Engineer for tech debt) | local Claude Code | intent `Status: accepted` |
| 2 · Design | `/spec intent/<slug>` | Engineer, reviewed by PO + Tester | local | spec accepted; conflicts resolved |
| 3 · Build | `/plan …` → approve → implement | Engineer | local (or `@claude` in CI) | plan approved before any edit |
| 4 · Test config | PR touching `.claude/**` | nobody — CI event | GitHub Actions | eval red blocks merge |
| 5 · Deploy | PR opened / updated | nobody — CI event; `@claude` fixes by Engineer | GitHub Actions | merge is manual |
| 6 · Maintain | daily cron / `workflow_dispatch` | nobody — CI event; triage by PO | GitHub Actions | intent PR reviewed before `/spec` |

---

## Stage 1 · Plan — `/intent`

**Who:** Product Owner. The engineer runs it for technical intents (a
migration, a flaky-test cleanup). Never the pipeline — except the maintain
loop, which writes its own with `Source: maintain-loop`.

**From a user report or ticket:**

```text
/intent Users on mobile report that "Place bet" does nothing after their
session expired — 14 support tickets this week (see ticket #482). Desired
outcome: the tap either succeeds or shows a clear "sign in again" prompt.
Non-goal: changing session length.
```

**From a Jira ticket** (the usual case at Kambi — the skill reads the ticket
and asks only about what it does not say):

```text
/intent SB-12345
```

**From a Sentry issue** (paste the permalink — the skill extracts from it):

```text
/intent https://sentry.io/organizations/<org>/issues/<id>/
```

**From an analytics finding:**

```text
/intent Only 3% of visitors who open the filter panel apply a filter (query:
analytics events "filter_open" vs "filter_apply", last 30 days). Hypothesis:
the Apply button is below the fold on small screens. Success signal:
apply/open ratio above 15% for 14 days after release.
```

The skill interviews you for whatever the template needs and **refuses to
invent a success signal** — if you have none, the file says so, and that is
information for the spec stage.

**Accepting and handing in** (the gate before Stage 2). Two questions, both
in the chat, both answered by the PO:

```text
Do you accept this intent as written?   → yes
Shall I hand it in, so an engineer can merge it?   → yes
```

The first sets `Status: accepted`: the PO accepts their own intent, because
the why is theirs. The second cuts a branch, commits the one file, pushes and
opens the pull request. No git words needed. An engineer then merges it; their
check is only that the file is in place, reads clearly and says accepted. The
PO never touches GitHub and nobody pushes to `main`.

**What the ticket sees.** With a Jira key on the intent, each skill adds two
comments to the ticket, one when the step starts and one at hand-in, all
starting with `Development loop ·`. Comments only; the loop never changes a
ticket's status or description. If the session has no Atlassian connector
the skill says so in one line and continues.

**Changing an accepted intent** (the spec step found the desired outcome
wrong, or a non-goal was crossed). Point the skill at the feature folder:

```text
/intent intent/SB-12345-place-bet-after-expiry
```

The skill reads what is there, asks *"What has changed?"*, changes only those
sections, adds a dated line under the intent's `## Decisions`, and asks the
product owner to accept again. On hand-in it puts the change where the
readers already are: into the open spec pull request if there is one (the
Product owner box then covers both files), otherwise into a small pull
request of its own, `Intent change: <short name>`. Never a second folder; the
spec, the plan and the review keep reading one file. A plan or build in
progress waits for that merge.

---

## Stage 2 · Design — `/spec`

**Who:** Engineer runs it; Product Owner and Tester review the result. This is
the "three amigos" moment: the PO owns scope, the engineer owns constraints,
the tester owns testability.

**Run it against the accepted intent:**

```text
/spec intent/SB-12345-place-bet-after-expiry
```

The skill reads every policy skill whose domain the intent touches and
distills them into the spec's *Policy constraints* section. If a constraint
conflicts with the intent (e.g. the intent wants an external link that policy
says must be validated first), it flags it — **resolve that now**, in the
spec, not at review time.

**If the checks find something only a person can decide** — the intent names
a field the code does not have, or asks for what a policy forbids — the skill
asks you first, in plain words with the options restated, and only then shows
the draft. You never have to hunt for the question inside the markdown.

**Four checks the skill runs before it shows you a draft.** You don't prompt
for these — they are in the skill — but knowing them tells you what a draft
that skipped one looks like:

- Every name a criterion cites *as already existing* is grepped and carries its
  `file:line`; what the feature will create is marked `NEW`.
- Absence claims from the intent ("no X exists yet, building it is in scope")
  are checked with `find` over the asset directories, not a code grep — an
  unreferenced asset has zero grep hits and sits on disk anyway.
- A linked design canvas is read *first* and its values transcribed into the
  criteria (see below).
- A checkability pass over the finished criteria: each needs a manual observation
  *and* a test.

**If the intent links a design canvas**, say so — the skill reads it with
`DesignSync`, not the `Artifact` tool, and needs consent once per session:

```text
/design-consent
/spec intent/SB-12345-place-bet-after-expiry — the intent links a canvas at
/design/p/<uuid>. Read it before writing criteria, transcribe its values
into the criteria that consume them, and list anything the canvas contradicts or
is silent on.
```

A canvas is non-normative and drifts: **Pass 3 reads `spec.md` and nothing
else**, so a number that lives only on the canvas is invisible to review.
Criteria added after the canvas was drawn are ones it is simply silent on —
silence is absence of design, never assent.

**Engineer follow-ups:**

```text
Criterion 2 depends on a backend change that is out of scope for this PR. Split it:
keep the client behaviour in this spec, move the API change to "Out of
scope" with a pointer to a follow-up intent.
```

**Tester's pass** — the spec skill already ran its own checkability pass, so
this is the independent second opinion, and it is what fills the *Test plan*
section. The tester types one line:

```text
/spec-testplan intent/SB-12345-place-bet-after-expiry
```

The skill finds the spec's branch itself, writes a manual check and an
automated test per criterion into the *Test plan* section of the local file,
asks before rewording any criterion that cannot be checked from outside, and
waits. The tester reads the file, says accept or what to change; on accept it
commits on the spec's branch, pushes, and ends with "tick the Tester box on
the pull request". Typed
with no folder, it lists the specs open for review and asks which one.

**Product Owner's acceptance:**

```text
Read @intent/SB-12345-place-bet-after-expiry/spec.md. Does anything in the
acceptance criteria go beyond the intent's Desired outcome, or contradict
its Non-goals? List each, then stop — I'll decide.
```

**Approval rule:** the pull request text has three tick boxes — engineer,
product owner, tester. Each ticks their own when done; the draft check blocks
the merge until all three are ticked. Under the product owner's box the
skill lists every decision it marked `Product owner to confirm.`, one line
each, so that tick confirms them; the draft check refuses a spec that
carries the marker while the box has the old wording. Then one approval,
from someone other than the person who ran `/spec`, who sets
`Status: accepted` in the file.

Commit `spec.md` next to `intent.md`. From here on the spec is *the* source
of truth; if implementation reveals it was wrong, change the spec first.

---

## Stage 3 · Build — plan, then implement

This stage has the most choices, so it gets the most detail. **Who:** the
Engineer, end to end. The Tester contributes the tests-per-criterion (see 3d).

### 3a · Trigger planning

Three equivalent ways to enter plan mode — Claude reads and explores but
**cannot edit** until you approve:

| How | When |
|---|---|
| `/plan <task>` as a prefix on one prompt | the normal case — one prompt, plan mode on |
| `Shift+Tab` until the status bar shows `⏸ plan mode on` | you're already mid-session |
| `claude --permission-mode plan` | you want the whole session to start in plan mode |

**The one line to type** — the skill does all of the above and more:

```text
/plan-spec intent/SB-12345-place-bet-after-expiry
```

It enters plan mode itself, reads the intent, the spec and its Test plan,
asks about anything wrong in the spec before drafting, and produces a plan
with one proof line per acceptance criterion — a criterion with no test is
named, never hidden. A step that creates a module creates its test file in
the same step, so the build can show each test red before the code that
makes it pass. Typed with no folder, it lists the accepted specs that
have no plan yet and asks which one. No `@` after a skill name: the skill
opens the files itself.

If you would rather drive plan mode by hand, this is the prompt the skill
carries, for reference:

```text
/plan Implement @intent/SB-12345-place-bet-after-expiry/spec.md.

Read intent.md, spec.md and (if present) the test plan in that directory
first. The plan must:
- map EVERY numbered acceptance criterion to the files that will change and
  the test that proves it — a criterion with no test in the plan is a gap, say so;
- list the Policy constraints from spec.md you will honour, and name the
  skill each comes from;
- call out anything in the spec you believe is wrong, ambiguous, or more
  expensive than it looks BEFORE proposing an approach;
- prefer the smallest change that satisfies the criteria — no refactors the spec
  didn't ask for.
```

Here the `@` matters: in a free sentence it is what puts the file's current
content in front of Claude.

**Iterate inside plan mode.** When the plan appears you get three options:
*Yes, and use auto mode* · *Yes, manually approve edits* · *No, keep
planning*. Press `Ctrl+G` to open the plan in your editor and change it
directly. Typical "keep planning" replies:

```text
No, keep planning. Step 3 introduces a new hook; the code-conventions skill
says derived state uses the useState prev-value guard, not useEffect. Redo
step 3 with that.
```

```text
No, keep planning. Criterion 4 has no test in the plan. Add one that fails before
the change and passes after.
```

**Commit the plan — this is the step people skip.** Claude Code keeps its own
copy of the plan under `~/.claude/plans/`, but that is local and unversioned.
The artifact is the committed file. `/plan-spec` does this for you on
approval: it cuts `feature/<slug>`, writes `plan.md` into the feature folder
and commits that one file before anything else. If you drove plan mode by
hand instead, type:

```text
Save the approved plan verbatim to intent/SB-12345-place-bet-after-expiry/plan.md
and commit it on this branch before you change any other file.
```

### When planning finds a spec defect

The planning prompt above asks Claude to call out anything wrong in the spec
*before* proposing an approach, so sooner or later plan mode will stop with a
question like: *"criterion 2 says prefer the API's `short_name` — but no such field
exists; `Team` has `short_code`, a 3-letter code. Which do I render?"* That
is the pipeline working. What matters is what you do next, because **the
spec is what the automated review checks the diff against**: answer the
question and move on, and you ship code built to a criterion nobody believes
anymore — Pass 3 then either cries wolf or rubber-stamps.

**1. Classify the defect — it decides who answers.**

| Kind | Example | Who decides | Where the decision goes |
|---|---|---|---|
| Factual error about the code | `short_name` doesn't exist, `short_code` does | Engineer, on the spot | amended criterion + a `## Decisions` entry |
| Ambiguous / conflicting behaviour | criteria 4 and 7 can't both hold on mobile | Product Owner | amended criterion; PO acknowledges on the PR |
| Policy conflict | a criterion wants what a policy skill forbids | Engineer, citing the skill | Policy constraints + Decisions |
| The intent's outcome is wrong | the fix reveals the desired outcome is off | Product Owner — back to Stage 1 | `intent.md`, then re-run `/spec` |

The `short_name` case is the first kind: the desired outcome (readable names
in a fixed slot) is unchanged, only the field name was invented. Take the
option that matches the criterion's own reasoning, no PO round-trip needed.

**2. Answer in the plan session, then make the spec fix the plan's first
step.** Plan mode can't edit files, so don't try to fix the spec from inside
it:

```text
Record this as a spec amendment. Step 1 of the plan must be: update
@intent/<slug>/spec.md criterion 2 to say "render participant.name on one line with
text-overflow: ellipsis; full name in the link's aria-label — `short_name`
does not exist; `Team.short_code` is a 3-letter code and is NOT used here",
and add a dated entry under "## Decisions" explaining why. Commit that before
any code change.
```

The amended spec lands in the same PR as the implementation, so the reviewer
reads the corrected criterion. `plan.md` carries the decision too.

**3. Never let the plan work around the spec silently.** If a question is
ever answered with "just do the sensible thing", the sensible thing still
gets written into `spec.md`. A spec that drifts from the code is worse than
no spec — it makes Pass 3 untrustworthy in both directions.

**4. Feed the root cause back to Stage 2.** A criterion citing a field that doesn't
exist means `/spec` wrote it from the intent's prose without checking the
code. The `spec` skill in this template therefore requires every name a criterion
cites to be grepped and cited as `file:line`, absence claims to be checked
with `find`, and every criterion to survive the checkability pass — the checks plan
mode just did, one stage earlier. If your `/spec` runs keep producing defects
of one kind, that is a skill patch, not a series of plan-mode questions.

### 3b · Trigger implementation — pick the mode that matches the risk

**The skill first.** `/build-plan step` is Option A below with the plan read
for you: the next uncommitted step, its tests found through the files it
touches, the diff shown, one question — *"Commit step 3?"* — and one commit
per step so the git log is the record. `/build-plan all` is Option B without
the paragraph: every remaining step, one commit each, stop on the first red
or after 25 turns, then the verification of 3c. The options below remain for
hand-driven runs and for headless use.


**Option A — interactive, step by step.** Best for risky or unfamiliar code.
After approval:

```text
Implement step 1 of @intent/SB-12345-place-bet-after-expiry/plan.md only. Run the
tests it names, show me the diff, and stop.
```

…then `step 2`, and so on. You stay in the loop at every step; the cost is
your attention.

**Option B — `/goal` for the whole plan, hand-driven or headless; `/build-plan all` is the skill's version of it.** `/goal` sets a completion
condition and Claude keeps taking turns until a separate small model judges
the condition met (or impossible). It is the right tool when the end state
is **verifiable from Claude's own output** — which is exactly what a spec
with numbered criteria and a test plan gives you:

```text
/goal Every acceptance criterion in intent/SB-12345-place-bet-after-expiry/spec.md
is implemented following intent/SB-12345-place-bet-after-expiry/plan.md, and:
- the project's test and type-check commands from AGENTS.md exit 0 (print
  the last 20 lines of each as proof);
- every criterion has at least one new test, and each new test was shown FAILING
  before the implementation that makes it pass;
- no file outside the plan's file list is modified (`git status --short`
  is printed and matches);
- or stop after 25 turns and report which criteria remain, with reasons.
```

How to write a condition that works — from the docs, in this template's terms:

- **State the check, not just the outcome.** The evaluator reads the
  transcript; it does not run commands. "Tests pass" is invisible unless
  Claude runs them and the output lands in the conversation — hence "print
  the last 20 lines".
- **Bound it.** A turn or time clause (`or stop after 25 turns`) is your
  budget. Without it, a stuck goal burns turns until you notice.
- **Pair it with auto mode** (Claude Code's default permission mode) so tool calls don't
  prompt between turns; a goal never changes your permission mode on its own.
- `/goal` with no argument shows status; `/goal clear` stops it early.

Don't use `/goal` when the spec is still ambiguous — the evaluator will
happily judge a wrong interpretation as "met". Ambiguity is a Stage 2 problem;
go back and fix the spec.

**Option C — unattended, in CI.** For work that fits comfortably in the plan
(mechanical migrations, follow-ups the spec fully pins down), the mention
responder in [`claude.yml`](../.github/workflows/claude.yml) runs the same
prompt on a GitHub issue or PR comment:

```text
@claude Implement intent/SB-12345-place-bet-after-expiry/plan.md on a branch off
main. Follow spec.md's acceptance criteria and policy constraints exactly,
run the project's checks, and open a PR that links the intent directory.
Don't change anything the plan doesn't list.
```

The resulting PR then goes through the automatic review like any other. The
same thing from a terminal, headless:

```bash
claude -p "/goal <the condition from Option B>" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose
```

(`stream-json --verbose` matters: a many-turn goal prints nothing until it
ends otherwise. And if your repo has a Stop hook like this template's, it is
the only format whose output you can trust — see the README gotchas.)

**A branch held by another worktree.** Every step that continues on a
branch another session made (`/spec-testplan` on `spec/<slug>`,
`/build-plan` on `feature/<slug>`, an intent change on an open spec branch)
may meet `fatal: '<branch>' is already used by worktree at <path>`. The
rule is in AGENTS.md and every skill follows it: a local branch under
another name from `origin/<branch>`, pushes with `git push origin
HEAD:<branch>`, one line to the person. Nothing to type.

**Option D — parallel work.** One engineer, two features:

```bash
claude --worktree place-bet-after-expiry
```

gives the session its own checkout and branch, so two implementations never
collide in the working tree.

### 3c · Verify before opening the PR

`/build-plan verify` prints exactly this: one PASS or FAIL line per
acceptance criterion with the test as evidence, after running the checks.
The prompt below is the hand-driven form of the same thing.

```text
Run the full checks. Then, for each acceptance criterion in
@intent/SB-12345-place-bet-after-expiry/spec.md, state PASS or FAIL with the
evidence — the test name, or the screenshot or response for criteria a
person observes. Anything FAIL: say why, don't fix yet.
```

Run the local reviewer against the same criteria the CI reviewer will use —
cheaper to hear it now:

```text
/code-review high
```

Then open the PR with the template, linking the intent dir:

```text
Open a PR against main using the repo's PR template. Link
intent/SB-12345-place-bet-after-expiry/ in the Artifacts section and list which
acceptance criteria this PR covers.
```

### 3d · The Tester's prompts during Build

The tester can work in parallel with the engineer, from the spec alone:

```text
From the Test plan in @intent/SB-12345-place-bet-after-expiry/spec.md, write the
automated tests for criteria 1 to 3 against the current code. They should FAIL now
(the feature isn't built) — run them and show me the failures. Don't touch
non-test files.
```

Failing tests committed ahead of the implementation are the strongest
possible acceptance criteria: the engineer's `/goal` condition can simply
say "the tests in `__tests__/place-bet-after-expiry.test.ts` pass".

### Which mechanism, when

| You want | Use | Not |
|---|---|---|
| A change reviewed before it touches disk | plan mode (`/plan`) | `/goal` |
| Autonomous work toward a **verifiable** end state | `/goal` (bounded) | plan mode alone |
| Re-run something on a **time** interval (poll CI, watch a deploy) | `/loop 5m …` | `/goal` |
| A check that should fire **every** turn, in every session | a Stop hook in `.claude/settings.json` | `/goal` (session-scoped) |
| Work that runs while nobody is at the keyboard | `@claude` in CI, or `claude -p` | an interactive session left open |
| Two things at once | `claude --worktree` | two sessions in one checkout |

---

## Stage 4 · Test the config — evals and skill patches

*Runs in CI only when `CLAUDE_CI` is `true`. The local command works always.*

**Who:** the Engineer writes the skill patch and the golden case; the Tester
owns the eval suite as a regression suite. **Triggered by:** any PR touching
`CLAUDE.md`/`AGENTS.md`/`.claude/**` — nobody runs it by hand in CI.

**Capturing a correction as a skill patch** — an engineer's session says two
lines at turn end (*"Skill gap noticed: … Want a patch?"*); the product owner's
session never does. You approve, and the patch and its case land together. The
approval must be explicit:

```text
yes, draft it
```

(Per the self-improvement rule, "thanks" or "looks good" after an answer is
*not* approval — the rule is deliberately strict about this.)

**Adding a case for the correction** — done for you on the yes above. To add
one by hand later:

```text
Add a case to @eval/config/cases.ts for the rule we just captured: a prompt
an agent would actually face, mustMatch/mustNotMatch regexes on the answer
(case-insensitive, multi-alternative — avoid trap regexes that a correct
answer QUOTING the anti-pattern would trip), severity must-pass, guardedBy
naming the skill section.
```

**Mutation-test it — a green eval proves nothing until you have watched it go red:**

```text
Temporarily delete the rule from AGENTS.md (or the skill section it lives
in), run `npm run ai:eval:config -- --id <case-id>`, and show me the
failure. Then restore the file and run it again.
```

If it does not go red, the rule is guarded somewhere else too (a skill
description, a second doc) — note that in the case's `guardedBy` rather than
pretending the eval measures what it doesn't.

---

## Stage 5 · Deploy — review and merge

*Runs only when `CLAUDE_CI` is `true`. Until then pull requests show the
review check as skipped, not failed, and `/code-review` locally is the review.*

**Triggered by:** the PR itself. The review runs on open, on ready-for-review
and on every push; nobody prompts it. **Who acts on it:** the Engineer fixes,
the Tester verifies on the preview, a human merges.

**Fix a finding via the mention responder** (runs in CI, pushes to the PR
branch):

```text
@claude Fix finding 2 from the review — keep the change minimal and add the
missing test it names.
```

**Ask for a targeted re-check** instead of a full review:

```text
@claude Pass 3 only: re-check this diff against
intent/SB-12345-place-bet-after-expiry/spec.md and tell me which acceptance
criteria are still unmet.
```

**Tester, on the build.** The feature pull request carries a "Tester's pass"
section, written by `/build-plan`: one line per criterion with the manual
check from the Test plan, and a Tester box. Run each check against the build
(the preview for a screen, the running service for a request, the log or
queue for a message), write what you observed on its line, tick the box. To
have Claude walk the screens with you:

```text
Using the preview URL in this PR, walk through the manual check for each criterion
in @intent/SB-12345-place-bet-after-expiry/spec.md and screenshot the result of
each. Report PASS/FAIL per criterion. Don't fix anything.
```

**Opting out** for mechanical PRs (dependency bumps, generated files): add
the `skip-claude-review` label. The bot-opened maintain-loop PRs carry it
automatically.

**Merging is always a person.** The pipeline never auto-merges — `CLEAN` from
GitHub and a green review are inputs to your decision, not the decision.

---

## Stage 6 · Maintain — the loop opens the PR, you triage it

*Runs only when `CLAUDE_CI` is `true` and the error tracker is configured.*

**Triggered by:** the daily cron in `sentry-maintain-loop.yml`, or
`workflow_dispatch` with `force=true` to test. **Who acts:** Product Owner
triages (is this worth doing?), Engineer sanity-checks the diagnosis, Tester
tunes the bands.

**Triage a maintain-loop intent PR:**

```text
Review @intent/SB-12346-checkout-timeout/intent.md — it was written by the
maintain loop. Verify the diagnosis hypothesis against the files and commits
it cites and the Sentry permalink. Then either set Status: accepted, or
write a Constraints note explaining why we're deferring it. Don't fix the bug.
```

Accepted → merge the intent PR → `/spec intent/SB-12346-checkout-timeout` and
you are back at Stage 2.

**Tune a band** (Tester/Engineer — the thresholds are a reviewable diff):

```text
The api-errors band in @config/error-bands.ts fired three days running on the
same issue that we've already accepted an intent for. Confirm the dedupe
picked up the permalink from intent/**, and if the band is just too
sensitive, propose a new minEvents with the last 14 days of counts as
evidence.
```

**Test the loop end-to-end** without waiting for a breach: run the workflow
with `force=true` from the Actions tab; it writes a single test intent and
says so in the file.

---

## Which model, where

Match the model to the **stage's risk**, not to the loop as a whole. Two
rules of thumb before the table:

- **Locally, use aliases** (`sonnet`, `opus`, `fable`, `haiku`, `opusplan`)
  so a model upgrade costs you nothing. **In CI, pin an exact model id** —
  the template's workflows do — so a review or a diagnosis is reproducible
  and a silent model change can't move your baseline.
- **CI is real money.** Every CI run in this template (`claude-review.yml`,
  the maintain loop's diagnose job, config evals) bills the frontend domain's
  Anthropic API key per token, while local sessions run on your own Claude
  Code sign-in. That is why the CI defaults below are Sonnet and Haiku, not
  Opus. Raise a CI model tier only when findings are visibly shallow, and
  check the key's usage in the Anthropic Console first.

| Stage · task | Local default | Upgrade when | Where it's set |
|---|---|---|---|
| 1 · `/intent` | `sonnet` | never needed — it's an interview + extraction | `/model sonnet` |
| 2 · `/spec` | `opus` | the intent touches several policy skills at once (the constraint pass is real reasoning over conflicting rules) | `/model opus` before running `/spec` |
| 3a · plan mode | **`opusplan`** — Opus while planning, auto-switches to Sonnet on approval | `fable` for architecture-level plans across many modules | `claude --model opusplan`, or `/model opusplan` |
| 3b · implement (interactive / `/goal`) | `sonnet` (what `opusplan` hands you after approval) | `fable` for `/goal` runs "larger than a single sitting" — the docs position it for long autonomous sessions that investigate and verify more; `opus` for a single gnarly step | `/model fable` before setting the goal |
| 3c · `/code-review` before the PR | session model | `/code-review ultra` for a deep multi-agent cloud review of a risky PR | argument to the command |
| 4 · config evals | `haiku` (`DEFAULT_MODEL` in [`eval/config/run.ts`](../eval/config/run.ts)) | **don't.** Evals test the *config*; if a rule only holds with a smarter model, the rule is under-specified — fix the wording, not the model. Use `--model` only to *diagnose* a flaky case | `npm run ai:eval:config -- --model=<id>` |
| 5 · automatic PR review | `claude-sonnet-4-5` pinned | findings feel shallow on complex diffs → `opus`; check the key's usage first | `claude_args: --model …` in [`claude-review.yml`](../.github/workflows/claude-review.yml) |
| 5 · `@claude fix …` responder | action default | rarely — fixes are scoped by the finding | `claude_args` in [`claude.yml`](../.github/workflows/claude.yml) |
| 6 · maintain-loop diagnosis | `claude-sonnet-4-5` pinned, read-only, 25 turns | diagnoses are hand-wavy → `opus`; it only runs on breach days, so the cost is bounded | `claude_args: --model …` in [`sentry-maintain-loop.yml`](../.github/workflows/sentry-maintain-loop.yml) |
| background: `/goal` evaluator, compaction, classifier | Haiku (the "small fast model") | leave it. `ANTHROPIC_DEFAULT_HAIKU_MODEL` overrides it *everywhere* the small model is used, not just for one feature | env var, only if your provider requires it |

**Effort** is the other dial. The default (`high`) is right for almost
everything here. Two deliberate exceptions:

- `/effort max` (or `--effort max`) for a plan-mode session on a design
  problem you'd otherwise whiteboard with a colleague — planning is where
  extra thinking pays off most, and it's a small slice of total tokens.
- `/effort low` for mechanical `/goal` runs the plan fully pins down (a
  rename across call sites, a lockstep migration) — faster and cheaper, and
  the spec's tests are the safety net, not the model's deliberation.

**A practical Build-stage recipe**, putting the above together:

```bash
claude --model opusplan --worktree place-bet-after-expiry
```

```text
/plan Implement @intent/SB-12345-place-bet-after-expiry/spec.md. …
```

…approve → Sonnet implements. If the plan turned out to be a multi-hour
`/goal`, `/model fable` before setting it.

---

## Roles → stages, in prose

**Product Owner** owns the *why*. They trigger Stage 1 (`/intent`), accept
the spec's scope in Stage 2, and triage what the maintain loop brings back in
Stage 6. They never approve a plan or merge — those are engineering gates —
but they are the only person who can say a maintain-loop intent isn't worth
pursuing.

**Engineer** owns the *how*. They run `/spec` (the constraint pass is a
technical review of policy skills), everything in Stage 3 (plan, approve,
implement, verify, open the PR), respond to review findings in Stage 5, and
write the skill patches and golden cases in Stage 4. Approving a plan and
merging a PR are theirs.

**Tester** owns *proof*. Their leverage is earliest: the testability review
in Stage 2 turns vague criteria into checkable ones before any code exists. They
write tests-per-criterion during Build (ideally failing, ahead of the
implementation), verify criteria on the preview in Stage 5, and own the eval
suite and band thresholds as regression instruments.

**The pipeline** owns *consistency*: it reviews every PR the same way,
replays every config change against the same golden prompts, and checks
production every morning. It proposes; it never decides.

**Solo developer?** You wear all three hats, and the artifacts still pay
for themselves — the automated reviewer reads the spec you wrote as PO and
holds the code you wrote as Engineer to it. Write the PO prompt in the PO's
voice and the tester prompt in the tester's; the role switch is the point.

---

## Tooling: which surface each role uses, and where skills live

### The Product Owner's surface — Code mode, not Cowork

An intent is a **repo artifact**: it must land as `intent/<slug>/intent.md`
on a branch, with a PR, next to the template it was filled from. Every later
stage reads it from the repo — `/spec`, REVIEW.md Pass 3, the maintain
loop's dedupe scan of `intent/**`. That makes the choice of surface a git
question, not a UI-preference question:

- **Cowork** (Claude Desktop) is a folder-and-connectors surface. It is the
  right place for the step *before* the intent — pulling evidence together
  from Slack, a Sentry link, a ticket export, an analytics sheet — but it is
  not built around branches and PRs, and it runs its own skill library
  (uploaded skills / plugins), not the repo's `.claude/skills/`. Pointing it
  at a clone yields a file on disk, not a committed artifact under review,
  and `/intent` isn't loaded there.
- **Code mode** (Claude Code — Desktop app, terminal, or the web) loads
  `CLAUDE.md`/`AGENTS.md` and `.claude/skills/` automatically, so `/intent`
  just works, and it can branch, commit and open the PR. Nothing in `/intent`
  requires reading code: it interviews, fills the template, shows a draft,
  writes one markdown file. The PO types a prompt; that's the whole job.

Three PO paths, in order of recommendation:

| Path | What the PO needs | How it runs |
|---|---|---|
| **1. Claude Code on the web / Desktop cloud session** | a browser and repo access | `/intent …` in a GitHub-connected session; the result comes back as a branch + PR to share. Plan and accept-edits modes are available; `/intent` only ever writes into `intent/`. |
| **2. GitHub only — zero tooling** | a GitHub account | Write an issue with problem, evidence and desired outcome, then comment `@claude run /intent on this issue and open a PR against main`. The mention responder ([`claude.yml`](../.github/workflows/claude.yml)) runs on a checkout with the repo skills loaded — headless mode expands `/skill-name` in the prompt — and opens the PR. The PO also does the *accept* step there: review the intent PR, merge. |
| **3. Desktop Code mode on a local clone** | git + a clone | same as 1, locally. Fine for a technical PO. |

The practical split: **Cowork for evidence-gathering, Code/GitHub for the
artifact.** Draft the problem statement in Cowork with connectors, then paste
it into `/intent` (path 1) or an issue (path 2).

The Engineer and Tester use Code mode throughout; the Tester's preview
verification (Stage 5) and the PO's triage of maintain-loop PRs (Stage 6)
happen on GitHub.

### Where the skills live — in the repo, not a marketplace plugin

Keep `/intent` and `/spec` in `.claude/skills/` of each repo that runs the
loop:

- **They are coupled to repo files.** `/intent` fills
  `intent/_templates/intent.md`; `/spec`'s mandatory constraint pass has a
  *repo-specific* mapping table of which policy skill to read for which
  domain. A plugin can't carry that table without going stale the first time
  the project adds a skill.
- **They are versioned with the loop.** Changes go through skill-maintenance
  and are gated by config-evals CI. A plugin is a per-user install, so people
  (and CI) can run different skill versions against the same templates —
  exactly the drift the pipeline exists to prevent.
- **CI needs them.** Path 2 above and every headless run load skills from the
  checkout; a plugin would have to be installed into each CI job separately.
- **Zero install** for contributors: clone and it's there.

Where a plugin *does* make sense:

- **Bootstrapping many repos** — publish the template itself as a plugin
  whose job is to copy the files in (skills, templates, workflows). After
  that, the repo copy is the source of truth. That's distribution, not
  runtime.
- **A Cowork-side helper for the PO** — a small plugin skill running the same
  interview and producing intent *text* to paste into an issue. Only if the
  PO genuinely can't use path 1 or 2; otherwise it's a second copy of the
  interview to keep aligned.

Rule of thumb: **skills that read or write repo files live in the repo;
skills that only shape a conversation can be plugins.** `/intent` and
`/spec` are both the first kind.

---

## Showing the loop to a team — the artifact prompt

[GETTING-STARTED.md](GETTING-STARTED.md) is the step-by-step in text. For a
presentation, a designed page reads better. Do not keep such a page in the
repository; it would drift from the text. Instead, paste this prompt into a
fresh Claude Code session and it produces the page as an artifact from the
current GETTING-STARTED.md. Anyone on the team can run it, any time, in any
Claude account; the result is the same page because the prompt names every
section.

**Keep the prompt level with the guide.** The list of sections below is the
guide's table of contents. A pull request that adds, removes or renames a
section in GETTING-STARTED.md changes this list in the same pull request
(the rule is in AGENTS.md). A page made from an old prompt silently leaves
out what the guide gained; that happened once, on 19 September 2026, and
cost a morning.

```text
Read docs/GETTING-STARTED.md. Build one HTML page that shows the feature
loop as a checklist a team can follow, and publish it as an artifact named
"The Feature Loop". Do not write the page into the repository.

Audience: engineers, product owners and testers who have never used Claude
Code. Not all are native English speakers. Full words, no abbreviations, no
idioms. Use the words the file uses: intent, spec, plan, criterion, pull
request.

Every section of the file goes on the page, in the file's order, nothing
left out. Today the sections are:
1. The six stages: a strip of six boxes, stage number, playbook name, what
   happens, file or place; the three that are in use marked, the three that
   are switched off marked.
2. The idea in one paragraph.
3. The three roles, as a table: role, owns, does.
4. Before the first feature: the template ships no house rules; the three
   day-one questions as a list; where existing rules must go to reach the
   spec and the review.
5. Your first feature, start to finish: the example ticket; the folder
   named by the Jira ticket; the sentence "nobody edits main, the plan is
   not on main until the code is"; two lanes, colour-coded, showing where
   each file lives (lane one is main: intent.md and spec.md, each arriving
   by its own small pull request before any code; lane two is the feature
   branch: plan.md, code and tests, one pull request at the end); the full
   step table with every row (playbook stage, file, step, who, type, ends
   with); the three habits; the paragraph "Jira knows the step".
6. Stage 1, Stage 2 and Stage 3: one block per role step, in the order the
   file gives them. Each block has a coloured badge for the role, the step
   name, and what the step ends with, including which branch. Inside, one
   line per step. What you type into Claude Code sits in a monospace chip.
   What you click on GitHub carries a small GitHub label. No explanations
   beyond the file's own sentences. Stage 2 also carries the paragraph
   "What a criterion is".
7. Stage 4, Stage 5 and Stage 6, each as the file describes them: Stage 4
   with the agent's three checks and the person's one check, and the note
   on what is the template's own addition; Stage 5 with the pull request
   steps and the production gate; Stage 6 with the maintain loop.
8. When a later step finds an earlier file wrong: the two rules, the two
   kinds (fact, judgement) as two boxes, and the full table with every
   row.
9. Who accepts what.
10. What a good intent looks like and what a good spec looks like.
11. Small changes.
12. When something feels wrong.
13. A footer linking to docs/PROMPTING.md, docs/GETTING-STARTED.md and the
    playbook, and the sentence "when this page and the file disagree, the
    file wins".

Any step the file marks as still being tested, or as "will be presented
soon", or as switched off, gets a dashed note saying so.

Design: a plain, polished document, not a landing page. Two accent colours,
one per lane, used for nothing else. Serif headings, sans body, monospace
for commands. Light and dark theme. No emoji, no hero image, no cards for
everything. Tables stay tables.

Do not invent steps. Every line must come from docs/GETTING-STARTED.md. If
a section of the file is missing from the list above, include it anyway and
say so at the end. If something in the file is unclear, stop and ask.
```

## Anti-patterns

- **Pasting the spec into chat** instead of `@`-referencing the file. The
  reviewer reads the file; if the chat copy drifted, you built to a spec
  nobody checks against.
- **`/goal` without a stated check or a turn bound.** The evaluator can only
  see what Claude prints; an unbounded goal is an unbounded bill.
- **Not committing `plan.md`.** The copy under `~/.claude/plans/` is local.
  If it isn't in the intent dir, the plan didn't happen as far as the repo is
  concerned.
- **Running `/spec` on a maintain-loop intent that nobody accepted.** The
  loop's diagnosis is a hypothesis from error text. A human reads it first.
- **Using `/goal` to resolve ambiguity.** It will resolve it — arbitrarily.
  Ambiguity is a Stage 2 defect.
- **Treating a green eval as proof.** Watch it go red once (mutation test) or
  it may be structurally unable to fail.
- **Auto-merging on `CLEAN` + green review.** Both race with checks that
  haven't been created yet; and the merge decision is the one gate this loop
  deliberately leaves to a person.
