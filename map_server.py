#!/usr/bin/env python3
"""Small viewer for explicitly submitted GPS observations."""

import argparse
import base64
import hmac
import stat
import json
import math
import re
import sqlite3
import signal
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from observation_store import (MAX_RECENT_POINTS, ObservationStore, SourceConflict,
                               UnknownSource, valid_channel_id, valid_source_id, valid_track_id)

MAX_BODY = 4096
MAX_WORKERS = 32  # Cap idle or stalled HTTP clients as well as active requests.
_ROOT = Path(__file__).resolve().parent
_HTML = (_ROOT / "index.html").read_bytes()
_VIEWER_JS = (_ROOT / "viewer.js").read_bytes()
_MANUAL = (_ROOT / "manual.html").read_bytes()
_HELP_IMAGES = {
    "/docs/images/tracks.png", "/docs/images/gaps.png",
    "/docs/images/tour-monitor.png", "/docs/images/tour-gaps.png",
    "/docs/images/tour-place.png", "/docs/images/tour-witness.png"
}
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

# A timestamp accepted by the history API must identify a millisecond exactly.
_RFC3339_MS = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
_CURSOR = re.compile(r"(-?[0-9]{1,19}):([1-9][0-9]{0,18})\Z")


def parse_optional_timestamp(params, name):
    value = params.get(name, [None])[0]
    if value is None:
        return None
    if not _RFC3339_MS.fullmatch(value):
        raise ValueError(f"{name} must be an RFC3339 timestamp with millisecond precision")
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        delta = date.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"invalid {name} timestamp") from exc
    return ((delta.days * 86400 + delta.seconds) * 1000
            + delta.microseconds // 1000)


def parse_history_query(query):
    """Validate bounded UTC intervals; reject ambiguous or repeated parameters."""
    if len(query) > 512:
        raise ValueError("query is too long")
    try:
        params = parse_qs(query, keep_blank_values=True, strict_parsing=True,
                          max_num_fields=5)
    except ValueError as exc:
        raise ValueError("invalid query string") from exc
    if set(params) - {"track_id", "from", "to", "limit", "cursor"} or any(
        len(values) != 1 for values in params.values()
    ):
        raise ValueError("unknown or repeated query parameter")
    track_id = params.get("track_id", [None])[0]
    if not valid_track_id(track_id):
        raise ValueError("track_id is required and must be a valid identifier")

    from_ms, to_ms = (parse_optional_timestamp(params, "from"),
                      parse_optional_timestamp(params, "to"))
    if from_ms is not None and to_ms is not None and from_ms >= to_ms:
        raise ValueError("from must precede to")

    raw_limit = params.get("limit", [str(MAX_RECENT_POINTS)])[0]
    if not re.fullmatch(r"[1-9][0-9]{0,3}", raw_limit) or int(raw_limit) > MAX_RECENT_POINTS:
        raise ValueError(f"limit must be between 1 and {MAX_RECENT_POINTS}")
    raw_cursor = params.get("cursor", [None])[0]
    after = None
    if raw_cursor is not None:
        match = _CURSOR.fullmatch(raw_cursor)
        if match is None:
            raise ValueError("invalid cursor")
        after = tuple(int(value) for value in match.groups())
        if any(value > (1 << 63) - 1 or value < -(1 << 63) for value in after):
            raise ValueError("cursor outside SQLite integer range")
    return {"track_id": track_id, "from_ms": from_ms, "to_ms": to_ms,
            "limit": int(raw_limit), "after": after}


def parse_runs_query(query):
    """Exact channel/source filters and a bounded newest-run pagination cursor."""
    if len(query) > 256:
        raise ValueError("query is too long")
    try:
        params = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=4)
    except ValueError as exc:
        raise ValueError("invalid query string") from exc
    if set(params) - {"limit", "before", "channel_id", "source_id"} or any(
            len(values) != 1 for values in params.values()):
        raise ValueError("unknown or repeated query parameter")
    raw_limit = params.get("limit", ["50"])[0]
    raw_before = params.get("before", [None])[0]
    if not re.fullmatch(r"[1-9][0-9]{0,2}", raw_limit) or int(raw_limit) > 100:
        raise ValueError("limit must be between 1 and 100")
    if raw_before is not None and (re.fullmatch(r"[1-9][0-9]{0,18}", raw_before) is None
                                  or int(raw_before) > (1 << 63) - 1):
        raise ValueError("invalid before cursor")
    cid = params.get("channel_id", [None])[0]
    sid = params.get("source_id", [None])[0]
    if cid is not None and not valid_channel_id(cid):
        raise ValueError("invalid channel_id")
    if sid is not None and not valid_source_id(sid):
        raise ValueError("invalid source_id")
    if cid is not None and sid is not None:
        raise ValueError("choose channel_id or source_id")
    return {"limit": int(raw_limit), "before": int(raw_before) if raw_before else None,
            "channel_id": cid, "source_id": sid}


