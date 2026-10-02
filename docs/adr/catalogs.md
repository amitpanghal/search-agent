# ADR: Catalogs

Status: current — built
Date: 2026-09-30
Component record: [components/catalogs.md](../components/catalogs.md)

## Context
The grounder's world. One entity catalog per sport in `catalogData/`, holding competitions, sport-root
branches, teams and players with their Kambi ids. Entities only; markets are never in a catalog. If a sport
has no catalog file, it does not exist at runtime.

## Decisions
- **Entities only.** Markets change daily and are resolved against the live menu; entities are stable
  enough to snapshot.
- **The tree is the whitelist.** Noise branches (esports, virtuals) fall out for free because no club or
  player references them.
- **Slim artifact, derived indexes at load.** The tokenizer and inversion can never go stale on disk.
- **Overrides only for the exceptions.** A sport with no entry builds as a plain team sport, which is right
  for the majority.
- **Refresh is local and the result is committed.** The feed hosts refuse non-browser clients, so CI cannot
  build; a committed catalog ships inside the image.
- **Aliases bridge, never patch.** An alias is added only for a gap lexical matching cannot cross, such as
  an acronym. A growing table is a smell.

## Related
- Related: grounding, offering-feed, extraction.
