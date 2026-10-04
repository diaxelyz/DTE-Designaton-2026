// NeuroHalo athlete app. Screens: Home, Ride, History, Helmet (+ ride report, check-in, impact).
import {createHelmetLink, bluetoothAvailable} from './helmet-ble.js';
import * as U from './ui.js';

const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const onLaptop = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);   // not already on the phone link
const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
if (inFrame) document.documentElement.classList.add('in-frame');

// ---------------------------------------------------------------- icons
const P = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  ride: 'M5.5 17.5a3.5 3.5 0 1 0 0-.01M18.5 17.5a3.5 3.5 0 1 0 0-.01M5.5 17.5 9 10h6l3.5 7.5M9 10l3 7.5h6.5M13 6h3l2 4',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3.5 2',
  helmet: 'M3.5 15.5a8.5 8.5 0 0 1 17 0V17h-17zM12 7v4M8 8.2l1.5 3M16 8.2l-1.5 3M2.5 17h19',
  play: 'M8 5.5v13l10.5-6.5z',
  stop: 'M7 7h10v10H7z',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 6l6 6-6 6',
  pin: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  locate: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zm0-3.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  send: 'M4 12 20 4l-6 16-3-7z',
  chat: 'M5 5h14v10H9l-4 4z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z',
  alert: 'M12 3 2 20h20zM12 10v4M12 17v.2',
  sun: 'M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8',
  partly: 'M8 5v1.5M3.5 9H5M4.6 5.6l1 1M11.4 5.6l-1 1M5.8 11.2A3.2 3.2 0 1 1 11 8.4M8 19h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 9 11.5 3.8 3.8 0 0 0 8 19z',
  cloud: 'M7 19h11a4 4 0 0 0 .5-8A6 6 0 0 0 7.2 9.4 4.8 4.8 0 0 0 7 19z',
  fog: 'M4 9h16M3 13h18M5 17h14',
  rain: 'M7 15h11a4 4 0 0 0 .5-8A6 6 0 0 0 7.2 5.4 4.8 4.8 0 0 0 7 15zM8 18l-1 3M12 18l-1 3M16 18l-1 3',
  snow: 'M7 14h11a4 4 0 0 0 .5-8A6 6 0 0 0 7.2 4.4 4.8 4.8 0 0 0 7 14zM8 18h.01M12 20h.01M16 18h.01M10 21.5h.01M14 21.5h.01',
  storm: 'M7 14h11a4 4 0 0 0 .5-8A6 6 0 0 0 7.2 4.4 4.8 4.8 0 0 0 7 14zM12.5 15l-2 3.5h3l-2 3.5',
};
const icon = (n, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n] || P.alert}"/></svg>`;

// ---------------------------------------------------------------- state
const S = {
  events: [], rides: [], current: null, server: 'checking',
  helmet: {state: 'disconnected'},
  weather: null, weatherBusy: false, weatherErr: '', editCity: false,
  city: store.get('nh-city', {name: 'Gainesville, FL', latitude: 29.6516, longitude: -82.3248}),
  details: {},                      // full impact records (with samples), by event_id
  checkin: null,                    // check-in form being filled in
  editing: false,                   // typing in a form: pause auto re-render
  busy: false,
  finishing: null,                  // {id, step}: wrapping up a ride before showing the report
};
let outbox = store.get('nh-outbox', []), sentIds = new Set(store.get('nh-sent', [])), delivering = false;
const saveQueues = () => { store.set('nh-outbox', outbox.slice(-40)); store.set('nh-sent', [...sentIds].slice(-500)); };

const route = () => { const [page = 'home', id = ''] = (location.hash.slice(1) || 'home').split('/'); return {page, id: decodeURIComponent(id)}; };
const go = path => { if (location.hash === '#' + path) render(); else location.hash = path; };
const rideElapsed = r => r ? ((r.ended_utc ? Date.parse(r.ended_utc) : Date.now()) - Date.parse(r.started_utc)) / 1000 : 0;
const rideImpacts = r => S.events.filter(e => e.ride_id === r.ride_id).sort((a, b) => Date.parse(b.incident_time_utc) - Date.parse(a.incident_time_utc));
const counts = list => ({hard: list.filter(e => U.impactLevel(e) === 'hard').length, moderate: list.filter(e => U.impactLevel(e) === 'moderate').length});

function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 4000);
}

async function api(path, options = {}) {
  const c = new AbortController(), timer = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch('/api' + path, {...options, headers: {'Content-Type': 'application/json'}, signal: c.signal, cache: 'no-store'});
    let body = null; try { body = await r.json(); } catch {}
    if (!r.ok) throw new Error(body?.error || `Server error (${r.status})`);
    return body;
  } finally { clearTimeout(timer); }
}

async function loadData() {
  try {
    const [ev, rd] = await Promise.all([api('/events'), api('/rides')]);
    S.events = (ev.events || []).filter(e => e.reporting_priority);
    S.rides = rd.rides || [];
    S.current = S.rides.find(r => r.active) || null;
    S.server = 'ok';
  } catch { S.server = 'down'; }
}

// ---------------------------------------------------------------- helmet (Bluetooth)
const quickSpikes = new Map();  // "impact now" pings from the helmet, before the full recording arrives
const link = createHelmetLink({onChange: syncHelmet, onEvent: queueEvent, onLog: () => {},
  onImpact: p => {
    if (quickSpikes.has(p.key)) return;
    quickSpikes.set(p.key, p);
    if (!p.light && route().page === 'ride' && !route().id) softRender();   // counts + list update instantly
  }});
let lastSig = '';
function syncHelmet() {
  const st = link.status, hb = link.heartbeat;
  if (st !== 'connected' && S.current && S.helmet.state === 'connected') wasAway = true;
  S.helmet = st === 'connected' ? {state: 'connected', ...(hb || {})}
    : {state: bluetoothAvailable() ? (st === 'connecting' ? 'connecting' : 'disconnected') : 'unsupported'};
  helmet3d?.setState(S.helmet.state === 'connected' && ['countdown', 'alert'].includes(S.helmet.crash_state_name) ? 'alert' : S.helmet.state);
  const sig = JSON.stringify([S.helmet.state, S.helmet.pending, S.helmet.battery_pct, S.helmet.crash_state_name, S.helmet.calibrated, U.positionText(S.helmet.tilt_deg)]);
  if (sig !== lastSig) { lastSig = sig; softRender(); }
}

let wasAway = false;   // the helmet dropped out during this ride (set in syncHelmet)
const liveSpikes = new Map();   // event_id -> {e, at}: recordings straight from the helmet, and when they arrived
function queueEvent(ev) {
  if (ev.incident_time_utc && !liveSpikes.has(ev.event_id)) {
    liveSpikes.set(ev.event_id, {e: ev, at: Date.now()});
    if (route().page === 'ride' && !route().id) softRender();   // counts + list update right away
  }
  if (sentIds.has(ev.event_id) || outbox.some(x => x.event_id === ev.event_id)) return;
  outbox.push(ev); saveQueues(); deliver();
}

function duringRide(ev, rides) {
  const t = ev.incident_time_utc ? Date.parse(ev.incident_time_utc) : null;
  return rides.some(r => {
    const a = Date.parse(r.started_utc), b = r.ended_utc ? Date.parse(r.ended_utc) : Date.now() + 5000;
    return t != null && t >= a - 1000 && t <= b;   // unknown time = not counted
  });
}

// Save helmet events on the server (only those during a ride). Kept and retried if the server is down.
async function deliver() {
  if (delivering || !outbox.length) return;
  delivering = true;
  let saved = 0, serverDown = false;
  try {
    const rides = (await api('/rides')).rides || [];
    for (const ev of [...outbox]) {
      if (duringRide(ev, rides)) {
        try {
          await api('/events', {method: 'POST', body: JSON.stringify(ev)});
          saved++;
        } catch (err) {
          if (err.name === 'TypeError' || err.name === 'AbortError' || /Storage operation failed/.test(err.message)) throw err;
          // anything else (e.g. already saved) is final
        }
      }
      outbox = outbox.filter(x => x !== ev);
      sentIds.add(ev.event_id);
    }
  } catch { serverDown = true; }
  finally {
    saveQueues(); delivering = false;
    if (saved) { await loadData(); softRender(); }
    if (outbox.length && !serverDown) setTimeout(deliver, 300);
  }
}

// ---------------------------------------------------------------- 3D helmet (persistent canvas)
let helmet3d = null;
const helmetCanvas = document.createElement('canvas');
helmetCanvas.className = 'helmet-canvas';
import('./helmet3d.js').then(m => { helmet3d = m.mountHelmet(helmetCanvas); syncHelmet(); if (!helmet3d) softRender(); }).catch(() => {});
function placeHelmet() {
  const slot = document.getElementById('helmet-slot');
  if (!slot) return;
  if (helmet3d) slot.replaceChildren(helmetCanvas);
  else slot.innerHTML = `<div class="helmet-flat">${icon('helmet')}</div>`;
}

