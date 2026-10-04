// =====================================================================
// NeuroHalo - XIAO nRF52840 Sense RTOS Helmet Impact Monitor  (v3.5)
//
// New in v3.5 (offline recording):
//   - Keeps up to 30 moderate/hard impacts while the app is out of range (was 5).
//   - The app confirms each impact it receives (command 3 + event ID). On reconnect only
//     the unconfirmed ones are sent again, so catching up is quick. If no confirmation
//     arrives within 20 s while connected, it is sent again (up to 3 tries per connection).
//   - When full, the oldest CONFIRMED impact is replaced first.
//   - Impacts live in memory: they survive Bluetooth drops, not a power-off or a reset.
//   - Command 4 = "new ride": wipes the saved impacts so every ride starts with all 30 slots free.
//
// New in v3.4 (telling road bumps from real hits):
//   1. SHARPNESS: real hits shoot up in a few ms; bumps come through the arms and neck
//      and build up slowly. A slow, soft jolt with little head spin is treated as a bump.
//   3. HEAD SPIN: a sharp jolt with a big head spin counts as MODERATE even a bit below 8 g.
//   (Hard hits, maxed-out readings and suspected crashes are never filtered.)
// Road-adjusted threshold:
//   - The helmet tracks how shaky the last ~2 s of riding were ("road roughness").
//     Smooth pavement: stays sensitive. Gravel / cobbles: a hit must stand out clearly
//     above the background shaking before it counts, and before it is called MODERATE.
//   - Safety limits: the bar can rise by at most ROUGH_MAX_EXTRA_G, and HARD (12 g),
//     accelerometer-maxed hits and suspected crashes are NEVER raised or hidden.
//
// New in v3.3 (live graph):
//   - The moment ANY hit happens (light ones flagged 0x10), a quick "impact now" ping (EventSummary on
//     5f8d0003) goes to the app, so the live graph spikes right away. The full recording
//     still follows after the crash check (about 10 s later), same as before.
//
// New in v3.2 (battery use):
//   - Status messages only go to USB when a computer is listening (printing with no
//     computer attached could freeze the board on a battery or power bank).
//   - Keeps advertising after a Bluetooth drop so the app can always reconnect.
//
// New in v3.1 (fewer false crashes):
//   - A crash needs the helmet to be UPRIGHT BEFORE the hit and TILTED AFTER it.
//     A board already lying on a desk can no longer trigger a crash.
//   - One-sample spikes (desk taps, glitches) are ignored: a hit must last 2+ samples.
//   - App commands on 5f8d0007: 1 = set upright position now, 2 = "I'm OK" (cancel countdown)
//
// Board:     "Seeed XIAO BLE Sense - nRF52840" (Seeed nRF52 mbed-enabled Boards)
// Libraries: "Seeed Arduino LSM6DS3", "ArduinoBLE"
//
// New in v3:
//   - Every impact gets a REPORTING PRIORITY: LOW / MEDIUM / HIGH
//     Only MEDIUM and HIGH events are stored and sent. LOW events are dropped.
//     (Reporting priority = how worth-reviewing a recording is. NOT injury severity.)
//   - Priority waits for the crash check (tilted + still) before it is decided
//   - Random boot ID (heartbeat) so event IDs never collide across restarts
//   - Each raw event starts with a 20-byte META packet (index 0xFF) for ble_bridge.py
//
// From v2:
//   1. Fixed __attribute__((packed)) on EventSummary (31 bytes)
//   2. Live preview timestamp is now milliseconds (matches existing websites)
//   3. Raw event window is sent too (one sample per BLE packet, 20 bytes)
//   4. Heartbeat every 3 s (battery, crash state, tilt, pending events)
//   5. Last 5 events are stored and re-sent when a website (re)connects
//   6. On-device crash decision: impact -> tilted -> still -> 30 s countdown
//   7. IMU output rate 833 Hz (we read at ~416 Hz, so every read is fresh)
//      + accel anti-alias filter widened to 400 Hz so short impacts aren't smoothed
//   8. Block Data Update enabled (a read never mixes two samples)
//   9. Mounting calibration: "up" = average gravity during the first second
//      -> POWER ON WITH THE HELMET UPRIGHT AND STILL
//
// Prototype thresholds only. NOT medical / concussion thresholds.
// =====================================================================

#include <Arduino.h>
#include <ArduinoBLE.h>
#include "LSM6DS3.h"
#include "Wire.h"
#include "mbed.h"

using namespace rtos;
using namespace std::chrono_literals;

// Print to USB only when a computer has the Serial Monitor open. On a battery or power bank
// nobody is listening, and writing anyway can block the program.
struct SafeLog {
  template <typename... A> void print(A... a)   { if (Serial) Serial.print(a...); }
  template <typename... A> void println(A... a) { if (Serial) Serial.println(a...); }
} LOG;

// =====================================================================
// SETTINGS
// =====================================================================

// Sending
const bool     SEND_LIVE_PREVIEW = false;  // true = also stream live data at 20 Hz (testing)
const uint32_t LIVE_INTERVAL_MS   = 50;
const uint32_t HEARTBEAT_MS       = 3000;
const uint32_t RAW_CHUNK_GAP_MS   = 15;    // pause between raw-event packets (slower = more reliable)

// Impact trigger
const float TRIGGER_G              = 4.0f;
const float SPIKE_ABOVE_BASELINE_G = 2.5f;
const float BASELINE_ALPHA         = 0.005f;

// Road-adjusted threshold (v3.4) - prototype values, tune with a bumpy ride + drop tests
const float ROUGH_WINDOW_S     = 2.0f;   // how many seconds of riding "roughness" looks back over
const float ROUGH_K            = 4.0f;   // a hit must be this many x the road shaking above normal
const float ROUGH_MAX_EXTRA_G  = 3.0f;   // the bar never rises more than this (real hits still count)
const float ROUGH_SMOOTH_G     = 0.15f;  // shaking below this = smooth road, no change at all

// Sharpness + head spin (v3.4) - prototype values
const float SHARP_RISE_MS      = 15.0f;  // reaches its peak this fast = sharp, hit-like
const float SOFT_RISE_MS       = 30.0f;  // takes this long or longer = soft, bump-like
const float SPIN_SUPPORT_DPS   = 300.0f; // head turning this fast during the jolt = hit-like
const float SPIN_ASSIST_G      = 6.0f;   // sharp + spinning hits count as MODERATE from here

