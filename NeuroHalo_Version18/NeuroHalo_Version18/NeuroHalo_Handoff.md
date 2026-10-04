# NeuroHalo Handoff Document

**Project:** NeuroHalo helmet-impact monitoring system  
**Use case:** Bicycle and sports helmet impact awareness  
**Date:** October 3, 2026  
**Current hardware:** HiLetgo ESP-32S development board with ESP-32D module, MPU-6050 breakout, portable USB charger  
**Current website:** Private NeuroHalo prototype site  

## 1. Product purpose

NeuroHalo is a small helmet-mounted gadget that records candidate impact events and makes the records available through a phone-friendly website. The rider should be able to review when an event occurred, where it occurred, the motion recorded by the device, the time since a previous recorded event, the area of the head they remember being hit, and their notes.

The system is intended to improve awareness and preserve information for discussion with a qualified professional. It does not diagnose concussion, determine whether an athlete is safe to continue, measure force on the brain, or replace medical judgment.

## 2. Required system architecture

The authoritative data path is:

```text
MPU-6050 → ESP32 → local event file folder → local backend API → phone browser
             │              ▲
             └─ offline queue┘
```

The frontend must not contain a file-upload control. The phone browser requests records from the backend. The backend reads the locally stored event files and returns validated records to the frontend.

For the first demonstration, run the backend on a laptop or Raspberry Pi connected to the same Wi-Fi network as the phone. A hosted/private Site cannot directly read files from the team’s laptop. The hosted NeuroHalo page can remain a visual prototype, but live local records require a local server address such as `http://<laptop-ip>:<port>`.

## 3. Current status

### Completed in the current website prototype

- Phone-first NeuroHalo home page
- Research and safety explanation
- Weather card, defaulting to Gainesville
- Recent collision and collision-history views
- Event detail view with acceleration and gyroscope charts
- User-selectable head-impact area
- Location, time, notes, event classification, and time-since-previous-event fields
- MPU-6050 clipping and measurement-limitation labels
- Demo records, manual records, browser-local prototype storage, backup/export, and printable report flow
- Private published prototype URL: `https://neurohalo.jeanpaololobelo.chatgpt.site`

### Required changes for the final architecture

- Remove the frontend JSON/CSV upload UI from the live local version
- Replace browser-local event storage with backend `GET` requests
- Add the backend folder watcher or file reader
- Add an ESP32 Wi-Fi event endpoint or file-transfer protocol
- Implement offline storage and retry on the ESP32
- Define the laptop/Raspberry Pi startup command and local network address
- Test the complete path from a generated ESP32 file to a phone browser

Do not describe the hosted prototype as live hardware-connected until this path has been tested.

## 4. Hardware connections

Use the ESP32 as the I²C master and the MPU-6050 as the sensor:

| MPU-6050 | ESP32-32S label | Purpose |
|---|---|---|
| VCC | 3V3 | Sensor power |
| GND | GND | Common ground |
| SDA | GPIO21 / P21 | I²C data |
| SCL | GPIO22 / P22 | I²C clock |
| AD0 | GND | I²C address `0x68` |
| INT | GPIO27 / P27 | Optional data-ready interrupt |
| XDA, XCL | Leave disconnected | Auxiliary sensor bus |

Use 3.3 V logic. Confirm the breakout board’s regulator and pull-up arrangement before connecting power. The board shown is a common GY-521-style MPU-6050 breakout with unsoldered connection holes, so soldered header pins or direct soldered wires are needed for a reliable wearable prototype.

The ESP32 development board is larger than the ESP-32D radio module. Measure the complete development board, including headers, before CAD enclosure work. Leave access to USB, EN/reset, and BOOT/IO0. Keep the MPU-6050 rigidly attached inside the enclosure so it cannot move relative to the helmet-mounted case.

## 5. MPU-6050 limits

The MPU-6050 accelerometer supports selectable ranges of ±2 g, ±4 g, ±8 g, and ±16 g per axis. The first prototype should use the highest available range, ±16 g, and record the configured range in every event.

The system records acceleration and angular velocity. It does not directly measure force. Do not calculate force with `F = ma` using the rider’s body mass or an assumed head mass. Helmet motion is not the same as force delivered to the head or brain.

When an axis reaches or approaches the configured limit, set an acceleration-clipping flag and display **“Sensor range exceeded — true peak unknown.”** A recorded peak may also miss a brief event because of sampling rate, filtering, mounting, or sensor bandwidth.

If the team must measure impacts substantially above 16 g, consider adding a high-g accelerometer breakout such as the ADXL375, which supports up to ±200 g per axis. That sensor still requires calibration, appropriate mounting, high-rate capture, and careful interpretation.

## 6. ESP32 firmware responsibilities

