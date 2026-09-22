# Getting started — your first week with the loop

This is for a team that has never worked this way. It explains the idea in
plain words, names the three roles, walks one feature through from start to
finish, and states the one review rule. Read this first; the
[README](../README.md) tells you how to set the repository up, and
[PROMPTING.md](PROMPTING.md) tells you exactly what to type at each step.

The process follows Anthropic's
[AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook).
When this document and the playbook disagree, the playbook wins.

## The six stages

The playbook has six stages in a loop. This guide covers the first three in
detail; they are tested and in use. The last three exist in the template and
are switched off until the project turns them on.

| Stage | Playbook name | What happens | File or place | In this guide |
|---|---|---|---|---|
| 1 | Plan | the product owner says why | `intent.md` | yes |
| 2 | Design | the team agrees what "done" means | `spec.md` | yes |
| 3 | Build | the engineer plans, then builds | `plan.md`, then the code | yes |
| 4 | Test | two things: the agent checks its own work with the product's tests before a person sees it, and the loop's own configuration is tested when a skill or instruction file changes. Not the traditional test stage | the test command, `eval/config/` | will be presented soon |
| 5 | Deploy | the pull request, the automatic review, the merge to main. Up to the production gate, never past it; the release to production is a person's act outside the loop | the pull request | will be presented soon |
| 6 | Maintain | production errors become new intents | the maintain loop | will be presented soon |

## The idea in one paragraph

Every feature leaves a paper trail of three small files before any code is
written: **why** we are doing it, **what** "done" means as a numbered
checklist, and **how** we will build it. Claude writes the drafts; people
approve them. The same checklist is later used by the automatic code review
to judge the finished code. Nothing is remembered in someone's head or in a
chat window; it is all in the repository, next to the code.

Think of a builder: write down what the client wants, measure the house
before quoting, show the drawing before picking up a hammer. The three files
are those three steps.

## The three roles

| Role | Owns | Does |
|---|---|---|
| **Product owner** | the *why* | starts a feature with `/intent`, checks the spec stays in scope, decides on maintain-loop findings |
| **Engineer** | the *how* | runs `/spec`, runs `/plan-spec` and approves the plan, implements, opens the PR, fixes review findings |
| **Tester** | the *proof* | runs `/spec-testplan` on each spec, writes tests per line (ideally before the code), verifies on the preview |

One person can wear all three hats. The roles still help: write the intent in
the PO's voice, then read the spec back as the tester.

## Before the first feature: write your first rules

The template ships no house rules. The code-conventions skill holds one
rule about process and an empty "Project rules" section. On day one, before
the first `/intent`, the team writes its first rules there, starting from
what reviews have already taught it. The spec cites those rules by name in
its Policy constraints section and the review checks the code against them,
so an empty file means specs with no constraints and reviews with nothing to
hold the code to. Three questions find the first rules:

- Does the project handle money, odds, quantities or other values where
  rounding matters?
- Does it render a screen a person sees?
- Does it own a contract other systems call?

Each yes is usually a rule. A rule is a bold name, what to do and what not
to do, why, and how it is checked; each one gets a case in
`eval/config/cases.ts` in the same pull request.

If the repository already has rules, in CLAUDE.md, in `.claude/rules/`, in a
contributing guide or in people's heads: Claude follows the loaded ones
while it writes code, but the spec cites only the policy skills. Write the
rules you want in specs and reviews into code-conventions, or list their
file as a policy skill in the spec skill's table.

## Your first feature, start to finish

Say a support ticket arrives: on mobile, "Place bet" does nothing after the
user's session has expired.

Three people, three files, one feature. The feature folder is named by the
Jira ticket: `intent/SB-194034-betslip-balance-warning/`. When there is a
ticket its key is in every path, link and pull request of the feature; without
one the folder is the slug alone and the intent says `Jira: none`. Nobody edits `main`. The intent and
the spec each reach `main` through their own small pull request, before any
code. The plan and the code share one feature branch and reach `main`
together, so `plan.md` is not on `main` until the code is.

The playbook names the stages Plan, Design, Build. The files are named
`intent.md`, `spec.md`, `plan.md`. The two sets of names do not line up, so
every step below says both.

