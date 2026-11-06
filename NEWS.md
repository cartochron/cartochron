# NEWS

## 0.2.0 — 2026-11-05

- Investigate a place across stored recording runs using exact-radius searches,
  bounded paging, source/channel filters, and a schema v6 spatial index.
  Results are individual reported fixes, not inferred visits.
- Compare two runs across places by bounded receipt-time and distance windows;
  inspect original witness pairs, adjacent observations, and recorded gaps.
  Dense candidate limits and incomplete history remain explicit.
- Add private, append-only operator annotations linked to one or two original
  observation IDs (schema v7). Notes are written locally, never through the
  browser's shared ingestion credential.
- Improve Monitor and History navigation, comparison selection, small-screen
  usability, and explicit empty/error/partial-result recovery. Preserve exact
  full-recording bounds across daylight-saving transitions.
- Render dashed observation links rather than implying measured travel;
  disclose unknown acquisition times while preserving original reports.
- Redact untrusted HTTP request targets from receiver access logs and add
  focused regression coverage for privacy and viewer state transitions.

### Upgrade from 0.1.0

- **Back up the private SQLite database before starting 0.2.0.** Persistent
  databases migrate from schema v5 through v6 to v7. Older receivers cannot
  open a database after migration; restoring 0.1.0 requires restoring its
  pre-upgrade database backup as well.
- Upgrade the receiver before updating acquisition adapters. The current
  Metasploit adapter reports `provider: network` but still cannot determine
  the phone's fix acquisition time or accuracy; existing rows are unchanged.
- Run `make check` and the opt-in real Docker check `make check-deploy` before
  tagging or upgrading a live receiver. See `docs/operations.md`.

## 0.1.0 — 2026-11-04

Initial release of Cartochron, an investigation-oriented map of *reported*
location observations. Its purpose is to preserve provenance and expose
uncertainty, not to infer uninterrupted physical movement.

- A small Python HTTP receiver with SQLite history, authenticated ingestion,
  bounded requests, Docker Compose deployment, and documented backup/restore.
- Separate source, acquisition-channel, recording-run and observation identities.
  Optional reported fix time, provider and accuracy remain distinct from server
  receipt time. Existing database formats migrate to schema v5.
- Monitor groups known channels and sources, distinguishes recent from stale
  receipts, and offers Free, Follow selected and Follow visible camera modes.
- History keeps recording runs separate, with paginated run discovery, bounded
  point queries, route gaps and possible positioning-jump markers.
- Comparison tools include shared-time inspection, track comparison and
  place inspection over *loaded* observations; these are not full-database
  presence or co-location claims.
- Operator-owned source/channel display names, synthetic examples and an
  illustrated investigation handbook. GPSD and Metasploit acquisition adapters
  are maintained in separate repositories.

### Important boundaries

- A source or channel ID is not authentication of a physical device.
- Recent receipts do not prove that a producer is connected or located there.
- Historical intervals are not bridged across unobserved gaps or recording runs.
- Persistent databases are not automatically pruned; keep data, authentication
  files and backups private. Map tiles are requested from OpenStreetMap.
- Back up the SQLite database before upgrading; older receiver versions cannot
  open databases upgraded to schema v5.

For operation, see `docs/operations.md`; for analysis, see `docs/handbook.md`.