// ---------------------------------------------------------------- weather
async function loadWeather() {
  if (S.weatherBusy) return;
  S.weatherBusy = true; S.weatherErr = ''; softRender();
  try {
    const q = new URLSearchParams({
      latitude: S.city.latitude, longitude: S.city.longitude,
      current: 'temperature_2m,weather_code,wind_speed_10m,precipitation',
      hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
      forecast_hours: 8, temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      timeformat: 'unixtime', timezone: 'auto'});
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q);
    const d = await r.json();
    if (!d.current) throw new Error();
    const h = d.hourly, now = Date.now() / 1000;
    const hours = h.time.map((t, i) => ({time: t, temperature_2m: h.temperature_2m[i], precipitation_probability: h.precipitation_probability?.[i] ?? 0,
      weather_code: h.weather_code[i], wind_speed_10m: h.wind_speed_10m[i]})).filter(x => x.time > now).slice(0, 6);
    S.weather = {current: d.current, hours, at: Date.now()};
  } catch { S.weatherErr = 'Weather unavailable right now.'; }
  finally { S.weatherBusy = false; softRender(); }
}

async function findCity(name) {
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({name, count: 1, language: 'en', format: 'json'}));
  const c = (await r.json()).results?.[0];
  if (!c) throw new Error('City not found');
  return {name: `${c.name}${c.admin1 ? ', ' + c.admin1 : ''}`, latitude: c.latitude, longitude: c.longitude};
}

function setCity(city) { S.city = city; store.set('nh-city', city); S.editCity = false; S.weather = null; loadWeather(); }

// ---------------------------------------------------------------- shared pieces
function helmetPill() {
  const h = S.helmet;
  if (h.state === 'connected') return `<a class="pill on" href="#helmet"><span class="dot"></span>Helmet${h.battery_pct ? ' · ' + h.battery_pct + '%' : ''}</a>`;
  if (h.state === 'connecting') return `<span class="pill"><span class="dot pulse"></span>Connecting…</span>`;
  if (h.state === 'unsupported') return `<a class="pill" href="#helmet">Use Chrome</a>`;
  return `<button class="pill connect" data-action="connect">${icon('helmet')}Connect</button>`;
}

function alertCard() {
  const c = S.helmet.state === 'connected' && S.helmet.crash_state_name;
  if (c === 'countdown') return `<div class="alert-card warn" role="alert">${icon('alert')}<div><strong>Possible crash</strong><p>The helmet thinks the rider went down. It is counting down. Sit up, or tap below if you're OK.</p>${link.canCommand ? `<button class="btn" data-action="im-ok">${icon('check')}I'm OK</button>` : ''}</div></div>`;
  if (c === 'alert') return `<div class="alert-card danger" role="alert">${icon('alert')}<div><strong>No response from the rider</strong><p>The countdown ended after a possible crash. Check on the rider now.</p></div></div>`;
  return '';
}

function strengthMeter(e) {
  const s = U.strength(e);
  return `<div class="meter"><div class="meter-bar"><span class="z light"></span><span class="z moderate"></span><span class="z hard"></span><i style="left:${(s.pos * 100).toFixed(1)}%"></i></div><div class="meter-labels"><span>Light</span><span>Moderate</span><span>Hard</span></div></div>`;
}

function impactRow(e) {
  const lvl = U.impactLevel(e);
  return `<a class="row impact ${lvl}" href="#impact/${encodeURIComponent(e.event_id)}"><span class="lvl-dot"></span><div class="row-main"><strong>${U.impactName(e)}</strong><small>${esc(U.whenText(e.incident_time_utc))}${e.crash_suspected ? ' · Rider went down' : ''}</small></div>${icon('chevron', 'chev')}</a>`;
}

function rideRow(r) {
  const c = counts(rideImpacts(r));
  const check = r.active ? '<span class="tag live">Riding now</span>' : r.checkin ? `<span class="tag ${r.checkin.feel_fine ? 'ok' : 'warn'}">${r.checkin.feel_fine ? 'Felt fine' : 'Reported pain'}</span>` : '<span class="tag todo">Check-in needed</span>';
  return `<a class="row ride-row" href="#ride/${encodeURIComponent(r.ride_id)}"><span class="ride-icon">${icon('ride')}</span><div class="row-main"><strong>${esc(U.rideTitle(r.started_utc))}</strong><small>${esc(U.whenText(r.started_utc))} · ${U.durationWords(rideElapsed(r))} · ${U.countsText(c.hard, c.moderate)}</small><div class="tags">${check}</div></div>${icon('chevron', 'chev')}</a>`;
}

function countTiles(c) {
  return `<div class="tiles"><div class="tile hard"><strong>${c.hard}</strong><span>Hard impact${c.hard === 1 ? '' : 's'}</span></div><div class="tile moderate"><strong>${c.moderate}</strong><span>Moderate impact${c.moderate === 1 ? '' : 's'}</span></div></div>`;
}

const serverNote = () => S.server === 'down' ? `<div class="note">${icon('alert')}<span>Can't reach the NeuroHalo server. Start it on the laptop with <code>python server.py</code>.</span></div>` : '';
const DANGER = `<div class="note">${icon('alert')}<span><strong>Get medical help right away</strong> if a headache gets worse or won't go away, or there is repeated vomiting, slurred speech, weakness or numbness, confusion, a seizure, or passing out. NeuroHalo records impacts; it can't diagnose an injury.</span></div>`;

// ---------------------------------------------------------------- graphs (plain labels, no raw units)
const niceMax = (v, steps) => { for (const s of steps) if (v <= s) return s; return Math.ceil(v / steps.at(-1)) * steps.at(-1); };

