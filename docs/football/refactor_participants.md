# Skill: Refactor participants for embedding

Turn a raw Kambi participant feed into a flat, deduped, English-only set of
records ready to embed. Two input shapes are supported:

- **Per-league** (one league at a time) — small, fixed-scope.
- **Sport-wide** (all participants for one sport in one file) — the
  production path; the script derives each team's home country from its own
  competition mix.

## When to use

- Ingesting a sport's clubs + players into the search index.
- Re-running after a refresh of the participants feed or `groups.json`.
- Generalising to a new sport — the rules are sport-agnostic; pass
  `--sport-label`/`--sport-slug`.

## Inputs

| File | Source | Notes |
|---|---|---|
| `groups.json` | `feeds-eu.offering-api.kambicdn.com/feeds/api/{operator}/group.json` (full offering tree) | Used to classify every groupId and to walk ancestor chains. Any groupId not present in this tree is treated as stale and dropped. |
| Raw participants (per-league) | `.../participant/group/{leagueId}.json` | One league per call. ~1.3 MB / 1822 records for the Premier League. |
| Raw participants (sport-wide) | `.../participant/sport/{sportLabel}.json` | One file per sport. ~47 MB / 130,899 records for football. Same record shape as per-league; ~2,554 teams have populated `teamMembers` (real clubs); the rest are historical/unsquadded TEAMs that drop. |

Both endpoints are IP-whitelisted (Kambi VPN). Fetch in a browser, save to disk,
then point the script at the local files.

## Refactor rules

The raw feed mixes entities, betting outcomes, historical records, and many
locale variants. Apply these in order:

1. **Drop `type == "LABEL"` at the top level.** ~25% of records. These are
   betting-outcome strings ("2 Trophies Won", "4-6"), not entities.
2. **Drop top-level `type == "PARTICIPANT"` records.** ~73% of records. These
   are historical players (retired/transferred). Current squad is fully
   covered by `TEAM.teamMembers`, so keeping the top-level list would
   pollute search with players who haven't played in years and have no
   "active" flag in the feed.
3. **Drop TEAM records with empty `teamMembers`.** 3 umbrella/legacy
   entries for the Premier League (e.g. "English Premier League",
   "Football England Premier League"). These are alias/metadata records,
   not clubs.
4. **Inside each TEAM's `teamMembers`, drop `type != "PARTICIPANT"`.**
   The nested list quietly contains `type: "LABEL"` records like
   "{Club} Extra Time" (~54 across the PL) that look like squad members
   but are betting markets.
5. **Collapse `names[]` → single `name` string.** Resolution chain:
   `en_GB → en_US → en_TK → en_GU → any en_* → first available`. Drop
   the array. A handful of entries (~24) have only non-English locales; the
   fallback keeps them rather than nulling silently.

   **Player names then go through `normalise_player_name()`** (TEAM/club
   names are passed through unchanged):

   a. Strip any trailing parenthetical (`\s*\([^)]+\)\s*$`). The Kambi
      participant feed tags national-team and international-friendly
      players with their nationality in parens — `"Caballero, Gustavo (PRY)"`,
      `"Büchel, Martin (Liechtenstein)"`. The country information is
      already structural (it lands in `groupIds` via the home-country
      picker and the NT back-fill in rule 6), so the parenthetical is
      redundant and degrades vector retrieval — embedding models
      down-weight leading-punctuation tokens, and the parenthetical
      pulls down the cosine score for natural queries like
      `"martin büchel"`. The regex is anchored to end-of-string so
      mid-name parens (very rare; e.g. `"Bui Tien Dung (1995)"` is a
      year-disambiguator that *should* drop — and does) are also
      caught when they're the trailing token.

   b. Flip `"Last, First"` → `"First Last"` (`^([^,]+),\s+(.+)$`).
      National-team rosters consistently use the inverted form
      (`"Sakamoto, Isa (Japan)"` → after (a) → `"Sakamoto, Isa"` →
      after (b) → `"Isa Sakamoto"`). The regex only matches a single
      leading comma, so multi-comma names (very rare) pass through
      unchanged.

   Idempotent — names already in the canonical `"First Last"` form are
   untouched. Known stragglers the rules don't catch:

   - `"Any Zimbabwe (W) Player"` — outcome-label leakage that survives
     because the parenthetical isn't trailing. Real fix is to extend
     `_BETTING_EXPR` or add an `^Any .+ Player$` rule.
   - `"Geummin Lee (South Korea W))"` — extra trailing close-paren in
     the source feed. Regex deliberately doesn't strip when the paren
     count is unbalanced.
