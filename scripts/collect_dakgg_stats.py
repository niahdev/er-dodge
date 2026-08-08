#!/usr/bin/env python3
"""Collect DAK.GG tier/character statistics into a local SQLite database."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sqlite3
import sys
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://er.dakgg.io/api/v1/character-stats"
CHARACTER_API_URL = "https://er.dakgg.io/api/v0/characters?hl=ko"
DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "dakgg_stats.sqlite3"
DEFAULT_ARTIFACT_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "dakgg_stats.json.gz"
)
USER_AGENT = "ER-Dodge-Check/1.0 (+https://github.com/dejava-daisky/er-dodge)"
COLLECT_AFTER_ENV = "DAKGG_COLLECT_AFTER"
TIERS = (
    ("in1000", "상위 1000명"),
    ("mithril_plus", "미스릴+"),
    ("meteorite_plus", "메테오라이트+"),
    ("diamond_plus", "다이아몬드+"),
    ("platinum_plus", "플래티넘+"),
    ("platinum", "플래티넘"),
    ("gold", "골드"),
    ("silver", "실버"),
    ("bronze", "브론즈"),
    ("iron", "아이언"),
)

SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE collection_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_url TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    period_days INTEGER NOT NULL,
    matching_mode TEXT NOT NULL,
    team_mode TEXT NOT NULL,
    current_patch INTEGER,
    previous_patch INTEGER,
    source_updated_at_min INTEGER NOT NULL,
    source_updated_at_max INTEGER NOT NULL,
    tier_count INTEGER NOT NULL
);

CREATE TABLE tier_snapshots (
    tier_key TEXT PRIMARY KEY,
    tier_label TEXT NOT NULL,
    game_count INTEGER NOT NULL,
    source_updated_at INTEGER NOT NULL
);

CREATE TABLE character_stats (
    tier_key TEXT NOT NULL,
    character_id INTEGER NOT NULL,
    game_count INTEGER NOT NULL,
    wins INTEGER NOT NULL,
    top3_count INTEGER NOT NULL,
    placement_sum INTEGER NOT NULL,
    damage_to_player_sum INTEGER NOT NULL,
    damage_to_monster_sum INTEGER NOT NULL,
    mmr_gain_sum INTEGER NOT NULL,
    team_kill_sum INTEGER NOT NULL,
    player_kill_sum INTEGER NOT NULL,
    player_assistant_sum INTEGER NOT NULL,
    monster_kill_sum INTEGER NOT NULL,
    player_death_sum INTEGER NOT NULL,
    view_contribution_sum INTEGER NOT NULL,
    win_rate REAL NOT NULL,
    top3_rate REAL NOT NULL,
    average_placement REAL NOT NULL,
    average_damage_to_player REAL NOT NULL,
    average_damage_to_monster REAL NOT NULL,
    average_mmr_gain REAL NOT NULL,
    average_team_kills REAL NOT NULL,
    average_player_kills REAL NOT NULL,
    average_player_assists REAL NOT NULL,
    average_monster_kills REAL NOT NULL,
    average_player_deaths REAL NOT NULL,
    average_view_contribution REAL NOT NULL,
    PRIMARY KEY (tier_key, character_id),
    FOREIGN KEY (tier_key) REFERENCES tier_snapshots(tier_key) ON DELETE CASCADE
);

CREATE TABLE weapon_stats (
    tier_key TEXT NOT NULL,
    character_id INTEGER NOT NULL,
    weapon_id INTEGER NOT NULL,
    game_count INTEGER NOT NULL,
    wins INTEGER NOT NULL,
    top3_count INTEGER NOT NULL,
    placement_sum INTEGER NOT NULL,
    damage_to_player_sum INTEGER NOT NULL,
    damage_to_monster_sum INTEGER NOT NULL,
    mmr_gain_sum INTEGER NOT NULL,
    team_kill_sum INTEGER NOT NULL,
    player_kill_sum INTEGER NOT NULL,
    player_assistant_sum INTEGER NOT NULL,
    monster_kill_sum INTEGER NOT NULL,
    player_death_sum INTEGER NOT NULL,
    view_contribution_sum INTEGER NOT NULL,
    win_rate REAL NOT NULL,
    top3_rate REAL NOT NULL,
    average_placement REAL NOT NULL,
    average_damage_to_player REAL NOT NULL,
    average_damage_to_monster REAL NOT NULL,
    average_mmr_gain REAL NOT NULL,
    average_team_kills REAL NOT NULL,
    average_player_kills REAL NOT NULL,
    average_player_assists REAL NOT NULL,
    average_monster_kills REAL NOT NULL,
    average_player_deaths REAL NOT NULL,
    average_view_contribution REAL NOT NULL,
    ranking_size INTEGER,
    pick_rank INTEGER,
    win_rank INTEGER,
    top3_rank INTEGER,
    placement_rank INTEGER,
    damage_to_player_rank INTEGER,
    dak_tier TEXT,
    dak_tier_score REAL,
    PRIMARY KEY (tier_key, character_id, weapon_id),
    FOREIGN KEY (tier_key, character_id)
        REFERENCES character_stats(tier_key, character_id) ON DELETE CASCADE
);

CREATE INDEX idx_character_stats_character
    ON character_stats(character_id, tier_key);

CREATE INDEX idx_weapon_stats_character
    ON weapon_stats(character_id, weapon_id, tier_key);
"""

