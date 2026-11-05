"""HTTP logs must not disclose location, evidence or untrusted request URLs."""

import unittest
from http.server import BaseHTTPRequestHandler
from unittest.mock import patch

from map_server import Handler


class RequestLoggingTests(unittest.TestCase):
    def check_log(self, path, expected):
        handler = Handler.__new__(Handler)
        handler.path = path
        handler.command = "GET"
        with patch.object(BaseHTTPRequestHandler, "log_message", autospec=True) as log:
            Handler.log_message(handler, '"%s" %s %s',
                                f"GET {path} HTTP/1.1", "200", "42")
        if expected is None:
            log.assert_not_called()
        else:
            log.assert_called_once_with(handler, '"%s %s" %s %s',
                                        "GET", expected, "200", "42")

    def test_api_queries_and_unknown_paths_are_private(self):
        for path in (
            "/api/position", "/api/runs?channel_id=private",
            "/api/monitor", "/api/place/observations?lat=47.0&lon=28.0",
            "/api/proximity?track_id=private", "/api/annotations?fix_id=17",
            "/unknown?token=secret", "/?token=secret",
            "/viewer.js?token=secret", "/%2f?token=secret",
        ):
            with self.subTest(path=path):
                self.check_log(path, None)

    def test_static_access_is_sanitized(self):
        for path in ("/", "/help", "/viewer.js", "/vendor/leaflet/leaflet.js"):
            with self.subTest(path=path):
                self.check_log(path, path)

    def test_non_access_errors_and_missing_path_are_not_logged(self):
        handler = Handler.__new__(Handler)
        with patch.object(BaseHTTPRequestHandler, "log_message", autospec=True) as log:
            Handler.log_message(handler, "Bad request syntax (%r)", "secret")
            handler.path = "/"
            Handler.log_message(handler, "Bad request syntax (%r)", "secret")
        log.assert_not_called()


if __name__ == "__main__":
    unittest.main()
