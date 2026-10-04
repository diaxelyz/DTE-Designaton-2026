// Talks to the XIAO helmet (helmet_monitor_v3.ino) directly from the browser with Web Bluetooth.
// Works in Chrome / Edge on a laptop or Android. Not on iPhone (Safari has no Web Bluetooth).
//
// The helmet sends:
//   5f8d0006 heartbeat (20 bytes, every 3 s): battery, crash state, tilt...
//   5f8d0005 events: one META packet (byte 2 = 0xFF) then one packet per sample (20 bytes each)

export const SERVICE_UUID = '5f8d0001-8523-4b4e-9c1a-eb1a4c3a1000';
const SUMMARY_UUID = '5f8d0003-8523-4b4e-9c1a-eb1a4c3a1000';   // helmet v3.3+: instant "impact now" ping
const RAW_UUID = '5f8d0005-8523-4b4e-9c1a-eb1a4c3a1000';
const HEARTBEAT_UUID = '5f8d0006-8523-4b4e-9c1a-eb1a4c3a1000';
const COMMAND_UUID = '5f8d0007-8523-4b4e-9c1a-eb1a4c3a1000';   // helmet v3.1+: 1 = set upright, 2 = I'm OK
const CRASH_STATES = ['normal', 'checking', 'countdown', 'alert', 'cancelled'];
const PRIORITY = {2: 'medium', 3: 'high'};   // LOW (1) is never sent by the helmet
const ACCEL_RANGE = 16, GYRO_RANGE = 2000;

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export function parseHeartbeat(v) {
  if (!v || v.byteLength < 20) return null;
  return {
    boot_id: v.getUint32(0, true), uptime_ms: v.getUint32(4, true),
    battery_mv: v.getUint16(8, true), battery_pct: v.getUint8(10),
    crash_state: v.getUint8(11), crash_state_name: CRASH_STATES[v.getUint8(11)] || 'normal',
    tilt_deg: v.getInt16(12, true) / 10, last_event_id: v.getUint16(14, true),
    pending: v.getUint8(16), calibrated: !!(v.getUint8(17) & 1), features: v.getUint8(17), imu_errors: v.getUint16(18, true),
    received: Date.now(),
  };
}

export function parseRaw(v) {
  if (!v || v.byteLength < 20) return [null, null];
  if (v.getUint8(2) === 0xFF) {
    const flags = v.getUint8(13);
    return ['meta', {
      event_id: v.getUint16(0, true), count: v.getUint8(3), boot_id: v.getUint32(4, true),
      trigger_ms: v.getUint32(8, true), priority: v.getUint8(12),
      accel_sat: !!(flags & 1), gyro_sat: !!(flags & 2), crash_suspected: !!(flags & 4),
      peak_g: v.getUint16(14, true) / 100, peak_gyro_dps: v.getUint16(16, true), sample_rate_hz: v.getUint16(18, true),
    }];
  }
  return ['sample', {
    event_id: v.getUint16(0, true), index: v.getUint8(2), count: v.getUint8(3), t_us: v.getInt32(4, true),
    ax: v.getInt16(8, true), ay: v.getInt16(10, true), az: v.getInt16(12, true),
    gx: v.getInt16(14, true), gy: v.getInt16(16, true), gz: v.getInt16(18, true),
  }];
}

