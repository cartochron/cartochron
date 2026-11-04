"""SQLite storage for received GPS observations, independent of HTTP and Metasploit."""

import os
import secrets
import math
import re
import sqlite3
import stat
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_RECENT_POINTS = 1000
SCHEMA_VERSION = 6
MAX_TRACKS = 100
MAX_SOURCES = 100
MAX_MONITOR = 100
MAX_RUN_PAGE = 100
MAX_PLACE_PAGE = 100
MAX_PLACE_CANDIDATES = 2000  # Cap candidate rows returned to Python per page.
SOURCE_ID_PATTERN = re.compile(r"src_[a-f0-9]{24}\Z")
TRACK_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
CHANNEL_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


def valid_source_id(value):
    """Canonical IDs are assigned at enrollment, not derived from hardware."""
    return isinstance(value, str) and SOURCE_ID_PATTERN.fullmatch(value) is not None


def valid_track_id(value):
    """Track IDs are small, portable identifiers, not device identities or secrets."""
    return isinstance(value, str) and TRACK_ID_PATTERN.fullmatch(value) is not None


def valid_channel_id(value):
    """Channels are operator-configured input identities, not device proof."""
    return isinstance(value, str) and CHANNEL_ID_PATTERN.fullmatch(value) is not None


class UnknownSource(ValueError):
    """An ingestion request referenced a source that was not enrolled."""


class SourceConflict(ValueError):
    """The requested run/source association contradicts stored history."""


