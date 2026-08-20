---
name: catalog
description: >-
  The per-sport entity catalogs in catalogData/ — how they are built (`npm run catalogs`, the fetch → normalize
  → build-scope-index chain), what a scope-index holds (groups/branches/teams/players — entities only, never
  markets), the hand-maintained tuning in sports.ts SPORT_OVERRIDES (individual sports, national teams, tour
  feeds, participantsFrom:"betoffer"), the curated scope-aliases files, and the daily GitHub refresh. Use when a
  sport fails to ground, a team/player/competition is missing or wrong, adding or re-tuning a sport, editing
  aliases, or touching build-catalogs.ts / fetch-participants.ts / build-scope-index.ts / sports.ts.
---

# catalog

`catalogData/` is the grounder's world: one `<slug>-scope-index.json` per sport (generated) plus an optional
curated `<slug>-scope-aliases.json`. It holds **entities only** — competitions (groups), sport-root branches,
teams, players. Markets are NOT in any catalog; they are resolved against the live menu after the fetch.

**If a sport has no scope-index file, it does not exist at runtime.** `builtSports()` (sports.ts) lists the
built files, feeds the extractor's sport menu, and is what `getSport()` trusts at runtime. Deleting or failing
to build a catalog silently drops the sport.

## Building — free, feed-only (no LLM)

```bash
npm run catalogs                 # every top-level sport in the offering tree (the daily job)
npm run catalogs -- baseball     # one sport; reuses the kept .catalog-build/groups.json
npm run catalogs -- --fresh      # force a fresh tree first
```

Per sport the chain is: `fetch-groups.ts` (ONE shared tree, kambi/GB market — the tree IS the competition
whitelist) → `fetch-participants.ts` → `scripts/football/refactor_participants.py` (the normalizer, all
sports despite the path) → `build-scope-index.ts` (pure local join, writes the index). Intermediates live in
`.catalog-build/` (gitignored): deleted on success, **kept on failure as evidence** — a `FAIL` summary row
means look there. Review a build with `git diff --stat catalogData/`.

## sports.ts — the only hand-maintained part

Everything else derives from the offering tree. `SPORT_OVERRIDES` (keyed by slug) carries what the tree
can't say; a sport with no entry builds as a plain team sport, and that is correct for the majority:

- `individual: true` — competitors are top-level participants, not team rosters (tennis, golf, darts, …).
- `nationalTeams: true` — the normalizer flags NT clubs (`ntVariant`) and links players' `countryTeamId`.
  These fields are load-bearing for grounding; they were silently lost once — never drop them.
- `tourFeeds` (tennis) — per-tour feed codes used for **gender de-pollution**: the participant feed tags
  players with both editions of gendered pairs ("Wimbledon" and "Wimbledon Women"); the wrong-gender node is
  dropped using which tour file the player came from.
- `eventCentric: true` (formula-1) — the "competition" a query names is an EVENT (a Grand Prix) under the
  sport root, so competition grounding targets the root.
- `participantsFrom: "betoffer"` (darts) — the participant feed for some individual sports is polluted
  (dead/404 ids, matchup combos), while the REAL bettable ids live only in betoffer-group **outcomes**. This
  flag sources players from the live betoffer menu instead. Only players with a live market appear — right
  for small event-driven fields; a big-roster sport would lose coverage. Suspect this class of bug whenever
  an individual sport grounds a player to an id the feed 404s on.

## Aliases — curated, bridge-only

`<slug>-scope-aliases.json`: three fold()-matched tables (competitions, regions, markers) mapping surface
forms to catalog names. Discipline: add an alias only to bridge a gap the lexical grounder fundamentally
cannot cross (lexically disjoint, e.g. an acronym) — **never** to patch a tuning miss. The table growing is
a smell.

## Daily refresh

`.github/workflows/refresh-catalogs.yml` runs `npm run catalogs` at 06:00 UTC, commits
`chore(catalog): daily refresh` to main (Render auto-deploys). No secrets — the feed is public. Trigger by
hand from the Actions tab (`workflow_dispatch`). Catalogs go stale against the live feed between refreshes;
a "missing" brand-new competition may just predate today's run.
