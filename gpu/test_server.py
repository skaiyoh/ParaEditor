"""Focused lifecycle, resource-bound and malformed-input regression checks."""
from contextlib import closing
import http.client
import json
import threading
import time
import unittest
from unittest.mock import patch

import server


class Engine:
    def health(self):
        return {"ok": True}

    def taps(self, *args):
        raise AssertionError("Malformed taps must not reach the model")


class StateTests(unittest.TestCase):
    def test_two_analyses_and_bounded_wait_release_on_error(self):
        state = server.State(Engine())
        with patch.object(server, "QUEUE_SECONDS", .02):
            with state.inference(), state.inference():
                started = time.monotonic()
                with self.assertRaises(server.Problem) as raised:
                    with state.inference():
                        self.fail("A third analysis ran")
                self.assertEqual(raised.exception.status, 503)
                self.assertLess(time.monotonic() - started, .1)
            with self.assertRaises(ValueError):
                with state.inference():
                    raise ValueError("Failed model")
            with state.inference(), state.inference():
                pass

    def test_same_session_wait_included_in_queue_deadline(self):
        state = server.State(Engine())
        session = server.Session(None, b"", None, 2, 2)
        with patch.object(server, "QUEUE_SECONDS", .02), state.inference(session):
            with self.assertRaises(server.Problem) as raised:
                with state.inference(session):
                    self.fail("A session was used concurrently")
            self.assertEqual(raised.exception.status, 503)

    def test_sliding_expiry_and_deleted_session_never_returns(self):
        state = server.State(Engine())
        session = server.Session(None, b"", None, 2, 2, touched=0)
        state.sessions["first"] = session
        with patch.object(server.time, "monotonic", return_value=1799):
            self.assertIs(state.get("first"), session)
        with patch.object(server.time, "monotonic", return_value=3598):
            self.assertIs(state.get("first"), session)
        with patch.object(server.time, "monotonic", return_value=5398):
            with self.assertRaises(server.Problem) as raised:
                state.get("first")
            self.assertEqual(raised.exception.status, 404)
        state.sessions["next"] = session
        with patch.object(server.time, "monotonic", return_value=3599):
            self.assertIs(state.get("next", delete=True), session)
            self.assertNotIn("next", state.sessions)
        # A running request may still hold its reference after deletion.
        self.assertEqual(session.width, 2)

    def test_capacity_and_rate_limit_by_address(self):
        state = server.State(Engine())
        with patch.object(server, "MAX_SESSIONS", 2), state.reserve("a"), state.reserve("b"):
            with self.assertRaises(server.Problem) as raised:
                with state.reserve("c"):
                    pass
            self.assertEqual(raised.exception.status, 503)
        self.assertEqual(state.pending, 0)
        for _ in range(9):
            with state.reserve("a"):
                pass
        with self.assertRaises(server.Problem) as raised:
            with state.reserve("a"):
                pass
        self.assertEqual(raised.exception.status, 429)
        with state.reserve("independent"):
            pass


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = server.State(Engine())
        cls.state.sessions["sample"] = server.Session(None, b"", None, 2, 2)
        cls.http = server.Server(("127.0.0.1", 0), cls.state)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def request(self, path, body, headers):
        with closing(http.client.HTTPConnection(*self.http.server_address, timeout=2)) as client:
            client.request("POST", path, body, headers)
            response = client.getresponse()
            result = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            self.assertIn("error", json.loads(result))
            return response.status

    def test_malformed_taps_are_400(self):
        for point in [{"x": .5, "y": .5, "label": []}, {"x": 10**400, "y": .5, "label": "include"},
                      {"x": float("nan"), "y": .5, "label": "include"}, {"x": True, "y": .5, "label": "include"}]:
            with self.subTest(point_type=type(point["x"]).__name__):
                self.assertEqual(self.request("/v1/sessions/sample/taps", json.dumps({"points": [point]}), {"Content-Type": "application/json"}), 400)

    def test_photo_size_rejected_without_waiting_for_body(self):
        self.assertEqual(self.request("/v1/sessions", b"", {"Content-Type": "image/png", "X-Width": "2", "X-Height": "2", "Content-Length": str(server.MAX_BODY + 1)}), 413)

    def test_content_length_requires_ascii_digits(self):
        self.assertEqual(self.request("/v1/sessions", b"", {"Content-Type": "image/png", "X-Width": "2", "X-Height": "2", "Content-Length": "\u00b2"}), 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