// Crash decision (after an impact)
const float    CRASH_TILT_DEG   = 60.0f;   // head ends up this far from upright
const float    STILL_GYRO_DPS   = 30.0f;   // "still" = rotating slower than this
const float    STILL_G_TOL      = 0.25f;   //          and total g within 1 +/- this
const uint32_t STILL_MS         = 2000;    // must stay tilted + still this long
const uint32_t WATCH_MS         = 10000;   // give up (= just a bump) after this
const uint32_t COUNTDOWN_S      = 30;      // "are you OK?" countdown
const float    UPRIGHT_DEG      = 30.0f;   // auto-cancel if back upright...
const float    UPRIGHT_BEFORE_DEG = 45.0f; // helmet must be roughly upright before the hit
const float    TILT_CHANGE_DEG  = 40.0f;   // ...and end up at least this much more tilted
const int      MIN_IMPACT_SAMPLES = 2;     // ignore one-sample spikes
const uint32_t UPRIGHT_MS       = 2000;    // ...for this long during the countdown

// Reporting priority (prototype values - tune with drop tests)
//   HIGH   : crash suspected (tilted + still after impact), OR peak >= HIGH_PEAK_G,
//            OR accelerometer range exceeded
//   MEDIUM : peak >= MEDIUM_PEAK_G, OR peak rotation >= MEDIUM_GYRO_DPS
//   LOW    : everything else (bumps, potholes) -> NOT reported
const float    MEDIUM_PEAK_G       = 8.0f;
const float    HIGH_PEAK_G         = 12.0f;
const float    MEDIUM_GYRO_DPS     = 1000.0f;
const uint32_t DECISION_TIMEOUT_MS = 15000;   // decide anyway if the crash check never finished

// Optional cancel button: wire between D1 and GND (needs soldering). Harmless if absent.
const int CANCEL_BUTTON_PIN = D1;

// Sampling
const uint32_t SAMPLE_INTERVAL_US = 2404;  // ~416 Hz
const int      CAL_SAMPLES        = 416;   // ~1 s of calibration at boot

// =====================================================================
// IMU + BLE
// =====================================================================

LSM6DS3 myIMU(I2C_MODE, 0x6A);

BLEService helmetService("5f8d0001-8523-4b4e-9c1a-eb1a4c3a1000");

// Same 16-byte layout as before (ms timestamp + 6 x int16)
BLECharacteristic liveDataChar("5f8d0002-8523-4b4e-9c1a-eb1a4c3a1000", BLENotify, 16);
// EventSummary (31 bytes, layout unchanged)
BLECharacteristic eventSummaryChar("5f8d0003-8523-4b4e-9c1a-eb1a4c3a1000", BLENotify, 32);
// NEW: raw event samples, one per packet (20 bytes)
BLECharacteristic eventRawChar("5f8d0005-8523-4b4e-9c1a-eb1a4c3a1000", BLENotify, 20);
// NEW: heartbeat / status (20 bytes)
BLECharacteristic heartbeatChar("5f8d0006-8523-4b4e-9c1a-eb1a4c3a1000", BLERead | BLENotify, 20);
// NEW in v3.1: commands from the app (1 byte): 1 = set upright position, 2 = I'm OK
// Commands from the app: 1 = set upright, 2 = I'm OK, 3 + up to 9 eventIDs (2 bytes each) = "got it", 4 = new ride (wipe) (v3.5)
BLECharacteristic commandChar("5f8d0007-8523-4b4e-9c1a-eb1a4c3a1000", BLEWrite | BLEWriteWithoutResponse, 20);

// =====================================================================
// RTOS
// =====================================================================

Thread imuThread(osPriorityHigh, 4096);
Thread alertThread(osPriorityNormal, 2048);
EventFlags sampleFlags;
EventFlags alertFlags;
mbed::Ticker sampleTicker;

const uint32_t SAMPLE_FLAG = 0x01;
const uint32_t EV_CRASH    = 0x01;
const uint32_t EV_CANCEL   = 0x02;

// =====================================================================
// DATA STRUCTURES
// =====================================================================

struct IMUSample {
  uint32_t timestamp_us;
  int16_t ax, ay, az;   // milli-g
  int16_t gx, gy, gz;   // tenths of deg/s
};

struct __attribute__((packed)) EventSummary {   // 31 bytes
  uint16_t eventID;
  uint32_t triggerTimeMs;
  float peakG;
  float peakGyroDps;
  float peakRotAccelRadS2;
  float hic15Style;
  float deltaV_mps;
  float impactDurationMs;
  uint8_t flags;           // bit0 accel saturated, bit1 gyro saturated
};

struct __attribute__((packed)) RawChunk {       // 20 bytes
  uint16_t eventID;
  uint8_t  index;          // 0 .. count-1
  uint8_t  count;          // samples in this event
  int32_t  offset_us;      // time relative to the trigger sample (negative = before)
  int16_t  ax, ay, az, gx, gy, gz;
};

// First packet of every raw event on 5f8d0005 (marker byte = 0xFF)
struct __attribute__((packed)) EventMeta {      // 20 bytes
  uint16_t eventID;
  uint8_t  marker;         // always 0xFF (raw samples use 0..count-1 here)
  uint8_t  count;          // samples that follow
  uint32_t bootId;
  uint32_t triggerTimeMs;  // device millis() at the trigger
  uint8_t  priority;       // 2 = MEDIUM, 3 = HIGH
  uint8_t  flags;          // bit0 accel saturated, bit1 gyro saturated, bit2 crash suspected
  uint16_t peakG_x100;     // e.g. 1234 = 12.34 g
  uint16_t peakGyroDps;
  uint16_t sampleRateHz;
};

enum Priority : uint8_t { PRI_UNDECIDED = 0, PRI_LOW = 1, PRI_MEDIUM = 2, PRI_HIGH = 3 };

struct __attribute__((packed)) Heartbeat {      // 20 bytes
  uint32_t bootId;
  uint32_t uptimeMs;
  uint16_t batteryMv;      // 0 if not available
  uint8_t  batteryPct;     // 0 if not available
  uint8_t  crashState;     // see CrashState
  int16_t  tiltDeci;       // tilt from upright x10 (e.g. 875 = 87.5 deg)
  uint16_t lastEventID;
  uint8_t  pendingEvents;  // stored but not yet delivered
  uint8_t  flags;          // bit0 calibrated, bit1 live preview on
  uint16_t imuErrors;
};

enum CrashState : uint8_t {
  CS_IDLE = 0,       // normal
  CS_WATCHING = 1,   // impact happened, checking tilt + stillness
  CS_COUNTDOWN = 2,  // crash suspected, counting down
  CS_ALERT = 3,      // countdown finished -> website should send the alert
  CS_CANCELLED = 4   // rider cancelled / sat back up
};

