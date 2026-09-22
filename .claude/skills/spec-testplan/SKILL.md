---
name: spec-testplan
description: >
  The tester's pass over a spec: for every numbered acceptance criterion,
  write the manual steps a tester would follow and the automated test that
  would prove it, flag any criterion that cannot be checked from outside the
  code, and write the result into the spec's "Test plan" section on the spec's
  own branch. Use when the user says "/spec-testplan intent/<slug>",
  "/spec-testplan", "write the test plan for <spec>", "tester's review of the
  spec", or when a tester has been asked to tick their box on a spec pull
  request. Works on spec.md only — never on intent.md or plan.md, never on
  code. Ends by telling the tester to tick the Tester box on the pull request.
compatibility: Repos with an intent/ directory at the root (this template).
metadata:
  version: "1.7"
---

# /spec-testplan — the tester's pass over a spec

The spec has three readers. The engineer checks it is technically true, the
product owner checks it is in scope, the tester checks that every criterion
can be verified from outside the code and writes down how. This skill is the
tester's part. It produces the spec's **Test plan** section and nothing else.

## Procedure

1. **Find the spec.** The argument is a feature folder, `intent/<ticket>-<slug>`.
   The spec is `spec.md` inside it. If no argument was given, list the specs
   whose pull request is open (branches named `spec/*` on origin) and ask
   which one. If the folder has no `spec.md`, say "run /spec first" and stop.
2. **Get on the right branch, silently.** `git fetch`. If a branch `spec/<slug>`
   exists on origin, switch to it and pull; that is where the spec is under
   review. If the spec is only on `main` and already says `Status: accepted`,
   say one sentence: *"This spec is accepted, so the Test plan lands as a
   small amendment pull request of its own. Continue?"* On yes, cut
   `spec/<slug>-testplan` from `origin/main` and carry on with the SAME steps
   below — write locally, wait for accept, then commit and open the pull
   request. The amendment path skips nothing. Never ask the tester which
   branch they are on.
   **If the switch fails with `fatal: 'spec/<slug>' is already used by
   worktree at <path>`**, the spec branch is checked out in another worktree
   (the spec was written there, or another session holds it). This is the
   AGENTS.md rule "a branch already used by another worktree": do not move
   to that worktree, do not remove it, and do not ask; cut a local branch
   under another name from the remote and work here,
   `git switch -c testplan/<slug> origin/spec/<slug>`. Step 8 then pushes it
   onto the spec branch with `git push origin HEAD:spec/<slug>`. Tell the
   tester in one line that this happened; the result on origin is the same.
3. **Read the spec in full**, then the intent it links, then the code the
   criteria cite (the `file:line` references). Do not read `plan.md` even if
   it exists; the test plan is written against the spec, not the plan.
4. **For every numbered acceptance criterion, write two things:**
   - *Manual check*: the steps a person takes to observe it: on which screen,
     or with which request and what response, or which log line or message;
     with which input, and what they must observe. Concrete values, not
     "verify it works". A backend service has no screen; a request and its
     response, or a message on a queue, is its surface.
   - *Automated test*: the test file and test name that proves it, existing or
     to be written, and what it asserts. If the project's test runner is named
     in `AGENTS.md`, name the command that runs it.
   A criterion that has neither is not checkable. Do not invent a check for
   it; flag it (step 5).
5. **Flag what cannot be checked from outside.** For each flagged criterion,
   propose a rewording that can be observed, in one line, and stop before
   writing the file: the rewording is a spec amendment and the engineer owns
   the spec. Ask, in the chat, one criterion at a time: *"Criterion N cannot be
   checked from outside. Reword to: <one line>. Apply?"* On yes, apply it to
   the criterion and add a dated line under `## Decisions` ("reworded for
   checkability; decided by: tester"). On no, leave it and note it in the Test
   plan as "not checkable from outside — engineer to decide".
6. **Write the Test plan section.** Replace the placeholder (or the previous
   content) of `## Test plan` in `spec.md` with:
   - the loop that must be green before "done": the exact commands;
   - one entry per criterion: number, manual check, automated test;
   - flagged criteria, if any, with their status.
   Keep the rest of the file untouched. Do not change `Status`.
7. **Summarise in at most five lines in the chat, then wait.** How many
   criteria, how many have both checks, how many were reworded, how many remain
   flagged, and the file link. Then: *"Read it there. Then: accept, or tell me
   what to change."* The file is written locally and nothing is committed yet.
   The tester reads the Test plan in the editor beside the chat. On a change
   request, edit the file, name the section that changed, and ask again.
8. **On accept, commit on the spec's branch and push.** One commit, message
   `spec: test plan for <short name>`. Only `spec.md` is staged. On the
   other-worktree path of step 2 the push is
   `git push origin HEAD:spec/<slug>`; the local branch name never reaches
   origin.
   - On the normal path the spec's pull request already exists: say
     *"Pushed. Tick the Tester box on the pull request."*
   - On the amendment path, open the pull request against `main` titled
     `Spec amendment: test plan for <short name>`, body linking the intent
     directory and carrying the same three reader boxes the spec skill writes
     (engineer, product owner, tester) — the draft check refuses to merge
     without them. Then say the same sentence.
   Never tick a box yourself.
9. **Name rules, never numbers.** When the Test plan or the chat cites a house
   rule, use its name ("the smallest-diff rule", or whatever the project's
   rule is called),
   never "rule 5". Numbers shift; names carry meaning.

## Tell Jira where the feature is

Jira is where the product owner and the team look, so every step writes two
short comments on the feature's ticket. The ticket key is the `Jira:` line in
`intent.md`. If that line says `none`, skip this section silently.

- **At the start**, when the spec has been read, add a comment:
  `Development loop · Stage 2 Design · test plan started · <your name> · <yyyy-mm-dd>`.
  This is what stops two people from starting the same step: whoever opens
  the ticket sees it before any branch is pushed.
- **At hand-in**, right after the push (step 8), linking the spec pull request, add a comment:
  `Development loop · Stage 2 Design · test plan handed in · <pull request link>`.

Use the Atlassian connector's add-comment tool. If the connector is not in
this session, say one line — *"Jira not updated: no Atlassian connector in
this session"* — and continue; the comment is a courtesy, never a gate.
Never change the ticket's status or description here; comments only.

## When something is found wrong

Same section in every skill of the loop; the full picture is the table in
`docs/GETTING-STARTED.md`. Here: only what this skill does.

| You find | Kind | What the skill does |
|---|---|---|
| a criterion cannot be checked from outside the code | judgement, engineer with the tester | ask before rewording; reword it with the tester, Decisions line in `spec.md`; if the spec is already merged, the small pull request `Spec amendment: test plan for …` |
| a criterion has no possible automated test | fact | the Test plan says *no test — needs one before this is done*; never hidden |
| the spec is already merged and accepted | amendment | a small pull request of its own with the three reader boxes, never a commit on `main` |
| the spec's branch cannot be found | setup | say so and stop |

## Don't

- Don't touch `intent.md`, `plan.md`, tests or code — this skill writes one
  section of `spec.md`.
- Don't paste the Test plan into the chat; write it to the file and summarise.
- Don't change a criterion without the yes in step 5.
- Don't set `Status`, and don't tick any box on the pull request.
- Don't commit or push before the tester has said accept (step 8) — on the
  amendment path too.
- Don't cite a house rule by number (step 9).
- Don't ask the tester about branches, commits or pushes; steps 2 and 8 handle it.