| Playbook stage | File | Step | Who | Type | Ends with |
|---|---|---|---|---|---|
| 1 · Plan | `intent.md` | Intent | product owner | `/intent` | `intent.md` in its own pull request, merged to `main` |
| 2 · Design | `spec.md` | Spec | engineer | `/spec intent/<feature folder>` | `spec.md` in its own pull request, three tick boxes |
| 2 · Design | `spec.md` | Read the spec | product owner | click on GitHub | Product owner box ticked |
| 2 · Design | `spec.md` | Test plan | tester | `/spec-testplan intent/<feature folder>` | Tester box ticked |
| 2 · Design | `spec.md` | Accept | a second engineer | edit `Status: accepted` on GitHub | `spec.md` merged to `main` |
| 3 · Build | `plan.md` | Plan | engineer | `/plan-spec intent/<feature folder>` | `plan.md` committed on `feature/<name>` |
| 3 · Build | the code | Build | engineer | `/build-plan step` or `/build-plan all` | the feature pull request, plan and code together |
| 4 · Test | `eval/config/` | Config evals | automatic | runs on a pull request that changes a skill | will be presented soon |
| 5 · Deploy | the pull request | Review and merge | reviewer | click on GitHub | merged to `main` |
| 6 · Maintain | the maintain loop | Error to intent | automatic | daily | will be presented soon |

Every step is one line typed into Claude Code, or one click on GitHub. Claude
handles the branches and pull requests; nobody types a git command. Three
habits: start a fresh Claude Code session for each step, open the file rather
than pasting it into the chat, and when Claude asks, pick an option and say yes.

One thing you may see once: a branch can be open in only one folder at a
time on a computer, and a finished session's folder keeps its branch. When
your step's branch is held that way, Claude works on a copy under another
name and pushes to the same branch, and says so in one line. Nothing for you
to do.

**Jira knows the step.** When the intent was read from a Jira ticket, every
step writes two comments on that ticket: "Development loop · Stage 2 Design ·
spec started · <name> · <date>" when someone starts, and "… handed in · <pull
request link>" when the step is handed in. Open the ticket and you see where
the feature is and who is on it, even before a branch is pushed. Running
`/intent` on a ticket that already carries such a comment does not create a
second intent; Claude points at the existing feature folder instead. The
ticket's status and description are never changed by the loop.

## Stage 1 · Plan · `intent.md`

### Product owner: the intent

1. `/intent` and describe the problem in your own words. With a Jira ticket:
   `/intent SB-12345`.
2. Answer the questions, or say "write it as is".
3. Read the draft Claude shows. Say what to change, or say it is fine.
4. Claude asks "Do you accept this intent as written?" Say yes.
5. Claude asks "Shall I hand it in?" Say yes. Claude opens the pull request.

An engineer merges it after a quick look: right place, reads clearly, says
accepted.

## Stage 2 · Design · `spec.md`

Four steps, one file. The spec is still being written and read until the
Accept step merges it.

**What a criterion is.** The spec is a numbered list of criteria. A criterion
is one sentence that says one thing that must be true when the feature is
done, written so that a person can check it by using the product, without
reading code. Example: "When the stake is higher than the balance, the
betslip shows the message *Your balance is 120 kr* and the Place bet button
cannot be pressed." Not a criterion: "The betslip handles low balance
better", because nobody can check it. The tester checks every criterion by
hand, one test checks every criterion automatically, and the automatic
review checks the code against the same list. Done means every criterion is
true.

### Engineer: the spec

1. `switch to main and pull`
2. `/spec intent/<feature folder>`
3. Pick an option when Claude asks. Decisions come before any draft.
4. Read the spec file. Say accept, or say what to change.
5. Claude asks "Shall I hand it in?" Say yes.
6. On GitHub, read the spec on the pull request. Tick the Engineer box.

### Product owner: read the spec

1. Open the spec pull request on GitHub.
2. One question: does any line ask for more than the intent, or go against
   its non-goals? Comment if so.
3. Read the decisions listed under your box. These are choices the engineer
   made on the facts that change what a player sees: a wording, a boundary,
   a language. If one is wrong, comment; the spec is changed and the line
   goes.
4. Tick the Product owner box. The tick confirms the listed decisions too.

### Tester: the test plan

1. `/spec-testplan intent/<feature folder>`. Claude finds the spec's branch
   itself.
2. Pick an option when Claude asks. A criterion nobody can check from outside
   is reworded with you, not around you.
3. Read the Test plan section in the spec file. Say accept, or say what to
   change. Claude commits and pushes.
4. On GitHub, tick the Tester box.

### Engineer: accept the spec

1. All three boxes ticked, and every decision listed under the product
   owner's box confirmed or changed? Someone other than the person who ran
   `/spec` opens the spec file on the pull request.
2. Change `Status: draft` to `Status: accepted`. Commit on the branch.
3. The draft check turns green. Approve and merge.

From here on the spec is the source of truth. If it turns out to be wrong
later, the spec is fixed first and the change is recorded under
`## Decisions`; the code is never quietly built to something the spec does
not say.

## Stage 3 · Build · `plan.md`, then the code

### Engineer: the plan