// Same event format the backend expects (schema_version 1)
export function buildEvent(meta, raw, hb) {
  const boot = meta.boot_id.toString(16).padStart(8, '0');
  let incident = null, timeSource = 'Unknown (no heartbeat from this boot)';
  if (hb && hb.boot_id === meta.boot_id) {
    const deviceNow = hb.uptime_ms + (Date.now() - hb.received);
    incident = new Date(Date.now() - (deviceNow - meta.trigger_ms)).toISOString();
    timeSource = 'Estimated by the app from device uptime (about ±1 s)';
  }
  const accelClip = new Set(), gyroClip = new Set(), samples = [];
  let last = -Infinity;
  for (const s of [...raw].sort((a, b) => a.t_us - b.t_us)) {
    if (s.t_us <= last) continue;
    last = s.t_us;
    const row = {t_us: s.t_us};
    for (const axis of 'xyz') {
      const a = s['a' + axis] / 1000, g = s['g' + axis] / 10;
      if (Math.abs(a) >= ACCEL_RANGE * 0.97) accelClip.add(axis);
      if (Math.abs(g) >= GYRO_RANGE * 0.97) gyroClip.add(axis);
      row['a' + axis + '_g'] = Math.round(Math.max(-ACCEL_RANGE, Math.min(ACCEL_RANGE, a)) * 1000) / 1000;
      row['g' + axis + '_dps'] = Math.round(Math.max(-GYRO_RANGE, Math.min(GYRO_RANGE, g)) * 10) / 10;
    }
    samples.push(row);
  }
  const priority = PRIORITY[meta.priority] || 'medium';
  const reasons = [];
  if (meta.crash_suspected) reasons.push('rider tilted and still after impact');
  if (meta.accel_sat || accelClip.size) reasons.push('sensor range exceeded, true peak unknown');
  reasons.push(`recorded peak ${meta.peak_g.toFixed(1)} g, ${meta.peak_gyro_dps} deg/s`);
  return {
    schema_version: 1,
    event_id: `xiao-${boot}-e${String(meta.event_id).padStart(5, '0')}`,
    device_id: 'neurohalo-xiao-01',
    boot_session_id: `boot-${boot}`,
    source: 'device',
    sensor_model: 'LSM6DS3TR-C (XIAO nRF52840 Sense)',
    firmware_version: 'helmet_monitor_v3',
    accel_range_g: ACCEL_RANGE,
    gyro_range_dps: GYRO_RANGE,
    sample_rate_hz: meta.sample_rate_hz,
    filter_configuration: 'Sensor ODR 833 Hz, accel bandwidth 400 Hz, read at ~416 Hz',
    incident_time_utc: incident,
    time_source: timeSource,
    device_event_time_us: meta.trigger_ms * 1000,
    threshold_g: 4,
    event_duration_ms: samples.length ? Math.round((samples.at(-1).t_us - samples[0].t_us) / 100) / 10 : 0,
    accel_clipped_axes: [...accelClip].sort(),
    gyro_clipped_axes: [...gyroClip].sort(),
    dropped_sample_count: meta.count - samples.length,
    timing_quality: samples.length === meta.count ? 'Complete BLE transfer' : 'Some samples missing',
    reporting_priority: priority,
    crash_suspected: meta.crash_suspected,
    user_classification: 'Candidate impact',
    head_region: 'Unknown',
    user_notes: `Device reporting priority: ${priority.toUpperCase()} (${reasons.join('; ')}). Reporting priority is not an injury assessment.`,
    location: {label: '', latitude: null, longitude: null, source: 'Not recorded'},
    samples,
  };
}

// onChange(): status or heartbeat changed.  onEvent(event): a complete event arrived.
// Quick summary the helmet sends the moment an impact happens (31 bytes)
export function parseSummary(dv) {
  const v = dv instanceof DataView ? dv : new DataView(dv.buffer || dv);
  if (v.byteLength < 31) return null;
  return {event_id: v.getUint16(0, true), trigger_ms: v.getUint32(2, true), peak_g: v.getFloat32(6, true),
    peak_gyro_dps: v.getFloat32(10, true), saturated: !!(v.getUint8(30) & 1), light: !!(v.getUint8(30) & 0x10)};
}

