"""Persistent enrollment, legacy migration, and immutable recording-run identity."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest import TestCase
import sqlite3
import tempfile

from observation_store import ObservationStore, SCHEMA_VERSION, SourceConflict, UnknownSource


class SourceStoreTest(TestCase):
    def test_enrollment_survives_restart_and_runs_remain_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.sqlite3"
            store = ObservationStore(path)
            source_id = store.enroll("Authorized test receiver")
            self.assertRegex(source_id, r"\Asrc_[0-9a-f]{24}\Z")
            store.record(47, 28, "run-1", source_id)
            store.close()
            reopened = ObservationStore(path)
            try:
                reopened.record(48, 29, "run-2", source_id)
                self.assertEqual(len(reopened.sources()["sources"]), 1)
                self.assertEqual(reopened.sources()["sources"][0]["runs"], 2)
                self.assertEqual({r["track_id"]: r["source_id"] for r in reopened.tracks()["tracks"]},
                                 {"run-1": source_id, "run-2": source_id})
                self.assertEqual([p["lat"] for p in reopened.history("run-1")["points"]], [47])
                self.assertEqual([p["lat"] for p in reopened.history("run-2")["points"]], [48])
            finally:
                reopened.close()

    def test_run_cannot_change_owner_or_become_anonymous(self):
        store = ObservationStore()
        try:
            first, second = store.enroll("First"), store.enroll("Second")
            store.record(47, 28, "run-1", first)
            for sid in [second, None]:
                with self.assertRaises(SourceConflict):
                    store.record(48, 28, "run-1", sid)
            with self.assertRaises(UnknownSource):
                store.record(47, 28, "unseen", "src_" + "f" * 24)
            store.record(46, 27, "legacy")
            with self.assertRaises(SourceConflict):
                store.record(47, 28, "legacy", first)
            self.assertEqual([p["lat"] for p in store.history("run-1")["points"]], [47])
            self.assertEqual({r["track_id"] for r in store.tracks()["tracks"]}, {"legacy", "run-1"})
        finally:
            store.close()

    def test_migration_preserves_v1_history_as_unassigned_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "v1.sqlite3"
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript("""
                    CREATE TABLE observations (
                        id INTEGER PRIMARY KEY, track_id TEXT NOT NULL,
                        received_ms INTEGER NOT NULL, lat REAL NOT NULL,
                        lon REAL NOT NULL
                    );
                    CREATE INDEX observations_track_time ON observations(track_id, received_ms, id);
                    INSERT INTO observations(track_id, received_ms, lat, lon)
                    VALUES ('legacy', 1700000000000, 47, 28), ('old-run', 1700000000500, 48, 29);
                    PRAGMA user_version = 1;
                """)
            path.chmod(0o600)
            store = ObservationStore(path)
            try:
                self.assertEqual([r["source_id"] for r in store.tracks()["tracks"]], [None, None])
                with self.assertRaises(SourceConflict):
                    store.record(47, 28, "old-run", store.enroll("Research source"))
                store.record(49, 30, "old-run")
                self.assertEqual([p["lat"] for p in store.history("old-run")["points"]], [48, 49])
            finally:
                store.close()
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 3)

    def test_concurrent_writes_to_one_source_are_consistent(self):
        store = ObservationStore()
        try:
            sid = store.enroll("Synthetic test")
            with ThreadPoolExecutor(max_workers=6) as executor:
                list(executor.map(lambda _: store.record(47, 28, "run-a", sid), range(80)))
            self.assertEqual(len(store.history("run-a")["points"]), 80)
            self.assertEqual(store.sources()["sources"][0]["runs"], 1)
        finally:
            store.close()

    def test_invalid_enrollment_labels(self):
        store = ObservationStore()
        try:
            for label in ["", "   ", "A\nB", "x" * 81, 123]:
                with self.subTest(label=label), self.assertRaises(ValueError):
                    store.enroll(label)
        finally:
            store.close()
