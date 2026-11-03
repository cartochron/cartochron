"""HTTP contracts for the map server, without requiring Leaflet or the network."""

import base64
import http.client
import json
import threading
import unittest

import map_server


class MapServerTest(unittest.TestCase):
    def start_server(self, bind="127.0.0.1", **kwargs):
        self.server = map_server.Server((bind, 0), map_server.Handler, **kwargs)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        with map_server._lock:
            map_server._points.clear()

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

    def test_invalid_port_is_rejected(self):
        for port in ("0", "65536", "hello"):
            with self.assertRaises(Exception):
                map_server.port_number(port)


if __name__ == "__main__":
    unittest.main()
