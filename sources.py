#!/usr/bin/env python3
"""Enroll an authorized observation source in a persistent Cartochron database.

Enrollment is deliberately an operator-side operation, not a public HTTP API.
The source ID identifies a configured producer; it is not an access token.
"""

import argparse
import sqlite3
from observation_store import ObservationStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, metavar="FILE",
                        help="private persistent Cartochron SQLite database")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="enroll a source and print its identifier")
    add.add_argument("label", help="human-readable label (1-80 characters)")
    commands.add_parser("list", help="list enrolled sources")
    rename = commands.add_parser("rename", help="update a source display name")
    rename.add_argument("source_id")
    rename.add_argument("label")
    args = parser.parse_args()
    try:
        store = ObservationStore(args.db)
        try:
            if args.command == "add":
                print(store.enroll(args.label))
            elif args.command == "rename":
                store.rename_source(args.source_id, args.label)
            else:
                for source in store.sources()["sources"]:
                    print(f"{source['source_id']}\t{source['label']}")
        finally:
            store.close()
    except (ValueError, OSError, sqlite3.Error) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