SUM_FIELDS = (
    "win",
    "top3",
    "place",
    "damageToPlayer",
    "damageToMonster",
    "mmrGain",
    "teamKill",
    "playerKill",
    "playerAssistant",
    "monsterKill",
    "playerDeaths",
    "viewContribution",
)


class TierSnapshotUnavailableError(RuntimeError):
    """Raised when DAK.GG has not published a requested tier snapshot."""

    def __init__(self, tier_key, error):
        super().__init__(f"tier snapshot {tier_key} is unavailable: {error}")
        self.tier_key = tier_key


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT_PATH)
    parser.add_argument("--period-days", type=int, default=7)
    parser.add_argument("--delay", type=float, default=0.35)
    parser.add_argument(
        "--collect-after",
        type=parse_timestamp,
        default=os.environ.get(COLLECT_AFTER_ENV),
        help="do not collect before this ISO-8601 timestamp",
    )
    return parser.parse_args()


def parse_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(
            "collect-after must be an ISO-8601 timestamp"
        ) from exc
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("collect-after must include a timezone")
    return parsed.astimezone(timezone.utc)


def set_collection_output(updated):
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"updated={'true' if updated else 'false'}\n")


def fetch_tier(tier_key, period_days, attempts=3):
    query = urlencode(
        {
            "dt": period_days,
            "matchingMode": "RANK",
            "teamMode": "SQUAD",
            "tier": tier_key,
        }
    )
    request = Request(
        f"{API_URL}?{query}",
        headers={
            "Accept": "application/json",
            "Dakgg-Language": "ko",
            "User-Agent": USER_AGENT,
        },
    )

    for attempt in range(1, attempts + 1):
        try:
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError(f"unexpected HTTP status {response.status}")
                return json.load(response)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            if isinstance(exc, HTTPError) and exc.code == 404:
                raise TierSnapshotUnavailableError(tier_key, exc) from exc
            if attempt == attempts:
                raise RuntimeError(f"failed to fetch tier {tier_key}: {exc}") from exc
            time.sleep(attempt * 2)


def fetch_characters(attempts=3):
    request = Request(
        CHARACTER_API_URL,
        headers={
            "Accept": "application/json",
            "Dakgg-Language": "ko",
            "User-Agent": USER_AGENT,
        },
    )
    for attempt in range(1, attempts + 1):
        try:
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError(f"unexpected HTTP status {response.status}")
                payload = json.load(response)
            characters = payload.get("characters")
            if not isinstance(characters, list) or not characters:
                raise ValueError("character metadata is empty")
            return {
                str(require_int(character.get("id"), "character.id")): {
                    "key": character.get("key") or "",
                    "name": character.get("name") or character.get("key") or "",
                    "imageUrl": character.get("imageUrl") or "",
                }
                for character in characters
            }
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            if attempt == attempts:
                raise RuntimeError(f"failed to fetch character metadata: {exc}") from exc
            time.sleep(attempt * 2)