def parse_annotations_query(query):
    """Read-only note lookup by exact evidence IDs, never by inferred location."""
    if len(query) > 160:
        raise ValueError("query is too long")
    try:
        params = parse_qs(query, keep_blank_values=True, strict_parsing=True,
                          max_num_fields=4)
    except ValueError as exc:
        raise ValueError("invalid query string") from exc
    if (set(params) - {"fix_id", "limit", "before"} or
            not 1 <= len(params.get("fix_id", [])) <= 2 or
            any(len(params.get(name, [])) > 1 for name in ("limit", "before"))):
        raise ValueError("supply one or two fix_id values")
    def positive(raw, name, maximum):
        if not re.fullmatch(r"[1-9][0-9]{0,18}", raw) or int(raw) > maximum:
            raise ValueError(f"invalid {name}")
        return int(raw)
    fixes = tuple(positive(raw, "fix_id", (1 << 63) - 1) for raw in params["fix_id"])
    limit = positive(params.get("limit", ["50"])[0], "limit", 100)
    before = params.get("before", [None])[0]
    return {"fix_ids": fixes, "limit": limit,
            "before": positive(before, "before", (1 << 63) - 1) if before is not None else None}


def parse_place_query(query):
    """Parse an exact, bounded place/evidence query on the receipt clock."""
    if len(query) > 512:
        raise ValueError("query is too long")
    try:
        params = parse_qs(query, keep_blank_values=True, strict_parsing=True,
                          max_num_fields=9)
    except ValueError as exc:
        raise ValueError("invalid query string") from exc
    allowed = {"lat", "lon", "radius_m", "limit", "before", "from", "to",
               "channel_id", "source_id"}
    if set(params) - allowed or any(len(values) != 1 for values in params.values()):
        raise ValueError("unknown or repeated place parameter")
    try:
        lat = float(params["lat"][0])
        lon = float(params["lon"][0])
        radius = float(params["radius_m"][0])
    except (KeyError, ValueError, OverflowError) as exc:
        raise ValueError("lat, lon and radius_m are required numbers") from exc
    raw_limit = params.get("limit", ["50"])[0]
    raw_before = params.get("before", [None])[0]
    if (re.fullmatch(r"[1-9][0-9]{0,2}", raw_limit) is None
            or int(raw_limit) > 100):
        raise ValueError("limit must be 1..100")
    if raw_before is not None and (re.fullmatch(r"[1-9][0-9]{0,18}", raw_before) is None
                                  or int(raw_before) > (1 << 63) - 1):
        raise ValueError("invalid before cursor")
    from_ms, to_ms = (parse_optional_timestamp(params, "from"),
                      parse_optional_timestamp(params, "to"))
    if from_ms is not None and to_ms is not None and from_ms >= to_ms:
        raise ValueError("from must precede to")
    cid = params.get("channel_id", [None])[0]
    sid = params.get("source_id", [None])[0]
    if cid is not None and not valid_channel_id(cid):
        raise ValueError("invalid channel_id")
    if sid is not None and not valid_source_id(sid):
        raise ValueError("invalid source_id")
    if cid is not None and sid is not None:
        raise ValueError("choose channel_id or source_id")
    return {"lat": lat, "lon": lon, "radius_m": radius,
            "limit": int(raw_limit), "before": int(raw_before) if raw_before else None,
            "from_ms": from_ms, "to_ms": to_ms, "channel_id": cid,
            "source_id": sid}


