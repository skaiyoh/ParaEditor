"""Private GP0 orchestration: inherit the platform network environment without logging it."""
import os
from pathlib import Path

ALLOW = {"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PIP_INDEX_URL", "HF_ENDPOINT", "HF_HUB_DISABLE_XET"}
for item in Path("/proc/1/environ").read_bytes().split(b"\0"):
    key, sep, value = item.partition(b"=")
    if sep and key.decode() in ALLOW:
        os.environ[key.decode()] = value.decode()

import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path("/workspace/GP0")
PYTHON = "/opt/venv/bin/python"
WHEEL = "opencv_python_headless-4.13.0.92-cp37-abi3-manylinux_2_28_x86_64.whl"
WHEEL_SHA = "0bd48544f77c68b2941392fcdf9bcd2b9cdf00e98cb8c29b2455d194763cf99e"
WEIGHT = "depth_anything_v2_vits.pth"
WEIGHT_SHA = "715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378"
REVISION = "03876f8651c73a60fe4c2c48294e09fcb6838fcf"
MANIFEST_SHA = "bcd75d6e51d3b6129e9b3644794a7c3a432b48bb0f084064abda7eab40abf513"

def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")

def safe(message):
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "PIP_INDEX_URL", "HF_ENDPOINT"):
        value = os.environ.get(key)
        if value:
            message = message.replace(value, "[platform network setting]")
    return re.sub(r"https?://[^\s'\"<>]+", lambda match: "[host:" +
                  str(urllib.parse.urlsplit(match.group()).hostname) + "]", message)

def command(argv, env=None):
    result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(f"Command exit {result.returncode}: " + safe(result.stdout + result.stderr))
    return result.stdout

