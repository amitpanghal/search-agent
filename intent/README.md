# Feature artifacts: intent → spec → plan

This directory holds the version-controlled artifact chain for feature work
(the Plan/Design stages of the AI-native SDLC loop):

```
intent/<ticket>-<slug>/          (intent/<slug>/ when there is no ticket)
  intent.md   what problem, for whom, what outcome — the WHY   (/intent)
  spec.md     acceptance criteria + policy constraints — the WHAT (/spec)
  plan.md     implementation plan from plan mode — the HOW
```

## Rules

- **One directory per feature/fix.** With a Jira ticket it is named
  `<ticket>-<slug>`: the key as Jira writes it, then a short kebab name (e.g.
  `SB-194034-betslip-balance-warning`); the key in the path means every pull
  request, link and commit that names the folder names the ticket, and a
  second intent for the same ticket cannot be created without noticing.
  Without a ticket it is named `<slug>` alone and `intent.md` says
  `Jira: none`; every step then skips its Jira comments. A ticket is
  optional, not required.
- `intent.md` and `spec.md` are created from `_templates/` via the `/intent`
  and `/spec` skills. `plan.md` is the approved plan-mode output, written and
  committed by `/plan-spec` before `/build-plan` writes any code.
- **Intent acceptance:** the product owner accepts their own intent, in the
  `/intent` chat; the skill sets `Status: accepted` on their yes. The pull
  request reviewer (an engineer) only checks the file is in place, reads
  clearly and says accepted, then merges. The why is the PO's call.
- **The gate:** a pull request that adds or changes an `intent.md` or `spec.md`
  still saying `Status: draft` fails the `Artifact status` check and cannot
  merge. No Claude involved; it just reads the line.
- **Spec review:** three readers, each ticks their own box in the pull
  request text — engineer (technically true), product owner (in scope),
  tester (every criterion checkable, Test plan filled in via `/spec-testplan`). Under the
  product owner's box the skill lists every decision marked
  `Product owner to confirm.`, so that tick covers them. The draft check
  refuses to merge while a box is unticked, or while a marked spec's box does
  not list the decisions. Then one approval, from someone other than the
  person who ran `/spec`, who sets `Status: accepted`.
- Artifacts are committed **with the feature PR** (or ahead of it). The PR
  body links the directory; the automated Claude review (see `REVIEW.md`,
  Pass 3) checks the diff against `spec.md`'s acceptance criteria.
- Not every change needs the chain: bug fixes and small changes may skip it
  (say "small change" in the PR template). Anything worth a plan-mode session
  is worth committing the plan here.
- The Sentry maintain loop opens PRs that add an `intent.md` with
  `Source: maintain-loop`. Review the diagnosis, edit freely, merge, then run
  `/spec` on it — that re-enters the normal chain.
