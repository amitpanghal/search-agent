# ADR: Market taxonomy

Status: accepted — not yet built
Date: 2026-10-03
Component record: none yet (written when built: `components/market-taxonomy.md`)

## Context

Every query that names a market pays one LLM call, shared by its legs, to pick each leg's market from the live
menu (`market-resolution`, `one-market-call`). Measured on 2026-10-02, before one-market-call merged the
per-group calls: the market calls were ~48% of a query's input tokens and 0.7–0.85 s each; the merge then cut
market-stage input on 12 multi-group queries from 87.8K to 48.0K tokens. And the pick is not stable — on a
fresh phrase the model picked the match total `Total Goals` for "total goals by Arsenal" while the team market
`Total Goals by Arsenal` sat at ref 0 of the same menu, and picked the team market for the identical phrase
shape "total goals by Lille" one call later.

The extracted concept is clean and repetitive: the extractor emits the bare market in `market_concept`
("to win", "total goals", "handicap") with the team or player in `subject` and the number and side in `line`
and `direction`. The same few concepts arrive thousands of times. The resolver re-decides each one.

The market a concept maps to is a stable feed fact. Kambi identifies a market by `criterion.id`; the id is
the same on every fixture in every competition (verified: `Full Time` 1001159858 on Premier League and
Champions League fixtures alike) and has not changed between the June 2026 criterion catalog and today.
Team-scoped markets are split by side with two ids and only the label text carries the club name:
`Total Goals by Home Team` 1001159967 / `Total Goals by Away Team` 1001159633, served as "Total Goals by
Arsenal" when Arsenal is at home.

The earlier `bo_types` field (2026-06-29) was a blind extractor guess at the bet offer type, applied to the
fetch; wrong guesses hard-pruned the right market. It was dropped. The static market catalog (2026-06-22) was
a pre-fetch map from concept to criterion that drifted from the feed; it was deleted. This record is neither:
its rows come from the resolver's own past picks, judged and approved, and are matched by id against the
live menu after the fetch.

## Decisions

1. **A post-fetch hint, never a pre-fetch answer.** The fetch stays by entity and untyped. After
   `filterBySubject`, each leg looks its key up; a hit fills `pickByIdx[i]` (`resolve.ts`, before the LLM
   batch) and the leg skips the resolver call. A miss, or a hit whose market is not on today's menu, goes to
   the LLM exactly as before, so a stale row costs only the shortcut. A row can still give a wrong answer when
   two different bets share one key: the key holds only what the extractor wrote, while the resolver also reads
   the raw query for what the phrase dropped (a sub-unit, a side, a time). "Celtics to win the East" extracted
   as `to win` would take the overall Winner, not the conference one. A hit skips the LLM, so only the offline
   judge can catch it; decisions 4 and 5 guard against it.