The ESP32 firmware should:

1. Initialize the MPU-6050 over I²C and verify its identity
2. Configure acceleration range, gyroscope range, output rate, and filtering
3. Record the achieved sampling rate and sensor configuration
4. Maintain a short pre-trigger ring buffer
5. Detect a candidate impact using an adjustable demonstration threshold
6. Capture a bounded post-trigger window
7. Save one complete event file to local flash or a microSD card
8. Mark clipped axes, dropped samples, FIFO overruns, and timing faults
9. Attempt Wi-Fi transfer when connected
10. Keep unsent files in an offline queue when Wi-Fi is unavailable
11. Retry queued files after Wi-Fi reconnects
12. Delete or archive a local file only after the backend confirms successful receipt

Do not write every sensor sample directly to flash. Use RAM buffering and write one completed event at a time. Use a monotonically increasing event ID and a boot/session ID so timer resets do not merge records.

## 7. Offline queue behavior

Recommended file states:

```text
pending/      event is complete and waiting to send
sending/      temporary state during transfer
sent/         optional archive after backend confirmation
failed/       optional state after repeated permanent failure
```

The simplest version can keep all complete unsent files in `pending/` and move them to `sent/` after a successful HTTP response. Use atomic file creation: write to `event.tmp`, close and flush it, then rename it to `event.json`. The backend must never read a partially written file.

Use a retry policy such as 1 second, 5 seconds, 30 seconds, then one minute with a maximum retry interval. Retry connection failures and HTTP 5xx responses. Do not endlessly retry malformed files or HTTP 4xx responses without logging the error.

## 8. Backend responsibilities

The backend should run on the laptop or Raspberry Pi and provide:

### `GET /api/health`

Returns server status, data-folder path, number of available event files, and the server time.

### `GET /api/events`

Reads event files from the local data folder, validates them, sorts them by incident time, and returns event summaries. Support query parameters for `from`, `to`, and `classification`.

### `GET /api/events/:eventId`

Returns one validated event, including samples, metadata, clipping flags, location, head region, and user notes.

### `POST /api/events`

Accepts one event JSON file from the ESP32. Validate schema, event ID, sample ordering, numeric ranges, and file size before saving. Return `201 Created` for a new event and `200 OK` for an already-known event ID. Duplicate requests must be idempotent.

### `POST /api/events/:eventId/ack`

Optional endpoint that allows the ESP32 to confirm the backend has persisted the file before the ESP32 moves it from `pending/` to `sent/`. A successful `POST /api/events` response can serve as the acknowledgment for the MVP.

### `PATCH /api/events/:eventId/annotations`

Updates user-entered fields such as location label, head region, classification, and notes. Keep raw sensor samples immutable. Write annotation changes atomically.

The backend must reject path traversal, arbitrary filenames, non-JSON files, oversized payloads, malformed records, nonfinite numbers, unsupported schema versions, and samples with non-increasing timestamps. Use event IDs as stored filenames or map them to safe generated filenames; never concatenate unsanitized user input into a filesystem path.

## 9. Data contract

JSON envelope:

```json
{
  "schema_version": 1,
  "events": [
    {
      "event_id": "helmet-001-session-000014",
      "device_id": "neurohalo-helmet-01",
      "boot_session_id": "boot-2026-10-03-001",
      "source": "device",
      "sensor_model": "MPU-6050",
      "firmware_version": "0.1.0",
      "accel_range_g": 16,
      "gyro_range_dps": 2000,
      "sample_rate_hz": 500,
      "filter_configuration": "Document the selected DLPF setting",
      "incident_time_utc": "2026-10-03T19:00:00.000Z",
      "time_source": "NTP synchronized",
      "device_event_time_us": 18234000,
      "threshold_g": 3,
      "event_duration_ms": 42,
      "recorded_peak_resultant_g": 8.4,
      "accel_clipped_axes": [],
      "gyro_clipped_axes": [],
      "dropped_sample_count": 0,
      "timing_quality": "No overruns detected",
      "location": {
        "label": "Hawthorne Trail, Gainesville",
        "latitude": null,
        "longitude": null,
        "source": "User entered"
      },
      "head_region": "Unknown",
      "user_classification": "Candidate impact",
      "user_notes": "",
      "samples": [
        {
          "t_us": -20000,
          "ax_g": 0.02,
          "ay_g": -0.04,
          "az_g": 0.98,
          "gx_dps": 1.2,
          "gy_dps": -0.5,
          "gz_dps": 0.4
        }
      ]
    }
  ]
}
```

Acceleration is in g and includes gravity. Gyroscope values are in degrees per second. `t_us` is time relative to the event trigger and must increase strictly. A nullable incident time is valid when the device clock was not synchronized. Import time must not be substituted for incident time.

