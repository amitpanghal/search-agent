---
name: spec
description: >
  Turn an accepted intent.md into a spec.md with numbered acceptance criteria
  and a policy-constraint pass over this repo's policy skills. Use when the
  user says "/spec", "write the spec for <intent>", "spec this out", or after
  an intent created by /intent or the maintain loop is accepted. The spec's
  acceptance criteria are what the automated PR review (REVIEW.md Pass 3)
  checks diffs against, so every field, type, route or component a criterion
  names must be GROUNDED in the code (grep it, cite file:line) — the intent's
  prose is not a schema, and an AC that cites a field nobody defined stalls
  plan mode one stage too late. ALSO covers what to do when plan mode,
  implementation or review finds a criterion wrong: amend spec.md first,
  record it under ## Decisions, and route the call by defect kind. ALSO
  covers the checkability pass every AC must survive before the spec is
  accepted — the four shapes that read as criteria but cannot be verified
  from outside the code (diff-only wording, test-only behaviour, process
  claims, post-launch measurement) and the rewording for each. ALSO use when
  a spec links a Claude Design canvas: read the canvas with DesignSync BEFORE
  writing criteria and diff it against them before flipping Status to
  accepted — it is non-normative, it drifts, and REVIEW.md Pass 3 never sees
  it. ALSO use when an intent constraint says something does NOT exist yet
  (an asset, a helper, a route) and scopes in producing it — an absence claim
  is grounded with `find`/`ls` over the asset directories, not a code grep,
  which returns nothing for an unreferenced file that is sitting right there.
  Human-initiated only — there is deliberately NO CI trigger for spec
  generation.
compatibility: Repos with an intent/ directory at the root (this template).
metadata:
  version: "1.13"
---

# /spec — write the spec for an intent

Create `spec.md` next to a given `intent/<slug>/intent.md`, from
`intent/_templates/spec.md`.

## Procedure

1. **Read the target `intent.md` in full.** If its Status is not `accepted`,
   confirm with the user before speccing a draft.
2. **Mandatory constraint pass.** Read, in full, the SKILL.md of every policy
   skill whose domain the intent touches, per this mapping (multiple rows
   usually apply; "any code" always does):

   | Intent touches | Read `.claude/skills/…/SKILL.md` |
   |---|---|
   | any code at all | `code-conventions` |
   | anything under `src/resolver/` — a stage, a prompt, `schema.ts`, the grounder, the shared types | `resolver-pipeline` |
   | a model, prompt or schema change that must pass the ship gate, or the gold set itself | `eval` |
   | entity grounding, a sport's catalog, `sports.ts` overrides, the scope-alias files | `catalog` |
   | a claim about why a query resolved the way it did (the evidence for the intent or a criterion) | `probe` |

   The table lists the current policy skills, but treat it as a floor, not a
   ceiling: scan `.claude/skills/` for any newer skill whose description
   matches the intent's domain before declaring the pass complete.

   Distill every applicable rule into the spec's **Policy constraints**
   section, each cited by skill name and by the rule's **name**, never by
   its number: "code-conventions, the smallest-diff rule", not "code-conventions
   rule 6". Numbers shift when a rule is added or removed and mean nothing
   to a reader; the bold lead-in of each rule is its name. The same applies
   in the chat summary and in the `## Decisions` entries. Flag conflicts
   between the intent and a policy explicitly — the user resolves them
   before the spec is accepted, not the implementer later.
   If code-conventions has no project rules yet (the template ships it
   empty), say so in one line in the chat and in the Policy constraints
   section — *"code-conventions has no project rules yet; see the guide's
   'Before the first feature'"* — instead of leaving the section silently
   empty. An empty section with no reason reads as "nothing applies".
3. **If a design canvas exists, read it BEFORE writing criteria.** A linked but
   unread canvas is worse than no link: it reads as "settled somewhere else"
   and leaves the spec parked in `draft` behind placeholder OPEN values.

   - **How to read one.** `DesignSync` `list_files` then `get_file`, with the
     uuid from the canvas's `/design/p/<uuid>` URL as `projectId`. The
     `Artifact` tool **refuses** that URL — it only accepts
     `…/code/artifact/<uuid>`, which a canvas does not have. Needs
     `/design-consent` once per session; `/design-login` is not available in a
     non-interactive session.
   - **Transcribe, don't cite.** Pass 3 reads `spec.md` and nothing else, so a
     number that lives only on the canvas is invisible to review. Move each
     value into the criterion it feeds, and leave behind a resolved table
     saying *which* criterion now carries it.
   - **Diff in three directions, because canvas and spec drift both ways:**
     values the canvas settles that the spec left open; **criteria added after
     the canvas was drawn** — it will be silent on them, and silence is absence
     of design, never assent; and canvas prescriptions that *contradict* a
     criterion or an intent non-goal.
   - **Record the read** in the spec header (`Canvas read: <date>`, file name,
     artboard count). That is what tells the next reviewer "settled on the
     canvas" from "nobody opened it".
   - **Never let an implementer resolve a conflict silently.** Contradictions
     go in a *Decisions to settle* section with a recommendation each, and the
     spec stays `draft` until they close — same rule as step 2's policy
     conflicts.
   - A canvas is hand-authored static HTML: not your real component theme, not
     your real breakpoints, no real data. It never satisfies a criterion that
     needs a layout engine or a production build.