class ObservationStore:
    """Own one SQLite connection; serialize its use across HTTP worker threads.

    Without a filename the database is in memory, with the legacy 1000-point
    retention limit. With a filename, observations remain on disk without
    automatic deletion. Queries still return at most the latest 1000 points.
    """

    def __init__(self, filename=None):
        self._lock = threading.Lock()
        self._persistent = filename is not None
        if self._persistent:
            self._prepare_file(filename)
        self._db = sqlite3.connect(
            str(filename) if self._persistent else ":memory:",
            check_same_thread=False,
        )
        self._db.execute("PRAGMA foreign_keys = ON")
        try:
            self._initialize()
        except Exception:
            self._db.close()
            raise

    @staticmethod
    def _prepare_file(filename):
        """Create private database files; reject existing publicly readable ones."""
        if os.fspath(filename) == ":memory:":
            raise ValueError("--db needs a filesystem path, not SQLite's :memory: name")
        path = Path(filename)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
        mode = path.lstat().st_mode
        if not stat.S_ISREG(mode) or mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise ValueError("database must be a regular private file (chmod 600)")

    def _initialize(self):
        version = self._db.execute("PRAGMA user_version").fetchone()[0]
        if version == 0:
            existing = self._db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
            if existing:
                raise ValueError("database has no Cartochron schema version; refusing to modify it")
            self._create_schema()
        elif version in (1, 2, 3, 4, 5):
            self._migrate(version)
        elif version != SCHEMA_VERSION:
            raise ValueError(f"unsupported database schema version: {version}")
        self._verify_schema()

    def _create_schema(self):
        """New databases start at the current schema, not at legacy revisions."""
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            self._db.execute("""
                CREATE TABLE sources (
                    source_id TEXT PRIMARY KEY,
                    label TEXT NOT NULL
                )
            """)
            self._db.execute("""
                CREATE TABLE runs (
                    track_id TEXT PRIMARY KEY,
                    source_id TEXT REFERENCES sources(source_id),
                    channel_id TEXT
                )
            """)
            self._db.execute("CREATE INDEX runs_channel ON runs(channel_id)")
            self._db.execute("""
                CREATE TABLE channel_labels (
                    channel_id TEXT PRIMARY KEY,
                    label TEXT NOT NULL
                )
            """)
            self._db.execute("""
                CREATE TABLE observations (
                    id INTEGER PRIMARY KEY,
                    track_id TEXT NOT NULL,
                    received_ms INTEGER NOT NULL,
                    lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
                    lon REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
                    measured_ms INTEGER,
                    provider TEXT,
                    accuracy_m REAL
                )
            """)
            self._db.execute("""
                CREATE INDEX observations_track_time
                ON observations(track_id, received_ms, id)
            """)
            self._db.execute("CREATE INDEX observations_place ON observations(lat, lon, id)")
            self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _migrate(self, version):
        """Upgrade existing histories without guessing unreported identities."""
        self._db.execute("SELECT id, track_id, received_ms, lat, lon FROM observations LIMIT 0")
        if version == 1:
            # Source/run enrollment was introduced in v2; old runs stay unassigned.
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("""
                    CREATE TABLE sources (
                        source_id TEXT PRIMARY KEY,
                        label TEXT NOT NULL
                    )
                """)
                self._db.execute("""
                    CREATE TABLE runs (
                        track_id TEXT PRIMARY KEY,
                        source_id TEXT REFERENCES sources(source_id)
                    )
                """)
                self._db.execute("""
                    INSERT INTO runs(track_id, source_id)
                    SELECT DISTINCT track_id, NULL FROM observations
                """)
                self._db.execute("PRAGMA user_version = 2")
            version = 2

        if version == 2:
            self._db.execute("SELECT source_id, label FROM sources LIMIT 0")
            self._db.execute("SELECT track_id, source_id FROM runs LIMIT 0")
            # Optional reported GPS measurement metadata introduced in v3.
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("ALTER TABLE observations ADD COLUMN measured_ms INTEGER")
                self._db.execute("ALTER TABLE observations ADD COLUMN provider TEXT")
                self._db.execute("ALTER TABLE observations ADD COLUMN accuracy_m REAL")
                self._db.execute("PRAGMA user_version = 3")
            version = 3

        if version == 3:
            # A channel was not observable in legacy records; preserve NULL.
            self._db.execute("SELECT source_id, label FROM sources LIMIT 0")
            self._db.execute("SELECT track_id, source_id FROM runs LIMIT 0")
            self._db.execute(
                "SELECT measured_ms, provider, accuracy_m FROM observations LIMIT 0"
            )
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("ALTER TABLE runs ADD COLUMN channel_id TEXT")
                self._db.execute("CREATE INDEX runs_channel ON runs(channel_id)")
                self._db.execute("PRAGMA user_version = 4")
            version = 4

        if version == 4:
            # Display names are separate from producer-origin run assertions.
            self._db.execute("SELECT track_id, source_id, channel_id FROM runs LIMIT 0")
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("""
                    CREATE TABLE channel_labels (
                        channel_id TEXT PRIMARY KEY,
                        label TEXT NOT NULL
                    )
                """)
                self._db.execute("PRAGMA user_version = 5")
            version = 5

        if version == 5:
            # Spatial bounding-box lookup, without modifying observations.
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("CREATE INDEX observations_place ON observations(lat, lon, id)")
                self._db.execute("PRAGMA user_version = 6")

    def _verify_schema(self):
        # A schema version is a contract, not a license to create missing tables.
        self._db.execute(
            "SELECT id, track_id, received_ms, lat, lon, measured_ms, provider, accuracy_m "
            "FROM observations LIMIT 0"
        )
        self._db.execute("SELECT source_id, label FROM sources LIMIT 0")
        self._db.execute("SELECT track_id, source_id, channel_id FROM runs LIMIT 0")
        self._db.execute("SELECT channel_id, label FROM channel_labels LIMIT 0")

    @staticmethod
    def _valid_label(label):
        if (not isinstance(label, str) or not 1 <= len(label) <= 80
                or not label.strip() or any(ord(ch) < 32 or ord(ch) == 127 for ch in label)):
            raise ValueError("label must be 1-80 printable characters")

    def enroll(self, label):
        """Create an operator-enrolled source. Labels are descriptions, not keys."""
        self._valid_label(label)
        with self._lock, self._db:
            source_id = "src_" + secrets.token_hex(12)
            self._db.execute("INSERT INTO sources(source_id, label) VALUES (?, ?)",
                             (source_id, label))
        return source_id

    def rename_source(self, source_id, label):
        """Change a display label without changing run attribution."""
        if not valid_source_id(source_id):
            raise ValueError("invalid source_id")
        self._valid_label(label)
        with self._lock, self._db:
            if self._db.execute("UPDATE sources SET label=? WHERE source_id=?",
                                (label, source_id)).rowcount == 0:
                raise ValueError("source_id not enrolled")

    def label_channel(self, channel_id, label):
        """Name an observed input channel; never reparent existing runs."""
        if not valid_channel_id(channel_id):
            raise ValueError("invalid channel_id")
        self._valid_label(label)
        with self._lock, self._db:
            if self._db.execute("SELECT 1 FROM runs WHERE channel_id=? LIMIT 1",
                                (channel_id,)).fetchone() is None:
                raise ValueError("unknown channel_id")
            self._db.execute("""INSERT INTO channel_labels(channel_id, label)
                VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET label=excluded.label""",
                (channel_id, label))

    def sources(self):
        """Return an authenticated, bounded source catalogue, including idle sources."""
        with self._lock:
            rows = self._db.execute("""
                SELECT s.source_id, s.label, COUNT(r.track_id), MAX(fix.last_ms)
                FROM sources s
                LEFT JOIN runs r ON r.source_id = s.source_id
                LEFT JOIN (
                    SELECT track_id, MAX(received_ms) AS last_ms
                    FROM observations GROUP BY track_id
                ) AS fix ON fix.track_id = r.track_id
                GROUP BY s.source_id
                ORDER BY s.label, s.source_id LIMIT ?
            """, (MAX_SOURCES + 1,)).fetchall()
        return {"sources": [
            {"source_id": sid, "label": label, "runs": count,
             "last": self._timestamp(last, "milliseconds") if last is not None else None}
            for sid, label, count, last in rows[:MAX_SOURCES]],
            "truncated": len(rows) > MAX_SOURCES}

    @staticmethod
    def _timestamp(received_ms, timespec="seconds"):
        # Integer arithmetic preserves exact milliseconds across time zones.
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        return (epoch + timedelta(milliseconds=received_ms)).isoformat(timespec=timespec)

    @classmethod
    def _point(cls, row):
        received_ms, lat, lon, measured_ms, provider, accuracy_m = row
        point = {"lat": lat, "lon": lon, "time": cls._timestamp(received_ms)}
        if measured_ms is not None:
            point["measured_time"] = cls._timestamp(measured_ms, "milliseconds")
        if provider is not None:
            point["provider"] = provider
        if accuracy_m is not None:
            point["accuracy_m"] = accuracy_m
        return point

    @classmethod
    def _historical_point(cls, row):
        point_id, *fix = row
        point = cls._point(fix)
        point.update(id=point_id, received_ms=fix[0],
                     time=cls._timestamp(fix[0], "milliseconds"))
        return point

    def record(self, lat, lon, track_id="legacy", source_id=None, *,
               measured_ms=None, provider=None, accuracy_m=None, channel_id=None):
        """Commit an observation under one immutable run-to-source association.

        Source and channel are independent assertions, immutable for a run.
        Missing values stay unknown, including after future observations.
        """
        if not valid_track_id(track_id):
            raise ValueError("invalid track_id")
        if source_id is not None and not valid_source_id(source_id):
            raise ValueError("invalid source_id")
        if channel_id is not None and not valid_channel_id(channel_id):
            raise ValueError("invalid channel_id")
        if measured_ms is not None and (type(measured_ms) is not int or
                                        not 0 <= measured_ms <= 253402300799999):
            raise ValueError("invalid measured_ms")
        if provider is not None and (not isinstance(provider, str) or
                                     re.fullmatch(r"[A-Za-z0-9._-]{1,40}", provider) is None):
            raise ValueError("invalid provider")
        if accuracy_m is not None and (type(accuracy_m) not in (int, float) or
                                       not math.isfinite(accuracy_m) or
                                       not 0 <= accuracy_m <= 100000):
            raise ValueError("invalid accuracy_m")
        with self._lock, self._db:
            if source_id is not None and self._db.execute(
                    "SELECT 1 FROM sources WHERE source_id = ?", (source_id,)).fetchone() is None:
                raise UnknownSource("unknown source_id")
            existing = self._db.execute(
                "SELECT source_id, channel_id FROM runs WHERE track_id = ?", (track_id,)).fetchone()
            if existing is None:
                self._db.execute(
                    "INSERT INTO runs(track_id, source_id, channel_id) VALUES (?, ?, ?)",
                    (track_id, source_id, channel_id))
            elif existing != (source_id, channel_id):
                raise SourceConflict("recording run source/channel association cannot change")
            received_ms = time.time_ns() // 1_000_000
            self._db.execute(
                """INSERT INTO observations(track_id, received_ms, lat, lon,
                                             measured_ms, provider, accuracy_m)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (track_id, received_ms, lat, lon, measured_ms, provider, accuracy_m),
            )
            if not self._persistent:
                self._db.execute("""
                    DELETE FROM observations WHERE id NOT IN (
                        SELECT id FROM observations ORDER BY id DESC LIMIT ?
                    )
                """, (MAX_RECENT_POINTS,))
        point = self._point((received_ms, lat, lon, measured_ms, provider, accuracy_m))
        if channel_id is not None:
            point["channel_id"] = channel_id  # Acknowledge persisted run association.
        return point

    def recent(self, track_id=None):
        """Return the latest points from one run, in chronological order.

        An omitted ID retains the original behavior: choose the last run to
        receive an observation. An explicit ID stays pinned to that run.
        """
        if track_id is not None and not valid_track_id(track_id):
            raise ValueError("invalid track_id")
        with self._lock:
            if track_id is None:
                latest = self._db.execute(
                    "SELECT track_id FROM observations ORDER BY id DESC LIMIT 1"
                ).fetchone()
                if latest is None:
                    return []
                track_id = latest[0]
            rows = self._db.execute(
                """SELECT received_ms, lat, lon, measured_ms, provider, accuracy_m
                   FROM observations
                   WHERE track_id = ? ORDER BY received_ms DESC, id DESC LIMIT ?""",
                (track_id, MAX_RECENT_POINTS),
            ).fetchall()
        return [self._point(row) for row in reversed(rows)]

    def tracks(self):
        """Bounded catalogue of runs, ordered by most recent ingestion."""
        with self._lock:
            rows = self._db.execute(
                """                SELECT runs.track_id, r.source_id, s.label, r.channel_id, c.label,
                       runs.count, runs.first_ms, runs.last_ms
                FROM (
                    SELECT track_id, COUNT(*) AS count,
                           MIN(received_ms) AS first_ms, MAX(received_ms) AS last_ms,
                           MAX(id) AS last_id
                    FROM observations GROUP BY track_id
                    ORDER BY last_id DESC LIMIT ?
                ) AS runs
                LEFT JOIN runs r ON r.track_id = runs.track_id
                LEFT JOIN sources s ON s.source_id = r.source_id
                LEFT JOIN channel_labels c ON c.channel_id = r.channel_id
                ORDER BY runs.last_id DESC""",
                (MAX_TRACKS + 1,),
            ).fetchall()
        return {
            "tracks": [
                {"track_id": track_id, "source_id": source_id, "source_label": source_label,
                 "channel_id": channel_id, "channel_label": channel_label, "count": count,
                 "first": self._timestamp(first_ms, "milliseconds"),
                 "last": self._timestamp(last_ms, "milliseconds")}
                for track_id, source_id, source_label, channel_id, channel_label,
                count, first_ms, last_ms in rows[:MAX_TRACKS]
            ],
            "truncated": len(rows) > MAX_TRACKS,
        }

    def monitor(self):
        """One latest run per reported channel, otherwise enrolled source.

        Unattributed runs have no shared identity. Only their newest run is
        exposed as an explicit fallback; the others remain separate in History.
        Choose the newest *inserted* observation, not the greatest clock value.
        No points or runs are ever combined into a synthetic recording.
        """
        with self._lock:
            rows = self._db.execute("""
                WITH fixes AS (
                    SELECT track_id, COUNT(*) AS count, MAX(id) AS last_id
                    FROM observations GROUP BY track_id
                ), identified AS (
                    SELECT f.*, latest.received_ms AS last_ms, latest.lat, latest.lon,
                           r.channel_id, r.source_id, s.label AS source_label,
                           c.label AS channel_label,
                           CASE WHEN r.channel_id IS NOT NULL THEN 'channel'
                                WHEN r.source_id IS NOT NULL THEN 'source'
                                ELSE 'unattributed' END AS kind,
                           COALESCE(r.channel_id, r.source_id, '') AS identity
                    FROM fixes f
                    JOIN observations latest ON latest.id = f.last_id
                    LEFT JOIN runs r ON r.track_id = f.track_id
                    LEFT JOIN sources s ON s.source_id = r.source_id
                    LEFT JOIN channel_labels c ON c.channel_id = r.channel_id
                ), ranked AS (
                    SELECT *,
                           COUNT(*) OVER (PARTITION BY kind, identity) AS run_count,
                           MIN(COALESCE(source_id, '')) OVER
                               (PARTITION BY kind, identity) AS source_min,
                           MAX(COALESCE(source_id, '')) OVER
                               (PARTITION BY kind, identity) AS source_max,
                           ROW_NUMBER() OVER
                               (PARTITION BY kind, identity ORDER BY last_id DESC) AS rank
                    FROM identified
                )
                SELECT kind, identity, track_id, source_id, source_label,
                       channel_id, channel_label, lat, lon, last_ms, run_count,
                       source_min != source_max
                FROM ranked WHERE rank = 1
                ORDER BY last_id DESC LIMIT ?
            """, (MAX_MONITOR + 1,)).fetchall()
        return {"entries": [
            {"kind": kind, "id": identity if kind != "unattributed" else track,
             "track_id": track, "source_id": source_id, "source_label": source_label,
             "channel_id": channel_id, "channel_label": channel_label,
             "lat": lat, "lon": lon, "runs": run_count,
             "mixed_sources": bool(mixed),
             "last": self._timestamp(last, "milliseconds")}
            for kind, identity, track, source_id, source_label, channel_id,
            channel_label, lat, lon, last, run_count, mixed in rows[:MAX_MONITOR]
        ], "truncated": len(rows) > MAX_MONITOR}

    def runs_page(self, *, limit=50, before=None, channel_id=None, source_id=None):
        """Page recording runs by last inserted fix; never join their points.

        A cursor is a row-ID boundary, not a database snapshot. The selected
        channel or source is an exact stored assertion, not a name match.
        """
        if type(limit) is not int or not 1 <= limit <= MAX_RUN_PAGE:
            raise ValueError("invalid limit")
        if before is not None and (type(before) is not int or not 1 <= before <= (1 << 63) - 1):
            raise ValueError("invalid before cursor")
        if channel_id is not None and not valid_channel_id(channel_id):
            raise ValueError("invalid channel_id")
        if source_id is not None and not valid_source_id(source_id):
            raise ValueError("invalid source_id")
        if channel_id is not None and source_id is not None:
            raise ValueError("filter by channel or source, not both")
        filters, params = [], []
        if channel_id is not None:
            filters.append("r.channel_id = ?")
            params.append(channel_id)
        if source_id is not None:
            filters.append("r.source_id = ?")
            params.append(source_id)
        where = ("WHERE " + " AND ".join(filters)) if filters else ""
        having = "HAVING MAX(o.id) < ?" if before is not None else ""
        if before is not None:
            params.append(before)
        with self._lock:
            rows = self._db.execute(f"""
                SELECT summary.track_id, r.source_id, s.label, r.channel_id, c.label,
                       summary.count, summary.first_ms, summary.last_ms, summary.last_id
                FROM (
                    SELECT o.track_id, COUNT(*) AS count,
                           MIN(o.received_ms) AS first_ms, MAX(o.received_ms) AS last_ms,
                           MAX(o.id) AS last_id
                    FROM observations o
                    LEFT JOIN runs r ON r.track_id=o.track_id
                    {where}
                    GROUP BY o.track_id {having}
                    ORDER BY last_id DESC LIMIT ?
                ) AS summary
                LEFT JOIN runs r ON r.track_id=summary.track_id
                LEFT JOIN sources s ON s.source_id=r.source_id
                LEFT JOIN channel_labels c ON c.channel_id=r.channel_id
                ORDER BY summary.last_id DESC
            """, (*params, limit + 1)).fetchall()
        page = rows[:limit]
        return {"tracks": [
            {"track_id": track_id, "source_id": sid, "source_label": slabel,
             "channel_id": cid, "channel_label": clabel, "count": count,
             "first": self._timestamp(first, "milliseconds"),
             "last": self._timestamp(last, "milliseconds")}
            for track_id, sid, slabel, cid, clabel, count, first, last, _ in page
        ], "next_cursor": str(page[-1][-1]) if len(rows) > limit else None}

    def history(self, track_id, *, from_ms=None, to_ms=None, limit=MAX_RECENT_POINTS,
                after=None):
        """Time-ordered, bounded track query; `after` is an (ms, row-id) cursor.

        An extra row distinguishes an exact page from a truncated one. The
        cursor is a position, not an authenticated capability or snapshot ID.
        """
        if not valid_track_id(track_id):
            raise ValueError("invalid track_id")
        if type(limit) is not int or not 1 <= limit <= MAX_RECENT_POINTS:
            raise ValueError("invalid limit")
        clauses, params = ["track_id = ?"], [track_id]
        if from_ms is not None:
            clauses.append("received_ms >= ?")
            params.append(from_ms)
        if to_ms is not None:
            clauses.append("received_ms < ?")
            params.append(to_ms)
        if after is not None:
            clauses.append("(received_ms, id) > (?, ?)")
            params.extend(after)
        sql = ("SELECT id, received_ms, lat, lon, measured_ms, provider, accuracy_m "
               "FROM observations WHERE "
               + " AND ".join(clauses)
               + " ORDER BY received_ms, id LIMIT ?")
        with self._lock:
            rows = self._db.execute(sql, (*params, limit + 1)).fetchall()
        more = len(rows) > limit
        selected = rows[:limit]
        return {
            "track_id": track_id,
            "points": [self._historical_point(row) for row in selected],
            "truncated": more,
            "next_cursor": f"{selected[-1][1]}:{selected[-1][0]}" if more else None,
        }

    def place_observations(self, lat, lon, radius_m, *, limit=50, before=None,
                           from_ms=None, to_ms=None, channel_id=None, source_id=None):
        """Find recorded fixes near a place across *all* recording runs.

        A bounding box narrows indexed candidates; great-circle distance then
        determines inclusion. The cursor counts *examined candidates* rather
        than matches, so a page with no matches can still have another page.
        It orders by ingestion row ID, never presumes clocks are monotonic.
        """
        if (type(lat) not in (float, int) or not math.isfinite(lat) or not -90 <= lat <= 90
                or type(lon) not in (float, int) or not math.isfinite(lon) or not -180 <= lon <= 180):
            raise ValueError("invalid place coordinates")
        if (type(radius_m) not in (float, int) or not math.isfinite(radius_m)
                or not 10 <= radius_m <= 1000):
            raise ValueError("radius_m must be between 10 and 1000")
        if type(limit) is not int or not 1 <= limit <= MAX_PLACE_PAGE:
            raise ValueError("limit must be 1..100")
        if before is not None and (type(before) is not int or not 1 <= before <= (1 << 63) - 1):
            raise ValueError("invalid before cursor")
        for name, value in (("from", from_ms), ("to", to_ms)):
            if value is not None and (type(value) is not int or not -(1 << 63) <= value < (1 << 63)):
                raise ValueError(f"invalid {name} timestamp")
        if from_ms is not None and to_ms is not None and from_ms >= to_ms:
            raise ValueError("from must precede to")
        if channel_id is not None and not valid_channel_id(channel_id):
            raise ValueError("invalid channel_id")
        if source_id is not None and not valid_source_id(source_id):
            raise ValueError("invalid source_id")
        if channel_id is not None and source_id is not None:
            raise ValueError("choose channel_id or source_id")
        # Conservative bounding box, including near the poles and date line.
        delta_lat = radius_m / 110_000
        low_lat, high_lat = max(-90, lat - delta_lat), min(90, lat + delta_lat)
        outer_lat = min(90, abs(lat) + delta_lat)
        cosine = math.cos(math.radians(outer_lat))
        delta_lon = 180 if cosine < 0.0001 else min(180, radius_m / (110_000 * cosine))
        lon_low, lon_high = lon - delta_lon, lon + delta_lon
        if delta_lon == 180:
            lon_clause, lon_params = "", []
        elif lon_low < -180:
            lon_clause, lon_params = "AND (o.lon >= ? OR o.lon <= ?)", [lon_low + 360, lon_high]
        elif lon_high > 180:
            lon_clause, lon_params = "AND (o.lon >= ? OR o.lon <= ?)", [lon_low, lon_high - 360]
        else:
            lon_clause, lon_params = "AND o.lon BETWEEN ? AND ?", [lon_low, lon_high]
        filters, filter_params = [], []
        if from_ms is not None:
            filters.append("o.received_ms >= ?")
            filter_params.append(from_ms)
        if to_ms is not None:
            filters.append("o.received_ms < ?")
            filter_params.append(to_ms)
        if channel_id is not None:
            filters.append("r.channel_id = ?")
            filter_params.append(channel_id)
        if source_id is not None:
            filters.append("r.source_id = ?")
            filter_params.append(source_id)
        extra_where = "".join(f" AND {clause}" for clause in filters)
        # Limit candidate rows transferred to Python. SQLite's indexed
        # bounding-box lookup can still scan/sort more entries internally;
        # this is a result bound, not a global CPU-time guarantee.
        sql = f"""
            SELECT o.id, o.track_id, o.received_ms, o.lat, o.lon,
                   o.measured_ms, o.provider, o.accuracy_m,
                   r.source_id, s.label, r.channel_id, c.label
            FROM observations o INDEXED BY observations_place
            LEFT JOIN runs r ON r.track_id = o.track_id
            LEFT JOIN sources s ON s.source_id = r.source_id
            LEFT JOIN channel_labels c ON c.channel_id = r.channel_id
            WHERE o.lat BETWEEN ? AND ? {lon_clause}
                  AND o.id < ? {extra_where}
            ORDER BY o.id DESC LIMIT ?
        """
        params = [low_lat, high_lat, *lon_params,
                  before if before is not None else (1 << 63) - 1,
                  *filter_params, MAX_PLACE_CANDIDATES + 1]
        with self._lock:
            rows = self._db.execute(sql, params).fetchall()
        matches = []
        scanned = 0
        last_examined = None
        for row in rows[:MAX_PLACE_CANDIDATES]:
            if len(matches) == limit:
                break
            identifier, track_id, received, plat, plon, measured, provider, accuracy, sid, slabel, cid, clabel = row
            scanned += 1
            last_examined = identifier
            phi, phi0 = math.radians(plat), math.radians(lat)
            dphi = phi - phi0
            dlambda = math.radians(plon - lon)
            hav = (math.sin(dphi / 2) ** 2 + math.cos(phi0) * math.cos(phi)
                   * math.sin(dlambda / 2) ** 2)
            meters = 12_742_000 * math.asin(min(1, math.sqrt(max(0, hav))))
            if meters <= radius_m:
                point = self._historical_point((identifier, received, plat, plon,
                                                measured, provider, accuracy))
                point.update(track_id=track_id, channel_id=cid, channel_label=clabel,
                             source_id=sid, source_label=slabel, distance_m=round(meters, 1))
                matches.append(point)
        has_more = len(rows) > scanned
        return {"points": matches, "scanned": scanned, "truncated": has_more,
                "next_cursor": str(last_examined) if has_more else None}

    def close(self):
        with self._lock:
            self._db.close()
