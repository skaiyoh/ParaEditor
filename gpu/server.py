"""Noisy's memory-only Radeon analysis service; Python standard-library HTTP."""
import argparse
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import ipaddress
import json
import math
import re
import secrets
import socket
import threading
import time
from urllib.parse import parse_qs, urlsplit

MAX_BODY = 24 * 1024 * 1024
TTL = 30 * 60
MAX_LIFETIME = 2 * 60 * 60
QUEUE_SECONDS = 30
MAX_SESSIONS = 32


class Problem(Exception):
    def __init__(self, status, sentence):
        self.status, self.sentence = status, sentence


@dataclass
class Session:
    rgb: object
    depth: bytes
    predictor: object
    width: int
    height: int
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    lock: object = field(default_factory=threading.Lock)

    def expired(self, now):
        return now - self.touched >= TTL or now - self.created >= MAX_LIFETIME


class State:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.Lock()
        self.sessions = {}
        self.rates = {}
        self.pending = 0
        self.analyses = threading.BoundedSemaphore(2)

    def reap(self):
        now = time.monotonic()
        with self.lock:
            self.sessions = {k: v for k, v in self.sessions.items() if not v.expired(now)}
            self.rates = {k: v for k, v in self.rates.items() if v and now - v[-1] < 60}

    def get(self, sid, delete=False, touch=False):
        with self.lock:
            s = self.sessions.get(sid)
            now = time.monotonic()
            if s is None or s.expired(now):
                self.sessions.pop(sid, None)
                raise Problem(404, "This session does not exist or has expired.")
            if touch:
                s.touched = now
            if delete:
                del self.sessions[sid]
            return s

    @contextmanager
    def reserve(self, address):
        self.reap()
        with self.lock:
            now = time.monotonic()
            events = self.rates.setdefault(address, deque())
            while events and now - events[0] >= 60:
                events.popleft()
            if len(events) >= 10:
                raise Problem(429, "Please wait a minute before creating more sessions.")
            if len(self.sessions) + self.pending >= MAX_SESSIONS:
                raise Problem(503, "The service has no free session capacity; please try again.")
            events.append(now)
            self.pending += 1
        try:
            yield
        finally:
            with self.lock:
                self.pending -= 1

    @contextmanager
    def inference(self, session=None):
        deadline = time.monotonic() + QUEUE_SECONDS
        locked = False
        acquired = False
        try:
            if session is not None:
                locked = session.lock.acquire(timeout=QUEUE_SECONDS)
                if not locked:
                    raise Problem(503, "Analysis is busy; please try again.")
            acquired = self.analyses.acquire(timeout=max(0, deadline - time.monotonic()))
            if not acquired:
                raise Problem(503, "Analysis is busy; please try again.")
            yield
        finally:
            if acquired:
                self.analyses.release()
            if locked:
                session.lock.release()


