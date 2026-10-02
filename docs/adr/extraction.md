# ADR: Extraction

Status: current — built
Date: 2026-09-30
Component record: [components/extraction.md](../components/extraction.md)

## Context
One model call turns the raw query into a `QueryPlan`: what the user wants to bet on, as text, with no ids.
The plan is the contract every later stage reads. The extractor classifies and copies. It never looks
anything up, never judges whether a number is realistic, and never guesses which markets exist.

## Decisions
- **Text, never ids.** The model does not know the catalog or the live menu. Recording the user's own
  wording lets the later stages match it against what really exists.
- **English values from any language.** Names and market wording are rendered in English so one catalog and
  one menu serve every language; `language` only localizes the labels shown back to the user.
- **Per-leg scope, values repeated.** No query-level scope and no inheritance; shared values are copied
  onto every leg, so downstream stages work leg by leg with no merge step.
- **`sport` is a hard enum.** The model cannot typo a sport. An unknown sport becomes `other`; sport recovery
  rescues it from precise names (the one sport every named team fits, or a league only one sport knows), else
  it fails at grounding, which is the right place. Extraction never abstains.
- **The `main` sentinel.** A query naming no market still yields one selector with `market_concept: "main"`,
  which later fans out into the fixture's main markets.
- **Never drop a named entity, never fabricate.** Every named competition, team, player or region lands in
  some leg's scope. Every stated number is spent exactly once. A field is omitted rather than guessed.
- **One retry on validation failure.** At temperature 0 the same input gives the same output; appending the
  error makes it a new input.
- **`competition` carries a schema description.** Leagues that name their own sport (MLB, UFC, WNBA) were
  spent on `sport` and left out of `competition`. Prompt guidance far from the field did not fix it; a
  description beside the field did.
- **Prompt rules stay sport-agnostic.** Sport idioms live in the alias files, never in a prompt rule.
- **`EXTRACTOR_PROMPT`** points at a variant prompt for offline A/B without touching the shipped one.

## Related
- Related: pipeline, grounding, llm-providers, evaluation.
