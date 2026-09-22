---
name: skill-maintenance
description: >
  Propose or update a project skill when a reusable, codebase-specific
  convention is discovered that isn't already captured. Use when a PR review
  comment flags a rule, when the same correction has come up more than once,
  when you hit a non-obvious gotcha worth recording, or when the user asks to
  "capture this", "add a skill", or "fill the gaps". Defines the detection
  triggers, the update-vs-create decision, the SKILL.md format, and the
  propose-then-confirm workflow (skills live in .claude/skills/). ALSO covers
  the step before any patch: re-read the SKILL.md from the integration
  branch, because a feature branch is routinely behind on a file it never
  touched and patching the stale copy silently reverts what landed in
  between. And the bump that goes with it: EVERY body change to a SKILL.md
  takes a `metadata.version` bump in the same commit. ALSO use when writing
  or reviewing a case in eval/config/cases.ts (the case that ships with every
  skill patch): how to word its prompt so it holds in a repository with real
  feature folders and project rules, and where to run it before the pull
  request.
compatibility: Repos using .claude/skills/<name>/SKILL.md (Claude Code / Agent SDK skills).
metadata:
  version: "1.1"
---

# Skill maintenance — keep the skill library current

Skills are how this repo's hard-won, non-obvious knowledge survives between
sessions. When you learn something reusable, the work isn't done until it's
captured. This skill is the process for doing that consistently.

> **This skill is the HOW.** The WHEN-to-propose triggers and the approval gate
> are owned by the always-on rule `.claude/rules/skill-self-improvement/RULE.md`.
> That rule fires every session; this skill is loaded on demand to carry out a
> proposal once it's approved. Don't write anything until the user approves.

## When to act (gap-detection triggers)

Treat any of these as a signal that a skill should be created or updated:

1. **Review feedback** — a PR review comment (human or automated) flags a
   convention, rule violation, or "you should have used X". If it's reusable,
   capture it.
2. **Repeated correction** — you (or the user) fixed the same class of issue
   more than once, in this session or across sessions.
3. **Non-obvious gotcha** — something that cost real debugging time and that the
   compiler/tests won't catch next time (an API that silently falls back, an
   import-time crash, an env quirk).
4. **Explicit request** — the user says "capture this", "add/update a skill",
   "document the convention", "fill the gaps".
5. **Drift** — you notice an existing skill is now wrong or incomplete.

If none of these apply, don't create a skill — avoid one-off or speculative
skills (KISS / YAGNI). A skill must encode *reusable* knowledge.

## Update vs create

- **Update an existing skill** when the knowledge fits its scope. Prefer this —
  fewer, denser skills beat many thin ones. Check `.claude/skills/` first.
- **Prefer a targeted PATCH (a small diff) over a rewrite** when updating — it's
  lower-risk and easier to review. Rewrite only when the skill is fundamentally
  wrong. For an improvement, **cite the evidence** (the review comment, the
  failing task) so the change is justified, not speculative.
- **Create a new skill** only when the knowledge is a distinct, cross-cutting
  area not owned by any existing skill.
- If a rule also belongs in `AGENTS.md` (the always-loaded source of truth), add
  a one-line rule there and point to the skill for the detail.

## Before you patch: re-read the file from the integration branch

**The working copy is not the base.** Skills are edited from many sessions and
worktrees, and a long-lived feature branch is routinely several commits behind
the integration branch on a file it never touched. Patching your stale copy
silently reverts whatever landed in between — and because a `SKILL.md` has no
tests and no type check, nothing catches it.

```bash
git fetch origin main -q   # TODO(template): your integration branch
git diff HEAD origin/main -- .claude/skills/<name>/SKILL.md   # empty ⇒ no drift
```

If it is not empty, take the integration branch's version before editing:

```bash
git checkout origin/main -- .claude/skills/<name>/SKILL.md
```

Then patch. The bump itself is required on **every** patch (see the Workflow
below); what this section adds is *which number to bump from* — the integration
branch's, not the one your branch remembered.

## A clean merge is not a coherent merge

After resolving any merge/rebase that touches a `SKILL.md`, don't stop at
"no conflict markers left" — two branches can independently add write-ups of
the SAME gotcha in different locations of the same file, and git auto-merges
them side by side with nothing flagged, even when they recommend opposite
fixes. Grep the merged file for the gotcha's distinctive terms across its
**entire** length; more than one hit in different sections is the signal.
Read each in context: complementary → cross-reference explicitly;
contradictory → synthesize one and replace the other with a pointer.

