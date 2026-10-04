# NeuroHalo (Version 4)

## Quick start

1. Upload `helmet_monitor_v3.ino` (v3.1) to the XIAO nRF52840 Sense.
2. Run `python server.py` in this folder.
3. Open http://localhost:8000 in **Chrome or Edge**. On a laptop you see the phone app first;
   **Open website** shows the same app full size.
4. Tap **Connect helmet** and pick **HelmetMonitor** (only once; it reconnects by itself).
5. On the **Helmet** tab, put the helmet on (or hold it as worn) and tap **Set upright**.
6. **Start ride**. Hard and moderate impacts during the ride are saved. **End ride** opens a short
   check-in (where it hurts, symptoms, notes), then the ride report.

Graphs: each impact shows its jolt strength and head turning; each ride has a timeline; History
shows impacts per ride. Reporting levels are not an injury assessment.

---


A redesigned, responsive helmet-motion dashboard and a working file-backed Python backend. This is a local application: the Python server serves both the frontend and API. It needs no npm install, CDN chart library, cloud database, or frontend upload control.

## Start

Requires Python 3.10 or newer.

1. Extract this ZIP.
2. Open a terminal in the extracted `neurohalo-v2` folder.
3. Run `python server.py` (or `python3 server.py` on macOS/Linux).
4. Open **http://localhost:8000** on the laptop.
5. For a phone, join the same Wi-Fi and open **http://<laptop-ip>:8000**.

The default server binds to `0.0.0.0:8000`. If necessary, allow Python through the laptop firewall on a private network. The Wi-Fi or hotspot must permit device-to-device traffic; do not assume every hotspot does. The phone cannot use `localhost` to reach your laptop.

The server is intended for a trusted local demonstration network. It has no user login or device authentication and should not be exposed publicly. Cross-origin browser writes are rejected. Wi-Fi passwords and private credentials are not included in this package.

Optional settings:

```sh
python server.py --port 8000 --data-dir ./data/events
```

## What changed

- Sage, forest-green, and lime visual design with desktop sidebar and mobile navigation.
- Overview with recent events, clipping counts, and current weather.
- Searchable history with date and classification filters.
- Separate simulated collection; demo edits are session-only and never posted to the backend.
- Acceleration and gyro charts retain every sample, with explicit clipping warnings.
- User-reported head-area selector, editable location/coordinates/notes, JSON export, and printable report.
- Backend connection state, stale-record notice after connection loss, and manual refresh.
- No file-upload controls and no IndexedDB record storage.
- Sensor files are authoritative; annotations are stored separately and never rewrite raw samples.
- No fabricated helmet-online state: the API reports backend availability only.

## Try the file-transfer path without a helmet

The example is clearly marked `source: simulated`. It is not real sensor data.

With the server running, execute in a second terminal:

### Windows PowerShell

```powershell
curl.exe -X POST http://localhost:8000/api/events -H "Content-Type: application/json" --data-binary "@examples/simulated-event.json"
```

### macOS / Linux

```sh
curl -X POST http://localhost:8000/api/events \
  -H 'Content-Type: application/json' \
  --data-binary @examples/simulated-event.json
```

Expected acknowledgment:

```json
{"event_id":"fixture-001","persisted":true,"duplicate":false}
```

Press **Refresh** in the website. Open the record, inspect its waveform, edit a note, and save. Refresh or restart the server: the event and annotation persist. Posting the same file again returns HTTP 200 with `duplicate: true` and preserves annotations.

For a file-folder test, place one complete event JSON file in `data/events/`, named exactly `<event_id>.json`, then refresh. The reader accepts a bare versioned event or a version-1 envelope containing exactly one event. Write to a `.tmp` file and rename it only after writing finishes. Temporary files are ignored. Malformed `.json` files are skipped and counted in Connection.

## Storage layout