// Jolt strength over the fraction of a second around the hit, with Light / Moderate / Hard bands
function joltChart(e) {
  const pts = (e.samples || []).map(s => [s.t_us / 1000, Math.hypot(s.ax_g, s.ay_g, s.az_g)]);
  if (pts.length < 3) return '';
  const W = 330, H = 190, L = 34, R = 66, T = 12, B = 30, w = W - L - R, h = H - T - B;
  const t0 = pts[0][0], t1 = pts.at(-1)[0], top = niceMax(Math.max(...pts.map(p => p[1])), [16, 20, 24, 32]);
  const x = t => L + (t - t0) / (t1 - t0 || 1) * w, y = v => T + h - Math.min(v, top) / top * h;
  const band = (a, b, cls, label) => `<rect x="${L}" y="${y(b)}" width="${w}" height="${y(a) - y(b)}" class="band ${cls}"/><text x="${L + w + 6}" y="${(y(a) + y(b)) / 2 + 4}" class="band-label ${cls}">${label}</text>`;
  const line = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, 4, 8, 12, 16].filter(v => v <= top);
  const xt = [-50, 0, 50, 100].filter(v => v >= t0 && v <= t1);
  return `<figure class="chart"><figcaption>Jolt strength <span>× the pull of gravity</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Jolt strength around the moment of the hit">
    ${band(0, 8, 'light', 'Light')}${band(8, 12, 'moderate', 'Moderate')}${band(12, top, 'hard', 'Hard')}
    ${ticks.map(v => `<line x1="${L}" x2="${L + w}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}×</text>`).join('')}
    <line x1="${x(0)}" x2="${x(0)}" y1="${T}" y2="${T + h}" class="hit"/>
    <path d="${line}" class="line"/>
    ${xt.map(v => `<text x="${x(v)}" y="${H - 10}" text-anchor="middle">${v === 0 ? 'hit' : (v > 0 ? '+' : '') + v + ' ms'}</text>`).join('')}
  </svg></figure>`;
}

// How fast the head was turning, in turns per second (1 turn = 360°)
function turnChart(e) {
  const pts = (e.samples || []).map(s => [s.t_us / 1000, Math.hypot(s.gx_dps ?? 0, s.gy_dps ?? 0, s.gz_dps ?? 0) / 360]);
  if (pts.length < 3) return '';
  const W = 330, H = 150, L = 34, R = 66, T = 12, B = 30, w = W - L - R, h = H - T - B;
  const t0 = pts[0][0], t1 = pts.at(-1)[0], top = niceMax(Math.max(...pts.map(p => p[1]), 0.5), [0.5, 1, 2, 3, 4, 6]);
  const x = t => L + (t - t0) / (t1 - t0 || 1) * w, y = v => T + h - v / top * h;
  const line = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, top / 2, top];
  return `<figure class="chart"><figcaption>Head turning <span>turns per second</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="How fast the head was turning around the hit">
    ${ticks.map(v => `<line x1="${L}" x2="${L + w}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`).join('')}
    <line x1="${x(0)}" x2="${x(0)}" y1="${T}" y2="${T + h}" class="hit"/>
    <path d="${line} L${x(t1).toFixed(1)} ${y(0)} L${x(t0).toFixed(1)} ${y(0)}Z" class="area alt"/><path d="${line}" class="line alt"/>
    <text x="${x(0)}" y="${H - 10}" text-anchor="middle">hit</text>
  </svg></figure>`;
}

// Impacts over the ride: each dot is one impact, placed by when it happened and how strong it was.
// While riding, the right edge is "now" and new impacts pop in as the helmet sends them.
function impactChart(r, list) {
  const W = 330, H = 200, L = 34, R = 66, T = 14, B = 30, w = W - L - R, h = H - T - B;
  const start = Date.parse(r.started_utc), end = r.ended_utc ? Date.parse(r.ended_utc) : Date.now();
  const span = Math.max(end - start, 60000);                       // at least one minute wide
  const pts = list.filter(e => e.incident_time_utc).map(e => ({e, t: Date.parse(e.incident_time_utc), g: e.recorded_peak_resultant_g ?? 0}))
    .sort((a, b) => a.t - b.t);
  const top = niceMax(Math.max(16, ...pts.map(p => p.g)), [16, 20, 24, 32]);
  const x = t => L + Math.max(0, Math.min(1, (t - start) / span)) * w, y = v => T + h - Math.min(v, top) / top * h;
  const band = (a, b, cls, label) => `<rect x="${L}" y="${y(b)}" width="${w}" height="${y(a) - y(b)}" class="band ${cls}"/><text x="${L + w + 6}" y="${(y(a) + y(b)) / 2 + 4}" class="band-label ${cls}">${label}</text>`;
  const ticks = [0, 4, 8, 12, 16].filter(v => v <= top);
  const mins = span / 60000, stepMin = [1, 2, 5, 10, 15, 30, 60, 120].find(s => mins / s <= 4) || 240;
  const xt = []; for (let m = 0; m <= mins + 1e-9; m += stepMin) xt.push(m);
  const fmt = m => m === 0 ? 'start' : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min`;
  const newest = pts.at(-1);
  const dots = pts.map(p => {
    const lvl = U.impactLevel(p.e), cx = x(p.t).toFixed(1), cy = y(p.g).toFixed(1);
    const fresh = !r.ended_utc && p === newest && Date.now() - p.t < 20000;
    return `<a href="#impact/${encodeURIComponent(p.e.event_id)}"><line x1="${cx}" x2="${cx}" y1="${y(0)}" y2="${cy}" class="stem ${lvl}"/>
      ${fresh ? `<circle cx="${cx}" cy="${cy}" r="7" class="ping ${lvl}"/>` : ''}
      ${p.e.crash_suspected ? `<circle cx="${cx}" cy="${cy}" r="10" class="crash-ring"/>` : ''}
      <circle cx="${cx}" cy="${cy}" r="6" class="mark-dot ${lvl}"><title>${U.impactName(p.e)} · ${p.g.toFixed(1)}× gravity · ${new Date(p.t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'})}</title></circle></a>`;
  }).join('');
  return `<figure class="chart"><figcaption>${r.ended_utc ? 'Impacts on this ride' : 'Live impacts'} <span>how hard, and when</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Impacts during the ride by time and strength">
    ${band(0, 8, 'light', 'Light')}${band(8, 12, 'moderate', 'Moderate')}${band(12, top, 'hard', 'Hard')}
    ${ticks.map(v => `<line x1="${L}" x2="${L + w}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}×</text>`).join('')}
    ${!r.ended_utc ? `<line x1="${x(end)}" x2="${x(end)}" y1="${T}" y2="${T + h}" class="now"/>` : ''}
    ${dots}
    ${xt.map(m => `<text x="${x(start + m * 60000)}" y="${H - 10}" text-anchor="${m === 0 ? 'start' : 'middle'}">${fmt(m)}</text>`).join('')}
    ${!r.ended_utc ? `<text x="${L + w}" y="${T - 3}" text-anchor="end" class="now-label">now</text>` : ''}
  </svg>
  ${pts.length ? `<div class="legend"><span class="hard">Hard</span><span class="moderate">Moderate</span>${pts.some(p => p.e.crash_suspected) ? '<span class="crash">Rider went down</span>' : ''}</div>`
    : `<p class="muted small">${r.ended_utc ? 'No impacts on this ride.' : 'No impacts yet. They will pop up here as they happen.'}</p>`}</figure>`;
}

// Live monitor: scrolls right to left like a heart monitor; the dot at the right edge is "now".
// Flat while nothing happens; each impact rises as a smooth spike as tall as the hit was hard.
const MON = {W: 330, H: 180, L: 30, R: 62, T: 12, B: 26, windowS: 60, top: 16};
function monitorChart() {
  const {W, H, L, R, T, B, top} = MON, w = W - L - R, h = H - T - B, y = v => T + h - Math.min(v, top) / top * h;
  const band = (a, b, cls, label) => `<rect x="${L}" y="${y(b)}" width="${w}" height="${y(a) - y(b)}" class="band ${cls}"/><text x="${L + w + 8}" y="${(y(a) + y(b)) / 2 + 4}" class="band-label ${cls}">${label}</text>`;
  return `<figure class="chart monitor"><figcaption>Live impacts <span id="mon-sub">last minute</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Live line that rises at each impact">
    <defs><clipPath id="mon-clip"><rect x="${L}" y="0" width="${w}" height="${H}"/></clipPath></defs>
    ${band(0, 8, 'light', 'Light')}${band(8, 12, 'moderate', 'Moderate')}${band(12, top, 'hard', 'Hard')}
    ${[0, 8, 12].map(v => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}×</text>`).join('')}
    <g clip-path="url(#mon-clip)"><path id="mon-area" class="mon-area"/><path id="mon-line" class="mon-line"/><g id="mon-peaks"></g></g>
    <circle id="mon-halo" r="8" class="mon-halo"/><circle id="mon-dot" r="4.5" class="mon-dot"/>
    <text x="${L}" y="${H - 6}">1 min ago</text><text x="${L + w / 2}" y="${H - 6}" text-anchor="middle">30 s</text><text x="${L + w}" y="${H - 6}" text-anchor="end">now</text>
  </svg></figure>`;
}

// What the live graph shows. Each impact is drawn ONCE, the moment we first hear about it
// (usually the helmet's instant ping), and never moved or recolored afterwards.
const drawn = new Map();
const pingLevel = q => q.light ? 'light' : q.saturated || q.g >= 12 ? 'hard' : 'moderate';
function monitorImpacts() {
  const r = S.current; if (!r) return [];
  const start = Date.parse(r.started_utc), list = [...drawn.values()];
  const near = t => list.some(p => Math.abs(p.t0 - t) < 2000);
  // 1) instant pings: drawn where they happened (that's "now" when they arrive)
  for (const [k, q] of quickSpikes) {
    if (drawn.has(k) || q.t < start - 1000 || near(q.t)) continue;
    const p = {t: q.t, t0: q.t, g: q.g, lvl: pingLevel(q)}; drawn.set(k, p); list.push(p);
  }
  // 2) recordings that came without a ping (older helmet code): drawn at the moment they
  //    ARRIVE, so the graph never goes back in time. Old catch-up recordings aren't drawn.
  for (const {e, at} of liveSpikes.values()) {
    const k = 'e-' + e.event_id, t0 = Date.parse(e.incident_time_utc);
    if (drawn.has(k) || t0 < start - 1000 || near(t0) || at - t0 > 60000) continue;
    const g = e.recorded_peak_resultant_g ?? Math.max(0, ...(e.samples || []).map(s => Math.hypot(s.ax_g, s.ay_g, s.az_g)));
    const p = {t: at, t0, g, lvl: U.impactLevel(e)}; drawn.set(k, p); list.push(p);
  }
  return list.filter(p => p.t0 >= start - 1000);
}

// Impacts we know about but the server hasn't saved yet: instant pings and fresh recordings.
// Counted and listed right away so nothing waits for the server.
function pendingImpacts(r) {
  const start = Date.parse(r.started_utc), seen = rideImpacts(r).map(e => Date.parse(e.incident_time_utc)), out = [];
  const add = (t, lvl) => { if (t >= start - 1000 && !seen.some(s => Math.abs(s - t) < 2000)) { seen.push(t); out.push({t, lvl}); } };
  for (const {e} of liveSpikes.values()) if (!S.events.some(x => x.event_id === e.event_id)) add(Date.parse(e.incident_time_utc), U.impactLevel(e));
  for (const q of quickSpikes.values()) if (!q.light && Date.now() - q.t < 180000) add(q.t, pingLevel(q));
  return out;
}

