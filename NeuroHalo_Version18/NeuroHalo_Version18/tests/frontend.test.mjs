// Tests for the plain-language helpers and Bluetooth decoding (no browser needed).
import assert from 'node:assert/strict';
import * as U from '../dist/ui.js';
import {parseHeartbeat, parseRaw, buildEvent} from '../dist/helmet-ble.js';

// impacts
assert.equal(U.impactName({reporting_priority: 'high'}), 'Hard impact');
assert.equal(U.impactName({reporting_priority: 'medium'}), 'Moderate impact');
assert.equal(U.strength({recorded_peak_resultant_g: 13}).zone, 'hard');
assert.equal(U.strength({recorded_peak_resultant_g: 9}).zone, 'moderate');
assert.equal(U.strength({recorded_peak_resultant_g: 30, accel_clipped_axes: ['x']}).words, 'Off the scale');
assert.match(U.impactFacts({reporting_priority: 'high', recorded_peak_resultant_g: 14, crash_suspected: true, samples: [{gx_dps: 900, gy_dps: 0, gz_dps: 0}]}).join(' '), /very quickly.*crash countdown/);

// time words
const now = new Date('2026-10-04T15:00:00');
assert.equal(U.whenText('2026-10-04T14:58:00', now), '2 min ago');
assert.match(U.whenText('2026-10-04T09:00:00', now), /^Today/);
assert.match(U.whenText('2026-10-03T09:00:00', now), /^Yesterday/);
assert.equal(U.durationWords(1500), '25 min');
assert.equal(U.timer(65), '01:05');
assert.equal(U.countsText(1, 2), '1 hard, 2 moderate impacts');
assert.equal(U.countsText(0, 0), 'No impacts');
assert.equal(U.checkinText({feel_fine: true}), 'Felt fine');
assert.equal(U.positionText(95), 'On its side');

// weather verdicts
const t = Date.parse('2026-10-04T15:00:00') / 1000;
const dry = h => ({time: t + h * 3600, temperature_2m: 75, precipitation_probability: 5, weather_code: 1, wind_speed_10m: 6});
assert.equal(U.rideVerdict({temperature_2m: 75, weather_code: 1, wind_speed_10m: 6, precipitation: 0}, [1, 2, 3].map(dry)).level, 'good');
assert.equal(U.rideVerdict({temperature_2m: 75, weather_code: 61, wind_speed_10m: 6, precipitation: 0.1}, [1, 2].map(dry)).level, 'bad');
assert.equal(U.rideVerdict({temperature_2m: 75, weather_code: 1, wind_speed_10m: 6, precipitation: 0}, [dry(1), {...dry(2), precipitation_probability: 70}]).level, 'caution');
assert.equal(U.rideVerdict({temperature_2m: 75, weather_code: 95, wind_speed_10m: 6, precipitation: 0}, []).level, 'bad');

// Bluetooth packets (same byte layout as helmet_monitor_v3.ino)
const dv = () => new DataView(new ArrayBuffer(20));
const hb = dv(); hb.setUint32(0, 0xABCD, true); hb.setUint32(4, 50000, true); hb.setUint8(10, 80); hb.setUint8(11, 2); hb.setInt16(12, 875, true); hb.setUint8(17, 1);
const H = parseHeartbeat(hb);
assert.equal(H.crash_state_name, 'countdown'); assert.equal(H.tilt_deg, 87.5); assert.equal(H.calibrated, true);
const m = dv(); m.setUint16(0, 7, true); m.setUint8(2, 0xFF); m.setUint8(3, 3); m.setUint32(4, 0xABCD, true); m.setUint32(8, 49800, true); m.setUint8(12, 3); m.setUint8(13, 4); m.setUint16(14, 1320, true);
const [kind, meta] = parseRaw(m);
assert.equal(kind, 'meta'); assert.equal(meta.priority, 3); assert.equal(meta.crash_suspected, true); assert.equal(meta.peak_g, 13.2);
const samples = [-2404, 0, 2404].map((tu, i) => { const s = dv(); s.setUint16(0, 7, true); s.setUint8(2, i); s.setUint8(3, 3); s.setInt32(4, tu, true); s.setInt16(8, i === 1 ? 13000 : 50, true); s.setInt16(12, 1000, true); s.setInt16(14, 23000, true); return parseRaw(s)[1]; });
const ev = buildEvent(meta, samples, H);
assert.equal(ev.event_id, 'xiao-0000abcd-e00007');
assert.equal(ev.reporting_priority, 'high');
assert.equal(ev.samples.length, 3);
assert.equal(ev.samples[0].gx_dps, 2000);              // clamped to the sensor range
assert.deepEqual(ev.gyro_clipped_axes, ['x']);
assert.ok(ev.incident_time_utc.endsWith('Z'));
console.log('PASS: impact words, strength meter, time words, weather verdicts, Bluetooth decoding and event building.');