4. **Write the acceptance criteria** — numbered, each independently checkable
   from the diff plus a running session. These are consumed verbatim by
   REVIEW.md Pass 3, so vague criteria produce vague reviews.

   **Ground every EXISTING name in the code.** Any field, type, prop, API
   route, component, env var or table an AC cites as already there must exist
   in the checkout: grep it and put the `file:line` in the AC (e.g.
   "`Team.shortCode`, `types/team.ts:6`"). If the intent's prose names
   something that does not exist, do NOT carry the name into the AC as if it
   did — write what the code actually has and note the substitution in the
   spec's Summary. The intent is written by a person from memory; it is not
   a schema.

   Things the feature will CREATE are named freely — that is what the
   Affected surfaces and Data / API contracts sections are for — but marked
   so a reader can't mistake them for existing code: "`NEW`
   `components/LiveTracker.tsx`", "`NEW` field `Fixture.trackerState`". The
   rule is about which names claim to exist, not about how many exist.

   *(Origin: a spec whose AC 2 said "prefer the API's `short_name`" when the
   only real field was a 3-letter `short_code`. Plan mode had to stop and ask
   a three-option question; a grep at spec time would have caught it.)*

   **Ground ABSENCE claims too.** A constraint of the form "no X exists yet,
   producing it is in scope" is a claim about the repo and gets the same check
   as a name — but a different command. A code grep proves only that nothing
   *references* X; an asset, a template or a helper can sit unreferenced in
   `public/`, `assets/` or `lib/` and still be exactly what the intent wants.
   Look for the file itself:

   ```bash
   find public assets -iname '*<term>*'      # assets: by name, not by reference
   grep -rln '<term>' lib components app     # code: a helper nobody imports yet
   ```

   If it exists, the scope shrinks: drop the production work from the spec,
   note the substitution in the Summary, and record it under `## Decisions` as
   a factual call (engineer decides). Check this BEFORE writing the criteria
   that would have consumed the new artefact — an AC that budgets for
   producing something that already exists is as wrong as one that cites a
   field nobody defined.

   **When the check leaves nothing to build, do not pad criteria.** Write one
   criterion that states the existing artefact and its verifiable properties
   (path, format, what it renders as), put everything else under Out of scope
   and Decisions, and say in the Summary that this spec records existing state
   and asks for no diff. If the whole intent is satisfied, say so and point
   back to `/intent` for whatever remains. A criterion invented to give the
   spec something to check is worse than a short spec.

   *(Origin: an intent asked for a logo that already existed and a header
   nobody had defined. After both dropped out, the skill had no shape for
   "nothing left to build" and the spec improvised a scope statement as a
   criterion.)*

   *(Origin: an intent stated that no ball-only logo asset existed and scoped
   in producing one from the PWA icon. One `find public -iname '*logo*'` found
   two, transparent and correctly tinted, referenced by no code — which is why
   every grep had missed them. One command removed a work item.)*

   **4a. Checkability pass — every AC needs an observation AND a test.**
   Before showing the draft, write next to each criterion (in your head or in
   the message, not in the file) the manual step a tester would take and the
   automated test that proves it. An AC with neither is not an AC. Four shapes
   read as criteria and fail this pass; each has a fixed rewording:

   | Shape | Tell | Reword to |
   |---|---|---|
   | Diff-only wording | "no longer calls X", "byte-for-byte unchanged", "never uses `x-uuid`" | the observable: a status code, a stored record, a response header, rendered copy, a counter that does or does not move |
   | Test-only behaviour | a failure mode the outside cannot produce (an outage on one dependency while an earlier one keeps working) | keep the behaviour, name the unit/route test as the proof, say "not a manual session" |
   | Process claim | "watched failing before restore", "grepped before deletion" | require the evidence be pasted in the PR body (the failing output, the grep command + result) |
   | Post-launch measurement | "conversions increase over 30 days" | deliver the query itself (bounded, internal traffic excluded) as the AC; the comparison goes back to the intent's Success signal |

   An AC that mixes a behaviour with implementation notes (file, helper,
   library) splits into the behaviour and a "How" sub-bullet — Pass 3 checks
   the behaviour; the notes are guidance for plan mode. Ambiguous counting
   words ("once per render") get a concrete event ("once per blocked response
   received; re-renders do not re-emit").

   *(Origin: a verification-matrix pass run AFTER acceptance flagged 11 of 22
   ACs — six diff-only, three test-only, two process/measurement — and every
   one had to be reworded in a Decisions entry. Running this pass before
   "propose, then confirm" costs minutes; after acceptance it costs a second
   review round.)*
5. **Fill the remaining sections** (surfaces, contracts, test plan, out of
   scope). The test plan names which loop must be green: unit tests, type
   check, verification by hand where a person can observe it (a screen, a
   request and its response, a message), evals.
6. **Decisions first, in plain words. Then the draft.** If the pass above
   left anything for a person to settle — a policy conflict, a name the code
   does not have, a canvas contradiction — do NOT bury it inside the draft.
   Before writing any markdown, ask in the chat, one decision at a time,
   using the structured question tool when it is available (one screen per
   decision, options as buttons):
   - one sentence on what the intent asked for and what the code actually
     has, in words a product owner uses (no field names unless quoted);
   - each option in ONE line, plus one line of cost; recommended one first.
     The long reasoning behind an option does not go in the chat — it goes
     into the file's `## Decisions` entry once the person has chosen.
   - the one question: *"Which do you choose?"*
   Wait for the answer. Then fold it into the draft and record it under
   `## Decisions`. The draft is for the file; the question is for the person,
   and a person should never have to search a raw markdown block for it.

   **A decision the product owner has not made yet ends with a fixed marker.**
   Some choices are the engineer's to make on the facts but change what a
   player sees or how far the feature reaches: the exact wording of a
   message, whether a boundary value counts as inside or outside, which
   languages the copy comes in. When the product owner is not in the chat to
   choose, the engineer chooses, records it under `## Decisions`, and ends
   the entry with exactly: **`Product owner to confirm.`** Never a loose
   phrase like "should confirm at acceptance"; the marker is what the
   hand-in step and the draft check look for. Step 7 lists every marked
   decision under the product owner's box in the pull request, so their
   tick confirms these lines and not only "nothing beyond the intent".

   *(Origin: the first sandbox spec had three such lines, "the product owner
   should confirm at acceptance". The pull request's product owner box did
   not mention them, everyone ticked, the spec merged as accepted, and no
   record says anyone confirmed them.)*

   *(Origin: a spec that caught an invented field name correctly, then put
   the three options under "Decisions to settle" near the bottom of a long
   draft and asked "pick A, B or C above". The PO could not find them.)*

   **Write the draft to the file, then summarise in the chat.** With the
   decisions settled, write `spec.md` at once with `Status: draft`. Do NOT
   paste the draft into the chat — the file is where a person reads a
   document, in the editor beside the chat or rendered on GitHub, and it is
   the same file the reviewer will read. In the chat, give at most six lines:
   - what the spec asks for, one sentence;
   - how many acceptance criteria;
   - which decisions were taken (one line each, pointing at `## Decisions`);
   - what was left out of scope, one line;
   - the file path as a link;
   - *"Read it there. Then: accept, or tell me what to change."*
   On a change request, edit the file and name the section that changed —
   still no paste. On accept, go to the next step. The person has read the
   whole spec; they read it once, in the file, instead of twice.
7. **Offer to hand it in for review, in plain words.** Ask exactly one
   question: *"Shall I put this on a branch and open a pull request for
   review?"* On yes:
   - `git fetch`, cut `spec/<slug>` from `origin/main`;
   - commit only `intent/<ticket>-<slug>/spec.md`, message
     `spec: <short name>`;
   - push, then open the pull request against `main` titled
     `Spec: <short name>`. The body links the intent directory and carries
     exactly these three tick boxes, one per reader, so everyone can see who
     has looked — the draft check refuses to merge while one is unticked:

     ```markdown
     Three readers, each ticks their own box when done:

     - [ ] Engineer: every criterion is technically true and buildable
     - [ ] Product owner: I confirm the decisions listed below; nothing beyond the intent, nothing against its non-goals
       - <one line per `## Decisions` entry that ends with "Product owner to confirm.", in the file's order; or the single line "no decisions wait for the product owner">
     - [ ] Tester: every criterion can be checked from outside; Test plan filled in

     Then one approval from someone other than the author, who sets
     Status: accepted on this branch before merging.
     ```
     The lines under the product owner's box are the spec's own marked
     decisions, copied, not reworded. The draft check refuses to merge a
     spec that carries the marker while the box still has the old wording,
     so the product owner's tick always covers the decisions.
   - report the link and stop. Never flip Status yourself, never tick a box.
8. Next step, once the spec is merged accepted: a plan-mode session on a
   feature branch producing `plan.md` in the same directory as its first
   commit.

## When something is found wrong

Same section in every skill of the loop; the full picture is the table in
`docs/GETTING-STARTED.md`. This skill owns the spec, so its table says who
decides for each kind of defect in the spec.

Plan mode, the implementation, or the review will sometimes surface a
criterion that is wrong. The spec is what Pass 3 checks the diff against, so
**the spec is amended first — never worked around silently.** Fix the
criterion in place and add a dated entry under `## Decisions` saying what
changed and why. Where the amendment travels depends on the kind of defect,
and this table says the same as the plan-spec and build-plan skills:

| Defect | Example | Kind | Decides | Goes to |
|---|---|---|---|---|
| Factual error about the code | the criterion names a field that does not exist | fact | engineer, on the spot | the criterion amended on the branch you are on, Decisions entry; from a plan session it is step 1 of the plan, committed before any code |
| Ambiguous or conflicting behaviour | two criteria cannot both hold on mobile | judgement | product owner | Claude stops. While the spec pull request is still open: amend it there, the product owner's box covers it. After the spec has merged: its own small pull request `Spec amendment: <short name>` to `main`, cut from `main`, only `spec.md` changed, with the reader boxes; the plan or build waits for the merge |
| Policy conflict | a criterion wants what a policy skill forbids | fact | engineer, citing the skill | Policy constraints + Decisions entry, on the branch you are on |
| The intent's outcome is wrong | the fix reveals the desired outcome is off | judgement | product owner, back to `/intent` | `intent.md` changed with `/intent intent/<folder>`, then `/spec` again |

Plan mode cannot edit files, so from a plan session a fact becomes
**step 1 of the plan** ("update spec.md criterion n and add the Decisions
entry; commit before any code change"), and `plan.md` records the choice
too. A judgement from a plan session stops the plan until the amendment
pull request merges.

## Tell Jira where the feature is

Jira is where the product owner and the team look, so every step writes two
short comments on the feature's ticket. The ticket key is the `Jira:` line in
`intent.md`. If that line says `none`, skip this section silently.

- **At the start**, when the intent has been read and before any decision is asked, add a comment:
  `Development loop · Stage 2 Design · spec started · <your name> · <yyyy-mm-dd>`.
  This is what stops two people from starting the same step: whoever opens
  the ticket sees it before any branch is pushed.
- **At hand-in**, right after the spec pull request is opened (step 7), add a comment:
  `Development loop · Stage 2 Design · spec handed in · <pull request link>`.

Use the Atlassian connector's add-comment tool. If the connector is not in
this session, say one line — *"Jira not updated: no Atlassian connector in
this session"* — and continue; the comment is a courtesy, never a gate.
Never change the ticket's status or description here; comments only.

## Don't

- Don't cite a field, type, route or component in an AC as existing unless
  you found it in the codebase this session — grep first, cite `file:line`;
  mark what the feature will create as `NEW`.
- Don't carry an intent's "X does not exist yet" into scope on a code grep
  alone — `find` the file by name in `public/`/`assets/` first; an
  unreferenced asset returns zero grep hits while sitting on disk.
- Don't let a later stage build to an interpretation the spec doesn't state;
  amend the spec, then build.
- Don't skip the constraint pass or cite a skill you didn't read this session.
- Don't ship an AC you cannot name a manual observation AND a test for —
  "no longer calls X" is a diff note, not a criterion (step 4a).
- Don't write criteria around an unread canvas, and don't treat a canvas as
  verification — screenshotting an artboard proves as little as screenshotting
  a control that never mounted.
- Don't ask a person to choose between options they have to scroll a raw
  markdown draft to find — decisions are asked first, one line each, in
  the chat (step 6).
- Don't paste the spec draft into the chat. Write the file, summarise in six
  lines, point at the file (step 6).
- Don't write code or plan.md — this skill ends at spec.md and its pull
  request.
- Don't push to `main`, and don't set `Status: accepted` — the reviewer does,
  on the pull request.
- Don't leave a decision the product owner has not made under a loose phrase
  ("should confirm at acceptance"); end it with `Product owner to confirm.`
  and list it under their box at hand-in (steps 6 and 7).
- Don't wire spec generation into CI; it stays human-triggered.
