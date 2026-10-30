#!/usr/bin/env python3
"""Small, localhost-only viewer for explicitly submitted GPS observations."""

import argparse
import json
import math
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_POINTS = 1000
MAX_BODY = 4096
_ROOT = Path(__file__).resolve().parent
_HTML = (_ROOT / "index.html").read_bytes()
_LEAFLET_FILES = {
    "/vendor/leaflet/leaflet.css": "text/css; charset=utf-8",
    "/vendor/leaflet/leaflet.js": "text/javascript; charset=utf-8",
    **{
        "/vendor/leaflet/images/" + name: "image/png"
        for name in (
            "layers.png", "layers-2x.png", "marker-icon.png",
            "marker-icon-2x.png", "marker-shadow.png",
        )
    },
}

_points = []
_lock = threading.Lock()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "GPSMapLab/1.0"

    def _reply(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org data:; connect-src 'self'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, data):
        self._reply(status, json.dumps(data, separators=(",", ":")).encode(), "application/json; charset=utf-8")

    def _valid_host(self):
        # Prevent virtual-host and DNS rebinding requests. Browser clients use
        # a numeric loopback hostname; curl may use localhost.
        host = self.headers.get("Host", "")
        return host in {"127.0.0.1:8765", "localhost:8765"}

    def _valid_origin(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in {"http://127.0.0.1:8765", "http://localhost:8765"}

    def do_GET(self):
        if not self._valid_host():
            return self._json(403, {"error": "loopback Host required"})
        path = urlsplit(self.path).path
        if path == "/":
            return self._reply(200, _HTML, "text/html; charset=utf-8")
        if path in _LEAFLET_FILES:
            asset = _ROOT / path.lstrip("/")
            if not asset.is_file():
                return self._json(503, {"error": "Leaflet not installed: run python3 vendor_leaflet.py"})
            return self._reply(200, asset.read_bytes(), _LEAFLET_FILES[path])
        if path == "/api/points":
            with _lock:
                data = list(_points)
            return self._json(200, {"points": data})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._valid_host() or not self._valid_origin():
            return self._json(403, {"error": "not permitted"})
        if self.path != "/api/position":
            return self._json(404, {"error": "not found"})
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            return self._json(415, {"error": "JSON required"})
        try:
            size = int(self.headers.get("Content-Length", ""))
            if size < 1 or size > MAX_BODY:
                return self._json(413, {"error": "invalid body size"})
            obj = json.loads(self.rfile.read(size))
            if not isinstance(obj, dict):
                raise ValueError("JSON object expected")
            lat, lon = obj["lat"], obj["lon"]
            if type(lat) not in (int, float) or type(lon) not in (int, float):
                raise ValueError("numeric coordinates required")
            if not math.isfinite(lat) or not math.isfinite(lon) or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                raise ValueError("coordinates out of range")
            point = {
                "lat": lat, "lon": lon,
                "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return self._json(400, {"error": "expected finite lat (-90..90) and lon (-180..180)"})
        with _lock:
            _points.append(point)
            del _points[:-MAX_POINTS]
        return self._json(201, point)

    def log_message(self, fmt, *args):
        # Do not log coordinates or request bodies.
        if self.path == "/api/position":
            return
        super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    if not (_ROOT / "vendor/leaflet/leaflet.js").is_file() or not (_ROOT / "vendor/leaflet/leaflet.css").is_file():
        parser.error("Leaflet assets missing; run: python3 vendor_leaflet.py")
    print("Local GPS map: http://127.0.0.1:8765", flush=True)
    print("Observations are held in RAM and erased when this program exits.", flush=True)
    try:
        Server(("127.0.0.1", 8765), Handler).serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
