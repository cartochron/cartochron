"""The demo database is disposable, deterministic, and useful to inspect visually."""

import sqlite3
from contextlib import closing
import stat
import tempfile
import unittest
from pathlib import Path

from demo import create_demo
from observation_store import ObservationStore


class DemoTest(unittest.TestCase):
    def test_fixture_is_private_and_contains_independent_routes_and_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "demo.sqlite3"
            create_demo(path, 1_800_000_000_000)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            store = ObservationStore(path)
            try:
                tracks = store.tracks()["tracks"]
                self.assertEqual([t["track_id"] for t in tracks],
                                 ["demo-city-loop", "demo-single-point", "demo-long-history", "demo-river"])
                self.assertEqual([t["count"] for t in tracks], [75, 1, 1205, 30])
                history = store.history("demo-city-loop")["points"]
                self.assertEqual(len(history), 75)
                self.assertEqual(len([1 for a, b in zip(history, history[1:])
                                      if b["received_ms"] - a["received_ms"] > 600_000]), 1)
                self.assertEqual(len(store.history("demo-single-point")["points"]), 1)
                first_page = store.history("demo-long-history")
                self.assertEqual(len(first_page["points"]), 1000)
                self.assertTrue(first_page["truncated"])
                after = tuple(map(int, first_page["next_cursor"].split(":")))
                last_page = store.history("demo-long-history", after=after)
                self.assertEqual(len(last_page["points"]), 205)
                self.assertFalse(last_page["truncated"])
            finally:
                store.close()
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                create_demo(path, 1_800_000_000_000)
            # A refused second run must not modify the existing database.
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1311)


if __name__ == "__main__":
    unittest.main()
