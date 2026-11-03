# Recording observations

Cartochron receives positions from an authorized producer. The Android
Meterpreter module is one adapter; the HTTP API is not tied to Metasploit.
For a receiver running in Docker Compose, first complete
[the operational setup](operations.md) and configure the adapter's
`MAP_USER`/`MAP_PASSWORD` to match the receiver's `data/auth` file.

To install the module from the repository and load its latest code in
`msfconsole`:

```sh
make install-local
```

The module is installed under `~/.msf4/modules/` by default; set `MSF_DIR`
for an alternative Metasploit module directory. Use `make` to fetch the
verified Leaflet assets before starting the native receiver.

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

The stream runs continuously. **Use `run -j`, not plain `run`:** Metasploit
runs the post module as a background job and returns the interactive console.
Plain `run` executes the polling loop in the foreground until interrupted.

A job is the GPS recording task; a session is the connection to the device.
They have different IDs and lifecycles. For example:

```text
msf6 > jobs -l              # Find the GPS streamer job ID
msf6 > sessions -l          # Find the Meterpreter session ID
msf6 > sessions -i <id>     # Enter the session while GPS streaming continues
meterpreter > background    # Return to msfconsole, keeping the session open
msf6 > jobs -k <JobID>      # Stop only the GPS streamer job
```

Do not confuse `<JobID>` with the Meterpreter session ID. Stopping the
streamer job does not close the session. Both the recording job and interactive
commands use the same session, so avoid overlapping intensive operations when
investigating inconsistent location polls. You do not need another terminal,
thread, daemon, or custom job manager.

### Streamer logging

Background jobs share the Metasploit console output, including the interactive
Meterpreter prompt. Cartochron therefore writes operational events to
**Metasploit's existing framework logger**, instead of calling `print_good`
or `print_error` on every poll. Only one-off invalid-configuration errors are
reported to the console.

The default log is `~/.msf4/logs/framework.log`. In another terminal, watch
just the Cartochron messages:

```sh
tail -F ~/.msf4/logs/framework.log | grep --line-buffered '\[Cartochron\]'
```

The framework determines the log location. You can inspect the exact path in
`msfconsole` with `irb` and `Msf::Config.log_directory`.

Logged at the ordinary level: job startup (including the run ID), first
successful ingestion, changes between healthy / unavailable / rejected /
error states, a summary every 60 seconds, and a final summary when the job
stops. Repeated identical failures are not logged every five seconds.
The summary gives counts of accepted, rejected, unavailable, and failed
polls. Per-observation acknowledgments are available in the framework's
debug log level when explicitly enabled:

```text
msf6 > setg LogLevel 2    # More detailed framework logging, including per-fix confirmations
msf6 > setg LogLevel 0    # Return to ordinary logging
```

`LogLevel` affects the entire framework, not only Cartochron. Leave it at the
normal level for long recordings. These logs contain **no GPS coordinates or
HTTP credentials**; use Cartochron's SQLite history to inspect coordinates.
The local framework log still contains run IDs and operational metadata, so
protect it and arrange log retention as appropriate for your environment.
Metasploit's `ConsoleLogging` option is not a replacement: it records console
output but does not prevent console pollution.

The default `ENDPOINT` is `http://127.0.0.1:8765/api/position`.
The recording-run ID and the configured source ID (if any) are written to the
Metasploit framework log. `TRACK_ID` is optional; leave it empty to
create a fresh random ID each run. Set it explicitly (1–64 ASCII letters,
digits, `.`, `_`, or `-`, starting with a letter or digit) only when you
intentionally want multiple jobs to append to the same recording run.
Do not reuse an explicit `TRACK_ID` simply because the same device reconnects:
use one new run per independently started job. Set `SOURCE_ID` to associate
runs with the same enrolled source without joining their paths.
If a previous `TRACK_ID` was set, `unset TRACK_ID` in the module and check
`show options` before starting the next job; also clear any global value with
`unsetg TRACK_ID` if one was configured.
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

## Persistent source identities

A **source** identifies an operator-enrolled producer across recording jobs.
A **run** (`track_id`) records one acquisition period. New jobs intentionally
get new run IDs, even when they belong to the same source: Cartochron must not
invent movement between recording runs. Labels are descriptions, not proof of
physical identity. No MAC address, hardware serial, or Meterpreter fingerprint
is automatically collected.

With the server stopped, enroll a source in the same persistent database:

```sh
python3 sources.py --db "$HOME/.local/share/cartochron/observations.sqlite3" \
    add 'Authorized research phone'
# Prints an opaque ID such as src_0123456789abcdef01234567 (illustrative).
```

If the database is already open in the server, SQLite can serialize normal
writes, but for the simplest initial workflow enroll before starting it.
In `msfconsole`, set `SOURCE_ID` to the exact returned ID, then `run -j`.
Keep `TRACK_ID` empty to generate a fresh run ID each time. To see enrolled
sources again:

```sh
python3 sources.py --db "$HOME/.local/share/cartochron/observations.sqlite3" list
```

`GET /api/sources` lists enrolled sources and `GET /api/tracks` now includes
`source_id` and `source_label` (null for unassigned runs). HTTP ingestion accepts
optional `source_id` alongside the existing `lat`, `lon`, and `track_id` fields.
An unknown source returns HTTP 422, and attempting to attach an existing run
to another source returns HTTP 409. Both errors leave the observation history
unchanged. Older producers can still omit `source_id`; their runs remain
unassigned. Existing schema-v1/v2 databases are upgraded to v3 automatically.
Previously unassigned runs remain unassigned and absent measurement metadata
remains NULL. Back up first; older Cartochron versions cannot read schema v3.

The ID is **not an authentication token**. Access control remains the
responsibility of the HTTP authentication / reverse proxy boundary, and every
writer with the same privileges can claim an enrolled source ID. Use trusted
producers and separate ingress credentials or server-side binding before
operating a genuinely multi-tenant service. For the formal observation
semantics and future evidence separation, see [Data contracts](data-contracts.md).

## First live-device field test

Use a device you own or are explicitly authorized to test, and a separate
persistent test database. Before walking, verify:

1. Start the server, open the map, and confirm it loads locally.
2. In `msfconsole`, run `reload_all`, select `post/android/gather/gps_streamer`,
   set the correct `SESSION` and `INTERVAL 5`, then `run -j`. Record the
   logged `track_id` in the Metasploit framework log, without publishing raw GPS coordinates.
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
not independently verified satellite-fix time. Meterpreter's Android `geolocate`
uses `getLastKnownLocation(NETWORK_PROVIDER)`: a successful poll can return the
same cached location repeatedly, with unknown acquisition time and accuracy.
Long observation gaps are not proof of continuous movement. Never place real
location data or passwords in public bug reports or test fixtures.

## When a receiver stops or changes credentials

`Errno::ECONNREFUSED` means that no receiver accepted the connection at the
configured endpoint. It is expected while the receiver is stopped or starting,
but should stop after it becomes reachable. HTTP **401** is different:
the receiver is reachable and has rejected the credentials. Verify the
running job's `MAP_USER` and `MAP_PASSWORD` against the *current* receiver
credential file. Changing the datastore does **not** update a running job;
stop that job and start a new one with the correct settings. For a Compose
receiver, use the username and password from `data/auth`:

```text
msf6 post(android/gather/gps_streamer) > set ENDPOINT http://127.0.0.1:8765/api/position
msf6 post(android/gather/gps_streamer) > set MAP_USER operator
msf6 post(android/gather/gps_streamer) > set MAP_PASSWORD <password-from-data/auth>
msf6 post(android/gather/gps_streamer) > unset TRACK_ID
msf6 post(android/gather/gps_streamer) > run -j
```

These settings apply when the new job starts. If the receiver is on a VPS,
use its HTTPS URL instead of local loopback; do not send Basic credentials
over plaintext HTTP on an untrusted network. A password entered using
`set` may appear in Metasploit console history and datastore output, so
protect them and avoid including them in logs or bug reports.

Use `jobs -l` to find all running GPS streamer jobs and `jobs -k <JobID>` to
stop a specific obsolete job. If the log shows two different counter streams
for the same run ID (for example, `accepted=977` and `accepted=7`), they can
be independent jobs whose output is interleaved in the framework log. The
counters belong to the job, not the run stored in SQLite. If both jobs submit
with the same `TRACK_ID`, Cartochron cannot infer which job supplied a fix.

`accepted`, `rejected`, `unavailable`, and `errors` count polls from **this
job's lifetime**. `rejected` means an HTTP non-success response (such as 401),
whereas `errors` includes connection failures; neither counter implies data
was stored. A successful response increments `accepted`. Investigate repeated
401s rather than restarting Docker repeatedly. Never include passwords in
bug reports or copy the credential file into the repository.
