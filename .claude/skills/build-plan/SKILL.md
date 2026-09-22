---
name: build-plan
description: >
  Turn a committed plan.md into code, one plan step at a time or all steps
  in one run — the Build half of the intent → spec → plan → build chain.
  Use when the user says "/build-plan", "/build-plan step", "/build-plan
  step 3", "/build-plan all", "/build-plan verify", "implement the plan",
  "build the plan", "start building", "next step", or is on a
  feature/<slug> branch whose intent folder has a committed plan.md and
  wants to write the code. Reads intent, spec (criteria and Test plan) and
  plan (Steps, Criteria to proof, Checks); implements only the files a step
  names; runs the tests the plan maps to that step; commits one step per
  commit so the git log is the record of progress; never ticks anything off
  in plan.md; ends with a PASS/FAIL verification per acceptance criterion
  and the offer to open the pull request. Does NOT write intent, spec or
  plan; a wrong plan or spec is routed, never worked around.
compatibility: Repos with an intent/ directory at the root (this template).
metadata:
  version: "1.4"
---

# /build-plan — from a committed plan to code

The plan is the last file before code. This skill turns it into code in the
smallest reviewable pieces — one plan step per commit — and finishes with a
verification against the spec, so the pull request carries proof, not hope.

Two modes, one word:

| Typed | What happens |
|---|---|
| `/build-plan step` | the next step not yet committed; show, test, commit, stop |
| `/build-plan step 3` | that step |
| `/build-plan all` | every remaining step in order, one commit each, then verify |
| `/build-plan verify` | only the PASS/FAIL per criterion, no code |

No mode given: ask one question, two options, `step` first and recommended.
Step mode is the default for a team's first features; `all` when the team
has seen a few specs turn into correct code.

## Procedure

1. **Find the feature.** From the argument `intent/<ticket>-<slug>`, or from
   the current branch `feature/<slug>`. Require: on `feature/<slug>`, with
   `intent/<ticket>-<slug>/plan.md` committed. If not, stop with one line:
   *"No committed plan on this branch. Run `/plan-spec intent/<slug>`
   first."* Never build from a plan that exists only in the chat.
   If `git switch feature/<slug>` is refused with `fatal: 'feature/<slug>' is
   already used by worktree at <path>`, the plan session's worktree still
   holds the branch: follow the AGENTS.md rule "a branch already used by
   another worktree". `git switch -c build/<slug> origin/feature/<slug>`,
   build here, and every step's push is `git push origin HEAD:feature/<slug>`.
   Do not move to that worktree, do not remove it, do not ask; say in one
   line that it happened.
2. **Read four things**, in full: `intent.md`, `spec.md` (the numbered
   criteria and the Test plan), `plan.md` (Steps, Criteria to proof, Checks),
   and the check commands in `AGENTS.md`. Then read the git log of the branch
   since it left `main`: every commit `build: step N — …` marks a done step.
3. **Say where we are**, in two lines: *"Plan has M steps; steps 1–K are
   committed. Next: step K+1, <its name>."* Then the Jira comment (below).