def origin_allowed(origin):
    if origin in {"https://nathan.fish", "https://noisy-demo.pages.dev"}:
        return True
    if re.fullmatch(r"https://[a-zA-Z0-9-]+\.noisy-demo\.pages\.dev", origin):
        return True
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})", origin)
    return bool(match and 0 < int(match[1]) <= 65535)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, state):
        self.state = state
        self.requests = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)

    def process_request(self, request, address):
        request.settimeout(35)
        if not self.requests.acquire(blocking=False):
            body = b'{"error":"Analysis is busy; please try again."}'
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.requests.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.requests.release()

    def handle_error(self, request, address):
        # Never emit a traceback, body, URL, session id, or client address.
        print("HTTP connection failed.", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": "The HTTP request is malformed or unsupported."})

    def reply(self, status, body, content_type="application/json", headers=None):
        if isinstance(body, dict):
            body = json.dumps(body, allow_nan=False, separators=(",", ":")).encode()
        headers = dict(headers or {})
        request_headers = getattr(self, "headers", {})
        if len(body) > 1024 and "gzip" in request_headers.get("Accept-Encoding", "") and content_type != "image/png":
            body = gzip.compress(body, compresslevel=1, mtime=0)
            headers["Content-Encoding"] = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Vary", "Origin, Accept-Encoding")
        origin = request_headers.get("Origin", "")
        if origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Width, X-Height")
            self.send_header("Access-Control-Expose-Headers", "X-Width, X-Height, X-Guide-Width, X-Guide-Height, X-Scores")
        for name, value in headers.items():
            self.send_header(name, str(value))
        # No request bodies are retained by persistent origin connections.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def dimensions(self):
        try:
            w, h = int(self.headers["X-Width"]), int(self.headers["X-Height"])
        except (ValueError, TypeError):
            raise Problem(400, "X-Width and X-Height must state the master dimensions.")
        if min(w, h) < 2 or max(w, h) > 2048:
            raise Problem(400, "Master dimensions must be between 2 and 2048 pixels.")
        return w, h

    def body(self, limit=MAX_BODY):
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]) or self.headers.get("Transfer-Encoding"):
            raise Problem(400, "One Content-Length and no transfer encoding are required.")
        length = lengths[0].lstrip("0") or "0"
        if len(length) > 8:
            raise Problem(413, "The request body is too large.")
        n = int(length)
        if n > limit:
            raise Problem(413, "The request body is too large.")
        if self.headers.get("Content-Encoding", "identity") != "identity":
            raise Problem(400, "Compressed request bodies are not supported.")
        result = self.rfile.read(n)
        if len(result) != n:
            raise Problem(400, "The request body is incomplete.")
        return result

    def media(self, allowed):
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() not in allowed:
            raise Problem(400, "The request Content-Type is not supported.")

    def client(self):
        # The listener is loopback-only; the sole public ingress is cloudflared.
        value = self.headers.get("CF-Connecting-IP", self.client_address[0])
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            return self.client_address[0]

    def dispatch(self):
        path = urlsplit(self.path)
        state = self.server.state
        if self.command == "OPTIONS":
            return self.reply(204, b"")
        if path.path == "/v1/health" and self.command == "GET":
            return self.reply(200, {**state.engine.health(), "sessionLimits": {"idleSeconds": TTL, "maxLifetimeSeconds": MAX_LIFETIME}})
        if path.path == "/v1/sessions" and self.command == "POST":
            self.media({"image/jpeg", "image/png"})
            w, h = self.dimensions()
            with state.reserve(self.client()):
                data = self.body()
                rgb = state.engine.decode(data, w, h)
                del data
                with state.inference():
                    depth, predictor = state.engine.create(rgb)
                session = Session(rgb, depth, predictor, w, h)
                sid = secrets.token_urlsafe(24)
                with state.lock:
                    state.sessions[sid] = session
            return self.reply(201, {"id": sid, "master": {"width": w, "height": h},
                                    "expiresAt": datetime.fromtimestamp(time.time() + TTL, timezone.utc).isoformat()})
        match = re.fullmatch(r"/v1/sessions/([A-Za-z0-9_-]{1,128})(?:/(depth|taps|inpaint))?", path.path)
        if not match:
            raise Problem(404, "This endpoint does not exist.")
        sid, operation = match.groups()
        if operation is None and self.command == "DELETE":
            state.get(sid, delete=True)
            return self.reply(200, {"ok": True})
        session = state.get(sid)
        dims = {"X-Width": session.width, "X-Height": session.height}
        if operation == "depth" and self.command == "GET":
            state.get(sid, touch=True)
            return self.reply(200, session.depth, "application/octet-stream", dims)
        if operation == "taps" and self.command == "POST":
            self.media({"application/json"})
            try:
                value = json.loads(self.body(8192))
            except (ValueError, UnicodeError):
                raise Problem(400, "Tap points must be valid JSON.")
            points = value.get("points") if isinstance(value, dict) else None
            if not isinstance(points, list) or not 1 <= len(points) <= 8:
                raise Problem(400, "Supply between one and eight tap points.")
            for p in points:
                if not isinstance(p, dict) or p.get("label") not in ("include", "exclude"):
                    raise Problem(400, "Each tap must have an include or exclude label.")
                if any(type(p.get(k)) not in {int, float} or not 0 <= p[k] <= 1 or not math.isfinite(p[k]) for k in ("x", "y")):
                    raise Problem(400, "Tap coordinates must be finite frame fractions from zero to one.")
            with state.inference(session):
                state.get(sid, touch=True)
                masks, scores, w, h = state.engine.taps(session.predictor, points, session.width, session.height)
            return self.reply(200, masks, "application/octet-stream", {
                "X-Width": w, "X-Height": h, "X-Guide-Width": w, "X-Guide-Height": h,
                "X-Scores": ",".join(str(float(s)) for s in scores)})
        if operation == "inpaint" and self.command == "POST":
            self.media({"application/octet-stream"})
            if self.dimensions() != (session.width, session.height):
                raise Problem(400, "The mask dimensions must equal the master dimensions.")
            query = parse_qs(path.query, keep_blank_values=True)
            fill = query.get("fill", ["migan"])
            if len(fill) != 1 or fill[0] not in {"migan", "lama"}:
                raise Problem(400, "The fill must be migan or lama.")
            body = self.body()
            if len(body) != session.width * session.height:
                raise Problem(400, "The mask must contain one byte per master pixel.")
            with state.inference(session):
                state.get(sid, touch=True)
                plate = state.engine.inpaint(session.rgb, body, fill[0])
            return self.reply(200, plate, "image/png", dims)
        raise Problem(400, "This method is not supported for the endpoint.")

    def handle_request(self):
        try:
            self.dispatch()
        except Problem as error:
            self.reply(error.status, {"error": error.sentence})
        except (socket.timeout, TimeoutError):
            self.reply(400, {"error": "The request body did not arrive in time."})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            # Exception messages can contain user data; only the class is logged.
            print("Analysis failed:", type(error).__name__, flush=True)
            self.reply(503, {"error": "Analysis could not complete; please try again."})

    do_GET = do_POST = do_DELETE = do_OPTIONS = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--assets", default="/workspace")
    args = parser.parse_args()
    from models import Engine
    engine = Engine(args.assets, Problem)
    engine.warm()
    state = State(engine)
    server = Server(("127.0.0.1", args.port), state)
    def reap():
        while True:
            time.sleep(30)
            state.reap()
    threading.Thread(target=reap, daemon=True).start()
    print(json.dumps(engine.health()), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
