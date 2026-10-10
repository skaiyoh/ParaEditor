"""Fetch only GP2's pinned public assets; preserve the supplied ROCm environment."""
import hashlib
import os
from pathlib import Path
import urllib.request


def network_environment():
    allowed = {"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PIP_INDEX_URL", "HF_ENDPOINT", "HF_HUB_DISABLE_XET"}
    for entry in Path("/proc/1/environ").read_bytes().split(b"\0"):
        key, _, value = entry.partition(b"=")
        if key.decode(errors="ignore") in allowed:
            os.environ[key.decode()] = value.decode()


ASSETS = [
    ("migan_inference.py", "https://raw.githubusercontent.com/Picsart-AI-Research/MI-GAN/2b793c5ece43f4253e32d4afc257120a5deed6f5/lib/model_zoo/migan_inference.py", "1e35a181e516742ae32af935848e6a9a4382f528ea7096db6658f14cd8b9ace0"),
    ("migan_512_places2.pt", "https://huggingface.co/vietnqai/Face-Service/resolve/cb1ff9ab23e7f15c332bd09461d1176fd2515b50/remove_object/removal/models/migan_512_places2.pt", "1d6087eee0aac8923ad2606be5d8caeb4824d3e4de331995e420c74e124a466a"),
    ("cloudflared", "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64", "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db"),
]


def main():
    network_environment()
    root = Path("/workspace/gp2/assets")
    root.mkdir(parents=True, exist_ok=True)
    for name, url, expected in ASSETS:
        path = root / name
        if not path.exists():
            if url.startswith("https://huggingface.co/"):
                url = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/") + url[len("https://huggingface.co"):]
            temp = path.with_suffix(path.suffix + ".partial")
            try:
                with urllib.request.urlopen(url, timeout=90) as response, temp.open("wb") as out:
                    while block := response.read(1024 * 1024):
                        out.write(block)
                with temp.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                        raise RuntimeError("Downloaded asset hash mismatch: " + name)
                temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise RuntimeError("Cached asset hash mismatch: " + name)
        if name == "cloudflared":
            path.chmod(0o755)
        print("Verified", name, path.stat().st_size, expected, flush=True)


if __name__ == "__main__":
    main()
