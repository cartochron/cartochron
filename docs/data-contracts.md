# Cartochron data contracts

## Implemented: location observation protocol (v6 database)

The API accepts `POST /api/position` with latitude and longitude, optional
`track_id`, and optional `source_id`. Missing track IDs use `legacy` for
compatibility. Every accepted fix receives a server-generated receipt timestamp.
This is *not* necessarily when the GPS measurement was acquired. Meterpreter's Android
`geolocate` uses `getLastKnownLocation(NETWORK_PROVIDER)`, so repeated responses
may be cached and cannot be treated as independent measurements.

A source is enrolled locally and has an opaque persistent ID plus a descriptive
label. A run has one stable association with exactly one source or with no
source. A producer may also supply an optional `channel_id`: a stable, configured
acquisition-input identifier, independent of a source or recording run. The
channel belongs to the run, not individual measurements. Neither `channel_id`
nor a source ID authenticates a physical device. Both are immutable for an
existing run; conflicting assertions fail instead of rewriting earlier records.
`source_id` is an identifier, **not proof of ownership or an API credential**.
A future multi-tenant deployment must authenticate producers and bind their
identities server-side before authorizing writes to a source.

The database stores original accepted coordinates and reception times. Producers
may optionally report `measured_ms` (Unix epoch milliseconds), `provider` (an
opaque provider name), and `accuracy_m` (horizontal accuracy in metres).
These are producer assertions, not independently verified measurements. All
three fields are absent for legacy and current Meterpreter observations; missing
values must never be replaced with server receipt time or guessed accuracy.
Schema v4 adds nullable run-level `channel_id`. New databases create v5
directly; v1/v2/v3 databases migrate without guessing old channel identities.
Legacy observations retain NULL for missing measurement metadata. Back up
the database before upgrading; earlier Cartochron versions cannot open v5.
Schema v5 adds a separate `channel_labels` display-name table. Changing labels
never updates `runs.source_id`, `runs.channel_id`, or an observation. The label
is an operator description, not authenticated source provenance.

A Monitor identity is a **read-only grouping**, not a new owner or a merged
recording: choose `channel_id` when present, otherwise the enrolled `source_id`.
If neither exists, show only the latest unattributed run as a fallback; never
infer identity from a shared prefix in `track_id`. Monitor selects the latest
*ingested* run for each identity, while History preserves every separate run.
Different source assertions on a channel remain visible as an ambiguity;
changing the displayed source label does not rewrite history.

The browser may draw connecting lines, but it cannot infer movement during gaps.
Time queries use `[from, to)` on the server's receipt clock. An old run migrated
from v1 stays unassigned; no attempt is made to infer device identity.

The post-v0.1 place investigation endpoint returns **only individual recorded
observations** that pass an exact-radius check after an indexed bounding-box
candidate search. It does not infer visits, presence between observations,
repeated activity, or physical source identity. Result pages and candidate
scans are bounded, and a cursor can exist even for an empty result page. The
schema v6 migration adds a lookup index only; original observations and run
attributions remain untouched.

## Not implemented: imported evidence or communications

Future explicitly authorized evidence import should distinguish:

- **Artifact**: material imported with source, acquisition time, and integrity
  information. A hash does not establish that the source's assertions are true.
- **Reported event**: a source assertion with event time, time zone/offset when
  known, and an artifact/provenance reference.
- **Observation**: a measurement, with acquisition time only if the provider
  actually supplies it, distinct from the server's receipt time.
- **Annotation**: an operator's interpretation, never silently promoted into
  an observation or event.

This is a data-model boundary, not a promise of an SMS/contact/call-log
collection endpoint. Any future importer should be explicit, authorized,
case-scoped, auditable, and separately permissioned, with limits on retention
and export. Source-derived assertions must not overwrite stored GPS fixes.
