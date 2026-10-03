# ADR: Same-name team twins — live offers decide

Status: current — built
Date: 2026-10-03
Component record: [components/catalogs.md](../components/catalogs.md)

## Context

Kambi can carry two participant ids for one team (twins: same name, same country) and price only one of them.
The normalizer merged twins (step h: same name and group ids) and kept the lowest id. On 2026-10-03 that kept
the wrong Spain, Germany and Belgium: the Nations League fixtures (Spain v Czech Republic, Croatia v Spain,
Greece v Germany, France v Belgium) use the new ids 1003666473, 1007458821 and 1007458818, while the old ids
carry two or three outrights each. "Spain to win" clarified "We couldn't find an upcoming match for Spain", and
about 15 of 100 synthetic football queries were lost this way. The same step dropped the merged twin's squad:
a player first seen on the dropped twin's roster carried its id as his club and cascaded out with it (Florian
Wirtz, Nico Schlotterbeck), so "Schlotterbeck" grounded to Keven Schlotterbeck.

A fresh rebuild does not help: both twins are in the fresh feed. Measured on one the same day: 189 twin pairs
merged (6 of them national teams), 183 players lost. Of the 10 pairs with any live offers, the priced twin was
the newer id for all 5 national teams and the older id for all 5 clubs (Lyon: 1,244 offers on 1000000120, a 404
on 1005952151, an empty row). No local signal picks it either: the bigger squad is wrong for Belgium (old 27
players, new 24).

## Decisions

- **Live offers decide.** `fetch-participants.ts` asks `/betoffer/participant/{id}` for every TEAM that shares
  its English name with another TEAM and stamps the count as `liveBetOffers`. Step h keeps the twin with the
  most offers. A 404 is a real 0; any other failure is retried, then counts as 0 and is listed in the build log.
- **Tie-break: the bigger squad, then the lowest id.** In a quiet week neither twin has offers (Bolivia on
  2026-10-03), and the squad is the next-best sign of the live row (Bolivia: new 37 players, old 0).
- **One id per team.** The dropped twin's competitions union onto the keeper as before; its id is not kept.
- **Players follow the keeper.** A `clubId` or `countryTeamId` pointing at a dropped twin moves to the keeper,
  so no squad is lost and no national-team link dangles.
- **A player's club is his club.** A player first seen on a national squad takes his `clubId` from a later
  club roster (Nico Schlotterbeck: Dortmund, not Germany).
- **Rejected.** Newest id wins: Lyon, Montevideo City Torque and SønderjyskE lose their fixtures (their new ids
  have no offers). Newest id for national teams only: right on the day's data, but it bakes in a guess about
  how Kambi migrates, and a club that moves to a new id would break with nothing to notice it. Keeping both ids:
  recall and select would have to accept either id, a resolver change.

## Consequences

- Measured on the 2026-10-03 football rebuild, against every upcoming football fixture (1,297 events): fixture
  participant ids filed under the wrong twin went from 5 (Spain twice, Germany, Belgium, Argentina) to 0.
  Lyon, Montevideo City Torque and SønderjyskE keep their old, live ids. Florian Wirtz (Liverpool) and Nico
  Schlotterbeck (Dortmund) are back, both linked to Germany 1007458821; player links to a missing team, 13 to 0.
- Offers left on a dropped twin's id can't be matched to the team by id: Spain's Nations League winner and
  Euro 2028 outrights sit on 1000000186.
- A football build makes one free feed call per same-name team id (866 on 2026-10-03), one at a time with a
  250 ms gap. Fired four at a time, the first build's burst drew a 429 (rate limit) from the host, which
  publishes no limit. Paced, the same 866 checks took 257 s with no 429, and calls made right after the build
  went through. The build log counts every 429; a failed check waits 30 s, then 60 s, before it counts as 0.
- The choice is a snapshot of the build day, like the rest of the catalog. If Kambi moves a team between
  rebuilds, the next `npm run catalogs` follows it.
- Every sport picks the rule up on its next rebuild; on 2026-10-03 only football was rebuilt with it.