## Workflow: propose, then confirm

1. **Draft** the change (new `SKILL.md` or an edit) following the format below.
2. **Propose it to the user** — briefly: what gap, update vs new, where it
   lives, and a 1–2 line summary. Do this even mid-task; a skill change is a
   repo change and deserves a quick confirm.
3. **On approval**, write the file. Skills are tracked in git like any other
   source, so commit them with a clear message — but only commit/push when the
   user asks (don't auto-commit after writing).
4. **Bump `metadata.version` in the same edit — every patch, no exceptions.**
   A content change that ships under the old number makes two different copies
   of the guide look identical, which defeats stale-copy detection. Verify
   before committing — the version must appear in the diff whenever the body
   does:

   ```bash
   git diff --unified=0 -- .claude/skills/<name>/SKILL.md | grep -c '^+  version:'
   # 1 ⇒ bumped. 0 with body changes present ⇒ you skipped it.
   ```

   New skills start at `"1.0"`; a patch takes the minor (1.23 → 1.24).
5. Keep it scoped — document the rule, the wrong/right example, and how to
   verify. Don't pad.

## The case that guards the patch: write it for a real repository

Every skill patch ships with one case in `eval/config/cases.ts` (the rule
`.claude/rules/skill-self-improvement/RULE.md` requires it). The case does
not run only here. It runs in every repository made from this template,
where feature folders under `intent/`, project rules and extra skills exist.
Write the prompt for that repository, not for the empty template.

**A case must not depend on something being absent.** If the prompt names a
feature folder, a file or a rule as its example, the model in a real
repository reads that thing and answers about its content instead of the
process. The case then passes only where the example does not exist, which
is only here.

- ❌ `'The intent in intent/2026-09-place-bet-after-expiry/intent.md is accepted. How does the product owner change it?'`
  Green in the template. Red in the sandbox, where that folder holds a real
  intent and spec and the answer became a summary of the feature.
- ✅ `'An intent under intent/<ticket>-<slug>/ is accepted and merged. How does the product owner change it?'`
  A placeholder, or no folder at all. Nothing to read, so the model reads
  the skill.

**Prove the case twice.** Red in the template with the guarding paragraph
removed (the mutation test above). Green once in the sandbox clone, which
has real features, before the pull request is opened:

```bash
npm run ai:eval:config -- --id=<case>   # in the template, rule removed: red; restored: green
npm run ai:eval:config -- --id=<case>   # in the sandbox clone: green
```

Evidence: the first real run of the config evals workflow in the sandbox on
21 September 2026 was red on 4 of 14 cases; one of the four was a prompt
naming a folder that exists there. See story FDA-34.

## SKILL.md format

```markdown
---
name: kebab-case-name            # must match the directory name
description: >                   # 2nd person, trigger-rich; this is what makes
  What it covers and WHEN to use it — list the concrete situations that should
  trigger it, so it auto-activates at the right moment.
compatibility: one line          # optional
pinned: true                     # optional — propose patches only, never archive/delete
metadata:
  version: "1.0"
---

# Title

Short why-it-matters. Then the rules with ❌ wrong / ✅ right code examples,
a verification step, and a "Don't" list. Keep it actionable, not theoretical.
```

The **description is the most important field** — skills are selected by it.
Write it so the trigger conditions are explicit.

## Don't

- Don't create a skill for a one-off fix or speculative future need.
- Don't silently rewrite a skill the user relies on — propose the change.
- Don't rewrite when a small patch will do, and never archive a `pinned: true` skill.
- Don't duplicate a whole rule into both `AGENTS.md` and a skill — put the
  one-line rule in `AGENTS.md` and the detail in the skill.
- Don't let a skill go stale — if you find it wrong while working, propose the fix.
- Don't patch a `SKILL.md` from your branch's copy without checking it against
  the integration branch first — no test or type check will catch the revert.
- Don't ship a `SKILL.md` body change under its old `metadata.version`.
- Don't propose more than one skill per chat, or propose after a trivial change
  (see `.claude/rules/skill-self-improvement/RULE.md` for the anti-spam constraints).