export function createHelmetLink({onChange = () => {}, onEvent = () => {}, onImpact = () => {}, onLog = () => {}} = {}) {
  let connectedAt = 0, canPing = false, device = null, wantConnected = false, status = 'disconnected', hb = null, commandChar = null;
  let meta = null, samples = new Map(), lastRaw = 0;
  const setStatus = s => { status = s; onChange(); };

  function finish(reason = '') {
    const m = meta, list = [...samples.values()];
    meta = null; samples = new Map();
    if (!m) return;
    if (list.length < Math.max(5, Math.floor(m.count / 2))) {
      onLog(`Lost event ${m.event_id}: only ${list.length}/${m.count} samples arrived ${reason}`);
      return;
    }
    if (!PRIORITY[m.priority]) return;
    if (!hb || hb.boot_id !== m.boot_id) { onLog(`Skipped event ${m.event_id}: time unknown`); return; }
    onEvent(buildEvent(m, list, hb));
    confirm(m.event_id);                 // tell the helmet we have it (helmet v3.5+)
  }

  function onRaw(e) {
    try {
      const [kind, p] = parseRaw(e.target.value);
      lastRaw = Date.now();
      if (kind === 'meta') {
        if (meta) finish('(next event started)');
        meta = p; samples = new Map();
        return;
      }
      if (kind !== 'sample' || !meta || p.event_id !== meta.event_id) return;
      samples.set(p.index, p);
      if (samples.size >= meta.count) finish();
    } catch (err) { onLog('Bad helmet packet: ' + err.message); }
  }

  function onSummary(e) {
    const s = parseSummary(e.target.value);
    if (!s || !hb) return;
    const deviceNow = hb.uptime_ms + (Date.now() - hb.received);
    const t = Math.min(Date.now(), Date.now() - (deviceNow - s.trigger_ms));
    if (Date.now() - t > 120000) return;      // an old stored event being re-sent, not a new hit
    onImpact({key: `${hb.boot_id}-${s.event_id}`, t, g: s.peak_g, saturated: s.saturated, light: s.light});
  }

  function onHeartbeat(e) {
    const next = parseHeartbeat(e.target.value);
    if (next) { hb = next; onChange(); }
  }

  async function attach() {
    setStatus('connecting');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const raw = await service.getCharacteristic(RAW_UUID);
    const heart = await service.getCharacteristic(HEARTBEAT_UUID);
    canPing = false;
    try { commandChar = await service.getCharacteristic(COMMAND_UUID); } catch { commandChar = null; }   // older helmet code
    hb = parseHeartbeat(await heart.readValue());   // know the helmet's clock first...
    raw.addEventListener('characteristicvaluechanged', onRaw);       // same function = never added twice
    heart.addEventListener('characteristicvaluechanged', onHeartbeat);
    await heart.startNotifications();
    await raw.startNotifications();                 // ...then accept events
    try {                                           // instant impact pings (helmet v3.3+)
      const sum = await service.getCharacteristic(SUMMARY_UUID);
      sum.addEventListener('characteristicvaluechanged', onSummary);
      await sum.startNotifications();
      canPing = true;
    } catch { /* older helmet code: spikes appear when the full recording arrives */ }
    connectedAt = Date.now();
    setStatus('connected');
    pumpConfirms();
  }

  async function reconnect() {
    if (!wantConnected || !device || status === 'connected') return;
    try { await attach(); onLog('Helmet reconnected'); }
    catch { setStatus('disconnected'); setTimeout(reconnect, 3000); }
  }

  async function connect() {
    if (!bluetoothAvailable()) throw new Error('Bluetooth needs Chrome or Edge on a laptop or Android phone.');
    const chosen = await navigator.bluetooth.requestDevice({filters: [{services: [SERVICE_UUID]}]});
    adopt(chosen);
    wantConnected = true;
    try { await attach(); } catch (err) { setStatus('disconnected'); throw err; }
  }

  function adopt(chosen) {
    if (device === chosen) return;
    device = chosen;
    device.addEventListener('gattserverdisconnected', () => {
      finish('(disconnected)');
      hb = null;
      setStatus('disconnected');
      if (wantConnected) setTimeout(reconnect, 2000);   // auto-reconnect, no extra click needed
    });
  }

  // After the first Connect, Chrome remembers the helmet. On the next page load we reconnect
  // without asking (where the browser supports getDevices). Returns true if it found the helmet.
  async function autoConnect() {
    if (!bluetoothAvailable() || !navigator.bluetooth.getDevices) return false;
    let known = [];
    try { known = await navigator.bluetooth.getDevices(); } catch { return false; }
    const helmet = known.find(d => /HelmetMonitor|XIAO/i.test(d.name || '')) || known[0];
    if (!helmet) return false;
    adopt(helmet);
    wantConnected = true;
    try { await attach(); } catch { setStatus('disconnected'); setTimeout(reconnect, 3000); }
    return true;
  }

  // "Got it" confirmations, sent one at a time (only one Bluetooth write can run at once)
  const confirmQueue = [];
  let confirming = false;
  function confirm(id) { if (!confirmQueue.includes(id)) confirmQueue.push(id); pumpConfirms(); }
  async function pumpConfirms() {
    if (confirming || !commandChar || status !== 'connected') return;
    confirming = true;
    try {
      while (confirmQueue.length && status === 'connected') {
        // up to 9 IDs in one message, so a burst of impacts is confirmed in one go
        const ids = confirmQueue.slice(0, 9), msg = new Uint8Array([3, ...ids.flatMap(id => [id & 255, id >> 8])]);
        await (commandChar.writeValueWithResponse ? commandChar.writeValueWithResponse(msg) : commandChar.writeValue(msg));
        confirmQueue.splice(0, ids.length);
      }
    } catch { setTimeout(pumpConfirms, 700); }   // busy: try again shortly
    finally { confirming = false; }
  }

  async function sendCommand(code) {
    if (!commandChar) throw new Error('Upload the latest helmet code (v3.1) to use this.');
    await commandChar.writeValueWithoutResponse(new Uint8Array([code]));
  }

  // New ride: wipe the helmet's saved impacts (helmet v3.5+). Waits for the write to be confirmed.
  async function clearHelmetMemory() {
    if (!commandChar || status !== 'connected') return false;
    const msg = new Uint8Array([4]);
    for (let i = 0; i < 3; i++) {
      try { await (commandChar.writeValueWithResponse ? commandChar.writeValueWithResponse(msg) : commandChar.writeValue(msg)); return true; }
      catch { await new Promise(r => setTimeout(r, 400)); }   // Bluetooth busy: try again
    }
    return false;
  }

  function disconnect() {
    wantConnected = false;
    if (device?.gatt?.connected) device.gatt.disconnect();
    hb = null;
    setStatus('disconnected');
  }

  setInterval(() => { if (meta && Date.now() - lastRaw > 1500) finish('(transfer stopped)'); }, 1000);

  return {
    connect, disconnect, autoConnect, sendCommand, clearHelmetMemory,
    get canCommand() { return !!commandChar; },
    get canPing() { return canPing && !!(hb && hb.features & 0x04); },   // helmet code sends instant pings (v3.3+)
    get connectedAt() { return connectedAt; },
    get upToDate() { return !!(hb && hb.features & 0x08); },              // helmet code v3.5+
    get receiving() { return !!meta; },            // an impact is arriving right now
    get status() { return status; },
    get heartbeat() { return hb; },
    get name() { return device?.name || 'Helmet'; },
  };
}