const monitorEl = document.createElement('div');   // the live graph lives here and is reused, never rebuilt

// Smooth bump, ~1.5 s wide, height = how hard the hit was (in × gravity)
const spikeAt = (dt, peak) => Math.abs(dt) > 1.6 ? 0 : peak * Math.exp(-(dt * dt) / (2 * 0.4 * 0.4));

function drawMonitor(now) {
  const line = document.getElementById('mon-line');
  if (!line || !S.current) return;
  const {W, H, L, R, T, B, windowS, top} = MON, w = W - L - R, h = H - T - B;
  const y = v => T + h - Math.min(v, top) / top * h, x = s => L + w - s / windowS * w;   // s = seconds ago
  const nowMs = Date.now(), hits = monitorImpacts().filter(p => nowMs - p.t < (windowS + 2) * 1000);
  const value = ago => hits.reduce((m, p) => Math.max(m, spikeAt((nowMs - p.t) / 1000 - ago, p.g)), 0);
  const pts = [];
  for (let ago = windowS + 1; ago >= 0; ago -= 0.5) pts.push(ago);
  for (const p of hits) { const c = (nowMs - p.t) / 1000; for (let d = -1.6; d <= 1.6; d += 0.06) if (c - d >= 0) pts.push(c - d); }
  pts.sort((a, b) => b - a);
  const d = pts.map((ago, i) => `${i ? 'L' : 'M'}${x(ago).toFixed(1)} ${y(value(ago)).toFixed(1)}`).join(' ');
  line.setAttribute('d', d);
  document.getElementById('mon-area').setAttribute('d', `${d} L${x(0)} ${y(0)} L${x(windowS + 1)} ${y(0)} Z`);
  const names = {hard: 'Hard', moderate: 'Moderate', light: 'Light (not saved)'};
  document.getElementById('mon-peaks').innerHTML = hits.map(p => {
    const cx = x((nowMs - p.t) / 1000).toFixed(1), cy = y(p.g).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="4.5" class="mark-dot ${p.lvl}"><title>${names[p.lvl] || 'Impact'} · ${new Date(p.t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'})}</title></circle>`;
  }).join('');
  const dy = y(value(0)), dot = document.getElementById('mon-dot'), halo = document.getElementById('mon-halo');
  const connected = S.helmet.state === 'connected';
  for (const el of [dot, halo]) { el.setAttribute('cx', L + w); el.setAttribute('cy', dy); el.classList.toggle('off', !connected); }
  halo.setAttribute('r', 6 + 2.5 * (0.5 + 0.5 * Math.sin(now / 400)));
  document.getElementById('mon-sub').textContent = !connected ? 'helmet not connected' : link.canPing ? 'last minute' : 'old helmet code · spikes ~10 s late';
}
(function monitorLoop(t) { drawMonitor(t || 0); requestAnimationFrame(monitorLoop); })();

// Hard and moderate impacts per ride, last 8 rides
function trendChart(rides) {
  const list = rides.filter(r => !r.active).sort((a, b) => Date.parse(a.started_utc) - Date.parse(b.started_utc)).slice(-8);
  if (list.length < 2) return '';
  const data = list.map(r => ({r, ...counts(rideImpacts(r))}));
  const W = 330, H = 170, L = 26, R = 8, T = 12, B = 34, w = W - L - R, h = H - T - B;
  const top = Math.max(2, niceMax(Math.max(...data.map(d => d.hard + d.moderate)), [2, 4, 6, 8, 10, 15, 20]));
  const bw = Math.min(26, w / data.length * 0.55), step = w / data.length, y = v => T + h - v / top * h;
  const bars = data.map((d, i) => {
    const cx = L + step * (i + 0.5), x0 = cx - bw / 2;
    const sameDay = new Set(data.map(x => new Date(x.r.started_utc).toDateString())).size === 1;
    const day = sameDay ? new Date(d.r.started_utc).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : new Date(d.r.started_utc).toLocaleDateString([], {month: 'numeric', day: 'numeric'});
    return `<a href="#ride/${encodeURIComponent(d.r.ride_id)}"><rect x="${x0}" y="${y(d.hard)}" width="${bw}" height="${y(0) - y(d.hard)}" rx="3" class="bar hard"/>
      <rect x="${x0}" y="${y(d.hard + d.moderate)}" width="${bw}" height="${y(d.hard) - y(d.hard + d.moderate)}" rx="3" class="bar moderate"/>
      ${!d.hard && !d.moderate ? `<circle cx="${cx}" cy="${y(0) - 4}" r="3" class="zero"/>` : ''}
      <text x="${cx}" y="${H - 12}" text-anchor="middle">${day}</text></a>`;
  }).join('');
  return `<section class="card"><figure class="chart"><figcaption>Impacts per ride <span>last ${data.length} rides</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hard and moderate impacts per ride">
    ${[0, top / 2, top].map(v => `<line x1="${L}" x2="${L + w}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}${bars}
  </svg><div class="legend"><span class="hard">Hard</span><span class="moderate">Moderate</span></div></figure></section>`;
}

// ---------------------------------------------------------------- pages
function homePage() {
  const h = S.helmet, r = S.current, last = S.rides.find(x => !x.active);
  const helmetLine = h.state === 'connected' ? `Connected${h.battery_pct ? ' · ' + h.battery_pct + '% battery' : ''}`
    : h.state === 'connecting' ? 'Connecting…' : h.state === 'unsupported' ? 'Open this app in Chrome to connect' : 'Not connected';
  const lastC = last ? counts(rideImpacts(last)) : null;
  const liveC = r ? counts(rideImpacts(r)) : null;
  return `${serverNote()}
  <section class="card helmet-card ${h.state}">
    <div id="helmet-slot" class="helmet-slot"></div>
    <div class="helmet-info"><span class="eyebrow">Your helmet</span><h2>${helmetLine}</h2>
      ${h.state === 'connected' ? `<p>${h.calibrated ? 'Ready. Impacts are being watched.' : 'Hold the helmet upright for a second…'}</p>`
        : h.state === 'disconnected' ? `<p>Turn the helmet on, then connect. You only do this once.</p><button class="btn lime" data-action="connect">${icon('helmet')}Connect helmet</button>` : ''}
    </div>
  </section>

  <section class="card ride-card">
    <div class="card-head"><span class="eyebrow">My ride</span>${r ? '<span class="tag live">Recording</span>' : ''}</div>
    ${r ? `<div class="live-ride"><div><span class="big-time" data-timer>${U.timer(rideElapsed(r))}</span><small>${U.countsText(liveC.hard, liveC.moderate)} so far</small></div><a class="btn lime" href="#ride">Open ride</a></div>`
      : `<h2>Ready to ride?</h2><p>Start a ride and NeuroHalo watches for hard and moderate impacts.</p><button class="btn lime big" data-action="start-ride" ${S.server !== 'ok' ? 'disabled' : ''}>${icon('play')}Start ride</button>`}
    ${last && !r ? `<a class="last-ride" href="#ride/${encodeURIComponent(last.ride_id)}"><span>Last ride · ${esc(U.whenText(last.started_utc))}</span><strong>${U.durationWords(rideElapsed(last))} · ${U.countsText(lastC.hard, lastC.moderate)}</strong>${!last.checkin ? '<em>How do you feel? Do your check-in</em>' : ''}</a>` : ''}
  </section>

  ${tipCard()}
  ${weatherCard()}`;
}

// Tip of the day: a new brain-health tip each day; "Another tip" flips through the rest
let tipOffset = 0;
function tipCard() {
  const t = U.tipOfDay(new Date(), tipOffset);
  return `<section class="card tip-card"><div class="card-head"><span class="eyebrow">${icon('bulb')}${tipOffset ? 'Brain tip' : 'Tip of the day'}</span><button class="text-btn" data-action="next-tip">Another tip</button></div>
    <h3>${esc(t.title)}</h3><p>${esc(t.text)}</p></section>`;
}

function weatherCard() {
  const w = S.weather;
  let body;
  if (!w) body = `<p class="muted">${S.weatherBusy ? 'Checking the weather…' : esc(S.weatherErr || 'Weather needs an internet connection.')}</p>${S.weatherErr ? '<button class="text-btn" data-action="weather-retry">Try again</button>' : ''}`;
  else {
    const c = w.current, v = U.rideVerdict(c, w.hours), kind = U.weatherKind(c.weather_code);
    body = `<div class="wx-now"><span class="wx-icon">${icon(kind)}</span><div><strong>${Math.round(c.temperature_2m)}°</strong><span>${U.weatherWords(c.weather_code)} · Wind ${Math.round(c.wind_speed_10m)} mph</span></div></div>
      <div class="verdict ${v.level}">${icon(v.level === 'good' ? 'check' : 'alert')}<div><strong>${v.title}</strong><span>${esc(v.detail)}</span></div></div>
      <div class="wx-hours">${w.hours.map(hr => `<div><span>${new Date(hr.time * 1000).toLocaleTimeString([], {hour: 'numeric'})}</span>${icon(U.weatherKind(hr.weather_code))}<strong>${Math.round(hr.temperature_2m)}°</strong><small>${hr.precipitation_probability ? hr.precipitation_probability + '%' : ''}</small></div>`).join('')}</div>`;
  }
  const loc = S.editCity
    ? `<form class="city-form" data-form="city"><input name="city" placeholder="City name" required minlength="2" autocomplete="off"><button class="btn small">Find</button><button type="button" class="btn small ghost" data-action="locate" aria-label="Use my location">${icon('locate')}</button></form>`
    : `<button class="loc" data-action="edit-city">${icon('pin')}${esc(S.city.name)}</button>`;
  return `<section class="card weather-card"><div class="card-head"><span class="eyebrow">Weather</span>${loc}</div>${body}</section>`;
}

function ridePage() {
  const r = S.current;
  if (!r) return `${serverNote()}<section class="card center-card"><div class="ring"><span>Not recording</span><strong>00:00</strong></div><h2>Ready to ride?</h2><p>Only hard and moderate impacts during a ride are saved.</p>
    <button class="btn lime big" data-action="start-ride" ${S.server !== 'ok' ? 'disabled' : ''}>${icon('play')}Start ride</button>
    ${S.helmet.state !== 'connected' ? `<p class="muted small">Your helmet isn't connected yet.</p>${S.helmet.state === 'disconnected' ? `<button class="btn ghost" data-action="connect">${icon('helmet')}Connect helmet</button>` : ''}` : ''}</section>`;
  const list = rideImpacts(r), c = counts(list), pend = pendingImpacts(r);
  for (const p of pend) c[p.lvl]++;
  const pendRows = pend.sort((a, b) => b.t - a.t).map(p => `<div class="row impact ${p.lvl}"><span class="lvl-dot"></span><div class="row-main"><strong>${p.lvl === 'hard' ? 'Hard impact' : 'Moderate impact'}</strong><small>Just now · saving…</small></div></div>`).join('');
  return `<section class="card center-card riding"><div class="ring live"><span>Recording</span><strong data-timer>${U.timer(rideElapsed(r))}</strong><small>Started ${new Date(r.started_utc).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}</small></div>
    ${S.endAsk && S.helmet.state !== 'connected' ? `<div class="end-ask"><strong>Connect your helmet first?</strong><p>Your helmet keeps any impacts from while it was away. Connect it now to add them before the report is made.</p>
      <button class="btn lime" data-action="connect">${icon('helmet')}Connect helmet</button><button class="btn ghost" data-action="end-ride" data-force="1">End ride anyway</button><button class="text-btn" data-action="end-cancel">Keep riding</button>
      <p class="muted small">Ending anyway is fine: they'll be added to this ride the next time the helmet connects.</p></div>`
      : `<button class="btn danger big" data-action="end-ride" ${S.busy ? 'disabled' : ''}>${icon('stop')}End ride</button>`}</section>
    ${offlineNote()}
    ${countTiles(c)}
    <section class="card" id="monitor-slot"></section>
    <section class="card"><div class="card-head"><h3>Impacts this ride</h3></div>${list.length || pend.length ? pendRows + list.map(impactRow).join('') : '<p class="muted">None yet. Ride safe!</p>'}</section>`;
}

// While riding: is the helmet away, or catching up on impacts it kept while away?
function offlineNote() {
  const h = S.helmet;
  // "catching up" only right after a reconnect; otherwise waiting impacts are just new ones being sent
  if (h.state === 'connected' && (h.pending ?? 0) > 0 && wasAway && Date.now() - link.connectedAt < 120000)
    return `<div class="note ok">${icon('helmet')}<span><strong>Catching up</strong> Getting ${h.pending} impact${h.pending === 1 ? '' : 's'} the helmet saved while it was away…</span></div>`;
  if (h.state !== 'connected' && store.get('nh-paired', 0))
    return `<div class="note">${icon('helmet')}<span><strong>Helmet out of range.</strong> It keeps recording on its own (up to 30 impacts) and sends them when it reconnects. Keep the helmet powered on. ${h.state === 'connecting' ? 'Reconnecting…' : ''}</span></div>`;
  return '';
}

function rideReport(id) {
  if (S.server === 'checking') return LOADING('Loading your ride', 'One moment…');
  const r = S.rides.find(x => x.ride_id === id);
  if (!r) return `<a class="back" href="#history">${icon('back')}History</a><section class="card"><p class="muted">Ride not found.</p></section>`;
  const list = rideImpacts(r), c = counts(list), ck = r.checkin;
  return `<a class="back" href="#history">${icon('back')}History</a>
  <div class="page-head"><span class="eyebrow">Ride report</span><h1>${esc(U.rideTitle(r.started_utc))}</h1>
    <p>${new Date(r.started_utc).toLocaleDateString([], {month: 'long', day: 'numeric'})} · ${U.durationWords(rideElapsed(r))}${r.active ? ' · still recording' : ''}</p></div>
  ${countTiles(c)}
  <section class="card">${impactChart(r, list)}</section>
  ${list.some(e => e.crash_suspected) ? `<div class="note warn">${icon('alert')}<span><strong>Possible crash on this ride.</strong> After an impact, the rider was down and still.</span></div>` : ''}
  ${r.active ? '' : `<a class="card coach-cta" href="#coach/${encodeURIComponent(r.ride_id)}"><span class="ride-icon">${icon('chat')}</span><div><strong>Talk it through</strong><small>Chat with the AI coach about this ride and how you feel</small></div>${icon('chevron', 'chev')}</a>`}
  <section class="card"><div class="card-head"><h3>How you felt after</h3>${ck ? `<a class="text-btn" href="#checkin/${encodeURIComponent(r.ride_id)}">Edit</a>` : ''}</div>
    ${ck ? checkinSummary(ck) : r.active ? '<p class="muted">You can check in after the ride ends.</p>' : `<p>Take 30 seconds to note any pain or symptoms.</p><a class="btn lime" href="#checkin/${encodeURIComponent(r.ride_id)}">Start check-in</a>`}
  </section>
  <section class="card"><div class="card-head"><h3>Impacts</h3></div>${list.length ? list.map(impactRow).join('') : '<p class="muted">No hard or moderate impacts. Clean ride!</p>'}</section>
  ${ck && !ck.feel_fine ? DANGER : ''}`;
}

function checkinSummary(ck) {
  if (ck.feel_fine) return `<div class="fine">${icon('check')}<strong>Felt fine</strong></div>`;
  return `<div class="ck-sum">${headMap(ck.pain_regions, false)}<div>
    ${ck.pain_regions.length ? `<p><strong>Pain:</strong> ${ck.pain_regions.join(', ')}</p>` : ''}
    ${ck.symptoms.length ? `<p><strong>Symptoms:</strong> ${ck.symptoms.join(', ')}</p>` : ''}
    ${ck.notes ? `<p class="muted">“${esc(ck.notes)}”</p>` : ''}</div></div>`;
}

// Top-down head: nose at the top. Regions are tappable when editable.
function headMap(selected = [], editable = true) {
  const sel = n => selected.includes(n) ? 'sel' : '';
  const R = {Front: 'M60 84C68 36 152 36 160 84L136 104Q110 88 84 104Z', Left: 'M60 84L84 104Q70 132 84 158L62 184Q34 136 60 84Z',
    Right: 'M160 84L136 104Q150 132 136 158L158 184Q186 136 160 84Z', Back: 'M62 184L84 158Q110 176 136 158L158 184Q110 222 62 184Z',
    Top: 'M84 104Q110 88 136 104Q150 132 136 158Q110 176 84 158Q70 132 84 104Z'};
  const parts = Object.entries(R).map(([n, d]) => `<path d="${d}" class="region ${sel(n)}" ${editable ? `data-region="${n}" role="button" tabindex="0" aria-pressed="${selected.includes(n)}"` : ''}><title>${n}</title></path>`).join('');
  return `<div class="head ${editable ? 'editable' : ''}"><svg viewBox="0 0 220 240" aria-label="Head seen from above, nose at the top">
    <path d="M102 34 110 20 118 34" class="nose"/><ellipse cx="44" cy="130" rx="9" ry="18" class="ear"/><ellipse cx="176" cy="130" rx="9" ry="18" class="ear"/>${parts}
    <text x="110" y="14">Front</text><text x="110" y="236">Back</text><text x="22" y="98">L</text><text x="198" y="98">R</text></svg>
    ${editable ? `<div class="extra-regions">${['Face', 'Neck'].map(n => `<button type="button" class="chip ${sel(n)}" data-region="${n}">${n}</button>`).join('')}</div>` : (selected.filter(n => n === 'Face' || n === 'Neck').map(n => `<span class="chip sel">${n}</span>`).join(''))}</div>`;
}

function checkinPage(id) {
  if (S.server === 'checking') return LOADING('Loading your ride', 'One moment…');
  const r = S.rides.find(x => x.ride_id === id);
  if (!r) return `<a class="back" href="#history">${icon('back')}History</a><section class="card"><p class="muted">Ride not found.</p></section>`;
  if (!S.checkin || S.checkin.rideId !== id) {
    const old = r.checkin;
    S.checkin = {rideId: id, regions: new Set(old?.pain_regions || []), symptoms: new Set(old?.symptoms || []), notes: old?.notes || '',
      off: !!old && !old.feel_fine};   // off = 'something hurts or feels off' chosen
  }
  const f = S.checkin;
  return `<a class="back" href="#ride/${encodeURIComponent(id)}">${icon('back')}Ride report</a>
  <div class="page-head"><span class="eyebrow">After-ride check-in</span><h1>How do you feel?</h1><p>${esc(U.rideTitle(r.started_utc))} · ${U.durationWords(rideElapsed(r))}</p></div>
  <div class="choice">
    <button class="choice-btn ${!f.off ? '' : 'dim'}" data-action="feel-fine">${icon('check')}<strong>I feel fine</strong><small>Nothing hurts, no symptoms</small></button>
    <button class="choice-btn off ${f.off ? 'sel' : ''}" data-action="feel-off">${icon('alert')}<strong>Something's off</strong><small>Pain or symptoms</small></button>
  </div>
  ${!f.off ? '' : `<section class="card"><div class="card-head"><h3>Where does it hurt?</h3><span class="muted small">Tap all that apply</span></div>${headMap([...f.regions], true)}</section>
  <section class="card"><div class="card-head"><h3>Any of these?</h3></div><div class="chips">${U.CHECKIN_SYMPTOMS.map(s => `<button type="button" class="chip ${f.symptoms.has(s) ? 'sel' : ''}" data-symptom="${esc(s)}">${esc(s)}</button>`).join('')}</div></section>
  <section class="card"><div class="card-head"><h3>Anything else?</h3></div><textarea id="ck-notes" maxlength="2000" placeholder="What happened, how you feel…">${esc(f.notes)}</textarea></section>
  <button class="btn lime big wide" data-action="save-checkin" ${S.busy || (!f.regions.size && !f.symptoms.size && !f.notes.trim()) ? 'disabled' : ''}>Save check-in</button>
  ${DANGER}`}`;
}

function impactPage(id) {
  const e = S.details[id] || S.events.find(x => x.event_id === id);
  if (!e) return `<a class="back" href="#history">${icon('back')}Back</a><section class="card"><p class="muted">Impact not found.</p></section>`;
  if (!S.details[id]) loadDetail(id);
  const ride = S.rides.find(r => r.ride_id === (S.events.find(x => x.event_id === id)?.ride_id));
  return `<a class="back" href="${ride ? '#ride/' + encodeURIComponent(ride.ride_id) : '#history'}">${icon('back')}${ride ? 'Ride report' : 'Back'}</a>
  <div class="page-head"><span class="eyebrow">${esc(U.whenText(e.incident_time_utc))}</span><h1 class="${U.impactLevel(e)}-text">${U.impactName(e)}</h1>${ride ? `<p>During your ${esc(U.rideTitle(ride.started_utc))}</p>` : ''}</div>
  <section class="card"><div class="card-head"><h3>How hard was it?</h3><strong class="${U.impactLevel(e)}-text">${U.strength(e).words}</strong></div>${strengthMeter(e)}</section>
  <section class="card">${S.details[id] ? joltChart(S.details[id]) + turnChart(S.details[id]) : '<p class="muted">Loading the graphs…</p>'}</section>
  <section class="card"><div class="card-head"><h3>What happened</h3></div><ul class="facts">${U.impactFacts(S.details[id] || e).map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>
  <section class="card"><div class="card-head"><h3>Your note</h3></div><textarea id="impact-note" maxlength="2000" placeholder="Where were you? What happened?">${esc(userNote(e))}</textarea><div class="right"><button class="btn small" data-action="save-note" data-id="${esc(id)}">Save note</button></div></section>
  <details class="card tech"><summary>Details for your coach or doctor</summary>
    <dl><dt>Peak acceleration</dt><dd>${(e.accel_clipped_axes || []).length ? 'Above 16 g (sensor limit)' : (e.recorded_peak_resultant_g ?? 0).toFixed(1) + ' g'}</dd>
    ${S.details[id] ? `<dt>Peak head rotation</dt><dd>${Math.round(U.peakSpin(S.details[id].samples))} °/s</dd>` : ''}
    <dt>Time</dt><dd>${e.incident_time_utc ? new Date(e.incident_time_utc).toLocaleString() : 'Unknown'}</dd>
    <dt>Rider down after impact</dt><dd>${e.crash_suspected ? 'Yes' : 'No'}</dd><dt>Record ID</dt><dd>${esc(e.event_id)}</dd></dl>
    <p class="muted small">Measured at the helmet, not inside the head. Not a diagnosis.</p></details>`;
}

// The device writes an automatic note; only show what the athlete wrote
const userNote = e => (e.user_notes || '').startsWith('Device reporting priority') ? '' : e.user_notes || '';

function spark(e) {
  const pts = (e.samples || []).map(s => [s.t_us, Math.hypot(s.ax_g, s.ay_g, s.az_g)]);
  if (pts.length < 3) return '';
  const t0 = pts[0][0], t1 = pts.at(-1)[0], max = Math.max(...pts.map(p => p[1]), 2);
  const x = t => 8 + (t - t0) / (t1 - t0 || 1) * 304, y = v => 70 - Math.min(v, max) / max * 60;
  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 320 88" aria-label="The jolt over a fraction of a second"><path d="${d} L312 76 L8 76Z" class="area"/><path d="${d}" class="line"/>
    <text x="8" y="88">before</text><text x="${x(0).toFixed(0)}" y="88" text-anchor="middle">impact</text><text x="312" y="88" text-anchor="end">after</text></svg>`;
}

async function loadDetail(id) {
  loadDetail.busy ||= new Set();
  if (loadDetail.busy.has(id)) return;
  loadDetail.busy.add(id);
  try { S.details[id] = await api('/events/' + encodeURIComponent(id)); softRender(); } catch {} finally { loadDetail.busy.delete(id); }
}

function historyPage() {
  const rides = [...S.rides].sort((a, b) => Date.parse(b.started_utc) - Date.parse(a.started_utc));
  const all = counts(S.events.filter(e => e.ride_id));
  return `${serverNote()}<div class="page-head"><span class="eyebrow">History</span><h1>Your rides</h1></div>
  ${rides.length ? countTiles(all) : ''}
  ${trendChart(rides)}
  <section class="card">${rides.length ? rides.map(rideRow).join('') : '<p class="muted">No rides yet. Start one from the Ride tab.</p>'}</section>`;
}

function helmetPage() {
  const h = S.helmet, on = h.state === 'connected';
  const row = (k, v) => `<div class="kv"><span>${k}</span><strong>${v}</strong></div>`;
  return `<section class="card helmet-card big ${h.state}"><div id="helmet-slot" class="helmet-slot"></div>
    <div class="helmet-info"><span class="eyebrow">Helmet</span><h2>${on ? 'Connected' : h.state === 'connecting' ? 'Connecting…' : 'Not connected'}</h2></div></section>
  <section class="card">
    ${on ? row('Battery', h.battery_pct ? h.battery_pct + '%' : 'Plugged in') + row('Position', U.positionText(h.tilt_deg)) + row('Ready', h.calibrated ? 'Yes' : 'Hold it upright') + row('Helmet code', link.upToDate ? 'Up to date' : '<span class="hard-text">Old: upload helmet_monitor_v3.ino</span>')
      + row('Crash watch', {normal: 'Watching', checking: 'Checking an impact…', countdown: 'Countdown!', alert: 'Alert sent', cancelled: 'Cancelled'}[h.crash_state_name] || 'Watching')
      + `<div class="calib"><div><strong>Set upright position</strong><p>Put the helmet on (or hold it the way it's worn), stay still, and tap the button.</p></div><button class="btn" data-action="calibrate">Set upright</button></div>`
      + `<div class="right"><button class="btn ghost small" data-action="disconnect">Disconnect</button></div>`
      : h.state === 'unsupported' ? '<p>This browser can\'t use Bluetooth. Open NeuroHalo in <strong>Chrome</strong> or <strong>Edge</strong> on a laptop or Android phone.</p>'
      : `<ol class="steps"><li>Turn the helmet on and keep it upright and still for a second.</li><li>Tap <strong>Connect helmet</strong> and pick <strong>HelmetMonitor</strong>.</li><li>That's it. The app reconnects on its own after this.</li></ol><button class="btn lime big wide" data-action="connect" ${h.state === 'connecting' ? 'disabled' : ''}>${icon('helmet')}Connect helmet</button>`}
  </section>
  ${onLaptop ? `<section class="card"><div class="calib"><div><strong>Use NeuroHalo on your phone</strong><p>Scan a QR code to open this app on your phone. Keep this laptop on with the server running.</p></div><button class="btn" data-action="phone-qr">Show QR</button></div></section>` : ''}
  <section class="card"><div class="card-head"><h3>Good to know</h3></div><ul class="facts"><li>Keep this app open during your ride. It receives the helmet's impacts.</li><li>Only hard and moderate impacts during a ride are saved. Small bumps are ignored.</li><li>If you go down and stay still, the helmet counts down 30 seconds, then raises an alert.</li></ul></section>`;
}

// ---------------------------------------------------------------- finishing a ride
// The report waits until every impact is in: nothing arriving from the helmet, nothing
// stored on the helmet still to send, and nothing waiting to be saved on the server.
const LOADING = (title, text) => `<section class="card center-card loading-card"><div class="spinner" aria-hidden="true"></div><h2>${title}</h2><p class="muted">${text}</p></section>`;
function finishingPage() {
  const n = link.status === 'connected' ? link.heartbeat?.pending ?? 0 : 0;
  const steps = {helmet: n > 0 ? `Getting ${n} impact${n === 1 ? '' : 's'} from your helmet…` : 'Getting the last impacts from your helmet…', save: 'Saving impacts…', load: 'Building your ride report…'};
  return LOADING('Finishing your ride', steps[S.finishing.step] || steps.load);
}

// Start of a ride: first collect anything still on the helmet (it may belong to the last ride),
// then wipe its memory so this ride gets all 30 slots. Only possible while connected.
async function prepareHelmetForRide() {
  wasAway = false;
  if (link.status !== 'connected') return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const busy = () => link.status === 'connected' && (link.receiving || (link.heartbeat?.pending ?? 0) > 0);
  if (busy()) {
    S.starting = true; render();
    const giveUp = Date.now() + 20000;
    while (Date.now() < giveUp && busy()) await sleep(300);
    S.starting = false;
  }
  await link.clearHelmetMemory();
}

async function finishRide(id) {
  S.finishing = {id, step: 'helmet'}; render();
  const endedAt = Date.now();
  let giveUp = endedAt + 25000, lastPending = Infinity;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const helmetBusy = () => link.status === 'connected' && (link.receiving || (link.heartbeat?.pending ?? 0) > 0);
  // brief grace period so an impact that just happened can start arriving
  await sleep(1500);
  while (Date.now() < giveUp && helmetBusy()) {
    const n = link.heartbeat?.pending ?? 0;
    if (n < lastPending) { lastPending = n; giveUp = Math.max(giveUp, Date.now() + 20000); render(); }   // still catching up: keep waiting
    if (Date.now() - endedAt > 120000) break;
    await sleep(300);
  }
  S.finishing.step = 'save'; render();
  while (Date.now() < giveUp && (outbox.length || delivering)) { deliver(); await sleep(300); }
  S.finishing.step = 'load'; render();
  await loadData();
  S.finishing = null;
  if (outbox.length) toast('Some impacts are still saving. They will appear in the report shortly.');
}

// ---------------------------------------------------------------- AI ride coach
// Chat about a ride with an AI coach. The laptop server holds the API key and adds the ride data.
const RED_FLAGS = /(worse|worsening|won'?t go away|vomit|throw(ing)? up|threw up|confus|slurr|numb|weak(ness)?|seizure|pass(ed)? out|fainted|blacked out|can'?t (wake|walk|remember|see)|drows|pupil)/i;
const coachKey = id => 'nh-coach-' + id;
function coachChat(id) {
  if (!S.coach || S.coach.rideId !== id) S.coach = {rideId: id, messages: store.get(coachKey(id), []), busy: false, error: ''};
  return S.coach;
}
const KICKOFF = '(The rider just opened the coach. Greet them in one short sentence, sum up the ride in one or two sentences, then ask how they feel right now.)';

function coachPage(id) {
  const r = S.rides.find(x => x.ride_id === id);
  if (S.server === 'checking') return LOADING('Loading your ride', 'One moment…');
  if (!r) return `<a class="back" href="#history">${icon('back')}History</a><section class="card"><p class="muted">Ride not found.</p></section>`;
  const c = coachChat(id);
  if (!c.messages.length && !c.busy && !c.error) setTimeout(() => sendCoach(id, KICKOFF, true), 0);
  const bubbles = c.messages.filter(m => !m.hidden).map(m => m.role === 'flag' ? DANGER
    : `<div class="bubble ${m.role === 'user' ? 'me' : 'coach'}">${esc(m.content).replace(/\n/g, '<br>')}</div>`).join('');
  const mic = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  return `<a class="back" href="#ride/${encodeURIComponent(id)}">${icon('back')}Ride report</a>
  <div class="page-head"><span class="eyebrow">Ride coach</span><h1>Talk it through</h1><p>${esc(U.rideTitle(r.started_utc))} · AI coach, not a doctor</p></div>
  <section class="card chat" id="chat">${bubbles}${c.busy ? '<div class="bubble coach typing"><i></i><i></i><i></i></div>' : ''}
    ${c.error ? `<div class="note">${icon('alert')}<span>${esc(c.error)} <button class="text-btn" data-action="coach-retry">Try again</button></span></div>` : ''}</section>
  <form class="chat-input" data-form="coach">
    ${mic ? `<button type="button" class="icon-btn ${S.listening ? 'on' : ''}" data-action="coach-mic" aria-label="Talk">${icon('mic')}</button>` : ''}
    <input id="coach-text" name="text" placeholder="${S.listening ? 'Listening…' : 'How are you feeling?'}" autocomplete="off" maxlength="2000">
    <button class="icon-btn send" aria-label="Send" ${c.busy ? 'disabled' : ''}>${icon('send')}</button></form>
  <p class="muted small center">Your ride and check-in are sent to an AI service (Anthropic) to answer. If you feel worse, get medical help.</p>
  ${c.messages.length > 1 ? '<div class="center"><button class="text-btn" data-action="coach-reset">Start over</button></div>' : ''}`;
}

async function sendCoach(id, text, hidden = false) {
  const c = coachChat(id);
  text = text.trim();
  if (!text || c.busy) return;
  const before = c.messages.length;
  c.messages.push({role: 'user', content: text, hidden});
  if (!hidden && RED_FLAGS.test(text)) c.messages.push({role: 'flag', content: ''});   // safety note right away, before the AI answers
  c.busy = true; c.error = ''; S.editing = false; render(); scrollChat();
  try {
    const msgs = c.messages.filter(m => m.role !== 'flag').map(({role, content}) => ({role, content}));
    const res = await fetch('/api/coach', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ride_id: id, messages: msgs})});
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
    c.messages.push({role: 'assistant', content: body.reply});
    store.set(coachKey(id), c.messages.slice(-60));
  } catch (err) {
    c.messages.length = before;   // take the message back out so "Try again" resends it
    c.error = err.name === 'TypeError' ? "Can't reach the NeuroHalo server." : err.message;
    c.retry = {text, hidden};
  } finally {
    c.busy = false;
    if (route().page === 'coach') { render(); scrollChat(); }
  }
}
const scrollChat = () => { const ch = document.getElementById('chat'); if (ch) ch.scrollTop = ch.scrollHeight; window.scrollTo(0, document.body.scrollHeight); };

