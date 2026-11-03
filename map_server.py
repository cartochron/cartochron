#!/usr/bin/env python3
"""Small viewer for explicitly submitted GPS observations."""

import argparse
import base64
import hmac
import stat
import json
import math
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from observation_store import ObservationStore

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

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, *, authorization=None, database=None):
        self.store = ObservationStore(database)
        try:
            super().__init__(address, handler)
        except Exception:
            self.store.close()
            raise
        self.loopback_only = address[0] in ("127.0.0.1", "localhost")
        self.authorization = authorization

    def server_close(self):
        super().server_close()
        self.store.close()



class Handler(BaseHTTPRequestHandler):
    server_version = "GPSMapLab/1.0"

    def _reply(self, status, body, content_type, extra_headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in extra_headers:
            self.send_header(name, value)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org data:; connect-src 'self'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, data):
        self._reply(status, json.dumps(data, separators=(",", ":")).encode(), "application/json; charset=utf-8")

    def _authorized(self):
        expected = self.server.authorization
        if expected is None or hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            return True
        body = b'{"error":"authentication required"}'
        self._reply(401, body, "application/json; charset=utf-8",
                    (("WWW-Authenticate", 'Basic realm="GPS Map", charset="UTF-8"'),))
        return False

    def _valid_host(self):
        # Keep the original DNS-rebinding protection for local-only use.
        # On a network listener, the externally visible Host may be a domain
        # or a reverse proxy rather than the bound interface address.
        host = self.headers.get("Host", "")
        if not host:
            return False
        # An authenticated listener may sit behind a TLS reverse proxy, whose
        # public Host is deliberately different from the local bind address.
        if not self.server.loopback_only or self.server.authorization is not None:
            return True
        port = self.server.server_port
        return host in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _valid_origin(self):
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        return origin is None or origin in {f"http://{host}", f"https://{host}"}

    def do_GET(self):
        if not self._valid_host():
            return self._json(403, {"error": "loopback Host required"})
        if not self._authorized():
            return
        path = urlsplit(self.path).path
        if path == "/":
            return self._reply(200, _HTML, "text/html; charset=utf-8")
        if path in _LEAFLET_FILES:
            asset = _ROOT / path.lstrip("/")
            if not asset.is_file():
                return self._json(503, {"error": "Leaflet not installed: run python3 vendor_leaflet.py"})
            return self._reply(200, asset.read_bytes(), _LEAFLET_FILES[path])
        if path == "/api/points":
            try:
                data = self.server.store.recent()
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, {"points": data})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._valid_host() or not self._valid_origin():
            return self._json(403, {"error": "not permitted"})
        if not self._authorized():
            return
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
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return self._json(400, {"error": "expected finite lat (-90..90) and lon (-180..180)"})
        try:
            point = self.server.store.record(lat, lon)
        except sqlite3.Error:
            return self._json(503, {"error": "observation storage unavailable"})
        return self._json(201, point)

    def log_message(self, fmt, *args):
        # Do not log coordinates or request bodies.
        if self.path == "/api/position":
            return
        super().log_message(fmt, *args)


def load_authorization(filename):
    """Read one user:password line without exposing secrets in process arguments."""
    path = Path(filename)
    try:
        if path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise ValueError("auth file must be private (chmod 600)")
        with path.open("rb") as stream:
            contents = stream.read(1025)
    except OSError as exc:
        raise ValueError(f"cannot read auth file: {exc}") from exc
    if len(contents) > 1024:
        raise ValueError("auth file exceeds 1024 bytes")
    raw = contents.rstrip(b"\r\n")
    username, separator, password = raw.partition(b":")
    if not separator or not username or not password or any(c in raw for c in (b"\r", b"\n", b"\x00")):
        raise ValueError("auth file must contain one user:password line")
    try:
        raw.decode("ascii")
    except UnicodeError as exc:
        raise ValueError("auth credentials must be ASCII") from exc
    return "Basic " + base64.b64encode(raw).decode("ascii")


def port_number(value):
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1", metavar="ADDRESS",
                        help="IPv4 listening address (default: 127.0.0.1)")
    parser.add_argument("--port", type=port_number, default=8765,
                        help="TCP listening port (default: 8765)")
    parser.add_argument("--auth-file", metavar="FILE",
                        help="private file containing user:password (HTTP Basic authentication)")
    parser.add_argument("--db", metavar="FILE",
                        help="persist observations in a private SQLite database (default: RAM only)")
    args = parser.parse_args()
    try:
        authorization = load_authorization(args.auth_file) if args.auth_file else None
    except ValueError as exc:
        parser.error(str(exc))
    if not (_ROOT / "vendor/leaflet/leaflet.js").is_file() or not (_ROOT / "vendor/leaflet/leaflet.css").is_file():
        parser.error("Leaflet assets missing; run: python3 vendor_leaflet.py")
    try:
        with Server((args.bind, args.port), Handler, authorization=authorization,
                    database=args.db) as server:
            print(f"GPS map listening on {args.bind}:{args.port}", flush=True)
            if args.db:
                print("Recording observations in SQLite (persistent).", flush=True)
            else:
                print("Observations are held in RAM and erased when this program exits.", flush=True)
            if args.bind not in ("127.0.0.1", "localhost"):
                print("WARNING: HTTP traffic is not encrypted; use HTTPS or a private network.", flush=True)
                if authorization is None:
                    print("WARNING: map and ingestion endpoints are publicly accessible without authentication.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (OSError, sqlite3.Error, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
