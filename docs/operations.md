# Running Cartochron with Docker Compose

This is an optional deployment path for the **receiver and map**. The optional [Cartochron Metasploit adapter](https://github.com/cartochron/cartochron-metasploit)
runs separately on the authorized operator's machine and is installed from
its own repository. Docker is not required
for ordinary local Python use.

## First start

Install Docker Engine and the Compose plugin, and run these commands from a
Cartochron checkout. The container runs as your host UID/GID, so you can read
and back up your own database without `sudo` or extra ownership scripts.

```sh
install -d -m 700 data
( umask 077; printf 'operator:%s\n' "$(openssl rand -hex 32)" > data/auth )
( umask 077; printf 'CARTOCHRON_UID=%s\nCARTOCHRON_GID=%s\n' \
    "$(id -u)" "$(id -g)" > .env )
docker compose config -q
docker compose up --build -d
```

Read the generated credentials with `cat data/auth` and open
<http://127.0.0.1:8765>. Your browser will prompt for the username and
password in `data/auth`. Keep this file private: it also grants **write**
access to observations. The password is not part of the Docker image or
passed as a process argument.

The source tree and SQLite data are separate. Compose uses a bind-mounted,
private `data/` directory, and both `data/` and `.env` are ignored by Git.
The container has a read-only root filesystem; only `/data` and the bounded
`/tmp` filesystem are writable. The HTTP port is published on the host's
**127.0.0.1 only**. The backend listens on `0.0.0.0` *inside the container*;
this is not a request to expose the host port publicly.

To choose a different host port, set `CARTOCHRON_PORT=9876` in `.env` and
recreate the container with `docker compose up -d`. This changes the receiver
endpoint; update any Metasploit job configuration accordingly and restart the
job, not only the container. To use an existing
private directory, set `CARTOCHRON_DATA_DIR=/absolute/path` in `.env`;
create it with mode `0700` and correct ownership first.

## Normal operation

```sh
docker compose ps
docker compose logs --tail=50 cartochron
docker compose stop       # Stop, keep the database
docker compose start      # Resume with existing data
docker compose down       # Remove the service, not the host data directory
```

Stopping or restarting this container does **not** stop an independently
running Metasploit streamer. A sender may log `ECONNREFUSED` while Cartochron
is down; it will retry on the next polling iteration. Restarting with a new
`data/auth` password causes the old job to receive **HTTP 401** until the
operator stops and relaunches it with the matching credentials. The receiver
does not reload an edited credential file until it restarts.

A new recording job should have a new `track_id`. If you use enrolled source
IDs, add/list them against the same database through the running container:

```sh
docker compose exec cartochron python3 sources.py --db /data/observations.sqlite3 add 'Research phone'
docker compose exec cartochron python3 sources.py --db /data/observations.sqlite3 list
```

A source ID identifies an operator-enrolled producer; it is not an
authentication token or proof of device identity.

## Back up and restore

**Stop the receiver before copying the SQLite file.** This is the simplest
safe path for v0.1 and prevents a torn copy while ingestion is active.

```sh
docker compose stop
install -d -m 700 backups
( umask 077; cp data/observations.sqlite3 backups/cartochron.sqlite3 )
( umask 077; cp data/auth backups/auth )
docker compose start
```

Verify the copied database locally (Python is sufficient; no `sqlite3`
command-line program or extra container required):

```sh
python3 - <<'PY'
import sqlite3
with sqlite3.connect('file:backups/cartochron.sqlite3?mode=ro', uri=True) as db:
    print(db.execute('PRAGMA quick_check').fetchone()[0])  # Expected: ok
PY
```

A snapshot contains all observations *up to its creation*, but not subsequent
writes. To restore deliberately, stop the receiver again, replace only the
SQLite file, and start it:

```sh
docker compose stop
cp backups/cartochron.sqlite3 data/observations.sqlite3
chmod 600 data/observations.sqlite3
docker compose start
```

Make a copy of the current database before overwriting it. Restore to the
same application schema or a newer application that explicitly supports the
older schema. Keep database and credential backups private, outside Git.
Do not confuse a Docker image rebuild with a database backup.

## VPS deployment

The Compose port remains loopback-only. Terminate HTTPS in a trusted reverse
proxy running on the host, for example Caddy:

```caddyfile
gps.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

Expose only the proxy's TLS port to the Internet, not Cartochron's backend.
The proxy must preserve `Authorization` and `Host`. Use a valid TLS
certificate and point the authorized Metasploit sender to
`https://gps.example.com/api/position`. Plain HTTP Basic auth does **not**
encrypt a connection. Keep the Docker engine updated and enforce network
restrictions with your host/VPS firewall; loopback port publishing must not
be your only security boundary on an untrusted host.

The map requests OpenStreetMap tiles externally; the tile provider may learn
the area being viewed. The application's Leaflet JavaScript and CSS are
vendored and checksum-verified during image build, so they are not downloaded
at container startup.

## Running without Docker, including a VPS

For the simplest local receiver with in-memory data, use
`python3 map_server.py`, listening on `127.0.0.1:8765` by default.
To retain observations, create a private parent directory and use an
explicit database path:

```sh
install -d -m 700 "$HOME/.local/share/cartochron"
python3 map_server.py --db "$HOME/.local/share/cartochron/observations.sqlite3"
```

The receiver supports `--bind` (default `127.0.0.1`), `--port` (default
`8765`), `--db`, and `--auth-file`. If remote access is needed, supply a
private Basic-auth file, for example:

```sh
install -d -m 700 "$HOME/.config/cartochron"
( umask 077; printf 'operator:%s\n' "$(openssl rand -hex 32)" > "$HOME/.config/cartochron/auth" )
python3 map_server.py --auth-file "$HOME/.config/cartochron/auth"
```

Keep the Python receiver on host loopback and forward HTTPS from a trusted
reverse proxy as shown above. An authenticated browser or sender must provide
matching credentials. If you intentionally bind on all interfaces for a
private VPN (`--bind 0.0.0.0`), restrict the port to trusted clients using
firewall rules; direct unauthenticated public access exposes all recordings.
Basic authentication is not encryption. Do not place passwords in endpoint URLs
or disable TLS certificate verification.

## Resource limits

The receiver bounds HTTP workers to 32 concurrent requests, waits at most
10 seconds for a request body, and rejects incomplete bodies. A busy
receiver can respond with **HTTP 503**. These limits reduce accidental
resource exhaustion but do not replace TLS termination, a reverse proxy,
or host firewall rules for remote exposure. An authenticated client has
read and write access; `source_id` and `track_id` are identifiers, not
permissions or credentials.

## Troubleshooting

- `variable CARTOCHRON_UID/GID is required`: recreate `.env` using `id -u`
  and `id -g` as shown above.
- `cannot read auth file`: verify `data/auth` exists, contains one
  `username:password` line and has mode `0600`; verify the container's UID.
- SQLite file cannot be created: check `data/` exists, is owned by the
  configured UID/GID, and is writable by that user.
- Receiver returns HTTP 503: check Docker logs, disk space, and the
  SQLite database, or whether the HTTP worker limit is reached.
- Metasploit logs HTTP 401 after switching to Compose: the new receiver
  requires credentials. Check `MAP_USER` and `MAP_PASSWORD` on the *running*
  streamer job; stop obsolete jobs and launch a new one after setting them.
  See [recording and job lifecycles](recording.md#when-a-receiver-stops-or-changes-credentials).
- Metasploit logs `Errno::ECONNREFUSED`: the receiver may be stopped, starting,
  or listening on a different port. Check `docker compose ps` and your
  streamer's `ENDPOINT` before changing passwords.
- Framework log shows two counter streams with one run ID: check `jobs -l`;
  multiple streamer jobs may have been started with the same `TRACK_ID`.
  Use fresh run IDs to avoid conflating acquisition periods.
- Browser prompts repeatedly: check the username and password from
  `data/auth`, and confirm the reverse proxy forwards `Authorization`.
- Map background tiles are unavailable: the map interface works locally,
  but the tile provider requires Internet access.

Before a release, run `make check` and `make check-deploy`. The latter
is **self-contained**: it validates the Compose configuration, builds a real
image, creates and starts a separate temporary Compose project with disposable
credentials and database, exercises authentication, shutdown, restart, and
offline restore, then tears the project down. It does **not** require a
prior `docker compose config` or `docker compose up` and does not modify the
regular `data/` directory. Use `docker compose up -d --build` separately to
start your actual receiver.
