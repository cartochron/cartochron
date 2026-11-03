# Running Cartochron with Docker Compose

This is an optional deployment path for the **receiver and map**. Metasploit
runs separately on the authorized operator's machine. Docker is not required
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
recreate the container with `docker compose up -d`. To use an existing
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

## Troubleshooting

- `variable CARTOCHRON_UID/GID is required`: recreate `.env` using `id -u`
  and `id -g` as shown above.
- `cannot read auth file`: verify `data/auth` exists, contains one
  `username:password` line and has mode `0600`; verify the container's UID.
- SQLite file cannot be created: check `data/` exists, is owned by the
  configured UID/GID, and is writable by that user.
- Receiver returns HTTP 503: check Docker logs, disk space, and the
  SQLite database, or whether the HTTP worker limit is reached.
- Browser prompts repeatedly: check the username and password from
  `data/auth`, and confirm the reverse proxy forwards `Authorization`.
- Map background tiles are unavailable: the map interface works locally,
  but the tile provider requires Internet access.

Before a release, run `make check` and `make check-deploy`. The latter
builds a real image, uses disposable test data and a separate Compose project,
and exercises authentication, shutdown, restart, and offline restore.