2. **Key** = `sport | level | subject kind | folded concept | direction class`. The level is `fixture` or
   `competition`; the subject kind is the schema's `player`, `team`, `either_match_team` or `event` — a `soft`
   subject (an undecided reading of 2+ kinds) builds no key and goes to the LLM. The direction class is one of
   `-`, `ou` (over/under), `atleast`, `atmost`, `yn` (yes/no). Over and under share one market, both sides
   priced, and so do yes and no (a missing No row is the selection step's `side-absent`, as on the LLM path);
   at least and at most do not — a Yes-only "at least N" family settles one and never the other. Not in the
   key: the line value, the team or player name, the competition, time, odds — none of them changes the
   market. Every part is already on the leg when the lookup runs.
3. **Value** = `pick`, a list of alternative market references, and `related`, up to three more. Every
   reference has one shape: `{ name, id, side?, variant?, byLine? }`. `name` is Kambi's neutral name (`Total
   Goals by Home Team`), for the reader only — never matched. The criterion id is matched. `pick` is a list
   because one concept has different ids in different competition types: a league winner is `Season Finishing
   Position` 1004240932 with variant `Winner`, a tournament winner is `To Win The Trophy` 1001159600, and the
   June 2026 World Cup menu carries the second and not the first. The menu decides between alternatives: the
   matches of every reference are pooled, one market name among them is the hit, several send the leg to the
   LLM. One concept never gets a second key. `side` is set where Kambi splits a market by team side (`Total
   Goals by Home Team` 1001159967 / `Away Team` 1001159633): the reference then matches only on events where
   the subject plays that side, so a split market is two sided alternatives. A row may hold one side alone:
   the logged menu is the subject-filtered one, which drops the opponent's twin, so a sighting can show only
   the subject's side. The other side comes from a later sighting or one free feed fetch of a fixture where
   the team plays that side, never a guess; until then that side is a miss. Two kinds of family share one id,
   and the reference says which member: by variant — 1004240932 fronts `Winner`, `Top 2`, `Top 4`, `Top 5`
   and `Top 6`, told apart only by the bet offer `description`, so the reference stores `variant` and the
   lookup matches id **and** variant (the identity the menu already uses: English label plus the trimmed
   variant); by threshold — `byLine: true` (decision 7). Bet offer types are not stored: the log carries each
   menu item's type, so a typed fetch mines them when it is decided.
4. **Rows are mined from production logs, offline, and judged by a strong model in a Claude Code session**
   — not by a new tool call in the pipeline. A deterministic script builds a review packet (per key: its
   sightings with query, phrase, sides, the menu with ids, the production pick and related); a session with the
   `taxonomy` skill decides the market per key, writes the rows and the gate fixture, and lists every case where
   production and the judge disagree. The packet ranks a key's sightings by the query words no leg of the plan
   accounts for — the details a phrase may have dropped — taxonomy hits first, since no LLM checked them. The
   judge writes no row for a key when any sighting's dropped detail changes the market (decision 1's example),
   and reports it as an extractor gap. A human reviews the diff and commits. No sighting floor — the human is
   the floor. Manual now; automated later.
5. **A second source, synthetic queries, bootstraps the file** before production logs mature. A
   `synth-queries` skill guides a session to write ~100 queries per sport that cover the real offering
   (market families from the `.sweep` sheets, teams and players with fixtures this week from a live league
   fetch, idioms from the scope aliases) in a deliberate mix: single to multi-leg, team / player / event /
   either-team subjects at fixture and competition level, clean / fuzzy / unclear phrasings, and collision
   pairs (a plain query beside one whose detail lives outside the phrase: `to win` / `to win the East`, a
   period, a side) so key collisions show before production, tagged with the eval's behavior tags. They run
   once through the live pipeline (`probe --file … --out`) and are judged like production. Synthetic seeds
   what markets exist; production teaches how people ask for them.
6. **The file**: `catalogData/market-taxonomy.json`, one file, a section per sport, flat string keys, loaded
   at boot and looked up in memory. Released by deploy, like the catalogs. An hourly read from a bucket is an
   overlay to add only if the deploy cadence proves too slow; never a per-query call.
7. **Runtime rules, in order**: build the key (no row → LLM) → resolve the leg's side per event from the
   fixture's home and away, or take it from an `either_match_team` subject, which names its side; an event
   with no side matches no sided reference, and a reference without `side` needs none, so a competition-level
   leg (an outright has no home or away) goes straight on → per reference in `pick`, the leg's filtered
   offers with its id, the variant when one is stored, the side when one is stored; a `byLine` reference
   keeps only those whose `criterion.order[0]` equals the leg's line (no line → LLM) → the distinct market
   names across every match of every reference: one → hit; several or none → LLM → related, per reference
   the same way on the same fixtures, the names found kept in list order, capped at 3; a sided related
   reference with no side resolved is dropped, not the hit. A hit is graded `exact`. Only the misses become
   bets in the query's one LLM call.
   `byLine` exists for the "To score at least 2 / 3 goals" family (id 1005153925, members differing by
   `criterion.order` `[2]` / `[3]` and outcome line), and the line check runs even when one member is on the
   menu — else "at least 3" takes "at least 2" when 3 isn't offered. The judge sets it; it is never inferred,
   because `order` is `[0]` or `[]` on most other markets and a point in the match in some (tennis set 1 game 5
   → `[1, 5]`).
8. **Live from the first deploy**, behind `TAXONOMY=off`, with `pickSource: taxonomy | llm` logged per leg,
   read from an optional `source` on the pick (`null` when no pick runs: a `main` browse, an unidentified
   subject); dev environment first. No shadow
   mode: the production LLM is the thing that slips, so its agreement is not the yardstick; the offline judge
   is the shadow.
9. **The log record carries what the miner and the gate need**: per leg `key { level, subject, dir }` (`dir`
   is the class exactly as the file writes it, `-` included), `sides` (event id → home | away, where
   resolved), `pick { label, ids, type, match }`, `related` labels, the menu as
   `{ label, ids, type, order?, variant?, eventIds }` (replacing the label list), `pickSource`. That is
   everything the lookup reads, so a record replays without the feed: `order` for the threshold family,
   `variant` for the variant family, `eventIds` for same-fixture related, `sides` for split ids. Related ids
   and judge corrections are resolved from the record's own menu. `sides` is computed once, in the pipeline at
   the filter step, and emitted beside the filtered menu; the log copies it, so the record and the lookup read
   one value and the log never reaches into the resolver's helpers.
10. **A free gate.** `npm run gate:taxonomy` replays the lookup over judged records
    (`src/eval/taxonomy.fixture.jsonl`, a few sightings per key, written by the same session; sides taken from
    the record) and fails if any hit differs from the judge's market. That checks the code, not the rows — the
    same session writes both — so the gate also checks the rows against a source the judge did not write: the
    eval gold's `market_concept.id` cells, with their `direction`, over the captured snapshots (the cells
    `market-resolve-gate.ts` already reads, plus the direction that lift does not read today), where every hit
    must land on a gold criterion id. The gold therefore never seeds a row — a row seeded from it would be
    checked against itself. No model call. Unit tests cover side
    resolution, the alternatives (one on the menu hits, both go to the LLM), the `byLine` choice, hit-on-menu,
    `soft`, and the kill switch. The paid market gate keeps grading the LLM path, with the taxonomy off.
11. **Scope**: all sports, every subject kind but `soft`, fixture and competition level from the start. The
    file begins empty; traffic sets its scope.

## Consequences

- When every named leg of a query hits, the market call is skipped: extract + fetch only, ~1.3 s + ~0.2 s
  instead of ~2.7 s, and about half the tokens (measured before one-market-call; to re-measure). When only some
  legs hit, the one call stays and loses only those bets — little, since the menus overlap — and the remaining
  bets see a smaller union menu and narrower `[may pick]` tags, so their picks can differ from `TAXONOMY=off`.
- Two numbers are read from `pickSource` in the logs: the per-leg hit rate, and the **all-legs-hit share** —
  queries where no leg has `pickSource: llm` and at least one has `taxonomy`, so no market call runs. The
  second measures the saving.
- Three ceilings on the hit rate, none a bug: the key is the exact folded phrase, so each phrasing of a family
  ("to win", "win", "winner", "wins") is its own row and the rate grows as phrasings are seen; the direction
  classes split keys that land on one market ("over 1.5 goals" is `ou`, "2+ goals" is `atleast`, both resolve
  to the team total, select turning at-least into over); an `either_match_team` leg across several fixtures
  never hits, because the sided references find one label per club ("Total Goals by Arsenal", "… by Chelsea")
  and several labels go to the LLM — the limit the LLM path already has, a pick being one label.
- A typed fetch becomes possible later without changing the log: each logged menu item carries its bet offer
  type, so the rows' types are mined then (related markets need their own: `Full Time` 2, `Double Chance` 12,
  `Half Time/Full Time` 8, `Both Teams To Score` 18). Measured
  2026-10-02, `type=2` on the Premier League group returned 283 KB / 51 ms / 20 events against 1.9 MB /
  164 ms / 2000 offers (capped, 8 events) untyped; on the Arsenal participant endpoint 41 KB / 43 ms against
  914 KB / 153 ms. The cap escape matters more than the bytes. Switching it on is its own ADR.
- The log record grows by roughly 5 KB on a 100-item menu (ids, type and event ids per item; estimate). Still
  one compact record.
- The variant is read from the bet offer `description`, and the fetch follows the user's locale. If Kambi
  translates it ("Vinnare"), a variant row misses for non-English users — safe, the LLM answers. To check once
  live.
- The offline job doubles as an audit: every production pick the judge overturns is a resolver error found
  for free. A taxonomy hit has no LLM check, so the judge is its only reviewer (decision 1).
- Two skills to write: `taxonomy` (judge a packet, write rows and fixture, run the gate) and `synth-queries`
  (generate per-sport lists from the real offering). Two npm commands: `taxonomy`, `gate:taxonomy`.

## Build order

The same order as the plan (`planning/market-taxonomy.md`), which holds the detail.

1. Log fields (`src/server/log.ts`, with `sides` and the pick `source` emitted by `resolve.ts`) → deploy →
   production starts collecting.
2. In parallel: `gate:taxonomy` and the unit tests (the lookup's cases written as `todo` until step 4), with a
   second captured snapshot — one league fixture plus its league group — so the gold pass reaches league rows
   the June World Cup capture lacks; the script `npm run taxonomy -- --from capture.jsonl | --since 7d`
   (capture reader first, CloudWatch pull second); the skills `synth-queries` and `taxonomy`.
3. Seed session: the 2026-10-02 probe capture into the first rows. The gold's id cells stay out of the rows;
   they are the second gate pass's independent source (decision 10).
4. Lookup (`src/resolver/market/taxonomy.ts`), the hook in `resolve.ts`, `TAXONOMY=off` → dev deploy.
5. The synthetic bootstrap run and its judging session; then the first production session on a week of logs,
   weekly after.
6. Docs, alongside step 4: this record flips to `current — built`; `components/market-taxonomy.md` is written;
   `components/market-resolution.md`, `recall.md` and `logging.md` get their pointer lines; the
   `resolver-pipeline` skill's stage table gains the step; CLAUDE.md gains the two commands;
   `.env.example` gains `TAXONOMY`.

## Evidence

- Probe 2026-10-02, two queries, compacted capture in `src/eval/team-scoped.capture.jsonl` (plan, picks, the
  menus with ids, the fixtures): extractor emitted `team Arsenal / total goals` and `team Lille / total goals`;
  resolver picked `Total Goals` (close) for Arsenal and `Total Goals by Lille` (exact) for Lille; "Arsenal over
  1.5 goals and Lille under 0.5 goals" picked both team markets (Lille graded close).
- Live feed 2026-10-03: competition-level ids are shared across leagues (`Season Finishing Position —
  Winner` 1004240932 on the Premier League, La Liga and Serie A; `Team(s) to be relegated` 1001625325; `To
  score most goals in the Competition` 1001304945 on PL, Serie A and the Champions League). Id 1004240932
  fronts `Winner` to `Top 6` on one competition with empty `order` and the same team outcomes — only
  `description` separates them (decision 3).
- Captured menu snapshot (`src/eval/live-menu.snapshot.json`, World Cup 2026, June): the tournament winner is
  `To Win The Trophy` 1001159600, the position market `Finishing Position` 1004240929 (`Winner` to `Top 16`),
  the group market `Group Finishing Position` 1004240933; 1004240932 has no offer. A cup and a league answer
  the same key with different ids — why `pick` is a list of alternatives (decision 3).
- Captured menu snapshot (`src/eval/live-menu.snapshot.json`): `criterion.order` is `[2]` / `[3]` on the "at
  least N goals" family, `[1]` on `To Score`, `[0]` on 205 offers (mostly over/under) and `[]` on 417 —
  why `byLine` is set by the judge, never inferred (decision 7).
- Live feed 2026-10-02: criterion ids per (market, side) across Arsenal–Lille (UCL), Arsenal–Leeds and
  Forest–Arsenal (PL); the June 2026 criterion catalog (git, `data/football/football_criterions.json` before
  1f317ea) names them `Total Goals by Home Team` / `Away Team` with `side: home | away`.
- 293 saved extractions: 2–4 phrasings per market family ("who wins", "to win", "winner", "wins").
- `.sweep` sheets, 19 sports: a plain winner is type `Match` and a total is `Over/Under` in every sport; only
  the label varies (`Full Time`, `Match Odds`, `Moneyline - Including Overtime`, `Regular Time`).

## Related

- market-resolution, one-market-call, recall, logging, evaluation, catalogs. Superseded ideas: the static
  market catalog (deleted 2026-06-22) and the extractor's `bo_types` (dropped 2026-06-29).
