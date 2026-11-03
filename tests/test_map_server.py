"""HTTP contracts for the map server, without requiring Leaflet or the network."""

import base64
import os
import tempfile
import http.client
import json
import threading
from datetime import datetime
import unittest

import map_server


class MapServerTest(unittest.TestCase):
    def start_server(self, bind="127.0.0.1", **kwargs):
        self.server = map_server.Server((bind, 0), map_server.Handler, **kwargs)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def setUp(self):
        self.start_server()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def position(self, headers=None):
        return self.request("POST", "/api/position", b'{"lat":47.0,"lon":28.0}',
                            {"Content-Type": "application/json", **(headers or {})})

    def test_local_legacy_mode(self):
        status, _, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        status, _, _ = self.position()
        self.assertEqual(status, 201)
        status, _, body = self.request("GET", "/api/points")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["points"]), 1)

    def test_loopback_host_check_tracks_selected_port(self):
        port = self.server.server_port
        self.assertEqual(self.request("GET", "/api/points",
                                      headers={"Host": f"localhost:{port}"})[0], 200)
        self.assertEqual(self.request("GET", "/api/points",
                                      headers={"Host": "outside.example"})[0], 403)

    def test_origin_must_match_host_even_with_custom_port(self):
        port = self.server.server_port
        self.assertEqual(self.position({"Origin": f"http://localhost:{port}",
                                        "Host": f"localhost:{port}"})[0], 201)
        self.assertEqual(self.position({"Origin": "https://other.example"})[0], 403)

    def test_network_bind_accepts_external_host(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.start_server("0.0.0.0")
        headers = {"Host": "map.example.test", "Origin": "https://map.example.test"}
        self.assertEqual(self.position(headers)[0], 201)
        self.assertEqual(self.request("GET", "/api/points", headers=headers)[0], 200)

    def test_basic_auth_protects_map_assets_points_and_ingestion(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        auth = "Basic " + base64.b64encode(b"operator:a-long-password").decode("ascii")
        self.start_server(authorization=auth)
        for path in ("/", "/api/points", "/vendor/leaflet/leaflet.js"):
            status, headers, _ = self.request("GET", path)
            self.assertEqual(status, 401)
            self.assertIn("Basic", headers["WWW-Authenticate"])
        self.assertEqual(self.position()[0], 401)
        self.assertEqual(self.position({"Authorization": "Basic invalid"})[0], 401)
        self.assertEqual(self.position({"Authorization": auth})[0], 201)
        status, _, body = self.request("GET", "/api/points", headers={"Authorization": auth})
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["points"]), 1)
        self.assertEqual(self.request("GET", "/", headers={"Authorization": auth})[0], 200)

    def test_authenticated_proxy_accepts_external_host_and_rejects_foreign_origin(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.start_server(authorization="Basic YTpi")
        headers = {"Authorization": "Basic YTpi", "Host": "map.example.test",
                   "Origin": "https://map.example.test"}
        self.assertEqual(self.position(headers)[0], 201)
        self.assertEqual(self.position({**headers, "Origin": "https://evil.example"})[0], 403)

    def test_private_authorization_file(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = os.path.join(directory, "auth")
            with open(filename, "w", encoding="ascii") as stream:
                stream.write("operator:a-long-password\n")
            os.chmod(filename, 0o600)
            expected = "Basic " + base64.b64encode(b"operator:a-long-password").decode("ascii")
            self.assertEqual(map_server.load_authorization(filename), expected)
            os.chmod(filename, 0o644)
            with self.assertRaisesRegex(ValueError, "private"):
                map_server.load_authorization(filename)
            os.chmod(filename, 0o600)
            with open(filename, "w", encoding="ascii") as stream:
                stream.write("bad-file-with-no-colon\n")
            with self.assertRaisesRegex(ValueError, "user:password"):
                map_server.load_authorization(filename)

    def test_position_response_and_recent_points_contract(self):
        # The browser and existing HTTP producers depend on these exact keys.
        status, _, body = self.position()
        self.assertEqual(status, 201)
        point = json.loads(body)
        self.assertEqual(set(point), {"lat", "lon", "time"})
        self.assertEqual((point["lat"], point["lon"]), (47.0, 28.0))
        self.assertIsNotNone(datetime.fromisoformat(point["time"]).tzinfo)
        status, _, body = self.request("GET", "/api/points")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"points": [point]})

    def test_invalid_coordinates_never_enter_history(self):
        for payload in (
            b'{}', b'{"lat":91,"lon":28}', b'{"lat":47,"lon":181}',
            b'{"lat":true,"lon":28}', b'{"lat":"47","lon":28}',
            b'{"lat":null,"lon":28}', b'[]', b'invalid-json',
        ):
            with self.subTest(payload=payload):
                status, _, _ = self.request("POST", "/api/position", payload,
                                           {"Content-Type": "application/json"})
                self.assertEqual(status, 400)
        status, _, body = self.request("GET", "/api/points")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"points": []})

    def test_ingestion_method_and_content_type_are_checked(self):
        self.assertEqual(self.request("GET", "/api/position")[0], 404)
        self.assertEqual(self.request("POST", "/api/position", b'{}',
                                      {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("GET", "/api/points")[0], 200)

    def test_database_isolation_between_servers(self):
        # A server has its own observation history, not module-level state.
        self.assertEqual(self.position()[0], 201)
        other = map_server.Server(("127.0.0.1", 0), map_server.Handler)
        thread = threading.Thread(target=other.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", other.server_port, timeout=2)
            try:
                connection.request("GET", "/api/points")
                response = connection.getresponse()
                self.assertEqual(json.loads(response.read()), {"points": []})
            finally:
                connection.close()
        finally:
            other.shutdown()
            other.server_close()
            thread.join(timeout=2)

    def test_persistent_observations_survive_server_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = os.path.join(directory, "observations.sqlite3")
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            self.start_server(database=filename)
            self.assertEqual(self.position()[0], 201)
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            self.start_server(database=filename)
            status, _, body = self.request("GET", "/api/points")
            self.assertEqual(status, 200)
            self.assertEqual(len(json.loads(body)["points"]), 1)

    def test_storage_failure_does_not_acknowledge_position(self):
        # A failed write must not be mistaken for an accepted observation.
        self.server.store.close()
        status, _, _ = self.position()
        self.assertEqual(status, 503)
        status, _, _ = self.request("GET", "/api/points")
        self.assertEqual(status, 503)

    def test_invalid_port_is_rejected(self):
        for port in ("0", "65536", "hello"):
            with self.assertRaises(Exception):
                map_server.port_number(port)


if __name__ == "__main__":
    unittest.main()
