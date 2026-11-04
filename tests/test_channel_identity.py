"""Channel identity belongs to a recording run, not to a GPS measurement.

Missing channel metadata is not a reason to infer it from the run ID.
"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from http.client import HTTPConnection

from map_server import Handler, Server
from observation_store import ObservationStore, SCHEMA_VERSION, SourceConflict


class ChannelStoreTest(unittest.TestCase):
    def test_channel_survives_new_runs_and_cannot_change_inside_a_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.sqlite3"
            store = ObservationStore(path)
            try:
                store.record(47, 28, "oneplus-1", channel_id="lab.oneplus")
                store.record(48, 28, "oneplus-2", channel_id="lab.oneplus")
                store.record(49, 28, "lg-1", channel_id="lab.lg")
                store.record(50, 28, "older")
                with self.assertRaises(SourceConflict):
                    store.record(51, 28, "oneplus-1", channel_id="lab.lg")
                with self.assertRaises(SourceConflict):
                    store.record(51, 28, "oneplus-1")
                with self.assertRaises(SourceConflict):
                    store.record(51, 28, "older", channel_id="lab.oneplus")
                self.assertEqual([point["lat"] for point in store.history("oneplus-1")["points"]], [47])
            finally:
                store.close()
            reopened = ObservationStore(path)
            try:
                tracks = {row["track_id"]: row for row in reopened.tracks()["tracks"]}
                self.assertEqual(tracks["oneplus-1"]["channel_id"], "lab.oneplus")
                self.assertEqual(tracks["oneplus-2"]["channel_id"], "lab.oneplus")
                self.assertEqual(tracks["lg-1"]["channel_id"], "lab.lg")
                self.assertIsNone(tracks["older"]["channel_id"])
                self.assertEqual(tracks["oneplus-1"]["count"], 1)
            finally:
                reopened.close()

    def test_invalid_channel_is_rejected_without_creating_run(self):
        store = ObservationStore()
        try:
            for value in ("", "../x", "space name", "x" * 65, True, 5, [], "é"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    store.record(47, 28, "should-not-exist", channel_id=value)
            self.assertEqual(store.tracks()["tracks"], [])
        finally:
            store.close()

    def test_v3_database_migrates_without_guessing_old_channels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "v3.sqlite3"
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript("""
                    CREATE TABLE sources (source_id TEXT PRIMARY KEY, label TEXT NOT NULL);
                    CREATE TABLE runs (track_id TEXT PRIMARY KEY,
                        source_id TEXT REFERENCES sources(source_id));
                    CREATE TABLE observations (
                        id INTEGER PRIMARY KEY, track_id TEXT NOT NULL,
                        received_ms INTEGER NOT NULL, lat REAL NOT NULL,
                        lon REAL NOT NULL, measured_ms INTEGER,
                        provider TEXT, accuracy_m REAL);
                    CREATE INDEX observations_track_time
                        ON observations(track_id, received_ms, id);
                    INSERT INTO runs VALUES ('oneplus-deadbeef', NULL);
                    INSERT INTO observations(track_id,received_ms,lat,lon,measured_ms,provider,accuracy_m)
                        VALUES ('oneplus-deadbeef',1700000000000,47,28,1699999999999,'gpsd',7.5);
                    PRAGMA user_version = 3;
                """)
            path.chmod(0o600)
            store = ObservationStore(path)
            try:
                old = store.tracks()["tracks"][0]
                self.assertIsNone(old["channel_id"])
                self.assertEqual(store.history(old["track_id"])["points"][0]["provider"], "gpsd")
                store.record(48, 29, "new-run", channel_id="lab.oneplus")
                with self.assertRaises(SourceConflict):
                    store.record(47, 28, old["track_id"], channel_id="lab.oneplus")
            finally:
                store.close()
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(db.execute("SELECT channel_id FROM runs WHERE track_id='oneplus-deadbeef'").fetchone()[0], None)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 2)


class ChannelHttpTest(unittest.TestCase):
    def test_channel_is_visible_on_run_catalogue_and_conflicts_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            server = Server(("127.0.0.1", 0), Handler,
                            database=Path(directory) / "history.sqlite3")
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def request(method, url, payload=None):
                conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                try:
                    body = json.dumps(payload).encode() if payload is not None else None
                    conn.request(method, url, body=body, headers={"Content-Type": "application/json"})
                    resp = conn.getresponse()
                    return resp.status, json.loads(resp.read())
                finally:
                    conn.close()
            try:
                payload = {"lat": 47, "lon": 28, "track_id": "oneplus-1",
                           "channel_id": "lab.oneplus"}
                code, acknowledged = request("POST", "/api/position", payload)
                self.assertEqual(code, 201)
                self.assertEqual(acknowledged["channel_id"], "lab.oneplus")
                self.assertEqual(request("POST", "/api/position", payload)[0], 201)
                code, listing = request("GET", "/api/tracks")
                self.assertEqual(code, 200)
                self.assertEqual(listing["tracks"][0]["channel_id"], "lab.oneplus")
                self.assertEqual(listing["tracks"][0]["count"], 2)
                for changed in (None, "lab.lg"):
                    bad = {"lat": 49, "lon": 30, "track_id": "oneplus-1"}
                    if changed is not None:
                        bad["channel_id"] = changed
                    self.assertEqual(request("POST", "/api/position", bad)[0], 409)
                for bad_channel in ("", "bad channel", 7, True):
                    bad = {"lat": 49, "lon": 30, "track_id": "bad-run", "channel_id": bad_channel}
                    self.assertEqual(request("POST", "/api/position", bad)[0], 400)
                self.assertEqual(request("GET", "/api/tracks")[1]["tracks"][0]["count"], 2)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
