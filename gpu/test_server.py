"""Focused lifecycle, resource-bound and malformed-input regression checks."""
from contextlib import closing
import http.client
import gzip
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
        session = server.Session(None, b"", None, 2, 2, created=0, touched=0)
        state.sessions["first"] = session
        with patch.object(server.time, "monotonic", return_value=1799):
            self.assertIs(state.get("first", touch=True), session)
        with patch.object(server.time, "monotonic", return_value=3598):
            self.assertIs(state.get("first", touch=True), session)
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

    def test_absolute_expiry_despite_accepted_touches(self):
        for reap in (False, True):
            with self.subTest(reap=reap):
                state = server.State(Engine())
                session = server.Session(None, b"", None, 2, 2, created=0, touched=0)
                state.sessions["first"] = session
                for now in (1799, 3598, 5397, 7196, 7199):
                    with patch.object(server.time, "monotonic", return_value=now):
                        self.assertIs(state.get("first", touch=True), session)
                with patch.object(server.time, "monotonic", return_value=7200):
                    if reap:
                        state.reap()
                    with self.assertRaises(server.Problem) as raised:
                        state.get("first", touch=True)
                    self.assertEqual(raised.exception.status, 404)
                    self.assertNotIn("first", state.sessions)
                    with patch.object(server, "MAX_SESSIONS", 1), state.reserve("new"):
                        self.assertEqual(state.pending, 1)

    def test_lookup_does_not_refresh_idle_expiry_and_reaper_honors_it(self):
        state = server.State(Engine())
        session = server.Session(None, b"", None, 2, 2, created=0, touched=0)
        state.sessions["first"] = session
        with patch.object(server.time, "monotonic", return_value=1799):
            self.assertIs(state.get("first"), session)
            self.assertEqual(session.touched, 0)
        with patch.object(server.time, "monotonic", return_value=1800):
            state.reap()
            self.assertNotIn("first", state.sessions)

    def test_capacity_rejections_do_not_charge_creation_budget(self):
        state = server.State(Engine())
        with patch.object(server, "MAX_SESSIONS", 1), state.reserve("busy"):
            for _ in range(12):
                with self.assertRaises(server.Problem) as raised:
                    with state.reserve("waiting"):
                        self.fail("Full service granted a reservation")
                self.assertEqual(raised.exception.status, 503)
            self.assertEqual(list(state.rates.get("waiting", [])), [])
        for _ in range(10):
            with state.reserve("waiting"):
                pass
        with self.assertRaises(server.Problem) as raised:
            with state.reserve("waiting"):
                self.fail("Eleventh granted reservation escaped the rate limit")
        self.assertEqual(raised.exception.status, 429)

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

    def setUp(self):
        self.state.sessions["sample"] = server.Session(None, b"", None, 2, 2)

    def test_health_exposes_both_session_limits(self):
        with closing(http.client.HTTPConnection(*self.http.server_address, timeout=2)) as client:
            client.request("GET", "/v1/health")
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())["sessionLimits"],
                             {"idleSeconds": 1800, "maxLifetimeSeconds": 7200})

    def test_accepted_depth_refreshes_idle_but_not_absolute_lifetime(self):
        session = server.Session(None, b"depth", None, 2, 2, created=0, touched=5399)
        self.state.sessions["sample"] = session
        for now, expected in ((7198, 200), (7199, 200), (7200, 404)):
            with patch.object(server.time, "monotonic", return_value=now):
                with closing(http.client.HTTPConnection(*self.http.server_address, timeout=2)) as client:
                    client.request("GET", "/v1/sessions/sample/depth")
                    response = client.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                self.assertEqual(session.created, 0)
                self.assertEqual(session.touched, min(now, 7199))

    def test_accepted_taps_and_inpaint_refresh_idle_after_admission(self):
        for operation, body, headers, method, result in [
            ("taps", json.dumps({"points": [{"x": .5, "y": .5, "label": "include"}]}),
             {"Content-Type": "application/json"}, "taps", (b"masks", [1, 1, 1], 2, 2)),
            ("inpaint", b"mask", {"Content-Type": "application/octet-stream", "X-Width": "2", "X-Height": "2"},
             "inpaint", b"png"),
        ]:
            with self.subTest(operation=operation):
                session = server.Session(None, b"", None, 2, 2, created=0, touched=0)
                self.state.sessions["sample"] = session
                with patch.object(server.time, "monotonic", return_value=1799), \
                     patch.object(self.state.engine, method, return_value=result, create=True):
                    with closing(http.client.HTTPConnection(*self.http.server_address, timeout=2)) as client:
                        client.request("POST", "/v1/sessions/sample/" + operation, body, headers)
                        response = client.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()
                self.assertEqual(session.touched, 1799)
                self.assertEqual(session.created, 0)

    def test_invalid_requests_do_not_touch_session(self):
        session = server.Session(None, b"", None, 2, 2, created=0, touched=0)
        self.state.sessions["sample"] = session
        with patch.object(server.time, "monotonic", return_value=1799):
            for operation, body, headers in [
                ("taps", b"{}", {"Content-Type": "application/json"}),
                ("inpaint", b"", {"Content-Type": "application/octet-stream", "X-Width": "2", "X-Height": "2"}),
                ("depth", b"", {}),
            ]:
                with self.subTest(operation=operation):
                    self.assertEqual(self.request("/v1/sessions/sample/" + operation, body, headers), 400)
                    self.assertEqual(session.touched, 0)
        with patch.object(server.time, "monotonic", return_value=1800):
            self.assertEqual(self.request("/v1/sessions/sample/taps", b"{}", {"Content-Type": "application/json"}), 404)

    def test_queue_rejection_does_not_touch_session(self):
        session = self.state.sessions["sample"]
        touched = session.touched
        with patch.object(server, "QUEUE_SECONDS", .02), self.state.inference(), self.state.inference():
            self.assertEqual(self.request("/v1/sessions/sample/taps", json.dumps({"points": [
                {"x": .5, "y": .5, "label": "include"}]}), {"Content-Type": "application/json"}), 503)
        self.assertEqual(session.touched, touched)

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
        with closing(http.client.HTTPConnection(*self.http.server_address, timeout=2)) as client:
            started = time.monotonic()
            client.request("POST", "/v1/sessions", b"", {"Content-Type": "image/png", "X-Width": "2", "X-Height": "2", "Content-Length": str(server.MAX_BODY + 1)})
            response = client.getresponse()
            self.assertEqual(response.status, 413)
            self.assertIn("error", json.loads(response.read()))
            self.assertLess(time.monotonic() - started, 1)
            client.request("DELETE", "/v1/sessions/sample")
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"ok": True})

    def test_complete_requests_reuse_socket_and_gzip_preserves_planes(self):
        plane = bytes(range(256)) * 100
        self.state.sessions["sample"].depth = plane
        with closing(http.client.HTTPConnection(*self.http.server_address, timeout=2)) as client:
            client.request("GET", "/v1/sessions/sample/depth", headers={"Accept-Encoding": "gzip"})
            sock = client.sock
            response = client.getresponse()
            self.assertEqual(response.getheader("Content-Encoding"), "gzip")
            wire = response.read()
            self.assertEqual(gzip.decompress(wire), plane)
            self.assertLess(len(wire), len(plane))
            self.assertIn("pack;dur=", response.getheader("Server-Timing"))
            client.request("DELETE", "/v1/sessions/sample")
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            self.assertIs(client.sock, sock)

    def test_content_length_requires_ascii_digits(self):
        self.assertEqual(self.request("/v1/sessions", b"", {"Content-Type": "image/png", "X-Width": "2", "X-Height": "2", "Content-Length": "\u00b2"}), 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