def require_int(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc


def validate_snapshot(payload, tier_key, period_days):
    meta = payload.get("meta") or {}
    snapshot = payload.get("characterStatSnapshot") or {}
    characters = snapshot.get("characterStats")

    if meta.get("tier") != tier_key:
        raise ValueError(f"{tier_key}: response tier mismatch")
    if require_int(meta.get("dt"), "meta.dt") != period_days:
        raise ValueError(f"{tier_key}: response period mismatch")
    if not isinstance(characters, list) or not characters:
        raise ValueError(f"{tier_key}: character statistics are empty")

    require_int(meta.get("updatedAt"), "meta.updatedAt")
    require_int(snapshot.get("tierCount"), "tierCount")
    for character in characters:
        require_int(character.get("key"), "character.key")
        weapons = character.get("weaponStats")
        if not isinstance(weapons, list) or not weapons:
            raise ValueError(f"{tier_key}: weapon statistics are empty")


def zero_totals():
    return {field: 0 for field in SUM_FIELDS}


def normalized_row(stats):
    count = require_int(stats.get("count"), "count")
    if count <= 0:
        raise ValueError("count must be positive")

    totals = {
        field: require_int(stats.get(field, 0), field)
        for field in SUM_FIELDS
    }
    return (
        count,
        totals["win"],
        totals["top3"],
        totals["place"],
        totals["damageToPlayer"],
        totals["damageToMonster"],
        totals["mmrGain"],
        totals["teamKill"],
        totals["playerKill"],
        totals["playerAssistant"],
        totals["monsterKill"],
        totals["playerDeaths"],
        totals["viewContribution"],
        totals["win"] / count,
        totals["top3"] / count,
        totals["place"] / count,
        totals["damageToPlayer"] / count,
        totals["damageToMonster"] / count,
        totals["mmrGain"] / count,
        totals["teamKill"] / count,
        totals["playerKill"] / count,
        totals["playerAssistant"] / count,
        totals["monsterKill"] / count,
        totals["playerDeaths"] / count,
        totals["viewContribution"] / count,
    )


def aggregate_character(character):
    totals = zero_totals()
    count = 0
    for weapon in character["weaponStats"]:
        weapon_count = require_int(weapon.get("count"), "weapon.count")
        if weapon_count <= 0:
            continue
        count += weapon_count
        for field in SUM_FIELDS:
            totals[field] += require_int(weapon.get(field, 0), field)
    if count <= 0:
        raise ValueError(f"character {character.get('key')} has no games")
    return {"count": count, **totals}


def insert_snapshot(conn, tier_key, tier_label, payload):
    meta = payload["meta"]
    snapshot = payload["characterStatSnapshot"]
    conn.execute(
        """
        INSERT INTO tier_snapshots (
            tier_key, tier_label, game_count, source_updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            tier_key,
            tier_label,
            require_int(snapshot["tierCount"], "tierCount"),
            require_int(meta["updatedAt"], "meta.updatedAt"),
        ),
    )

    for character in snapshot["characterStats"]:
        character_id = require_int(character["key"], "character.key")
        aggregate = aggregate_character(character)
        conn.execute(
            """
            INSERT INTO character_stats VALUES (
                ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            (tier_key, character_id, *normalized_row(aggregate)),
        )

        for weapon in character["weaponStats"]:
            if require_int(weapon.get("count"), "weapon.count") <= 0:
                continue
            rank = weapon.get("rank") or {}
            conn.execute(
                """
                INSERT INTO weapon_stats VALUES (
                    ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    tier_key,
                    character_id,
                    require_int(weapon["key"], "weapon.key"),
                    *normalized_row(weapon),
                    rank.get("size"),
                    rank.get("count"),
                    rank.get("win"),
                    rank.get("top3"),
                    rank.get("place"),
                    rank.get("damageToPlayer"),
                    weapon.get("tier"),
                    weapon.get("tierScore"),
                ),
            )


def build_database(db_path, payloads, period_days):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = db_path.with_name(f".{db_path.name}.tmp")
    temp_path.unlink(missing_ok=True)

    updated_values = [
        require_int(payload["meta"]["updatedAt"], "meta.updatedAt")
        for _, _, payload in payloads
    ]
    patches = payloads[0][2].get("patches") or []
    collected_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    try:
        with closing(sqlite3.connect(temp_path)) as conn:
            conn.executescript(SCHEMA)
            with conn:
                for tier_key, tier_label, payload in payloads:
                    insert_snapshot(conn, tier_key, tier_label, payload)
                conn.execute(
                    """
                    INSERT INTO collection_meta
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        1,
                        API_URL,
                        collected_at,
                        period_days,
                        "RANK",
                        "SQUAD",
                        patches[0] if len(patches) > 0 else None,
                        patches[1] if len(patches) > 1 else None,
                        min(updated_values),
                        max(updated_values),
                        len(payloads),
                    ),
                )
                conn.execute("PRAGMA optimize")

        with closing(sqlite3.connect(temp_path)) as conn:
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        os.replace(temp_path, db_path)
    finally:
        temp_path.unlink(missing_ok=True)


def database_is_current(db_path, payloads, period_days):
    if not db_path.exists():
        return False

    updated_values = [
        require_int(payload["meta"]["updatedAt"], "meta.updatedAt")
        for _, _, payload in payloads
    ]
    patches = payloads[0][2].get("patches") or []
    try:
        with closing(sqlite3.connect(db_path)) as conn:
            if conn.execute("PRAGMA user_version").fetchone()[0] != 1:
                return False
            row = conn.execute(
                """
                SELECT
                    period_days,
                    current_patch,
                    previous_patch,
                    source_updated_at_min,
                    source_updated_at_max,
                    tier_count
                FROM collection_meta
                WHERE id = 1
                """
            ).fetchone()
    except sqlite3.DatabaseError:
        return False

    expected = (
        period_days,
        patches[0] if len(patches) > 0 else None,
        patches[1] if len(patches) > 1 else None,
        min(updated_values),
        max(updated_values),
        len(payloads),
    )
    return row == expected


def print_summary(db_path):
    with closing(sqlite3.connect(db_path)) as conn:
        tiers = conn.execute("SELECT COUNT(*) FROM tier_snapshots").fetchone()[0]
        characters = conn.execute("SELECT COUNT(*) FROM character_stats").fetchone()[0]
        weapons = conn.execute("SELECT COUNT(*) FROM weapon_stats").fetchone()[0]
        games = conn.execute("SELECT SUM(game_count) FROM tier_snapshots").fetchone()[0]
        patch = conn.execute(
            "SELECT current_patch FROM collection_meta WHERE id = 1"
        ).fetchone()[0]
    print(f"database: {db_path}")
    print(f"patch: {patch}")
    print(f"tiers: {tiers}")
    print(f"tier game samples: {games:,}")
    print(f"character rows: {characters}")
    print(f"weapon rows: {weapons}")


def build_release_artifact(db_path, artifact_path, character_metadata):
    with closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        meta = dict(conn.execute("SELECT * FROM collection_meta WHERE id = 1").fetchone())
        tiers = {}
        tier_rows = conn.execute(
            """
            SELECT tier_key, tier_label, game_count, source_updated_at
            FROM tier_snapshots
            ORDER BY rowid
            """
        ).fetchall()
        for tier in tier_rows:
            tier_characters = {}
            rows = conn.execute(
                """
                SELECT
                    character_id,
                    game_count,
                    win_rate,
                    top3_rate,
                    average_placement,
                    average_damage_to_player,
                    average_mmr_gain,
                    average_team_kills,
                    average_player_kills,
                    average_player_assists,
                    average_player_deaths,
                    average_view_contribution
                FROM character_stats
                WHERE tier_key = ?
                ORDER BY character_id
                """,
                (tier["tier_key"],),
            ).fetchall()
            for row in rows:
                tier_characters[str(row["character_id"])] = {
                    "games": row["game_count"],
                    "winRate": round(row["win_rate"], 7),
                    "top3Rate": round(row["top3_rate"], 7),
                    "averagePlacement": round(row["average_placement"], 5),
                    "averageDamage": round(row["average_damage_to_player"], 2),
                    "averageMmrGain": round(row["average_mmr_gain"], 4),
                    "averageTeamKills": round(row["average_team_kills"], 4),
                    "averagePlayerKills": round(row["average_player_kills"], 4),
                    "averagePlayerAssists": round(row["average_player_assists"], 4),
                    "averagePlayerDeaths": round(row["average_player_deaths"], 4),
                    "averageViewContribution": round(
                        row["average_view_contribution"], 4
                    ),
                }
            tiers[tier["tier_key"]] = {
                "label": tier["tier_label"],
                "games": tier["game_count"],
                "updatedAt": tier["source_updated_at"],
                "characters": tier_characters,
            }

    artifact = {
        "schemaVersion": 1,
        "source": meta["source_url"],
        "collectedAt": meta["collected_at"],
        "periodDays": meta["period_days"],
        "matchingMode": meta["matching_mode"],
        "teamMode": meta["team_mode"],
        "currentPatch": meta["current_patch"],
        "previousPatch": meta["previous_patch"],
        "sourceUpdatedAtMin": meta["source_updated_at_min"],
        "sourceUpdatedAtMax": meta["source_updated_at_max"],
        "characters": character_metadata,
        "tiers": tiers,
    }
    encoded = json.dumps(
        artifact, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = artifact_path.with_name(f".{artifact_path.name}.tmp")
    try:
        with temp_path.open("wb") as output:
            with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
                compressed.write(encoded)
        os.replace(temp_path, artifact_path)
    finally:
        temp_path.unlink(missing_ok=True)
    print(f"release artifact: {artifact_path} ({artifact_path.stat().st_size:,} bytes)")


def main():
    args = parse_args()
    set_collection_output(False)
    artifact_path = args.artifact.resolve()
    if args.collect_after and datetime.now(timezone.utc) < args.collect_after:
        if not artifact_path.is_file():
            raise RuntimeError(
                f"collection is deferred until {args.collect_after.isoformat()}, "
                "but no cached artifact is available"
            )
        print(
            f"collection deferred until {args.collect_after.isoformat()}; "
            f"keeping cached artifact {artifact_path}"
        )
        return

    print("fetching character metadata...")
    characters = fetch_characters()
    payloads = []
    for index, (tier_key, tier_label) in enumerate(TIERS):
        print(f"fetching {tier_key}...")
        try:
            payload = fetch_tier(tier_key, args.period_days)
        except TierSnapshotUnavailableError as exc:
            if not artifact_path.is_file():
                raise RuntimeError(
                    f"{exc}; no existing release artifact is available"
                ) from exc
            print(
                f"warning: {exc}; keeping existing release artifact {artifact_path}",
                file=sys.stderr,
            )
            return
        validate_snapshot(payload, tier_key, args.period_days)
        payloads.append((tier_key, tier_label, payload))
        if index + 1 < len(TIERS):
            time.sleep(args.delay)

    db_path = args.db.resolve()
    if database_is_current(db_path, payloads, args.period_days):
        print("source snapshots are unchanged; keeping the existing database")
    else:
        build_database(db_path, payloads, args.period_days)
    print_summary(db_path)
    build_release_artifact(db_path, artifact_path, characters)
    set_collection_output(True)


if __name__ == "__main__":
    main()
