---
name: plan-spec
description: >
  Turn an accepted spec.md into a committed plan.md — the "how" of the
  intent → spec → plan chain. Use when the user says "/plan-spec
  intent/<slug>", "/plan-spec", "plan the spec for <feature>", "make the
  implementation plan", or when a spec has just been merged with Status:
  accepted and the engineer wants to start building. Enters plan mode through
  the EnterPlanMode tool, reads intent, spec and Test plan, maps EVERY
  acceptance criterion to the files that change and the test that proves it,
  raises spec defects before drafting, and on approval cuts the feature branch
  and commits plan.md before any code. Writes no code; the build step comes
  after.
compatibility: Repos with an intent/ directory at the root (this template).
metadata:
  version: "1.3"
---

# /plan-spec — from an accepted spec to a committed plan

The plan is the third file in the feature folder: intent (why), spec (what),
plan (how). This skill produces it and commits it before a single line of code
changes, so the plan is a file on the branch and not a memory in the chat.

## Procedure

1. **Find the spec.** The argument is a feature folder, `intent/<ticket>-<slug>`.
   If no argument was given, list the folders whose `spec.md` says
   `Status: accepted` and have no `plan.md`, and ask which one. `git fetch`
   and pull `main` first. If `spec.md` is missing or not accepted, stop:
   *"The spec is not accepted yet — finish the spec review first."* If
   `plan.md` already exists, ask: *"A plan exists. Replace it?"* and stop on no.
2. **Enter plan mode by calling the `EnterPlanMode` tool.** Do not draft
   anything before the tool has been called; plan mode is what makes this step
   read-only and gives the engineer the approve step at the end. Then read, in
   this order: `intent.md`, `spec.md` including its Test plan and Decisions,
   every file the criteria cite by `file:line`, and `AGENTS.md` for the check
   commands.
3. **Spec defects first, in plain words.** If a criterion is wrong, ambiguous,
   or more expensive than it looks, ask before drafting — one question at a
   time, using the structured question tool when available, options as
   one-line buttons with one line of cost each. A factual error about the code
   is the engineer's call and becomes step 1 of the plan ("amend `spec.md`
   criterion N, add the Decisions line, commit before any code"). A scope or
   outcome question belongs to the product owner: say so and stop.
4. **Draft the plan** with exactly three parts:
   - **Steps**, numbered, the smallest change that satisfies the criteria, no
     refactor the spec did not ask for. Each step names the files it touches.
     **A step that creates a module creates its test file in the same step.**
     Never the module in one step and its tests in a later one: the build
     shows each new test failing before the code that makes it pass, and a
     test written against a module that already exists passes at once, so
     nobody ever sees it red. Module and tests together, each step goes red,
     then green, and ends in one commit. *(Origin: the first sandbox plan put
     `balance.ts` in step 1 and `balance.test.ts` in step 2; the six tests
     passed on first run and the failing-first rule never fired.)*
   - **Criteria to proof**: one line per acceptance criterion — its number, the
     files that change for it, the test that proves it (file and test name,
     taken from the spec's Test plan where it has one). A criterion with no
     test gets the line *"no test — needs one before this is done"*; never
     hide it.
   - **Checks**: the commands from `AGENTS.md` that must be green.
   Cite house rules by name, never by number.
5. **Ask for approval** through plan mode's own approve step. In the chat, at
   most six lines: what changes, how many steps, how many criteria have a
   test, which have none, and *"Approve, or tell me what to change."* Iterate
   until approved. Nothing is written or committed yet. Plan mode ends with
   more than one approve button; tell the engineer once: *"Pick the one that
   keeps the context and asks before edits. Whichever you pick, this skill
   commits `plan.md` and stops; no code is written in this session."*
6. **On approval, make the plan real.** Cut `feature/<slug>` from
   `origin/main`; write the approved plan verbatim to
   `intent/<ticket>-<slug>/plan.md`; commit only that file, message
   `plan: <short name>`; push. If step 3 produced a spec amendment, commit that
   first, as its own commit, on the same branch.
7. **Stop with one line:** *"Plan committed on `feature/<slug>`. Next:
   `/build-plan step`, one plan step per commit, or `/build-plan all`."* Do
   not start implementing.

## Tell Jira where the feature is

Jira is where the product owner and the team look, so every step writes two
short comments on the feature's ticket. The ticket key is the `Jira:` line in
`intent.md`. If that line says `none`, skip this section silently.

- **At the start**, when intent, spec and Test plan have been read (step 2), add a comment:
  `Development loop · Stage 3 Build · plan started · <your name> · <yyyy-mm-dd>`.
  This is what stops two people from starting the same step: whoever opens
  the ticket sees it before any branch is pushed.
- **At hand-in**, right after `plan.md` is committed and pushed (step 6), linking the branch since no pull request exists yet, add a comment:
  `Development loop · Stage 3 Build · plan handed in · <pull request link>`.

Use the Atlassian connector's add-comment tool. If the connector is not in
this session, say one line — *"Jira not updated: no Atlassian connector in
this session"* — and continue; the comment is a courtesy, never a gate.
Never change the ticket's status or description here; comments only.

## When something is found wrong

Same section in every skill of the loop; the full picture is the table in
`docs/GETTING-STARTED.md`. Here: only what this skill does.

| You find | Kind | What the skill does |
|---|---|---|
| a criterion names something that does not exist in the code | fact | step 1 of the plan: fix `spec.md`, Decisions line, commit before any code |
| two criteria conflict, or the spec goes beyond the intent | judgement | one question with options; if it is the product owner's call, say so and stop; the fix is a small pull request `Spec amendment: …` to `main` with the reader boxes and a dated line under the spec's `## Decisions`, and the plan waits for the merge |
| the intent itself is wrong | judgement | stop; the product owner runs `/intent intent/<folder>`; then `/spec` again, then this skill again |
| a criterion has no test in the Test plan | fact | the plan's *Criteria to proof* line says *no test — needs one before this is done* |
| the engineer wants code in the same session | scope | no; this skill ends at the `plan.md` commit, `/build-plan` is the next step |

## Don't

- Don't write, edit or generate any code — this skill ends at `plan.md`.
- Don't draft outside plan mode; call `EnterPlanMode` first (step 2).
- Don't paste the plan into the chat; the file is the reading surface.
- Don't build to an interpretation the spec does not state; amend the spec
  first (step 3).
- Don't commit before approval, and don't let any code change land before the
  plan commit.
- Don't ask the engineer about branch names or commit messages; step 6 handles it.
- Don't cite a house rule by number.
- Don't put a new module in one step and its test file in a later one; they
  share a step (step 4).
