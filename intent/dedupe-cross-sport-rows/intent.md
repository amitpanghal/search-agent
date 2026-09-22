# Intent: Dedupe cross-sport candidate rows

- **Date:** 2026-09-22
- **Source:** human
- **Status:** accepted
- **Jira:** none

## Problem / observed signal

The entity disambiguator shows the model, and the user's clarify message, the same candidate more than
once. Cross-sport widening in `src/resolver/resolve-entities.ts` (`crossSportRows`, the `rows.push` at
line 142) runs both the team grounder and the player grounder against every other sport's catalog and
pushes every hit, so a row both grounders match is listed twice. The `ForeignIds` map next to it already
dedupes by id; the `rows` list does not.

Seen on 2026-09-21 while replaying a captured cell for the query "Tell me when Arsenal or Spurs drop
below 2.0": the candidates for "Tottenham Hotspur" were 5 esports clones plus trotting id 1003385961
"Tottenham" listed twice — 7 rows for 6 entities. Evidence: the local probe trace
`scripts/.trace-out/snipe-rerun2-2026-09-10.jsonl` (gitignored, not committed) and the code above. No
user report; the duplicate is visible in the trace, not in a ticket.

## Desired outcome

Every candidate list the disambiguator shows the model, and every clarify suggestion list shown to the
user, names each entity once.

## Non-goals

- Not fixing why a trotting horse is offered for a football query at all (catalog pollution; a separate
  intent).
- No change to candidate ranking, per-sport quotas or caps beyond keeping the first occurrence of an id.
- No Jev work.

## Constraints known up front

- `resolve-entities.ts` is shipped resolver code: plan and approval before the edit (the **Human-gated
  resolver code** rule).
- Deterministic change; no paid probe or eval is needed to prove it.

## Success signal

A new invariant in `npm test` fails on the duplicate before the fix and passes after; the captured
"Tottenham Hotspur" cell replays with 6 candidates instead of 7. No production metric exists for this.

## Decisions

