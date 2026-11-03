#!/usr/bin/env python3
"""Create an isolated, synthetic Cartochron history for manual browser inspection.

This is a fixture, not a GPS producer: it writes known-valid observations
with deliberate historical timestamps directly to a new SQLite database.
No Metasploit session, network connection, or real location is required.
"""

import argparse
from contextlib import closing
import math
import sqlite3
import time
from pathlib import Path

from observation_store import ObservationStore


def examples(now_ms):
    """Yield synthetic tracks with a visible time gap and a lone observation."""
    # A separate run in a distant city makes accidental track joining obvious.
    for i in range(30):
        yield ("demo-river", now_ms - (240 - 3 * i) * 60_000,
               51.505 + 0.00035 * i + 0.0002 * math.sin(i / 4),
               -0.122 + 0.0004 * i)

    # A larger run exercises cursor paging and the browser's Load more control.
    for i in range(1205):
        yield ("demo-long-history", now_ms - (3000 - i) * 60_000,
               48.850 + 0.000025 * i + 0.0012 * math.sin(i / 30),
               2.335 + 0.00003 * i + 0.001 * math.cos(i / 25))

    yield ("demo-single-point", now_ms - 25 * 60_000, 48.2082, 16.3738)

    # An east-west route crosses the city loop geographically, but was
    # recorded at a different time. A crossing is not proof of a meeting.
    for i in range(25):
        yield ("demo-crossing", now_ms - 120 * 60_000 + 4_000 * i,
               50.081, 14.4195 + 0.00042 * i)

    # After sample 34, 21.5 minutes elapse with no observations. The viewer
    # must draw two route segments rather than invent a connecting movement.
    for i in range(75):
        received_ms = now_ms - (75 - i) * 90_000
        if i < 35:
            received_ms -= 20 * 60_000
        yield ("demo-city-loop", received_ms,
               50.075 + 0.00016 * i + 0.0006 * math.sin(i / 5),
               14.414 + 0.00028 * i + 0.0005 * math.cos(i / 7))


def create_demo(filename, now_ms):
    """Write a private SQLite fixture; refuse to overwrite existing history."""
    path = Path(filename)
    if path.exists() or path.is_symlink():
        raise ValueError(f"refusing to overwrite existing file: {path}")
    store = ObservationStore(path)
    store.close()
    try:
        observations = list(examples(now_ms))
        with closing(sqlite3.connect(path)) as db, db:
            # Source labels are unknown, but recording runs are real database
            # entities. Establish them in the same transaction as their fixes.
            runs = sorted({track_id for track_id, *_ in observations})
            db.executemany("INSERT INTO runs(track_id, source_id) VALUES (?, NULL)",
                           ((track_id,) for track_id in runs))
            db.executemany(
                "INSERT INTO observations(track_id, received_ms, lat, lon) VALUES (?, ?, ?, ?)",
                observations,
            )
    except Exception:
        path.unlink()
        raise
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, metavar="FILE",
                        help="new SQLite fixture file; existing files are never overwritten")
    args = parser.parse_args()
    try:
        filename = create_demo(args.db, time.time_ns() // 1_000_000)
    except (OSError, sqlite3.Error, ValueError) as exc:
        parser.error(str(exc))
    print(f"Created synthetic observations in {filename}")
    print("Start the server with: python3 map_server.py --db " + str(filename))
    print("Inspect demo-city-loop for a gap, demo-crossing for a separate run "
          "overlaid in History, demo-long-history for paging, "
          "or demo-single-point for one fix.")


if __name__ == "__main__":
    main()
