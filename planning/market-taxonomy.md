# Market taxonomy — skip the resolver LLM call when the concept is already known

Agreed 2026-10-02/03 (grill session). Status: **accepted, not built**. The why and the decisions:
[docs/adr/market-taxonomy.md](../docs/adr/market-taxonomy.md). This page is the how: artefacts, build order,
acceptance, open items. It does not restate the decisions; where it names one it points at the ADR by number.

## In one paragraph

After `filterBySubject`, each leg looks up `sport | level | subject kind | concept | direction class` in a
committed JSON file. A hit names a criterion id (a home/away pair for team-scoped markets); if that id is on the
leg's live menu as exactly one market, the leg is resolved without the LLM. Rows are mined offline from
production logs and from a synthetic query run, judged in a Claude Code session, reviewed by a human, committed,
deployed. `TAXONOMY=off` turns it off. Rows store no bet offer types; the log keeps one per menu item, mined if a
typed fetch is accepted (its own ADR).

> Rejected on purpose, don't re-propose (ADR Context + decisions 1, 4, 6, 8): a pre-fetch `type=` from the
> taxonomy now; a per-query read from a bucket; learn-on-miss in process memory; hand-written rows as the source;
> a judge as a new pipeline tool call; shadow mode; a sighting floor; matching on label text; a skill per
> component; a lower bar for the "at least N" shared-id family (it goes to the LLM unless the leg has a line).

## Artefacts

### The file — `catalogData/market-taxonomy.json` (ADR 2, 3, 6)

```json
{
  "football": {
    "fixture|team|to win|-": {
      "pick":    { "name": "Full Time", "id": 1001159858 },
      "related": [ { "name": "Draw No Bet", "id": 1001159862 },
                   { "name": "Double Chance", "id": 1001159870 } ]
    },
    "fixture|team|total goals|-": {
      "pick":    { "name": "Total Goals by Home/Away Team", "home": 1001159967, "away": 1001159633 },
      "related": [ { "name": "Total Goals by Home/Away Team - 1st Half", "home": 1003194958, "away": 1003194956 },
                   { "name": "Total Goals", "id": 1001159926 } ]
    },
    "fixture|player|goals|atleast": {
      "pick":    { "name": "To score at least N goals", "id": 1005153925, "byLine": true },
      "related": []
    },
    "competition|team|to win|-": {
      "pick":    { "name": "Season Finishing Position — Winner", "id": 1004240932, "variant": "Winner" },
      "related": [ { "name": "Season Finishing Position — Top 4", "id": 1004240932, "variant": "Top 4" },
                   { "name": "Team(s) to be relegated", "id": 1001625325 } ]
    }
  }
}
```

Key = `level|subject kind|folded concept|direction class` under the sport (ADR 2): level ∈ `fixture`,
`competition`; subject kind ∈ `player`, `team`, `either_match_team`, `event` (`soft` builds no key); direction
class ∈ `-`, `ou`, `atleast`, `atmost`, `yn`. A market reference is `{ name, id }` or
`{ name, home?, away? }` (at least one side), plus `variant` when the id is shared across variants (ADR 3) and
`byLine: true` on a threshold family (ADR 7). `name` is for the reader. Nothing else
in a row. A half pair is normal at first: the logged menu is subject-filtered, so the opponent's twin ("Total Goals
by Lille" when the subject is Arsenal) never shows; the missing side is a miss until filled (ADR 3).

### The lookup — `src/resolver/market/taxonomy.ts` + one hook in `resolve.ts` (ADR 1, 7)

- `loadTaxonomy()` at boot: the file into a `Map<string, Row>` per sport; `TAXONOMY=off` → empty map.
- `sidesOf(events, subject, subjectId, subjectName): Record<eventId, "home" | "away">` — an `either_match_team`
  subject names its side: every event gets `subject.side` (none named → no sides). Otherwise per event, the
  `participants[]` entry whose `participantId` equals the grounded subject id → `home ? "home" : "away"`;
  fallback, folded name against `homeName` / `awayName`; neither → the event is left out. Per event, because a
  multi-fixture leg can be home in one match and away in the next. Separate from `lookup` so the gate replays the
  logged `sides`.
