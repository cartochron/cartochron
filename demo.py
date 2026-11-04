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
import subprocess
import sys
import tempfile
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


# Named evidence for an interactive, entirely synthetic investigation tour.
# The identifiers have no connection to real devices or actual people.
TOUR_SOURCES = {
    "src_" + "a" * 24: "Example OnePlus (synthetic)",
    "src_" + "b" * 24: "Example LG (synthetic)",
    "src_" + "c" * 24: "Example distant station (synthetic)",
}
TOUR_CHANNELS = {
    "tour.oneplus": "OnePlus · simulated GPSD",
    "tour.lg": "LG · simulated GPSD",
    "tour.vienna": "Vienna station · simulated feed",
    "tour.gpx": "Old GPX-style recording · simulated",
    "tour.archive": "Archive · synthetic long recording",
}
TOUR_RUNS = {
    "demo-oneplus-morning": ("src_" + "a" * 24, "tour.oneplus"),
    "demo-oneplus-evening": ("src_" + "a" * 24, "tour.oneplus"),
    "demo-lg-evening": ("src_" + "b" * 24, "tour.lg"),
    "demo-old-crossing": (None, "tour.gpx"),
    "demo-vienna-station": ("src_" + "c" * 24, "tour.vienna"),
    "demo-archive": (None, "tour.archive"),
    "demo-single-fix": (None, None),
}


def tour_examples(now_ms):
    """Distinct runs, a gap, a stale position and a testable witness pair.

    All positions are invented and all times are derived from one frozen clock.
    Same coordinates or receipt times are *not* simulated contact events.
    """
    minute = 60_000
    hour = 60 * minute
    for i in range(48):
        # Deliberate 22-minute observation gap inside one run.
        t = now_ms - 12 * hour + i * minute + (22 * minute if i >= 20 else 0)
        yield ("demo-oneplus-morning", t,
               50.076 + .00016 * i + .00014 * math.sin(i / 4),
               14.410 + .00027 * i, t - 1200, "gpsd", 10.0)
    for i in range(34):
        # Both channels report near this region within 25 seconds. This is
        # suitable for candidate-pair analysis, not proof of physical meeting.
        t = now_ms - (34 - i) * minute
        lat = 50.082 + .00012 * i
        lon = 14.416 + .00014 * i
        yield ("demo-oneplus-evening", t, lat, lon, t - 1800, "gpsd", 8.0)
        yield ("demo-lg-evening", t + 25_000, lat + .00010, lon - .00011,
               t + 23_000, "gpsd", 16.0)
    for i in range(26):
        # A crossing at a *different* time: spatial similarity != temporal overlap.
        t = now_ms - 9 * hour + i * minute
        yield ("demo-old-crossing", t, 50.0805, 14.409 + .00053 * i,
               None, "imported-synthetic", None)
    for i in range(18):
        # A stale last reported position in a separate city exercises the camera.
        t = now_ms - 3 * hour + i * minute
        yield ("demo-vienna-station", t, 48.207 + .00018 * i,
               16.370 + .00011 * i, None, "simulated", None)
    for i in range(1205):
        t = now_ms - 5 * 24 * hour + i * minute
        yield ("demo-archive", t, 50.072 + .000014 * i + .00015 * math.sin(i / 19),
               14.411 + .00001 * i, None, "imported-synthetic", None)
    yield ("demo-single-fix", now_ms - 2 * 24 * hour,
           50.074, 14.427, None, "simulated", None)


def create_tour(filename, now_ms):
    """Write an isolated annotated investigation fixture; never merge into user data."""
    path = Path(filename)
    if path.exists() or path.is_symlink():
        raise ValueError(f"refusing to overwrite existing file: {path}")
    store = ObservationStore(path)
    store.close()
    try:
        with closing(sqlite3.connect(path)) as db, db:
            db.executemany("INSERT INTO sources(source_id, label) VALUES (?, ?)",
                           TOUR_SOURCES.items())
            db.executemany("INSERT INTO channel_labels(channel_id, label) VALUES (?, ?)",
                           TOUR_CHANNELS.items())
            db.executemany("INSERT INTO runs(track_id, source_id, channel_id) VALUES (?, ?, ?)",
                           ((track, *identity) for track, identity in TOUR_RUNS.items()))
            db.executemany("""INSERT INTO observations
                (track_id, received_ms, lat, lon, measured_ms, provider, accuracy_m)
                VALUES (?, ?, ?, ?, ?, ?, ?)""", tour_examples(now_ms))
            witness_ids = [db.execute("""SELECT id FROM observations WHERE track_id = ?
                ORDER BY received_ms, id LIMIT 1 OFFSET 17""", (track,)).fetchone()[0]
                for track in ("demo-oneplus-evening", "demo-lg-evening")]
        notes = ObservationStore(path)
        try:
            notes.annotate(witness_ids,
                "DEMO HYPOTHESIS: the two reported fixes are close in receipt time and coordinates.\n"
                "ALTERNATIVE: acquisition clocks, error bounds or a delayed feed could explain the pair.\n"
                "NEXT: inspect both run timelines and their missing coverage. This is not an encounter claim.")
        finally:
            notes.close()
    except Exception:
        path.unlink()
        raise
    return path


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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", metavar="FILE", help="new SQLite fixture; never overwrite existing history")
    parser.add_argument("--tour", action="store_true", help="full investigation dataset with provenance and notes")
    parser.add_argument("--serve", action="store_true", help="run a disposable tour on loopback port 8877")
    args = parser.parse_args(argv)
    if args.serve and (args.db or not args.tour):
        parser.error("--serve requires --tour and must not be combined with --db")
    if not args.serve and not args.db:
        parser.error("--db is required unless --serve is selected")
    now_ms = time.time_ns() // 1_000_000
    if args.serve:
        # No persistence in the user's normal database, no external bind or auth.
        with tempfile.TemporaryDirectory(prefix="cartochron-tour-") as directory:
            filename = Path(directory) / "tour.sqlite3"
            create_tour(filename, now_ms)
            print("Synthetic tour: http://127.0.0.1:8877/", flush=True)
            print("Stop with Ctrl-C; the temporary database will be deleted.", flush=True)
            try:
                return subprocess.call([sys.executable, str(Path(__file__).with_name("map_server.py")),
                                        "--bind", "127.0.0.1", "--port", "8877",
                                        "--db", str(filename)])
            except KeyboardInterrupt:
                return 0
    try:
        filename = (create_tour if args.tour else create_demo)(args.db, now_ms)
    except (OSError, sqlite3.Error, ValueError) as exc:
        parser.error(str(exc))
    print(f"Created synthetic observations in {filename}")
    print("Start the server with: python3 map_server.py --db " + str(filename))
    if args.tour:
        print("Tour: compare demo-oneplus-evening with demo-lg-evening; inspect their "
              "witness pair and note. Use demo-oneplus-morning for a gap, "
              "demo-old-crossing for a different-time crossing, and demo-archive for paging.")
    else:
        print("Inspect demo-city-loop for a gap, demo-crossing for a separate run "
              "overlaid in History, demo-long-history for paging, "
              "or demo-single-point for one fix.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
