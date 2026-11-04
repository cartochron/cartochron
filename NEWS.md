# NEWS

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
