# ADR: Evaluation

Status: current — built
Date: 2026-09-30
Component record: [components/evaluation.md](../components/evaluation.md)

## Context
Know whether a change to a prompt, the schema, a stage or a model made the resolver better or worse, before
it ships. The paid gate grades the model stages on a gold set; the free gates replay the deterministic
stages against captured data; the probe shows one query stage by stage.

## Decisions
- **Grade the extractor by text, the market by id after the fetch.** The extractor's job is the wording;
  the criterion id only exists once the menu is known.
- **Deterministic gates are free and always run.** Model judgment is measured separately and rarely.
- **Catalog coverage is separated from extraction.** No prompt rewrite can win back a row the catalog
  cannot serve.
- **Replay from captures.** A gold or scorer fix re-scores the existing capture; only a prompt, schema or
  model change needs fresh extractions.
- **Paid runs need an OK first.** The default is one run per row; `--runs 3` for measuring a prompt delta;
  `--release` (5 runs) only for final sign-off.

## Related
- Related: extraction, grounding, market-resolution, logging.
