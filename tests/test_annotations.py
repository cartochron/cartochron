"""Operator interpretations are separate, exact, bounded and read-only over HTTP."""

import base64
from http.client import HTTPConnection
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from map_server import Handler, Server, parse_annotations_query
from observation_store import ObservationStore, SCHEMA_VERSION


class AnnotationStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "history.sqlite3"
        self.store = ObservationStore(self.path)
        for track in ("first", "second"):
            self.store.record(47.0, 28.0, track)
        self.fixes = [row[0] for row in self.store._db.execute(
            "SELECT id FROM observations ORDER BY id")]

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_single_and_pair_notes_are_exact_and_never_modify_observations(self):
        original = self.store.history("first")["points"]
        single = self.store.annotate((self.fixes[0],), "Question: was this a cached report?")
        pair = self.store.annotate((self.fixes[1], self.fixes[0]),
                                   "Hypothesis: reports arrived close together.")
        self.assertEqual(self.store.history("first")["points"], original)
        one = self.store.annotations((self.fixes[0],))["annotations"]
        self.assertEqual([note["id"] for note in one], [pair, single])
        self.assertEqual(one[0]["fix_ids"], self.fixes)
        self.assertEqual(one[0]["run_ids"], ["first", "second"])
        self.assertEqual([n["id"] for n in self.store.annotations(self.fixes)["annotations"]],
                         [pair])
        self.assertEqual(self.store.annotations((self.fixes[1],))["annotations"][1:], [])
        self.store.close()
        self.store = ObservationStore(self.path)
        self.assertEqual(self.store.annotations(self.fixes)["annotations"][0]["note"],
                         "Hypothesis: reports arrived close together.")

    def test_reject_nonexistent_duplicate_invalid_or_blank_evidence_without_partial_write(self):
        for fixes, note in [((999,), "valid"), ((self.fixes[0], 999), "valid"),
                            ((self.fixes[0], self.fixes[0]), "valid"),
                            ((self.fixes[0],), "  \n "),
                            ((self.fixes[0],), "x" * 2001),
                            ((self.fixes[0],), "control\x00character"),
                            ((True,), "valid"), ((), "valid"),
                            ((self.fixes[0], 2, 3), "valid")]:
            with self.subTest(fixes=fixes, note=note[:20]):
                with self.assertRaises(ValueError):
                    self.store.annotate(fixes, note)
        self.assertEqual(self.store._db.execute("SELECT count(*) FROM annotations").fetchone()[0], 0)

    def test_append_only_evidence_and_paging_not_silent_truncation(self):
        for n in range(4):
            self.store.annotate(self.fixes, f"Review {n}")
        first = self.store.annotations(self.fixes, limit=2)
        self.assertEqual([n["note"] for n in first["annotations"]], ["Review 3", "Review 2"])
        self.assertIsNotNone(first["next_cursor"])
        second = self.store.annotations(self.fixes, limit=2, before=int(first["next_cursor"]))
        self.assertEqual([n["note"] for n in second["annotations"]], ["Review 1", "Review 0"])
        self.assertIsNone(second["next_cursor"])
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store._db:
                self.store._db.execute("DELETE FROM observations WHERE id=?", (self.fixes[0],))
        self.assertEqual(len(self.store.history('first')['points']), 1)

    def test_in_memory_retention_cannot_invalidate_annotation_anchors(self):
        memory = ObservationStore()
        try:
            memory.record(47, 28, 'temporary')
            with self.assertRaisesRegex(ValueError, 'persistent database'):
                memory.annotate((1,), 'Cannot be retained in RAM mode')
        finally:
            memory.close()

    def test_v6_to_v7_migration_keeps_all_original_evidence(self):
        evidence = self.store.history("first")["points"]
        self.store.close()
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TABLE annotations")
            db.execute("PRAGMA user_version = 6")
        self.store = ObservationStore(self.path)
        self.assertEqual(self.store._db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual(self.store.history("first")["points"], evidence)
        self.assertIsInstance(self.store.annotate(self.fixes, "Post-upgrade note"), int)

    def test_cli_accepts_stdin_and_never_creates_a_missing_database(self):
        cmd = [sys.executable, "annotations.py", "--db", str(self.path)]
        created = subprocess.run(cmd + ["add", "--fix", str(self.fixes[0]),
                                        "--note-file", "-"], input="Interpretation ✓\n",
                                 text=True, capture_output=True)
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertEqual(created.stdout.strip(), "1")
        listing = subprocess.run(cmd + ["list", "--fix", str(self.fixes[0])],
                                 text=True, capture_output=True)
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn("Interpretation ✓", listing.stdout)
        absent = Path(self.tmp.name) / "absent.sqlite3"
        missing = subprocess.run([sys.executable, "annotations.py", "--db", str(absent),
                                  "list", "--fix", "1"], text=True, capture_output=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse(absent.exists())


class AnnotationHTTPTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "history.sqlite3"
        self.auth = "Basic " + base64.b64encode(b"analyst:password").decode("ascii")
        self.server = Server(("127.0.0.1", 0), Handler,
                             database=self.path, authorization=self.auth)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.server.store.record(47.0, 28.0, "one")
        self.server.store.record(47.001, 28.001, "two")
        self.server.store.annotate((1, 2), "Potential correlation; not a proven meeting")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def request(self, method, route, *, auth=True, body=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = self.auth
        try:
            conn.request(method, route, body=json.dumps(body).encode() if body is not None else None,
                         headers=headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_read_requires_authentication_and_pair_matches_exact_anchor(self):
        self.assertEqual(self.request('GET', '/api/annotations?fix_id=1&fix_id=2', auth=False)[0], 401)
        status, data = self.request('GET', '/api/annotations?fix_id=2&fix_id=1')
        self.assertEqual(status, 200)
        self.assertEqual(data['annotations'][0]['fix_ids'], [1, 2])
        self.assertIsNone(data['next_cursor'])
        self.assertEqual(self.request('GET', '/api/annotations?fix_id=999')[1]['annotations'], [])
        self.assertEqual(self.request('POST', '/api/annotations', body={
            'fix_id': 1, 'note': 'Attempted HTTP mutation'})[0], 404)
        self.assertEqual(len(self.server.store.annotations((1, 2))['annotations']), 1)

    def test_strict_query_parsing_and_no_unbounded_results(self):
        good = parse_annotations_query('fix_id=1&fix_id=2&limit=1')
        self.assertEqual(good, {'fix_ids': (1, 2), 'limit': 1, 'before': None})
        for query in ('', 'fix_id=0', 'fix_id=1&fix_id=1', 'fix_id=-1',
                      'fix_id=1&fix_id=2&fix_id=3', 'fix_id=1&limit=101',
                      'fix_id=1&before=-2', 'fix_id=1&unknown=x',
                      'fix_id=1&limit=1&limit=2'):
            with self.subTest(query=query):
                self.assertEqual(self.request('GET', '/api/annotations?' + query)[0], 400)


if __name__ == '__main__':
    unittest.main()
