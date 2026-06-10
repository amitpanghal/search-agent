# Kambi Offering API Reference

Consolidated reference for the Offering API: endpoints, parameters, response shapes,
and the data models they return.

---

## Table of Contents

1. [Common Parameters](#common-parameters)
2. [Endpoints](#endpoints)
   - [Bet Offers](#bet-offers)
   - [Events](#events)
   - [Event Groups](#event-groups)
   - [List View](#list-view)
   - [Meetings](#meetings)
   - [Categories](#categories)
   - [Rewards](#rewards)
3. [Response Wrappers](#response-wrappers)
4. [Data Models](#data-models)
5. [Example Responses](#example-responses)

---

## Common Parameters

Most endpoints accept these. `offering` is always required and in the path.

| Param                 | In    | Type           | Notes                                                                    |
| --------------------- | ----- | -------------- | ------------------------------------------------------------------------ |
| `offering`            | path  | string         | API user identifier. Example: `kambi`.                                   |
| `lang`                | query | string         | Locale for translated text. Example: `en_GB`, `fr_FR`.                   |
| `market`              | query | string         | Player's geographical market. Example: `GB`, `FR`.                       |
| `includeParticipants` | query | boolean        | Include participant info in response.                                    |
| `includeTeamMembers`  | query | boolean        | Include team members. If true, `includeParticipants` is treated as true. |
| `range_size`          | query | integer        | Page size. Min 1, max 1000. Defaults to max.                             |
| `range_start`         | query | integer        | Pagination offset. Default 0.                                            |
| `depth`               | query | integer        | Max depth of root nodes. Omit to fetch entire tree.                      |
| `category`            | query | integer/string | Restrict to bet offers whose criterion maps to this category id.         |
| `type`                | query | string         | Comma-separated bet offer type ids. 404 if none match.                   |
| `onlyMain`            | query | boolean        | Only main bet offers.                                                    |

---

## Endpoints

### Bet Offers

#### `GET /{offering}/betoffer/{betOfferIds}`

List bet offers for the given comma-separated ids.

| Param                                   | In    | Required | Notes                                      |
| --------------------------------------- | ----- | -------- | ------------------------------------------ |
| `betOfferIds`                           | path  | yes      | Comma-separated ids. Example: `5293,4265`. |
| `market`, `lang`, `includeParticipants` | query | no       | Common params.                             |

**Returns:** [`BetOfferResponse`](#betofferresponse)

---

#### `GET /{offering}/betoffer/event/{eventIds}`

All bet offers for one or more events.

| Param                                       | In    | Required | Notes                                           |
| ------------------------------------------- | ----- | -------- | ----------------------------------------------- |
| `eventIds`                                  | path  | yes      | Comma-separated event ids.                      |
| `type`                                      | query | no       | Filter by bet offer type ids.                   |
| `range_size`, `range_start`                 | query | no       | Pagination.                                     |
| `includeParticipants`, `includeTeamMembers` | query | no       |                                                 |
| `excludePrePacks`                           | query | no       | Highly recommended if pre-packs are not needed. |
| `onlyMain`                                  | query | no       |                                                 |
| `category`                                  | query | no       |                                                 |
| `market`, `lang`                            | query | no       |                                                 |

**Returns:** [`BetOfferResponse`](#betofferresponse)

---

#### `GET /{offering}/betoffer/participant/{participantIds}`

All betoffers based on participant (type team)

| Param                       | In    | Required | Notes                                    |
| --------------------------- | ----- | -------- | ---------------------------------------- |
| `participantIds`            | path  | yes      | List of participants (team) identifiers. |
| `type`                      | query | no       | Filter by bet offer type ids.            |
| `includeParticipants`       | query | no       |                                          |
| `market`, `lang`            | query | no       |                                          |
| `range_size`, `range_start` | query | no       |                                          |

**Returns:** [`BetOfferResponse`](#betofferresponse)

---

#### `GET /{offering}/betoffer/group/{groupIds}`

All prematch and live bet offers in the specified event group(s).

| Param                                          | In    | Required | Notes                                                                                                                                 |
| ---------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `groupIds`                                     | path  | yes      | List of event group identifiers.                                                                                                      |
| `excludeLive`                                  | query | no       | Exclude live bet offers/events.                                                                                                       |
| `excludePrematch`                              | query | no       | Exclude prematch bet offers/events.                                                                                                   |
| `excludeOngoing`                               | query | no       | Exclude already-started events.                                                                                                       |
| `excludeUnevenLines`                           | query | no       | Exclude non-main-line bet offers.                                                                                                     |
| `onlyMain`, `onlyStreamed`, `onlyCompetitions` | query | no       |                                                                                                                                       |
| `type`                                         | query | no       | Filter by bet offer type ids.                                                                                                         |
| `category`                                     | query | no       | Cannot be combined with `categoryGroupName`.                                                                                          |
| `categoryGroupName`                            | query | no       | Only events with at least one matching bet offer. If multiple groups, all must be the same sport. Cannot be combined with `category`. |
| `includeParticipants`, `includeTeamMembers`    | query | no       |                                                                                                                                       |
| `market`, `lang`                               | query | no       |                                                                                                                                       |
| `range_size`, `range_start`                    | query | no       |                                                                                                                                       |
| `maxNumberEvents`                              | query | no       | Cap on number of events.                                                                                                              |

**Returns:** [`BetOfferResponse`](#betofferresponse)

---

#### `GET /{offering}/betoffer/outcome`

Unique bet offers for one or more outcomes.

| Param                                   | In    | Required | Notes                                                    |
| --------------------------------------- | ----- | -------- | -------------------------------------------------------- |
| `id`                                    | query | yes      | Repeatable: `?id=1&id=2`. Combinational: `id=1001,1002`. |
| `market`, `lang`, `includeParticipants` | query | no       |                                                          |
| `range_size`, `range_start`             | query | no       |                                                          |

**Returns:** `{ betOffers: [...], events: [...] }` — see [example](#betofferoutcome-response).

---

### Events

#### `GET /{offering}/event/group/{groupId}`

Events for a group.

| Param                                   | In    | Required | Notes    |
| --------------------------------------- | ----- | -------- | -------- |
| `groupId`                               | path  | yes      | Integer. |
| `lang`, `market`, `includeParticipants` | query | no       |          |

**Returns:** list of [`Event`](#event).

---

#### `GET /{offering}/event/live/open`

Open live events.

| Param                                            | In    | Required | Notes |
| ------------------------------------------------ | ----- | -------- | ----- |
| `lang`, `market`, `depth`, `includeParticipants` | query | no       |       |

**Returns:** `{ liveEvents: [...], group: Group }` where each item wraps an [`Event`](#event), [`LiveData`](#livedata), and an optional `mainBetOffer` ([`BetOffer`](#betoffer)). See [example](#live-open-events-response).

---

#### `GET /{offering}/event/livedata/{eventIds}`

Live data for one or more events.

| Param      | In    | Required | Notes            |
| ---------- | ----- | -------- | ---------------- |
| `eventIds` | path  | yes      | Comma-separated. |
| `lang`     | query | no       |                  |

**Returns:** list of [`LiveData`](#livedata).

---

### Event Groups

#### `GET /{offering}/group`

Event group tree.

| Param                     | In    | Required | Notes |
| ------------------------- | ----- | -------- | ----- |
| `lang`, `market`, `depth` | query | no       |       |

**Returns:** [`Group`](#group) tree.

---

#### `GET /{offering}/group/{groupId}`

Single event group by id.

| Param                     | In    | Required | Notes    |
| ------------------------- | ----- | -------- | -------- |
| `groupId`                 | path  | yes      | Integer. |
| `lang`, `market`, `depth` | query | no       |          |

**Returns:** [`Group`](#group).

---

#### `GET /{offering}/group/highlight`

Highlighted event groups (marketing).

| Param                     | In    | Required | Notes |
| ------------------------- | ----- | -------- | ----- |
| `lang`, `market`, `depth` | query | no       |       |

**Returns:** `{ group: Group, groups: [Group] }`. See [example](#highlights-response).

---

### List View

Hierarchical event browsing for sports/regions/leagues.

#### `GET /{offering}/listView/{sports}/{regions}/{leagues}`

#### `GET /{offering}/listView/{sports}/{regions}/{leagues}/{participants}`

#### `GET /{offering}/listView/{sports}/{regions}/{leagues}/{participants}/{attributes}`

| Param                          | In    | Required    | Notes                                                           |
| ------------------------------ | ----- | ----------- | --------------------------------------------------------------- |
| `sports`, `regions`, `leagues` | path  | yes         | Term codes.                                                     |
| `participants`                 | path  | conditional | Required for the participants variants.                         |
| `attributes`                   | path  | conditional | Required for the attributes variant. Filters by attribute term. |
| `lang`, `market`               | query | yes         |                                                                 |
| `includeParticipants`          | query | no          |                                                                 |
| `useCombined`                  | query | no          | Allow combinations of bet offers per prematch event.            |
| `useCombinedLive`              | query | no          | Allow combinations on live events. Requires `useCombined=true`. |
| `category`                     | query | no          |                                                                 |
| `from`, `to`                   | query | no          | Datetime range when used with the `starting-within` attribute.  |

**Returns:** event list with bet offers.

---

### Meetings

#### `GET /{offering}/meeting/{sport}`

Race meetings for a sport.

| Param            | In    | Required | Notes       |
| ---------------- | ----- | -------- | ----------- |
| `sport`          | path  | yes      | Sport code. |
| `lang`, `market` | query | yes      |             |

**Returns:** list of [`Meeting`](#meeting).

---

### Categories

#### `GET /{offering}/category/{categoryGroupNames}/sport/{sportId}`

Bet offer categories scoped to a sport.

| Param                | In    | Required | Notes                                        |
| -------------------- | ----- | -------- | -------------------------------------------- |
| `categoryGroupNames` | path  | yes      | Comma-separated. Example: `pre_match_event`. |
| `sportId`            | path  | yes      | Example: `FOOTBALL`.                         |
| `lang`, `market`     | query | no       |                                              |

**Returns:** [`BetOfferCategoryResponse`](#betoffercategoryresponse).

---

### Rewards

#### `GET /{offeringEndpoint}/rewards`

Group rewards for an offering.

| Param      | In    | Required | Notes                         |
| ---------- | ----- | -------- | ----------------------------- |
| `currency` | query | yes      | Example: `EUR`, `USD`, `GBP`. |

**Returns:** list of [`ReceivableRewardDto`](#receivablerewarddto).

---

## Response Wrappers

### `BetOfferResponse`

List of bet offers, events and group information.

```
{
  betOffers: BetOffer[],
  events: Event[],
  prePacks: [...],
  range
}
```

### `EventWithBetOffers`

Wrapper around an Event with its bet offers and live data.

```
{
  event: Event,
  betOffers: BetOffer[],
  liveData: LiveData
}
```

### `BetOfferCategoryResponse`

Three levels deep — `categoryGroups[]` wraps `categories[]` which carries `mappings[]`. Verified against `/category/list_view,list_view_competitions/sport/FOOTBALL.json` and `/category/pre_match_event,live_event/sport/FOOTBALL.json` (Phase 3 probe, 2026-05-17).

```
{
  categoryGroups: [{
    categoryGroupName: string,    // "list_view" | "list_view_competitions" | "pre_match_event" | "live_event"
    categories: [{
      id: int64,                  // bet offer category id (used by listView ?category= and /betoffer/event ?category=)
      name: string,               // localized
      englishName: string,
      sortOrder: int32,
      displayBoTypeHeaders: boolean,
      mappings: [{
        criterionId: int64,       // optional; if missing, criterion not used
        boType: int32,            // bet offer type id
        sortOrder: int32          // sort order within category
      }]
    }]
  }]
}
```

The `categoryGroupName` value mirrors the path segment used in the request and discriminates which client endpoint accepts the resulting category id: `list_view*` ids go to `listView`, `pre_match_event` / `live_event` ids go to `/betoffer/event` and `/betoffer/group`. The id spaces are disjoint across the two endpoint families (Phase 3 probe: 0 overlap between 17 listView categories and 106 betoffer categories for football).

---

## Data Models

### BetOffer

| Field           | Type                          | Notes                                                                                              |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`            | int64                         | Unique id.                                                                                         |
| `suspended`     | boolean                       | Omitted when false.                                                                                |
| `closed`        | date-time                     | Cutoff for bets. Omitted if live.                                                                  |
| `criterion`     | [Criterion](#criterion)       |                                                                                                    |
| `extra`         | string                        | Localized extra info.                                                                              |
| `betOfferType`  | [BetOfferType](#betoffertype) |                                                                                                    |
| `placeLimit`    | int64                         | Number of participants for Outright Place, or positions for MultiPosition (2=forecast, 3=tricast). |
| `eventId`       | int64                         |                                                                                                    |
| `outcomes`      | [Outcome](#outcome)[]         |                                                                                                    |
| `place`         | boolean                       | True for Outright Place.                                                                           |
| `eachWay`       | object                        |                                                                                                    |
| `tags`          | string[]                      | See tag list below.                                                                                |
| `sortOrder`     | int32                         |                                                                                                    |
| `cashOutStatus` | enum                          | `ENABLED \| DISABLED \| SUSPENDED`                                                                 |
| `from`, `to`    | int32                         | Position bet offers: interval.                                                                     |
| `description`   | string                        | Position bet offers: localized description.                                                        |

**BetOffer tags:** `OFFERED_LIVE`, `OFFERED_PREMATCH`, `NOT_COMBINABLE`, `MAIN`, `PBA_DISABLED`, `MAIN_LINE`, `STARTING_PRICE` (odds set at settling, returned as -1), `RULE4`, `ENHANCED_PLACE_TERMS`, `EACH_WAY_REQUIRED`.

---

### BetOfferType

| Field         | Type   | Notes      |
| ------------- | ------ | ---------- |
| `id`          | int32  |            |
| `name`        | string | Localized. |
| `englishName` | string |            |

---

### Criterion

| Field                             | Type     | Notes                                                                  |
| --------------------------------- | -------- | ---------------------------------------------------------------------- |
| `id`                              | int64    |                                                                        |
| `label`, `englishLabel`           | string   |                                                                        |
| `shortLabel`, `shortEnglishLabel` | string   |                                                                        |
| `order`                           | number[] | Sortable point-in-match, e.g. tennis set 1 game 5 point 2 → `[1,5,2]`. |
| `occurrenceType`                  | enum     | What is counted. See values below. Defaults to `UNTYPED`.              |
| `occurrenceNumberInLifetime`      | int32    | Sort order for `OCCURRENCE_METHOD` bet offers.                         |
| `lifetime`                        | enum     | `FULL_TIME \| FULL_TIME_OVERTIME \| FULL_TIME_EXTRA_TIME \| UNTYPED`.  |
| `occurrenceNumber`                | int32    | Number of occurrences during lifetime.                                 |
| `raceToValue`                     | int32    | First to reach this value.                                             |

**occurrenceType values:** `DRIVE_RESULT`, `BALL_PUNTED`, `CARDS`, `DRIVE_END`, `DRIVE_END_HALF_TIME`, `DRIVE_START`, `FIELD_GOALS`, `FIELD_GOAL`, `FIELD_GOAL_ATTEMPTS`, `GOALS`, `INTERCEPTIONS`, `PASSING_YARDS`, `PENALTIES`, `POINTS`, `RECEIVING_YARDS`, `ROUGES`, `RUSHING_YARDS`, `SAFETIES`, `SAFETY`, `SCORING_PLAY`, `SCORING_PLAYS`, `TIMEOUT`, `TOUCHDOWNS`, `TURNOVERS`, `TWO_POINT_SAFETIES`, `UNTYPED`.

---

### Event

A match or a competition.

| Field                                         | Type                                    | Notes                                                                   |
| --------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `id`                                          | int64                                   |                                                                         |
| `name`                                        | string                                  | Translated, with display formatting. Format depends on `AWAY_HOME` tag. |
| `nameDelimiter`                               | string                                  | Only for match events.                                                  |
| `englishName`                                 | string                                  | `homeName - awayName`. Useful for analytics.                            |
| `homeName`, `awayName`                        | string                                  |                                                                         |
| `start`                                       | date-time                               |                                                                         |
| `originalStartTime`                           | string                                  | **Deprecated** — use `originalStartDate`.                               |
| `originalStartDate`                           | date-time                               | UTC.                                                                    |
| `group`                                       | string                                  | Event group name.                                                       |
| `groupId`                                     | int64                                   |                                                                         |
| `path`                                        | [GroupPath](#grouppath)[]               |                                                                         |
| `nonLiveBoCount`, `liveBoCount`               | int32                                   |                                                                         |
| `sport`                                       | string                                  | E.g. `FOOTBALL`, `BOXING`, `BASKET`.                                    |
| `tags`                                        | string[]                                | See list below.                                                         |
| `state`                                       | enum                                    | `NOT_STARTED \| STARTED \| FINISHED \| UNKNOWN`.                        |
| `distance`                                    | string                                  | E.g. horse racing.                                                      |
| `eventNumber`                                 | int32                                   | Race number within a meeting.                                           |
| `nameDetails`                                 | string                                  | Extra info for the name.                                                |
| `editorial`                                   | string                                  | E.g. course conditions.                                                 |
| `raceClass`, `raceType`, `trackType`, `going` | string                                  | Horse racing fields.                                                    |
| `participants`                                | [EventParticipant](#eventparticipant)[] |                                                                         |
| `rank`                                        | int32                                   | Total ranking.                                                          |
| `groupSortOrder`                              | int64                                   |                                                                         |
| `sortOrder`                                   | int32                                   | Within event group.                                                     |
| `prematchEnd`                                 | date-time                               | When event stops being prematch.                                        |
| `meetingId`                                   | string                                  | Horse racing / greyhound.                                               |
| `extraInfo`                                   | string                                  |                                                                         |

**Race types:** Flat, Hurdle, Chase, National Hunt Flat.

**Event tags:** `OFFERED_LIVE`, `STREAMED_WEB`, `STREAMED_MOBILE`, `ENHANCED_PLACE_TERMS`, `PRICEBOOST`, `PREMATCH_STATS`, `VISUALIZATION`, `OPEN_FOR_LIVE`, `SHOW_START_NUMBER`, `MATCH`, `COMPETITION`, `AWAY_HOME`, `BET_BUILDER` (removed when going live if sport doesn't support live bet builder), `LIVE_OCCURRENCE_FEED`.

---

### EventParticipant

| Field                            | Type    | Notes                                      |
| -------------------------------- | ------- | ------------------------------------------ |
| `participantId`                  | int64   |                                            |
| `name`, `englishName`            | string  |                                            |
| `shortName`, `shortEnglishName`  | string  | Nullable.                                  |
| `termKey`                        | string  | Normalized name.                           |
| `scratched`, `nonRunner`, `home` | boolean |                                            |
| `startNumber`                    | int32   |                                            |
| `participantType`                | enum    | `TEAM \| PARTICIPANT \| LABEL \| UNKNOWN`. |
| `teamMembers`                    | [...]   |                                            |
| `nationality`                    | string  |                                            |

---

### GroupPath

| Field                 | Type   | Notes |
| --------------------- | ------ | ----- |
| `id`                  | int64  |       |
| `name`, `englishName` | string |       |
| `termKey`             | string |       |

---

### Outcome

| Field                            | Type                                  | Notes                                                                         |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| `id`                             | int64                                 |                                                                               |
| `label`, `englishLabel`          | string                                | Format depends on `AWAY_HOME` tag.                                            |
| `odds`                           | int32                                 | See odds format docs.                                                         |
| `line`                           | int32                                 | Handicap / Over-Under.                                                        |
| `distance`                       | string                                | Outright only.                                                                |
| `scratched`                      | boolean                               | Outright only. Participant won't race.                                        |
| `startNr`                        | int32                                 | Outright only. Possibly empty.                                                |
| `prevOdds`                       | [...]                                 |                                                                               |
| `criterion`                      | [OutcomeCriterion](#outcomecriterion) |                                                                               |
| `participant`                    | string                                | Head-to-head and Yes/No only.                                                 |
| `popular`                        | boolean                               | One of the most popular.                                                      |
| `type`                           | string                                | Outcome type.                                                                 |
| `homeTeamMember`                 | boolean                               | Scorer bet offers; also `OT_ANY_PARTICIPANT` in player-occurrence bet offers. |
| `betOfferId`                     | int64                                 |                                                                               |
| `changedDate`                    | string                                | Last odds change.                                                             |
| `participantId`                  | int64                                 |                                                                               |
| `oddsFractional`, `oddsAmerican` | string                                |                                                                               |
| `tags`                           | string[]                              |                                                                               |
| `status`                         | enum                                  | `OPEN \| CLOSED \| SUSPENDED \| SETTLED`.                                     |
| `cashOutStatus`                  | enum                                  | `ENABLED \| DISABLED \| SUSPENDED`.                                           |
| `homeScore`, `awayScore`         | string                                | Score bet offers. Usually numeric, but can be `W` (tennis).                   |
| `lowerLimit`, `upperLimit`       | int32                                 | Winning-margin bet offers.                                                    |
| `eventParticipantId`             | int64                                 | Player-occurrence bet offers: id of the team this player belongs to.          |
| `occurrence`                     | object                                |                                                                               |
| `displayOrder`                   | int32                                 |                                                                               |

---

### OutcomeCriterion

| Field  | Type   | Notes                                                                    |
| ------ | ------ | ------------------------------------------------------------------------ |
| `type` | int64  | `4,8`=First Goal, `5,9`=Last Goal, `6,10`=To Score, `7,11`=Not to Score. |
| `name` | string |                                                                          |

---

### Group

| Field                | Type    | Notes                       |
| -------------------- | ------- | --------------------------- |
| `id`                 | int64   |                             |
| `name`               | string  | Localized.                  |
| `boCount`            | int32   | Active bet offers in group. |
| `uri`                | string  | Fetch subgroups.            |
| `englishName`        | string  |                             |
| `groups`             | Group[] | Subgroups.                  |
| `sport`              | string  |                             |
| `eventCount`         | int32   |                             |
| `secondsToNextEvent` | int64   |                             |
| `termKey`            | string  |                             |
| `pathTermId`         | string  |                             |
| `sortOrder`          | string  | See sorting note.           |

**Sorting:** sort by `sortOrder`, then alphabetically by name; groups without `sortOrder` go after sorted ones, alphabetically.

---

### LiveData

| Field             | Type                      | Notes                                                                      |
| ----------------- | ------------------------- | -------------------------------------------------------------------------- |
| `eventId`         | int64                     |                                                                            |
| `matchClock`      | [MatchClock](#matchclock) |                                                                            |
| `score`           | [Score](#score)           |                                                                            |
| `statistics`      | object                    | Includes `football` counters and `sets` ([SetBasedStats](#setbasedstats)). |
| `description`     | string                    | Not localized.                                                             |
| `occurrences`     | [...]                     |                                                                            |
| `liveFeedUpdates` | [...]                     |                                                                            |
| `tickers`         | [...]                     |                                                                            |
| `liveStatistics`  | [LiveStats](#livestats)[] |                                                                            |

---

### LiveStats

Occurrence counter for one occurrence type.

| Field              | Type   | Notes           |
| ------------------ | ------ | --------------- |
| `occurrenceTypeId` | string | See list below. |
| `count`            | int32  |                 |

**Football:** `ATTACK_HOME`/`AWAY`, `DANGEROUS_ATTACK_HOME`/`AWAY`, `SHOTS_ON_TARGET_HOME`/`AWAY`, `SHOTS_OFF_TARGET_HOME`/`AWAY`, `GOALS_HOME`/`AWAY`, `CARDS_YELLOW_HOME`/`AWAY`, `CARDS_RED_HOME`/`AWAY`, `CORNERS_HOME`/`AWAY`.
**Tennis:** `ACES_WON_HOME`/`AWAY` (sum), `DOUBLE_FAULTS_HOME`/`AWAY` (sum), `FIRST_SERVE_WINNING_HOME`/`AWAY` (percent), `BREAK_POINT_CONVERSION_HOME`/`AWAY` (percent).

---

### MatchClock

| Field                                        | Type    | Notes                                                         |
| -------------------------------------------- | ------- | ------------------------------------------------------------- |
| `minute`, `second`                           | int32   |                                                               |
| `minutesLeftInPeriod`, `secondsLeftInMinute` | int32   | Reverse-clock sports only.                                    |
| `period`                                     | string  | Localized label or numeric string.                            |
| `running`                                    | boolean | If true, client should tick locally each second until update. |
| `disabled`                                   | boolean |                                                               |
| `periodId`                                   | string  |                                                               |
| `version`                                    | int64   | Use to detect latest data.                                    |

---

### Score

| Field          | Type   | Notes                      |
| -------------- | ------ | -------------------------- |
| `home`, `away` | string |                            |
| `info`         | string | Free-form.                 |
| `who`          | string | `HOME \| AWAY \| UNKNOWN`. |
| `version`      | int64  |                            |

---

### SetBasedStats

| Field          | Type    | Notes                                              |
| -------------- | ------- | -------------------------------------------------- |
| `home`, `away` | int32[] | Scores in playing order. Non-played sets are `-1`. |
| `homeServe`    | boolean | Tennis/volleyball only. May be absent.             |

---

### Meeting

| Field            | Type     | Notes                                                                                      |
| ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| `meetingId`      | string   |                                                                                            |
| `context.sport`  | object   | `name`, `englishName`, `termKey`, `sortOrder`.                                             |
| `context.region` | object   | Same shape.                                                                                |
| `context.course` | object   | Same shape.                                                                                |
| `events`         | object[] | `id`, `startTime`, `state`, `originalStartTime` (deprecated), `originalStartDate`, `tags`. |

---

### ReceivableRewardDto

Reward assigned when a bet with a Second Chance reward is lost.

| Field                   | Type                                                  | Notes     |
| ----------------------- | ----------------------------------------------------- | --------- |
| `percentageOfStake`     | double                                                |           |
| `maxAmount`             | double                                                |           |
| `rewardType`            | enum                                                  |           |
| `currency`              | string                                                | Required. |
| `expirationDate`        | date-time                                             | ISO 8601. |
| `profitBoostProperties` | [ProfitBoostPropertiesDto](#profitboostpropertiesdto) |           |
| `oddsBoostProperties`   | [OddsBoostPropertiesDto](#oddsboostpropertiesdto)     |           |
| `criteria`              | [RewardCriteriaDto](#rewardcriteriadto)               |           |
| `rewardTemplateId`      | int64                                                 |           |

---

### OddsBoostPropertiesDto

| Field                  | Type  | Notes                               |
| ---------------------- | ----- | ----------------------------------- |
| `boostedOdds`          | int32 | Required. Odds × 1000.              |
| `minStake`, `maxStake` | int64 | `maxStake` required.                |
| `maxExtraWinnings`     | int64 | E.g. payout 4€ → 7€ means 3€ extra. |

---

### ProfitBoostPropertiesDto

| Field                  | Type  | Notes                                                              |
| ---------------------- | ----- | ------------------------------------------------------------------ |
| `boostPercentage`      | int32 | Required. % applied to combination odds.                           |
| `minStake`, `maxStake` | int64 | `maxStake` required.                                               |
| `maxExtraWinnings`     | int64 | Required.                                                          |
| `minWonLegs`           | int32 | Paid out only if ≥ this many legs settled as won (and not voided). |

---

### RewardCriteriaDto

| Field                                                    | Type    | Notes                                                                   |
| -------------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `minCombinationSize`, `maxCombinationSize`               | int32   | Bet builder selection counts as 1 regardless of legs.                   |
| `minCombinationOdds`, `maxCombinationOdds`               | int32   | × 1000.                                                                 |
| `eventGroupIds`, `eventIds`, `outcomeIds`, `betOfferIds` | [...]   |                                                                         |
| `live`                                                   | boolean | `true` = live only, `false` = prematch only.                            |
| `channels`                                               | [...]   |                                                                         |
| `systemBet`                                              | boolean | `true` = system bet only (e.g. Trixie, Patent).                         |
| `eachWay`                                                | boolean | `true` = each-way only; `false` = no each-way; absent = no restriction. |
| `betBuilder`                                             | boolean | `true` = bet builder only.                                              |
| `minOddsPerLeg`                                          | int32   | × 1000.                                                                 |
| `betPlacementTime`                                       | string  | UK local time, ISO 8601. Same day as event, after this time.            |
| `prePackSelectionIds`                                    | [...]   |                                                                         |
| `minBetBuilderSize`, `maxBetBuilderSize`                 | int32   |                                                                         |
| `criterionIds`                                           | [...]   |                                                                         |

---

## Example Responses

### Live open events response

`GET /{offering}/event/live/open`

```json
{
  "liveEvents": [
    {
      "event": {
        "id": 0,
        "name": "string",
        "nameDelimiter": "string",
        "englishName": "string",
        "homeName": "string",
        "awayName": "string",
        "start": "2026-05-14T08:25:30.485Z",
        "originalStartTime": "string",
        "originalStartDate": "2026-05-14T08:25:30.485Z",
        "group": "string",
        "groupId": 0,
        "path": [
          {
            "id": 0,
            "name": "string",
            "englishName": "string",
            "termKey": "string"
          }
        ],
        "nonLiveBoCount": 0,
        "liveBoCount": 0,
        "sport": "string",
        "tags": ["string"],
        "state": "NOT_STARTED",
        "distance": "string",
        "eventNumber": 0,
        "nameDetails": "string",
        "editorial": "string",
        "raceClass": "string",
        "raceType": "string",
        "trackType": "string",
        "going": "string",
        "timeform": { "analystVerdict": "string", "drawComment": "string" },
        "participants": [
          {
            "participantId": 0,
            "name": "string",
            "englishName": "string",
            "shortName": "string",
            "shortEnglishName": "string",
            "termKey": "string",
            "extended": {
              "startNumber": 0,
              "startPosition": 0,
              "driverName": "string",
              "age": "string",
              "weight": "string",
              "editorial": "string",
              "hasIcon": true,
              "icon": "string",
              "trainerName": "string",
              "formFigures": [{ "type": "string", "figures": "string" }],
              "lastRunDays": [{ "type": "string", "days": "string" }],
              "raceHistoryStat": [{ "type": "string", "stat": "string" }],
              "timeform": {
                "analystsComments": "string",
                "rating123": 0,
                "ratingStars": 0,
                "performances": [
                  {
                    "raceDay": "string",
                    "courseName": "string",
                    "raceNumber": 0,
                    "distanceFurlongs": 0,
                    "distanceYards": 0,
                    "going": "string",
                    "raceType": "string",
                    "positionStatus": "string",
                    "positionOfficial": 0,
                    "numberOfRunners": 0,
                    "jockey": "string",
                    "trainer": "string",
                    "startingPrice": 0,
                    "startingPriceFractional": "string"
                  }
                ]
              },
              "favouriteType": "FIRST"
            },
            "scratched": true,
            "nonRunner": true,
            "home": true,
            "startNumber": 0,
            "participantType": "TEAM",
            "teamMembers": [
              { "participantId": 0, "name": "string", "jerseyNumber": 0 }
            ],
            "nationality": "string"
          }
        ],
        "rank": 0,
        "groupSortOrder": 0,
        "teamColors": {
          "home": { "shirtColor1": "string", "shirtColor2": "string" },
          "away": { "shirtColor1": "string", "shirtColor2": "string" }
        },
        "sortOrder": 0,
        "prematchEnd": "2026-05-14T08:25:30.485Z",
        "meetingId": "string",
        "extraInfo": "string"
      },
      "liveData": {
        "eventId": 0,
        "matchClock": {
          "minute": 0,
          "second": 0,
          "minutesLeftInPeriod": 0,
          "secondsLeftInMinute": 0,
          "period": "string",
          "running": true,
          "disabled": true,
          "periodId": "string",
          "version": 0
        },
        "score": {
          "home": "string",
          "away": "string",
          "info": "string",
          "who": "string",
          "version": 0
        },
        "statistics": {
          "football": {
            "home": { "yellowCards": 0, "redCards": 0, "corners": 0 },
            "away": { "yellowCards": 0, "redCards": 0, "corners": 0 }
          },
          "sets": { "home": [0], "away": [0], "homeServe": true },
          "version": 0
        },
        "description": "string",
        "latestVisualization": {
          "id": 0,
          "eventId": 0,
          "occurrenceTypeId": "string",
          "periodId": "string",
          "visualization": { "position": { "x": 0, "y": 0, "zone": "string" } }
        },
        "occurrences": [
          {
            "id": 0,
            "eventId": 0,
            "occurrenceTypeId": "string",
            "secondInPeriod": 0,
            "secondInMatch": 0,
            "secondInPeriodAddedTime": 0,
            "periodId": "string",
            "player": { "id": 0, "name": "string" },
            "playerOut": { "id": 0, "name": "string" },
            "additionalProperties": ["string"],
            "action": "ADDED",
            "index": 0,
            "periodIndex": 0
          }
        ],
        "liveFeedUpdates": [
          {
            "ticker": {
              "eventId": 0,
              "type": "string",
              "minute": 0,
              "message": "string",
              "id": 0
            },
            "score": {
              "home": "string",
              "away": "string",
              "info": "string",
              "who": "string",
              "version": 0
            },
            "type": "string"
          }
        ],
        "tickers": [
          {
            "eventId": 0,
            "type": "string",
            "minute": 0,
            "message": "string",
            "id": 0
          }
        ],
        "liveStatistics": [{ "occurrenceTypeId": "string", "count": 0 }]
      },
      "mainBetOffer": {
        "id": 0,
        "suspended": true,
        "closed": "2026-05-14T08:25:30.485Z",
        "criterion": {
          "id": 0,
          "label": "string",
          "englishLabel": "string",
          "shortLabel": "string",
          "shortEnglishLabel": "string",
          "order": [0],
          "occurrenceType": "DRIVE_RESULT",
          "occurrenceNumberInLifetime": 0,
          "lifetime": "FULL_TIME",
          "occurrenceNumber": 0,
          "raceToValue": 0
        },
        "extra": "string",
        "betOfferType": { "id": 0, "name": "string", "englishName": "string" },
        "placeLimit": 0,
        "eventId": 0,
        "outcomes": [
          {
            "id": 0,
            "label": "string",
            "englishLabel": "string",
            "odds": 0,
            "line": 0,
            "distance": "string",
            "scratched": true,
            "startNr": 0,
            "prevOdds": [0],
            "criterion": { "type": 0, "name": "string" },
            "participant": "string",
            "popular": true,
            "type": "string",
            "homeTeamMember": true,
            "betOfferId": 0,
            "changedDate": "string",
            "participantId": 0,
            "oddsFractional": "string",
            "oddsAmerican": "string",
            "tags": ["string"],
            "status": "OPEN",
            "cashOutStatus": "ENABLED",
            "homeScore": "string",
            "awayScore": "string",
            "lowerLimit": 0,
            "upperLimit": 0,
            "eventParticipantId": 0,
            "occurrence": {
              "occurrenceType": "DRIVE_RESULT",
              "occurrenceTypeLabel": "string"
            },
            "displayOrder": 0
          }
        ],
        "place": true,
        "eachWay": { "fractionMilli": 0, "terms": "string", "placeLimit": 0 },
        "tags": ["string"],
        "oddsStats": {
          "unexpectedOddsTrend": true,
          "outcomeId": 0,
          "startingOdds": 0,
          "startingOddsFractional": "string",
          "startingOddsAmerican": "string"
        },
        "sortOrder": 0,
        "cashOutStatus": "ENABLED",
        "from": 0,
        "to": 0,
        "description": "string"
      }
    }
  ],
  "group": {
    "id": 0,
    "name": "string",
    "boCount": 0,
    "uri": "string",
    "englishName": "string",
    "groups": [null],
    "sport": "string",
    "eventCount": 0,
    "secondsToNextEvent": 0,
    "termKey": "string",
    "pathTermId": "string",
    "sortOrder": "string"
  }
}
```

---

### Highlights response

`GET /{offering}/group/highlight`

```json
{
  "group": {
    "id": 0,
    "name": "string",
    "boCount": 0,
    "uri": "string",
    "englishName": "string",
    "groups": [null],
    "sport": "string",
    "eventCount": 0,
    "secondsToNextEvent": 0,
    "termKey": "string",
    "pathTermId": "string",
    "sortOrder": "string"
  },
  "groups": [
    {
      "id": 0,
      "name": "string",
      "boCount": 0,
      "uri": "string",
      "englishName": "string",
      "groups": [null],
      "sport": "string",
      "eventCount": 0,
      "secondsToNextEvent": 0,
      "termKey": "string",
      "pathTermId": "string",
      "sortOrder": "string"
    }
  ]
}
```

---

### Horse racing event example

```json
{
  "id": 1027565386,
  "name": "Delta Downs",
  "englishName": "Delta Downs",
  "homeName": "Delta Downs",
  "start": "2026-05-06T23:15:00Z",
  "originalStartTime": "00:15",
  "originalStartDate": "2026-05-06T23:15:00Z",
  "group": "Delta Downs",
  "groupId": 2000117502,
  "path": [
    {
      "id": 2000065773,
      "name": "Horse Racing",
      "englishName": "Horse Racing",
      "termKey": "horse_racing"
    },
    {
      "id": 2000069540,
      "name": "America",
      "englishName": "America",
      "termKey": "america"
    },
    {
      "id": 2000117502,
      "name": "Delta Downs",
      "englishName": "Delta Downs",
      "termKey": "delta_downs"
    }
  ],
  "nonLiveBoCount": 2,
  "sport": "GALLOPS",
  "tags": ["COMPETITION", "SHOW_START_NUMBER"],
  "state": "NOT_STARTED",
  "distance": "1f 179y",
  "eventNumber": 1,
  "nameDetails": "2F Stakes",
  "editorial": "",
  "raceClass": "",
  "trackType": "Dirt",
  "going": "",
  "participants": [
    {
      "participantId": 1030270255,
      "name": "Jtf San Corona",
      "englishName": "Jtf San Corona",
      "termKey": "jtf_san_corona",
      "extended": {
        "startNumber": 5,
        "driverName": "Juan Garcia- Gonzalez",
        "age": "3",
        "weight": "9st",
        "editorial": "",
        "hasIcon": true,
        "trainerName": "Gilberto Rosales",
        "formFigures": [{ "type": "FlatAll", "figures": "77699-69" }],
        "lastRunDays": [],
        "raceHistoryStat": []
      },
      "scratched": false,
      "nonRunner": false,
      "home": false,
      "startNumber": 5,
      "participantType": "PARTICIPANT"
    }
  ],
  "groupSortOrder": 2880819019684212736,
  "meetingId": "5589319"
}
```

---

### `betoffer/outcome` response

```json
{
  "betOffers": [],
  "events": []
}
```
