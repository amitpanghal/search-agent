---
name: _template
description: >
  TODO(template): NOT a real skill — copy this directory to
  .claude/skills/<kebab-name>/ and rewrite. The description is the most
  important field: write it in 2nd person, trigger-rich — what the skill
  covers and the CONCRETE situations that should activate it ("Use when
  writing code that touches X", "Use when the user says Y") — because skills
  are selected by their descriptions.
metadata:
  version: "1.0"
---

# Title — the rule in one line

Short why-it-matters paragraph: what silently goes wrong without this rule,
and why the compiler/tests won't catch it.

## The rule

```ts
// ❌ Wrong — and WHY it looks right but isn't
// ✅ Right — the house pattern
```

## Verify

How to prove compliance mechanically (a grep, a command, a red/green test).

## Don't

- Bullet list of the tempting shortcuts this skill exists to prevent.