// =====================================================================
// EVENT CAPTURE (shared between IMU thread and loop, guarded by eventReady)
// =====================================================================

const int PRE_SAMPLES = 32;
const int POST_SAMPLES = 48;
const int MAX_EVENT_SAMPLES = PRE_SAMPLES + 1 + POST_SAMPLES;

IMUSample preBuffer[PRE_SAMPLES];
volatile int preWriteIndex = 0;
volatile int preCount = 0;

IMUSample eventBuffer[MAX_EVENT_SAMPLES];
volatile int eventSampleCount = 0;
volatile int triggerIndex = 0;
volatile bool recordingEvent = false;
volatile bool eventReady = false;
volatile int postSamplesRemaining = 0;
volatile uint16_t eventID = 0;
volatile uint32_t triggerMillis = 0;

float baselineG = 1.0f;
float triggerBaselineG = 1.0f;
float roughVar = 0.0f;                 // running average of (shaking)^2 over ~ROUGH_WINDOW_S
volatile float roadRoughG = 0.0f;      // road shaking right now, in g (0 = perfectly smooth)
float triggerRoughG = 0.0f;            // road shaking when the current event started


// =====================================================================
// STORED EVENTS (re-sent on reconnect)
// =====================================================================

const int MAX_STORED = 30;      // ~1.4 KB each

struct StoredEvent {
  bool valid;
  bool sent;
  bool acked;              // the app confirmed it has it (v3.5)
  uint8_t tries;           // sends this connection without a confirmation
  uint32_t sentAtMs;
  uint8_t priority;        // PRI_UNDECIDED until the crash check finishes
  bool crashSuspected;
  uint32_t storedAtMs;
  uint32_t seq;
  EventSummary summary;
  float roughG;            // road shaking when it happened
  float riseMs;            // how fast it reached its peak (small = sharp)
  int count;
  int trigIdx;
  IMUSample samples[MAX_EVENT_SAMPLES];
};

StoredEvent stored[MAX_STORED];
uint32_t storedSeq = 0;

// How much the bar is raised for a given road shaking level (0 on smooth roads)
float roadExtraG(float rough) {
  float extra = ROUGH_K * (rough - ROUGH_SMOOTH_G);
  return constrain(extra, 0.0f, ROUGH_MAX_EXTRA_G);
}

float mediumThresholdFor(float rough);   // defined further down

// MODERATE cut-off on this road (HARD_PEAK_G is never raised)


int sendingSlot = -1;      // which stored event is being sent (-1 = none)
int sendingIndex = 0;      // -1 = META packet next, then raw samples 0..count-1
uint32_t bootId = 0;
uint32_t lastChunkMs = 0;

// =====================================================================
// SHARED LIVE STATE
// =====================================================================

IMUSample latestSample;
Mutex latestSampleMutex;
volatile bool latestSampleValid = false;

volatile uint8_t crashState = CS_IDLE;
volatile float currentTiltDeg = 0.0f;
volatile bool calibrated = false;
volatile bool recalibrateRequested = false;
volatile float triggerTilt = 0.0f;   // tilt just before the last impact

volatile uint32_t totalSamples = 0;
volatile uint32_t imuReadErrors = 0;

// Gravity tracking for tilt (only used inside the IMU thread)
float upX = 0, upY = 0, upZ = 1;            // calibrated "up"
float gravX = 0, gravY = 0, gravZ = 1;      // smoothed gravity
const float GRAV_ALPHA = 0.05f;

// =====================================================================
// ISR + HELPERS
// =====================================================================

void sampleTickerISR() { sampleFlags.set(SAMPLE_FLAG); }
void cancelButtonISR() { alertFlags.set(EV_CANCEL); }   // EventFlags are ISR-safe

bool readIMUFast(IMUSample &s) {
  uint8_t raw[12];
  s.timestamp_us = micros();
  if (myIMU.readRegisterRegion(raw, LSM6DS3_ACC_GYRO_OUTX_L_G, 12) != IMU_SUCCESS) {
    imuReadErrors++;
    return false;
  }
  int16_t rGX = (int16_t)(((uint16_t)raw[1] << 8) | raw[0]);
  int16_t rGY = (int16_t)(((uint16_t)raw[3] << 8) | raw[2]);
  int16_t rGZ = (int16_t)(((uint16_t)raw[5] << 8) | raw[4]);
  int16_t rAX = (int16_t)(((uint16_t)raw[7] << 8) | raw[6]);
  int16_t rAY = (int16_t)(((uint16_t)raw[9] << 8) | raw[8]);
  int16_t rAZ = (int16_t)(((uint16_t)raw[11] << 8) | raw[10]);

  s.ax = (int16_t)(myIMU.calcAccel(rAX) * 1000.0f);
  s.ay = (int16_t)(myIMU.calcAccel(rAY) * 1000.0f);
  s.az = (int16_t)(myIMU.calcAccel(rAZ) * 1000.0f);
  s.gx = (int16_t)(myIMU.calcGyro(rGX) * 10.0f);
  s.gy = (int16_t)(myIMU.calcGyro(rGY) * 10.0f);
  s.gz = (int16_t)(myIMU.calcGyro(rGZ) * 10.0f);
  return true;
}

float getTotalG(const IMUSample &s) {
  float ax = s.ax / 1000.0f, ay = s.ay / 1000.0f, az = s.az / 1000.0f;
  return sqrtf(ax * ax + ay * ay + az * az);
}

float getTotalGyro(const IMUSample &s) {
  float gx = s.gx / 10.0f, gy = s.gy / 10.0f, gz = s.gz / 10.0f;
  return sqrtf(gx * gx + gy * gy + gz * gz);
}

void addToPreBuffer(const IMUSample &s) {
  preBuffer[preWriteIndex] = s;
  preWriteIndex = (preWriteIndex + 1) % PRE_SAMPLES;
  if (preCount < PRE_SAMPLES) preCount++;
}

void startEvent(const IMUSample &triggerSample) {
  eventID++;
  eventSampleCount = 0;
  int oldest = (preWriteIndex - preCount + PRE_SAMPLES) % PRE_SAMPLES;
  for (int i = 0; i < preCount; i++) {
    eventBuffer[eventSampleCount++] = preBuffer[(oldest + i) % PRE_SAMPLES];
  }
  triggerIndex = eventSampleCount;
  eventBuffer[eventSampleCount++] = triggerSample;
  triggerBaselineG = baselineG;
  triggerRoughG = roadRoughG;
  triggerMillis = millis();
  postSamplesRemaining = POST_SAMPLES;
  recordingEvent = true;
}

// =====================================================================
// HIGH PRIORITY IMU TASK
// =====================================================================

