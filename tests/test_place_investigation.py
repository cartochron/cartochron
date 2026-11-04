"""Full-database place search preserves individual observations and bounded coverage."""

from http.client import HTTPConnection
import json
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from map_server import Handler, Server
from observation_store import ObservationStore, SCHEMA_VERSION, MAX_PLACE_CANDIDATES


class PlaceSearchTest(unittest.TestCase):
    def test_cross_run_provenance_and_exact_circle_not_bounding_square(self):
        store = ObservationStore()
        try:
            source = store.enroll('Synthetic OnePlus')
            store.record(47, 28, 'first', source, channel_id='gpsd.a',
                         measured_ms=1_700_000_000_000, provider='gpsd', accuracy_m=7)
            store.label_channel('gpsd.a', 'Registered receiver A')
            # Close enough to be within 100m, from another unassigned run.
            store.record(47.0003, 28, 'second', channel_id='gpsd.b')
            # Inside conservative bounding square, but outside the true circle.
            store.record(47.00085, 28.0011, 'outside')
            page = store.place_observations(47, 28, 100)
            self.assertEqual([p['track_id'] for p in page['points']], ['second', 'first'])
            self.assertFalse(page['truncated'])
            self.assertIsNone(page['next_cursor'])
            original = page['points'][-1]
            self.assertEqual(original['source_label'], 'Synthetic OnePlus')
            self.assertEqual(original['channel_label'], 'Registered receiver A')
            self.assertEqual(original['provider'], 'gpsd')
            self.assertEqual(original['accuracy_m'], 7)
            self.assertIn('measured_time', original)
            self.assertEqual(page['points'][0]['source_id'], None)
            self.assertLess(page['points'][0]['distance_m'], 100)
            self.assertEqual(len(store.runs_page()['tracks']), 3)
        finally:
            store.close()

    def test_antimeridian_and_ordinary_nonmatch(self):
        store = ObservationStore()
        try:
            store.record(0, 179.9997, 'east')
            store.record(0, -179.9997, 'west')
            store.record(0, -179, 'far')
            tracks = [p['track_id'] for p in store.place_observations(0, 180, 100)['points']]
            self.assertEqual(tracks, ['west', 'east'])
            self.assertEqual(store.place_observations(48, 28, 50)['points'], [])
        finally:
            store.close()

    def test_cursor_advances_across_empty_pages_and_clock_regressions(self):
        directory = tempfile.TemporaryDirectory()
        store = ObservationStore(Path(directory.name) / 'observations.sqlite3')
        try:
            with patch('observation_store.time.time_ns', return_value=2_000_000_000_000_000_000):
                store.record(0, 0, 'older-good')
            # All these points pass the bounding rectangle but not the circle.
            # The bounded query must not silently claim the entire DB has no hit.
            with patch('observation_store.time.time_ns', return_value=1_900_000_000_000_000_000):
                for i in range(MAX_PLACE_CANDIDATES):
                    store.record(.0008, .0008, 'corner-run')
            empty = store.place_observations(0, 0, 100)
            self.assertEqual(empty['points'], [])
            self.assertEqual(empty['scanned'], MAX_PLACE_CANDIDATES)
            self.assertTrue(empty['truncated'])
            self.assertIsNotNone(empty['next_cursor'])
            last = store.place_observations(0, 0, 100, before=int(empty['next_cursor']))
            self.assertEqual([p['track_id'] for p in last['points']], ['older-good'])
            self.assertFalse(last['truncated'])
        finally:
            store.close()
            directory.cleanup()

    def test_validation_bounds_and_no_implicit_normalization(self):
        store = ObservationStore()
        try:
            for params in [(-91, 0, 100), (0, 181, 100), (True, 0, 100),
                           (0, 0, float('nan')), (0, 0, 1001), (0, 0, 0)]:
                with self.subTest(params=params), self.assertRaises(ValueError):
                    store.place_observations(*params)
            for wrong in (False, 0, 101, 3.5):
                with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                    store.place_observations(0, 0, 100, limit=wrong)
            for wrong in (0, False, -1, 2 ** 63):
                with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                    store.place_observations(0, 0, 100, before=wrong)
        finally:
            store.close()

    def test_time_window_and_exact_channel_source_filters(self):
        store = ObservationStore()
        try:
            source_a = store.enroll('A')
            source_b = store.enroll('B')
            epoch = 1_800_000_000_000_000_000
            with patch('observation_store.time.time_ns', return_value=epoch):
                store.record(0, 0, 'a1', source_a, channel_id='gpsd.a')
            with patch('observation_store.time.time_ns', return_value=epoch + 1_000_000):
                store.record(0, 0, 'a2', source_a, channel_id='msf.a')
            with patch('observation_store.time.time_ns', return_value=epoch + 2_000_000):
                store.record(0, 0, 'b1', source_b, channel_id='gpsd.b')
            since = epoch // 1_000_000 + 1
            until = since + 1
            self.assertEqual([p['track_id'] for p in store.place_observations(
                0, 0, 100, from_ms=since, to_ms=until)['points']], ['a2'])
            self.assertEqual([p['track_id'] for p in store.place_observations(
                0, 0, 100, channel_id='gpsd.a')['points']], ['a1'])
            self.assertEqual([p['track_id'] for p in store.place_observations(
                0, 0, 100, source_id=source_a)['points']], ['a2', 'a1'])
            self.assertEqual(store.place_observations(
                0, 0, 100, source_id=source_b, to_ms=since)['points'], [])
            page = store.place_observations(0, 0, 100, source_id=source_a, limit=1)
            self.assertEqual([p['track_id'] for p in page['points']], ['a2'])
            self.assertEqual([p['track_id'] for p in store.place_observations(
                0, 0, 100, source_id=source_a, limit=1,
                before=int(page['next_cursor']))['points']], ['a1'])
        finally:
            store.close()

    def test_invalid_place_filter_values_are_not_coerced(self):
        store = ObservationStore()
        try:
            for kwargs in ({'from_ms': True}, {'to_ms': 3.1},
                           {'from_ms': 5, 'to_ms': 5}, {'source_id': ''},
                           {'channel_id': 'bad space'},
                           {'channel_id': 'gpsd.a', 'source_id': 'src_' + 'a' * 24}):
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                    store.place_observations(0, 0, 100, **kwargs)
        finally:
            store.close()

    def test_v5_to_v6_migration_adds_only_index(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'observations.sqlite3'
            store = ObservationStore(path)
            source = store.enroll('Old source')
            store.record(47, 28, 'original', source, channel_id='ch.a')
            store.close()
            with sqlite3.connect(path) as db, db:
                db.execute('DROP INDEX observations_place')
                db.execute('PRAGMA user_version = 5')
            restored = ObservationStore(path)
            try:
                self.assertEqual(restored._db.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(restored.place_observations(47, 28, 100)['points'][0]['track_id'], 'original')
                self.assertEqual(restored.tracks()['tracks'][0]['source_id'], source)
            finally:
                restored.close()


class PlaceHttpTest(unittest.TestCase):
    def setUp(self):
        self.server = Server(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, url, auth=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        try:
            conn.request('GET', url, headers={'Authorization': auth} if auth else {})
            res = conn.getresponse()
            return res.status, json.loads(res.read())
        finally:
            conn.close()

    def test_place_scope_and_receipt_time_are_validated_over_http(self):
        from datetime import datetime, timezone
        source = self.server.store.enroll('Controlled source')
        with patch('observation_store.time.time_ns', return_value=1_800_000_000_000_000_000):
            self.server.store.record(0, 0, 'gpsd', source, channel_id='gpsd.a')
        with patch('observation_store.time.time_ns', return_value=1_800_000_001_000_000_000):
            self.server.store.record(0, 0, 'msf', source, channel_id='msf.a')
        t0 = datetime.fromtimestamp(1_800_000_000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        t1 = datetime.fromtimestamp(1_800_000_001, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        base = '/api/place/observations?lat=0&lon=0&radius_m=100'
        code, result = self.get(base + '&from=' + t0 + '&to=' + t1)
        self.assertEqual(code, 200)
        self.assertEqual([p['track_id'] for p in result['points']], ['gpsd'])
        code, result = self.get(base + '&source_id=' + source)
        self.assertEqual([p['track_id'] for p in result['points']], ['msf', 'gpsd'])
        code, result = self.get(base + '&channel_id=msf.a')
        self.assertEqual([p['track_id'] for p in result['points']], ['msf'])
        for suffix in ('&from=2026-11-04', '&to=2026-11-04T12:00:00',
                       '&from=invalid', '&channel_id=bad%20id',
                       '&source_id=invalid', '&source_id=' + source + '&channel_id=msf.a',
                       '&from=' + t1 + '&to=' + t0, '&to=' + t0 + '&to=' + t1):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.get(base + suffix)[0], 400)

    def test_query_validation_auth_and_run_isolation(self):
        self.server.store.record(47, 28, 'older')
        self.server.store.record(47.0001, 28, 'newer')
        path = '/api/place/observations?lat=47&lon=28&radius_m=100&limit=1'
        status, page = self.get(path)
        self.assertEqual(status, 200)
        self.assertEqual([p['track_id'] for p in page['points']], ['newer'])
        self.assertTrue(page['truncated'])
        _, old = self.get(path + '&before=' + page['next_cursor'])
        self.assertEqual([p['track_id'] for p in old['points']], ['older'])
        self.assertFalse(old['truncated'])
        for query in ['lat=47&lon=28', 'lat=foo&lon=28&radius_m=100',
                      'lat=47&lat=47&lon=28&radius_m=100',
                      'lat=47&lon=NaN&radius_m=100',
                      'lat=47&lon=28&radius_m=100&limit=999',
                      'lat=47&lon=28&radius_m=100&before=-1',
                      'lat=47&lon=28&radius_m=100&evil=1']:
            with self.subTest(query=query):
                self.assertEqual(self.get('/api/place/observations?' + query)[0], 400)
        self.server.authorization = 'Basic dGVzdDp0ZXN0'
        self.assertEqual(self.get(path)[0], 401)
        self.assertEqual(self.get(path, 'Basic dGVzdDp0ZXN0')[0], 200)


if __name__ == '__main__':
    unittest.main()
