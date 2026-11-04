#!/usr/bin/env python3
"""Operator-only channel display names; never changes recorded provenance."""

import argparse
import sqlite3
from observation_store import ObservationStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="private Cartochron SQLite database")
    parser.add_argument("channel_id", help="existing, observed acquisition channel")
    parser.add_argument("label", help="human-readable display name (1–80 characters)")
    args = parser.parse_args()
    try:
        store = ObservationStore(args.db)
        try:
            store.label_channel(args.channel_id, args.label)
        finally:
            store.close()
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