void imuTask() {
  float calX = 0, calY = 0, calZ = 0;
  int calN = 0;
  uint32_t watchStartMs = 0, stillStartMs = 0, uprightStartMs = 0;
  IMUSample firstAbove;          // first sample of a possible impact
  int aboveCount = 0;

  while (true) {
    sampleFlags.wait_any(SAMPLE_FLAG);

    if (recalibrateRequested) {    // app asked: "this is upright now"
      recalibrateRequested = false;
      calibrated = false;
      calX = calY = calZ = 0; calN = 0;
      if (crashState == CS_WATCHING) crashState = CS_IDLE;
    }

    IMUSample sample;
    if (!readIMUFast(sample)) continue;
    totalSamples++;

    latestSampleMutex.lock();
    latestSample = sample;
    latestSampleValid = true;
    latestSampleMutex.unlock();

    float ax = sample.ax / 1000.0f, ay = sample.ay / 1000.0f, az = sample.az / 1000.0f;
    float currentG = getTotalG(sample);
    float currentGyro = getTotalGyro(sample);
    uint32_t nowMs = millis();

    // ---------------- 9. Mounting calibration (first ~1 s) ----------------
    if (!calibrated) {
      calX += ax; calY += ay; calZ += az; calN++;
      if (calN >= CAL_SAMPLES) {
        float n = sqrtf(calX * calX + calY * calY + calZ * calZ);
        if (n > 0.5f) { upX = calX / n; upY = calY / n; upZ = calZ / n; }
        gravX = upX; gravY = upY; gravZ = upZ;
        calibrated = true;
      }
      continue;   // no detection until calibrated
    }

    // ---------------- Tilt from calibrated "up" ----------------
    gravX += GRAV_ALPHA * (ax - gravX);
    gravY += GRAV_ALPHA * (ay - gravY);
    gravZ += GRAV_ALPHA * (az - gravZ);
    float gn = sqrtf(gravX * gravX + gravY * gravY + gravZ * gravZ);
    float tilt = 0.0f;
    if (gn > 0.1f) {
      float c = (gravX * upX + gravY * upY + gravZ * upZ) / gn;
      tilt = acosf(constrain(c, -1.0f, 1.0f)) * RAD_TO_DEG;
    }
    currentTiltDeg = tilt;
    bool still = currentGyro < STILL_GYRO_DPS && fabsf(currentG - 1.0f) < STILL_G_TOL;

    // ---------------- 6. Crash decision ----------------
    if (crashState == CS_WATCHING) {
      if (tilt > CRASH_TILT_DEG && tilt - triggerTilt > TILT_CHANGE_DEG && still) {
        if (!stillStartMs) stillStartMs = nowMs;
        if (nowMs - stillStartMs >= STILL_MS) {
          crashState = CS_COUNTDOWN;
          uprightStartMs = 0;
          alertFlags.set(EV_CRASH);
        }
      } else {
        stillStartMs = 0;
      }
      if (crashState == CS_WATCHING && nowMs - watchStartMs > WATCH_MS) {
        crashState = CS_IDLE;           // kept moving / stayed upright = bump
      }
    } else if (crashState == CS_COUNTDOWN) {
      // Auto-cancel if the rider is back upright for a while
      if (tilt < UPRIGHT_DEG) {
        if (!uprightStartMs) uprightStartMs = nowMs;
        if (nowMs - uprightStartMs >= UPRIGHT_MS) alertFlags.set(EV_CANCEL);
      } else {
        uprightStartMs = 0;
      }
    }

    // ---------------- Event capture ----------------
    if (eventReady) continue;   // loop() is still analyzing the last event

    if (recordingEvent) {
      if (eventSampleCount < MAX_EVENT_SAMPLES) eventBuffer[eventSampleCount++] = sample;
      if (--postSamplesRemaining <= 0) {
        recordingEvent = false;
        eventReady = true;
        // Only check for a crash if the helmet was upright before the hit
        if (crashState == CS_IDLE && triggerTilt < UPRIGHT_BEFORE_DEG) {
          crashState = CS_WATCHING;
          watchStartMs = nowMs;
          stillStartMs = 0;
        }
      }
      continue;
    }

    float extra = roadExtraG(roadRoughG);          // 0 on smooth roads, up to ROUGH_MAX_EXTRA_G on rough ones
    bool above = currentG >= TRIGGER_G + extra && currentG >= baselineG + SPIKE_ABOVE_BASELINE_G + extra;
    if (above) {
      if (++aboveCount < MIN_IMPACT_SAMPLES) {   // wait: is it more than a single spike?
        if (aboveCount == 1) { firstAbove = sample; triggerTilt = tilt; }
        continue;
      }
      aboveCount = 0;
      startEvent(firstAbove);                    // the hit started at the first sample
      eventBuffer[eventSampleCount++] = sample;
      postSamplesRemaining--;
      continue;
    }
    if (aboveCount) {                            // it was only a one-sample spike: ignore it
      addToPreBuffer(firstAbove);
      aboveCount = 0;
    }

    addToPreBuffer(sample);
    baselineG = (1.0f - BASELINE_ALPHA) * baselineG + BASELINE_ALPHA * currentG;
    // Road roughness: how far readings wander from normal, averaged over the last ~2 s
    {
      static const float a = (SAMPLE_INTERVAL_US / 1e6f) / ROUGH_WINDOW_S;
      float dev = currentG - baselineG;
      roughVar += a * (dev * dev - roughVar);
      roadRoughG = sqrtf(roughVar);
    }
  }
}

// =====================================================================
// ALERT TASK (countdown)
// =====================================================================

void alertTask() {
  while (true) {
    alertFlags.wait_any(EV_CRASH);
    alertFlags.clear(EV_CANCEL);   // ignore old presses
    LOG.println("CRASH SUSPECTED - countdown started");

    bool cancelled = false;
    for (uint32_t i = 0; i < COUNTDOWN_S && !cancelled; i++) {
      uint32_t got = alertFlags.wait_any_for(EV_CANCEL, 1000ms);
      if (!(got & osFlagsError) && (got & EV_CANCEL)) cancelled = true;
    }

    crashState = cancelled ? CS_CANCELLED : CS_ALERT;
    LOG.println(cancelled ? "Countdown CANCELLED" : "ALERT - no response from rider");

    ThisThread::sleep_for(10s);   // show ALERT / CANCELLED for 10 s
    crashState = CS_IDLE;
  }
}

// =====================================================================
// ANALYSIS (unchanged math from v1)
// =====================================================================

