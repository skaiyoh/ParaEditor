"""Regression checks for the narrowly allowed public upload disconnect."""
from contextlib import redirect_stdout
import http.client
import io
import ssl
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

import contract_test as contract


class OversizedUploadTests(unittest.TestCase):
    def probe(self, url, error=None):
        client = Mock(url=urlsplit(url))
        client.request.side_effect = error
        with redirect_stdout(io.StringIO()):
            contract.oversized_upload(client, {"Content-Type": "image/jpeg"})
        client.request.assert_called_once_with("POST", "/v1/sessions", b"", {
            "Content-Type": "image/jpeg", "Content-Length": str(24 * 1024 * 1024 + 1)}, 413)
        client.close.assert_called_once()

    def test_loopback_requires_json_413(self):
        for host in ("localhost", "LOCALHOST.", "test.localhost", "127.0.0.1", "127.2.3.4", "[::1]", "[::ffff:127.0.0.1]"):
            with self.subTest(host=host):
                self.probe("http://" + host)
                with self.assertRaises(http.client.RemoteDisconnected):
                    self.probe("http://" + host, http.client.RemoteDisconnected())

    def test_public_accepts_json_413_or_connection_closure(self):
        self.probe("https://rc-example.radeon.firstdg.ai")
        for error in (http.client.RemoteDisconnected(), ConnectionResetError(), BrokenPipeError(), ssl.SSLEOFError()):
            with self.subTest(error=type(error).__name__):
                self.probe("https://rc-example.radeon.firstdg.ai", error)

    def test_other_failures_stay_strict(self):
        for error in (TimeoutError(), AssertionError("Wrong status or invalid JSON"), ssl.SSLCertVerificationError()):
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(type(error)):
                    self.probe("https://rc-example.radeon.firstdg.ai", error)

    def test_delete_after_disconnect_constructs_a_fresh_connection(self):
        client = contract.Client("http://public.example")
        old = Mock()
        old.request.side_effect = http.client.RemoteDisconnected()
        client.connection = old
        response = Mock(status=200)
        response.read.return_value = b'{"ok":true}'
        response.getheader.return_value = None
        response.getheaders.return_value = [("Content-Type", "application/json")]
        new = Mock()
        new.getresponse.return_value = response
        with patch.object(http.client, "HTTPConnection", return_value=new) as connect, redirect_stdout(io.StringIO()):
            contract.oversized_upload(client, {})
            self.assertIsNone(client.connection)
            client.request("DELETE", "/v1/sessions/sample")
        old.close.assert_called_once()
        connect.assert_called_once()
        self.assertIs(client.connection, new)
        self.assertEqual(new.request.call_args.args[:2], ("DELETE", "/v1/sessions/sample"))


if __name__ == "__main__":
    unittest.main()
