# The Cartochron handbook

*An operator's guide to observing, comparing, and questioning location evidence.*

This is the first **living edition**, covering the implemented v0.1-era
analysis tools. Planned capabilities are described separately in
[the project vision](vision.md); nothing in that document should be
mistaken for a working control.

For a compact illustrated guide inside the running application, open
**Help / Manual** (`/help`). For installation commands and disaster recovery,
consult [Operations](operations.md). This handbook is organized around
*questions an investigator wants to answer*, not around program files.

## Part I — Know what you're looking at

**An observation** says that a producer reported coordinates to Cartochron.
Cartochron stamps the time it *received* the report. When a producer supplies
its own acquisition time, the two clocks are displayed separately. An
observation may be old, inaccurate, cached, or incomplete. Cartochron does
not independently verify the phone or the person's physical presence.

**A source** is an enrolled, operator-chosen identity; **a channel** is the
configured acquisition input; **a run** is one recording session. A single
source may be observed via several channels, and each channel may produce
several independent runs. The original associations are preserved even when
an operator changes a display label.

| On the map | What it can support | What it cannot prove |
| --- | --- | --- |
| Recent receipts | A position report reached the server recently | The producer is currently connected or the device is physically there |
| Last recorded point | The most recent stored report for a run | Continuous presence since the report |
| Route line | The visual order of *recorded* observations | An observed journey between the points |
| Broken line / gap | No supporting reports for an interval beyond the threshold | Device absence or any particular movement in the gap |
| Two routes crossing | Recorded geographic overlap | A meeting without temporal and independent supporting evidence |

### The first rule

**Do not turn an absence of observation into an observation of absence.**
Always examine acquisition quality, time coverage, and the amount of history
actually loaded before interpreting a pattern.

## Part II — Start with safe, reproducible evidence

Use synthetic data first. In a fresh Cartochron checkout:

```sh
make
python3 demo.py --db /tmp/cartochron-handbook-demo.sqlite3
python3 map_server.py --db /tmp/cartochron-handbook-demo.sqlite3
```

Choose a **new** database path each time: the demo refuses to overwrite
existing records. Open `http://127.0.0.1:8765/`, then **History**. No phone,
Metasploit session, or GPS hardware is needed. Avoid using real locations in
examples, issues, or screenshots intended for publication.

For the production lifecycle, run the receiver with a private persistent
SQLite file or its supported Compose deployment. Back up before a schema
upgrade. See [Operations](operations.md) for permissions, TLS, authentication,
stop/start, and restore procedures.

## Part III — Acquire without coupling collection to analysis

The core receiver exposes an HTTP observation contract, rather than requiring
one specific kind of tracker. The current independent adapters include:

- [cartochron-gpsd](https://github.com/cartochron/cartochron-gpsd): subscribes
  to GPSD TPV reports and may include producer-reported fix time and estimated
  error. GPSD's input path is a configured channel, not authenticated phone
  identity.
- [cartochron-metasploit](https://github.com/cartochron/cartochron-metasploit):
  uses an authorized Android Meterpreter session. Its location can be the
  Android network provider's *last-known* value, with unknown fix age and
  accuracy. The adapter may send a stable `CHANNEL_ID`; omit `TRACK_ID` to
  generate a new run for each job.

Both produce ordinary observations. Importing GPX/KML/KMZ, incident feeds,
and road-restriction overlays are future capabilities, **not** implemented
core inputs. The [data contracts](data-contracts.md) describe boundaries for
future event and artifact types.

## Part IV — Ask better questions with the map

### 1. Monitor: what has been reported lately?

Monitor groups known channels or enrolled sources rather than filling the
selector with every old recording job. Each identity follows its newest run
when fresh observations arrive. **Recent receipts** means recent data, not a
verified connection. Select **Show inactive positions** to inspect stale last
positions deliberately; do not interpret them as current locations.

Camera modes are operator-controlled: **Free** avoids automatic recentering,
**Follow selected** follows one chosen entry with reduced jitter, **Follow
visible** frames the shown sources together, and **Fit visible** reframes
once. Manual camera movement returns to Free. A selected run's trail never
joins older runs or another channel's positions.

### 2. History: what was recorded, and when?

Switch to History and browse recording runs separately. Filter by stored
source or channel, page into older runs, then select a time interval.
Cartochron uses a **half-open interval** `[from, to)` on the *receipt clock*.
History requests and rendered pages are bounded; a partial result does not
mean older observations do not exist. If you change the interval, note its
local-time display and the receiver's UTC semantics.

### 3. Points, gaps, and suspect jumps

Inspect individual points instead of reasoning from the line alone. A gap
larger than ten minutes breaks the rendered route. Some abrupt apparent
movements are separately flagged as *possible positioning jumps*, based on
server receipt time. Neither rule tells you where the subject traveled or
whether the GPS report was wrong.

![Synthetic Cartochron route with a deliberate observation gap](images/gaps.png)

*Figure 1 — Synthetic recording gap. Inspect the endpoints and the time
between them; the missing interval is not a reconstructed route.*

### 4. Compare tracks: does a spatial crossing matter?

Select a focused run, open **Tracks**, and add up to three comparison runs.
Use **Entire runs (spatial)** to study where recorded paths overlap, or **Same
interval** when temporal coverage matters. Read the recording intervals
before making claims about proximity or repeated passage.

![Synthetic Cartochron comparison of two runs](images/tracks.png)

*Figure 2 — The blue and violet recorded routes cross. Their shared geography
alone cannot establish that two sources met. The shared-time result below
is a separate question.*

### 5. Shared time: what was actually observed together?

Move the **Shared time** cursor in History. For each loaded run, Cartochron
selects the latest actual fix at or before the chosen instant **only when no
more than five minutes old**. It does not interpolate positions. A missing
qualifying fix means **no sufficiently recent loaded observation**, not
proof that the source was somewhere else.

### 6. Inspect a place: who was recorded near this area?

In History, open **Inspect place**, select a radius, and click an area. The
first list examines **loaded, visible recordings**. Its scope is deliberately
limited to the selected runs and loaded pages.

Press **Search recorded history** to ask a different question: *which individual
recorded observations, across all saved runs, fall within this radius?* This
second list returns the supporting observations with exact run IDs, channel
and source labels if known, receipt times, reported fix provenance and computed
distance. Use **Older search page** until the cursor is exhausted. A page with
no matches may still have older candidates; do not interpret it as complete.
The search is not a frozen database snapshot while acquisition continues.

Use **Scope** to restrict the search to an enrolled source or configured
channel; an unfiltered search covers all recorded identities. **From** and
**To** restrict the server's *receipt clock*, using the operator's local time
in the browser. This is not the same as a producer-reported GPS fix time.

Above the raw evidence, the browser shows *matching-fix groups* from the
observations it has retrieved so far. They join **only matching points of the
same run** when successive receipt times are at most five minutes apart. Such
groups can split or change as older pages arrive. They say nothing about what
happened between the fixes, even if their timestamps are close. In particular,
they are **not visits, dwell times or co-presence conclusions**.

Record the coordinates, radius, time of query and completion state before
reporting any finding. A geographic distance computed from reported
coordinates is not a measured distance between physical people. Repeated fixes
are not automatically independent measurements or evidence of a visit/dwell.

## Part V — Three worked lines of inquiry

**Question A: Was this source continuously present?** Select the source in
Monitor, inspect its receipt freshness, then examine the relevant recording
runs in History. Enumerate gaps. Distinguish repeated cached coordinates
from independent measurement epochs. The result may simply be: *the receiver
has no observations covering this interval*.

**Question B: Did two sources meet?** Load the relevant runs, inspect
spatial intersections, then compare their receipt-time windows and reported
measurement times, if available. Account for accuracy and missing intervals.
If the only support is two crossing polylines, the meeting hypothesis is
**unconfirmed**.

**Question C: Was a place repeatedly visited?** Filter runs in History,
choose an explicit time range, and use Inspect place. Repeat across pages or
runs rather than treating the first page as complete. Record search radius,
time windows, results and exclusions. A repeat observation near a place is
not necessarily evidence of a deliberate visit or dwell.

For each inquiry, keep a compact working record: **question → supporting
observations → competing explanation → test → conclusion and limits**.
That record is the investigator's analysis, not another type of raw GPS fix.

## Part VI — Preserve, interpret, communicate

Separate what the system *received* from what a producer *reported*, and both
from what an investigator *infers*. Preserve source/channel/run identifiers
with relevant timestamps in notes. Do not silently reassign the provenance
of an old recording because its display name changes. Protect SQLite data,
credentials and backups; obey the applicable authorization and retention
constraints. Avoid sharing private coordinates in issue reports or examples.

The existing implementation provides map inspection, not a full case-management
or forensic chain-of-custody system. Artifact import, incident overlays,
annotations, saved investigative queries and evidence-backed report export
remain **design directions**, as detailed in [the vision](vision.md).

## Part VII — Reference

- [Illustrated in-app manual](/help) (when the Cartochron server is running)
- [Synthetic walkthrough](walkthrough.md)
- [Recording and adapter operation](recording.md)
- [API and pagination](api.md)
- [Data contracts and provenance](data-contracts.md)
- [Deployment, backup and restore](operations.md)
- [Future direction and design principles](vision.md)

This handbook should grow through small, *synthetic and reproducible* case
studies as analysis features mature. Screenshots must be updated when the UI
changes; an old figure should not be presented as proof of current controls.
