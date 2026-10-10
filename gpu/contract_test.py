"""Exercise the public GPU contract from a client, keeping every photo in memory.

Usage: python gpu/contract_test.py https://gpu.nathan.fish
Requires Pillow (already present on the development Mac); no NumPy required.
"""
import argparse
from array import array
from concurrent.futures import ThreadPoolExecutor
import gzip
import http.client
import io
import json
import math
from pathlib import Path
import ssl
import sys
import time
from urllib.parse import urlsplit

from PIL import Image, ImageChops, ImageDraw


class Client:
    def __init__(self, url):
        self.url = urlsplit(url.rstrip("/"))
        if self.url.scheme not in {"http", "https"} or not self.url.hostname:
            raise ValueError("Supply an HTTP or HTTPS base URL.")
        self.connection = None

    def request(self, method, path, body=None, headers=None, status=200):
        # Keep TLS alive to Cloudflare as a browser does. The origin may close
        # its own connection independently of this client-to-edge connection.
        if self.connection is None:
            cls = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
            self.connection = cls(self.url.hostname, self.url.port, timeout=60)
        request_headers = {"Accept-Encoding": "gzip", "Origin": "https://nathan.fish", **(headers or {})}
        started = time.perf_counter()
        self.connection.request(method, self.url.path + path, body, request_headers)
        response = self.connection.getresponse()
        payload = response.read()
        elapsed = (time.perf_counter() - started) * 1000
        if response.getheader("Content-Encoding") == "gzip":
            payload = gzip.decompress(payload)
        response_headers = {k.lower(): v for k, v in response.getheaders()}
        assert response.status == status, (method, path.split("/")[-1], response.status,
                                           response_headers.get("content-type"), len(payload))
        if status >= 400:
            assert response_headers["content-type"].startswith("application/json")
            error = json.loads(payload)
            assert set(error) == {"error"} and isinstance(error["error"], str) and "\n" not in error["error"]
        return payload, response_headers, elapsed


def png(image):
    stream = io.BytesIO()
    image.save(stream, format="PNG", compress_level=1)
    return stream.getvalue()