```text
neurohalo-v2/
  server.py
  dist/                       frontend, served by Python
  data/events/<event_id>.json  raw records (created at runtime)
  data/events-annotations/    separate editable annotations
  examples/simulated-event.json
  tests/
```

Raw data folders are not exposed as static directories. Back up both runtime folders together. No destructive delete interface is included.

## HTTP contract

| Request | Purpose | Result |
|---|---|---|
| `GET /api/health` | Backend and storage status | service, count, invalid-file count, folder, server time |
| `GET /api/events` | Read saved event summaries | `{schema_version:1,events:[...],invalid_file_count:n}` |
| `GET /api/events/{event_id}` | Read full event and annotations | One event with samples |
| `POST /api/events` | ESP32 sends one complete JSON event | 201 new; 200 identical retry; 409 conflicting sensor record |
| `PATCH /api/events/{event_id}/annotations` | Save user context | Updated full event |

List filters: `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, `classification=...`. API date filters use UTC; the interface filters displayed dates in the browser's local timezone. Unknown incident times remain unknown and are excluded by bounded date filters.

POST requires `Content-Type: application/json`, a `Content-Length`, and at most 5 MiB. Chunked encoding is not supported. Maximum 20,000 samples per event. Use globally unique event IDs composed of letters, digits, `_`, and `-`; include device and boot/session identifiers. IDs are at most 150 characters and start with a letter or digit. See `examples/simulated-event.json` for the complete contract.

A successful POST responds only after writing, flushing, and atomically replacing the destination file. Repeated IDs with different immutable data return 409; they do not overwrite existing data. Keep rejected files on the ESP32 for diagnosis.

PATCH only accepts `location`, `head_region`, `user_classification`, and `user_notes`. Raw sensor fields are immutable. A 200 response confirms saved annotations. Demo edits do not call PATCH.

To update the original hosted URL, the account owning that Site must provide editing access. Its project could not be accessed in this session. Running this local package does not change the hosted site.

## Verification

Run backend integration tests:

```sh
python -m unittest discover -s tests -p "test_*.py"
```

Optional frontend checks require Node.js (runtime is otherwise unnecessary):

```sh
node --check dist/app.js
node --check dist/core.js
node tests/frontend.test.mjs
```

Backend integration tests cover actual HTTP upload/read, restart persistence, duplicate acknowledgments, conflicting IDs, immutable raw files, annotation persistence, timestamps, invalid samples, clipping, invalid/partial files, origin restrictions, payload limits, and static-file isolation. Frontend tests use a lightweight DOM stub and mocked fetch to check rendering, summary/detail requests, waveform output, demo separation, and offline-state behavior.

No visual browser QA, real-phone networking, real ESP32 transfer, or firmware-offline test was possible in this session. Layout uses responsive CSS but should be inspected on your phone before presenting. Clinical performance is not validated.

## Credits and project notes

Cycling photograph retained from the supplied source: Ovidiu Perța / Unsplash, https://unsplash.com/photos/a-man-riding-a-bike-down-a-curvy-road-sK_9OsyO93g.

Weather uses Open-Meteo and requires internet access. Only weather location is stored in browser localStorage; event records come from the backend. Location is sent to Open-Meteo for weather and is never retroactively attached to events. System fonts and inline SVG charts allow the core interface to work without internet access.

`NeuroHalo_Handoff.md` is the original handoff, retained as project context. This README describes the delivered implementation and remaining work.

## Open on your phone (free https link)

1. One time: download `cloudflared-windows-amd64.exe` from
   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
   rename it to `cloudflared.exe` and put it next to `server.py`.
2. Run `python server.py`. It prints a `https://….trycloudflare.com` phone link after a few seconds.
3. In the app click **Open on phone** (top right on the laptop, or Helmet tab → Show QR) and scan the QR code.
   Android: Chrome. iPhone: the free Bluefy browser (Safari has no Web Bluetooth).
The link changes every time the server restarts, and anyone with it can open the app (no login).
Run `python server.py --no-phone` to skip the link.