bool findMainImpactPulse(int &startIndex, int &endIndex) {
  if (eventSampleCount < 3) return false;

  int peakIndex = triggerIndex;
  float peakG = getTotalG(eventBuffer[peakIndex]);
  for (int i = 0; i < eventSampleCount; i++) {
    float g = getTotalG(eventBuffer[i]);
    if (g > peakG) { peakG = g; peakIndex = i; }
  }

  float peakRise = max(0.0f, peakG - triggerBaselineG);
  float threshold = max(triggerBaselineG + 0.20f * peakRise, triggerBaselineG + 0.75f);

  const int MAX_HALF_WINDOW_SAMPLES = 9;   // ~40 ms total at 416 Hz
  int minIndex = max(0, peakIndex - MAX_HALF_WINDOW_SAMPLES);
  int maxIndex = min((int)eventSampleCount - 1, peakIndex + MAX_HALF_WINDOW_SAMPLES);

  startIndex = peakIndex;
  for (int i = peakIndex; i >= minIndex; i--) {
    if (getTotalG(eventBuffer[i]) < threshold) { startIndex = i + 1; break; }
    startIndex = i;
  }

  const int QUIET_SAMPLES = 2;
  int quietCount = 0;
  endIndex = peakIndex;
  for (int i = peakIndex + 1; i <= maxIndex; i++) {
    if (getTotalG(eventBuffer[i]) < threshold) {
      if (++quietCount >= QUIET_SAMPLES) { endIndex = i - QUIET_SAMPLES; break; }
    } else {
      quietCount = 0;
      endIndex = i;
    }
  }
  return endIndex > startIndex;
}

float calculateHIC15Style() {
  float maxHIC = 0.0f;
  for (int i = 0; i < eventSampleCount - 1; i++) {
    float integral = 0.0f;
    for (int j = i + 1; j < eventSampleCount; j++) {
      float dt = (eventBuffer[j].timestamp_us - eventBuffer[j - 1].timestamp_us) / 1e6f;
      integral += 0.5f * (getTotalG(eventBuffer[j - 1]) + getTotalG(eventBuffer[j])) * dt;
      float duration = (eventBuffer[j].timestamp_us - eventBuffer[i].timestamp_us) / 1e6f;
      if (duration > 0.015f) break;
      if (duration <= 0.0f) continue;
      float hic = duration * powf(integral / duration, 2.5f);
      if (hic > maxHIC) maxHIC = hic;
    }
  }
  return maxHIC;
}

float calculateImpactDuration() {
  int s, e;
  if (!findMainImpactPulse(s, e)) return 0.0f;
  return (eventBuffer[e].timestamp_us - eventBuffer[s].timestamp_us) / 1000.0f;
}

float calculateDeltaV() {
  int startIndex, endIndex;
  if (!findMainImpactPulse(startIndex, endIndex) || startIndex < 2) return 0.0f;

  float bx = 0, by = 0, bz = 0;
  int n = 0;
  for (int i = max(0, startIndex - 16); i < startIndex; i++) {
    bx += eventBuffer[i].ax / 1000.0f;
    by += eventBuffer[i].ay / 1000.0f;
    bz += eventBuffer[i].az / 1000.0f;
    n++;
  }
  if (n == 0) return 0.0f;
  bx /= n; by /= n; bz /= n;

  const float G = 9.80665f;
  float dvX = 0, dvY = 0, dvZ = 0;
  for (int i = startIndex + 1; i <= endIndex; i++) {
    float dt = (eventBuffer[i].timestamp_us - eventBuffer[i - 1].timestamp_us) / 1e6f;
    if (dt <= 0.0f) continue;
    dvX += 0.5f * ((eventBuffer[i - 1].ax / 1000.0f - bx) + (eventBuffer[i].ax / 1000.0f - bx)) * G * dt;
    dvY += 0.5f * ((eventBuffer[i - 1].ay / 1000.0f - by) + (eventBuffer[i].ay / 1000.0f - by)) * G * dt;
    dvZ += 0.5f * ((eventBuffer[i - 1].az / 1000.0f - bz) + (eventBuffer[i].az / 1000.0f - bz)) * G * dt;
  }
  return sqrtf(dvX * dvX + dvY * dvY + dvZ * dvZ);
}

float calculatePeakRotAccel() {
  float peak = 0.0f;
  for (int i = 1; i < eventSampleCount; i++) {
    float dt = (eventBuffer[i].timestamp_us - eventBuffer[i - 1].timestamp_us) / 1e6f;
    if (dt <= 0.0f) continue;
    float axr = (eventBuffer[i].gx - eventBuffer[i - 1].gx) / 10.0f * DEG_TO_RAD / dt;
    float ayr = (eventBuffer[i].gy - eventBuffer[i - 1].gy) / 10.0f * DEG_TO_RAD / dt;
    float azr = (eventBuffer[i].gz - eventBuffer[i - 1].gz) / 10.0f * DEG_TO_RAD / dt;
    float a = sqrtf(axr * axr + ayr * ayr + azr * azr);
    if (a > peak) peak = a;
  }
  return peak;
}

// How long the jolt took to climb from 25% of its height to its peak (ms).
// Real hits: a few ms. Bumps through the arms/neck: tens of ms.
float calculateRiseMs() {
  int p = 0; float peak = 0;
  for (int i = 0; i < eventSampleCount; i++) { float g = getTotalG(eventBuffer[i]); if (g > peak) { peak = g; p = i; } }
  float level = triggerBaselineG + 0.25f * max(0.0f, peak - triggerBaselineG);
  int j = p;
  while (j > 0 && getTotalG(eventBuffer[j - 1]) >= level) j--;
  return (eventBuffer[p].timestamp_us - eventBuffer[j].timestamp_us) / 1000.0f;
}

// Priority before the crash check: HIGH / MEDIUM / LOW, with the bump filters applied.
// why (optional) gets a short reason for the Serial Monitor.
uint8_t impactPriority(const EventSummary &s, float roughG, float riseMs, const char **why) {
  const char *w = "";
  uint8_t p;
  bool accelSat = s.flags & 0x01;
  bool sharp = riseMs <= SHARP_RISE_MS, soft = riseMs >= SOFT_RISE_MS;
  bool spin = s.peakGyroDps >= SPIN_SUPPORT_DPS;
  float bar = mediumThresholdFor(roughG);
  if (accelSat || s.peakG >= HIGH_PEAK_G)            { p = PRI_HIGH;   w = "hard hit"; }
  else if (s.peakGyroDps >= MEDIUM_GYRO_DPS)          { p = PRI_MEDIUM; w = "very fast head spin"; }
  else if (s.peakG >= bar && soft && !spin)           { p = PRI_LOW;    w = "slow and no head spin = road bump"; }
  else if (s.peakG >= bar)                            { p = PRI_MEDIUM; w = "moderate hit"; }
  else if (sharp && spin && s.peakG >= SPIN_ASSIST_G + roadExtraG(roughG)) { p = PRI_MEDIUM; w = "sharp hit with head spin"; }
  else                                                { p = PRI_LOW;    w = "small bump"; }
  if (why) *why = w;
  return p;
}

