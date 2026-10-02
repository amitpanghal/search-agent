# Offering feed

Component record: how this component works today. The decisions behind it: [adr/offering-feed.md](../adr/offering-feed.md).
Last verified: 2026-09-30 against eb4aae8

## Purpose
One client for Kambi's public offering API, shared by the pipeline, the eval gates and the scripts. Read-only
GETs, no auth. It owns the raw feed shapes (`BetOffer`, `KEvent`, `KOutcome`) and the few facts about the
feed that every caller must respect.

## Input and output
- In: ids (group, event, participant, outcome) and a Kambi locale.
- Out: `BetOfferResponse { betOffers, events, range? }`, event lists, or a joint price.

## How it works
Base URL `https://eu.offering-api.kambicdn.com/offering/v2018/kambi`; every call sends
`lang=<locale>&market=GB`, betoffer calls add `includeParticipants=true`.

| Call | Endpoint | Notes |
|---|---|---|
| `eventsByGroup` | `/event/group/{id}` | never capped; carries `homeName`/`awayName` |
| `betOffersByGroup` | `/betoffer/group/{id}` | `type`, `onlyMain`, `onlyCompetitions`, `excludeLive`/`excludePrematch`, `maxNumberEvents` |
| `betOffersByEvents` | `/betoffer/event/{ids}` | `type`, `onlyMain`; `excludePrePacks` always sent |
| `betOffersByParticipants` | `/betoffer/participant/{ids}` | `type` is the only server filter that bites |
| `onDemandPricing` | `/onDemandPricing/event/{id}/outcome/{ids}` | 200 with the joint price, 400 when not combinable |

Helpers: `levelOf(tags)` reads fixture versus competition from the event tags, `isMain` and `isMainLine`
read the betoffer tags, `localeOf(language)` maps a language name to a Kambi locale (default `en_GB`),
`batches()` chunks id lists.

## Invariants
- Any name match against feed text is diacritic-folded on both sides; the feed stores accents
  inconsistently.
- A failed fetch degrades to an empty, flagged result in recall; it never throws through the pipeline.

## Limits
- Server-side filters are uneven across endpoints (the participant endpoint honours only `type`).
- The feed is behind a proxy from CI; only a local machine can refresh catalogs.

## Where to look
- `src/resolver/shared/offering-client.ts`; `docs/OFFERING_API.md` (endpoints) and `docs/BetOffer.md` (shapes).
- Probe `[kambi]` rows show every request and response.
- Related: recall, combinations, catalogs.