def versions(env):
    script = "import json,torch,numpy,torchvision,PIL; print(json.dumps({'torch':str(torch.__version__),'hip':torch.version.hip,'numpy':numpy.__version__,'torchvision':torchvision.__version__,'pillow':PIL.__version__,'paths':{m.__name__:m.__file__ for m in (torch,numpy,torchvision,PIL)}}))"
    return json.loads(command([PYTHON, "-c", script], env))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--collect", action="store_true")
    parser.add_argument("--out", default="outputs-final")
    args = parser.parse_args()
    os.environ.update(PYTHONPYCACHEPREFIX=str(ROOT / "pycache"),
                      PIP_CACHE_DIR=str(ROOT / "pip-cache"),
                      PIP_DISABLE_PIP_VERSION_CHECK="1", TMPDIR=str(ROOT / "pip-tmp"))
    (ROOT / "pip-tmp").mkdir(exist_ok=True)
    base_env = dict(os.environ)
    base_env.pop("PYTHONPATH", None)
    overlay = dict(base_env, PYTHONPATH="/workspace/pydeps")
    evidence = ROOT / "dependency-evidence-final"
    evidence.mkdir(exist_ok=True)
    if args.prepare:
        before = versions(base_env)
        freeze_before = command([PYTHON, "-m", "pip", "freeze"], base_env)
        save(evidence / "versions-before.json", before)
        (evidence / "venv-freeze-before.txt").write_text(freeze_before)
        wheel_dir = ROOT / "wheels"
        wheel_dir.mkdir(exist_ok=True)
        wheel = wheel_dir / WHEEL
        if wheel.exists() and digest(wheel) != WHEEL_SHA:
            wheel.rename(wheel.with_suffix(".whl.previous-partial"))
        if not wheel.exists():
            print("Downloading pinned wheel through host " + str(urllib.parse.urlsplit(os.environ["PIP_INDEX_URL"]).hostname), flush=True)
            command([PYTHON, "-m", "pip", "download", "--no-deps", "--only-binary=:all:",
                     "--dest", str(wheel_dir), "opencv-python-headless==4.13.0.92"], base_env)
        if digest(wheel) != WHEEL_SHA:
            raise RuntimeError("Downloaded wheel SHA-256 mismatch")
        print("Wheel SHA-256 verified against the full local wheel", flush=True)
        command([PYTHON, "-m", "pip", "install", "--no-deps", "--target", "/workspace/pydeps", str(wheel)], base_env)
        freeze_after = command([PYTHON, "-m", "pip", "freeze"], base_env)
        after = versions(overlay)
        save(evidence / "versions-after.json", after)
        (evidence / "venv-freeze-after.txt").write_text(freeze_after)
        if before != after:
            raise RuntimeError("Protected package versions or paths changed")
        if freeze_before != freeze_after:
            raise RuntimeError("Supplied /opt/venv pip freeze changed")
        protected = {"torch", "torchvision", "torchaudio", "numpy", "PIL"}
        if protected.intersection((p.name for p in Path('/workspace/pydeps').iterdir())):
            raise RuntimeError("Protected package shadow")
        cv2_info = json.loads(command([PYTHON, "-c", "import cv2,json; print(json.dumps({'version':cv2.__version__,'path':cv2.__file__}))"], overlay))
        distribution = next(importlib.metadata.distributions(path=["/workspace/pydeps"]))
        save(evidence / "package-record.json", {
            "status": "INSTALLED", "name": distribution.metadata["Name"], "version": distribution.version,
            "wheel": WHEEL, "wheel_tag": "cp37-abi3-manylinux_2_28_x86_64", "wheel_bytes": wheel.stat().st_size,
            "wheel_sha256": digest(wheel), "license": distribution.metadata.get("License"),
            "packaging_license": "MIT", "third_party_notices": "opencv_python_headless-4.13.0.92.dist-info/licenses/LICENSE-3RD-PARTY.txt",
            "cv2": cv2_info, "protected_versions_and_paths_unchanged": True, "venv_freeze_identical": True,
            "venv_freeze_sha256": digest(evidence / "venv-freeze-before.txt")})
        with tarfile.open(ROOT / "code-bundle.tar.gz") as archive:
            archive.extractall(ROOT, filter="data")
        if digest(ROOT / 'code-manifest.json') != MANIFEST_SHA:
            raise RuntimeError("Manifest pin mismatch")
        manifest = json.loads((ROOT / "code-manifest.json").read_text())
        code = ROOT / ("Depth-Anything-V2-" + manifest["code_commit"])
        for name, expected in manifest["files"].items():
            if digest(code / name) != expected:
                raise RuntimeError("Upstream source hash mismatch: " + name)
        print(f"Verified {len(manifest['files'])} imported upstream files", flush=True)
        weight = ROOT / WEIGHT
        if not weight.exists():
            endpoint = os.environ["HF_ENDPOINT"].rstrip("/")
            print("Fetching pinned checkpoint through host " + str(urllib.parse.urlsplit(endpoint).hostname), flush=True)
            url = endpoint + "/depth-anything/Depth-Anything-V2-Small/resolve/" + REVISION + "/" + WEIGHT
            partial = weight.with_suffix(".partial")
            with urllib.request.urlopen(url, timeout=60) as source, partial.open("wb") as target:
                shutil.copyfileobj(source, target)
            if digest(partial) != WEIGHT_SHA:
                raise RuntimeError("Checkpoint SHA-256 mismatch")
            partial.replace(weight)
        if digest(weight) != WEIGHT_SHA:
            raise RuntimeError("Checkpoint SHA-256 mismatch")
        print("Checkpoint SHA-256 verified; supplied package preservation PASS", flush=True)
    if args.collect:
        old_console = (ROOT / "runner-console-final.log").read_text()
        warnings = "\n".join(line for line in old_console.splitlines() if line.startswith("warning:"))
        console = (ROOT / args.out / "runner.log").read_text() + warnings + "\n"
        exit_code = 0 if json.loads((ROOT / args.out / "environment.json").read_text())["status"] == "PASS" else 1
    else:
        result = subprocess.run([PYTHON, str(ROOT / "gp0-smoke.py"), "--workspace", str(ROOT), "--out", args.out],
                                env=overlay, capture_output=True, text=True, timeout=240)
        console = safe(result.stdout + result.stderr)
        exit_code = result.returncode
    (ROOT / "runner-console-final.log").write_text(console)
    print(console, end="", flush=True)
    print(f"Runner exit: {exit_code}", flush=True)
    inventory = {}
    for path in sorted(ROOT.iterdir()):
        files = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file()]
        inventory[path.name] = {"files": len(files), "bytes": sum(p.stat().st_size for p in files)}
    pydeps = Path("/workspace/pydeps")
    pydeps_files = [p for p in pydeps.rglob("*") if p.is_file()]
    save(ROOT / "handoff-final.json", {
        "last_observed_utc": datetime.now(timezone.utc).isoformat(), "state": "SSH accessible, left running",
        "uid": os.getuid(), "hostname": __import__("socket").gethostname(), "workspace": str(ROOT),
        "inventory": inventory, "pydeps": {"files": len(pydeps_files), "bytes": sum(p.stat().st_size for p in pydeps_files)},
        "runner_exit": exit_code, "stop_or_destroy_performed": False})
    names = ["gp0-smoke.py", "remote-prepare.py", "code-manifest.json", "runner-console-final.log", "handoff-final.json"]
    names += [str(p.relative_to(ROOT)) for p in evidence.iterdir() if p.is_file()]
    names += [str(p.relative_to(ROOT)) for p in (ROOT / args.out).iterdir() if p.is_file()]
    manifest = {name: {"bytes": (ROOT / name).stat().st_size, "sha256": digest(ROOT / name)} for name in sorted(names)}
    save(ROOT / "copy-manifest-final.json", manifest)
    with tarfile.open(ROOT / "GP0-results.tar.gz", "w:gz") as archive:
        for name in sorted(names) + ["copy-manifest-final.json"]:
            archive.add(ROOT / name, arcname=name)
    print("Results bundle bytes:", (ROOT / "GP0-results.tar.gz").stat().st_size, "SHA-256:", digest(ROOT / "GP0-results.tar.gz"), flush=True)
    return exit_code

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("PREPARATION FAILED: " + safe(type(error).__name__ + ": " + str(error)), flush=True)
        sys.exit(1)
