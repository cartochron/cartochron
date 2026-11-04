#!/usr/bin/env python3
"""Append evidence-linked operator interpretations without rewriting observations.

This is deliberately a local operator command, not an HTTP write API.
Use --note-file - to read private notes from stdin rather than command history.
"""

import argparse
from pathlib import Path
import sqlite3
import sys

from observation_store import ObservationStore, MAX_ANNOTATION_LENGTH


def read_note(filename):
    """Bound input before decoding; do not silently truncate an interpretation."""
    if filename == "-":
        data = sys.stdin.buffer.read(4 * MAX_ANNOTATION_LENGTH + 2)
    else:
        with open(filename, "rb") as stream:
            data = stream.read(4 * MAX_ANNOTATION_LENGTH + 2)
    if len(data) > 4 * MAX_ANNOTATION_LENGTH + 1:
        raise ValueError("note is too long")
    return data.decode("utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="existing private persistent Cartochron database")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="append a note linked to one fix or an exact pair")
    add.add_argument("--fix", type=int, action="append", required=True,
                     help="existing observation row ID; repeat once for a pair")
    add.add_argument("--note-file", default="-", help="UTF-8 text file, or - for stdin (default)")
    listing = commands.add_parser("list", help="read notes linked to one fix or exact pair")
    listing.add_argument("--fix", type=int, action="append", required=True)
    listing.add_argument("--before", type=int)
    args = parser.parse_args(argv)
    try:
        if not Path(args.db).is_file():
            raise ValueError("database must already exist; refusing to create a new history")
        # Validate fix IDs without changing the database or consuming note input.
        ObservationStore._annotation_fixes(args.fix)
        note = read_note(args.note_file) if args.command == "add" else None
        store = ObservationStore(args.db)
        try:
            if args.command == "add":
                print(store.annotate(args.fix, note))
            else:
                result = store.annotations(args.fix, before=args.before)
                for item in result["annotations"]:
                    anchors = ",".join(map(str, item["fix_ids"]))
                    print(f"{item['id']}\t{item['created']}\tfix={anchors}\t{item['note']}")
                if result["next_cursor"]:
                    print(f"More notes: --before {result['next_cursor']}", file=sys.stderr)
        finally:
            store.close()
    except (ValueError, OSError, UnicodeError, sqlite3.Error) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
