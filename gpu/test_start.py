"""Connector lifecycle checks without touching provider state or loading models."""
import os
from contextlib import redirect_stdout
import hashlib
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import start


ACTIVE = "URL: https://rc-example.radeon.firstdg.ai\nStatus: active\nLocal port: 8789\nFRPC running: true\nFRPC PID: 12\n"


class NativeRestartTests(unittest.TestCase):
    def test_connector_environment_isolated(self):
        base = {name: "proxy-value" for name in start.PROXIES}
        base["UNRELATED"] = "kept"
        with patch.dict(os.environ, base, clear=True), patch.object(Path, "read_bytes", return_value=b"FRP_BROKER_URL=broker\0UNRELATED=not-imported\0"):
            env = start.connector_environment()
            self.assertEqual(env["FRP_BROKER_URL"], "broker")
            self.assertEqual(env["UNRELATED"], "kept")
            self.assertFalse(set(start.PROXIES) & env.keys())
            self.assertEqual(os.environ["HTTP_PROXY"], "proxy-value")

    def test_active_connector_preserves_hostname(self):
        with patch.object(start, "native_command", return_value=(0, ACTIVE)) as command:
            self.assertEqual(start.ensure_connector({}), ("https://rc-example.radeon.firstdg.ai", "preserved"))
            command.assert_called_once_with(["status"], {})

    def test_stopped_connector_allocates_new_hostname(self):
        with patch.object(start, "native_command", side_effect=[(1, "rc-tunnel: no active tunnel"), (0, "Tunnel starting: https://rc-new.radeon.firstdg.ai\n")]) as command:
            self.assertEqual(start.ensure_connector({}), ("https://rc-new.radeon.firstdg.ai", "allocated"))
            self.assertEqual(command.call_args_list[-1].args, (["expose", "--port", "8789"], {}))

    def test_dead_connector_uses_official_cleanup(self):
        with patch.object(start, "native_command", side_effect=[(0, ACTIVE.replace("running: true", "running: false")), (0, "stopped"), (0, "Tunnel starting: https://rc-new.radeon.firstdg.ai\n")]) as command:
            start.ensure_connector({})
            self.assertEqual(command.call_args_list[1].args, (["stop"], {}))

    def test_broker_revoked_but_local_process_running_uses_cleanup(self):
        stale = "Local FRPC is running with PID 9773, but the broker has no active tunnel.\nrc-tunnel: not_found: this Pod has no active tunnel\n"
        with patch.object(start, "native_command", side_effect=[(1, stale), (0, "stopped"), (0, "Tunnel starting: https://rc-new.radeon.firstdg.ai\n")]) as command:
            self.assertEqual(start.ensure_connector({}), ("https://rc-new.radeon.firstdg.ai", "allocated"))
            self.assertEqual([call.args[0] for call in command.call_args_list], [["status"], ["stop"], ["expose", "--port", "8789"]])

    def test_unrelated_connector_is_untouched(self):
        with patch.object(start, "native_command", return_value=(0, ACTIVE.replace("8789", "8080"))) as command:
            with self.assertRaisesRegex(RuntimeError, "another exposed port"):
                start.ensure_connector({})
            command.assert_called_once()

    def test_cli_failure_does_not_print_credentials(self):
        with patch.object(start, "native_command", return_value=(1, "token=secret")):
            with self.assertRaisesRegex(RuntimeError, "Unexpected native") as caught:
                start.ensure_connector({})
            self.assertNotIn("secret", str(caught.exception))

    def test_main_checks_only_local_health_and_records_public_url(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cli = root / "cli"
            cli.write_bytes(b"verified test CLI")
            output = io.StringIO()
            process = object()
            url = "https://rc-example.radeon.firstdg.ai"
            with patch.object(start, "ROOT", root), patch.object(start, "CLI", cli), \
                 patch.object(start, "CLI_SHA256", hashlib.sha256(cli.read_bytes()).hexdigest()), \
                 patch.object(start, "connector_environment", return_value={}), \
                 patch("prepare.network_environment"), patch("sys.argv", ["start.py"]), \
                 patch.object(start, "start_service", return_value=process), \
                 patch.object(start, "wait_health", return_value={"ok": True}) as health, \
                 patch.object(start, "ensure_connector", return_value=(url, "allocated")), \
                 redirect_stdout(output):
                start.main()
            health.assert_called_once_with(start.LOCAL_URL, 240, process)
            self.assertEqual((root / "public-url").read_text(), url + "\n")
            self.assertIn("Local health:", output.getvalue())
            self.assertIn("Public URL: " + url, output.getvalue())
            self.assertIn("NOISY_GPU_URL=" + url, output.getvalue())
            self.assertNotIn("Public health:", output.getvalue())


if __name__ == "__main__":
    unittest.main()