6. **Resolve every raw `groupIds` entry against `groups.json` and classify.**
   See [Group classification](#group-classification) below. Keep
   `competition` + `group`; drop `market`. Stale IDs (not in the sport
   subtree) drop automatically. The `group` kind is additionally restricted
   to a per-team allowlist (sport root + home country) so unrelated country
   attachments from pre-season friendlies are dropped — see
   [Home-country allowlist](#home-country-allowlist).

   **National-team back-fill.** After the allowlist filter, if a TEAM's
   resolved `groupIds` collapsed to `[sport_root]` only (i.e. the
   home-country picker found no country because every competition was
   international) AND the TEAM's English name exactly matches a
   country/region node at depth 2 in the offering tree, union that
   country's group id onto the TEAM and onto every roster member.
   Implemented in `refactor()` via the `country_map` built by
   `build_country_map()`. Senior men's NTs like `"Argentina"`,
   `"Germany"`, `"Spain"` fall into this case — without the back-fill,
   their players' `groupIds` carries their *club's* home country
   (e.g. Messi at Inter Miami → USA) but not their nationality, so
   queries that scope on country group id miss them entirely. After
   back-fill, Messi's `groupIds` becomes `[Football, Argentina, USA]`
   and country-scoped national-team queries work end-to-end.

   Women's and U-age variants (`"Argentina (W)"`, `"Spain U21"`) don't
   trigger the back-fill — their names don't match the country map
   exactly. They typically already carry a country via the regular
   home-country picker because their qualification tournaments do
   sit under country parents.
7. **Flatten TEAM → players.**
   - One `kind: "club"` record per team.
   - One `kind: "player"` record per `teamMembers` entry, carrying
     `clubId` so the club's name and metadata are reachable by join.
   - Dedupe players by `id` across all teams; union `competitionIds` and
     `groupIds` (a national-team player will appear in multiple league
     feeds when we scale).

### Group classification

For each groupId, look up the node in `groups.json` and classify by tree
position + name:

| Kind | Rule | Examples |
|---|---|---|
| `group` (keep) | Sport root (depth 1) OR country/region wrapper (depth 2 with children) — excluding market-named nodes. | `Football`, `England`, `Spain`, `International Tournaments` |
| `competition` (keep) | Leaf nodes that aren't under a market or locale-alias subtree. | `Premier League`, `Champions League`, `FA Cup`, `Premier League Asia Trophy` |
| `market` (drop) | Node name is in the market-bucket set, OR ends in ` Specials`, OR sits anywhere under a locale-alias subtree root, OR is a test/Request-a-Bet artifact (name matches `^(test\|testing)$` case-insensitive, or contains `(TEST` / `Request a Bet`). | `Specials`, `Trophies`, `Transfers`, `Managers`, `Grand Salami`, `Club Tournaments`, `Cross-Sport Specials`, `Enhanced Accas`, `Premier League Specials`, `Test`, `TEST`, `World Cup Specials (TEST - Request a Bet)`, anything under `Marcatore` (Italian-aliased subtree) |

**Why drop the market kind:** these IDs attach a club to a bet-market category
("Trophies", "Transfers", "Managers"), not to a competition or organisational
group. They mostly mirror prestige (Chelsea is in more markets than Brentford
because more markets exist on Chelsea), so they correlate with name fame and
would confuse competition-based filters at query time.

**Why drop locale-alias subtrees:** the tree carries duplicate competitions
under non-English-named parents (`Marcatore` is Italian for "scorer", and its
children include `Inghilterra`, `Amichevoli per Club`, `Champions League` with
a fresh ID). The English originals are already classified elsewhere.

The market-name and locale-alias sets are encoded in
[`refactor_participants.py`](../../scripts/football/refactor_participants.py) as
`MARKET_NAMES_LITERAL` and `LOCALE_ALIAS_SUBTREE_ROOTS`. Extend them as new
sports surface new patterns.

### Home-country allowlist

Even after classification, the `group` kind can attach a club to *unrelated*
countries — the Kambi feed tags clubs to every country where they've played
a friendly, so Aston Villa appears under `Football > Antigua & Barbuda`,
Chelsea under `Football > Spain`, Arsenal under `Football > USA`. For
embedding/filter purposes these are noise: the club's organisational home
is the country of its league.

The script restricts each team's `groupIds` to a 1- or 2-element allowlist
`{sport_root, home_country?}`. The home country is resolved per-team in
two modes:

- **Per-league mode** (`--league-id` set): home country = the depth-2
  group ancestor of the league in `groups.json`. Every team in the feed
  inherits the same allowlist. For Premier League
  (`Football > England > Premier League`) → `{Football, England}`. For
  leagues directly under the sport root (e.g. Champions League →
  `Football > Champions League`) → `{Football}` only.

- **Sport-wide mode** (`--league-id` omitted): home country is **derived
  per team** by tallying each `competition`-kind groupId on the team
  back to its depth-2 country ancestor. The country with the most
  competition-votes wins. Examples on real data:
  - Real Madrid: Spain 3 votes (one stray USA vote loses) → home=Spain
  - Boca Juniors: Argentina 8 votes → home=Argentina
  - Bayern Munich → Germany; PSG → France
  - England (national team): 0 votes (all comps are international,
    no country parent) → home=null

  Tournament-category headers at depth 2 (`International Tournaments`,
  `International Youth Friendlies`, `Club Youth Tournaments`, …) classify
  as `group` overall but are excluded from the home-country picker via
  `NON_COUNTRY_GROUP_NAMES` so they don't masquerade as a home country.

### Noise removal

After flatten, `_remove_noise()` strips records that survive the structural
rules above but carry no signal for embedding / search. Applied in order:

a. **Cross-sport intruders.** Six club ids appear in the football
   participant feed via charity / mixed-sport friendlies but actually
   belong to other sports (`Glasgow Warriors` rugby, `Rögle BK` and
   `HC Ambri-Piotta` ice hockey, `Barbarians` rugby, `TV-laget` Swedish
   TV celebrity team, `Ohio State Buckeyes` US college sport). Drop by
   id; players cascade out. The list (`CROSS_SPORT_CLUB_IDS` in the
   script) is explicit because structural rules don't catch them all —
   most also get caught by (f) or (g) below, but `Ohio State Buckeyes`
   carries a non-friendly competition.

b. **Test / Request-a-Bet competitions.** Handled upstream in
   `classify()` — see the `market` row of the classification table.
   Effect on the football snapshot: 2 ids drop (`2000066131 "Test"`
   referenced by Real Madrid / FC Barcelona; `2000114515 "World Cup
   Specials (TEST - Request a Bet)"` referenced by 7 national teams).
   The strip happens during `split_group_ids`, so by the time the
   noise-removal pass runs, no record carries a test id.

c. **Betting-label leakage.** Rule 4 (drop nested non-`PARTICIPANT`)
   misses cases where the source feed mis-typed a market label as
   `PARTICIPANT`. Drop players whose name ends in ` Penalties`,
   ` Extra Time`, ` Regular Time`, or contains `win &` / `& Over ` /
   `& Under `. Match is global (not anchored to the parent club's
   name) because Kambi sometimes uses a stripped or localised club name
   in the label — e.g. club `FC Sion` produces `Sion Penalties`, club
   `Finland (W)` produces `Finland Women Penalties`. Examples caught:
   `Belgium Extra Time`, `Tahiti win & Over 2.5 Goals`.

d. **Anonymous placeholders.** Drop players whose name matches
   `<clubName> #NN` — slot fillers used when Kambi doesn't have a real
   roster. The only current example is `Hapoel Ironi Kiryat Shmona
   #01` … `#10`, but the pattern is general.

e. **Name hygiene.** Drop players whose name is ≤ 1 character or
   contains a double space — data-entry errors (`f`, `Jake  Hollman`).

f. **Zero-competition stubs.** Drop clubs whose `competitionIds`
   array is empty after (b). They have no league/cup membership and
   can never be returned by a competition-scoped query.

g. **Friendly-only clubs.** Drop clubs whose only remaining
   competitions are friendlies (id resolves to a node with `Friendly`
   in its name). Catches exhibition / legends / defunct teams —
   `England Legends`, `Rest of the World XI`, `Bordeaux II`, etc.

h. **Same-shape duplicates.** Collapse clubs sharing
   `(name, sorted(groupIds))` to the lowest id; collapse players
   sharing `(name, clubId)` to the lowest id. Loser's `competitionIds`
   (and `groupIds` for players) union onto the keeper before drop, so
   no membership is lost. Legitimately distinct clubs with the same
   name but different `groupIds` (e.g. `Alianza FC` El Salvador vs
   Panama) don't collide and stay separate. The `Australia`
   national-team duplicate (one record carried `World Cup 2026`, the
   other didn't) collapses to the lower id with the comp set unioned.

i. **Final zero-roster sweep.** After all player drops, any club left
   with zero roster members is removed (same invariant as the
   original sweep — every emitted club has ≥ 1 player).

Effect on the sport-wide football snapshot: −80 clubs, −459 players
(2,493 → 2,413 clubs, 38,881 → 38,422 players).

## Output schema

Top-level:

```json
{
  "source": { "sport": "football", "sportLabel": "FOOTBALL" },
  "counts": { "clubs": 2413, "players": 38422 },
  "clubs":  [ /* club records */ ],
  "players": [ /* player records */ ]
}
```

Per-league runs add `leagueId` and `leagueName` to `source`. Sport-wide runs omit them.

Club record:

```json
{
  "id": 1000000139,
  "kind": "club",
  "sport": "football",
  "name": "Manchester City",
  "competitionIds": [1000093381, 1000093393, 1000094983, 1000094984, 1000094985, 1000094986, 1000246008, 2000087729, 2000108084],
  "groupIds": [1000093190, 1000461733]
}
```

Player record:

```json
{
  "id": 1004389212,
  "kind": "player",
  "sport": "football",
  "name": "Anthony Gordon",
  "clubId": 1000000044,
  "competitionIds": [1000093381, 1000093393, 1000094984, 1000094985, 1000094986, 2000108084],
  "groupIds": [1000093190, 1000461733]
}
```

Field notes:

- `groupIds` — primary metadata-filter field for country / sport scoping.
  **Not the same as the raw `groupIds` on the source feed.** Here it's the
  per-team allowlist `{sport_root, home_country?}` produced by the
  classification + home-country picker, **plus the national-team back-fill**.
  Length 2 in the common case (sport root + home country, whether picked
  from the competition mix or back-filled from the NT name). Length 1 only
  for international clubs that aren't named after a country (rare —
  invitational XIs that lost their country tag in noise removal). For
  dual-affiliation players (a club player who also appears in their
  national-team squad), the player's `groupIds` is the union across all
  TEAM nodes they appeared in, so a third country id can show up — most
  visibly the Inter Miami / Argentina-NT case where Messi ends up with
  `[Football, Argentina, USA]`. Snapshot today: 1,446 players carry an
  NT-back-filled country in addition to their club's home country.
- `competitionIds` — leaf competition ids the participant is attached to.
  On clubs this is the league/cup membership set (4–11 ids typical). On
  players it's the union across the club squad(s) they're listed in; for
  ~2.4% of players it carries extra national-team / youth competitions
  beyond the club's set.
- `clubId` — single-club back-pointer on player records. For players
  listed under multiple TEAMs (club + national team), the scalar `clubId`
  is whichever TEAM the flattener saw first; the full affiliation surface
  lives in `groupIds` and `competitionIds`. The club's name is resolved by
  join on `clubId` — not denormalised on the player record.
- **No embed-text composition in this stage.** The participant-layer embed
  string (`<name> | sport=<sport> | league=<top-1 league name>`) is
  composed at index build per
  [`preprocess_classify_tightening.md`](../preprocess_classify_tightening.md)
  §"Layers + embedded text composition". Country is **not** in the embed
  text — it stays a metadata filter via `groupIds`.
- `sport` is a slug ("football") for output; `sportLabel` in `source` is the
  raw Kambi label ("FOOTBALL") so consumers can round-trip if needed.

## How to run

From `kambi_search_agent/`:

```bash
# Per-league
python3 scripts/football/refactor_participants.py \
  --groups /path/to/groups.json \
  --participants /path/to/PREMIER_LEAGUE_PARTICIPANTS.json \
  --league-id 1000094985 \
  --league-name "Premier League" \
  --out data/football/premier_league_participants.json

# Sport-wide
python3 scripts/football/refactor_participants.py \
  --groups /path/to/groups.json \
  --participants /path/to/FOOTBALL_PARTICIPANTS.json \
  --out data/football/football_participants.json
```

`--league-id` and `--league-name` are paired: both or neither. Without them
the script runs in sport-wide mode and derives home country per team.
Override `--sport-label` / `--sport-slug` for non-football sports.

## Verification

Quick sanity checks (`F=data/football/premier_league_participants.json`):

```bash
# Counts (expect 20 clubs, ~600–700 players for one PL slice;
# sport-wide football reference: 2,413 clubs / 38,422 players)
jq '.counts' "$F"

# No LABEL leakage on players (noise-removal rule c)
jq '[.players[] | select(.name | test("Penalties$|Extra Time$|Regular Time$|win &|& Over |& Under |#[0-9]+$"; "i"))] | length' "$F"
# expect: 0

# No name-hygiene survivors (noise-removal rule e)
jq '[.players[] | select((.name | length) <= 1 or (.name | test("  ")))] | length' "$F"
# expect: 0

# No cross-sport intruders (noise-removal rule a)
jq '[.clubs[] | select(.id == 1000011657 or .id == 1000005250 or .id == 1000432757 or .id == 1000246859 or .id == 1004030675 or .id == 1001402569)] | length' "$F"
# expect: 0

# No duplicate player ids
jq '[.players[].id] as $ids | ($ids|length) - ($ids|unique|length)' "$F"
# expect: 0

# Every player.clubId resolves to a club we still emit
jq '
  (.clubs | map(.id) | unique) as $clubs
  | [.players[] | select((.clubId as $c | $clubs | index($c)) | not)] | length
' "$F"
# expect: 0

# Per-club roster sizes (join player.clubId → club.name)
jq -r '
  (.clubs | map({(.id|tostring): .name}) | add) as $names
  | .players
  | group_by(.clubId)
  | map([$names[(.[0].clubId|tostring)], length])
  | sort_by(-.[1])[]
  | "\(.[1])  \(.[0])"
' "$F"

# Competition/group ID counts per club (expect comp 4–11, grp ≈ 2 after
# the NT back-fill; grp == 1 should be a small residue — invitational XIs)
jq -r '.clubs[] | "\(.name)\tcomp=\(.competitionIds|length)\tgrp=\(.groupIds|length)"' "$F"

# NT back-fill landed: country-named TEAMs with grp == 2 should dominate.
jq '
  [.clubs[] | select(.name | test("\\(W\\)|U[0-9]+") | not)] as $candidates
  | { grp1: ([$candidates[] | select((.groupIds|length) == 1)] | length),
      grp2: ([$candidates[] | select((.groupIds|length) == 2)] | length) }
' "$F"
# Football reference today: grp1 == 17 (international invitational XIs etc.), grp2 == 2185.

# No zero-roster clubs survive (the empty-squad sweep should have run)
jq '
  (.players | map(.clubId) | unique) as $with_roster
  | [.clubs[] | select((.id as $c | $with_roster | index($c)) | not)] | length
' "$F"
# expect: 0
```

## Known data quirks

- **Locale-alias subtrees:** so far only `Marcatore` is in the drop set. Other
  sports may surface more (e.g. Spanish, German non-English-named parent
  nodes). Extend `LOCALE_ALIAS_SUBTREE_ROOTS` as they're discovered.
- **Tournament-category headers masquerading as countries:** depth-2 nodes
  like `International Tournaments`, `International Youth Friendlies`,
  `Club Youth Tournaments` look like country wrappers (they have children
  and pass the `group` classifier) but are actually competition categories.
  They're excluded from the home-country picker via
  `NON_COUNTRY_GROUP_NAMES`. Extend that set if new patterns appear.
- **Club Tournaments classifies as `market` but contains real competitions
  as children.** Those children (e.g. "Premier League Asia Trophy") are
  classified individually as `competition` and kept. The parent gets
  dropped — which is correct, because the parent itself isn't a tournament.
- **National teams surface as clubs with `groupIds.length == 2`** in
  sport-wide mode after the back-fill — `[sport_root, country]`. Without
  the back-fill they'd collapse to `[sport_root]` because their
  competitions are all international (World Cup, Euro qualifiers, UEFA
  Nations League) with no country ancestor. The TEAM's name *is* the
  country ("Italy", "Argentina") so `build_country_map()` joins it
  back to the depth-2 country node and unions that id in.
  National-team rosters are populated in this feed (sport-wide football
  snapshot: 68 senior-men's NTs back-filled with their country id,
  covering ~1.4k roster members that previously had no country tag).
  The remaining country-named TEAMs (e.g. small-nation senior squads,
  W / U-age variants) either:
  - already carry a country via the regular home-country picker
    because their qualifiers run under country parents, or
  - drop entirely during noise removal (rule (g) friendly-only).
  Country-level filtering against national-team players works via the
  player's own `groupIds` — the union over TEAM nodes covers both the
  player's club-country and (via the NT back-fill) their nationality.
  A Reading player on the Finland squad gets Finland in `groupIds`
  through the Finland-NT row's back-filled country id, and a Messi-style
  case (Inter Miami + Argentina NT) gets both USA (club home) and
  Argentina (NT back-fill).
- **No timestamp on any record.** Liveness is inferred from "the groupId
  exists in the current tree". There is no way to distinguish "just
  archived" from "still active" from the feed alone.
- **Friendly-match country attachments are stripped by the allowlist**,
  not by classification. If you ever need them back (e.g. for a
  "where did Chelsea tour pre-season?" feature), they're available in
  the raw feed — re-run with that filter relaxed in `split_group_ids`.

## Scaling

The sport-wide endpoint replaces the per-league orchestration that this
skill used to imply — one call per sport, one refactor invocation.
Current football snapshot:

| | Count |
|---|---|
| Raw participants in `FOOTBALL_PARTICIPANTS.json` | 130,899 |
| → after dropping LABELs, top-level PARTICIPANTs, empty-member TEAMs | 2,554 clubs + 38,881 players |
| → after dropping zero-roster clubs (post-trim) | 2,493 clubs + 38,881 players |
| → after noise removal (cross-sport, zero-comp, friendly-only, label leakage, dedup) | 2,413 clubs + 38,422 players |
| Output size (post-trim, no embed text / denormalised country fields) | ~14 MB |

For a new sport, all that changes is `--sport-label` / `--sport-slug` and
(if extending classification) the constants at the top of the script. The
home-country derivation is sport-agnostic — it just walks the tree.

Cross-sport ingestion is not handled here: run the script once per sport
and merge downstream if needed.
