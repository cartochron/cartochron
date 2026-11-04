"""Monitor summarizes *identities*, never splices independently recorded runs."""

import json
import unittest
from observation_store import ObservationStore

class MonitorStoreTest(unittest.TestCase):
    def test_channel_newest_run_is_selected_and_other_run_remains_history(self):
        store = ObservationStore()
        try:
            store.record(47, 28, 'oneplus-first', channel_id='gpsd.oneplus')
            store.record(48, 29, 'lg-first', channel_id='gpsd.lg')
            store.record(49, 30, 'oneplus-second', channel_id='gpsd.oneplus')
            result = store.monitor()
            self.assertFalse(result['truncated'])
            self.assertEqual([r['id'] for r in result['entries']],
                             ['gpsd.oneplus', 'gpsd.lg'])
            self.assertEqual(result['entries'][0]['track_id'], 'oneplus-second')
            self.assertEqual(result['entries'][0]['runs'], 2)
            self.assertEqual([p['lat'] for p in store.history('oneplus-first')['points']], [47])
            self.assertEqual([p['lat'] for p in store.history('oneplus-second')['points']], [49])
        finally:
            store.close()

    def test_source_only_runs_group_by_enrollment_not_label(self):
        store = ObservationStore()
        try:
            a, b = store.enroll('Same label'), store.enroll('Same label')
            store.record(47, 28, 'run-a1', source_id=a)
            store.record(47, 28, 'run-b', source_id=b)
            store.record(47, 28, 'run-a2', source_id=a)
            entries = store.monitor()['entries']
            self.assertEqual([(e['id'], e['runs']) for e in entries], [(a, 2), (b, 1)])
            self.assertTrue(all(e['kind'] == 'source' for e in entries))
        finally:
            store.close()

    def test_unattributed_history_is_not_merged_or_guessed_from_run_prefix(self):
        store = ObservationStore()
        try:
            store.record(47, 28, 'oneplus-old')
            store.record(47, 28, 'oneplus-new')
            entries = store.monitor()['entries']
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]['kind'], 'unattributed')
            self.assertEqual(entries[0]['track_id'], 'oneplus-new')
            self.assertEqual(entries[0]['runs'], 2)
            self.assertEqual(len(store.tracks()['tracks']), 2)
        finally:
            store.close()

    def test_conflicting_source_assertions_on_one_channel_are_disclosed(self):
        store = ObservationStore()
        try:
            a, b = store.enroll('A'), store.enroll('B')
            store.record(47, 28, 'run-A', a, channel_id='udp.1')
            store.record(47, 28, 'run-B', b, channel_id='udp.1')
            row = store.monitor()['entries'][0]
            self.assertEqual(row['kind'], 'channel')
            self.assertTrue(row['mixed_sources'])
            self.assertEqual(row['source_id'], b)
            self.assertEqual(row['runs'], 2)
        finally:
            store.close()

    def test_monitor_is_bounded_and_latest_ingested_wins_even_if_clock_regresses(self):
        from unittest.mock import patch
        store = ObservationStore()
        try:
            with patch('observation_store.time.time_ns', return_value=2_000_000_000_000_000_000):
                store.record(47, 28, 'old', channel_id='gpsd.1')
            with patch('observation_store.time.time_ns', return_value=1_900_000_000_000_000_000):
                store.record(48, 28, 'new', channel_id='gpsd.1')
            latest = store.monitor()['entries'][0]
            self.assertEqual(latest['track_id'], 'new')
            self.assertEqual(latest['last'], store.tracks()['tracks'][0]['last'])
            for index in range(105):
                store.record(47, 28, f'run-{index}', channel_id=f'channel-{index}')
            result = store.monitor()
            self.assertEqual(len(result['entries']), 100)
            self.assertTrue(result['truncated'])
        finally:
            store.close()

class MonitorHttpTest(unittest.TestCase):
    def setUp(self):
        import threading
        from map_server import Handler, Server
        self.server = Server(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, headers=None):
        from http.client import HTTPConnection
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        try:
            conn.request('GET', path, headers=headers or {})
            res = conn.getresponse()
            return res.status, json.loads(res.read())
        finally:
            conn.close()

    def test_readonly_monitor_exposes_latest_run_per_channel(self):
        store = self.server.store
        store.record(47, 28, 'first', channel_id='oneplus')
        store.record(47, 28, 'second', channel_id='oneplus')
        status, payload = self.request('/api/monitor')
        self.assertEqual(status, 200)
        self.assertEqual(len(payload['entries']), 1)
        self.assertEqual(payload['entries'][0]['track_id'], 'second')
        self.assertEqual(payload['entries'][0]['runs'], 2)
        self.assertEqual(self.request('/api/monitor?ignored=1')[0], 404)

    def test_monitor_requires_same_credentials_as_history(self):
        self.server.authorization = 'Basic dGVzdDp0ZXN0'
        self.assertEqual(self.request('/api/monitor')[0], 401)
        self.assertEqual(self.request('/api/monitor', {'Authorization': 'Basic dGVzdDp0ZXN0'})[0], 200)
