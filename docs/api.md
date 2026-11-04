# HTTP API and history queries

The receiver accepts generic HTTP observations independently of Metasploit.
The examples below use loopback HTTP; for authenticated remote use, terminate
TLS in a trusted proxy and never expose Basic credentials over plaintext.
For the distinction between observations, sources, and runs, see
[data contracts](data-contracts.md).

## Tracks and historical queries

A recording run is identified by `track_id`. Existing senders that POST only
`lat` and `lon` continue to work and write to the `legacy` track. The server
still returns the original `lat`, `lon`, and `time` fields on successful POST.
`time` is the server's **receipt time**, not necessarily the moment when a
GPS device obtained a fix. The database retains integer UTC milliseconds.
Producers may supply optional `measured_ms` (Unix epoch milliseconds),
`provider` and `accuracy_m` (horizontal accuracy in metres). A producer may
also set `channel_id` (1–64 ASCII letters, digits, dots, underscores and
hyphens, starting with a letter or digit). This identifies a configured
acquisition input, not an authenticated device or a permanent source. It is
attached to the entire run and cannot be changed later; absent means unknown.
POST success with a channel echoes `channel_id` so an adapter can verify the
receiver preserved it. The run catalogue includes nullable `channel_id`;
point history does not repeat run-level metadata. Existing requests without a
channel retain unchanged receipt response bodies. Measurement metadata is
included in point responses only when reported (`measured_time` is RFC3339).
Such values are unverified producer reports, not substitute receipt timestamps.
The current Meterpreter adapter supplies none of the measurement metadata
fields and may omit `channel_id`. The GPSD adapter can supply a configured
`channel_id` independently of whether a source has been enrolled.

The API exposes these relevant GET operations:

| Endpoint | Response |
| --- | --- |
| `GET /api/points` | Original `{"points": [...]}` response, from the most recently updated run |
| `GET /api/points/recent?track_id=...` | Up to 1,000 newest points for an explicitly selected run (used by Live mode) |
| `GET /api/tracks` | Up to 100 run summaries, including nullable `channel_id`, `source_id` and descriptive `source_label` |
| `GET /api/monitor` | Up to 100 grouped Monitor entries, including each group's latest reported coordinates and optional display labels |
| `GET /api/runs?limit=50&before=...` | Paginated run catalogue, optionally filtered by exact `channel_id` or `source_id` |
| `GET /api/sources` | Up to 100 enrolled source summaries (protected by the same HTTP authentication) |
| `GET /api/points?track_id=...` | Historical query ordered by receipt time, with an optional time range, page size, and continuation cursor |
| `GET /api/place/observations?lat=...&lon=...&radius_m=100` | Recorded observations near one point across all stored runs, with bounded pages |

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

The read-only `/api/monitor` response has `entries` and a `truncated`
flag. Entries carry `kind` (`channel`, `source`, or `unattributed`), `id`,
`track_id` (the newest *ingested* run for that identity), `last` (receipt
of that run's latest inserted observation), `runs` (number of separate runs),
nullable `channel_id`, `channel_label`, `source_id`, `source_label`,
`lat`, `lon` (latest reported coordinates), and `mixed_sources`. The
latter warns if different runs on one channel asserted different enrolled
source IDs. The latest source label must not be promoted to a claim about
all historical runs. Unattributed entries are **not** merged into a device:
only the newest unassociated run is surfaced in Monitor, and the `runs`
count signals the number of distinct unattributed runs still in History.
Enrollment without recorded observations is listed by `/api/sources`, not
`/api/monitor`. Both endpoints use the same configured HTTP authentication.
Monitor summaries are bounded and may be truncated; they are not full-history
exports or evidence of a current connection.

To list older recording runs use `GET /api/runs?limit=50`. Each result contains
`tracks` and `next_cursor` (an integer observation-row ID, or null). When a
cursor is present, pass it as `before=<next_cursor>` to load the next page.
Optionally pass exactly one of `channel_id` or `source_id` for a stored
association filter. Page sizes are 1–100. The cursor is a position rather
than a snapshot: concurrent ingestion can reorder an existing run between
requests. Use exact run IDs to examine recorded evidence.

`channel_label` is a mutable operator description, distinct from the run's
immutable `channel_id` and optional `source_id`. The HTTP API does not expose
label writes. The latest coordinates on Monitor are observational reports,
not evidence that a source remains connected or is currently present there.

The Leaflet page uses these APIs for track selection and historical navigation.
The unfiltered endpoint remains available for older clients and still follows
the most recently ingested run.

## Search a place across recorded runs (post-v0.1)

In History, **Inspect place** retains the lightweight search of *loaded*
points. Click **Search recorded history** to query all stored runs at that
location, not just the current display. The read-only endpoint is:

```text
GET /api/place/observations?lat=47&lon=28&radius_m=100&limit=50
```

`lat` and `lon` are finite coordinates. `radius_m` is 10–1000 metres;
`limit` is 1–100 matching fixes (default 50). Results are sorted by the
**insertion order of observations**, newest first, not by potentially
unreliable producer measurement times. Each match contains its original
observation fields, distance from the queried point, exact `track_id`, and
nullable immutable source/channel IDs and operator-owned display labels.
Distance is derived from the *reported coordinates*, not ground-truth
positions, and reported accuracy may be absent.

The server first selects observations in a conservative indexed bounding box,
then applies great-circle distance to each candidate. A response transfers
at most 2,000 candidates into Python for checking, but the SQLite lookup can
scan/sort additional indexed entries. Thus this is **not a fixed CPU-time
bound**; use a trusted receiver and consider narrower radius/time-scoped
queries for very large histories.

`next_cursor` (or null) is the ID of the last examined candidate, not
necessarily the last *matching* observation. Pass it as `before=<cursor>` to
continue. A page can have **zero matches and still have a cursor** if further
candidates remain. Stop only when the cursor is null. `truncated` indicates
whether additional pages may exist; `scanned` reports the candidate count for
that page. Like the run browser, this is **not a frozen snapshot** during
concurrent ingestion. No reported fix is converted into an inferred visit,
continuous presence, or a claim about a person/device.

Optional `from` and `to` restrict **server receipt time** with the same
RFC3339, millisecond-precision `[from, to)` convention as run History. Optional
`channel_id` or `source_id` selects exactly one stored run association; these
filters are mutually exclusive. A query may still span many distinct runs.
For example:

```sh
curl -fsSG 'http://127.0.0.1:8765/api/place/observations' \
  --data-urlencode 'lat=47' --data-urlencode 'lon=28' \
  --data-urlencode 'radius_m=100' \
  --data-urlencode 'from=2026-11-03T09:00:00Z' \
  --data-urlencode 'to=2026-11-03T12:00:00Z' \
  --data-urlencode 'channel_id=gpsd.oneplus'
```

The `before` cursor has meaning only with the **same** location, radius,
time window and exact identity filter. Changing any of those resets the search.
The result order still follows ingestion, not receipt time; the clock may have
moved backwards. Narrow time or identity filters reduce the relevant candidate
set but do not turn the indexed query into a hard CPU-time guarantee.

The browser additionally groups **retrieved matching fixes** for inspection:
fixes in the same run at most five minutes apart *by receipt time* form one
matching-fix group. Groups can change when older pages are loaded and never
mean a continuous visit, dwell interval, verified physical presence, or
complete case-wide coverage. All individual observations remain accessible.
No source association or historical observation is modified.
Database schema v6 adds only a latitude/longitude lookup index on top of v5;
back up the database before upgrading and do not downgrade the running
receiver afterward.

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
