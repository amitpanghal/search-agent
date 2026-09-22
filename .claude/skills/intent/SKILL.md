---
name: intent
description: >
  Capture a feature/fix intent as a version-controlled intent.md artifact —
  the entry point of this repo's plan→spec→build loop. Use when the user says
  "/intent", "capture an intent", "start a feature", "turn this Sentry issue /
  analytics finding / user report into an intent", gives a Jira key or URL
  ("/intent SB-12345"), or hands you a problem statement that should become
  tracked feature work. When a Jira ticket exists it is read first and the
  interview covers only what the ticket does not say; a ticket is optional.
  Produces intent/<ticket>-<slug>/intent.md (intent/<slug>/ when there is no
  ticket) from the template; it does NOT write specs,
  plans, or code — /spec is the next step. ALSO use when the user points at a
  feature folder whose intent is already accepted ("/intent intent/<slug>",
  "change the intent", "the spec found the intent wrong", "the desired
  outcome is off"): the intent is changed in place,
  the change is recorded under ## Decisions, the product owner accepts again,
  and the change travels in the open spec pull request if there is one.
compatibility: Repos with an intent/ directory at the root (this template).
metadata:
  version: "1.9"
---

# /intent — capture an intent artifact

Create `intent/<ticket>-<slug>/intent.md` (`intent/<slug>/intent.md` when there is
no ticket) from `intent/_templates/intent.md`. The artifact records WHY, not HOW.

## Procedure

1. **Gather the problem.** If the user gave a Sentry link, GitHub issue,
   analytics finding, or free-text description, extract from it. Otherwise
   interview — ask only the questions the template needs, in one batch:
   problem + evidence, desired outcome, non-goals, hard constraints, success
   signal.

   **If the user gave a Jira key or URL** (e.g. `SB-12345`, or a
   `…/browse/SB-12345` link), read the ticket first — summary, description,
   acceptance criteria, linked issues, comments — with the Jira tooling
   available in this session (the Atlassian connector's get-issue tool; if
   none is available, say so and ask the user to paste the ticket text). Then:
   - fill every section you can from the ticket, quoting or closely
     paraphrasing it — the ticket is the PO's words, do not improve on them;
   - ask only about the sections the ticket does not cover, marked optional;
   - set the `Jira` line to the key and link back;
   - keep the ticket's own success measure if it has one; if it has none,
     the Success signal says none is known — a ticket is not evidence of a
     metric.
   The intent is the structured, in-repo copy of the ticket that the spec,
   the plan and the automated review can read. It does not replace the
   ticket; it travels with the code.

   **When there is a ticket, read its comments before anything else.** If one starts with
   `Development loop ·`, this ticket is already in the loop: say so, name
   the feature folder the comment points at, and ask whether the user wants
   to continue there (change the intent, run the next step) instead of
   creating a second intent. Two intents for one ticket is the thing to
   avoid.
2. **Name the directory.** With a ticket: `intent/<ticket>-<slug>/`, the Jira
   key exactly as Jira writes it (`SB-194034`, `PD-9207` — any project), a
   dash, and a 2–4 word kebab slug; the key in the path puts the ticket in
   every pull request, link and commit. Without one: `intent/<slug>/`, and the
   `Jira:` line says `none` — every later step then skips its Jira comments.
   **A ticket is optional.** If the user gave no key, ask once: *"Which Jira
   ticket is this for? Say none if there isn't one."* When the Atlassian
   connector is in the session and the user asks for a ticket, create it from
   the problem statement and continue with its key. Then check `intent/`
   against a second intent for the same work: with a key, a folder that
   already starts with it; without, a folder whose slug names the same
   feature. Either means the work is in the loop — go to "Changing an
   accepted intent" below instead of creating a second one.
3. **Fill every template section.** Rules that matter:
   - The observed signal must link real evidence (Sentry permalink, analytics
     query, PR/issue URL). No evidence → say "no hard evidence; based on X".
   - Desired outcome is user-visible and testable, free of implementation.
   - **Never invent a success signal.** If nothing measurable exists, write
     that explicitly in the section.
   - `Source: human` (the maintain loop writes its own with
     `Source: maintain-loop`). `Status: draft`.
   - Leave `## Decisions` empty on creation. It is filled only when the
     intent is changed after acceptance (see below).
4. **Show the draft** to the user. Interview questions are optional: say so,
   and accept "write it as is" as the answer to all of them (unanswered
   sections get "none known"). Apply corrections, write the file.
5. **Ask the product owner to accept it, in the chat.** The intent is the
   PO's own statement of what the business wants; the PO is the only person
   who can accept it. Ask exactly: *"Do you accept this intent as written?"*
   On yes, set `Status: accepted` in the file. On no, take the corrections
   and show the draft again. Never set accepted without that yes.
6. **Offer to hand it in, in plain words.** The user may not use git. Ask
   exactly: *"Shall I hand it in, so an engineer can merge it?"* On yes:
   - `git fetch`, cut `intent/<slug>` from `origin/main`;
   - commit only the feature folder's `intent.md`, message
     `intent: <short name>`;
   - push, then open the pull request against `main` with the title
     `Intent: <short name>` and a body that links the intent directory and
     says: *"Accepted by the product owner. Reviewer: check the file is in
     the right place, reads clearly and says Status: accepted, then merge.
     The why is the PO's call, not the reviewer's."*
   - report the pull request link and stop.
   On no: leave the file in the working tree and say how to hand it in later.
7. **After the merge, tidy up without asking.** When the user says the pull
   request is merged (or asks to continue), switch to `main`, pull, delete
   the local `intent/<slug>` branch and its remote counterpart, and confirm
   in one line: *"Merged and on main. Next: an engineer runs /spec on it."*
   Never ask a product owner whether to delete a branch, merge main into a
   branch, or audit stale branches — they do not know what those words mean,
   and the answer is always the same.
8. Point at the next step: once the intent is merged, run `/spec` on it. Do
   not start speccing or planning unless asked.

## Tell Jira where the feature is

Jira is where the product owner and the team look, so every step writes two
short comments on the feature's ticket. The ticket key is the `Jira:` line in
`intent.md` — for this skill, the key the user gave. If that line says `none`, skip this section silently.

- **At the start**, as soon as the ticket has been read (step 1), add a comment:
  `Development loop · Stage 1 Plan · intent started · <your name> · <yyyy-mm-dd>`.
  This is what stops two people from starting the same step: whoever opens
  the ticket sees it before any branch is pushed.
- **At hand-in**, right after the pull request is opened (step 6), add a comment:
  `Development loop · Stage 1 Plan · intent handed in · <pull request link>`.

Use the Atlassian connector's add-comment tool. If the connector is not in
this session, say one line — *"Jira not updated: no Atlassian connector in
this session"* — and continue; the comment is a courtesy, never a gate.
Never change the ticket's status or description here; comments only.

## Changing an accepted intent

A later step will sometimes find the intent wrong: the spec step finds the
desired outcome is off, the plan step finds a non-goal that the spec has
quietly crossed, a build reveals the problem was misread. The spec skill's
table routes that to the product owner and says "back to `/intent`". This
section is where that instruction lands. The intent is changed **in place**, never
forked into a second folder, so the spec, the plan and the review keep
reading one file.

Triggered by `/intent intent/<ticket>-<slug>` (or plain words pointing at an
existing feature folder) when that folder's `intent.md` says
`Status: accepted`:

1. **Read the file and say what is there**, in three lines: the desired
   outcome, the non-goals, the success signal. Then ask: *"What has changed?"*
   Only the product owner answers; if the person is an engineer relaying a
   finding, say the product owner has to confirm before hand-in.
2. **Change the sections that need changing.** Do not rewrite the rest. Keep
   `Status: accepted` only after the yes in step 4; while editing, leave it as
   it is.
3. **Record the change under `## Decisions`** (add the section at the end of
   the file if the intent predates it): one dated line per change — what
   changed, why, and who asked. This is the audit trail the spec's own
   Decisions section points back to.
4. **Ask the product owner to accept it again**, exactly as in step 5 above:
   *"Do you accept this intent as written?"* On no, take corrections. Never
   hand in a changed intent without that yes.
5. **Hand it in where the readers already are.** Ask, exactly:
   *"Shall I hand it in?"* On yes:
   - **If a spec pull request for this feature folder is open** (`gh pr list`
     finds one whose branch touches `intent/<slug>/spec.md`): commit
     `intent.md` on that branch, message `intent: change — <short reason>`,
     push, and add one line to the pull request text: *"Intent changed, see
     its Decisions. The Product owner box now covers both."* The product
     owner's tick covers the changed intent; no second pull request. If the
     switch to that branch is refused because another worktree holds it,
     follow the AGENTS.md rule "a branch already used by another worktree":
     `git switch -c intent/<slug>-change origin/spec/<slug>`, commit here,
     `git push origin HEAD:spec/<slug>`; never ask the product owner about it.
   - **Otherwise** (nothing open, or only the feature branch exists): cut
     `intent/<slug>-change` from `origin/main`, commit only `intent.md`,
     message `intent: change — <short reason>`, push, open a pull request
     against `main` titled `Intent change: <short name>` with the same
     reviewer note as step 6 above plus: *"Any spec or plan for this folder
     must be re-run against the changed intent."* A plan or build in
     progress waits for this merge; nothing is built against an intent the
     product owner has not re-accepted.
   - report the link and stop.
6. **Point at the next step:** the engineer runs `/spec intent/<slug>` again,
   or amends the open spec, against the changed intent.

A wrong **fact** in an intent (a ticket number, a dead link) does not go
through these steps: fix it in whatever pull request is open, with a Decisions line,
and move on. Changing an accepted intent is for judgement: outcome, scope,
non-goals.

## When something is found wrong

Same section in every skill of the loop; the full picture is the table in
`docs/GETTING-STARTED.md`. Here: only what this skill does.

| You find | Kind | What the skill does |
|---|---|---|
| the spec step, or a later one, finds the desired outcome or the scope wrong | judgement | the change path above: read back, ask what changed, change in place, Decisions line, the product owner accepts again, hand in where the readers are; a plan or build in progress waits |
| a fact in the intent is wrong (ticket number, dead link) | fact | fix it in whatever pull request is open, Decisions line, no second acceptance |
| the ticket is already in the loop (a folder starts with its key, or a `Development loop ·` comment exists) | duplicate | no second intent; point at the folder and offer the change path |
| the ticket has no success measure | none | the Success signal says none is known; nothing is invented |

## Don't

- Don't write spec.md/plan.md or touch code — this skill ends at intent.md
  and its pull request.
- Don't fork a second intent folder to change an accepted intent — change the
  file in place and record it under `## Decisions` (see "Changing an accepted
  intent" above).
- Don't push to `main`.
- Don't set `Status: accepted` without the PO's explicit yes in this chat,
  and don't leave it `draft` after that yes — the PO accepts, nobody else.
- Don't retype a Jira ticket by interview: read it, fill from it, ask only
  about the gaps.
- Don't offer git housekeeping choices (delete this branch? merge main into
  that?) — do the standard thing silently (step 7).
- Don't ask the user for branch names, commit messages or git commands;
  the two yes/no questions in steps 5 and 6 are the whole interface.
- Don't pad sections to look complete; a short honest intent beats a padded one.
- Don't create an intent for trivial changes the user would ship directly —
  suggest skipping the chain instead.
