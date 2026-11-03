"""SQLite storage for received GPS observations, independent of HTTP and Metasploit."""

import os
import re
import sqlite3
import stat
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

MAX_RECENT_POINTS = 1000
SCHEMA_VERSION = 1
MAX_TRACKS = 100
TRACK_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


def valid_track_id(value):
    """Track IDs are small, portable identifiers, not device identities or secrets."""
    return isinstance(value, str) and TRACK_ID_PATTERN.fullmatch(value) is not None



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
            # Fail on a mismatched schema rather than silently invent columns.
            self._db.execute("SELECT id, track_id, received_ms, lat, lon FROM observations LIMIT 0")
            return
        if version != 0:
            raise ValueError(f"unsupported database schema version: {version}")
        existing = self._db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        if existing:
            raise ValueError("database has no Cartochron schema version; refusing to modify it")
        # DDL and version stamp must commit together. A crash must not leave
        # a versionless, half-created database that cannot be reopened.
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
            self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    @staticmethod
    def _timestamp(received_ms, timespec="seconds"):
        return datetime.fromtimestamp(received_ms / 1000, timezone.utc).isoformat(timespec=timespec)

    @classmethod
    def _point(cls, row):
        received_ms, lat, lon = row
        return {"lat": lat, "lon": lon, "time": cls._timestamp(received_ms)}

    @classmethod
    def _historical_point(cls, row):
        point_id, received_ms, lat, lon = row
        return {"id": point_id, "received_ms": received_ms,
                "lat": lat, "lon": lon, "time": cls._timestamp(received_ms, "milliseconds")}

    def record(self, lat, lon, track_id="legacy"):
        """Commit first; only then return an acknowledgement to the HTTP layer."""
        if not valid_track_id(track_id):
            raise ValueError("invalid track_id")
        with self._lock, self._db:
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

    def recent(self):
        """Return recent points from one run, never a route joining unrelated runs.

        The unfiltered legacy viewer follows the most recently ingested track.
        Dedicated historical queries select a track explicitly.
        """
        with self._lock:
            latest = self._db.execute(
                "SELECT track_id FROM observations ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if latest is None:
                return []
            rows = self._db.execute(
                """SELECT received_ms, lat, lon FROM observations
                   WHERE track_id = ? ORDER BY id DESC LIMIT ?""",
                (latest[0], MAX_RECENT_POINTS),
            ).fetchall()
        return [self._point(row) for row in reversed(rows)]

    def tracks(self):
        """Bounded catalogue of runs, ordered by most recent ingestion."""
        with self._lock:
            rows = self._db.execute(
                """SELECT track_id, COUNT(*), MIN(received_ms), MAX(received_ms)
                   FROM observations GROUP BY track_id ORDER BY MAX(id) DESC
                   LIMIT ?""",
                (MAX_TRACKS + 1,),
            ).fetchall()
        return {
            "tracks": [
                {"track_id": track_id, "count": count,
                 "first": self._timestamp(first_ms, "milliseconds"),
                 "last": self._timestamp(last_ms, "milliseconds")}
                for track_id, count, first_ms, last_ms in rows[:MAX_TRACKS]
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