1. `switch to main and pull`
2. `/plan-spec intent/<feature folder>`
3. Pick an option when Claude asks. Spec defects are raised before any
   drafting.
4. Claude proposes a plan. Open plan, read it, Accept or Revise.

On accept Claude creates the feature branch and commits the plan as
`plan.md` before any code changes. That commit is what makes the plan real.
Every step that creates a module also creates its test file, so the build
can show each test failing before the code that makes it pass.

### Engineer: build

1. `switch to feature/<feature name> and pull`
2. `/build-plan step`. Claude does the next step of the plan, runs the tests
   the plan maps to it, shows the diff, and asks "Commit step 3?" Say yes.
   Repeat until the last step. Or `/build-plan all`: every remaining step,
   one commit each, no questions, stops on the first red or after 25 turns.
3. When the last step is committed, Claude runs the checks and prints one
   line per criterion: PASS with the test, or FAIL with the reason.
4. `/code-review high`
5. Claude asks to open the pull request. Say yes. The pull request links the
   feature folder and lists the criteria as tick boxes.

Progress is the git log: one commit per step, `build: step 3 — <name>`.
Nothing is ticked off in `plan.md`; it only changes when the plan changes,
in the same commit as the code.

## Stage 4 · Test · the test command, `eval/config/`

Stage 4 is not a step anyone runs or schedules. It is the name for the
checking that happens inside Build and inside the pull request. Nobody
types a Test command; the checks below are where Stage 4 lives.

**The agent's part, three checks.** First, every build step is red, then
green: when a step adds a test, `/build-plan step` shows it failing before
the code that makes it pass, and nothing red is ever committed. Second,
when the last step is committed, `/build-plan verify` runs every command
in the plan's Checks and prints one PASS or FAIL line per criterion, with
the test that proves it. Third, when a pull request changes a skill or an
instruction file, the cases in `eval/config/cases.ts` run against the
changed configuration, and a red case blocks the merge. The first two are
on from day one; the third is off until the project turns on the
`CLAUDE_CI` switch.

**The person's part, one check.** The feature pull request carries a
section "Tester's pass", written by `/build-plan`: one line per criterion
with the manual check copied from the spec's Test plan, and a Tester box.
The tester runs each check against the build (the preview for a screen, the
running service for a request, the log or queue for a message), writes what
they observed on its line, and ticks the box. The Test plan itself was
written in Stage 2 by `/spec-testplan`; by Stage 4 the tests exist and the
agent runs them, and the tester runs what only a person can. Jira gets one
comment when the pass is requested; the result stays on the pull request.

Two of these are this template's additions, not the playbook's. The
playbook asks for the failing test first only for bug fixes and has no
tester before merge; here every step goes red then green, and a tester
checks by hand before the merge, until the first real project shows the
automated checks are enough.

## Stage 5 · Deploy · the pull request

The name misleads here too: Deploy means the pull request, the automatic
review and the merge to `main`, up to the production gate and never past
it. The playbook's words: the agent may act up to the production gate and
cannot pass it. The release to production is a person's act, behind branch
protection, outside the loop.

### The pull request

The pull request uses the repository's template and links the intent
directory. The automatic review reads the diff three times: for bugs, for
security, and against your own acceptance criteria. Fix findings locally or
by commenting `@claude fix finding 2`. A person merges. Always.

The automatic review is off until the project turns it on: a repository
setting called `CLAUDE_CI`, plus the domain's API key. Until then the check
shows as skipped and the local `/code-review` is your review. The README
says how to turn it on.

## Stage 6 · Maintain · the maintain loop

Will be presented soon. In short: a daily check reads the error tracker; when
an error band is breached, a read-only diagnosis writes a draft `intent.md`
and opens a pull request. The product owner reads it, edits it, merges it,
and the loop starts again at Stage 1. Off until the project turns on the
`CLAUDE_CI` switch.

That is the whole loop. The first time takes an afternoon. By the third
feature it is faster than working without it, because nobody re-explains the
feature to anyone, including to Claude.

## When a later step finds an earlier file wrong

A later step will sometimes find an earlier file wrong. Two rules hold in
every case. The earlier file is fixed first, never worked around. Every fix
gets a dated line under that file's `## Decisions` saying what changed and
why.

Where the fix goes depends on the kind of problem:

- **A fact is wrong.** A criterion names a field that does not exist, a rule
  citation has shifted, a link is dead. There is one right answer and the
  engineer knows it. Fix the file where you stand, on the branch you are on.
  The change is visible in the pull request you will open anyway. Nobody
  needs to be asked.
- **A judgement is wrong.** Two criteria cannot both hold, the scope is off,
  the outcome is questioned. This is the product owner's call, and it must
  not wait for the feature pull request. Claude stops and says so. The fix
  goes back to `main` now, in a small pull request with the reader boxes,
  and the current step waits for the merge.