- `lookup(leg, sel, sides, offers): MarketPick | undefined`, rules in order:
  1. key from the leg (`leg.level`, `sel.subject.kind`, `fold(sel.market_concept)`, class of `sel.direction`);
     a `soft` subject or no row → `undefined`.
  2. the id per offer: a single-id reference → that id, no side needed (an outright has no home or away, so
     `competition|team|to win|-` must not depend on one); a pair → the id of `sides[offer.eventId]`, and an event
     with no side, or whose side's id isn't stored, contributes nothing.
  3. offers with `criterion.id ===` that id, and `description === variant` when the reference carries one; a
     `byLine` reference keeps only those whose `criterion.order[0] === sel.line` (no numeric line → `undefined`),
     even when one member is on the menu. Then distinct `marketLabelOf` labels: one → the hit; several or none →
     `undefined`. `order` is never read without `byLine` — it is `[0]` or `[]` on most markets (ADR 7).
  4. related: each reference → same mapping on the same `eventId`s (a pair with no side is skipped, not the
     hit); keep the labels found, cap 3.
  Returns `{ label, match: "exact", related }`.
- Hook in `resolve.ts`, in the per-group loop just before `llmIdxs` is computed: for each `i` in `idxs` with no
  pick yet and `market_concept !== "main"`,
  `pickByIdx[i] = lookup(leg, sel, sidesOf(scoped.events, sel.subject, …), fr.offers)` when defined. The
  `pickSource` per leg is emitted on the `market` stage output for the log.

### The log record — `src/server/log.ts` (ADR 9)

Per leg today: `phrase, pick (label), match, matched, labels[]`. Per leg after:

```json
{ "phrase": "total goals",
  "key": { "level": "fixture", "subject": "team", "dir": "-" },
  "sides": { "1024001234": "home" },
  "pick": { "label": "Total Goals by Arsenal", "ids": [1001159967], "type": 6, "match": "exact" },
  "related": ["Total Goals by Arsenal - 1st Half", "Total Goals"],
  "menu": [ { "label": "Total Goals by Arsenal", "ids": [1001159967], "type": 6, "eventIds": [1024001234] },
            { "label": "To score at least 2 goals", "ids": [1005153925], "type": 127, "order": [2], "eventIds": [1024001234] },
            "…" ],
  "pickSource": "llm", "matched": true }
```

`dir` is the class exactly as the file writes it. `pickSource` is `taxonomy`, `llm`, or `null` when no pick runs
(a `main` browse, an unidentified subject). `menu` replaces `labels`: per item ids, type and event ids, plus
`order` and `variant` when set, from the filter stage's offers via `marketLabelOf`. That is everything `lookup`
reads, so a record replays in the gate with no feed (ADR 9). Related ids and judge corrections are resolved from
`menu`. `sport` stays where it is (`ground.sport`). The menu is the subject-filtered one, so the opponent's twin is
absent (half pairs, above).

### The packet script — `scripts/taxonomy.ts`, `npm run taxonomy` (ADR 4)

`--from capture.jsonl` (probe `--out` traces, or exported log lines) first; `--since 7d` (CloudWatch
`/ecs/search-agent-dev`, SigV4 fetch through the in-tree deps, no `aws` CLI) second. Groups legs by
`sport + key`; writes `taxonomy-packet.jsonl`, one line per key: `{ sport, key, sightings: [{ query, phrase,
sides, menu, pick, related, pickSource }] }`, sightings capped (say 8). Ranked for the cap by the query's
leftover words — those no leg of its plan accounts for (not in any phrase, subject, scope or line), i.e. what a
phrase may have dropped — taxonomy hits first, since no LLM checked them (ADR 1, 4). Deterministic; no model call.
Prints a tally: keys, sightings, sightings cut by the cap, keys already in the file, keys whose production picks
disagree among themselves.

### The gate — `npm run gate:taxonomy` (ADR 10)

