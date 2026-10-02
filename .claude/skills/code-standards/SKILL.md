---
name: code-standards
description: >-
  How code is written in this repo, as practiced: file layout and why-headers, naming (files, functions,
  variables, types, constants, the LLM contract's snake_case), comments (why not what, no JSDoc, `ponytail:`
  markers), types (strict TS, unions over enums, when `!` and `as` are allowed), errors and logging,
  injection for tests, test naming, formatting (quotes, width, imports). Use whenever writing, reviewing or
  refactoring code under src/ or scripts/, adding a stage or helper, naming something, deciding where a type
  lives, or when the user mentions conventions, standards, naming, comments, lint or formatting.
---

# code-standards

These are the conventions the code already follows, measured against the tree on 2026-09-30 and written
down so new code matches old code. They are the team's rules, not suggestions. Enforced by tools:
`npm run typecheck` (strict TypeScript with unchecked-index and unused-code checks), `npm test`, and Biome
(`npm run lint`, `npm run format`; config in `biome.jsonc`). The pre-commit hook in `.githooks/` runs all three
on the staged files. Naming and comments are checked in review.

## Files

- Names are kebab-case: `resolve-market.ts`, `time-window.ts`. One stage or one concern per file.
- Every file opens with a `//` header that says **why** the file exists, what it must never do, and the
  load-bearing gotchas. The header is the documentation; keep it true when you change the file.
- No default exports. A stage file exports its stage function and the types only it owns. Shared shapes
  live in `live-menu-types.ts` (pipeline contracts), `schema.ts` (the plan), `offering-client.ts` (raw feed).
- A prompt is a `.md` file next to the stage that loads it.
- Move or rename with `git mv`, so history follows the file.

## Naming

| Thing | Rule | Examples in the tree |
|---|---|---|
| Function | verb plus object, camelCase | `buildBetslip`, `filterBySubject`, `planRecall` |
| Predicate | starts with `is`, `has`, `can` | `isMain`, `isTruncated`, `hasWindow` |
| Pure accessor or derivation | `<thing>Of(x)` | `marketLabelOf`, `levelOf`, `localeOf` |
| Comparator | `by<Key>` | `byProminence` |
| Variable | camelCase, a whole word; single letters only in a short callback | `betOffers`, `settled` |
| Module constant | UPPER_SNAKE | `CAP`, `DEFAULT_LOCALE`, `INCOMPLETE_QUESTION` |
| Type | PascalCase `type` alias; string unions, never `interface` or `enum` | `MarketPick`, `ScopeTier` |
| Zod schema | PascalCase, the same name as the type it infers | `QueryPlan`, `Subject`, `GoldRecord` |
| Raw feed shape | `K` prefix | `KEvent`, `KOutcome`, `KParticipant` |
| Response shape | `Envelope` prefix | `EnvelopeLeg`, `EnvelopeOutcome` |
| Injected collaborator | `<role>Fn`, with the real one as the default | `decideFn: DecideFn = decide` |

snake_case appears only inside the extractor's JSON contract (`market_concept`, `play_state`, `odds_sort`):
that is the form the model fills in, and it stays as the model sees it. Everything else is camelCase.

## Functions

- `function` declarations for exported and top-level functions; arrows for one-expression helpers and
  callbacks. The tree is mixed today; new code follows this, and a file you rewrite gets aligned.
- Inject collaborators as defaulted parameters. Production passes nothing; a test passes a double. This is
  how the model steps and the pricing call replay with no network: `decideFn = decide`, `priceCombo`,
  `lang = DEFAULT_LOCALE`.
- `async`/`await`; `Promise.all` for fan-out. `for...of` over `forEach`. `const` unless reassigned.
- No classes. Small pure functions; per-request state goes through `AsyncLocalStorage` (`usageStore`,
  `traceStore`), never a module global.
- `===` everywhere; the one loose comparison in use is `== null` / `!= null`, the nullish check.

## Types

- `strict` and `noUncheckedIndexedAccess` stay on. Fix the type, not the flag.
- Data crossing a trust boundary is `unknown` until a zod schema parses it: the request body, the model's
  tool output, the gold files. The raw feed JSON is the one `any` edge (`getJson`); do not add more.
- `!` only where the index is provably in range: `arr[i]!` inside a bounds-checked loop, `map.get(k)!`
  right after the `set`. Never to silence a real maybe-undefined.
- `as` only to narrow a parsed payload to its declared shape; when the reason is not obvious, say it in a
  comment on the same line.
- `import type { ... }`, or an inline `type` specifier in a mixed import, for anything type-only. `node:`
  prefix for builtins. Relative imports without an extension.

```ts
// Bad: hides a real maybe
const ev = events.find((e) => e.id === id)!;

// Good: handle it, or degrade with a reason
const ev = events.find((e) => e.id === id);
if (!ev) return failedTask(task); // an id the feed no longer serves: degrade, don't throw
```

## Comments

- Say why, not what. A comment on a line explains why the line is surprising, never what it does.
- No JSDoc `@param` / `@returns` blocks; the types carry that. A comment above a function only when the
  name cannot carry the why.
- `ponytail:` marks a deliberate shortcut with its ceiling and the upgrade path:
  `// ponytail: capped at 3 rounds; a 5-leg group where no triple combines returns null`.
- A measured fact carries its date (`verified live 2026-08-16`). A finding that decides a design goes in
  the file header or a decision record under `docs/adr/`, not only in a chat; how the built component works
  goes in its record under `docs/components/`.
- No `TODO`. A deferred behaviour goes to `planning/limitations.md` or a `ponytail:` marker.
- Never `@ts-ignore`, `@ts-expect-error` or a lint-disable comment. Fix the type instead.

## Errors and logging

The rules are in CLAUDE.md, section "Errors and logging". In short: never swallow; degrade with a flag and
a one-line reason (`failedTask`); throw with the context in the message (what was expected, what came);
log only through `src/server/log.ts`; anything the user must see goes in the envelope.

## Tests

- `node:test` with `node:assert/strict`, run by `npm test`. Free: no network, no model.
- The test name is the sentence that would be false if the code broke:
  `test("a live match survives a now-floored window but not a future-day one", ...)`.
- One invariants file per area (`src/resolver/invariants.test.ts`, `src/server/log.test.ts`), grouped by
  stage under a comment line. No fixture framework; build the smallest input inline.
- Non-trivial logic ships with the smallest check that fails if it breaks. A pure helper may carry a
  self-check under a main guard instead (`cost.ts`).
- A probe-diagnosed bug leaves a test behind, named after the invariant, not after the query.

## Formatting

Biome formats the tree: two-space indent, semicolons, double quotes, trailing commas, width 120. Run
`npm run format` before a commit, or let the hook tell you. Comments are not reflowed by the formatter; wrap them
by hand at the same width. Two Biome rules are off on purpose: the non-null assertion rule (the index idiom above)
and assignment-in-expression (`cached ??= load()`, `while ((m = re.exec(s)))`). Lint warnings are a to-do list
shown by `npm run lint`; errors block the commit.

## Before you finish

1. `npm run typecheck`, `npm test` and `npm run lint` pass; `npm run gate:live-menu` too when a post-fetch stage changed.
2. Every new file has a why-header, and every header you touched is still true.
3. Names follow the table. No new `any`, no unjustified `!` or `as`.
4. New logic has its check; a fixed bug has its test.
5. Comments say why; shortcuts carry `ponytail:`; nothing says TODO.
6. A changed stage, command, file or decision is reflected in CLAUDE.md, the skill map, or the ADR.
