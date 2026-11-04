"""Two-run spatial/receipt-time witnesses, not inferred encounters or journeys."""

from http.client import HTTPConnection
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from map_server import Handler, Server, parse_proximity_query
from observation_store import ObservationStore


class ProximityStoreTest(unittest.TestCase):
    def setUp(self):
        self.store = ObservationStore()
        self.a = self.store.enroll('Research A')
        self.b = self.store.enroll('Research B')
        self.clock = 1_800_000_000_000

    def tearDown(self):
        self.store.close()

    def record(self, track, lat, lon, source, channel, *, ms=None, measured=None):
        self.clock += 1000
        with patch('observation_store.time.time_ns', return_value=(ms or self.clock) * 1_000_000):
            self.store.record(lat, lon, track, source, channel_id=channel, measured_ms=measured,
                              accuracy_m=12)

    def query(self, **kwargs):
        options = {'radius_m': 100, 'window_s': 300, **kwargs}
        return self.store.run_proximity('run-a', 'run-b', **options)

    def test_near_receipt_witness_is_supported_by_two_original_fixes(self):
        self.record('run-a', 47, 28, self.a, 'lab.a', ms=1_800_000_000_000,
                    measured=1_700_000_000_000)  # Reported measurement could be old.
        self.record('run-b', 47.0001, 28.0001, self.b, 'lab.b', ms=1_800_000_009_000,
                    measured=1_600_000_000_000)
        self.record('run-b', 47.9, 28.9, self.b, 'lab.b', ms=1_800_000_001_000)
        result = self.query()
        self.assertEqual(result['scanned'], 1)
        self.assertFalse(result['truncated'])
        self.assertFalse(result['candidate_limited'])
        self.assertEqual(len(result['pairs']), 1)
        match = result['pairs'][0]
        self.assertEqual(match['identity_kind'], 'source')
        self.assertEqual(match['receipt_delta_ms'], 9000)
        self.assertLess(match['distance_m'], 20)
        self.assertEqual(match['a']['track_id'], 'run-a')
        self.assertEqual(match['b']['track_id'], 'run-b')
        self.assertNotEqual(match['a']['id'], match['b']['id'])
        self.assertIn('measured_time', match['a'])
        self.assertEqual(match['a']['source_id'], self.a)
        self.assertEqual(match['b']['source_id'], self.b)

    def test_not_near_in_time_or_space_and_no_interpolated_match(self):
        self.record('run-a', 47, 28, self.a, 'lab.a', ms=1_800_000_000_000)
        self.record('run-b', 47.01, 28.01, self.b, 'lab.b', ms=1_800_000_000_000)
        self.assertEqual(self.query()['pairs'], [])
        self.record('run-b', 47.0001, 28.0001, self.b, 'lab.b', ms=1_800_002_000_000)
        self.assertEqual(self.query()['pairs'], [])

    def test_page_by_receipt_time_even_with_nonmonotonic_ingest_clock(self):
        for ms in (1_800_000_020_000, 1_800_000_010_000, 1_800_000_030_000):
            self.record('run-a', 47, 28, self.a, 'lab.a', ms=ms)
        self.record('run-b', 47, 28, self.b, 'lab.b', ms=1_800_000_020_000)
        page1 = self.query(limit=1)
        self.assertTrue(page1['truncated'])
        self.assertEqual(page1['pairs'][0]['a']['received_ms'], 1_800_000_030_000)
        before = tuple(map(int, page1['next_cursor'].split(':')))
        page2 = self.query(limit=1, before=before)
        self.assertEqual(page2['pairs'][0]['a']['received_ms'], 1_800_000_020_000)
        page3 = self.query(limit=1, before=tuple(map(int, page2['next_cursor'].split(':'))))
        self.assertEqual(page3['pairs'][0]['a']['received_ms'], 1_800_000_010_000)
        self.assertFalse(page3['truncated'])

    def test_sparse_page_without_matches_still_advances(self):
        for n in range(202):
            self.record('run-a', 40, 20, self.a, 'lab.a', ms=1_800_000_000_000 + n * 1000)
        self.record('run-b', 42, 20, self.b, 'lab.b')
        page = self.query(limit=10)
        self.assertEqual(page['pairs'], [])
        self.assertEqual(page['scanned'], 200)
        self.assertTrue(page['truncated'])
        self.assertEqual(self.query(before=tuple(map(int, page['next_cursor'].split(':'))))['scanned'], 2)

    def test_no_crossing_dateline_or_pole_error(self):
        self.record('run-a', 0, 179.9999, self.a, 'lab.a')
        self.record('run-b', 0, -179.9999, self.b, 'lab.b')
        self.assertEqual(len(self.query()['pairs']), 1)
        self.record('pole-a', 89.9999, 179.9999, self.a, 'lab.pole.a')
        self.record('pole-b', 89.9999, -179.9999, self.b, 'lab.pole.b')
        result = self.store.run_proximity('pole-a', 'pole-b', 100, 300)
        self.assertEqual(len(result['pairs']), 1)

    def test_same_source_same_channel_and_ambiguous_claims_are_rejected(self):
        self.record('run-a', 47, 28, self.a, 'lab.a')
        self.record('run-b', 47, 28, self.a, 'lab.b')
        with self.assertRaisesRegex(ValueError, 'share'):
            self.query()
        self.record('run-c', 47, 28, self.b, 'lab.a')
        with self.assertRaisesRegex(ValueError, 'share'):
            self.store.run_proximity('run-a', 'run-c', 100, 300)
        self.record('run-d', 47, 28, self.b, 'lab.d')
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            self.store.run_proximity('run-a', 'run-d', 100, 300)

    def test_distinct_unassigned_channels_are_only_channel_claims(self):
        self.record('run-a', 47, 28, None, 'a')
        self.record('run-b', 47, 28, None, 'b')
        self.assertEqual(self.query()['pairs'][0]['identity_kind'], 'channel')
        self.record('run-unknown', 47, 28, None, None)
        with self.assertRaisesRegex(ValueError, 'lack'):
            self.store.run_proximity('run-a', 'run-unknown', 100, 300)

    def test_dense_time_window_is_flagged_as_partial_even_with_no_match(self):
        self.record('run-a', 47, 28, self.a, 'a')
        # The bounding box includes these fixes but the 100-m circle does not.
        for n in range(120):
            self.record('run-b', 47.00085, 28.0012, self.b, 'b',
                        ms=1_800_000_000_000 + n)
        result = self.query()
        self.assertEqual(result['pairs'], [])
        self.assertTrue(result['candidate_limited'])

    def test_validation_and_time_bounds(self):
        self.record('run-a', 47, 28, self.a, 'a')
        self.record('run-b', 47, 28, self.b, 'b')
        for options in ({'limit': 0}, {'window_s': 42}, {'radius_m': 1},
                        {'before': (12, 0)}, {'from_ms': 1000, 'to_ms': 1000}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.query(**options)
        self.assertEqual(self.query(to_ms=1_700_000_000_000)['pairs'], [])


class ProximityHTTPTest(unittest.TestCase):
    def test_endpoint_checks_parameters_and_authentication(self):
        with tempfile.TemporaryDirectory() as dirpath:
            path = Path(dirpath) / 'db.sqlite3'
            server = Server(('127.0.0.1', 0), Handler, database=path)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                s = server.store
                a, b = s.enroll('A'), s.enroll('B')
                s.record(47, 28, 'a', a, channel_id='channel.a')
                s.record(47, 28, 'b', b, channel_id='channel.b')
                base = '/api/proximity?track_id=a&other_track_id=b&radius_m=100&window_s=60'
                def get(url, auth=None):
                    conn = HTTPConnection('127.0.0.1', server.server_port, timeout=4)
                    headers = {'Authorization': auth} if auth else {}
                    conn.request('GET', url, headers=headers)
                    reply = conn.getresponse()
                    status, body = reply.status, json.loads(reply.read())
                    conn.close()
                    return status, body
                status, result = get(base)
                self.assertEqual(status, 200)
                self.assertEqual(len(result['pairs']), 1)
                for suffix in ('&evil=1', '&limit=0', '&track_id=a',
                               '&window_s=12', '&before=invalid',
                               '&from=2026-11-01', '&other_track_id=a'):
                    with self.subTest(suffix=suffix):
                        self.assertEqual(get(base + suffix)[0], 400)
                server.authorization = 'Basic dGVzdDp0ZXN0'
                self.assertEqual(get(base)[0], 401)
                self.assertEqual(get(base, 'Basic dGVzdDp0ZXN0')[0], 200)
            finally:
                server.shutdown()
                thread.join(5)
                server.server_close()

    def test_query_parser_is_explicit(self):
        parsed = parse_proximity_query('track_id=a&other_track_id=b&radius_m=100&window_s=300')
        self.assertEqual(parsed['track_id'], 'a')
        self.assertEqual(parsed['other_track_id'], 'b')
        self.assertEqual(parsed['limit'], 20)


if __name__ == '__main__':
    unittest.main()
