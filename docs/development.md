# Developing and testing Cartochron

The receiver is deliberately small and depends on the Python standard
library. Ruby and Node.js are needed for the adapter and viewer tests; Docker
is needed only for the explicit deployment rehearsal. Avoid additional
services and test wrappers unless a real failure demands them.

## Repository layout

- `map_server.py`: HTTP routing, authentication, and worker lifecycle
- `observation_store.py`: SQLite schema, atomic writes, and historical queries
- `sources.py`: local command-line source enrollment
- `gps_streamer.rb`: authorized Android Meterpreter post module
- `index.html`, `viewer.js`, `manual.html`: browser and its built-in help
- `demo.py`, `replay.py`: synthetic history and local-only HTTP rehearsal
- `vendor_leaflet.py`: installs the pinned, checksum-verified Leaflet distribution
- `docs/data-contracts.md`: persisted observations and source/run semantics
- `docs/api.md`: request, history and pagination reference
- `tests/`: Python `unittest`, Ruby Minitest, and Node.js built-in tests

## Test commands

```sh
make check          # All Python, Ruby and JavaScript suites; missing tools fail
make check-viewer   # JavaScript tests only
make check-deploy   # Real Docker Compose: builds and uses disposable resources
```

`make check-deploy` creates its own temporary Compose project and data; **do
not start the normal Compose service as a prerequisite**. Docker itself is a
required dependency for this test, not for normal unit tests. The test
checks loopback-only port publishing, authentication, persistence over
restart, SQLite file permissions, and restore of an offline backup.

Use `make` to fetch and verify Leaflet assets locally before running the
browser. The checked-in Python, Ruby, and JavaScript source is sufficient to
run `make check` without network access or map tiles. No real GPS positions
or access tokens belong in test fixtures or issues.

For a new regression, write the smallest test that reproduces the observed
failure first. Preserve the existing HTTP response shapes and SQLite data
when changing code. Schema changes must support stored records from earlier
supported schema versions, and tests must include migration and rollback.

The in-app `/help` page is for someone reading the map, not development
instructions. See [the synthetic walkthrough](walkthrough.md) for a manual
browser test and [operations](operations.md) for backups and deployment.
