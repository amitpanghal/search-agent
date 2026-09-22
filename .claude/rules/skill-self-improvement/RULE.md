# Skill Self-Improvement

Skills are how this project's hard-won, codebase-specific knowledge survives between
sessions. Anything you reconstruct in a chat that isn't captured is lost the moment
the conversation ends — and re-derived next session, sometimes *wrongly*. So you are a
**co-author of the skill library**: when a chat surfaces a reusable convention,
**propose** capturing it; when a skill you loaded proves wrong or insufficient,
**propose** fixing it.

Two behaviors, one hard gate:

1. **Propose a NEW skill** when chat reveals a reusable gap not covered by any skill.
2. **Propose an IMPROVEMENT** when a loaded skill is inaccurate, incomplete, or stale.
3. **NEVER create or modify a `SKILL.md` (or `RULE.md`) without explicit user approval** — treat it like any other repo change.

## Who hears this rule

**Never a product owner.** If this session ran `/intent`, or the person is acting as
the product owner (accepting an intent, answering an intent interview), this rule is
silent for the rest of the session: no proposal, no "no skill gap this turn", nothing.
Note the gap to yourself and leave it; an engineer's session will meet the same gap.
Everywhere else the audience is an engineer, and the rule speaks in two lines (below).

## When to run this check

This rule is always on, but evaluate it at a **definite moment: just before you end a
turn.** Do a single, quick pass over the triggers below — did anything this turn
reveal a reusable gap or a wrong/stale skill? If yes, propose (propose-then-confirm)
before finishing. If no, end the turn normally. Run this pass **at most once per
turn** — never re-open it after you've already reflected, and never manufacture a gap
to justify a proposal.

## When to propose a NEW skill

- A PR review comment (human or automated) flags a convention or "you should have
  used X" that will recur.
- The user explained a project convention, internal tool, or workflow you didn't
  already know.
- You read several files to reconstruct a pattern that will recur.
- You hit a non-obvious gotcha that cost real debugging time and the compiler/tests
  won't catch next time (a silent fallback, an import-time crash, an env quirk).
- The task was complex (roughly **≥5 tool calls**), or you hit a dead-end and then
  found the working path — and the result is reusable.

## When to propose an IMPROVEMENT

- A loaded skill led you to a wrong answer or a dead-end.
- The user corrected something a skill *should* have caught.
- A skill references a path, symbol, or convention that no longer matches the
  codebase (a name it cites no longer greps).
- You had to supplement a skill's content with information from elsewhere to finish
  the task.

## Propose, then confirm — the gate

NEVER write or edit a `SKILL.md`/`RULE.md` until the user approves **this** proposal.
Approval must be specific to the skill action.

**IS approval:** "yes, draft it", "create that skill", "go ahead and add it",
"update the skill", "draft the diff".

**IS NOT approval:** "thanks" / "great" / "looks good" after an answer; "go ahead"
in reply to a *code* question; finishing the task. When in doubt, ask.

## The proposal shape (what you SAY, not do)

**Two lines, then stop.** In the chat, after the turn's real answer:

> Skill gap noticed: <which skill> does not cover <the situation, one clause>.
> Want a patch? (yes / no)

Nothing else: no summary paragraph, no frontmatter quote, no bullet outline, no
evidence block. Those belong in the patch itself, after a yes. If nothing fired,
say **nothing** — not "no skill gap this turn", not a reflection, nothing.

**On yes**, follow the **skill-maintenance** skill and, in the same change:
1. patch the skill (targeted diff, version bump, evidence in the commit message);
2. add one **case** to `eval/config/cases.ts` — the question a developer would ask
   where the new paragraph changes the answer, with the words the answer must and
   must not contain — and prove it by deleting the paragraph, running
   `npm run ai:eval:config -- --id=<case>`, watching it fail, restoring it;
3. report both in one line: *"Patched <skill> and added the case <id>."*
The engineer says yes once. They do not have to know that a case exists.

## Hard constraints

- **One proposal per chat** unless the user asks for more. Do NOT propose at the end
  of every chat — only when a trigger above clearly fires. A trivial change is never
  a trigger. Silence is the default; a proposal is the exception.
- **Check existing skills first** (`.claude/skills/`). Prefer amending an existing
  skill over a near-duplicate new one.
- Improvement proposals default to a **PATCH** (a targeted diff), not a rewrite.
- Improvement proposals **must cite evidence** — no "the skill could be better"
  without a concrete failure.
- A `pinned: true` frontmatter marker means: propose **patches only, never archival**.
- **Never auto-touch a human-authored or bundled skill** — only ever frame a change
  as a proposal.
- Descriptions follow the `name` + 2nd-person, trigger-rich `description` YAML
  convention.
- If a one-line rule also belongs in the always-loaded `AGENTS.md`/`CLAUDE.md`, add
  it there and point to the skill for the detail.

## Good / Bad

**Good (new):** You reconstruct a non-obvious data-flow across several files from
scratch, and no skill covers it. You propose a new skill with a trigger-rich
description and a 5-bullet outline, name where it lives, and ask before writing.

**Good (improvement):** You apply a skill but a review comment flags a case it
should have caught. You propose a targeted PATCH to the relevant section, cite the
failing case as evidence, and ask before editing.

**Bad:** "Want me to create a skill for this?" after a one-line rename (spam). •
Writing a `SKILL.md` without asking (gate violation). • Proposing a skill that just
rephrases an existing one (sprawl).

## How — and what's out of scope

For the `SKILL.md` format, the update-vs-create decision, and the patch / pinning /
evidence mechanics, follow the **skill-maintenance** skill
(`.claude/skills/skill-maintenance/SKILL.md`).

Out of scope here: automated skill garbage-collection and offline trace-based skill
optimization — this rule covers only in-chat, user-approved proposals.
