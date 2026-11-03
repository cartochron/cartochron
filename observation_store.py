"""SQLite storage for received GPS observations, independent of HTTP and Metasploit."""

import os
import sqlite3
import stat
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

MAX_RECENT_POINTS = 1000
SCHEMA_VERSION = 1


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
    def _point(row):
        received_ms, lat, lon = row
        timestamp = datetime.fromtimestamp(received_ms / 1000, timezone.utc)
        return {"lat": lat, "lon": lon, "time": timestamp.isoformat(timespec="seconds")}

    def record(self, lat, lon):
        """Commit first; only then return an acknowledgement to the HTTP layer."""
        received_ms = time.time_ns() // 1_000_000
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO observations(track_id, received_ms, lat, lon) VALUES (?, ?, ?, ?)",
                ("legacy", received_ms, lat, lon),
            )
            if not self._persistent:
                self._db.execute("""
                    DELETE FROM observations WHERE id NOT IN (
                        SELECT id FROM observations ORDER BY id DESC LIMIT ?
                    )
                """, (MAX_RECENT_POINTS,))
        return self._point((received_ms, lat, lon))

    def recent(self):
        """Return a bounded, chronologically ordered JSON-compatible snapshot."""
        with self._lock:
            rows = self._db.execute(
                "SELECT received_ms, lat, lon FROM observations ORDER BY id DESC LIMIT ?",
                (MAX_RECENT_POINTS,),
            ).fetchall()
        return [self._point(row) for row in reversed(rows)]

    def close(self):
        with self._lock:
            self._db.close()
