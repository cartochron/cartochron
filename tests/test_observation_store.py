"""Storage behavior: durability, bounds, concurrency, and refusal of unsafe files."""

import os
import sqlite3
import stat
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from observation_store import MAX_RECENT_POINTS, ObservationStore, SCHEMA_VERSION, valid_track_id


class ObservationStoreTest(unittest.TestCase):
    def test_new_database_starts_directly_at_current_schema(self):
        # A pre-release version need not reenact v1/v2 migrations every time
        # someone creates an empty database.
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "new.sqlite3"
            statements = []
            real_connect = sqlite3.connect

            def traced_connect(*args, **kwargs):
                db = real_connect(*args, **kwargs)
                db.set_trace_callback(statements.append)
                return db

            with patch("observation_store.sqlite3.connect", side_effect=traced_connect):
                store = ObservationStore(filename)
                try:
                    sid = store.enroll("Lab")
                    store.record(47, 28, "run", sid, measured_ms=1700000000000,
                                 provider="gps", accuracy_m=12.0)
                finally:
                    store.close()
            self.assertFalse(any("ALTER TABLE" in sql.upper() for sql in statements))
            self.assertFalse(any("USER_VERSION = 1" in sql.upper() or
                                 "USER_VERSION = 2" in sql.upper() for sql in statements))
            with closing(real_connect(filename)) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT provider, accuracy_m FROM observations").fetchone(),
                                 ("gps", 12.0))

    def test_track_ids_are_validated_and_isolated(self):
        store = ObservationStore()
        try:
            store.record(47, 28, "run-A")
            store.record(48, 29, "run-B")
            store.record(49, 30, "run-A")
            self.assertEqual([p["lat"] for p in store.recent()], [47, 49])
            catalogue = store.tracks()
            self.assertEqual([t["track_id"] for t in catalogue["tracks"]], ["run-A", "run-B"])
            self.assertEqual([t["count"] for t in catalogue["tracks"]], [2, 1])
            self.assertFalse(catalogue["truncated"])
            for invalid in ("", " space", "../oops", "x" * 65, "é", None, 42):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    store.record(47, 28, invalid)
            self.assertTrue(valid_track_id("abc.1-X_y"))
            self.assertEqual(len(store.tracks()["tracks"]), 2)
        finally:
            store.close()

    def test_recent_explicit_track_returns_newest_page_not_first_page(self):
        import tempfile
        directory = tempfile.TemporaryDirectory()
        store = ObservationStore(Path(directory.name) / "observations.sqlite3")
        try:
            for index in range(MAX_RECENT_POINTS + 3):
                store.record(47, float(index % 180) - 90, "A")
            store.record(48, 28, "B")
            recent = store.recent("A")
            self.assertEqual(len(recent), MAX_RECENT_POINTS)
            self.assertEqual(recent[0]["lon"], 3 - 90)
            self.assertEqual(recent[-1]["lon"], (MAX_RECENT_POINTS + 2) % 180 - 90)
            self.assertEqual([p["lat"] for p in store.recent("B")], [48])
        finally:
            store.close()
            directory.cleanup()

    def test_timestamp_formatting_preserves_exact_milliseconds(self):
        self.assertEqual(ObservationStore._timestamp(1_700_000_000_001, "milliseconds"),
                         "2023-11-14T22:13:20.001+00:00")
        self.assertEqual(ObservationStore._timestamp(1_700_000_000_999, "milliseconds"),
                         "2023-11-14T22:13:20.999+00:00")

    def test_historical_interval_is_half_open_with_stable_cursor(self):
        store = ObservationStore()
        try:
            # Real SQLite writes with an injected clock: two equal timestamps
            # must remain distinct and pagination must not repeat either one.
            with patch("observation_store.time.time_ns", side_effect=[
                1_700_000_000_000_000_000,
                1_700_000_000_000_000_000,
                1_700_000_000_100_000_000,
                1_700_000_000_100_000_000,
            ]):
                store.record(47, 28, "A")
                store.record(48, 28, "A")
                store.record(90, 28, "B")
                store.record(49, 28, "A")
            first = store.history("A", from_ms=1700000000000,
                                  to_ms=1700000000100, limit=1)
            self.assertEqual([p["lat"] for p in first["points"]], [47])
            self.assertTrue(first["truncated"])
            self.assertIsNotNone(first["next_cursor"])
            values = list(first["points"])
            page = first
            while page["next_cursor"] is not None:
                cursor = tuple(map(int, page["next_cursor"].split(":")))
                page = store.history("A", from_ms=1700000000000,
                                     to_ms=1700000000100, limit=1,
                                     after=cursor)
                values.extend(page["points"])
            self.assertEqual([p["lat"] for p in values], [47, 48])
            self.assertEqual(len({p["id"] for p in values}), 2)
            self.assertFalse(page["truncated"])
            self.assertIsNone(page["next_cursor"])
            self.assertEqual([p["lat"] for p in store.history("A", to_ms=1700000000101)["points"]],
                             [47, 48, 49])
            self.assertEqual(store.history("missing")["points"], [])
        finally:
            store.close()

    def test_track_catalogue_is_bounded_and_reports_truncation(self):
        store = ObservationStore(filename=None)
        try:
            for number in range(101):
                store.record(47, 28, f"run-{number}")
            listing = store.tracks()
            self.assertEqual(len(listing["tracks"]), 100)
            self.assertTrue(listing["truncated"])
            self.assertEqual(listing["tracks"][0]["track_id"], "run-100")
        finally:
            store.close()

    def test_catalogues_keep_ingestion_order_and_all_source_runs(self):
        """A clock adjustment does not reorder runs or hide idle sources."""
        store = ObservationStore()
        try:
            source_a = store.enroll("A")
            source_b = store.enroll("B (idle)")
            # Last received point in run-A has an earlier timestamp than run-B.
            # Catalogue order is by row ID, while first/last are clock bounds.
            with patch("observation_store.time.time_ns", side_effect=[
                1_700_000_000_000_000_000,
                1_700_000_002_000_000_000,
                1_699_999_999_000_000_000,
            ]):
                store.record(47, 28, "run-A", source_a)
                store.record(48, 29, "run-B")
                store.record(49, 30, "run-A", source_a)
            catalogue = store.tracks()["tracks"]
            self.assertEqual([run["track_id"] for run in catalogue], ["run-A", "run-B"])
            self.assertEqual([run["count"] for run in catalogue], [2, 1])
            self.assertEqual(catalogue[0]["source_id"], source_a)
            self.assertEqual(catalogue[0]["source_label"], "A")
            self.assertEqual(catalogue[0]["first"], "2023-11-14T22:13:19.000+00:00")
            self.assertEqual(catalogue[0]["last"], "2023-11-14T22:13:20.000+00:00")
            self.assertIsNone(catalogue[1]["source_id"])
            self.assertEqual(store.sources()["sources"], [
                {"source_id": source_a, "label": "A", "runs": 1,
                 "last": "2023-11-14T22:13:20.000+00:00"},
                {"source_id": source_b, "label": "B (idle)", "runs": 0, "last": None},
            ])
        finally:
            store.close()

    def test_default_database_is_in_memory_and_bounded(self):
        store = ObservationStore()
        try:
            for index in range(MAX_RECENT_POINTS + 5):
                store.record(47.0, float(index % 180) - 90.0)
            recent = store.recent()
            self.assertEqual(len(recent), MAX_RECENT_POINTS)
            self.assertEqual(recent[0]["lon"], -85.0)
            self.assertEqual(recent[-1]["lon"], (MAX_RECENT_POINTS + 4) % 180 - 90.0)
        finally:
            store.close()

    def test_file_keeps_all_observations_and_opens_existing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "gps.sqlite3"
            store = ObservationStore(filename)
            try:
                self.assertEqual(stat.S_IMODE(filename.stat().st_mode), 0o600)
                for index in range(MAX_RECENT_POINTS + 5):
                    store.record(47.0, float(index % 180) - 90.0)
                before = store.recent()
                self.assertEqual(len(before), MAX_RECENT_POINTS)
            finally:
                store.close()
            with closing(sqlite3.connect(filename)) as db, db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], MAX_RECENT_POINTS + 5)
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(db.execute("SELECT DISTINCT track_id FROM observations").fetchone(), ("legacy",))
            reopened = ObservationStore(filename)
            try:
                self.assertEqual(reopened.recent(), before)
            finally:
                reopened.close()

    def test_reject_existing_public_file_or_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.sqlite3"
            path.write_bytes(b"")
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private"):
                ObservationStore(path)
            path.chmod(0o600)
            link = Path(directory) / "link.sqlite3"
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "regular private file"):
                ObservationStore(link)
            with self.assertRaisesRegex(ValueError, "filesystem path"):
                ObservationStore(":memory:")

    def test_refuse_unrelated_or_future_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "unrelated.sqlite3"
            with closing(sqlite3.connect(filename)) as db, db:
                db.execute("CREATE TABLE unrelated (id INTEGER)")
            filename.chmod(0o600)
            with self.assertRaisesRegex(ValueError, "no Cartochron schema"):
                ObservationStore(filename)
            filename.unlink()
            store = ObservationStore(filename)
            store.close()
            with closing(sqlite3.connect(filename)) as db, db:
                db.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
            with self.assertRaisesRegex(ValueError, "unsupported database schema"):
                ObservationStore(filename)

    def test_one_connection_supports_concurrent_producers(self):
        store = ObservationStore()
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                values = list(pool.map(lambda _: store.record(47.0, 28.0), range(200)))
            self.assertEqual(len(values), 200)
            self.assertEqual(len(store.recent()), 200)
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
