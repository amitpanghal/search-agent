# ADR: "His team" binds per fixture, from the live feed

Status: current — built
Date: 2026-10-03
Component record: [components/selection.md](../components/selection.md)

## Context

"Wirtz 1+ shots on target and his team to win" came back with Greece to win Greece v Germany. The extractor
did what its prompt says: an unnamed team ("his team") becomes `either_match_team` with no side, and the player
stays in the leg's scope. Nothing downstream turned that into the player's side, so select got no subject and
took each fixture's first outcome, "1", the home team: Greece, Liverpool and Brentford across Wirtz's three
fixtures (two of three wrong). That is the blind pick the selection ADR forbids.

The extractor cannot fix it. The player's side changes per fixture (away for Germany in Greece v Germany, home
for Liverpool against City), and only the fetched fixtures know it. The bet-offer response does: every outcome
about a player carries `eventParticipantId`, the event participant he plays for, and each event lists its two
participants with a `home` flag (verified on the 2026-10-03 capture).

## Decisions

- **Bind per fixture.** A leg whose subject is `either_match_team` with no side and whose scope holds exactly one
  confidently grounded player gets `sideByEvent`: per event, the side his team holds. Select keeps only that
  side's outcomes in each fixture, through the existing per-fixture home/away check.
- **Live data only.** His team in a fixture is the `eventParticipantId` on his own outcomes there; its side is
  that participant's `home` flag in the event. No catalog lookup.
- **No outcome of his, no side.** A fixture where he has no outcome drops out; none left is an honest
  `subject-absent`, never the home side.
- **Scorelines too.** "His team" means the same team in every market. Select reads correct-score and
  half-time/full-time tokens before the subject step, so that branch also takes the side from each outcome's own
  fixture: "2-1" where he plays away is the feed's home-first "1-2", "win/win" away is "2/2". A fixture with no
  recorded side never matches. A named team keeps its one side for the whole slice.
- **Rejected: the catalog as a fallback.** His catalog club or national team could fill a fixture where he has
  no market, but it goes stale between catalog builds, and a "his team" bet almost always sits next to a bet on
  the player, which needs his markets anyway.

## Consequences

- Replayed on the 2026-10-03 Wirtz capture: Greece v Germany "2" Germany, Liverpool v Man City "1" Liverpool,
  Brentford v Liverpool "2" Liverpool (was "1" in all three). Live probe the same day: the betslip is Wirtz
  over 0.5 shots on target + Germany to win in Greece v Germany @2.55 (was + Greece to win @6.40).
- Scorelines replayed on the same capture: correct score "2-1" for his team is "2-1" in Liverpool v Man City and
  "1-2" in Brentford v Liverpool and Greece v Germany (was the literal "2-1" in all three: two wrong winners);
  "win/win" is "1/1", "2/2", "2/2" (was not priced).
- Keyed on what the extractor returns, not on wording: "her side", "their team", "Kane's team" and other
  languages bind the same way. A side the query names ("the home team") and a named team are unchanged.
- Not covered: a leg naming two players gets no "his team" binding.
