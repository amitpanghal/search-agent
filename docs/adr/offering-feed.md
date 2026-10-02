# ADR: Offering feed

Status: current — built
Date: 2026-09-30
Component record: [components/offering-feed.md](../components/offering-feed.md)

## Context
One client for Kambi's public offering API, shared by the pipeline, the eval gates and the scripts. Read-only
GETs, no auth. It owns the raw feed shapes (`BetOffer`, `KEvent`, `KOutcome`) and the few facts about the
feed that every caller must respect.

## Decisions
- **The 2000-betoffer cap is silent.** Every betoffer response is capped at 2000 and the truncation shows
  only in `range.total`, which small responses omit. Recall detects it and fans out by event.
- **`englishLabel` over `label`.** The `label` is localized and reversible; `englishLabel` is the stable
  identity for criteria and outcomes. The betoffer `description` is the market variant and part of its
  identity.
- **`market=GB` is fixed; only `lang` varies.** The locale localizes labels, never which markets exist.
- **Time is not a server filter.** The API ignores `from` and `to`; time windows are applied client-side.
- **Pre-packs are excluded on event fetches.** Bet-builder pre-packs are not markets a user asks for.
- **Odds are raw millis everywhere.** The client never formats.
- **The catalog build scripts fetch through a headless browser.** CloudFront in front of the feeds hosts
  returned 410 to every non-browser TLS fingerprint (verified 2026-08-16), so `scripts/curl-fetch.ts` runs
  each GET inside a Chromium page. The runtime client uses plain `fetch`.

## Related
- Related: recall, combinations, catalogs.
