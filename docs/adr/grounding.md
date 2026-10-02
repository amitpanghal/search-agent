# ADR: Grounding

Status: current — built
Date: 2026-09-30
Component record: [components/grounding.md](../components/grounding.md)

## Context
Map the plan's free-text scope (region, competition, teams, players) to real Kambi ids from the sport's
catalog. The grounder returns candidates plus a confidence tier per entity and never forces a guess. One
model call settles only the doubtful cells. A genuine collision becomes a question to the user.

## Decisions
- **Lexical first, no embeddings.** The names are short proper nouns, and the tokens that decide ("2026"
  versus "2022") blur under embeddings.
- **Precision-biased.** Tiers and candidates instead of a forced pick; a confident-wrong entity is the
  dangerous miss, a clarification is not.
- **One stateless model call, pick or reexpress only.** A second call, or a model-side clarify, only turned
  clarifications into silent rescue picks.
- **Joint resolution, order-free.** Information flows both ways: a named player can pin a team, a team can
  cut a player homonym. One loop covers head-to-head twins, competition anchors and the homonym cut.
- **Skip a constraint that would empty a set.** Stale roster data then degrades to the weaker signal instead
  of deleting the right answer.
- **The extractor owns region-versus-team routing.** The grounder never re-decides it.
- **Sport recovery switches only on a blind sport.** A weak match keeps the extractor's sport; generic names
  ("Barcelona", "Bundesliga") invert the tier signal across sports, so "confident elsewhere" is not a trigger.
  Leagues never vote against a named sport; under `other`, a league that exactly one sport knows places the
  query in that sport (a league-only query no longer stops dead), and any other league abstains.
- **Aliases are bridge-only.** An alias is added only for a gap lexical matching cannot cross.

## Related
- Related: catalogs, extraction, pipeline.
