# Cartochron

Cartochron records and displays location observations for authorized security
research. The Python receiver accepts observations over HTTP and stores them
in SQLite; an optional Metasploit Android adapter supplies reported positions.
The Leaflet viewer lets you follow individual recording runs, inspect history,
compare runs, and see where observation gaps or possible positioning jumps
make movement uncertain.

**Cartochron records observations, not verified movements.** Android
Meterpreter `geolocate` returns a last-known network-provider location; its
measurement time and accuracy are unknown. The receiver records when an
observation arrived, not when it was originally measured. Observations from
different recording runs are not joined.

## Quick start: local receiver

Requires Python 3. Download and verify the pinned Leaflet assets once:

```sh
make
python3 map_server.py
```

Open <http://127.0.0.1:8765/>. This default setup uses an in-memory SQLite
database and needs no credentials on loopback. **History is lost on server
exit.** For a persistent recording, create a private data directory and start
with `--db`:

```sh
install -d -m 700 "$HOME/.local/share/cartochron"
python3 map_server.py --db "$HOME/.local/share/cartochron/observations.sqlite3"
```

The optional [Cartochron Metasploit adapter](https://github.com/cartochron/cartochron-metasploit)
is a **separate repository**, with its own `make install` and Ruby tests.
The [recording guide](docs/recording.md) explains background jobs, source
identity, and framework logging. The Metasploit operator submits observations
to the receiver; the Android session does not contact the receiver directly.

## Docker Compose: persistent, authenticated receiver

Docker Compose is optional. It provides a single Python container with a
host-mounted SQLite database and Basic authentication, exposed only on the
host's loopback address. Follow the [first-start instructions](docs/operations.md#first-start)
to create `data/auth` and `.env`, then run:

```sh
docker compose up -d --build
```

**Compose credentials must be set on the external Metasploit adapter separately.**
When changing credentials, stop the old streamer job and launch another;
restarting the receiver does not reconfigure an existing Metasploit job.
See [receiver operations](docs/operations.md) for backups, restore, HTTPS
proxy setup, service lifecycle, and common failures. Do not expose Basic
authentication on an unencrypted public connection.

## Explore without a device

```sh
python3 demo.py --db /tmp/cartochron-demo.sqlite3
python3 map_server.py --db /tmp/cartochron-demo.sqlite3
```

Open the map, select a demo run, and use History to inspect gaps or compare
routes. `demo.py` refuses to overwrite an existing database. Use a fresh
filename for each rehearsal. See [the synthetic walkthrough](docs/walkthrough.md)
and the illustrated `/help` page for map controls. `replay.py` can also feed
synthetic observations into a separate, unauthenticated **loopback-only**
receiver to rehearse Live mode.

## Testing

```sh
make check            # Python and JavaScript tests; no silent skips
make check-deploy     # Self-contained real Docker Compose integration test
```

`make check` requires Python 3 and Node.js; it does not require Ruby or Docker.
`make check-deploy` requires Docker Engine and Compose, and creates its own
disposable project, credentials, and SQLite file. You **do not** need to
start your regular Compose service before running it. Deployment verification
does not use or modify your normal observations.

## Documentation

- [Recording and external Metasploit adapter](docs/recording.md): run IDs, source identities,
  startup, logging and live-device field checks
- [Map walkthrough and synthetic demo](docs/walkthrough.md): Live, History,
  gaps, comparisons, time and place inspection
- [Operations](docs/operations.md): Compose and native deployment,
  authentication, backups, restore, VPS HTTPS, troubleshooting
- [HTTP API](docs/api.md): ingestion, history, cursors and response contracts
- [Development](docs/development.md): source layout, tests and conventions
- [Data contracts](docs/data-contracts.md): source/run provenance and schema
- `/help` (on the running receiver): illustrated manual for map users

## Boundaries

Persistent recordings are never automatically pruned; protect SQLite data,
credentials, and backups. The browser loads OpenStreetMap tiles, which may
reveal the viewed area to the tile provider. User-visible routes connect
reported observations only; they do not establish movement during gaps or
prove that two sources met at an intersection.

Use Cartochron only on devices and sessions you own or are explicitly
authorized to investigate. Unauthorized surveillance or tracking is not
permitted.

GPL-3.0-or-later; see [COPYING](COPYING) and [COPYRIGHT](COPYRIGHT).
Vendored Leaflet assets retain the BSD-2-Clause license. Thanks to
Leaflet.js, OpenStreetMap contributors, and Rapid7 Metasploit Framework.
