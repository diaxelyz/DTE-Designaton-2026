#!/usr/bin/env python3
"""NeuroHalo trusted-LAN prototype server. Python 3.10+, no dependencies."""
import argparse
import shutil
import subprocess
import json
import math
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent
MAX_BYTES = 5 * 1024 * 1024
SAFE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,149}\Z')
REGIONS = ['Unknown', 'Front', 'Back', 'Left', 'Right', 'Crown', 'Face']
CLASSES = ['Candidate impact', 'Collision', 'Handling / drop', 'Unknown']
ANNOTATIONS = {'head_region', 'user_classification', 'user_notes', 'location'}
LOCK = threading.RLock()


def number(v, name, low=None, high=None, nullable=False):
    if v is None and nullable:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f'{name} must be a finite number')
    if low is not None and v < low or high is not None and v > high:
        raise ValueError(f'{name} is outside its supported range')
    return v


def text(v, name, limit=200):
    if not isinstance(v, str) or len(v) > limit:
        raise ValueError(f'{name} must be text of at most {limit} characters')
    return v


def timestamp(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('incident_time_utc must be a timezone-qualified ISO timestamp or null')
    try:
        t = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if t.tzinfo is None:
            raise ValueError()
        return t.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    except ValueError:
        raise ValueError('incident_time_utc must include a valid date and timezone')


def validate_annotations(data):
    if not isinstance(data, dict) or set(data) - ANNOTATIONS:
        raise ValueError('Only location, head_region, user_classification, and user_notes may be edited')
    if 'head_region' in data and data['head_region'] not in REGIONS:
        raise ValueError('Unknown head region')
    if 'user_classification' in data and data['user_classification'] not in CLASSES:
        raise ValueError('Unknown event classification')
    if 'user_notes' in data:
        text(data['user_notes'], 'user_notes', 5000)
    if 'location' in data:
        loc = data['location']
        if not isinstance(loc, dict) or set(loc) - {'label', 'latitude', 'longitude', 'source'}:
            raise ValueError('Invalid location object')
        text(loc.get('label', ''), 'location label')
        text(loc.get('source', ''), 'location source', 100)
        lat, lon = loc.get('latitude'), loc.get('longitude')
        if (lat is None) != (lon is None):
            raise ValueError('Latitude and longitude must both be supplied or both be null')
        number(lat, 'latitude', -90, 90, True)
        number(lon, 'longitude', -180, 180, True)
    return data


def validate(raw):
    if not isinstance(raw, dict):
        raise ValueError('Event must be a JSON object')
    # Reject NaN/Infinity even in unrecognized metadata.
    json.dumps(raw, allow_nan=False)
    raw = dict(raw)
    if 'events' in raw:
        if raw.get('schema_version') != 1 or not isinstance(raw['events'], list) or len(raw['events']) != 1:
            raise ValueError('Upload exactly one event in a schema_version 1 envelope')
        raw = dict(raw['events'][0]) if isinstance(raw['events'][0], dict) else {}
        raw.setdefault('schema_version', 1)
    if type(raw.get('schema_version')) is not int or raw['schema_version'] != 1:
        raise ValueError('schema_version must be 1')
    if not isinstance(raw.get('event_id'), str) or not SAFE_ID.fullmatch(raw['event_id']):
        raise ValueError('event_id must contain only letters, numbers, underscores and hyphens; max 150 characters')
    for k in ['device_id', 'boot_session_id']:
        if not text(raw.get(k), k, 150):
            raise ValueError(f'{k} is required')
    if raw.get('source') not in ['device', 'simulated', 'manual']:
        raise ValueError('source must be device, simulated, or manual')
    raw['incident_time_utc'] = timestamp(raw.get('incident_time_utc'))
    for k in ['sensor_model', 'firmware_version', 'filter_configuration', 'time_source', 'timing_quality']:
        text(raw.get(k, ''), k, 200)
    ar = number(raw.get('accel_range_g'), 'accel_range_g', .1, 10000)
    gr = number(raw.get('gyro_range_dps'), 'gyro_range_dps', .1, 100000)
    for k in ['sample_rate_hz', 'event_duration_ms', 'threshold_g', 'device_event_time_us']:
        number(raw.get(k), k, 0, 1e16, True)
    dropped = number(raw.get('dropped_sample_count'), 'dropped_sample_count', 0, 1e9, True)
    if dropped is not None and int(dropped) != dropped:
        raise ValueError('dropped_sample_count must be an integer')
    samples = raw.get('samples')
    if not isinstance(samples, list) or len(samples) > 20000:
        raise ValueError('samples must be an array with at most 20,000 rows')
    if raw['source'] != 'manual' and not samples:
        raise ValueError('Device and simulated events require samples')
    clips = {}
    for key in ['accel_clipped_axes', 'gyro_clipped_axes']:
        axes = raw.get(key, [])
        if not isinstance(axes, list) or any(a not in ['x', 'y', 'z'] for a in axes):
            raise ValueError(f'Invalid {key}')
        clips[key] = set(axes)
    prev, peak = -math.inf, None
    for s in samples:
        if not isinstance(s, dict):
            raise ValueError('Every sample must be an object')
        t = number(s.get('t_us'), 't_us', -1e12, 1e12)
        if t <= prev:
            raise ValueError('Sample times must be strictly increasing')
        prev = t
        for axis in 'xyz':
            a = number(s.get('a' + axis + '_g'), 'acceleration', -ar * 1.01, ar * 1.01)
            g = number(s.get('g' + axis + '_dps'), 'angular velocity', -gr * 1.01, gr * 1.01, True)
            if abs(a) >= ar * .995:
                clips['accel_clipped_axes'].add(axis)
            if g is not None and abs(g) >= gr * .995:
                clips['gyro_clipped_axes'].add(axis)
        p = math.hypot(s['ax_g'], s['ay_g'], s['az_g'])
        peak = max(peak or 0, p)
    raw['recorded_peak_resultant_g'] = peak if samples else number(raw.get('recorded_peak_resultant_g'), 'recorded_peak_resultant_g', 0, ar * math.sqrt(3) * 1.01, True)
    for k, axes in clips.items():
        raw[k] = sorted(axes)
    defaults = {'head_region': 'Unknown', 'user_classification': 'Candidate impact', 'user_notes': '', 'location': {'label': '', 'latitude': None, 'longitude': None, 'source': 'Not recorded'}}
    for k, v in defaults.items():
        raw.setdefault(k, v)
    validate_annotations({k: raw[k] for k in ANNOTATIONS})
    raw.pop('key', None)
    raw.pop('_full', None)
    return raw


def atomic_write(path, obj):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('w', encoding='utf-8') as f:
            json.dump(obj, f, allow_nan=False, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        if os.name != 'nt':
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


class Store:
    def __init__(self, folder):
        self.folder = Path(folder).resolve()
        self.folder.mkdir(parents=True, exist_ok=True)
        self.annotations = self.folder.parent / (self.folder.name + '-annotations')
        self.annotations.mkdir(parents=True, exist_ok=True)

    def path(self, event_id):
        if not SAFE_ID.fullmatch(event_id):
            raise ValueError('Invalid event ID')
        return self.folder / (event_id + '.json')

    def read(self, event_id):
        path = self.path(event_id)
        if path.is_symlink():
            raise ValueError('Symlink event files are not supported')
        if path.stat().st_size > MAX_BYTES:
            raise ValueError('Stored file exceeds size limit')
        event = validate(json.loads(path.read_text(encoding='utf-8')))
        if event['event_id'] != event_id:
            raise ValueError('Stored filename must match event_id')
        annotations = self.annotations / (event_id + '.json')
        if annotations.is_file():
            if annotations.is_symlink() or annotations.stat().st_size > 32768:
                raise ValueError('Invalid annotation file')
            event.update(validate_annotations(json.loads(annotations.read_text(encoding='utf-8'))))
        return event

    def list(self):
        events, invalid = [], 0
        for path in self.folder.glob('*.json'):
            try:
                events.append(self.read(path.stem))
            except (ValueError, OSError, TypeError, KeyError):
                invalid += 1
        events.sort(key=lambda e: datetime.fromisoformat(e['incident_time_utc'].replace('Z', '+00:00')).timestamp() if e['incident_time_utc'] else -math.inf, reverse=True)
        return events, invalid

    def upload(self, raw):
        event = validate(raw)
        path = self.path(event['event_id'])
        with LOCK:
            if path.is_symlink():
                raise ValueError('Symlink event files are not supported')
            if path.exists():
                # Compare immutable payload. Retries never overwrite annotations.
                original = validate(json.loads(path.read_text(encoding='utf-8')))
                immutable = lambda e: {k: v for k, v in e.items() if k not in ANNOTATIONS}
                if immutable(original) != immutable(event):
                    return 409, {'error': 'Event ID already exists with different sensor data; use a globally unique ID'}
                return 200, {'event_id': event['event_id'], 'persisted': True, 'duplicate': True}
            atomic_write(path, event)
        return 201, {'event_id': event['event_id'], 'persisted': True, 'duplicate': False}


def parse_utc(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')) if value else None


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


class RideStore:
    """Rides are time windows. An event belongs to a ride if its incident time is inside it.
    Raw event files are never changed."""

    def __init__(self, folder):
        self.folder = Path(folder).resolve()
        self.folder.mkdir(parents=True, exist_ok=True)

    def path(self, ride_id):
        if not SAFE_ID.fullmatch(ride_id):
            raise ValueError('Invalid ride ID')
        return self.folder / (ride_id + '.json')

    def read(self, ride_id):
        ride = json.loads(self.path(ride_id).read_text(encoding='utf-8'))
        parse_utc(ride['started_utc'])
        parse_utc(ride.get('ended_utc'))
        return ride

    def all(self):
        rides = []
        for path in self.folder.glob('*.json'):
            try:
                rides.append(self.read(path.stem))
            except (ValueError, OSError, KeyError, TypeError):
                pass
        rides.sort(key=lambda r: r['started_utc'], reverse=True)
        return rides

    def current(self):
        return next((r for r in self.all() if not r.get('ended_utc')), None)

    def start(self):
        ride = self.current()
        if ride:
            return 200, ride
        now = datetime.now(timezone.utc)
        ride = {'ride_id': f"ride-{now:%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}",
                'started_utc': utc_now_iso(), 'ended_utc': None}
        atomic_write(self.path(ride['ride_id']), ride)
        return 201, ride

    def end(self, ride_id):
        ride = self.read(ride_id)
        if not ride.get('ended_utc'):
            ride['ended_utc'] = utc_now_iso()
            atomic_write(self.path(ride_id), ride)
        return ride

    def checkin(self, ride_id, data):
        ride = self.read(ride_id)
        ride['checkin'] = validate_checkin(data)
        atomic_write(self.path(ride_id), ride)
        return ride

    @staticmethod
    def contains(ride, event):
        t = parse_utc(event.get('incident_time_utc'))
        if t is None:
            return False
        end = parse_utc(ride.get('ended_utc')) or datetime.now(timezone.utc)
        return parse_utc(ride['started_utc']) <= t <= end

    def ride_for(self, event, rides):
        return next((r['ride_id'] for r in rides if self.contains(r, event)), None)

    def summary(self, ride, events):
        inside = [e for e in events if self.contains(ride, e)]
        start = parse_utc(ride['started_utc'])
        end = parse_utc(ride.get('ended_utc')) or datetime.now(timezone.utc)
        peaks = [e['recorded_peak_resultant_g'] for e in inside if e.get('recorded_peak_resultant_g') is not None]
        return {**ride,
                'active': not ride.get('ended_utc'),
                'duration_s': max(0, int((end - start).total_seconds())),
                'event_count': len(inside),
                'high_count': sum(1 for e in inside if e.get('reporting_priority') == 'high'),
                'medium_count': sum(1 for e in inside if e.get('reporting_priority') == 'medium'),
                'crash_suspected_count': sum(1 for e in inside if e.get('crash_suspected') is True),
                'clipped_count': sum(1 for e in inside if e.get('accel_clipped_axes')),
                'peak_g': max(peaks) if peaks else None,
                'event_ids': [e['event_id'] for e in inside]}


CHECKIN_REGIONS = ['Front', 'Back', 'Left', 'Right', 'Top', 'Face', 'Neck']
CHECKIN_SYMPTOMS = ['Headache', 'Dizziness', 'Nausea', 'Blurry vision', 'Feeling foggy',
                    'Ringing ears', 'Trouble balancing', 'Sensitive to light']


def validate_checkin(data):
    """Post-ride self-report. Not a diagnosis."""
    if not isinstance(data, dict) or set(data) - {'feel_fine', 'pain_regions', 'symptoms', 'notes'}:
        raise ValueError('Check-in may only contain feel_fine, pain_regions, symptoms and notes')
    regions, symptoms = data.get('pain_regions', []), data.get('symptoms', [])
    if not isinstance(regions, list) or any(r not in CHECKIN_REGIONS for r in regions):
        raise ValueError('Unknown pain region')
    if not isinstance(symptoms, list) or any(x not in CHECKIN_SYMPTOMS for x in symptoms):
        raise ValueError('Unknown symptom')
    if not isinstance(data.get('feel_fine', False), bool):
        raise ValueError('feel_fine must be true or false')
    return {'feel_fine': data.get('feel_fine', False) and not regions and not symptoms,
            'pain_regions': sorted(set(regions), key=CHECKIN_REGIONS.index),
            'symptoms': sorted(set(symptoms), key=CHECKIN_SYMPTOMS.index),
            'notes': text(data.get('notes', ''), 'notes', 2000),
            'submitted_utc': utc_now_iso()}


# Latest helmet status, reported by ble_bridge.py (kept in memory only)
HELMET = {'data': None, 'received': 0.0}
HELMET_FIELDS = {'connected': bool, 'battery_pct': (int, float), 'battery_mv': (int, float),
                 'crash_state': (int, float), 'tilt_deg': (int, float), 'calibrated': bool,
                 'pending': (int, float), 'imu_errors': (int, float), 'device_name': str}
CRASH_STATES = {0: 'normal', 1: 'checking', 2: 'countdown', 3: 'alert', 4: 'cancelled'}


def validate_helmet_status(data):
    if not isinstance(data, dict) or data.get('bridge') is not True:
        raise ValueError('Status must come from the NeuroHalo bridge')
    clean = {}
    for key, kind in HELMET_FIELDS.items():
        if key in data and data[key] is not None:
            v = data[key]
            if kind is not bool and isinstance(v, bool) or not isinstance(v, kind):
                raise ValueError(f'Invalid helmet status field: {key}')
            if isinstance(v, float) and not math.isfinite(v):
                raise ValueError(f'Invalid helmet status field: {key}')
            clean[key] = text(v, key, 80) if kind is str else v
    return clean


def helmet_status():
    data, age = HELMET['data'], time.time() - HELMET['received']
    if data is None or age > 10:
        return {'state': 'bridge_offline', 'age_s': None if data is None else round(age, 1)}
    out = {**data, 'age_s': round(age, 1)}
    out['state'] = 'connected' if data.get('connected') else 'helmet_disconnected'
    out['crash_state_name'] = CRASH_STATES.get(int(data.get('crash_state', 0)), 'normal')
    return out


STATIC_FILES = {'/', '/index.html', '/app.js', '/style.css', '/device.html',
                '/helmet-ble.js', '/helmet3d.js', '/ui.js', '/three.module.min.js', '/qrcode.js', '/phone.js'}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def __init__(self, *args, store, rides, **kwargs):
        self.store = store
        self.rides = rides
        super().__init__(*args, directory=str(ROOT / 'dist'), **kwargs)

    def log_message(self, fmt, *args):
        # Avoid logging annotation bodies or credentials.
        super().log_message(fmt, *args)

    def end_headers(self):
        if not self.path.startswith('/api'):
            # always check for a newer app version, so an update shows up on a normal reload
            self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        super().end_headers()

    def reply(self, status, obj):
        data = json.dumps(obj, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        origin = self.headers.get('Origin')
        same = origin and urlsplit(origin).netloc == self.headers.get('Host')
        via_phone_link = origin and TUNNEL['url'] and origin.rstrip('/') == TUNNEL['url']   # the tunnel may rewrite Host
        if origin and not (same or via_phone_link):
            raise PermissionError('Cross-origin writes are not allowed')
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('Send a Content-Length; chunked uploads are not supported')
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Send Content-Type: application/json')
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > MAX_BYTES:
            raise OverflowError('JSON body must be between 1 byte and 5 MiB')
        self.connection.settimeout(10)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError('Incomplete request body')
        return json.loads(raw)

    def api(self, method):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        if method == 'POST' and path == '/api/coach':
            return self.coach()
        try:
            with LOCK:
                if method == 'GET' and path == '/api/health':
                    events, invalid = self.store.list()
                    return self.reply(200, {'service': 'neurohalo', 'status': 'ok', 'event_count': len(events), 'invalid_file_count': invalid, 'data_folder': str(self.store.folder), 'server_time_utc': datetime.now(timezone.utc).isoformat()})
                if method == 'GET' and path == '/api/events':
                    events, invalid = self.store.list()
                    q = parse_qs(parts.query)
                    for key in ['from', 'to']:
                        if key in q and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', q[key][0]):
                            raise ValueError('Date filters must use YYYY-MM-DD (UTC)')
                    def matches(e):
                        date = (e['incident_time_utc'] or '')[:10]
                        return ('from' not in q or date and date >= q['from'][0]) and ('to' not in q or date and date <= q['to'][0]) and ('classification' not in q or e['user_classification'] == q['classification'][0])
                    rides = self.rides.all()
                    summaries = [{**{k: v for k, v in e.items() if k != 'samples'}, 'sample_count': len(e['samples']), 'ride_id': self.rides.ride_for(e, rides)} for e in events if matches(e)]
                    return self.reply(200, {'schema_version': 1, 'events': summaries, 'invalid_file_count': invalid})
                if method == 'POST' and path == '/api/events':
                    code, response = self.store.upload(self.body())
                    return self.reply(code, response)
                if method == 'GET' and path == '/api/phone-link':
                    return self.reply(200, {'status': TUNNEL['status'], 'url': TUNNEL['url']})
                if method == 'GET' and path == '/api/helmet/status':
                    return self.reply(200, helmet_status())
                if method == 'POST' and path == '/api/helmet/status':
                    HELMET['data'] = validate_helmet_status(self.body())
                    HELMET['received'] = time.time()
                    return self.reply(200, {'ok': True})
                if path == '/api/rides' and method == 'GET':
                    events, _ = self.store.list()
                    return self.reply(200, {'rides': [self.rides.summary(r, events) for r in self.rides.all()]})
                if path == '/api/rides/current' and method == 'GET':
                    ride = self.rides.current()
                    events, _ = self.store.list()
                    return self.reply(200, {'ride': self.rides.summary(ride, events) if ride else None})
                if path == '/api/rides/start' and method == 'POST':
                    code, ride = self.rides.start()
                    events, _ = self.store.list()
                    return self.reply(code, {'ride': self.rides.summary(ride, events)})
                ride_match = re.fullmatch(r'/api/rides/([^/]+)(/end|/checkin)?', path)
                if ride_match:
                    ride_id, end = ride_match.groups()
                    if method == 'POST' and end == '/end':
                        ride = self.rides.end(ride_id)
                    elif method == 'POST' and end == '/checkin':
                        ride = self.rides.checkin(ride_id, self.body())
                    elif method == 'GET' and not end:
                        ride = self.rides.read(ride_id)
                    else:
                        return self.reply(404, {'error': 'API route not found'})
                    events, _ = self.store.list()
                    summary = self.rides.summary(ride, events)
                    summary['events'] = [{**{k: v for k, v in e.items() if k != 'samples'}, 'sample_count': len(e['samples'])} for e in events if e['event_id'] in summary['event_ids']]
                    return self.reply(200, {'ride': summary})
                match = re.fullmatch(r'/api/events/([^/]+)(/annotations)?', path)
                if match:
                    event_id, annotation = match.groups()
                    if method == 'GET' and not annotation:
                        return self.reply(200, self.store.read(event_id))
                    if method == 'PATCH' and annotation:
                        event = self.store.read(event_id)
                        patch = validate_annotations(self.body())
                        event.update(patch)
                        atomic_write(self.store.annotations / (event_id + '.json'), {k: event[k] for k in ANNOTATIONS})
                        return self.reply(200, event)
                self.reply(404, {'error': 'API route not found'})
        except FileNotFoundError:
            self.reply(404, {'error': 'Event not found'})
        except PermissionError as e:
            self.reply(403, {'error': str(e)})
        except OverflowError as e:
            self.reply(413, {'error': str(e)})
        except (ValueError, TypeError, KeyError, UnicodeError) as e:
            self.reply(400, {'error': str(e)})
        except OSError:
            self.reply(500, {'error': 'Storage operation failed; event not acknowledged'})

    def coach(self):
        try:
            data = self.body()
            messages = validate_chat(data)
            ride_id = data.get('ride_id')
            if not isinstance(ride_id, str):
                raise ValueError('ride_id is required')
            with LOCK:   # read the ride data quickly, then talk to the AI without holding the lock
                ride = self.rides.read(ride_id)
                events, _ = self.store.list()
                inside = [e for e in events if self.rides.contains(ride, e)]
                week = datetime.now(timezone.utc).timestamp() - 7 * 86400
                hist = {'rides': 0, 'hard': 0, 'moderate': 0}
                for r in self.rides.all():
                    if r['ride_id'] == ride_id or parse_utc(r['started_utc']).timestamp() < week:
                        continue
                    hist['rides'] += 1
                    for e in events:
                        if self.rides.contains(r, e):
                            hist['hard' if e.get('reporting_priority') == 'high' else 'moderate'] += 1
                context = coach_context(ride, inside, hist)
            reply = ask_coach(context, messages)
            return self.reply(200, {'reply': reply})
        except FileNotFoundError:
            return self.reply(404, {'error': 'Ride not found'})
        except PermissionError as e:
            return self.reply(503, {'error': str(e)})
        except ConnectionError as e:
            return self.reply(502, {'error': str(e)})
        except (ValueError, TypeError, KeyError, UnicodeError, OverflowError) as e:
            return self.reply(400, {'error': str(e)})

    def do_GET(self):
        if urlsplit(self.path).path.startswith('/api/'):
            return self.api('GET')
        # Serve only explicit frontend assets; never expose the event folder.
        allowed = STATIC_FILES
        if urlsplit(self.path).path not in allowed:
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path not in STATIC_FILES:
            return self.send_error(404)
        return super().do_HEAD()

    def do_POST(self):
        self.api('POST')

    def do_PATCH(self):
        self.api('PATCH')


# ---------------------------------------------------------------- AI coach (talk about a ride)
# The key is read from the ANTHROPIC_API_KEY environment variable, or from anthropic_key.txt
# next to this file. It stays on this laptop: the website never sees it.
COACH_MODEL = os.environ.get('NEUROHALO_MODEL', 'claude-haiku-4-5')
API_URL = os.environ.get('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').rstrip('/') + '/v1/messages'
KEY_FILE = ROOT / 'anthropic_key.txt'


def api_key():
    key = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not key and KEY_FILE.is_file():
        key = KEY_FILE.read_text(encoding='utf-8').strip()
    return key


COACH_RULES = """You are the NeuroHalo ride coach, talking with a cyclist after a ride. NeuroHalo is a helmet
sensor that records impacts (jolts to the helmet). You can see the ride data and the rider's
post-ride check-in below.

How to talk:
- Warm, calm, plain words, short replies (2-5 sentences). One question at a time.
- Help them reflect: what happened, how they feel now, whether symptoms are changing.
- Explain the data simply: "moderate" and "hard" describe how strong the jolt to the HELMET was.
  It is measured at the helmet, not inside the head, so it cannot tell whether they are injured.
- You may suggest common-sense steps: rest, avoid riding or screens if symptoms appear, tell a
  coach/parent/trainer, have someone check on them, and follow up with a doctor or athletic trainer.

Safety rules (never break these):
- You are not a doctor. Never diagnose, and never say they do or don't have a concussion or that
  they are "fine" or "cleared" to ride or play.
- If they mention ANY red flag, stop the casual chat and tell them clearly to get medical help now
  (call emergency services or go to an emergency room, and don't be alone): a headache that gets
  worse or won't go away, repeated vomiting, confusion or not recognising people/places, slurred
  speech, weakness or numbness, trouble walking, a seizure, passing out, one pupil larger than the
  other, unusual drowsiness or being hard to wake.
- If they had a hard impact, a suspected crash, or any symptoms, recommend they get checked by a
  doctor or athletic trainer before riding again, and not to ride today.
- Don't invent data. If something isn't in the ride data, say you don't know.
- Stay on topic: the ride, impacts, how they feel, and safety."""


def coach_context(ride, ride_events, history):
    def when(iso):
        t = parse_utc(iso)
        return t.astimezone().strftime('%I:%M %p').lstrip('0') if t else 'unknown time'
    start, end = parse_utc(ride['started_utc']), parse_utc(ride.get('ended_utc'))
    mins = round(((end or datetime.now(timezone.utc)) - start).total_seconds() / 60, 1)
    lines = [f"Ride: started {start.astimezone():%A %B %d, %I:%M %p}, {mins} minutes, {'finished' if end else 'still going'}."]
    if ride_events:
        lines.append(f'Impacts saved on this ride ({len(ride_events)}):')
        for e in sorted(ride_events, key=lambda e: e.get('incident_time_utc') or ''):
            level = 'HARD' if e.get('reporting_priority') == 'high' else 'moderate'
            g = e.get('recorded_peak_resultant_g')
            extra = []
            if e.get('accel_clipped_axes'): extra.append('stronger than the sensor can measure')
            if e.get('crash_suspected'): extra.append('afterwards the rider was down and still (possible crash)')
            lines.append(f"- {when(e.get('incident_time_utc'))}: {level} impact, peak {g:.1f} times gravity at the helmet" if g is not None else f"- {when(e.get('incident_time_utc'))}: {level} impact")
            if extra: lines[-1] += ' (' + '; '.join(extra) + ')'
    else:
        lines.append('No moderate or hard impacts were saved on this ride.')
    ck = ride.get('checkin')
    if ck:
        lines.append('Post-ride check-in: ' + ('felt fine.' if ck.get('feel_fine') else
            f"pain at {', '.join(ck.get('pain_regions') or []) or 'no specific spot'}; symptoms: {', '.join(ck.get('symptoms') or []) or 'none ticked'}.")
            + (f" Notes: {ck['notes']}" if ck.get('notes') else ''))
    else:
        lines.append('The rider has not done the post-ride check-in yet.')
    lines.append(f"Earlier rides in the last 7 days: {history['rides']} rides, {history['hard']} hard and {history['moderate']} moderate impacts.")
    return '\n'.join(lines)


def validate_chat(data):
    if not isinstance(data, dict) or not isinstance(data.get('messages'), list):
        raise ValueError('messages must be a list')
    msgs = data['messages'][-30:]
    clean = []
    for m in msgs:
        if not isinstance(m, dict) or m.get('role') not in ('user', 'assistant') or not isinstance(m.get('content'), str):
            raise ValueError('Each message needs a role (user/assistant) and text content')
        text = m['content'].strip()[:2000]
        if text:
            clean.append({'role': m['role'], 'content': text})
    # the conversation must start with the rider and alternate
    while clean and clean[0]['role'] != 'user':
        clean.pop(0)
    merged = []
    for m in clean:
        if merged and merged[-1]['role'] == m['role']:
            merged[-1]['content'] += '\n' + m['content']
        else:
            merged.append(m)
    if not merged or merged[-1]['role'] != 'user':
        raise ValueError('The last message must be from the rider')
    return merged


def ask_coach(context, messages):
    key = api_key()
    if not key:
        raise PermissionError('The AI coach needs an Anthropic API key. Put it in anthropic_key.txt next to server.py, then restart the server.')
    body = json.dumps({'model': COACH_MODEL, 'max_tokens': 600,
                       'system': COACH_RULES + '\n\n--- Ride data ---\n' + context,
                       'messages': messages}).encode()
    req = urllib.request.Request(API_URL, data=body, method='POST', headers={
        'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode('utf-8')).get('error', {}).get('message', '')
        except Exception:
            detail = ''
        if e.code == 401:
            raise PermissionError('The API key was not accepted. Make a new key under API Keys on platform.claude.com (it starts with sk-ant-api) and put it in anthropic_key.txt.')
        if e.code in (402, 403) or 'credit' in detail.lower():
            raise PermissionError('The API account has no credit left or no access. Check Billing on platform.claude.com.')
        raise ConnectionError(f'The AI service said: {detail or e.reason}')
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ConnectionError("Couldn't reach the AI service. Check the laptop's internet connection.")
    text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text').strip()
    return text or "Sorry, I didn't get that. Could you say it another way?"


# ---------------------------------------------------------------- phone link (free https tunnel)
# If cloudflared(.exe) is next to this file or installed, the server starts a free Cloudflare
# "quick tunnel" so a phone can open the app over https (needed for Bluetooth on phones).
# The link changes every time; the app shows it as a QR code ("Open on phone").
TUNNEL = {'status': 'off', 'url': None, 'proc': None}


def find_cloudflared():
    for name in ('cloudflared.exe', 'cloudflared'):
        local = ROOT / name
        if local.is_file():
            return str(local)
    return shutil.which('cloudflared')


def start_tunnel(port):
    exe = find_cloudflared()
    if not exe:
        TUNNEL['status'] = 'missing'
        return
    TUNNEL['status'] = 'starting'
    try:
        proc = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', '--url', f'http://localhost:{port}'],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except OSError:
        TUNNEL['status'] = 'error'
        return
    TUNNEL['proc'] = proc

    def watch():
        for line in proc.stdout:
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if m and not TUNNEL['url']:
                TUNNEL['url'], TUNNEL['status'] = m.group(0), 'ready'
                print(f'Phone link: {TUNNEL["url"]}  (or click "Open on phone" in the app for a QR code)', flush=True)
        TUNNEL['status'], TUNNEL['url'] = 'stopped', None
    threading.Thread(target=watch, daemon=True).start()


def stop_tunnel():
    if TUNNEL['proc'] and TUNNEL['proc'].poll() is None:
        TUNNEL['proc'].terminate()


def make_server(host, port, data_dir):
    store = Store(data_dir)
    rides = RideStore(store.folder.parent / (store.folder.name + '-rides'))
    return ThreadingHTTPServer((host, port), partial(Handler, store=store, rides=rides))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data' / 'events')
    parser.add_argument('--no-phone', action='store_true', help="don't start the phone link (Cloudflare tunnel)")
    args = parser.parse_args()
    server = make_server(args.host, args.port, args.data_dir)
    if not args.no_phone:
        start_tunnel(args.port)
    phone = {'starting': 'Phone link: starting… (shows here in a few seconds, and as a QR code in the app)',
             'missing': 'Phone link: off. Put cloudflared.exe in this folder to get one (see README).',
             'error': 'Phone link: cloudflared could not start.'}.get(TUNNEL['status'], 'Phone link: off (--no-phone)')
    print(f'NeuroHalo: http://localhost:{args.port}\n{phone}\nFiles: {args.data_dir.resolve()}\nNo login: only share the phone link with people you trust.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping NeuroHalo.')
    finally:
        stop_tunnel()
        server.server_close()