// Talk instead of type (Chrome's built-in speech recognition)
let recog = null;
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (recog) { recog.stop(); return; }
  recog = new SR(); recog.lang = navigator.language || 'en-US'; recog.interimResults = true;
  let finalText = '';
  recog.onresult = e => {
    const box = document.getElementById('coach-text');
    finalText = [...e.results].map(r => r[0].transcript).join(' ');
    if (box) box.value = finalText;
  };
  recog.onend = () => { recog = null; S.listening = false; render(); const id = route().id; if (finalText.trim()) sendCoach(id, finalText); };
  recog.onerror = e => { if (e.error === 'not-allowed') toast('Allow the microphone to talk to the coach.'); };
  S.listening = true; render(); recog.start();
}

// ---------------------------------------------------------------- frame
const TABS = [['home', 'Home'], ['ride', 'Ride'], ['history', 'History'], ['helmet', 'Helmet']];
function chrome(page) {
  const active = page === 'checkin' || page === 'impact' || page === 'coach' || (page === 'ride' && route().id) ? 'history' : page;
  const titles = {ride: 'Ride', history: 'History', helmet: 'Helmet', checkin: 'Check-in', impact: 'Impact', coach: 'Coach'};
  const phoneView = !inFrame && innerWidth >= 900 ? `${onLaptop ? '<button class="pill ghost" data-action="phone-qr">Open on phone</button>' : ''}<a class="pill ghost" href="/">Phone view</a>` : '';
  $('#top').innerHTML = `<a class="brand" href="#home"><span class="logo"></span><span>${titles[page] ? esc(titles[page]) : 'Neuro<b>Halo</b>'}</span></a>
    <nav class="top-tabs">${TABS.map(([k, l]) => `<a href="#${k}" class="${active === k ? 'on' : ''}">${l}</a>`).join('')}</nav><div class="top-right">${phoneView}${helmetPill()}</div>`;
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<a href="#${k}" class="${active === k ? 'on' : ''}">${icon(k)}<span>${l}</span></a>`).join('');
}

function render() {
  const {page, id} = route();
  chrome(page);
  const pages = {home: homePage, ride: () => id ? rideReport(id) : ridePage(), history: historyPage, helmet: helmetPage, checkin: () => checkinPage(id), impact: () => impactPage(id), coach: () => coachPage(id)};
  app.innerHTML = alertCard() + (S.finishing ? finishingPage() : S.starting ? LOADING('Getting ready', 'Collecting the last impacts from your helmet before the new ride…') : (pages[page] || homePage)());
  placeHelmet();
  const ms = document.getElementById('monitor-slot');
  if (ms) { if (!monitorEl.firstChild) monitorEl.innerHTML = monitorChart(); ms.replaceChildren(monitorEl); }
  if (page === 'home' && !S.weather && !S.weatherBusy && !S.weatherErr) loadWeather();
}

// Re-render unless the athlete is typing
function softRender() { if (S.editing) chrome(route().page); else render(); }

// ---------------------------------------------------------------- actions
async function action(name, el) {
  switch (name) {
    case 'connect':
      try { await link.connect(); store.set('nh-paired', 1); toast('Helmet connected'); }
      catch (err) { if (err.name !== 'NotFoundError') toast(err.message); }
      break;
    case 'phone-qr': window.showPhoneQR?.(); break;
    case 'next-tip': tipOffset++; render(); break;
    case 'coach-mic': toggleMic(); break;
    case 'coach-retry': { const c = S.coach; if (c?.retry) { c.error = ''; sendCoach(c.rideId, c.retry.text, c.retry.hidden); } break; }
    case 'coach-reset': { const id = route().id; store.set(coachKey(id), []); S.coach = null; render(); break; }
    case 'end-cancel': S.endAsk = false; render(); break;
    case 'disconnect': link.disconnect(); store.set('nh-paired', 0); break;
    case 'calibrate': await link.sendCommand(1); toast('Hold still… setting upright position'); break;
    case 'im-ok': await link.sendCommand(2); toast("Glad you're OK. Countdown cancelled."); break;
    case 'start-ride':
      S.busy = true;
      try {
        await prepareHelmetForRide();
        await api('/rides/start', {method: 'POST', body: '{}'}); await loadData(); toast('Ride started'); go('ride');
      }
      catch (err) { toast(err.message); } finally { S.busy = false; render(); }
      break;
    case 'end-ride': {
      if (!S.current) break;
      if (S.helmet.state !== 'connected' && store.get('nh-paired', 0) && !el.dataset.force) { S.endAsk = true; render(); break; }
      S.endAsk = false;
      S.busy = true; render();
      try { const id = S.current.ride_id; await api('/rides/' + encodeURIComponent(id) + '/end', {method: 'POST', body: '{}'}); await finishRide(id); toast('Ride saved'); S.checkin = null; go('checkin/' + encodeURIComponent(id)); }
      catch (err) { S.finishing = null; toast(err.message); } finally { S.busy = false; render(); }
      break;
    }
    case 'feel-fine': await saveCheckin(true); break;
    case 'feel-off': if (S.checkin) { S.checkin.off = true; render(); } break;
    case 'save-checkin': await saveCheckin(false); break;
    case 'save-note': {
      const id = el.dataset.id, note = $('#impact-note').value;
      try { await api('/events/' + encodeURIComponent(id) + '/annotations', {method: 'PATCH', body: JSON.stringify({user_notes: note})}); delete S.details[id]; S.editing = false; await loadData(); toast('Note saved'); render(); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'edit-city': S.editCity = true; render(); document.querySelector('[data-form=city] input')?.focus(); break;
    case 'locate':
      if (!navigator.geolocation) { toast('Location is not available here'); break; }
      navigator.geolocation.getCurrentPosition(p => { S.editing = false; setCity({name: 'My location', latitude: p.coords.latitude, longitude: p.coords.longitude}); },
        () => toast('Location permission was declined'), {timeout: 12000, maximumAge: 300000});
      break;
    case 'weather-retry': S.weatherErr = ''; loadWeather(); break;
  }
}

async function saveCheckin(fine) {
  const f = S.checkin; if (!f) return;
  const notes = $('#ck-notes')?.value ?? f.notes;
  const body = fine ? {feel_fine: true, pain_regions: [], symptoms: [], notes: ''}
    : {feel_fine: false, pain_regions: [...f.regions], symptoms: [...f.symptoms], notes};
  S.busy = true;
  try {
    await api('/rides/' + encodeURIComponent(f.rideId) + '/checkin', {method: 'POST', body: JSON.stringify(body)});
    S.editing = false; const id = f.rideId; S.checkin = null; await loadData(); toast('Check-in saved'); go('ride/' + encodeURIComponent(id));
  } catch (err) { toast(err.message); } finally { S.busy = false; }
}

document.addEventListener('click', async ev => {
  const reg = ev.target.closest('[data-region]');
  if (reg && S.checkin && reg.closest('.editable')) {
    const n = reg.dataset.region, set = S.checkin.regions;
    set.has(n) ? set.delete(n) : set.add(n);
    S.checkin.notes = $('#ck-notes')?.value ?? S.checkin.notes;
    S.editing = false; render(); return;
  }
  const sym = ev.target.closest('[data-symptom]');
  if (sym && S.checkin) {
    const n = sym.dataset.symptom, set = S.checkin.symptoms;
    set.has(n) ? set.delete(n) : set.add(n);
    S.checkin.notes = $('#ck-notes')?.value ?? S.checkin.notes;
    S.editing = false; render(); return;
  }
  const el = ev.target.closest('[data-action]');
  if (el) { ev.preventDefault(); try { await action(el.dataset.action, el); } catch (err) { toast(err.message); } }
});
document.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('path[data-region]')) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent('click', {bubbles: true})); } });
document.addEventListener('input', ev => {
  if (ev.target.matches('textarea, input')) S.editing = true;
  if (ev.target.id === 'ck-notes' && S.checkin) {
    S.checkin.notes = ev.target.value;
    const save = document.querySelector('[data-action=save-checkin]');
    if (save && !S.busy) save.disabled = !S.checkin.regions.size && !S.checkin.symptoms.size && !S.checkin.notes.trim();
  }
});
document.addEventListener('submit', async ev => {
  if (ev.target.dataset.form === 'coach') {
    ev.preventDefault();
    const text = ev.target.text.value; ev.target.text.value = '';
    sendCoach(route().id, text); return;
  }
  if (ev.target.dataset.form !== 'city') return;
  ev.preventDefault();
  try { S.editing = false; setCity(await findCity(ev.target.city.value)); } catch (err) { toast(err.message === 'City not found' ? 'City not found' : 'Could not search right now'); }
});
window.addEventListener('hashchange', () => { S.editing = false; render(); scrollTo(0, 0); });

// ---------------------------------------------------------------- start
render();
loadData().then(() => { render(); deliver(); });
if (store.get('nh-paired', 0)) link.autoConnect().then(syncHelmet);
setInterval(() => { document.querySelectorAll('[data-timer]').forEach(t => { if (S.current) t.textContent = U.timer(rideElapsed(S.current)); }); }, 1000);
setInterval(async () => { const p = route().page; if (['home', 'ride', 'history'].includes(p) && !S.editing) { await loadData(); softRender(); } }, 8000);
setInterval(deliver, 5000);
setInterval(() => { if (S.weather && Date.now() - S.weather.at > 15 * 60000) { S.weather = null; if (route().page === 'home') loadWeather(); } }, 60000);
