#!/usr/bin/env python3
"""Replay synthetic database fixes through a local Cartochron HTTP server.

A manual live-view test: the existing demo database supplies GPS coordinates,
but the receiver assigns fresh receipt timestamps through its real POST API.
For safety, only an unauthenticated loopback HTTP endpoint is accepted.
"""

import argparse
from contextlib import closing
import json
import sqlite3
import time
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


def validate_endpoint(value):
    url = urlsplit(value)
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.path != "/api/position" or url.username is not None
            or url.password is not None or url.query or url.fragment):
        raise ValueError("replay endpoint must be a loopback HTTP /api/position URL")
    try:
        if url.port is None:
            raise ValueError("explicit server port required")
    except ValueError as exc:
        raise ValueError("invalid replay endpoint port") from exc
    return value


def source_points(filename, track, count):
    path = Path(filename).resolve()
    # mode=ro ensures that replay never creates or modifies the demo fixture.
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        return db.execute(
            "SELECT lat, lon FROM observations WHERE track_id=? "
            "ORDER BY received_ms, id LIMIT ?", (track, count)
        ).fetchall()


def replay(filename, source_track, destination_track, endpoint, count=25, interval=0.5,
           sleep=time.sleep):
    validate_endpoint(endpoint)
    if not 1 <= count <= 1000 or not 0 <= interval <= 60:
        raise ValueError("count must be 1..1000 and interval 0..60 seconds")
    fixes = source_points(filename, source_track, count)
    if not fixes:
        raise ValueError(f"no synthetic observations for {source_track!r}")
    for index, (lat, lon) in enumerate(fixes, 1):
        request = Request(endpoint, method="POST",
                          data=json.dumps({"track_id": destination_track,
                                           "lat": lat, "lon": lon}).encode(),
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            if response.status != 201:
                raise RuntimeError(f"receiver returned HTTP {response.status}")
            response.read()
        print(f"Sent synthetic observation {index}/{len(fixes)}", flush=True)
        if index < len(fixes):
            sleep(interval)
    return len(fixes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="existing synthetic database from demo.py")
    parser.add_argument("--track", default="demo-city-loop", help="source recording run")
    parser.add_argument("--as-track", default="demo-replay", help="destination recording run")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8765/api/position")
    parser.add_argument("--count", type=int, default=25)
    parser.add_argument("--interval", type=float, default=0.5, help="seconds between POSTs")
    args = parser.parse_args()
    try:
        replay(args.db, args.track, args.as_track, args.endpoint, args.count, args.interval)
    except (OSError, ValueError, sqlite3.Error, RuntimeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
