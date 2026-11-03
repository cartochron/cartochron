"""Opt-in real Docker Compose rehearsal: isolation, persistence, and restore.

Run with `make check-deploy`; this intentionally creates and stops a real
container. The standard `make check` does not need Docker or network access.
All data and Compose resources use disposable, per-test names and paths.
"""

import base64
import http.client
import json
import os
import shutil
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent


class ComposeDeploymentTest(unittest.TestCase):
    def test_authenticated_restart_and_backup_restore(self):
        if not shutil.which("docker"):
            self.fail("Docker is required: install Docker Compose or omit check-deploy")

        with tempfile.TemporaryDirectory(prefix="cartochron-deploy-") as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir(mode=0o700)
            auth = data / "auth"
            auth.write_text("operator:local-integration-test-secret\n", encoding="ascii")
            auth.chmod(0o600)

            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]

            env = {**os.environ,
                   "CARTOCHRON_DATA_DIR": str(data),
                   "CARTOCHRON_UID": str(os.getuid()),
                   "CARTOCHRON_GID": str(os.getgid()),
                   "CARTOCHRON_PORT": str(port),
                   "COMPOSE_PROJECT_NAME": "cartochron_test_" + uuid.uuid4().hex[:12]}
            prefix = ["docker", "compose", "-f", str(ROOT / "compose.yaml")]

            def compose(*args, timeout=240):
                result = subprocess.run([*prefix, *args], cwd=ROOT, env=env,
                                        capture_output=True, text=True, timeout=timeout)
                if result.returncode:
                    self.fail(f"docker compose {' '.join(args)} failed:\n"
                              f"{result.stdout}\n{result.stderr}")
                return result.stdout.strip()

            def request(path, payload=None, authenticated=True):
                headers = {}
                if authenticated:
                    raw = base64.b64encode(b"operator:local-integration-test-secret").decode()
                    headers["Authorization"] = "Basic " + raw
                if payload is not None:
                    headers["Content-Type"] = "application/json"
                    payload = json.dumps(payload).encode()
                req = Request(f"http://127.0.0.1:{port}{path}", data=payload,
                              headers=headers)
                try:
                    with urlopen(req, timeout=3) as response:
                        body = response.read()
                        return response.status, json.loads(body) if path.startswith("/api/") else body
                except HTTPError as exc:
                    return exc.code, exc.read()

            def ready():
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    try:
                        status, _ = request("/api/tracks")
                        if status == 200:
                            return
                    except (OSError, URLError, TimeoutError):
                        pass
                    time.sleep(0.1)
                self.fail("Cartochron did not become ready after Compose start")

            # Run configuration validation before creating any Docker resources.
            config = json.loads(compose("config", "--format", "json"))
            service = config["services"]["cartochron"]
            self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
            self.assertEqual(service["read_only"], True)
            self.assertEqual(service["user"], f"{os.getuid()}:{os.getgid()}")
            self.assertEqual(service["volumes"][0]["source"], str(data))

            try:
                compose("up", "--build", "-d", timeout=300)
                ready()
                self.assertEqual(compose("port", "cartochron", "8765"),
                                 f"127.0.0.1:{port}")
                self.assertEqual(request("/api/tracks", authenticated=False)[0], 401)
                self.assertEqual(request("/vendor/leaflet/leaflet.js")[0], 200)
                code, _ = request("/api/position", {"lat": 47, "lon": 28,
                                                     "track_id": "integration"})
                self.assertEqual(code, 201)
                database = data / "observations.sqlite3"
                self.assertEqual(stat.S_IMODE(database.stat().st_mode), 0o600)

                # A stopped instance is safe to copy. We do not invoke a
                # new database service or change the schema for backup.
                compose("stop")
                backup = root / "backup.sqlite3"
                shutil.copy2(database, backup)
                self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
                with sqlite3.connect(f"file:{backup}?mode=ro", uri=True) as snapshot:
                    self.assertEqual(snapshot.execute("PRAGMA quick_check").fetchone()[0], "ok")
                    self.assertEqual(snapshot.execute(
                        "SELECT COUNT(*) FROM observations").fetchone()[0], 1)

                compose("start")
                ready()
                self.assertEqual(len(request("/api/points?track_id=integration")[1]["points"]), 1)
                self.assertEqual(request("/api/position", {
                    "lat": 48, "lon": 29, "track_id": "integration"})[0], 201)
                compose("stop")
                shutil.copy2(backup, database)
                compose("start")
                ready()
                points = request("/api/points?track_id=integration")[1]["points"]
                self.assertEqual([point["lat"] for point in points], [47])
            finally:
                # Never remove the data directory: the test owns it, not Docker.
                compose("down", "--remove-orphans", timeout=90)


if __name__ == "__main__":
    unittest.main()
