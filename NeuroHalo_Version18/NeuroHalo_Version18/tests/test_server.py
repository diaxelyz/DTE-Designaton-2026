import http.client
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('server', ROOT / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def fixture():
    return json.loads((ROOT / 'examples' / 'simulated-event.json').read_text())


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name) / 'events'
        self.http = server.make_server('127.0.0.1', 0, self.folder)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.http.server_port)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method='GET', body=None, headers=None):
        payload = json.dumps(body).encode() if body is not None else None
        req = Request(self.base + path, data=payload, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            r = urlopen(req, timeout=5)
        except HTTPError as e:
            r = e
        with r:
            data = r.read()
            return r.status, json.loads(data) if 'application/json' in r.headers.get('Content-Type', '') else data

    def post(self, data=None):
        return self.request('/api/events', 'POST', data if data is not None else fixture())

    def test_empty_health_and_list(self):
        code, health = self.request('/api/health')
        self.assertEqual((code, health['event_count'], health['service']), (200, 0, 'neurohalo'))
        self.assertEqual(self.request('/api/events')[1]['events'], [])

    def test_upload_read_restart_and_duplicate(self):
        self.assertEqual(self.post()[0], 201)
        code, ack = self.post()
        self.assertEqual((code, ack['persisted'], ack['duplicate']), (200, True, True))
        self.assertEqual(len(list(self.folder.glob('*.json'))), 1)
        event = server.Store(self.folder).read('fixture-001')
        self.assertEqual(event['source'], 'simulated')
        self.assertEqual(event['samples'], fixture()['events'][0]['samples'])
        self.assertEqual(self.request('/api/events/fixture-001')[0], 200)
        summary = self.request('/api/events')[1]['events'][0]
        self.assertNotIn('samples', summary)
        self.assertEqual(summary['sample_count'], len(event['samples']))

    def test_annotations_preserve_sensor_file_and_survive_retries(self):
        self.post()
        before = (self.folder / 'fixture-001.json').read_bytes()
        code, record = self.request('/api/events/fixture-001/annotations', 'PATCH', {'user_notes': 'Remember this turn', 'head_region': 'Left'})
        self.assertEqual((code, record['head_region']), (200, 'Left'))
        self.assertEqual(before, (self.folder / 'fixture-001.json').read_bytes())
        self.post()
        self.assertEqual(server.Store(self.folder).read('fixture-001')['user_notes'], 'Remember this turn')
        self.assertEqual(self.request('/api/events/fixture-001/annotations', 'PATCH', {'samples': []})[0], 400)

    def test_id_conflict_does_not_overwrite(self):
        self.post()
        data = fixture()
        data['events'][0]['samples'][0]['ax_g'] = 1.2
        self.assertEqual(self.post(data)[0], 409)
        self.assertNotEqual(server.Store(self.folder).read('fixture-001')['samples'][0]['ax_g'], 1.2)

    def test_bad_order_nan_schema_and_path(self):
        edits = [lambda e: e.update(event_id='../outside'), lambda e: e.update(schema_version=9), lambda e: e['samples'][1].update(t_us=e['samples'][0]['t_us']), lambda e: e['samples'][0].update(ax_g=float('nan')), lambda e: e['samples'][0].update(ax_g=17), lambda e: e.update(incident_time_utc='2026-10-03T12:00:00')]
        for edit in edits:
            data = fixture()
            edit(data['events'][0])
            self.assertEqual(self.post(data)[0], 400)
        self.assertEqual(self.request('/api/events')[1]['events'], [])

    def test_clipping_unknown_timestamp_and_filter(self):
        data = fixture()
        e = data['events'][0]
        e['incident_time_utc'] = None
        e['samples'][0]['ax_g'] = 16
        self.assertEqual(self.post(data)[0], 201)
        record = self.request('/api/events/fixture-001')[1]
        self.assertEqual(record['accel_clipped_axes'], ['x'])
        self.assertIsNone(record['incident_time_utc'])
        self.assertEqual(self.request('/api/events?from=2026-01-01')[1]['events'], [])
        self.assertEqual(len(self.request('/api/events?classification=Candidate%20impact')[1]['events']), 1)

    def test_invalid_and_partial_files_are_skipped(self):
        self.folder.joinpath('unfinished.tmp').write_text('{')
        self.folder.joinpath('broken.json').write_text('{')
        self.post()
        health = self.request('/api/health')[1]
        self.assertEqual((health['event_count'], health['invalid_file_count']), (1, 1))

    def test_wrong_content_origin_size_and_static_isolation(self):
        self.assertEqual(self.request('/api/events', 'POST', fixture(), {'Content-Type': 'text/plain'})[0], 400)
        self.assertEqual(self.request('/api/events', 'POST', fixture(), {'Origin': 'https://unrelated.example'})[0], 403)
        client = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=5)
        client.putrequest('POST', '/api/events')
        client.putheader('Content-Type', 'application/json')
        client.putheader('Content-Length', str(server.MAX_BYTES + 1))
        client.endheaders()
        response = client.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        client.close()
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/server.py')[0], 404)
        self.assertEqual(self.request('/data/events/fixture-001.json')[0], 404)
        self.assertEqual(self.request('/api/events/no-such-id')[0], 404)


    def test_rides_and_helmet_status(self):
        status, body = self.request('/api/helmet/status')
        self.assertEqual(status, 200)
        self.assertEqual(body['state'], 'bridge_offline')
        status, _ = self.request('/api/helmet/status', 'POST', {'bridge': True, 'connected': True, 'battery_pct': 80, 'crash_state': 2})
        self.assertEqual(status, 200)
        status, body = self.request('/api/helmet/status')
        self.assertEqual((body['state'], body['crash_state_name'], body['battery_pct']), ('connected', 'countdown', 80))
        status, _ = self.request('/api/helmet/status', 'POST', {'connected': True})
        self.assertEqual(status, 400)

        status, body = self.request('/api/rides/current')
        self.assertIsNone(body['ride'])
        status, body = self.request('/api/rides/start', 'POST', {})
        self.assertEqual(status, 201)
        ride = body['ride']
        self.assertTrue(ride['active'])
        status, again = self.request('/api/rides/start', 'POST', {})
        self.assertEqual((status, again['ride']['ride_id']), (200, ride['ride_id']))

        event = fixture()['events'][0]
        event['event_id'] = 'ride-test-001'
        event['incident_time_utc'] = server.utc_now_iso()
        event['reporting_priority'] = 'high'
        event['crash_suspected'] = True
        self.assertEqual(self.request('/api/events', 'POST', event)[0], 201)
        status, body = self.request('/api/events')
        listed = {e['event_id']: e for e in body['events']}
        self.assertEqual(listed['ride-test-001']['ride_id'], ride['ride_id'])
        self.assertEqual(listed['ride-test-001']['reporting_priority'], 'high')

        status, body = self.request('/api/rides/' + ride['ride_id'] + '/end', 'POST', {})
        self.assertEqual(status, 200)
        summary = body['ride']
        self.assertFalse(summary['active'])
        self.assertEqual((summary['event_count'], summary['high_count'], summary['crash_suspected_count']), (1, 1, 1))
        self.assertEqual([e['event_id'] for e in summary['events']], ['ride-test-001'])
        self.assertEqual(self.request('/api/rides/../x/end', 'POST', {})[0], 404)

        # post-ride check-in
        status, body = self.request('/api/rides/' + ride['ride_id'] + '/checkin', 'POST',
                                    {'pain_regions': ['Back', 'Neck'], 'symptoms': ['Headache'], 'notes': 'Sore'})
        self.assertEqual(status, 200)
        ck = body['ride']['checkin']
        self.assertEqual((ck['feel_fine'], ck['pain_regions'], ck['symptoms'], ck['notes']), (False, ['Back', 'Neck'], ['Headache'], 'Sore'))
        self.assertEqual(self.request('/api/rides/' + ride['ride_id'] + '/checkin', 'POST', {'pain_regions': ['Elbow']})[0], 400)
        self.assertEqual(self.request('/api/rides/' + ride['ride_id'] + '/checkin', 'POST', {'feel_fine': True, 'hack': 1})[0], 400)
        status, body = self.request('/api/rides/' + ride['ride_id'] + '/checkin', 'POST', {'feel_fine': True})
        self.assertTrue(body['ride']['checkin']['feel_fine'])
        self.assertTrue(self.request('/api/rides')[1]['rides'][0]['checkin']['feel_fine'])
        for f in ['/app.js', '/ui.js', '/helmet-ble.js', '/helmet3d.js', '/device.html', '/style.css']:
            self.assertEqual(self.request(f)[0], 200, f)

if __name__ == '__main__':
    unittest.main()
