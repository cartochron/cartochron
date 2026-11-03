"""Worker limits must protect normal requests when clients occupy sockets."""

import http.client
import threading
import unittest

from map_server import Handler, Server


class WorkerLimitsTest(unittest.TestCase):
    def test_stalled_clients_cannot_create_unbounded_workers(self):
        entered = threading.Semaphore(0)
        release = threading.Event()

        class WaitingHandler(Handler):
            def do_GET(self):
                entered.release()
                release.wait(timeout=5)
                super().do_GET()

        server = Server(("127.0.0.1", 0), WaitingHandler, max_workers=2)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        clients = []

        def connect():
            client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            clients.append(client)
            client.request("GET", "/")
            return client

        try:
            first = connect()
            self.assertTrue(entered.acquire(timeout=2))
            second = connect()
            self.assertTrue(entered.acquire(timeout=2))

            # No worker available: return 503 directly from the accept loop,
            # instead of creating a third request thread.
            busy = connect()
            response = busy.getresponse()
            self.assertEqual(response.status, 503)
            self.assertEqual(response.read(), b"")

            release.set()
            for client in (first, second):
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                client.close()
            response = connect().getresponse()
            self.assertEqual(response.status, 200)
            response.read()
        finally:
            release.set()
            for client in clients:
                client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_invalid_worker_limit_fails_before_creating_a_server(self):
        for limit in (0, -1, 257, True, 1.5):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                Server(("127.0.0.1", 0), Handler, max_workers=limit)


if __name__ == "__main__":
    unittest.main()
