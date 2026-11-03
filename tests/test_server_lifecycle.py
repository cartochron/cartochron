"""SIGTERM must drain HTTP writes and close the persistent database cleanly."""

import http.client
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from observation_store import ObservationStore


class ServerLifecycleTest(unittest.TestCase):
    def test_sigterm_preserves_an_accepted_fix(self):
        # Stage a self-contained server. Stub assets satisfy startup without
        # contacting npm or depending on the developer's vendored files.
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            for name in ("map_server.py", "observation_store.py", "index.html",
                         "viewer.js", "manual.html"):
                shutil.copyfile(root / name, stage / name)
            leaflet = stage / "vendor" / "leaflet"
            leaflet.mkdir(parents=True)
            (leaflet / "leaflet.js").write_text("/* test asset */")
            (leaflet / "leaflet.css").write_text("/* test asset */")
            database = stage / "history.sqlite3"
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen(
                [sys.executable, str(stage / "map_server.py"), "--port", str(port),
                 "--db", str(database)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while True:
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                        conn.request("POST", "/api/position",
                                     body=b'{"lat":47,"lon":28,"track_id":"shutdown"}',
                                     headers={"Content-Type": "application/json"})
                        response = conn.getresponse()
                        code = response.status
                        response.read()
                        conn.close()
                        self.assertEqual(code, 201)
                        break
                    except (ConnectionError, OSError):
                        if process.poll() is not None or time.monotonic() > deadline:
                            self.fail("server never accepted a request")
                        time.sleep(0.05)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=6)
                self.assertEqual(process.returncode, 0, (stdout, stderr))
                store = ObservationStore(database)
                try:
                    self.assertEqual(len(store.history("shutdown")["points"]), 1)
                finally:
                    store.close()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