EventSummary analyzeEvent() {
  EventSummary r;
  r.eventID = eventID;
  r.triggerTimeMs = triggerMillis;
  r.peakG = 0.0f;
  r.peakGyroDps = 0.0f;
  bool accelSat = false, gyroSat = false;

  for (int i = 0; i < eventSampleCount; i++) {
    const IMUSample &s = eventBuffer[i];
    r.peakG = max(r.peakG, getTotalG(s));
    r.peakGyroDps = max(r.peakGyroDps, getTotalGyro(s));
    if (abs(s.ax) >= 15500 || abs(s.ay) >= 15500 || abs(s.az) >= 15500) accelSat = true;
    if (abs(s.gx) >= 19500 || abs(s.gy) >= 19500 || abs(s.gz) >= 19500) gyroSat = true;
  }

  r.hic15Style = calculateHIC15Style();
  r.deltaV_mps = calculateDeltaV();
  r.peakRotAccelRadS2 = calculatePeakRotAccel();
  r.impactDurationMs = calculateImpactDuration();
  r.flags = (accelSat ? 0x01 : 0) | (gyroSat ? 0x02 : 0);
  return r;
}

void printEventSummary(const EventSummary &e) {
  LOG.println();
  LOG.println("========== IMPACT EVENT ==========");
  LOG.print("Event ID: ");            LOG.println(e.eventID);
  LOG.print("Samples: ");             LOG.println(eventSampleCount);
  LOG.print("Peak G: ");              LOG.println(e.peakG, 3);
  LOG.print("Peak gyro (deg/s): ");   LOG.println(e.peakGyroDps, 1);
  LOG.print("Peak rot accel (rad/s^2): "); LOG.println(e.peakRotAccelRadS2, 1);
  LOG.print("Impact duration (ms): ");LOG.println(e.impactDurationMs, 2);
  LOG.print("Delta-V (m/s): ");       LOG.println(e.deltaV_mps, 3);
  LOG.print("HIC15-style: ");         LOG.println(e.hic15Style, 2);
  LOG.print("Accel saturated: ");     LOG.println((e.flags & 0x01) ? "YES" : "NO");
  LOG.print("Gyro saturated: ");      LOG.println((e.flags & 0x02) ? "YES" : "NO");
  LOG.println("==================================");
}

// =====================================================================
// BATTERY (approximate; 0 if this board version doesn't expose it)
// =====================================================================

uint16_t readBatteryMv() {
#if defined(PIN_VBAT) && defined(VBAT_ENABLE)
  int raw = analogRead(PIN_VBAT);                    // 10-bit, 3.3 V reference
  return (uint16_t)(raw * 3300.0f / 1023.0f * (1510.0f / 510.0f));
#else
  return 0;
#endif
}

uint8_t batteryPercent(uint16_t mv) {
  if (mv == 0) return 0;
  return (uint8_t)constrain((int)((mv - 3300) * 100 / (4200 - 3300)), 0, 100);
}

// =====================================================================
// BLE SENDING (all BLE calls happen in loop() only)
// =====================================================================

bool readyToSend(const StoredEvent &e) {
  return e.valid && !e.sent && e.priority >= PRI_MEDIUM;
}

int pendingCount() {
  int n = 0;
  for (int i = 0; i < MAX_STORED; i++) if (readyToSend(stored[i])) n++;
  return n;
}

const char *priorityName(uint8_t p) {
  return p == PRI_HIGH ? "HIGH" : p == PRI_MEDIUM ? "MEDIUM" : p == PRI_LOW ? "LOW" : "UNDECIDED";
}

float mediumThresholdFor(float rough) {
  return min(MEDIUM_PEAK_G + roadExtraG(rough), HIGH_PEAK_G);
}

// Decide priority for events still waiting on the crash check.
// LOW events are deleted here and never reported.
void decideEvents(bool crashSuspected, bool onlyTimedOut) {
  for (int i = 0; i < MAX_STORED; i++) {
    StoredEvent &e = stored[i];
    if (!e.valid || e.priority != PRI_UNDECIDED) continue;
    if (onlyTimedOut && millis() - e.storedAtMs < DECISION_TIMEOUT_MS) continue;

    const char *why = "";
    uint8_t p = impactPriority(e.summary, e.roughG, e.riseMs, &why);
    if (crashSuspected) { p = PRI_HIGH; why = "rider went down"; }   // never filtered

    e.crashSuspected = crashSuspected;
    e.priority = p;
    LOG.print("Event ");
    LOG.print(e.summary.eventID);
    LOG.print(" priority: ");
    LOG.print(priorityName(p));
    LOG.print("  [");
    LOG.print(why);
    LOG.print("]  rise ");
    LOG.print(e.riseMs, 1);
    LOG.print(" ms, spin ");
    LOG.print(e.summary.peakGyroDps, 0);
    LOG.print(" dps");
    LOG.print("  (road shaking ");
    LOG.print(e.roughG, 2);
    LOG.print(" g, moderate bar ");
    LOG.print(mediumThresholdFor(e.roughG), 1);
    LOG.print(" g)");
    if (p == PRI_LOW) {
      e.valid = false;                         // drop: low priority is not reported
      LOG.println(" -> not reported");
    } else {
      LOG.println(" -> will be reported");
    }
  }
}

void sendHeartbeat() {
  Heartbeat h;
  h.bootId = bootId;
  h.uptimeMs = millis();
  h.batteryMv = readBatteryMv();
  h.batteryPct = batteryPercent(h.batteryMv);
  h.crashState = crashState;
  h.tiltDeci = (int16_t)(currentTiltDeg * 10.0f);
  h.lastEventID = eventID;
  h.pendingEvents = pendingCount();
  // bit2 = sends instant impact pings (v3.3+), bit3 = offline memory + confirmations (v3.5+)
  h.flags = (calibrated ? 0x01 : 0) | (SEND_LIVE_PREVIEW ? 0x02 : 0) | 0x04 | 0x08;
  uint32_t errs = imuReadErrors;   // copy the volatile first
  h.imuErrors = (uint16_t)(errs > 65535 ? 65535 : errs);
  heartbeatChar.writeValue((uint8_t *)&h, sizeof(h));
}