def run(args):
    client = Client(args.url)
    timings = {}
    raw = args.photo.read_bytes()
    master = Image.open(io.BytesIO(raw)).convert("RGB")
    if args.long_edge:
        master.thumbnail((args.long_edge, args.long_edge))
        raw = png(master)
    w, h = master.size
    headers = {"Content-Type": "image/png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg", "X-Width": str(w), "X-Height": str(h)}
    payload, _, timings["health_ms"] = client.request("GET", "/v1/health")
    health = json.loads(payload)
    assert health["ok"] is True and "Radeon" in health["gpu"]
    assert set(health["models"]) == {"depth", "segment", "inpaint"}
    assert all(isinstance(x, str) and x for x in health["models"].values())
    print("PASS health", json.dumps(health), flush=True)
    for origin in ["https://nathan.fish", "https://noisy-demo.pages.dev", "https://branch.noisy-demo.pages.dev", "http://127.0.0.1:8790"]:
        _, cors, _ = client.request("OPTIONS", "/v1/sessions", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-width,x-height"}, status=204)
        assert cors["access-control-allow-origin"] == origin
        assert {x.strip().lower() for x in cors["access-control-allow-headers"].split(",")} == {"content-type", "x-width", "x-height"}
        assert {x.strip() for x in cors["access-control-allow-methods"].split(",")} == {"GET", "POST", "DELETE"}
    for origin in ["https://evil.example", "https://noisy-demo.pages.dev.evil.example", "http://127.0.0.1:99999"]:
        _, cors, _ = client.request("GET", "/v1/health", headers={"Origin": origin})
        assert "access-control-allow-origin" not in cors
    print("PASS allowed and rejected CORS origins", flush=True)

    payload, _, timings["session_ms"] = client.request("POST", "/v1/sessions", raw, headers, 201)
    session = json.loads(payload)
    assert session["master"] == {"width": w, "height": h} and isinstance(session["expiresAt"], str)
    path = "/v1/sessions/" + session["id"]
    payload, dims, timings["depth_ms"] = client.request("GET", path + "/depth")
    assert dims["content-type"] == "application/octet-stream"
    assert (int(dims["x-width"]), int(dims["x-height"])) == (w, h)
    assert len(payload) == w * h * 4
    depth = array("f")
    depth.frombytes(payload)
    if sys.byteorder != "little":
        depth.byteswap()
    assert all(math.isfinite(v) and 0 <= v <= 1 for v in depth)
    assert min(depth) < .001 and max(depth) > .999
    print("PASS session and master-sized little-endian f32 inverse depth", w, h, flush=True)

    points = json.dumps({"points": [{"x": .5, "y": .5, "label": "include"}]}).encode()
    tap_headers = {"Content-Type": "application/json"}
    masks, dims, timings["tap_first_ms"] = client.request("POST", path + "/taps", points, tap_headers)
    gw, gh = int(dims["x-guide-width"]), int(dims["x-guide-height"])
    assert (gw, gh) == (max(1, math.floor(w * 1024 / max(w, h) + .5)), max(1, math.floor(h * 1024 / max(w, h) + .5)))
    assert len(masks) == 3 * gw * gh and dims["content-type"] == "application/octet-stream"
    scores = [float(v) for v in dims["x-scores"].split(",")]
    assert len(scores) == 3 and all(math.isfinite(v) for v in scores)
    assert any(0 < v < 255 for v in masks) and any(v >= 128 for v in masks)
    warm = []
    for _ in range(3):
        repeated, rh, elapsed = client.request("POST", path + "/taps", points, tap_headers)
        assert repeated == masks and rh["x-scores"] == dims["x-scores"]
        warm.append(round(elapsed, 3))
    timings["tap_warm_ms"] = warm
    print("PASS three soft u8 multimask candidates, finite scores, deterministic repeats", flush=True)

    hole = Image.new("L", (w, h))
    ImageDraw.Draw(hole).rectangle((w//3, h//3, w//2, h//2), fill=255)
    mask_headers = {"Content-Type": "application/octet-stream", "X-Width": str(w), "X-Height": str(h)}
    for fill in ["migan", "lama"]:
        suffix = "" if fill == "migan" else "?fill=lama"
        plate_bytes, ph, timings[fill + "_ms"] = client.request("POST", path + "/inpaint" + suffix, hole.tobytes(), mask_headers)
        assert ph["content-type"] == "image/png"
        plate = Image.open(io.BytesIO(plate_bytes))
        assert plate.format == "PNG" and plate.mode == "RGB" and plate.size == (w, h)
        diff = ImageChops.difference(plate, master)
        assert diff.getbbox() is not None, fill + " did not fill any pixel"
        outside = Image.composite(Image.new("RGB", (w, h)), diff, hole)
        assert outside.getbbox() is None, fill + " changed pixels outside the hole"
        print("PASS", fill, "RGB PNG and byte-exact outside-hole master", flush=True)
    empty, _, _ = client.request("POST", path + "/inpaint", bytes(w * h), mask_headers)
    assert Image.open(io.BytesIO(empty)).tobytes() == master.tobytes()
    print("PASS empty mask returns the master", flush=True)

    # A second client/session and concurrent taps exercise independent embeddings.
    other_client = Client(args.url)
    mirrored = master.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    other_raw = png(mirrored)
    other_payload, _, timings["second_device_session_ms"] = other_client.request("POST", "/v1/sessions", other_raw, {**headers, "Content-Type": "image/png"}, 201)
    other_path = "/v1/sessions/" + json.loads(other_payload)["id"]
    other_baseline, other_dims, _ = other_client.request("POST", other_path + "/taps", points, tap_headers)
    with ThreadPoolExecutor(2) as pool:
        a = pool.submit(client.request, "POST", path + "/taps", points, tap_headers)
        b = pool.submit(other_client.request, "POST", other_path + "/taps", points, tap_headers)
        same, sh, _ = a.result()
        other, oh, _ = b.result()
    assert same == masks and sh["x-scores"] == dims["x-scores"]
    assert other == other_baseline and oh["x-scores"] == other_dims["x-scores"]
    with ThreadPoolExecutor(2) as pool:
        fills = [pool.submit(c.request, "POST", p + "/inpaint?fill=lama", hole.tobytes(), mask_headers)
                 for c, p in [(client, path), (other_client, other_path)]]
        for future, expected in zip(fills, [master, mirrored]):
            body, _, _ = future.result()
            difference = ImageChops.difference(Image.open(io.BytesIO(body)), expected)
            assert Image.composite(Image.new("RGB", (w, h)), difference, hole).getbbox() is None
    # A newly opened connection is the service boundary of a page reload.
    reloaded = Client(args.url)
    same, _, _ = reloaded.request("POST", path + "/taps", points, tap_headers)
    assert same == masks
    print("PASS concurrent devices and retained session through a new client connection", flush=True)
    mixed = json.dumps({"points": [{"x": .5, "y": .5, "label": "include"}] +
                                    [{"x": .1, "y": .1, "label": "exclude"}] * 7}).encode()
    more, _, _ = client.request("POST", path + "/taps", mixed, tap_headers)
    assert len(more) == len(masks)
    print("PASS eight points with include and exclude labels", flush=True)

    malformed = [{}, {"points": []}, {"points": [{}]}, {"points": [{"x": True, "y": .5, "label": "include"}]},
                 {"points": [{"x": 10**400, "y": .5, "label": "include"}]},
                 {"points": [{"x": .5, "y": .5, "label": []}]},
                 {"points": [{"x": float("nan"), "y": .5, "label": "include"}]},
                 {"points": [{"x": .5, "y": .5, "label": "include"}] * 9}]
    for value in malformed:
        client.request("POST", path + "/taps", json.dumps(value).encode(), tap_headers, 400)
    client.request("POST", path + "/taps", b"{", tap_headers, 400)
    client.request("POST", path + "/taps", b"x" * 8193, tap_headers, 413)
    client.request("POST", path + "/inpaint", b"x", mask_headers, 400)
    client.request("POST", path + "/inpaint?fill=unknown", b"", mask_headers, 400)
    client.request("POST", path + "/inpaint", b"", {**mask_headers, "X-Width": "1"}, 400)
    client.request("POST", "/v1/sessions", b"not a photo", headers, 400)
    client.request("POST", "/v1/sessions", raw, {**headers, "X-Width": str(w-1)}, 400)
    client.request("POST", "/v1/sessions", b"", {**headers, "X-Width": "2049"}, 400)
    # The service must reject before reading an oversized photo body.
    client.request("POST", "/v1/sessions", b"", {**headers, "Content-Length": str(24 * 1024 * 1024 + 1)}, 413)
    print("PASS malformed inputs (400) and oversized bodies (413)", flush=True)
    for c, p in [(client, path), (other_client, other_path)]:
        result, _, _ = c.request("DELETE", p)
        assert json.loads(result) == {"ok": True}
        c.request("GET", p + "/depth", status=404)
        c.request("POST", p + "/taps", points, tap_headers, 404)
        c.request("POST", p + "/inpaint", b"", mask_headers, 404)
        c.request("DELETE", p, status=404)
    print("PASS deletes and subsequent 404s", flush=True)
    print("TIMINGS", json.dumps(timings, sort_keys=True), flush=True)
    limits = {"session_under_2000ms": timings["session_ms"] < 2000,
              "every_warm_tap_under_300ms": all(t < 300 for t in warm)}
    print("TIMING LIMITS", json.dumps(limits), flush=True)
    if args.require_timings:
        assert all(limits.values()), "Tunnel timing limits were not met."
    print("PASS all endpoint contract checks", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--photo", type=Path, default=Path(__file__).resolve().parents[1] / "src/assets/sample.jpg")
    parser.add_argument("--long-edge", type=int)
    parser.add_argument("--require-timings", action="store_true")
    run(parser.parse_args())