def parse_proximity_query(query):
    """Require two runs and bounded, explicit comparison parameters."""
    if len(query) > 512:
        raise ValueError("query is too long")
    try:
        params = parse_qs(query, keep_blank_values=True, strict_parsing=True,
                          max_num_fields=9)
    except ValueError as exc:
        raise ValueError("invalid query string") from exc
    allowed = {"track_id", "other_track_id", "radius_m", "window_s",
               "limit", "before", "from", "to"}
    if set(params) - allowed or any(len(v) != 1 for v in params.values()):
        raise ValueError("unknown or repeated proximity parameter")
    try:
        radius = float(params["radius_m"][0])
        window_s = int(params["window_s"][0])
    except (KeyError, ValueError, OverflowError) as exc:
        raise ValueError("radius_m and window_s are required numbers") from exc
    raw_limit = params.get("limit", ["20"])[0]
    if not re.fullmatch(r"[1-9][0-9]?", raw_limit) or int(raw_limit) > 40:
        raise ValueError("limit must be 1..40")
    raw_before = params.get("before", [None])[0]
    if raw_before is not None:
        match = _CURSOR.fullmatch(raw_before)
        if not match:
            raise ValueError("invalid proximity cursor")
        before = tuple(int(v) for v in match.groups())
    else:
        before = None
    return {"track_id": params.get("track_id", [None])[0],
            "other_track_id": params.get("other_track_id", [None])[0],
            "radius_m": radius, "window_s": window_s, "limit": int(raw_limit),
            "before": before, "from_ms": parse_optional_timestamp(params, "from"),
            "to_ms": parse_optional_timestamp(params, "to")}


class Server(ThreadingHTTPServer):
    # Drain in-flight requests before closing their shared SQLite connection.
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address, handler, *, authorization=None, database=None,
                 max_workers=MAX_WORKERS):
        if type(max_workers) is not int or not 1 <= max_workers <= 256:
            raise ValueError("max_workers must be 1..256")
        self._worker_slots = threading.BoundedSemaphore(max_workers)
        self.store = ObservationStore(database)
        try:
            super().__init__(address, handler)
        except Exception:
            self.store.close()
            raise
        self.loopback_only = address[0] in ("127.0.0.1", "localhost")
        self.authorization = authorization

    def process_request(self, request, client_address):
        # ThreadingHTTPServer otherwise starts a new thread for every accepted
        # socket, including clients stalled before their first HTTP header.
        if not self._worker_slots.acquire(blocking=False):
            try:
                request.settimeout(0.1)  # Never stall the accept loop.
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\n"
                                b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._worker_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._worker_slots.release()

    def server_close(self):
        super().server_close()
        self.store.close()



