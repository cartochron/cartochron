"""SQLite storage for received GPS observations, independent of HTTP and Metasploit."""

import os
import secrets
import re
import sqlite3
import stat
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_RECENT_POINTS = 1000
SCHEMA_VERSION = 2
MAX_TRACKS = 100
MAX_SOURCES = 100
SOURCE_ID_PATTERN = re.compile(r"src_[a-f0-9]{24}\Z")
TRACK_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


def valid_source_id(value):
    """Canonical IDs are assigned at enrollment, not derived from hardware."""
    return isinstance(value, str) and SOURCE_ID_PATTERN.fullmatch(value) is not None


def valid_track_id(value):
    """Track IDs are small, portable identifiers, not device identities or secrets."""
    return isinstance(value, str) and TRACK_ID_PATTERN.fullmatch(value) is not None



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
        if version == SCHEMA_VERSION:
            self._verify_schema()
            return
        if version not in (0, 1):
            raise ValueError(f"unsupported database schema version: {version}")
        if version == 0:
            existing = self._db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
            if existing:
                raise ValueError("database has no Cartochron schema version; refusing to modify it")
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("""
                    CREATE TABLE observations (
                        id INTEGER PRIMARY KEY,
                        track_id TEXT NOT NULL,
                        received_ms INTEGER NOT NULL,
                        lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
                        lon REAL NOT NULL CHECK (lon BETWEEN -180 AND 180)
                    )
                """)
                self._db.execute("""
                    CREATE INDEX observations_track_time
                    ON observations(track_id, received_ms, id)
                """)
                self._db.execute("PRAGMA user_version = 1")
        else:
            self._db.execute(
                "SELECT id, track_id, received_ms, lat, lon FROM observations LIMIT 0"
            )

        # One transaction upgrades both new and existing version-1 databases.
        # Old runs remain unassigned; no historical source is guessed.
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
            self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        self._verify_schema()

    def _verify_schema(self):
        # A schema version is a contract, not a license to create missing tables.
        self._db.execute("SELECT id, track_id, received_ms, lat, lon FROM observations LIMIT 0")
        self._db.execute("SELECT source_id, label FROM sources LIMIT 0")
        self._db.execute("SELECT track_id, source_id FROM runs LIMIT 0")

    def enroll(self, label):
        """Create an operator-enrolled source. Labels are descriptions, not keys."""
        if (not isinstance(label, str) or not 1 <= len(label) <= 80
                or not label.strip() or any(ord(ch) < 32 or ord(ch) == 127 for ch in label)):
            raise ValueError("label must be 1-80 printable characters")
        with self._lock, self._db:
            source_id = "src_" + secrets.token_hex(12)
            self._db.execute("INSERT INTO sources(source_id, label) VALUES (?, ?)",
                             (source_id, label))
        return source_id

    def sources(self):
        """Return an authenticated, bounded source catalogue, including idle sources."""
        with self._lock:
            rows = self._db.execute("""
                SELECT s.source_id, s.label, COUNT(DISTINCT r.track_id), MAX(o.received_ms)
                FROM sources s
                LEFT JOIN runs r ON r.source_id = s.source_id
                LEFT JOIN observations o ON o.track_id = r.track_id
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
        received_ms, lat, lon = row
        return {"lat": lat, "lon": lon, "time": cls._timestamp(received_ms)}

    @classmethod
    def _historical_point(cls, row):
        point_id, received_ms, lat, lon = row
        return {"id": point_id, "received_ms": received_ms,
                "lat": lat, "lon": lon, "time": cls._timestamp(received_ms, "milliseconds")}

    def record(self, lat, lon, track_id="legacy", source_id=None):
        """Commit an observation under one immutable run-to-source association.

        A run first created without a source cannot silently be claimed later,
        and an enrolled run cannot be written as an anonymous legacy run.
        """
        if not valid_track_id(track_id):
            raise ValueError("invalid track_id")
        if source_id is not None and not valid_source_id(source_id):
            raise ValueError("invalid source_id")
        with self._lock, self._db:
            if source_id is not None and self._db.execute(
                    "SELECT 1 FROM sources WHERE source_id = ?", (source_id,)).fetchone() is None:
                raise UnknownSource("unknown source_id")
            existing = self._db.execute(
                "SELECT source_id FROM runs WHERE track_id = ?", (track_id,)).fetchone()
            if existing is None:
                self._db.execute("INSERT INTO runs(track_id, source_id) VALUES (?, ?)",
                                 (track_id, source_id))
            elif existing[0] != source_id:
                raise SourceConflict("recording run belongs to a different source")
            received_ms = time.time_ns() // 1_000_000
            self._db.execute(
                "INSERT INTO observations(track_id, received_ms, lat, lon) VALUES (?, ?, ?, ?)",
                (track_id, received_ms, lat, lon),
            )
            if not self._persistent:
                self._db.execute("""
                    DELETE FROM observations WHERE id NOT IN (
                        SELECT id FROM observations ORDER BY id DESC LIMIT ?
                    )
                """, (MAX_RECENT_POINTS,))
        return self._point((received_ms, lat, lon))

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
                """SELECT received_ms, lat, lon FROM observations
                   WHERE track_id = ? ORDER BY received_ms DESC, id DESC LIMIT ?""",
                (track_id, MAX_RECENT_POINTS),
            ).fetchall()
        return [self._point(row) for row in reversed(rows)]

    def tracks(self):
        """Bounded catalogue of runs, ordered by most recent ingestion."""
        with self._lock:
            rows = self._db.execute(
                """SELECT o.track_id, r.source_id, COUNT(*), MIN(o.received_ms), MAX(o.received_ms)
                   FROM observations o LEFT JOIN runs r ON r.track_id = o.track_id
                   GROUP BY o.track_id, r.source_id ORDER BY MAX(o.id) DESC
                   LIMIT ?""",
                (MAX_TRACKS + 1,),
            ).fetchall()
        return {
            "tracks": [
                {"track_id": track_id, "source_id": source_id, "count": count,
                 "first": self._timestamp(first_ms, "milliseconds"),
                 "last": self._timestamp(last_ms, "milliseconds")}
                for track_id, source_id, count, first_ms, last_ms in rows[:MAX_TRACKS]
            ],
            "truncated": len(rows) > MAX_TRACKS,
        }

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
        sql = ("SELECT id, received_ms, lat, lon FROM observations WHERE "
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

    def close(self):
        with self._lock:
            self._db.close()
