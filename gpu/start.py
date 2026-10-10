"""Restart this deployment's service and tunnel, without exposing its token."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request


ROOT = Path("/workspace/gp2")


def alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        return state not in {"Z", "X"}
    except FileNotFoundError:
        return False


def start(name, command, env):
    pidfile = ROOT / (name + ".pid")
    if pidfile.exists():
        pid = int(pidfile.read_text())
        try:
            if alive(pid):
                cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
                if str(command[0]).encode() not in cmdline or not any(str(x).encode() in cmdline for x in command[1:2]):
                    raise RuntimeError("The saved PID belongs to a different process.")
                os.kill(pid, signal.SIGTERM)
                for _ in range(50):
                    if not alive(pid):
                        break
                    time.sleep(.1)
                else:
                    os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except FileNotFoundError:
            pass
    with (ROOT / (name + ".log")).open("ab") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   env=env, cwd=ROOT, start_new_session=True)
    pidfile.write_text(str(process.pid))
    return process


def main():
    from prepare import network_environment
    network_environment()
    ROOT.mkdir(exist_ok=True)
    with (ROOT / "start.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = dict(os.environ, PYTHONPATH="/workspace/pydeps", PYTHONPYCACHEPREFIX=str(ROOT / "pycache"),
                   PYTHONUNBUFFERED="1", OMP_NUM_THREADS="4")
        process = start("service", ["/opt/venv/bin/python", str(ROOT / "server.py")], env)
        for _ in range(240):
            if process.poll() is not None:
                raise RuntimeError("Service startup failed; inspect /workspace/gp2/service.log.")
            try:
                with urllib.request.urlopen("http://127.0.0.1:8789/v1/health", timeout=1) as response:
                    health = json.load(response)
                break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError("Models did not warm within 240 seconds.")
        command = [str(ROOT / "assets/cloudflared"), "tunnel", "--no-autoupdate", "--protocol", "http2"]
        tokenfile = ROOT / "tunnel.token"
        if tokenfile.exists():
            command += ["run", "--token-file", str(tokenfile)]
        else:
            command += ["--url", "http://127.0.0.1:8789"]
        start("tunnel", command, env)
        print(json.dumps(health))
        print("Service ready; tunnel started. Verify the public /v1/health endpoint.")


if __name__ == "__main__":
    main()
