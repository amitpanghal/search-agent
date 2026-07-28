"""Refactor a raw Kambi participant feed into embedding-ready records.

Two input shapes are supported:

  1. Per-league feed (one league passed via --league-id):
     feeds-eu.offering-api.kambicdn.com/feeds/api/{operator}/participant/group/{leagueId}.json

  2. Sport-wide feed (omit --league-id):
     feeds-eu.offering-api.kambicdn.com/feeds/api/{operator}/participant/sport/{sportLabel}.json

Inputs:
  - groups.json (the full Kambi offering tree; used to classify groupIds)
  - participants JSON for either a single league or a whole sport

Output:
  - {slug}_participants.json with one record per club + one per player,
    using only en_GB names, with raw groupIds resolved against groups.json
    and split into competitionIds + groupIds (markets/aliases dropped).
    The home-country picker still drives the per-team allowlist, but the
    resolved country lives in `groupIds[1]` (when length 2) rather than
    in separate `homeCountryId`/`homeCountryName` fields. After flatten,
    `_remove_noise()` drops cross-sport intruders, zero-comp / friendly-
    only clubs, betting-label / placeholder / hygiene-fail players, and
    same-shape duplicates, then sweeps any club left with no roster.

Usage (per-league):
    python3 refactor_participants.py \\
        --groups /path/to/groups.json \\
        --participants /path/to/raw_league_feed.json \\
        --league-id 1000094985 \\
        --league-name "Premier League" \\
        --out premier_league_participants.json

Usage (sport-wide):
    python3 refactor_participants.py \\
        --groups /path/to/groups.json \\
        --participants /path/to/raw_sport_feed.json \\
        --out football_participants.json

See docs/football/refactor_participants.md for the full spec.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

EN_FALLBACK = ("en_GB", "en_US", "en_TK", "en_GU")

# Names that designate a market-bucket subtree (everything at or under such a
# node is a bet-market category, not a competition or organisational group).
MARKET_NAMES_LITERAL: set[str] = {
    "Specials",
    "Trophies",
    "Transfers",
    "Managers",
    "Grand Salami",
    "Club Tournaments",
    "Cross-Sport Specials",
    "Enhanced Accas",
}

# Subtree roots that hold non-English locale aliases of competitions/groups.
# Everything under these is a duplicate of something already classified
# elsewhere and should be dropped.
LOCALE_ALIAS_SUBTREE_ROOTS: set[str] = {"Marcatore"}

# Depth-2 'group' nodes whose name resembles a country wrapper but are
# actually tournament-category headers (their children are international
# competitions, not country-bound leagues). Excluded from the home-country
# picker only — they still classify as 'group' overall.
NON_COUNTRY_GROUP_NAMES: set[str] = {
    "International Tournaments",
    "International Tournaments (W)",
    "International Youth Tournaments",
    "International Youth Friendlies",
    "International Youth Friendlies (W)",
    "Club Youth Tournaments",
}

# Explicit cross-sport ids that survive the structural rules — clubs appearing
# in football participant feeds via charity / mixed-sport friendlies but
# whose actual sport is rugby / ice hockey / US college sport. Drop by id
# in the noise-removal pass; their players cascade out.
CROSS_SPORT_CLUB_IDS: set[int] = {
    1000011657,  # Glasgow Warriors (rugby)
    1000005250,  # Rögle BK (ice hockey)
    1000432757,  # HC Ambri-Piotta (ice hockey)
    1000246859,  # Barbarians (rugby)
    1004030675,  # TV-laget (Swedish TV celebrity team)
    1001402569,  # Ohio State Buckeyes (US college sport)
}

# Time-period market suffixes are unambiguous: no real player ends in
# " Penalties" / " Extra Time" / " Regular Time". Kambi labels sometimes
# drop the "FC" / use locale variants ("Women" vs "(W)"), so prefix-only
# matching against the parent club name misses cases — match the suffix
# globally instead.
_BETTING_PERIOD_SUFFIX = re.compile(r"\s(?:Penalties|Extra Time|Regular Time)$")
# Same/both-team market expressions — substring sufficient.
_BETTING_EXPR = re.compile(r"win\s*&|&\s*(?:Over|Under)\s")
_PLACEHOLDER_TAIL = re.compile(r"#\d+")
_DOUBLE_SPACE = re.compile(r"  ")
# Trailing parenthetical on player names (country full name or ISO code).
# Anchored to end of string to avoid stripping mid-name parens, in case any
# real surname carries them. The character class is permissive — it catches
# "(PRY)", "(Liechtenstein)", "(USA)", "(W)" (women NT slot inside player
# rows from older feeds), "(Korea Rep.)", etc.
_TRAILING_PAREN = re.compile(r"\s*\([^)]+\)\s*$")
# "Last, First" inversion. First group is everything up to the first comma
# (no commas allowed in the surname), then a space, then the rest. Anchored
# to start so we only flip names that begin in the inverted form.
_COMMA_FLIP = re.compile(r"^([^,]+),\s+(.+)$")

# National-team variant suffixes: "X Women" / "X (W)" -> women; "X U23" -> youth, age 23.
_NT_WOMEN = re.compile(r"\s+(?:Women|\(W\))$")
_NT_YOUTH = re.compile(r"\s+U(\d{2})$")


def nt_variant_from_name(name: str | None) -> str:
    """Derive an ntVariant tag from a national-team name's suffix.

    "Italy" -> senior_men, "Spain U21" -> youth_men_u21, "USA (W)" -> senior_women.
    Defaults to senior_men. A name may carry both a gender and a youth suffix in either order.
    """
    base, gender, age = (name or ""), "men", None
    for _ in range(2):
        mw = _NT_WOMEN.search(base)
        if mw:
            gender, base = "women", base[: mw.start()]
            continue
        my = _NT_YOUTH.search(base)
        if my:
            age, base = my.group(1), base[: my.start()]
            continue
        break
    level = "youth" if age else "senior"
    return f"{level}_{gender}" + (f"_u{age}" if age else "")


# A national team plays ONLY national-team competitions; a club plays a continental CLUB cup. On a sparse
# offering tree, a club whose domestic league is absent collapses to "international-only" too, so this rules
# it back out (Galatasaray plays the Champions League; Argentina never does). Validated: drops 133 club
# false-positives on the GB tree, leaving 48 real national sides.
_CLUB_CONTINENTAL = re.compile(r"Champions League|Europa League|Conference League|Copa Libertadores|Copa Sudamericana", re.IGNORECASE)


def plays_club_competition(comp_ids: list[int], group_index: dict[int, dict]) -> bool:
    return any(_CLUB_CONTINENTAL.search((group_index.get(cid) or {}).get("name") or "") for cid in comp_ids)


def is_test_node(name: str) -> bool:
    """Test / Request-a-Bet artifact in the Kambi tree. Treated as market-kind
    so split_group_ids drops the id during resolution.

    Catches `^(test|testing)$` (case-insensitive) and the literal substrings
    `(TEST` and `Request a Bet`. The literal-substring matches are
    case-sensitive — Kambi's test markers consistently use that casing, and
    a looser rule would catch "Test Cricket" / "La Teste De Buch" etc.
    """
    if re.fullmatch(r"(?:test|testing)", name, re.IGNORECASE):
        return True
    return "(TEST" in name or "Request a Bet" in name


def build_group_index(groups_root: dict, sport_label: str) -> dict[int, dict]:
    """Walk the offering tree and index every node under the requested sport.

    The index records each node's depth, child-count, and full ancestor path
    (names), which together let us classify it without recursive traversal at
    classification time.
    """
    sport_node = next(
        (g for g in groups_root.get("groups", []) if g.get("sport") == sport_label),
        None,
    )
    if sport_node is None:
        raise RuntimeError(f"Sport node {sport_label!r} not found in groups.json")

    index: dict[int, dict] = {}

    def walk(node: dict, depth: int, ancestor_ids: list[int], path_names: list[str]) -> None:
        gid = int(node["id"])
        path_names_here = path_names + [node.get("name") or ""]
        ancestor_ids_here = ancestor_ids + [gid]
        index[gid] = {
            "id": gid,
            "name": node.get("name"),
            "depth": depth,
            "child_count": len(node.get("groups") or []),
            "ancestor_ids": ancestor_ids,  # excludes self
            "path": path_names_here,
        }
        for child in node.get("groups") or []:
            walk(child, depth + 1, ancestor_ids_here, path_names_here)

    walk(sport_node, depth=1, ancestor_ids=[], path_names=[])
    return index


def find_sport_root_id(group_index: dict[int, dict]) -> int:
    """Return the depth-1 sport-root node id (unique within an index)."""
    return next(gid for gid, node in group_index.items() if node["depth"] == 1)


def compute_allowed_groups(group_index: dict[int, dict], league_id: int) -> set[int]:
    """Return the set of structural ancestors of the league that classify as 'group'.

    Used as the per-team allowlist in per-league mode: only the league's own
    organisational chain (sport root, country/region) is kept, so unrelated
    country attachments from pre-season friendlies and similar artefacts are
    dropped.
    """
    node = group_index.get(int(league_id))
    if node is None:
        return set()
    allowed: set[int] = set()
    for aid in node["ancestor_ids"]:
        anc = group_index.get(aid)
        if anc and classify(anc) == "group":
            allowed.add(aid)
    # If the league node itself classifies as 'group' (e.g. caller passed a
    # country wrapper instead of a competition leaf), include it.
    if classify(node) == "group":
        allowed.add(int(league_id))
    return allowed


def derive_home_country(raw_group_ids: list[int], group_index: dict[int, dict]) -> int | None:
    """Pick the most-likely home country for a team from its competition mix.

    Each competition the team plays in is walked up to its depth-2
    country/region ancestor. The country with the most competition votes
    wins. Returns None for teams that only attach to international
    tournaments with no country parent.
    """
    votes: Counter[int] = Counter()
    for raw in raw_group_ids:
        node = group_index.get(int(raw))
        if not node or classify(node) != "competition":
            continue
        for aid in node["ancestor_ids"]:
            anc = group_index.get(aid)
            if not anc or anc["depth"] != 2 or classify(anc) != "group":
                continue
            if (anc.get("name") or "") in NON_COUNTRY_GROUP_NAMES:
                continue  # tournament-category header, not a country
            votes[aid] += 1
            break
    if not votes:
        return None
    return votes.most_common(1)[0][0]


def country_in_allowlist(allowlist: set[int], group_index: dict[int, dict]) -> int | None:
    """Pick the depth-2 country/region id from a fixed allowlist, if any."""
    for gid in allowlist:
        node = group_index.get(gid)
        if node and node["depth"] == 2:
            return gid
    return None


def classify(node: dict) -> str:
    """Classify one indexed node as 'competition' | 'group' | 'market'."""
    name = (node.get("name") or "").strip()
    depth = node["depth"]

    if depth == 1:
        return "group"  # sport root

    # Locale-alias subtree: root or anything under it.
    ancestors = node["path"][:-1]
    if name in LOCALE_ALIAS_SUBTREE_ROOTS or any(
        a in LOCALE_ALIAS_SUBTREE_ROOTS for a in ancestors
    ):
        return "market"

    # Test / Request-a-Bet artifacts that the production tree still carries.
    if is_test_node(name):
        return "market"

    # Exact market-name matches and the " Specials" naming pattern.
    if name in MARKET_NAMES_LITERAL or name.endswith(" Specials"):
        return "market"

    # Country/region wrappers (depth-2 nodes that have children).
    if depth == 2 and node["child_count"] > 0:
        return "group"

    # Everything else (leaves under sport or country) → competition.
    return "competition"


def split_group_ids(
    raw_ids: list[int],
    group_index: dict[int, dict],
    allowed_groups: set[int],
) -> tuple[list[int], list[int]]:
    """Resolve raw groupIds against the sport tree, classify, drop markets.

    Returns (competition_ids, group_ids), each sorted and deduplicated. Stale
    or non-sport IDs drop automatically (not in the index). `group`-kind IDs
    are additionally restricted to `allowed_groups` (the league's ancestor
    chain), so unrelated countries from friendly-match attachments are pruned.
    """
    competitions: set[int] = set()
    groups: set[int] = set()
    for raw in raw_ids:
        gid = int(raw)
        node = group_index.get(gid)
        if node is None:
            continue  # stale or different sport
        kind = classify(node)
        if kind == "competition":
            competitions.add(gid)
        elif kind == "group" and gid in allowed_groups:
            groups.add(gid)
        # markets and unrelated-country groups are dropped
    return sorted(competitions), sorted(groups)


def pick_en_name(names: list[dict]) -> str | None:
    """Resolve the canonical English name with the en_* fallback chain."""
    by_locale = {n["locale"]: n["name"] for n in names if n.get("locale")}
    for loc in EN_FALLBACK:
        if loc in by_locale:
            return by_locale[loc]
    for loc, name in by_locale.items():
        if loc.startswith("en_"):
            return name
    return names[0]["name"] if names else None


def normalise_player_name(name: str | None) -> str | None:
    """Drop trailing country parenthetical, then flip "Last, First" → "First Last".

    The Kambi participant feed mixes naming conventions: many national-team
    rosters carry "Surname, Given (Country)" (e.g. "Caballero, Gustavo (PRY)",
    "Büchel, Martin (Liechtenstein)"), while club rosters use plain
    "Given Surname". Country tagging is redundant with the player's
    `groupIds`, and the inverted-comma form scores poorly at retrieval time
    because vector models down-weight leading punctuated tokens.

    Idempotent: a name already in "First Last" form passes through unchanged.
    """
    if not name:
        return name
    cleaned = _TRAILING_PAREN.sub("", name).strip()
    m = _COMMA_FLIP.match(cleaned)
    if m:
        last, first = m.group(1).strip(), m.group(2).strip()
        if last and first:
            cleaned = f"{first} {last}"
    return cleaned


def build_country_map(group_index: dict[int, dict]) -> dict[str, int]:
    """Country/region name → depth-2 group id, restricted to nodes the
    `classify()` function calls 'group'.

    Used to back-fill the country group id onto national-team clubs whose
    `groupIds` collapse to `[sport_root]` only — the
    `derive_home_country()` picker can't infer a country from
    international-only competitions, so an NT row like "Argentina" carries
    no country tag and any "argentina players" query that scopes by
    country-group misses it. The fix here is structural: when a club's
    name exactly matches a country node, union that country's id onto
    its `groupIds` (and onto every roster member of that club).
    """
    return {
        node["name"]: gid
        for gid, node in group_index.items()
        if node["depth"] == 2
        and node["child_count"] > 0
        and classify(node) == "group"
        and node["name"] not in NON_COUNTRY_GROUP_NAMES
    }


def _collect_friendly_ids(group_index: dict[int, dict]) -> set[int]:
    """Ids whose resolved name contains 'friendly' (case-insensitive).

    Used by the noise-removal pass to drop clubs whose only remaining
    competitions are friendlies — almost always exhibition / legends /
    defunct teams with no league membership we'd ever want to scope on.
    """
    return {
        gid
        for gid, node in group_index.items()
        if "friendly" in (node.get("name") or "").lower()
    }


def _remove_noise(
    clubs: list[dict],
    players: dict[int, dict],
    group_index: dict[int, dict],
    *,
    individual: bool = False,
) -> tuple[list[dict], dict[int, dict]]:
    """Post-flatten cleanup — see refactor_participants.md §'Noise removal'.

    Applies, in order:
      a. drop cross-sport intruder ids
      f. drop zero-competition clubs (after the test-strip in classify())
      g. drop friendly-only clubs
      h. dedupe clubs by (name, sorted(groupIds))
      cascade-drop players whose club was dropped
      c/d/e. drop player names matching betting-market / placeholder /
             hygiene patterns
      h. dedupe players by (name, clubId)
      i. final zero-roster sweep
    """
    friendly_ids = _collect_friendly_ids(group_index)

    drop_clubs: set[int] = set()

    # a. Cross-sport intruders.
    drop_clubs.update(c["id"] for c in clubs if c["id"] in CROSS_SPORT_CLUB_IDS)

    # f. zero-competition. g. friendly-only. National teams are EXEMPT: their competitions are
    # international tournaments that often don't resolve against the (GB-scoped) offering tree, so
    # they'd look zero-competition here — but they are real and fetched LIVE by team id at query
    # time, so dropping them just breaks grounding (e.g. "Messi Argentina"). Guarded upstream by
    # a country-name match + a non-empty roster, so this exempts only real national sides.
    for c in clubs:
        if c["id"] in drop_clubs:
            continue
        if c.get("ntVariant"):
            continue
        comps = c["competitionIds"]
        if not comps or all(i in friendly_ids for i in comps):
            drop_clubs.add(c["id"])

    # h (clubs). Dedupe by (name, sorted(groupIds)); keep lowest id; union
    # losers' competitionIds onto the keeper. Clubs that share a name but
    # have different groupIds (e.g. "Alianza FC" in El Salvador vs Panama)
    # don't collide here and stay as separate records.
    by_key: dict[tuple[str, tuple[int, ...]], list[dict]] = {}
    for c in clubs:
        if c["id"] in drop_clubs:
            continue
        by_key.setdefault((c["name"], tuple(sorted(c["groupIds"]))), []).append(c)
    for group in by_key.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda c: c["id"])
        keeper, *losers = group
        merged = set(keeper["competitionIds"])
        for loser in losers:
            merged.update(loser["competitionIds"])
            drop_clubs.add(loser["id"])
        keeper["competitionIds"] = sorted(merged)

    clubs = [c for c in clubs if c["id"] not in drop_clubs]
    surviving_ids = {c["id"] for c in clubs}
    surviving_names = {c["id"]: c["name"] for c in clubs}

    if individual:
        players = {pid: p for pid, p in players.items() if p["clubId"] is None or p["clubId"] in surviving_ids}
    else:
        players = {pid: p for pid, p in players.items() if p["clubId"] in surviving_ids}

    # c/d/e. Player name patterns.
    drop_players: set[int] = set()
    for pid, p in players.items():
        name = p["name"] or ""
        if len(name) <= 1 or _DOUBLE_SPACE.search(name):
            drop_players.add(pid)
            continue
        if _BETTING_PERIOD_SUFFIX.search(name) or _BETTING_EXPR.search(name):
            drop_players.add(pid)
            continue
        club_name = surviving_names.get(p["clubId"])
        if club_name and name.startswith(club_name):
            tail = name[len(club_name):].lstrip()
            if _PLACEHOLDER_TAIL.fullmatch(tail):
                drop_players.add(pid)
    players = {pid: p for pid, p in players.items() if pid not in drop_players}

    # h (players). Dedupe by (name, clubId); keep lowest id; union losers'
    # competitionIds + groupIds onto the keeper.
    by_pkey: dict[tuple[str, int], list[dict]] = {}
    for p in players.values():
        by_pkey.setdefault((p["name"], p["clubId"]), []).append(p)
    dup_drop: set[int] = set()
    for group in by_pkey.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda p: p["id"])
        keeper, *losers = group
        merged_c = set(keeper["competitionIds"])
        merged_g = set(keeper["groupIds"])
        for loser in losers:
            merged_c.update(loser["competitionIds"])
            merged_g.update(loser["groupIds"])
            if "countryTeamId" in keeper and not keeper.get("countryTeamId") and loser.get("countryTeamId"):
                keeper["countryTeamId"] = loser["countryTeamId"]
            dup_drop.add(loser["id"])
        keeper["competitionIds"] = sorted(merged_c)
        keeper["groupIds"] = sorted(merged_g)
    players = {pid: p for pid, p in players.items() if pid not in dup_drop}

    # i. Final zero-roster sweep — clubs whose only roster members were
    # dropped (e.g. by the name-pattern filter) become orphans.
    # Skipped for individual sports where clubs (e.g. Davis Cup country teams)
    # are standalone entities with no players in the individual roster.
    if not individual:
        clubs_with_roster = {p["clubId"] for p in players.values()}
        # Keep a club if it has a roster OR a real competition OR is a national team. Competition-having
        # rosterless teams are real (bettable) sides we want for team-level grounding; only true orphans
        # (no players, no competition, not an NT) are swept. National teams are kept even with neither,
        # since their squad links via countryTeamId (clubId points at the player's club, not the NT).
        clubs = [c for c in clubs if c["id"] in clubs_with_roster or c["competitionIds"] or c.get("ntVariant")]

    return clubs, players


def refactor(
    blob: dict,
    group_index: dict[int, dict],
    *,
    league_id: int | None,
    league_name: str | None,
    sport_label: str,
    sport_slug: str,
    individual: bool = False,
    national_teams: bool = False,
) -> dict:
    """Transform a raw participants blob into the embedding-ready shape.

    Per-league mode (league_id provided): every team shares the same allowlist
    and home country, taken from the league's ancestor chain.
    Sport-wide mode (league_id None): each team's home country is derived
    from its own competition attachments (most-common depth-2 country
    ancestor), and the allowlist is {sport_root, home_country}.
    """
    sport_root_id = find_sport_root_id(group_index)
    country_map = build_country_map(group_index)
    clubs: list[dict] = []
    players: dict[int, dict] = {}

    if individual:
        # Individual-sport ingest (e.g. tennis): players are top-level PARTICIPANT entries;
        # clubs are TEAM entries (e.g. Davis Cup country teams) with no roster.
        # All in-tree group nodes are allowed so tour nodes (ATP/WTA/Grand Slam) survive
        # split_group_ids. Both get the group→comp fold so competitionIds includes them.
        ind_allowed = {gid for gid, n in group_index.items() if classify(n) == "group"}
        for p in blob.get("participants", []):
            if p.get("type") == "PARTICIPANT":
                pid = int(p["id"])
                pname = normalise_player_name(pick_en_name(p.get("names") or []))
                pcomp, pgrp = split_group_ids(p.get("groupIds") or [], group_index, ind_allowed)
                comp_ids = sorted(set(pcomp) | (set(pgrp) - {sport_root_id}))
                players[pid] = {
                    "id": pid,
                    "kind": "player",
                    "sport": sport_slug,
                    "name": pname,
                    "clubId": None,
                    "competitionIds": comp_ids,
                    "groupIds": [],
                }
            elif p.get("type") == "TEAM":
                club_id = int(p["id"])
                club_name = pick_en_name(p.get("names") or [])
                ccomp, cgrp = split_group_ids(p.get("groupIds") or [], group_index, ind_allowed)
                club: dict = {
                    "id": club_id,
                    "kind": "club",
                    "sport": sport_slug,
                    "name": club_name,
                    "competitionIds": sorted(set(ccomp) | (set(cgrp) - {sport_root_id})),
                    "groupIds": [],
                }
                if national_teams:
                    # In an individual sport the country teams are the rostered TEAMs (Davis / BJK Cup
                    # squads). Un-rostered TEAMs are market/label junk; "A/B" ones are doubles pairs —
                    # neither is a nation. Gender comes from the name suffix ("(W)" -> women).
                    is_national_team = bool(p.get("teamMembers")) and "/" not in club_name
                    club["ntVariant"] = nt_variant_from_name(club_name) if is_national_team else None
                clubs.append(club)
        clubs, players = _remove_noise(clubs, players, group_index, individual=True)
        source: dict = {"sport": sport_slug, "sportLabel": sport_label}
        return {
            "source": source,
            "counts": {"clubs": len(clubs), "players": len(players)},
            "clubs": clubs,
            "players": list(players.values()),
        }

    if league_id is not None:
        fixed_allowlist = compute_allowed_groups(group_index, league_id)
        fixed_home: int | None = country_in_allowlist(fixed_allowlist, group_index)
    else:
        fixed_allowlist = None
        fixed_home = None

    def home_and_allowlist(team_raw_groups: list[int]) -> set[int]:
        if fixed_allowlist is not None:
            return fixed_allowlist
        home = derive_home_country(team_raw_groups, group_index)
        return {sport_root_id} | ({home} if home is not None else set())

    for p in blob.get("participants", []):
        if p.get("type") != "TEAM":
            continue
        members = p.get("teamMembers") or []
        # Rosterless teams are NOT dropped here: a real team can have events/competitions but no listed
        # squad (e.g. AFC Malmö in Ettan Södra, or CL-qualifier clubs). _remove_noise's zero-competition
        # filter drops the genuinely-empty umbrella/phantom rows; teams with a real competition survive
        # and ground by name (their matches are fetched live by team id at query time).

        raw_team_groups = p.get("groupIds") or []
        allowed = home_and_allowlist(raw_team_groups)

        club_id = int(p["id"])
        club_name = pick_en_name(p.get("names") or [])
        comp_ids, grp_ids = split_group_ids(raw_team_groups, group_index, allowed)

        # National-team back-fill. When the home-country picker returns no
        # country (all attached competitions are international) and the
        # club's name exactly matches a country node in the offering tree,
        # union that country's group id onto both the club and every
        # roster member. Without this, queries like "argentina messi" miss
        # Messi because his groupIds carry his club's home country (USA),
        # not his nationality.
        # National team = a rostered TEAM whose name exactly matches a country node in the offering
        # tree (Argentina, Brazil, Morocco (W), …). This is the robust signal. The old "groups collapse
        # to the sport root" heuristic mass-mis-flags CLUBS as NTs on a tree where many domestic leagues
        # don't resolve — a club then looks international-only too (1000+ false positives here). An exact
        # country-name match doesn't. Gated by --national-teams; the country_map lookup below also drives
        # the countryTeamId back-fill, so detection and linkage share one signal.
        is_national_team = national_teams and club_name in country_map

        nt_country_id: int | None = None
        if is_national_team and club_name in country_map:
            nt_country_id = country_map[club_name]
            grp_ids = sorted(set(grp_ids) | {nt_country_id})

        club: dict = {
            "id": club_id,
            "kind": "club",
            "sport": sport_slug,
            "name": club_name,
            "competitionIds": comp_ids,
            "groupIds": grp_ids,
        }
        if national_teams:
            club["ntVariant"] = nt_variant_from_name(club_name) if is_national_team else None
        clubs.append(club)

        for m in members:
            if m.get("type") != "PARTICIPANT":
                continue  # inner LABELs (e.g. "{Club} Extra Time") leak in here
            pid = int(m["id"])
            pname = normalise_player_name(pick_en_name(m.get("names") or []))
            pcomp, pgrp = split_group_ids(m.get("groupIds") or [], group_index, allowed)
            if nt_country_id is not None:
                pgrp = sorted(set(pgrp) | {nt_country_id})
            if pid in players:
                existing = players[pid]
                existing["competitionIds"] = sorted(set(existing["competitionIds"]) | set(pcomp))
                existing["groupIds"] = sorted(set(existing["groupIds"]) | set(pgrp))
                if is_national_team:
                    existing["countryTeamId"] = club_id  # this TEAM is the player's national side
            else:
                player: dict = {
                    "id": pid,
                    "kind": "player",
                    "sport": sport_slug,
                    "name": pname,
                    "clubId": club_id,
                    "competitionIds": pcomp,
                    "groupIds": pgrp,
                }
                if national_teams:
                    player["countryTeamId"] = club_id if is_national_team else None
                players[pid] = player

    # Noise removal: drop cross-sport intruders, zero-comp / friendly-only
    # clubs, label-leakage / placeholder / hygiene-fail players, and
    # same-shape duplicates. Subsumes the original zero-roster sweep —
    # _remove_noise runs the final sweep itself after all player drops.
    clubs, players = _remove_noise(clubs, players, group_index, individual=False)

    source: dict = {"sport": sport_slug, "sportLabel": sport_label}
    if league_id is not None:
        source = {"leagueId": league_id, "leagueName": league_name, **source}

    return {
        "source": source,
        "counts": {"clubs": len(clubs), "players": len(players)},
        "clubs": clubs,
        "players": list(players.values()),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--groups", required=True, type=Path)
    ap.add_argument("--participants", required=True, type=Path)
    ap.add_argument("--league-id", type=int, help="Per-league mode: pin allowlist + home country to this league's ancestors")
    ap.add_argument("--league-name", help="Per-league mode: label for output source metadata")
    ap.add_argument("--sport-label", default="FOOTBALL", help="Sport label in groups.json (default: FOOTBALL)")
    ap.add_argument("--sport-slug", default="football", help="Sport slug used in output records (default: football)")
    ap.add_argument("--individual", action="store_true", help="Individual-sport mode: players from top-level PARTICIPANT entries")
    ap.add_argument("--national-teams", action="store_true", help="Flag national-team clubs (ntVariant) and link players to them (countryTeamId). Detection: a TEAM whose groups collapse to the sport root. Football only for now.")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if (args.league_id is None) != (args.league_name is None):
        ap.error("--league-id and --league-name must be provided together (or both omitted for sport-wide mode)")

    groups_root = json.loads(args.groups.read_text())
    if "group" in groups_root and isinstance(groups_root.get("group"), dict):
        groups_root = groups_root["group"]
    blob = json.loads(args.participants.read_text())

    group_index = build_group_index(groups_root, args.sport_label)
    result = refactor(
        blob,
        group_index,
        league_id=args.league_id,
        league_name=args.league_name,
        sport_label=args.sport_label,
        sport_slug=args.sport_slug,
        individual=args.individual,
        national_teams=args.national_teams,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False))

    raw_total = len(blob.get("participants", []))
    mode = "per-league" if args.league_id is not None else "sport-wide"
    print(f"mode: {mode}")
    print(f"sport-subtree ids indexed: {len(group_index)}")
    print(f"raw participants: {raw_total} -> clubs: {result['counts']['clubs']}, players: {result['counts']['players']}")
    print(f"wrote: {args.out}  ({args.out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
