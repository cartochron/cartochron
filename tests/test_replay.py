"""Synthetic live replay exercises real HTTP ingestion without Android or MSF."""

import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError

from demo import create_demo
from map_server import Handler, Server
from replay import replay, validate_endpoint


class ReplayTest(unittest.TestCase):
    def test_only_explicit_loopback_http_ingestion_is_allowed(self):
        for url in ("https://example.com/api/position",
                    "http://map.example/api/position",
                    "http://127.0.0.1:8765/",
                    "http://user:secret@127.0.0.1:8765/api/position",
                    "http://localhost:8765/api/position?track_id=x"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_endpoint(url)
        self.assertEqual(validate_endpoint("http://127.0.0.1:8765/api/position"),
                         "http://127.0.0.1:8765/api/position")

    def test_replay_posts_into_a_different_track_through_real_http(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "demo.sqlite3"
            create_demo(fixture, 1_800_000_000_000)
            server = Server(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                endpoint = f"http://127.0.0.1:{server.server_port}/api/position"
                sent = replay(fixture, "demo-city-loop", "demo-replay", endpoint,
                              count=4, interval=0, sleep=lambda _time: None)
                self.assertEqual(sent, 4)
                observed = server.store.recent("demo-replay")
                self.assertEqual(len(observed), 4)
                self.assertEqual(observed[0]["lat"], 50.075)
                self.assertEqual(observed[0]["lon"], 14.4145)
                self.assertFalse(server.store.recent("demo-city-loop"))
                self.assertEqual(server.store.tracks()["tracks"][0]["track_id"], "demo-replay")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_invalid_track_never_posts(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "demo.sqlite3"
            create_demo(fixture, 1_800_000_000_000)
            with self.assertRaisesRegex(ValueError, "no synthetic observations"):
                replay(fixture, "missing", "replay", "http://127.0.0.1:8765/api/position")

    def test_replay_does_not_bypass_receiver_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "demo.sqlite3"
            create_demo(fixture, 1_800_000_000_000)
            server = Server(("127.0.0.1", 0), Handler, authorization="Basic YTpi")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                endpoint = f"http://127.0.0.1:{server.server_port}/api/position"
                with self.assertRaises(HTTPError) as caught:
                    replay(fixture, "demo-city-loop", "demo-replay", endpoint,
                           count=1, interval=0)
                self.assertEqual(caught.exception.code, 401)
                self.assertFalse(server.store.recent("demo-replay"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
