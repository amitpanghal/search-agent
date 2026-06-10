# Tier-1 Extractor Coverage Gaps

> Tracked from the Sprint-4 punt triage of the 400-query extractor→ground probe. These are NOT
> grounding misses — the extractor returned `unsupported` (or crashed) on an in-scope market, so
> grounding never ran. They stay in the eval as honest failing tests; fixing them is extractor work.

## B — in-scope markets the extractor wrongly punts (kept in the eval)

| target id | market | probe query |
| --- | --- | --- |
| 1001159861 | Most Offsides | which team gets flagged offside more |
| 1003194959 | Total Goals by Home Team - 2nd Half | how many do the home team get after the restart |
| 2100097912 | Total Goals - Extra Time | how many in extra time alone |
| 1004670973 | Player's sprints | how many sprints does mbappé clock in the match |
| 1001241016 | Team to Score Least Goals | which of these teams ends up scoring fewest |
| 1002520396 | To qualify for Play-Off | do they sneak into the playoff spots |
| 1001877372 | Team to concede a penalty in the Tournament/League | will they give away a spot kick at some point this season |
| 1002077068 | Player to receive the fastest Card from Kick Off | earliest booking of the match, which player |
| 1003430635 | Team to receive least Red Cards | which club picks up the fewest reds this season |

## Validation crashes — extractor emitted invalid QueryPlan JSON (robustness bug, fix regardless of scope)

| target id | market | probe query | class |
| --- | --- | --- | --- |
| 1002467526 | Total Corners - Low Alternate Line | unders on corners with a really low line | C (quarantined) |
| 1003430635 | Team to receive least Red Cards | which club picks up the fewest reds this season | B (kept) |
| 1007764665 | Georginho Wijnaldum to score in Penalty Shootout - Bets void if the player does not take a penalty in the shootout | wijnaldum scoring from the spot if it goes to pens | C (quarantined) |
| 1002153710 | Total Shots off Target - Including Extra Time | wayward shots over 120 minutes if it goes long | A (rewritten) |
| 1002114354 | Team to score the fastest goal from kick off in the respective match | quickest goal from kickoff out of all today's games, which team | A (rewritten) |
| 1002154385 | Player's fouls committed - Including Extra Time | casemiro fouls over the full 120 if it goes to extra time | A (rewritten) |

## Note — subject-routing (wrong-bucket) misses

Separately, the recall probe found ~19 grounding misses where the gold is in the WRONG subject bucket
(`gold rank = ∞` in tier_1_automation.md). Those are a subject-routing problem (extractor `subject.kind`
or catalog subject tag), not extractor punts and not doc-view-fixable — tracked via the probe log.