void sendLiveSample() {
  if (!latestSampleValid) return;
  IMUSample copy;
  latestSampleMutex.lock();
  copy = latestSample;
  latestSampleMutex.unlock();

  uint32_t t_ms = copy.timestamp_us / 1000;   // websites expect milliseconds
  uint8_t packet[16];
  memcpy(packet + 0, &t_ms, 4);
  memcpy(packet + 4, &copy.ax, 2);
  memcpy(packet + 6, &copy.ay, 2);
  memcpy(packet + 8, &copy.az, 2);
  memcpy(packet + 10, &copy.gx, 2);
  memcpy(packet + 12, &copy.gy, 2);
  memcpy(packet + 14, &copy.gz, 2);
  liveDataChar.writeValue(packet, sizeof(packet));
}

void storeEvent(const EventSummary &summary) {
  int slot = -1;  // empty slot, otherwise overwrite the oldest (never the one being sent)
  for (int i = 0; i < MAX_STORED; i++) {
    if (i == sendingSlot) continue;
    if (!stored[i].valid) { slot = i; break; }
  }
  // Full: replace the oldest one the app already has; only if none, the oldest overall
  for (int pass = 0; slot < 0 && pass < 2; pass++) {
    for (int i = 0; i < MAX_STORED; i++) {
      if (i == sendingSlot || (pass == 0 && !stored[i].acked)) continue;
      if (slot < 0 || stored[i].seq < stored[slot].seq) slot = i;
    }
  }
  if (slot < 0) return;   // only possible if MAX_STORED == 1
  StoredEvent &e = stored[slot];
  e.valid = true;
  e.sent = false;
  e.acked = false;
  e.tries = 0;
  e.sentAtMs = 0;
  e.priority = PRI_UNDECIDED;
  e.crashSuspected = false;
  e.storedAtMs = millis();
  e.seq = ++storedSeq;
  e.summary = summary;
  e.roughG = triggerRoughG;
  e.riseMs = calculateRiseMs();
  e.count = eventSampleCount;
  e.trigIdx = triggerIndex;
  for (int i = 0; i < eventSampleCount; i++) e.samples[i] = eventBuffer[i];
}

// Sends one MEDIUM/HIGH event: summary, then META packet, then each raw sample (paced)
void serviceEventSending(bool connected) {
  if (!connected) { sendingSlot = -1; return; }   // resume from scratch after reconnect

  if (sendingSlot < 0) {
    for (int i = 0; i < MAX_STORED; i++) {        // oldest undelivered first
      if (readyToSend(stored[i]) &&
          (sendingSlot < 0 || stored[i].seq < stored[sendingSlot].seq)) sendingSlot = i;
    }
    if (sendingSlot < 0) return;
    eventSummaryChar.writeValue((uint8_t *)&stored[sendingSlot].summary, sizeof(EventSummary));
    sendingIndex = -1;                             // META packet goes first
    lastChunkMs = millis();
    return;
  }

  if (millis() - lastChunkMs < RAW_CHUNK_GAP_MS) return;
  lastChunkMs = millis();

  StoredEvent &e = stored[sendingSlot];

  if (sendingIndex < 0) {
    EventMeta m;
    m.eventID = e.summary.eventID;
    m.marker = 0xFF;
    m.count = e.count;
    m.bootId = bootId;
    m.triggerTimeMs = e.summary.triggerTimeMs;
    m.priority = e.priority;
    m.flags = (e.summary.flags & 0x03) | (e.crashSuspected ? 0x04 : 0);
    m.peakG_x100 = (uint16_t)constrain((int)(e.summary.peakG * 100.0f), 0, 65535);
    m.peakGyroDps = (uint16_t)constrain((int)e.summary.peakGyroDps, 0, 65535);
    m.sampleRateHz = (uint16_t)(1000000UL / SAMPLE_INTERVAL_US);
    if (!eventRawChar.writeValue((uint8_t *)&m, sizeof(m))) return;   // buffer full: retry next time
    sendingIndex = 0;
    return;
  }

  const IMUSample &s = e.samples[sendingIndex];
  RawChunk c;
  c.eventID = e.summary.eventID;
  c.index = sendingIndex;
  c.count = e.count;
  c.offset_us = (int32_t)(s.timestamp_us - e.samples[e.trigIdx].timestamp_us);
  c.ax = s.ax; c.ay = s.ay; c.az = s.az;
  c.gx = s.gx; c.gy = s.gy; c.gz = s.gz;
  if (!eventRawChar.writeValue((uint8_t *)&c, sizeof(c))) return;     // buffer full: retry next time

  if (++sendingIndex >= e.count) {
    e.sent = true;
    e.tries++;
    e.sentAtMs = millis();
    sendingSlot = -1;
    LOG.print("Event delivered over BLE: ");
    LOG.print(e.summary.eventID);
    LOG.print(" (");
    LOG.print(priorityName(e.priority));
    LOG.println(")");
  }
}

// =====================================================================
// LEDs (XIAO LEDs are ON when LOW). Only loop() touches them.
// =====================================================================

void setLed(bool r, bool g, bool b) {
  digitalWrite(LEDR, r ? LOW : HIGH);
  digitalWrite(LEDG, g ? LOW : HIGH);
  digitalWrite(LEDB, b ? LOW : HIGH);
}

void updateLeds(bool connected) {
  bool blink = (millis() / 250) % 2;
  switch (crashState) {
    case CS_COUNTDOWN: setLed(blink, false, false); break;  // fast red blink
    case CS_ALERT:     setLed(true, false, false);  break;  // solid red
    case CS_CANCELLED: setLed(false, true, false);  break;  // green
    default:
      if (!calibrated) setLed(blink, blink, false);         // yellow blink = calibrating
      else setLed(false, false, connected);                 // blue = connected
  }
}

// =====================================================================
// SETUP
// =====================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);
  LOG.println("\n===== NeuroHalo RTOS Helmet Monitor v3 =====");

  pinMode(LEDR, OUTPUT); pinMode(LEDG, OUTPUT); pinMode(LEDB, OUTPUT);
  setLed(false, false, false);

