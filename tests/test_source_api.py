"""Source identity is carried by the generic HTTP API, never inferred from hardware."""

import base64
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from map_server import Handler, Server


class SourceHTTPTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "observations.sqlite3"
        self.srv = Server(("127.0.0.1", 0), Handler, database=self.path)
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join(timeout=2)
        self.dir.cleanup()

    def request(self, method, path, data=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.server_port, timeout=3)
        body = json.dumps(data).encode() if data is not None else None
        opts = {"Content-Type": "application/json", **(headers or {})}
        try:
            conn.request(method, path, body=body, headers=opts)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_enrolled_source_is_not_a_run_and_unknown_sources_are_rejected(self):
        sid = self.srv.store.enroll("Research device")
        self.assertEqual(self.request("POST", "/api/position", {
            "track_id": "r1", "source_id": sid, "lat": 47, "lon": 28})[0], 201)
        self.assertEqual(self.request("POST", "/api/position", {
            "track_id": "r2", "source_id": sid, "lat": 48, "lon": 29})[0], 201)
        status, data = self.request("GET", "/api/tracks")
        self.assertEqual(status, 200)
        self.assertEqual({r["track_id"]: r["source_id"] for r in data["tracks"]},
                         {"r1": sid, "r2": sid})
        status, data = self.request("GET", "/api/sources")
        self.assertEqual(status, 200)
        self.assertEqual(data["sources"][0]["label"], "Research device")
        self.assertEqual(data["sources"][0]["runs"], 2)
        self.assertEqual(self.request("POST", "/api/position", {
            "track_id": "r3", "source_id": "src_" + "a" * 24,
            "lat": 47, "lon": 28})[0], 422)

    def test_run_cannot_switch_sources_and_legacy_works(self):
        first, other = self.srv.store.enroll("First"), self.srv.store.enroll("Other")
        for sid, code in ((first, 201), (other, 409), (None, 409)):
            self.assertEqual(self.request("POST", "/api/position", {
                "track_id": "a", "lat": 47, "lon": 28, "source_id": sid})[0], code)
        self.assertEqual(self.request("POST", "/api/position", {
            "lat": 47, "lon": 28})[0], 201)
        self.assertEqual(self.request("POST", "/api/position", {
            "track_id": "a", "lat": 47, "lon": 28, "source_id": "bad"})[0], 400)
        self.assertEqual(self.request("GET", "/api/tracks")[1]["tracks"][1]["source_id"], first)

    def test_source_catalogue_requires_authorization_when_enabled(self):
        self.srv.shutdown(); self.srv.server_close(); self.thread.join(timeout=2)
        auth = "Basic " + base64.b64encode(b"operator:secret").decode("ascii")
        self.srv = Server(("127.0.0.1", 0), Handler, authorization=auth, database=self.path)
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()
        self.assertEqual(self.request("GET", "/api/sources")[0], 401)
        self.assertEqual(self.request("GET", "/api/sources", headers={"Authorization": auth})[0], 200)
        self.assertEqual(self.request("POST", "/api/sources", {"label": "no"},
                                      {"Authorization": auth})[0], 404)


if __name__ == "__main__":
    unittest.main()