4. **Do the step** (step mode does one, all mode loops):
   - Touch only the files the step names. A file the step does not name is
     not touched; if the step cannot be done without one, stop and say so —
     that is a plan fact to fix (step 7), not a liberty to take.
   - Find the tests for this step through files: every line in *Criteria to
     proof* whose files overlap the step's files names the test to run. When
     the step adds a new test, show it **failing first**, then make it pass.
     If a step's new tests pass on their first run because the module they
     test already exists (a plan that split module and tests across steps),
     prove they bite: change one comparison or constant in the module, run
     the tests, show one go red, restore the module, show the diff is empty.
     Say in one line that the plan should have put module and tests in one
     step; it is a plan fact, not a reason to stop.
     When no criterion maps to the step (a shared helper, a type), run the
     full test command from Checks instead.
   - Stage the step's files (`git add <the step's files>`) — a brand-new
     file does not appear in `git diff` until it is staged — then print the
     diff summary (`git diff --cached --stat`) and the test output's last
     lines, pasted as printed — evidence the reader can check, not a
     sentence about it. In step mode ask exactly: *"Commit step K+1?"* On yes, commit
     only the step's files, message `build: step K+1 — <step name>`, push,
     and stop with one line: *"Step K+1 of M committed. Next:
     `/build-plan step`."* In all mode commit without asking and continue.
   - A step that changes no files (a checks step, a manual confirmation)
     makes no commit: say so in one line and go on — to the next step, or
     to verify when it was the last.
   - A red test is fixed within the step's files, at most twice. Still red:
     stop, leave the working tree as it is, and say which criterion and
     which test. Never commit red.
5. **All mode bound.** Stop after every step is committed, or after the
   first step that stays red, or after 25 turns — whichever comes first —
   and report which steps and criteria remain. Nothing is built past the
   plan: when the steps are done, the feature is done; anything more is a
   new intent or a spec change, not more building.
6. **Verify** — automatically when the last step is committed, or on
   `/build-plan verify`: run every command in Checks and print the last 20
   lines of each, pasted as printed, not summarised. Then one line per
   acceptance criterion: `Criterion n — PASS — <test file and name>` or
   `Criterion n — FAIL — <why>` (the full word, never "AC"). FAIL is reported, not
   fixed in this step; the engineer decides. Then say: *"Next:
   `/code-review high`, then I open the pull request."* On yes, open the
   pull request against `main` with the repository's template; the body
   links the intent directory and lists the criteria as tick boxes, ticked
   from the verification. Then the Jira hand-in comment.

   **The tester's pass.** The body also carries a section for the person who
   checks the built feature by hand, since the Test plan's manual checks are
   run by nobody otherwise:

   ```markdown
   ## Tester's pass

   The Test plan in the spec names a manual check per criterion. Run each
   one against this build (the preview for a screen, the running service
   for a request, the log or queue for a message), write what you observed
   on its line, then tick the box. A FAIL is a review finding: the engineer
   fixes it in this pull request, or routes it as a spec defect. Never
   change the Test plan to make a check pass.

   - Criterion 1 — <the manual check, copied from the Test plan> — PASS/FAIL: <what was observed>
   - Criterion 2 — …

   - [ ] Tester: the manual checks from the Test plan run against this build, one line per criterion above
   ```
   One line per criterion, the manual check copied from the Test plan, the
   result left for the tester to fill. Nothing blocks the merge on this box;
   the person who merges reads it. Findings live here, on the pull request,
   not in the feature folder; Jira points at them (below).
7. **When the plan or the spec is wrong**, route by kind, never work around:
   - A **fact** in the plan (a step names the wrong file, a test name has
     moved): change `plan.md` in the **same commit** as the step's code, and
     add a dated line under `## Decisions` in `plan.md`. The playbook's own
     rule: when implementation departs from the plan, update plan.md in the
     same commit.
   - A **judgement** (a criterion cannot be met as written, two criteria
     conflict, the outcome is questioned): stop before the step. This is
     the product owner's call. Say so, name the criterion, and point at the
     spec skill's table; the fix goes to `main` in a small pull request
     `Spec amendment: <short name>` and the build waits for the merge.
   - A criterion that the code simply does not meet yet is neither: fix the
     code.

## Tell Jira where the feature is

The ticket key is the `Jira:` line in `intent.md`; if it says `none`, skip
this section silently. At step 3 add a comment
`Development loop · Stage 3 Build · build started · <your name> · <yyyy-mm-dd>`
(once per branch: skip if a comment with that text already exists). When the
pull request is opened in step 6, add two comments:
`Development loop · Stage 3 Build · build handed in · <pull request link>`
and `Development loop · Stage 4 Test · tester's pass requested · <pull request link>`.
The tester's result stays on the pull request; no session runs when the
tester ticks, so no "done" comment is written until GitHub can talk to Jira
(the maintain loop's connection).
Use the Atlassian connector's add-comment tool. If the connector is not in
this session, say one line — *"Jira not updated: no Atlassian connector in
this session"* — and continue. Comments only; never status or description.

## When something is found wrong

Same section in every skill of the loop; the full picture is the table in
`docs/GETTING-STARTED.md`. Here: only what this skill does.

| You find | Kind | What the skill does |
|---|---|---|
| a step's test stays red after two tries | code | stop, commit nothing, name the criterion and the test |
| a step needs a file the plan does not name, or names a test that has moved | plan fact | change `plan.md` in the same commit as the step's code, Decisions line in `plan.md` |
| a criterion cannot be met as written, or two criteria conflict | judgement | stop before the step; the product owner's call; the fix goes to `main` in a small pull request `Spec amendment: …`, the build waits |
| `all` mode reaches 25 turns | bound | stop, report the steps and criteria that remain |
| verify says FAIL on a criterion | code | report it with the reason, do not fix in the same breath; the engineer decides |
| the branch has no committed `plan.md` | setup | stop: run `/plan-spec` first |
| `feature/<slug>` is checked out in another worktree | setup | the AGENTS.md rule: a local branch under another name from `origin/feature/<slug>`, every push `HEAD:feature/<slug>`, one line to the engineer (step 1) |

## Don't

- Don't build on `main`, or on a branch without a committed `plan.md`.
- Don't touch a file the current step does not name.
- Don't tick steps or criteria off inside `plan.md`; the git log and the
  verification are the record.
- Don't commit a red step, and don't commit code in the same commit as an
  unrelated step.
- Don't let a wrong criterion become code that "does the sensible thing";
  route it (step 7).
- Don't run `/code-review` or open the pull request before the verification
  has run.
- Don't ask the engineer about branch names, commit messages or git
  commands; `/build-plan step`, yes, and `/build-plan all` are the whole
  interface.
- Don't fill or tick the Tester's pass yourself; the lines are for the
  person who checks the build by hand.