class Handler(BaseHTTPRequestHandler):
    server_version = "GPSMapLab/1.0"
    timeout = 10  # Do not let an incomplete request occupy a worker indefinitely.

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
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org data:; connect-src 'self'; base-uri 'none'; form-action 'none'")
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
        if path == "/help":
            return self._reply(200, _MANUAL, "text/html; charset=utf-8")
        if path in _HELP_IMAGES:
            return self._reply(200, (_ROOT / path.lstrip("/")).read_bytes(), "image/png")
        if path == "/viewer.js":
            return self._reply(200, _VIEWER_JS, "text/javascript; charset=utf-8")
        if path in _LEAFLET_FILES:
            asset = _ROOT / path.lstrip("/")
            if not asset.is_file():
                return self._json(503, {"error": "Leaflet not installed: run python3 vendor_leaflet.py"})
            return self._reply(200, asset.read_bytes(), _LEAFLET_FILES[path])
        if path == "/api/annotations":
            try:
                data = self.server.store.annotations(
                    **parse_annotations_query(urlsplit(self.path).query))
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/proximity":
            try:
                data = self.server.store.run_proximity(
                    **parse_proximity_query(urlsplit(self.path).query))
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/place/observations":
            try:
                data = self.server.store.place_observations(
                    **parse_place_query(urlsplit(self.path).query))
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/points/recent":
            # Explicit track selection is a separate operation from ascending,
            # cursor-based history queries. Do not confuse recent with page 1.
            query = urlsplit(self.path).query
            try:
                params = parse_qs(query, keep_blank_values=True, strict_parsing=True,
                                  max_num_fields=2)
                if set(params) != {"track_id"} or len(params["track_id"]) != 1:
                    raise ValueError("one track_id is required")
                data = {"points": self.server.store.recent(params["track_id"][0])}
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/points":
            query = urlsplit(self.path).query
            try:
                if query:
                    data = self.server.store.history(**parse_history_query(query))
                else:
                    data = {"points": self.server.store.recent()}
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/sources" and not urlsplit(self.path).query:
            try:
                data = self.server.store.sources()
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/monitor" and not urlsplit(self.path).query:
            try:
                data = self.server.store.monitor()
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/runs":
            try:
                params = parse_runs_query(urlsplit(self.path).query)
                data = self.server.store.runs_page(**params)
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
        if path == "/api/tracks" and not urlsplit(self.path).query:
            try:
                data = self.server.store.tracks()
            except sqlite3.Error:
                return self._json(503, {"error": "observation storage unavailable"})
            return self._json(200, data)
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
            try:
                body = self.rfile.read(size)
            except TimeoutError:
                return self._json(408, {"error": "request body timeout"})
            if len(body) != size:
                return self._json(400, {"error": "incomplete request body"})
            obj = json.loads(body)
            if not isinstance(obj, dict):
                raise ValueError("JSON object expected")
            lat, lon = obj["lat"], obj["lon"]
            track_id = obj.get("track_id", "legacy")
            source_id = obj.get("source_id")
            channel_id = obj.get("channel_id")
            measured_ms = obj.get("measured_ms")
            provider = obj.get("provider")
            accuracy_m = obj.get("accuracy_m")
            if source_id is not None and not valid_source_id(source_id):
                return self._json(400, {"error": "invalid source_id"})
            if channel_id is not None and not valid_channel_id(channel_id):
                return self._json(400, {"error": "invalid channel_id"})
            if not valid_track_id(track_id):
                return self._json(400, {"error": "invalid track_id"})
            if type(lat) not in (int, float) or type(lon) not in (int, float):
                raise ValueError("numeric coordinates required")
            if not math.isfinite(lat) or not math.isfinite(lon) or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                raise ValueError("coordinates out of range")
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return self._json(400, {"error": "expected finite lat (-90..90) and lon (-180..180)"})
        try:
            point = self.server.store.record(lat, lon, track_id, source_id,
                                             measured_ms=measured_ms, provider=provider,
                                             accuracy_m=accuracy_m, channel_id=channel_id)
        except UnknownSource:
            return self._json(422, {"error": "source_id is not enrolled"})
        except SourceConflict:
            return self._json(409, {"error": "recording run source/channel conflict"})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except sqlite3.Error:
            return self._json(503, {"error": "observation storage unavailable"})
        return self._json(201, point)

    def log_message(self, fmt, *args):
        # Do not log coordinates or request bodies.
        if urlsplit(self.path).path in ("/api/position", "/api/points", "/api/points/recent", "/api/tracks", "/api/sources"):
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
            # Docker sends SIGTERM on stop. shutdown() must run on another
            # thread so serve_forever() can return and close SQLite cleanly.
            def stop_server(_signum, _frame):
                threading.Thread(target=server.shutdown, daemon=True).start()

            previous_handler = signal.signal(signal.SIGTERM, stop_server)
            try:
                server.serve_forever()
            finally:
                signal.signal(signal.SIGTERM, previous_handler)
    except KeyboardInterrupt:
        pass
    except (OSError, sqlite3.Error, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