`src/eval/taxonomy-gate.ts` over `src/eval/taxonomy.fixture.jsonl` (judged records: the packet sighting plus the
judge's market as ids). For each record: run `lookup` with the record's `sides` against its menu rebuilt as offers,
one per (event id, id) of each item, carrying label, `order` and `variant` (an item whose two ids sit on two events
crosses them — harmless, the hit is a label); pass iff every hit equals the judge's ids; print hit rate.

That checks the code, not the rows — the same session writes rows and fixture — so a second pass checks the rows
against a source the judge did not write (ADR 10): the gold's `market_concept.id` cells, lifted exactly as
`market-resolve-gate.ts` lifts them (accept phrasings, subject kind, level, direction), each looked up against
`live-menu.snapshot.json` with a pair tried on both sides; every hit must land on one of the cell's gold criterion
ids. A key the snapshot can't reach is a miss, not a failure.

Wired into `npm run eval`'s exit code like `gate:live-menu`; free, no network.

### The two skills (ADR 4, 5)

- `.claude/skills/taxonomy` — judge a packet, write rows and the fixture, run the gate. Holds the rules that
  decide a row (key parts; home/away ids — a half pair is fine, the other side filled only from a later sighting
  or one free feed fetch of a fixture where the team plays that side, never guessed; shared-id families need a
  `variant` on the reference, or `byLine: true` when the members differ by `criterion.order` as a threshold —
  set only after checking the members' `order` against their outcome lines; related ≤ 3; a `none` is a vote
  against; what never becomes a row: `outcomeLabel` picks, `main`, a `soft` subject, a key whose sightings the
  judge cannot settle, a key where any sighting's leftover words change the market — "Celtics to win the East"
  under `to win` — reported as an extractor gap), the packet and file formats, the report of production
  disagreements, and the review checklist.
- `.claude/skills/synth-queries` — write `queries/<sport>-synth.txt`. Inputs: `.sweep/<sport>.json` families
  (every family ≥ 3 queries), a live `event/group/<league>` fetch for teams and players with fixtures in 7 days
  (the sweep's fixture samples are esports-polluted — exclude esports and virtual groups by name),
  `catalogData/<sport>-scope-aliases.json` for idioms. Quotas per 100: legs 50 / 30 / 20 (1 / 2 / 3+); 85
  fixture-level (35 team / 25 player / 25 `event` or `either_match_team` subject) and 15 competition-level;
  clarity 50 clean / 30 fuzzy / 20 unclear; at least 5 collision pairs — a plain query beside one whose detail
  lives outside the phrase (`to win` / `to win the East`, a period, a side), so key collisions show before
  production (ADR 5). Each query preceded by a `#` line: intended key(s), behavior tags from
  `src/eval/behavior-tags.ts`, clarity. Never copy the gold. Ends with a coverage tally.

## Build plan

Ungated (server, scripts, eval tooling, tests, docs, skills):

1. **Log fields** — `src/server/log.ts`: the per-leg entry above. Reads what the trace already carries
   (`extract` plan, `filter` offers, `market` picks, the scoped events + grounded subject id for `sides`), with
   `sidesOf` written now in `src/resolver/market/taxonomy.ts` (a pure helper, not wired into the pipeline until
   item 10, which reuses it). Declares `order?: number[]` on `BetOffer.criterion` (`offering-client.ts`; the
   feed sends it, the type lacks it). One unit test on a captured trace. The same change updates every reader
   of the old shape (`labels` → `menu`, `match` → `pick.match`): the record example and field list in
   `planning/logging.md`, `docs/components/logging.md`, `src/server/log.test.ts` (it asserts `labels`), and
   any saved Logs Insights query (SB-195171). Deploy → production starts collecting. *Prerequisite for everything mined.*
2. **Gate + fixture + tests** — `src/eval/taxonomy-gate.ts` (both passes), the fixture file (empty at first), the
   `invariants.test.ts` cases — the `sidesOf` ones run now; the ones that call `lookup` are written as `todo`
   (node's runner reports them without failing) and switched on by item 9. The cases: home/away side
   resolution (per event, and an `either_match_team` subject's own side), a competition-level team row hits
   with no side, a half pair misses on its unknown side, a `byLine` reference takes the line's member and misses when only another member is on the menu, `order` is ignored
   without `byLine`, the shared-id variant match, a `soft` subject never hits, a hit is always on the menu,
   `TAXONOMY=off`.
3. **Packet script** — `scripts/taxonomy.ts`, capture reader first, CloudWatch pull second.
4. **Skills** — `synth-queries`, then `taxonomy`.
5. **Seed session** — judge the eval gold's verified concept → criterion cells and the 2026-10-02 probe capture
   (`src/eval/team-scoped.capture.jsonl`) into the first rows (football). Review, commit. The file is small but
   not empty when the lookup ships.
6. **Synthetic bootstrap** — per-sport lists from the skill (football first, then the sports with expected
   traffic), one paid batch run per list through `probe --file … --out` (ask first), packet, judging session,
   review, commit, deploy.
7. **Production sessions** — after a week of logs: `--since 7d`, judge, review, commit, deploy; weekly, slowing as
   the file saturates.
8. **Docs when built** — ADR status to `current — built <commit>`; `docs/components/market-taxonomy.md`
   (purpose, in/out, how it works, invariants, limits, where to look); pointer lines in
   `components/market-resolution.md`, `recall.md`, `logging.md`; the step in the `resolver-pipeline` skill's stage
   table; the two commands in the CLAUDE.md table; `TAXONOMY` in `.env.example`.

Gated (resolver code — plan + worked example, then ask before editing; CLAUDE.md rule 2):

9. **`src/resolver/market/taxonomy.ts`** — load + `lookup` as specified above. `sides` and `offers` are passed in,
   so the gate and tests replay without a network. Done when item 2's `todo` cases are switched on and pass, and
   both gate passes are green.
10. **The hook in `resolve.ts`** — ~10 lines before `llmIdxs`; `pickSource` on the `market` stage emit.

Order: 1 → (2, 3, 4 in parallel) → 5 → 9, 10 → dev deploy → 6 → 7; 8 alongside 9–10.

## Acceptance

- `npm test`, `npm run typecheck`, `npm run lint`, `npm run gate:live-menu`, `npm run gate:taxonomy` green.
- Dev deploy: the two 2026-10-02 probe queries resolve both team legs with `pickSource: taxonomy` and zero
  `pick` LLM calls; `TAXONOMY=off` restores today's behaviour exactly.
- Paid 1× `npm run eval` with the taxonomy off: unchanged (the LLM path is untouched).
- After the first production week: hit rate from `pickSource` reported; production disagreements from the judge
  reported as a list — the first free audit of the resolver.

## Open items

- Which strong model the judging session runs on is a session setting, not code; nothing to decide here.
- ~~Competition-level ids: per competition or shared?~~ Verified 2026-10-03: shared (`Winner` 1004240932 on
  PL, La Liga, Serie A; relegation 1001625325; top scorer 1001304945 on PL, Serie A, UCL). One row covers all
  competitions. The check found the variant-shared family (`Winner` / `Top 2` / `Top 4` / `Top 5` / `Top 6` on
  one id) → the `variant` field (ADR 3).
- A hit on a `close`-only situation cannot happen (rows are exact by construction); a leg whose exact market is
  missing today takes the LLM path as before. Fine, noted.
- The log record is ~5 KB larger on a 100-item menu (estimate). If CloudWatch cost becomes visible, cap `menu` to the
  items the filter kept (it already is the filtered menu) — nothing further planned.
- Is the bet offer `description` (the variant) localized? The fetch follows the user's locale; if it is, a variant
  row misses outside English — safe, the LLM answers. Check on one non-English fetch at the dev deploy.
- Typed fetch (`type=`, the rows' types mined from the logged menus): a separate ADR when the hit rate and the
  all-legs-hit share are known.
- Jira: created 2026-10-03, see below.

## Jira

Under epic PD-9573 "NL Search — Partner POC", next to SB-195164 (logging; sub-task 195347 extends that record).

- **SB-195345** — story: NL Search - Market taxonomy: skip the resolver LLM call for known concepts
  - SB-195347 — Agent: log the picked market's ids, type and side, and the menu with ids, per leg (build item 1)
  - SB-195348 — Agent: taxonomy lookup and the hook before the resolver call, `TAXONOMY=off` (items 9, 10; gated)
  - SB-195349 — Eval: `gate:taxonomy` replay gate, fixture and unit tests (item 2)
  - SB-195350 — Script: `npm run taxonomy` — review packet from captures and CloudWatch (item 3)
  - SB-195351 — Skills: `synth-queries` and `taxonomy` (item 4)
  - SB-195352 — Taxonomy: seed from the eval gold, synthetic bootstrap run and judging (items 5, 6)
  - SB-195353 — Taxonomy: first production judging session, then weekly (item 7)
  - SB-195354 — Docs: ADR to current, component record, pointers, CLAUDE.md, `.env.example` (item 8)
- **SB-195346** — story: NL Search - Typed fetch from the taxonomy (decision pending data); blocked by SB-195345;
  ADR `docs/adr/typed-fetch.md`. No sub-tasks until the decision.

Order: 195347 → (195349, 195350, 195351) → 195352 → 195348 → dev deploy → 195353; 195354 alongside 195348.
