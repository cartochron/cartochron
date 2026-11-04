# Explore the map and rehearse locally

This walkthrough uses synthetic locations and does not require a phone,
Metasploit session, or remote service. For an in-browser illustrated guide,
open `/help` in a running Cartochron server; the Help page requires the same
credentials as the map, if authentication is enabled.

## Map navigation

The **Help / Manual** link in the header opens a user-oriented map-reading
guide at `/help`. It explains Live/History, track comparisons, time and place
inspection, gaps, partial results, and what the data does not establish, with
annotated synthetic screenshots. Installation, Metasploit operation, and testing
belong in the repository guides, not the in-app Help page. Help and its images use the
same authentication requirements as the map.


In **Monitor** (formerly Live), the selector shows one entry per configured
acquisition channel, or per enrolled source when no channel was reported. Its
selected entry follows the most recently ingested recording run automatically
when a collector restarts; it never combines their observations into one
recording. The latest **unattributed** run is available as a fallback, without
treating older unattributed runs as the same device. Channel names are
operator-configured assertions, not verified device identities.

- **Monitor** polls up to 1,000 recent observations for the selected identity's
  current run. **Recent receipts** means the server received a fix within two
  minutes, not that a phone is online. After two minutes without a receipt,
  **No recent receipts** dims the route; stored fixes remain available. The
  selector displays receipt states, not ever-increasing counters.
- **History** retains separate recording run IDs, independent of Monitor selection. It lists the 100 newest runs; the API can query older known IDs. History lets you set **From** and **To** using the browser's *local*
  clock. Press **Show interval** to query `[from, to)`; the server converts the
  timestamps to UTC. Use **Inspect point** to examine the position and receipt
  time of each displayed observation.
- The browser loads 1,000 historical points at a time. **Load more** fetches
  the next page without losing earlier points. After 5,000 displayed points,
  narrow the interval to inspect the remainder. The interface reports partial
  results; it does not silently simplify a route or claim completeness.
- A gap greater than **10 minutes between consecutive receipt times** breaks
  the line into separate route segments. Pale endpoint rings explain the gap
  duration when inspected. Movement between fixes is unknown. Green marks
  the first displayed fix, orange the last, and purple the inspected fix.
- **Tracks** shows up to four runs at once: the focused blue run plus up to
  three color-coded comparison layers. **Entire runs (spatial)** compares the
  loaded routes regardless of time; **Same interval** filters comparisons to
  the focused run's selected window.
- **Shared time** highlights only the latest recorded fix at or before the
  cursor if it is no more than five minutes old. It never interpolates
  positions or treats stale fixes as current.
- **Inspect place** accepts a click on the map and lists up to 40
  chronologically ordered observations from **loaded** tracks within the
  selected radius. It is not a whole-database search.


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

In **History** mode, choose **Tracks** to show comparison runs. The focused
run remains blue; the three possible additional runs use violet, teal, and
crimson with dark outlines. Clicking a node or a line opens its real recorded
coordinates and time; the primary point slider continues to inspect the
focused run only. **Entire runs (spatial)** compares geography across the
loaded lifetimes, while **Same interval** uses the focused run's time window.
The viewport fits visible tracks, even when they come from different cities.

Try `demo-city-loop` plus `demo-crossing`; their routes intersect on the map
but the fixes were recorded at different times. Their intersection alone
cannot establish a meeting. Use the **Shared time** slider to see whether
recent recorded fixes exist for each run, or **Inspect place** to read loaded
observations near a manually chosen location in timestamp order.

The browser caps each displayed run at 5,000 observations and reports partial
pages. Place inspection and the shared time cursor operate only on the points
currently loaded in the browser, not the entire persisted database. Check
pagination and time intervals before treating an empty result as meaningful.

See **Help / Manual** for screenshots and an operator walkthrough. The manual
captures use a **neutral offline demonstration map base** and synthetic
positions, not real GPS or downloaded map tiles.

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
