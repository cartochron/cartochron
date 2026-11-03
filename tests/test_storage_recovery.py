"""Persistent history must remain consistent after failed writes and backups."""

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from observation_store import ObservationStore


class StorageRecoveryTest(unittest.TestCase):
    def test_failed_observation_does_not_leave_a_run_or_partial_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.sqlite3"
            store = ObservationStore(path)
            try:
                store.record(47, 28, "before")
                # Force a real SQLite constraint failure after record() has
                # inserted the new run but before its observation is inserted.
                with store._db:
                    store._db.executescript("""
                        CREATE TRIGGER reject_test_fix BEFORE INSERT ON observations
                        WHEN NEW.track_id = 'failed'
                        BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;
                    """)
                with self.assertRaisesRegex(sqlite3.IntegrityError, "simulated storage failure"):
                    store.record(48, 29, "failed")
                self.assertEqual(store._db.execute(
                    "SELECT COUNT(*) FROM runs WHERE track_id = 'failed'").fetchone()[0], 0)
            finally:
                store.close()

            reopened = ObservationStore(path)
            try:
                self.assertEqual([run["track_id"] for run in reopened.tracks()["tracks"]],
                                 ["before"])
                self.assertEqual(len(reopened.history("before")["points"]), 1)
                self.assertEqual(reopened.history("failed")["points"], [])
            finally:
                reopened.close()

    def test_private_online_sqlite_backup_restores_source_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "history.sqlite3"
            backup = Path(directory) / "backup.sqlite3"
            store = ObservationStore(original)
            try:
                sid = store.enroll("Research source")
                store.record(47, 28, "run-1", sid, measured_ms=1700000000000,
                             provider="network", accuracy_m=25)
                # An online SQLite backup is a consistent snapshot. Create its
                # destination privately, before writing location history.
                fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                with closing(sqlite3.connect(original)) as reader, \
                        closing(sqlite3.connect(backup)) as destination:
                    reader.backup(destination)
                store.record(48, 29, "run-2", sid)
            finally:
                store.close()

            restored = ObservationStore(backup)
            try:
                self.assertEqual(restored.sources()["sources"][0]["runs"], 1)
                tracks = restored.tracks()["tracks"]
                self.assertEqual([run["track_id"] for run in tracks], ["run-1"])
                self.assertEqual(tracks[0]["source_id"], sid)
                fix = restored.history("run-1")["points"][0]
                self.assertEqual((fix["lat"], fix["lon"]), (47, 28))
                self.assertEqual(fix["provider"], "network")
                self.assertEqual(fix["accuracy_m"], 25)
                self.assertEqual(fix["measured_time"], "2023-11-14T22:13:20.000+00:00")
                self.assertEqual(restored._db.execute("PRAGMA quick_check").fetchone()[0], "ok")
            finally:
                restored.close()


if __name__ == "__main__":
    unittest.main()
