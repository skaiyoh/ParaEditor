"""Restart the resident model service and its official Radeon native connector."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.request


ROOT = Path("/workspace/gp2")
CLI = Path("/root/.local/bin/rc-tunnel")
CLI_SHA256 = "3abb46533f717089dfc1a6e2a1bc9b314baf7e7aa5e24e2bcf403de2a7dc54c9"
LOCAL_URL = "http://127.0.0.1:8789"
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
PUBLIC_URL = re.compile(r"https://[a-z0-9-]+\.radeon\.firstdg\.ai(?=\s|$)")


def connector_environment():
    env = os.environ.copy()
    for entry in Path("/proc/1/environ").read_bytes().split(b"\0"):
        key, separator, value = entry.partition(b"=")
        if separator and key.startswith(b"FRP_"):
            env[key.decode()] = value.decode()
    for name in PROXIES:
        env.pop(name, None)
    return env


def alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        return state not in {"Z", "X"}
    except FileNotFoundError:
        return False


def start_service(env):
    command = ["/opt/venv/bin/python", str(ROOT / "server.py")]
    pidfile = ROOT / "service.pid"
    if pidfile.exists():
        pid = int(pidfile.read_text())
        try:
            if alive(pid):
                cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                if cmdline[:2] != [part.encode() for part in command]:
                    raise RuntimeError("The saved service PID belongs to a different process.")
                os.kill(pid, signal.SIGTERM)
                for _ in range(50):
                    if not alive(pid):
                        break
                    time.sleep(.1)
                else:
                    os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, FileNotFoundError):
            pass
    with (ROOT / "service.log").open("ab") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   env=env, cwd=ROOT, start_new_session=True)
    pidfile.write_text(str(process.pid))
    return process


def wait_health(url, seconds, process=None):
    # Local readiness bypasses the image's generic HTTP proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError("Service startup failed; inspect /workspace/gp2/service.log.")
        try:
            with opener.open(url + "/v1/health", timeout=min(5, max(.1, deadline - time.monotonic()))) as response:
                health = json.load(response)
            if health.get("ok") is True:
                return health
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Health did not become ready within {seconds} seconds: {url}/v1/health")


def native_command(args, env):
    result = subprocess.run([str(CLI), *args], env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=90, start_new_session=True)
    # Do not print arbitrary CLI diagnostics: credentials belong only to the provider's state.
    return result.returncode, result.stdout + result.stderr


def ensure_connector(env):
    code, output = native_command(["status"], env)
    match = PUBLIC_URL.search(output)
    if code == 0 and match and re.search(r"Local port:\s+8789\s", output):
        if re.search(r"Status:\s+active\s", output) and re.search(r"FRPC running:\s+true\s", output):
            return match.group(0), "preserved"
        code, _ = native_command(["stop"], env)
        if code != 0:
            raise RuntimeError("Native connector cleanup failed; inspect rc-tunnel status.")
    elif "no active tunnel" in output and re.search(r"Local FRPC is running with PID [0-9]+", output):
        # The broker can revoke a reservation while its local process remains alive.
        # Expose refuses that local state until the official CLI cleans it up.
        code, _ = native_command(["stop"], env)
        if code != 0:
            raise RuntimeError("Orphaned native connector cleanup failed; inspect rc-tunnel status.")
    elif "no active tunnel" not in output:
        raise RuntimeError("Unexpected native connector status or another exposed port; no connector was replaced.")
    code, output = native_command(["expose", "--port", "8789"], env)
    match = PUBLIC_URL.search(output)
    if code != 0 or match is None:
        raise RuntimeError("Native connector allocation failed; inspect rc-tunnel status with the connector environment.")
    return match.group(0), "allocated"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-service", action="store_true", help="Recover only the connector; keep resident models and sessions.")
    args = parser.parse_args()
    if hashlib.sha256(CLI.read_bytes()).hexdigest() != CLI_SHA256:
        raise RuntimeError("Expected the verified Radeon rc-tunnel 0.3.0 binary; install using the provider's mounted installer.")
    connector_env = connector_environment()
    from prepare import network_environment
    network_environment()
    ROOT.mkdir(exist_ok=True)
    with (ROOT / "start.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = dict(os.environ, PYTHONPATH="/workspace/pydeps", PYTHONPYCACHEPREFIX=str(ROOT / "pycache"),
                   PYTHONUNBUFFERED="1", OMP_NUM_THREADS="4")
        process = None if args.keep_service else start_service(env)
        health = wait_health(LOCAL_URL, 15 if args.keep_service else 240, process)
        print("Local health:", LOCAL_URL + "/v1/health", json.dumps(health), flush=True)
        url, action = ensure_connector(connector_env)
        previous = (ROOT / "public-url").read_text().strip() if (ROOT / "public-url").exists() else None
        (ROOT / "public-url").write_text(url + "\n")
        print("Public URL:", url, flush=True)
        print("Native connector:", action, flush=True)
        print("NOISY_GPU_URL=" + url, flush=True)
        if previous and previous != url:
            print("Public URL changed; update the app's gpu setting to this URL before its next export.", flush=True)


if __name__ == "__main__":
    main()
