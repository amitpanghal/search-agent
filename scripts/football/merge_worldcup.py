"""Merge the World Cup 2026 participant feed into football_participants.json
under the new clubId / countryTeamId data model.

Pipeline:
  1. backfill_existing()  — migrate football_participants.json from old model
                            (region in player.groupIds, NT-as-clubId artifacts)
                            to new model (countryTeamId scalar, no region on
                            players, NT clubs stripped of region groupId).
  2. refactor_wc()        — per-league refactor of the WC feed under the new
                            model. Empty-roster NTs survive (rule 3 exception).
  3. merge_wc_into_existing() — non-empty WC NTs replace existing same-name
                            matches; empty WC NTs tag-union onto existing.

Usage:
    python3 scripts/football/merge_worldcup.py \\
        --groups data/football/groups.json \\
        --existing data/football/football_participants.json \\
        --worldcup data/football/2010133908_worldcup.json \\
        --out data/football/football_participants.json
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from refactor_participants import (
    _BETTING_EXPR,
    _BETTING_PERIOD_SUFFIX,
    _DOUBLE_SPACE,
    _PLACEHOLDER_TAIL,
    build_country_map,
    build_group_index,
    compute_allowed_groups,
    derive_home_country,
    find_sport_root_id,
    normalise_player_name,
    pick_en_name,
    split_group_ids,
)

WC_LEAGUE_ID = 2010133908
WC_LEAGUE_NAME = "World Cup 2026"
SPORT_LABEL = "FOOTBALL"

# Longest / most-specific suffixes first so "Germany (W) U21" strips to
# "Germany", not "Germany (W)". Tuples are (suffix, ntVariant).
NT_SUFFIX_TO_VARIANT: list[tuple[str, str]] = [
    (" (W) U-23", "youth_women_u23"),
    (" (W) U-21", "youth_women_u21"),
    (" (W) U-20", "youth_women_u20"),
    (" (W) U-19", "youth_women_u19"),
    (" (W) U-17", "youth_women_u17"),
    (" (W) U23", "youth_women_u23"),
    (" (W) U21", "youth_women_u21"),
    (" (W) U20", "youth_women_u20"),
    (" (W) U19", "youth_women_u19"),
    (" (W) U17", "youth_women_u17"),
    (" (W)", "senior_women"),
    (" Women", "senior_women"),
    (" U-23", "youth_men_u23"),
    (" U-21", "youth_men_u21"),
    (" U-20", "youth_men_u20"),
    (" U-19", "youth_men_u19"),
    (" U-17", "youth_men_u17"),
    (" U23", "youth_men_u23"),
    (" U21", "youth_men_u21"),
    (" U20", "youth_men_u20"),
    (" U19", "youth_men_u19"),
    (" U18", "youth_men_u18"),
    (" U17", "youth_men_u17"),
    (" U16", "youth_men_u16"),
    (" U15", "youth_men_u15"),
]

# Aliases between Kambi participant naming and groups.json country naming.
# Seeded empty; extend if backfill stats show missed matches.
NT_NAME_ALIASES: dict[str, str] = {}

# Country names with NT participants but no depth-2 wrapper in groups.json
# (typically because Kambi doesn't carry a domestic league for them).
# Without these, classify_nt would mis-flag the WC TEAM as a pro club.
# country_group_id is None for these — backfill never needs to resolve them
# (no existing player carries the missing group node id).
EXTRA_NT_COUNTRY_NAMES: set[str] = {
    "Ghana",
    "Tunisia",
    "Ivory Coast",
    "Qatar",
    "Algeria",
    "DR Congo",
    "Cape Verde Islands",
    "Haiti",
    "Jordan",
    "Panama",
    "Uzbekistan",
    "Curacao",
}


def strip_nt_suffix(name: str) -> tuple[str, str]:
    for suffix, variant in NT_SUFFIX_TO_VARIANT:
        if name.endswith(suffix):
            return name[: -len(suffix)], variant
    return name, "senior_men"


def classify_nt(
    name: str | None,
    country_map: dict[str, int],
) -> tuple[bool, int | None, str | None]:
    """(is_nt, country_group_id, nt_variant). None,None,None if not NT.

    country_group_id is None when the country is in EXTRA_NT_COUNTRY_NAMES
    but absent from groups.json (no domestic league wrapper).
    """
    if not name:
        return False, None, None
    aliased = NT_NAME_ALIASES.get(name, name)
    if aliased in country_map:
        return True, country_map[aliased], "senior_men"
    if aliased in EXTRA_NT_COUNTRY_NAMES:
        return True, None, "senior_men"
    base, variant = strip_nt_suffix(name)
    if base != name:
        if base in country_map:
            return True, country_map[base], variant
        aliased_base = NT_NAME_ALIASES.get(base, base)
        if aliased_base in country_map:
            return True, country_map[aliased_base], variant
        if aliased_base in EXTRA_NT_COUNTRY_NAMES:
            return True, None, variant
    return False, None, None


def backfill_existing(
    existing: dict,
    group_index: dict[int, dict],
    country_map: dict[str, int],
) -> tuple[dict, dict[str, int]]:
    sport_root_id = find_sport_root_id(group_index)
    stats: Counter[str] = Counter()
    valid_group_ids = set(group_index.keys())

    # Pass 1: classify clubs. Strip region from NT groupIds, set ntVariant.
    # Also prune stale competitionIds against the current groups.json — older
    # Kambi snapshots tagged participants with comps that no longer resolve
    # to a node in the tree; under the walker's club ∪ NT comp derivation,
    # any bloat on a club poisons every anchored player's embed text.
    # Build country-group-id → NT-club-id for senior_men (the only case the
    # leftover-groupIds backfill needs to resolve).
    country_groupId_to_nt_clubId: dict[int, int] = {}
    for c in existing["clubs"]:
        original_comps = c.get("competitionIds") or []
        c["competitionIds"] = [cid for cid in original_comps if cid in valid_group_ids]
        dropped = len(original_comps) - len(c["competitionIds"])
        if dropped:
            stats["filtered_stale_comps"] += dropped

        is_nt, country_gid, variant = classify_nt(c["name"], country_map)
        if is_nt:
            c["ntVariant"] = variant
            c["groupIds"] = [g for g in c["groupIds"] if g == sport_root_id]
            stats[f"nt_{variant}"] += 1
            if variant == "senior_men" and country_gid is not None:
                country_groupId_to_nt_clubId[country_gid] = c["id"]
        else:
            c["ntVariant"] = None
            stats["pro_clubs"] += 1

    # Pass 2: migrate players.
    club_by_id = {c["id"]: c for c in existing["clubs"]}
    for p in existing["players"]:
        club = club_by_id.get(p.get("clubId"))
        if club is not None and club.get("ntVariant"):
            # clubId pointed at an NT — reassign.
            p["countryTeamId"] = p["clubId"]
            p["clubId"] = None
            stats["players_nt_anchored"] += 1
        else:
            # Pro club or orphan. Mine groupIds for nationality leftover.
            club_country_groups: set[int] = set()
            if club is not None:
                club_country_groups = set(club["groupIds"]) - {sport_root_id}
            leftover = (
                set(p.get("groupIds") or [])
                - {sport_root_id}
                - club_country_groups
            )
            country_team_id: int | None = None
            for cgid in leftover:
                if cgid in country_groupId_to_nt_clubId:
                    country_team_id = country_groupId_to_nt_clubId[cgid]
                    break
            p["countryTeamId"] = country_team_id
            if country_team_id is not None:
                stats["players_nt_backfilled"] += 1
            else:
                stats["players_club_only"] += 1
        # Drop groupIds field on every player.
        p.pop("groupIds", None)

    existing["counts"] = {
        "clubs": len(existing["clubs"]),
        "players": len(existing["players"]),
    }
    return existing, dict(stats)


def refactor_wc(
    blob: dict,
    group_index: dict[int, dict],
    country_map: dict[str, int],
) -> tuple[dict, dict[str, int]]:
    sport_root_id = find_sport_root_id(group_index)
    fixed_allowlist = compute_allowed_groups(group_index, WC_LEAGUE_ID)
    if not fixed_allowlist:
        fixed_allowlist = {sport_root_id}
    stats: Counter[str] = Counter()

    clubs: list[dict] = []
    players: dict[int, dict] = {}

    for p in blob.get("participants", []):
        if p.get("type") != "TEAM":
            continue
        club_id = int(p["id"])
        club_name = pick_en_name(p.get("names") or [])
        if not club_name:
            continue

        is_nt, _country_gid, variant = classify_nt(club_name, country_map)
        members = p.get("teamMembers") or []
        if not members and not is_nt:
            stats["dropped_empty_non_nt"] += 1
            continue

        raw_team_groups = p.get("groupIds") or []
        comp_ids, _ = split_group_ids(raw_team_groups, group_index, fixed_allowlist)

        if is_nt:
            club_groupIds = [sport_root_id]
            stats[f"nt_{variant}"] += 1
        else:
            home = derive_home_country(raw_team_groups, group_index)
            club_groupIds = [sport_root_id] + ([home] if home is not None else [])
            stats["pro_clubs"] += 1

        clubs.append({
            "id": club_id,
            "kind": "club",
            "sport": "football",
            "name": club_name,
            "competitionIds": comp_ids,
            "groupIds": club_groupIds,
            "ntVariant": variant if is_nt else None,
        })

        for m in members:
            if m.get("type") != "PARTICIPANT":
                continue
            pid = int(m["id"])
            pname = normalise_player_name(pick_en_name(m.get("names") or []))
            pcomp, _ = split_group_ids(
                m.get("groupIds") or [], group_index, fixed_allowlist
            )
            if pid in players:
                ex = players[pid]
                ex["competitionIds"] = sorted(set(ex["competitionIds"]) | set(pcomp))
                if is_nt:
                    ex["countryTeamId"] = club_id
                else:
                    ex["clubId"] = club_id
            else:
                players[pid] = {
                    "id": pid,
                    "kind": "player",
                    "sport": "football",
                    "name": pname,
                    "clubId": None if is_nt else club_id,
                    "countryTeamId": club_id if is_nt else None,
                    "competitionIds": pcomp,
                }

    # Hygiene cleanup on player names (Sub-Q1's refactor analogue of
    # _remove_noise rules c/d/e — adapted to anchor by clubId-or-countryTeamId).
    club_names = {c["id"]: c["name"] for c in clubs}
    drop_ids: set[int] = set()
    for pid, pl in players.items():
        name = pl["name"] or ""
        if len(name) <= 1 or _DOUBLE_SPACE.search(name):
            drop_ids.add(pid)
            continue
        if _BETTING_PERIOD_SUFFIX.search(name) or _BETTING_EXPR.search(name):
            drop_ids.add(pid)
            continue
        anchor_id = pl["clubId"] if pl["clubId"] is not None else pl["countryTeamId"]
        anchor_name = club_names.get(anchor_id, "") if anchor_id is not None else ""
        if anchor_name and name.startswith(anchor_name):
            tail = name[len(anchor_name):].lstrip()
            if _PLACEHOLDER_TAIL.fullmatch(tail):
                drop_ids.add(pid)
    for pid in drop_ids:
        del players[pid]
    if drop_ids:
        stats["dropped_hygiene_players"] = len(drop_ids)

    return {
        "source": {
            "leagueId": WC_LEAGUE_ID,
            "leagueName": WC_LEAGUE_NAME,
            "sport": "football",
            "sportLabel": SPORT_LABEL,
        },
        "counts": {"clubs": len(clubs), "players": len(players)},
        "clubs": clubs,
        "players": list(players.values()),
    }, dict(stats)


def merge_wc_into_existing(
    existing: dict,
    wc_blob: dict,
) -> tuple[dict, dict[str, int]]:
    stats: Counter[str] = Counter()

    existing_clubs_by_name_variant: dict[tuple[str, str | None], list[dict]] = defaultdict(list)
    for c in existing["clubs"]:
        existing_clubs_by_name_variant[(c["name"], c.get("ntVariant"))].append(c)

    existing_players_by_id: dict[int, dict] = {p["id"]: p for p in existing["players"]}
    existing_players_by_country_team: dict[int, list[dict]] = defaultdict(list)
    for p in existing["players"]:
        ct = p.get("countryTeamId")
        if ct is not None:
            existing_players_by_country_team[ct].append(p)

    wc_players_by_country_team: dict[int, list[dict]] = defaultdict(list)
    for p in wc_blob["players"]:
        ct = p.get("countryTeamId")
        if ct is not None:
            wc_players_by_country_team[ct].append(p)

    drop_existing_club_ids: set[int] = set()
    drop_existing_player_ids: set[int] = set()
    wc_clubs_consumed: set[int] = set()
    # When a replaced NT has a different id (Spain old 1000000186 → new
    # 1003666473), any leftover-backfilled player still pointing at the old
    # id needs repointing to the new one — otherwise their countryTeamId
    # dangles. Same-id replaces (Bosnia/Austria) skip the repoint.
    nt_repoint: dict[int, int] = {}

    # Phase 1: classify each WC club as replace / tag-union / fresh-insert.
    for wc_club in wc_blob["clubs"]:
        wc_id = wc_club["id"]
        wc_roster = wc_players_by_country_team.get(wc_id, [])
        key = (wc_club["name"], wc_club.get("ntVariant"))
        existing_matches = existing_clubs_by_name_variant.get(key, [])

        if not wc_roster:
            if existing_matches:
                # Tag-union: append WC comps onto existing club + roster.
                wc_clubs_consumed.add(wc_id)
                for em in existing_matches:
                    em["competitionIds"] = sorted(
                        set(em["competitionIds"]) | set(wc_club["competitionIds"])
                    )
                    for ep in existing_players_by_country_team.get(em["id"], []):
                        ep["competitionIds"] = sorted(
                            set(ep["competitionIds"]) | set(wc_club["competitionIds"])
                        )
                    stats["tagged_existing_nts"] += 1
            else:
                stats["empty_nt_inserts"] += 1
            continue

        # Non-empty roster: replace existing same-name NT(s).
        if existing_matches:
            for em in existing_matches:
                drop_existing_club_ids.add(em["id"])
                stats["replaced_clubs"] += 1
                if em["id"] != wc_id:
                    nt_repoint[em["id"]] = wc_id
                for ep in existing_players_by_country_team.get(em["id"], []):
                    if ep.get("clubId") is None:
                        drop_existing_player_ids.add(ep["id"])
                        stats["dropped_orphan_players"] += 1
        else:
            stats["fresh_nt_inserts"] += 1

    # Phase 2: apply drops, insert WC clubs (skip consumed), insert/update players.
    merged_clubs = [c for c in existing["clubs"] if c["id"] not in drop_existing_club_ids]
    for wc_club in wc_blob["clubs"]:
        if wc_club["id"] not in wc_clubs_consumed:
            merged_clubs.append(wc_club)

    merged_players_by_id: dict[int, dict] = {
        p["id"]: p for p in existing["players"] if p["id"] not in drop_existing_player_ids
    }
    for wc_player in wc_blob["players"]:
        pid = wc_player["id"]
        wc_ct = wc_player.get("countryTeamId")
        if wc_ct in wc_clubs_consumed:
            # Empty NTs have no players in wc_blob, so this is defensive only.
            continue
        if pid in merged_players_by_id:
            ep = merged_players_by_id[pid]
            if wc_ct is not None:
                ep["countryTeamId"] = wc_ct
            ep["competitionIds"] = sorted(
                set(ep["competitionIds"]) | set(wc_player["competitionIds"])
            )
            stats["updated_existing_players"] += 1
        else:
            merged_players_by_id[pid] = wc_player
            stats["inserted_players"] += 1

    # Repoint dangling countryTeamId references for leftover-backfilled
    # players whose NT got replaced with a new WC id.
    for p in merged_players_by_id.values():
        ct = p.get("countryTeamId")
        if ct is not None and ct in nt_repoint:
            p["countryTeamId"] = nt_repoint[ct]
            stats["repointed_country_team_ids"] += 1

    merged = {
        "source": existing.get("source", {"sport": "football", "sportLabel": SPORT_LABEL}),
        "counts": {
            "clubs": len(merged_clubs),
            "players": len(merged_players_by_id),
        },
        "clubs": merged_clubs,
        "players": list(merged_players_by_id.values()),
    }
    return merged, dict(stats)


def _print_stats(label: str, stats: dict[str, int]) -> None:
    print(f"\n--- {label} ---")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--groups", required=True, type=Path)
    ap.add_argument("--existing", required=True, type=Path)
    ap.add_argument("--worldcup", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print stats but don't write --out",
    )
    args = ap.parse_args()

    groups_root = json.loads(args.groups.read_text())
    existing = json.loads(args.existing.read_text())
    wc_raw = json.loads(args.worldcup.read_text())

    group_index = build_group_index(groups_root, SPORT_LABEL)
    country_map = build_country_map(group_index)

    print("--- Loaded ---")
    print(f"  groups sport-subtree: {len(group_index)} nodes")
    print(f"  country_map: {len(country_map)} countries")
    print(f"  existing counts: {existing['counts']}")
    print(f"  worldcup raw participants: {len(wc_raw.get('participants', []))}")

    backfilled, bf_stats = backfill_existing(existing, group_index, country_map)
    _print_stats("Backfill stats", bf_stats)

    wc_blob, wc_stats = refactor_wc(wc_raw, group_index, country_map)
    _print_stats("WC refactor stats", wc_stats)
    print(f"  wc_blob counts: {wc_blob['counts']}")

    merged, m_stats = merge_wc_into_existing(backfilled, wc_blob)
    _print_stats("Merge stats", m_stats)
    print(f"  final counts: {merged['counts']}")

    if args.dry_run:
        print("\n(--dry-run) not writing --out")
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(merged, indent=2, ensure_ascii=False))
    print(f"\nwrote: {args.out}  ({args.out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
