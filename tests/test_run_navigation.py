"""History paging uses an immutable run boundary and display names never rewrite provenance."""

from contextlib import closing
from http.client import HTTPConnection
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

from map_server import Handler, Server
from observation_store import ObservationStore, SCHEMA_VERSION


class RunNavigationTest(unittest.TestCase):
    def test_run_paging_by_last_insert_handles_regressing_clock_and_exact_filters(self):
        from unittest.mock import patch
        store = ObservationStore()
        try:
            a = store.enroll('A')
            b = store.enroll('B')
            with patch('observation_store.time.time_ns', return_value=2_000_000_000_000_000_000):
                store.record(47, 28, 'a-old', a, channel_id='channel.a')
            with patch('observation_store.time.time_ns', return_value=1_900_000_000_000_000_000):
                store.record(48, 29, 'b-old', b, channel_id='channel.b')
            with patch('observation_store.time.time_ns', return_value=1_800_000_000_000_000_000):
                store.record(49, 30, 'a-new', a, channel_id='channel.a')
            first = store.runs_page(limit=2)
            self.assertEqual([r['track_id'] for r in first['tracks']], ['a-new', 'b-old'])
            self.assertIsNotNone(first['next_cursor'])
            second = store.runs_page(limit=2, before=int(first['next_cursor']))
            self.assertEqual([r['track_id'] for r in second['tracks']], ['a-old'])
            self.assertIsNone(second['next_cursor'])
            self.assertEqual([r['track_id'] for r in store.runs_page(channel_id='channel.a')['tracks']], ['a-new', 'a-old'])
            self.assertEqual([r['track_id'] for r in store.runs_page(source_id=b)['tracks']], ['b-old'])
            with self.assertRaises(ValueError):
                store.runs_page(channel_id='channel.a', source_id=a)
            for bad in (0, -1, True, 2**64):
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    store.runs_page(before=bad)
        finally:
            store.close()

    def test_labels_are_mutable_but_run_source_and_channel_remain_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'observations.sqlite3'
            store = ObservationStore(path)
            source = store.enroll('Research source')
            store.record(47, 28, 'run-a', source, channel_id='lab.oneplus')
            store.record(48, 29, 'run-b', source, channel_id='lab.oneplus')
            store.rename_source(source, 'OnePlus enrolled source')
            store.label_channel('lab.oneplus', 'OnePlus GPSD input')
            with self.assertRaisesRegex(ValueError, 'unknown channel'):
                store.label_channel('lab.unknown', 'Invented')
            with self.assertRaisesRegex(ValueError, 'not enrolled'):
                store.rename_source('src_' + 'a'*24, 'Invented')
            for invalid in ('', ' ', 'x'*81, 'bad\nname'):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    store.label_channel('lab.oneplus', invalid)
            store.close()
            reopened = ObservationStore(path)
            try:
                entries = reopened.monitor()['entries']
                self.assertEqual(entries[0]['channel_label'], 'OnePlus GPSD input')
                self.assertEqual(entries[0]['source_label'], 'OnePlus enrolled source')
                self.assertEqual(entries[0]['lat'], 48)
                self.assertEqual(entries[0]['lon'], 29)
                listing = reopened.runs_page(channel_id='lab.oneplus')['tracks']
                self.assertEqual([r['channel_label'] for r in listing], ['OnePlus GPSD input']*2)
                self.assertEqual({r['source_id'] for r in listing}, {source})
                self.assertEqual({r['channel_id'] for r in listing}, {'lab.oneplus'})
                self.assertEqual([p['lat'] for p in reopened.history('run-a')['points']], [47])
            finally:
                reopened.close()

    def test_v4_to_v5_migration_keeps_existing_run_and_measurement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v4.sqlite3'
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript('''
                    CREATE TABLE sources(source_id TEXT PRIMARY KEY,label TEXT NOT NULL);
                    CREATE TABLE runs(track_id TEXT PRIMARY KEY,source_id TEXT REFERENCES sources(source_id),channel_id TEXT);
                    CREATE INDEX runs_channel ON runs(channel_id);
                    CREATE TABLE observations(id INTEGER PRIMARY KEY,track_id TEXT NOT NULL,
                      received_ms INTEGER NOT NULL,lat REAL NOT NULL,lon REAL NOT NULL,
                      measured_ms INTEGER,provider TEXT,accuracy_m REAL);
                    CREATE INDEX observations_track_time ON observations(track_id,received_ms,id);
                    INSERT INTO runs VALUES('old-run',NULL,'lab.old');
                    INSERT INTO observations(track_id,received_ms,lat,lon,measured_ms,provider,accuracy_m)
                    VALUES('old-run',1700000000000,47,28,1699999999999,'gpsd',7.5);
                    PRAGMA user_version=4;
                ''')
            path.chmod(0o600)
            store = ObservationStore(path)
            try:
                self.assertEqual(store.tracks()['tracks'][0]['channel_id'], 'lab.old')
                self.assertIsNone(store.tracks()['tracks'][0]['channel_label'])
                store.label_channel('lab.old', 'Old input')
                self.assertEqual(store.history('old-run')['points'][0]['provider'], 'gpsd')
            finally:
                store.close()
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)
                self.assertEqual(db.execute('SELECT label FROM channel_labels').fetchone()[0], 'Old input')

    def test_cli_rename_and_channel_label(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'db.sqlite3'
            with closing(ObservationStore(path)) as store:
                source = store.enroll('Source')
                store.record(47, 28, 'r1', source, channel_id='udp.oneplus')
            subprocess.run([sys.executable, 'sources.py', '--db', str(path),
                            'rename', source, 'OnePlus source'], check=True)
            subprocess.run([sys.executable, 'channels.py', '--db', str(path),
                            'udp.oneplus', 'OnePlus GPSD input'], check=True)
            store = ObservationStore(path)
            try:
                self.assertEqual(store.monitor()['entries'][0]['channel_label'], 'OnePlus GPSD input')
                self.assertEqual(store.monitor()['entries'][0]['source_label'], 'OnePlus source')
            finally:
                store.close()


class RunsHttpTest(unittest.TestCase):
    def setUp(self):
        self.server = Server(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, url, auth=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        try:
            conn.request('GET', url, headers={'Authorization': auth} if auth else {})
            res = conn.getresponse()
            return res.status, json.loads(res.read())
        finally:
            conn.close()

    def test_bounded_pagination_and_authentication(self):
        s = self.server.store
        s.record(47, 28, 'first', channel_id='gpsd.a')
        s.record(48, 28, 'second', channel_id='gpsd.a')
        s.record(49, 28, 'third', channel_id='gpsd.b')
        status, first = self.get('/api/runs?limit=2')
        self.assertEqual(status, 200)
        self.assertEqual([r['track_id'] for r in first['tracks']], ['third', 'second'])
        status, second = self.get('/api/runs?limit=2&before=' + first['next_cursor'])
        self.assertEqual(status, 200)
        self.assertEqual([r['track_id'] for r in second['tracks']], ['first'])
        self.assertEqual(self.get('/api/runs?channel_id=gpsd.a')[1]['tracks'][0]['track_id'], 'second')
        for query in ('limit=0', 'limit=101', 'limit=2&limit=3', 'before=-1', 'before=x',
                      'channel_id=../x', 'source_id=invalid', 'channel_id=gpsd.a&source_id=src_'+'a'*24,
                      'other=x'):
            with self.subTest(query=query):
                self.assertEqual(self.get('/api/runs?' + query)[0], 400)
        self.server.authorization = 'Basic dGVzdDp0ZXN0'
        self.assertEqual(self.get('/api/runs')[0], 401)
        self.assertEqual(self.get('/api/runs', 'Basic dGVzdDp0ZXN0')[0], 200)


if __name__ == '__main__':
    unittest.main()
