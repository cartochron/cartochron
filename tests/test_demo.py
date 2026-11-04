"""The demo database is disposable, deterministic, and useful to inspect visually."""

import sqlite3
from contextlib import closing
import stat
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from demo import create_demo, create_tour, main as demo_main
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
                                 ["demo-city-loop", "demo-crossing", "demo-single-point", "demo-long-history", "demo-river"])
                self.assertEqual([t["count"] for t in tracks], [75, 25, 1, 1205, 30])
                history = store.history("demo-city-loop")["points"]
                self.assertEqual(len(history), 75)
                self.assertEqual(len([1 for a, b in zip(history, history[1:])
                                      if b["received_ms"] - a["received_ms"] > 600_000]), 1)
                self.assertEqual(len(store.history("demo-single-point")["points"]), 1)
                crossing = store.history("demo-crossing")["points"]
                self.assertEqual(len(crossing), 25)
                self.assertTrue(crossing[0]["lon"] < 14.424 < crossing[-1]["lon"])
                # The synthetic paths actually intersect: the city loop
                # crosses the overlay's latitude within its longitude span.
                self.assertTrue(any(
                    (a["lat"] - crossing[0]["lat"]) *
                    (b["lat"] - crossing[0]["lat"]) <= 0 and
                    crossing[0]["lon"] <= a["lon"] <= crossing[-1]["lon"]
                    for a, b in zip(history, history[1:])
                ))
                # The spatial crossing is intentionally offset in time.
                self.assertGreater(history[35]["received_ms"] - crossing[12]["received_ms"],
                                   50 * 60_000)
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
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1336)
                # Every observed run must have an explicit ownership record,
                # even when its source is deliberately unknown.
                self.assertEqual(db.execute("""
                    SELECT COUNT(*) FROM observations o
                    LEFT JOIN runs r ON r.track_id = o.track_id
                    WHERE r.track_id IS NULL
                """).fetchone()[0], 0)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 5)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM runs WHERE source_id IS NOT NULL").fetchone()[0], 0)


    def test_bad_fixture_rolls_back_and_leaves_no_partial_database(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.sqlite3"
            fake_fixes = [("good-run", 1700000000000, 47, 28),
                          ("bad-run", 1700000000100, 999, 28)]
            with patch("demo.examples", return_value=iter(fake_fixes)):
                with self.assertRaises(sqlite3.IntegrityError):
                    create_demo(path, 1700000000000)
            self.assertFalse(path.exists())


    def test_investigation_tour_has_reproducible_evidence_not_claimed_encounters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tour.sqlite3"
            create_tour(path, 1_800_000_000_000)
            store = ObservationStore(path)
            try:
                runs = store.tracks()["tracks"]
                self.assertEqual(len(runs), 7)
                self.assertEqual(len(store.history("demo-oneplus-morning")["points"]), 48)
                morning = store.history("demo-oneplus-morning")["points"]
                self.assertEqual(sum(b["received_ms"] - a["received_ms"] > 600_000
                                     for a, b in zip(morning, morning[1:])), 1)
                # Multiple runs of one source must not be fused together.
                self.assertEqual(next(r for r in runs if r["track_id"] == "demo-oneplus-evening")["channel_id"],
                                 next(r for r in runs if r["track_id"] == "demo-oneplus-morning")["channel_id"])
                self.assertEqual(store.history("demo-archive")["truncated"], True)
                pairs = store.run_proximity("demo-oneplus-evening", "demo-lg-evening", 100, 60)["pairs"]
                self.assertTrue(pairs)
                self.assertLess(pairs[0]["receipt_delta_ms"], 60_000)
                notes = store.annotations([pairs[-1]["a"]["id"], pairs[-1]["b"]["id"]])
                # The note is attached to the midpoint witness, not every pair.
                self.assertEqual(len(notes["annotations"]), 0)
                with closing(sqlite3.connect(path)) as db:
                    refs = db.execute("SELECT fix_a, fix_b FROM annotations").fetchone()
                saved = store.annotations(list(refs))["annotations"]
                self.assertEqual(len(saved), 1)
                self.assertIn("DEMO HYPOTHESIS", saved[0]["note"])
                self.assertIn("ALTERNATIVE", saved[0]["note"])
                overview = store.monitor()["entries"]
                self.assertEqual(len([m for m in overview if m["channel_id"] == "tour.oneplus"]), 1)
            finally:
                store.close()
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                create_tour(path, 1_800_000_000_000)

    def test_disposable_tour_runs_on_loopback_and_deletes_its_history(self):
        observed = []
        def fake_server(args):
            self.assertEqual(args[2:6], ["--bind", "127.0.0.1", "--port", "8877"])
            self.assertEqual(args[-2], "--db")
            path = Path(args[-1])
            self.assertTrue(path.is_file())
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1366)
            observed.append(path)
            return 0
        with patch("demo.subprocess.call", side_effect=fake_server):
            self.assertEqual(demo_main(["--tour", "--serve"]), 0)
        self.assertFalse(observed[0].exists(), "temporary history must be deleted on exit")

    def test_tour_serve_is_isolated_from_a_user_supplied_database(self):
        with self.assertRaises(SystemExit):
            demo_main(["--serve", "--tour", "--db", "/tmp/existing.sqlite3"])



if __name__ == "__main__":
    unittest.main()
