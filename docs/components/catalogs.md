# Catalogs

Component record: how this component works today. The decisions behind it: [adr/catalogs.md](../adr/catalogs.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
The grounder's world. One entity catalog per sport in `catalogData/`, holding competitions, sport-root
branches, teams and players with their Kambi ids. Entities only; markets are never in a catalog. If a sport
has no catalog file, it does not exist at runtime.

## Input and output
- In: the Kambi offering group tree and the per-sport participant feeds.
- Out: `catalogData/<slug>-scope-index.json` (generated, version-stamped) and an optional curated
  `catalogData/<slug>-scope-aliases.json`. Today: 50 scope indexes and 8 alias files.

## How it works
1. `npm run catalogs` (`scripts/build-catalogs.ts`) runs the chain for every sport in the tree, or one sport
   by name, and reuses the kept tree unless `--fresh`.
2. `fetch-groups.ts` fetches the group tree once, for the kambi/GB market. The tree is the competition
   whitelist: what is not in it does not exist.
3. `fetch-participants.ts` fetches each group under the sport root, descending only where a group times out,
   unions and dedups by id. Every TEAM that shares its English name with another TEAM (a twin) is stamped
   with its live bet-offer count, `liveBetOffers`: one call at a time, about 3 a second, because the host
   rate-limits bursts (429). The build log counts any 429.
4. `scripts/catalog/refactor_participants.py` normalizes the raw feed into flat, deduped, English-only
   records, for every sport. Twins collapse to one id: the most live offers, then the bigger squad, then the
   lowest id; players pointing at the dropped twin move to the keeper
   ([adr/catalog-twins.md](../adr/catalog-twins.md)).
5. `build-scope-index.ts` does a pure local join of the tree and the participants into the slim index:
   `groups[]` (the participant-referenced whitelist, each with its root `branch`), `branches[]` (root
   children with at least one whitelisted descendant), `teams[]` (name, competition ids, group ids,
   `ntVariant`), `players[]` (name, `clubId`, `countryTeamId`, competition ids).
6. Intermediates live in `.catalog-build/` and are deleted on success, kept on failure as evidence.
7. At runtime `scope-catalog.ts` loads the index and aliases, builds the folded-name maps and roster
   inversion, and memoizes per sport. `sports.ts` derives each sport's config from the tree; `builtSports()`
   lists the built files and feeds both the extractor's sport enum and `getSport()`.

Hand-maintained tuning, `SPORT_OVERRIDES` in `sports.ts`, only for what the tree cannot say:
`individual` (competitors are top-level participants), `nationalTeams` (flag NT clubs, link
`countryTeamId`), `eventCentric` (Formula 1: a named "competition" is an event under the sport root),
`tourFeeds` (tennis: per-tour feed codes for gender de-pollution), `participantsFrom: "betoffer"` (darts:
source players from live betoffer outcomes when the participant feed is polluted).

Aliases are three fold-matched tables per sport: competitions, regions, markers.

## Invariants
- `ntVariant` and `countryTeamId` are load-bearing for grounding; they were silently lost once and must
  never be dropped again.
- A build failure leaves its intermediates in `.catalog-build/`; review any rebuild with
  `git diff --stat catalogData/`.

## Limits
- Catalogs go stale between refreshes; a brand-new competition may just predate the last run.
- One id per team: offers left on a dropped twin's id (Spain's old-id outrights) can't be matched to the team.
- `participantsFrom: "betoffer"` lists only players with a live market; a big-roster sport would lose
  coverage under it.
- Basketball national teams and tennis country links are missing (`planning/limitations.md`).

## Where to look
- `scripts/build-catalogs.ts`, `fetch-groups.ts`, `fetch-participants.ts`, `curl-fetch.ts`,
  `scripts/catalog/refactor_participants.py`; `src/resolver/catalog/build-scope-index.ts`, `scope-catalog.ts`,
  `sports.ts`. The `catalog` skill is the operator's guide.
- Related: grounding, offering-feed, extraction.