Every case, one row each:

| You are in | You find | Kind | Who decides | Where the fix goes | What waits |
|---|---|---|---|---|---|
| Spec step | the intent's outcome or scope is wrong | judgement | product owner | `intent.md` changed with `/intent intent/<feature folder>`; the change rides in the open spec pull request, the Product owner box covers both | the spec, until the product owner accepts the changed intent |
| Spec step | a fact in the intent is wrong (ticket number, dead link) | fact | engineer | `intent.md` fixed on the spec branch, Decisions line | nothing |
| Plan step | a criterion names something that does not exist in the code | fact | engineer | step 1 of the plan: fix `spec.md`, Decisions line, commit before any code | nothing |
| Plan step | two criteria conflict, or the spec goes beyond the intent | judgement | product owner | Claude stops. Small pull request `Spec amendment: …` to `main` with the reader boxes | the plan, until it is merged |
| Plan step | the intent itself is wrong | judgement | product owner | Claude stops. `/intent intent/<feature folder>`, small pull request to `main`, then `/spec` again | the plan and the spec |
| Build | a criterion cannot be met as written | judgement | product owner, unless it is a plain fact | Claude stops. Small pull request `Spec amendment: …` to `main`; the plan is updated in the same commit as the code that follows | the build, until it is merged |
| Build | the plan's steps are wrong but the spec holds | fact | engineer | `plan.md` changed in the same commit as the code, Decisions line; `/build-plan` does this itself | nothing |
| Build | a step's test stays red after two tries | code | engineer | `/build-plan` stops, commits nothing, names the criterion and the test; the engineer decides | the step, until it is green |
| Build | verify says FAIL on a criterion | code | engineer | the FAIL is reported with its reason, not fixed in the same breath; the code is fixed, not the spec | the pull request, until every line says PASS |
| After the spec is merged | the tester finds a criterion nobody can check from outside | judgement | engineer, with the tester | `/spec-testplan` opens a small pull request `Spec amendment: test plan for …` | the plan, until it is merged |
| Review | a criterion is not met by the code | none of the above | engineer | the code is fixed, not the spec | the merge |

The skills carry the detail: the spec skill has the table of who decides by
kind of problem; the intent skill has the steps for changing an accepted
intent; the spec-testplan skill has the tester's small pull request; the
build-plan skill fixes a plan fact in the same commit and stops on a
judgement.

## Who accepts what

**Intents are accepted by the product owner**, in the chat, before hand-in.
The engineer who merges the pull request is not judging the why; they check
the file is in place and says accepted.

**Specs are approved by someone else.** A spec is a small pull request of its
own. Its text carries three tick boxes, one per reader: engineer, product
owner, tester. Each reads, does their part, ticks their box. The pull request
cannot merge while a box is unticked, so the person who finally sets
`Status: accepted` can see that all three have looked. **One approval is
required, from someone other than the person who ran `/spec`.** The product
owner and the tester tick and comment; they do not need to approve. Three required approvals on every spec slows a team
down until people start rubber-stamping, which is worse than one honest read.

Setting `Status: accepted` in the file is the record of that approval. A
small check on every pull request refuses to merge an intent or spec that
still says draft, so a forgotten flip is caught on the pull request, not
weeks later. The same check refuses a spec whose Decisions carry
`Product owner to confirm.` while the product owner's box does not list
them: a box with nothing under it confirms nothing.

## What a good intent looks like

- Says what is wrong and how we know: a ticket count, a query, a report.
- Says what the world looks like when it is fixed, in one or two sentences a
  user would recognise. No implementation.
- Says what is deliberately out of scope.
- Either names a measurable success signal or says plainly that none is
  known.

## What a good spec looks like

- Numbered criteria, each one observable from outside the code.
- Every existing field, route or component it names carries a `file:line`.
  Things the feature will create are marked `NEW`.
- A Policy constraints section that cites the house rule each constraint
  came from.
- A Test plan naming the checks that must be green.
- Nothing the intent did not ask for.

## Small changes

Not everything needs the chain. A typo, a dependency bump, a one-line fix:
write "small change — no artifact" in the PR and go. If you find yourself
wanting a plan, it is not a small change.

## When something feels wrong

The process improves itself, but only if you say so. When an engineer's
session notices a skill is missing something, it says two lines: "Skill gap
noticed: … Want a patch?" Say yes and the skill is patched and a case is added
to `eval/config/cases.ts` in the same change; say no and nothing happens. A
product owner's session never asks this. A correction
that was painful enough to remember becomes a golden test case in
`eval/config/`, so it cannot come back.
