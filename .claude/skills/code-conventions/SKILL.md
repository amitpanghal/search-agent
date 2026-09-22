---
name: code-conventions
description: >
  search-agent's house rules that the compiler does not catch: paid runs need an OK, shipped resolver
  code is human-gated, fix at the right layer, never branch on a query's phrasing, prompts stay
  sport-agnostic, filters never drop a row on missing data, fold diacritics. Read BEFORE writing or
  reviewing any code in this repository, and whenever /spec builds its Policy constraints section —
  every rule cited in a spec must come from here or from another policy skill (resolver-pipeline,
  probe, eval, catalog). REVIEW.md Pass 1 reads this file in full. Bump the version with every change.
metadata:
  version: "1.0"
---

# code-conventions

Rules here are the ones a type check and a linter cannot enforce. **Cite a rule by its name** — the bold
words that open it, e.g. "the smallest-diff rule" — never by its number: numbers shift when rules are
added or removed, and a name tells the reader what was meant.

## How to write a rule

One rule is one numbered paragraph with four parts:

- **A name in bold that opens it**, two to four words, the way people will say it in a review: "the
  smallest-diff rule".
- **What to do and what not to do**, in one or two sentences, concrete enough that a reviewer can point
  at a line and say which side of the rule it is on.
- **Why**, in one sentence, so a newcomer can tell when the rule does not apply.
- **How it is checked**: what a reviewer looks for in the diff, or which test or tool catches it. A rule
  nobody can check is a wish, not a rule.

A rule enters this file only behind a review finding or a correction that happened. Every rule added or
changed takes a case in `eval/config/cases.ts` in the same pull request, proven by removing the rule,
running the case, watching it fail, and restoring it (the skill-maintenance skill has the procedure).
Bump `metadata.version` with every change to the body.

## The one rule the template ships with

1. **Small change, smallest diff.** No refactor the spec did not ask for. A drive-by improvement is a
   separate intent. Checked in review: every hunk in the diff maps to a criterion or a plan step.

## Project rules

Seeded on 2026-09-22 from the rules and gotchas the project had already learned the hard way (they lived
in `CLAUDE.md` before the loop). Rules 2, 3 and 5 have a case in `eval/config/cases.ts`; rules 4 and 6
still need theirs before they count as guarded (rules 7 and 8 are checked by tests and grep, not by the
agent-config harness).

2. **Ask before paid runs.** Every `npm run probe` and `npm run eval` hits Bedrock and Kambi for real
   money; get an explicit OK in the chat first, run one targeted query rather than a batch, save the
   trace with `--out` and reuse it instead of re-running, and never loop paid calls. Use
   `--until=extract|ground|entities|recall` to stop before the next paid call when the question lives in
   an early stage. Why: a batch that looks free from the inside is a bill, and a re-run of an input that
   did not change buys nothing. Checked: the session shows the ask and the OK before the command; a PR
   that cites a probe or eval result names the saved trace.

3. **Human-gated resolver code.** For any change to a pipeline stage under `src/resolver`, a prompt
   (`*.md` there), `schema.ts`, or the grounder: explain the plan in plain English with one worked
   example, then stop and ask before editing; a prompt edit shows the exact old→new text first and is
   never auto-applied. Tests, scripts and docs need no gate. Why: the extractor and the resolver prompts
   are fragile, and a change that fixes the query in front of you routinely breaks a working extraction
   elsewhere. Checked: the PR links a `plan.md` whose step for the change exists, or a Decisions line
   records the approval; the review flags a prompt diff with neither.

4. **Fix at the right layer.** Before changing the extractor, a prompt or the schema, read what the
   extractor already returns for the failing query (the probe trace's `extract` stage); if the facts are
   present — the participant, the line value, the qualifier — the bug is downstream and is fixed there.
   Why: reshaping the extractor to cure a downstream symptom trades one bug for several. Checked: the
   plan or PR quotes the extractor output for the failing query and names the stage that owns the bug.

5. **Never branch on phrasing.** Never fix a query by matching the exact words it used (a literal string
   test on the query text, a special case for one team's nickname); the same intent arrives in a hundred
   surface forms, so move the decision to where the facts are concrete and enumerable — the extracted
   plan, the catalog, the live menu, the alias files — and test the fix on a reworded variant and on the
   inverse subject. Why: a phrasing patch passes the one query and silently misses the next hundred.
   Checked: grep the diff for query-text comparisons (`includes(`, `===`, regexes over `query`) in
   `src/resolver`; the PR names the reworded variant it tested.

6. **Sport-agnostic prompts.** A prompt rule states a general principle; per-sport market names and
   idioms ("run line", "both teams to score", "first service game") go in
   `catalogData/<sport>-scope-aliases.json`, never into a prompt rule or an example. Why: the same three
   prompts serve 38 sports, and a football idiom in a rule misleads every other sport. Checked: the
   prompt diff contains no sport-specific market name; the alias file carries the addition instead.

7. **Never drop a row on missing data.** Every filter in the pipeline is lenient: a row with a missing
   field passes through, it is never discarded for what it lacks. Why: over-keeping costs a little
   noise, over-dropping loses the right answer with no signal. Checked: `npm test` (the invariants in
   `src/resolver/*.test.ts`); a new filter ships with an invariant that feeds it a row with the field
   absent.

8. **Fold diacritics on both sides.** Any comparison of a name against the feed or the catalog folds both
   operands with `fold()` from `lexical.ts`; never compare raw strings. Why: the feed stores accents
   inconsistently ("Mbappe" and "Mbappé" are the same player on different days). Checked: grep the diff
   for name equality or `includes` without `fold(`.

## Don't

- Don't cite a rule number that isn't in this file.
- Don't add a rule here without a review finding or a correction behind it.
- Don't add a rule without its case; a rule without a case is not guarded.
- Don't move a rule back into `AGENTS.md` as prose; `AGENTS.md` keeps the one-line pointer, this file
  keeps the rule.