## 10. Frontend changes

The final local frontend should:

- Fetch `/api/events` on the history page
- Fetch `/api/events/:eventId` on the detail page
- Poll or refresh manually after an ESP32 transfer
- Show a backend connection state: Connected, Waiting for local backend, or Backend error
- Remove “Import data” and all browser file input controls
- Remove IndexedDB as the authoritative record store
- Keep the research homepage, weather, recent collision, history, charts, head-area selection, notes, and printable report
- Send annotation changes to `PATCH /api/events/:eventId/annotations`
- Show that force is not measured and that clipped peaks are unknown
- Provide a small local-backend setup panel containing the backend address and health status

The frontend should not expose a cloud bucket as the primary data source. Cloud synchronization can be added later behind the backend after local transfer is reliable.

## 11. Local run model

Recommended demo arrangement:

```text
Laptop or Raspberry Pi
  ├── NeuroHalo backend, listening on 0.0.0.0:<port>
  ├── static frontend files
  └── data/events/*.json

ESP32 + MPU-6050  ── Wi-Fi ──>  laptop/Raspberry Pi

Phone ── same Wi-Fi ──> http://<laptop-ip>:<port>
```

The team must choose one backend language and keep it simple. A small Python FastAPI/Flask or Node Express server is sufficient for the prototype. The chosen server must bind to the laptop’s LAN interface, not only `localhost`, so the phone can reach it. The operating-system firewall may need a rule for the selected port.

Do not expose the server to the public internet during the designathon. If the team later adds cloud access, use authentication and a private API; never place cloud credentials in the ESP32 firmware or browser JavaScript.

## 12. Test plan

### Backend tests

- Health endpoint responds when data folder exists
- Empty data folder returns an empty event list
- Valid event file appears in `GET /api/events`
- Invalid JSON is rejected without deleting existing records
- Duplicate `POST` does not create a second record
- Partial `.tmp` files are ignored
- Path traversal and unsupported extensions are rejected
- Clipped acceleration remains flagged
- Samples with duplicate or decreasing timestamps are rejected
- Annotation updates preserve raw samples

### ESP32 tests

- MPU identity read succeeds
- Axis values change when the board is rotated
- Event trigger stores a complete file
- Wi-Fi transfer succeeds when connected
- Event remains in `pending/` while Wi-Fi is absent
- Event sends after Wi-Fi reconnects
- Power interruption does not create a readable partial event
- Full storage condition is visible to the user

### End-to-end demonstration

1. Start the backend with an empty local data folder
2. Open the site on a phone using the laptop’s LAN address
3. Generate a controlled fixture event without a person wearing the helmet
4. Confirm the ESP32 creates an event file
5. Disconnect Wi-Fi and create a second event
6. Confirm the second event remains queued
7. Reconnect Wi-Fi and confirm it transfers automatically
8. Refresh the phone history and open both records
9. Add a location, note, and remembered head region
10. Show acceleration, gyro data if available, time since the prior event, and any clipping warning

## 13. Safety and claims

Use a padded fixture or dedicated test headform for impacts. Do not conduct human impact tests. Do not drill the helmet shell or cut protective foam. A strap-mounted enclosure must be lightweight, rounded, securely retained, and positioned so it does not interfere with the helmet fit or protective padding.

Use the terms **candidate impact**, **recorded acceleration**, **sensor range exceeded**, and **user-reported head area**. Avoid **concussion detected**, **safe**, **unsafe**, **brain force**, or **injury severity**.

The CDC notes that concussion symptoms may take hours or days to appear. A sensor reading cannot clear a rider to continue. If danger signs appear after a head impact, follow emergency medical guidance.

## 14. Immediate ownership checklist

- **Embedded team:** I²C bring-up, event capture, file schema, offline queue, Wi-Fi retry, and battery behavior
- **Backend team:** local folder reader, upload endpoint, validation, annotations, health endpoint, and phone-network setup
- **Frontend team:** replace browser import flow with API reads, connection status, refresh behavior, and annotation API calls
- **CAD/mechanical team:** compact case, strap slots, board retention, USB access, battery retention, and safe rounded edges
- **Presentation team:** explain the awareness use case, demonstrate one transferred event, state MPU-6050 range limits, and avoid medical claims

## 15. Definition of done for the designathon

The project is ready for the presentation when one real or controlled fixture event travels from MPU-6050 to ESP32, becomes a local file, transfers over Wi-Fi to the local backend, appears in the phone history, and opens with its waveform and metadata. The team must also demonstrate one offline-queued event that transfers after Wi-Fi returns.

The hosted visual prototype can support the story and interface demonstration, but it should be described as a prototype until the local backend path has passed the end-to-end test above.