#if defined(PIN_VBAT) && defined(VBAT_ENABLE)
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);   // enables the battery voltage divider (keep LOW)
#endif

  pinMode(CANCEL_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(CANCEL_BUTTON_PIN), cancelButtonISR, FALLING);

  // ---- IMU ----
  myIMU.settings.accelRange = 16;
  myIMU.settings.gyroRange = 2000;
  myIMU.settings.accelSampleRate = 833;   // 7. sensor faster than we read
  myIMU.settings.gyroSampleRate = 833;
  myIMU.settings.accelBandWidth = 400;    // 7. don't smooth short impacts
  if (myIMU.begin() != IMU_SUCCESS) {
    LOG.println("ERROR: IMU init failed (is the board set to XIAO BLE *Sense*?)");
    while (1) delay(1000);
  }
  Wire.setClock(400000);

  // 8. Block Data Update (bit 6) + keep register auto-increment (bit 2)
  uint8_t ctrl3 = 0;
  myIMU.readRegister(&ctrl3, LSM6DS3_ACC_GYRO_CTRL3_C);
  myIMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL3_C, ctrl3 | 0x40 | 0x04);
  LOG.println("IMU OK: +/-16 g, +/-2000 dps, 833 Hz output, BDU on");

  // ---- BLE ----
  if (!BLE.begin()) {
    LOG.println("ERROR: BLE init failed");
    while (1) delay(1000);
  }
  // Random boot ID so event IDs from different power-ups never collide
  randomSeed(analogRead(A0) ^ micros());
  bootId = ((uint32_t)random(0x10000) << 16) | (uint32_t)random(0x10000);
  LOG.print("Boot ID: ");
  LOG.println(bootId, HEX);

  BLE.setLocalName("HelmetMonitor");
  BLE.setAdvertisedService(helmetService);
  helmetService.addCharacteristic(liveDataChar);
  helmetService.addCharacteristic(eventSummaryChar);
  helmetService.addCharacteristic(eventRawChar);
  helmetService.addCharacteristic(heartbeatChar);
  helmetService.addCharacteristic(commandChar);
  BLE.addService(helmetService);
  sendHeartbeat();   // initial readable value
  BLE.advertise();
  LOG.println("BLE advertising as HelmetMonitor");

  // ---- RTOS ----
  imuThread.start(imuTask);
  alertThread.start(alertTask);
  sampleTicker.attach(sampleTickerISR, std::chrono::microseconds(SAMPLE_INTERVAL_US));
  LOG.println("Sampling ~416 Hz. Calibrating 'up' for 1 s - keep the helmet upright and still...");
}

// =====================================================================
// LOOP (BLE + analysis)
// =====================================================================

void loop() {
  BLE.poll();
  bool connected = BLE.connected();

  // After a drop, make sure the helmet stays visible so the app can reconnect
  static uint32_t lastAdvertise = 0;
  if (!connected && millis() - lastAdvertise > 5000) {
    BLE.advertise();
    lastAdvertise = millis();
  }

  // New connection -> re-send stored events (website skips IDs it already has)
  static bool wasConnected = false;
  if (connected && !wasConnected) {
    for (int i = 0; i < MAX_STORED; i++) {
      if (stored[i].valid && !stored[i].acked) { stored[i].sent = false; stored[i].tries = 0; }
    }
    sendHeartbeat();
  }
  wasConnected = connected;

  static bool calAnnounced = false;
  if (calibrated && !calAnnounced) {
    calAnnounced = true;
    LOG.println("Calibration done. Monitoring for impacts.");
  }

  // Finished event -> analyze, store, reset
  if (eventReady) {
    EventSummary summary = analyzeEvent();
    printEventSummary(summary);
    storeEvent(summary);
    // Quick ping for the live graph: EVERY hit, so the graph always reacts.
    // Light hits get flag bit4 (0x10): the app draws them small and doesn't save or count them.
    if (connected) {
      EventSummary ping = summary;
      if (impactPriority(summary, triggerRoughG, calculateRiseMs(), nullptr) < PRI_MEDIUM) ping.flags |= 0x10;
      eventSummaryChar.writeValue((uint8_t *)&ping, sizeof(EventSummary));
    }

    preWriteIndex = 0;
    preCount = 0;
    eventSampleCount = 0;
    baselineG = 1.0f;
    eventReady = false;   // must be last: lets the IMU thread capture again
  }

  // Priority decision: wait for the crash check to finish
  static uint8_t prevCrashState = CS_IDLE;
  uint8_t cs = crashState;
  if (prevCrashState == CS_WATCHING && cs == CS_COUNTDOWN) decideEvents(true, false);   // crash suspected
  if (prevCrashState == CS_WATCHING && cs == CS_IDLE)      decideEvents(false, false);  // just a bump
  prevCrashState = cs;
  decideEvents(false, true);   // safety net: decide anything waiting too long

  // Heartbeat: every HEARTBEAT_MS, or right away when the crash state changes
  static uint32_t lastHeartbeat = 0;
  static uint8_t lastState = CS_IDLE;
  if (crashState != lastState || millis() - lastHeartbeat >= HEARTBEAT_MS) {
    if (crashState != lastState) {
      LOG.print("Crash state -> ");
      LOG.println(crashState);
    }
    lastState = crashState;
    lastHeartbeat = millis();
    sendHeartbeat();
  }

  // Commands from the app
  if (commandChar.written() && commandChar.valueLength() >= 1) {
    const uint8_t *v = commandChar.value();
    uint8_t cmd = v[0];
    if (cmd == 1) { recalibrateRequested = true; LOG.println("App: set upright position"); }
    if (cmd == 2) { alertFlags.set(EV_CANCEL); LOG.println("App: rider is OK, countdown cancelled"); }
    if (cmd == 4) {                                     // new ride: start with an empty memory
      sendingSlot = -1;
      for (int i = 0; i < MAX_STORED; i++) stored[i].valid = false;
      sendHeartbeat();                                  // app sees 0 waiting right away
      LOG.println("App: new ride, saved impacts cleared");
    }
    if (cmd == 3) {                                     // the app has these impacts (one or more IDs)
      for (int k = 1; k + 1 < commandChar.valueLength(); k += 2) {
        uint16_t id = v[k] | (v[k + 1] << 8);
        for (int i = 0; i < MAX_STORED; i++) {
          if (stored[i].valid && stored[i].summary.eventID == id) { stored[i].acked = true; stored[i].sent = true; }
        }
        LOG.print("App confirmed impact ");
        LOG.println(id);
      }
    }
  }

  // Sent but never confirmed (packets lost?): try again, up to 3 times per connection
  if (connected) {
    for (int i = 0; i < MAX_STORED; i++) {
      StoredEvent &e = stored[i];
      if (e.valid && e.sent && !e.acked && e.tries < 3 && i != sendingSlot && millis() - e.sentAtMs > 20000) e.sent = false;
    }
  }

  serviceEventSending(connected);

  static uint32_t lastLive = 0;
  if (SEND_LIVE_PREVIEW && connected && millis() - lastLive >= LIVE_INTERVAL_MS) {
    lastLive = millis();
    sendLiveSample();
  }

  updateLeds(connected);
  delay(1);
}
