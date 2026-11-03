# Cartochron data contracts

## Implemented: location observation protocol (v2 database)

The API accepts `POST /api/position` with latitude and longitude, optional
`track_id`, and optional `source_id`. Missing track IDs use `legacy` for
compatibility. Every accepted fix receives a server-generated receipt timestamp.
This is *not* necessarily when the GPS measurement was acquired. Meterpreter's Android
`geolocate` uses `getLastKnownLocation(NETWORK_PROVIDER)`, so repeated responses
may be cached and cannot be treated as independent measurements.

A source is enrolled locally and has an opaque persistent ID plus a descriptive
label. A run has one stable association with exactly one source or with no
source. Conflicting assertions fail, rather than modifying earlier records.
`source_id` is an identifier, **not proof of ownership or an API credential**.
A future multi-tenant deployment must authenticate producers and bind their
identities server-side before authorizing writes to a source.

The database stores original accepted coordinates and reception times. The
browser may draw connecting lines, but it cannot infer movement during gaps.
Time queries use `[from, to)` on the server's receipt clock. An old run migrated
from v1 stays unassigned; no attempt is made to infer device identity.

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
