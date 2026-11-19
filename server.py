#!/usr/bin/env python3
"""Paydown server — serves the web UI and stores data on this machine.

Standard library only (Python 3.9+).

    python3 server.py passwd                 # set the login password (first run)
    python3 server.py                        # serve on 0.0.0.0:8787
    python3 server.py --host 127.0.0.1 --port 9000 --data-dir ./data

Settings can also come from the environment: PAYDOWN_HOST, PAYDOWN_PORT, PAYDOWN_DATA_DIR.
The data directory holds:
    data.json      all accounts, transactions and document metadata
    auth.json      password hash + session signing key (mode 600)
    files/         uploaded PDFs (loan agreements, monthly statements)
    trash/         deleted PDFs, kept 30 days
    backups/       one snapshot of data.json per day, last 30 kept
The data directory must be outside the app's git checkout (or the git-ignored ./data).
"""
import argparse
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
from datetime import date
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC = {  # URL path -> (file, content type). Only these files are ever served.
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/login": ("login.html", "text/html; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
}
PUBLIC = {"/login", "/icon.svg", "/manifest.webmanifest", "/healthz", "/api/login"}
COOKIE = "paydown_session"
SESSION_DAYS = 30
PBKDF2_ITERS = 600_000
BACKUPS_KEPT = 30
FILE_MAX = 25 * 1024 * 1024  # bytes per PDF
FILE_ID = re.compile(r"^[0-9a-f]{32}$")
TRASH_DAYS = 30

LOCK = threading.Lock()
DATA_DIR = ""
FAILS = {}  # client -> [failure timestamps]


def p(name):
    return os.path.join(DATA_DIR, name)


# ---------- auth ----------
def hash_password(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    return salt.hex(), hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITERS).hex()


def load_auth():
    try:
        with open(p("auth.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def set_password(pw):
    salt, h = hash_password(pw)
    # A new signing secret logs out every existing session.
    data = {"salt": salt, "hash": h, "iters": PBKDF2_ITERS, "secret": secrets.token_hex(32)}
    tmp = p(".auth.json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, p("auth.json"))
    return data


def check_password(pw, auth):
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(auth["salt"]), auth.get("iters", PBKDF2_ITERS)).hex()
    return hmac.compare_digest(h, auth["hash"])


def make_token(auth):
    payload = f"{int(time.time()) + SESSION_DAYS * 86400}.{secrets.token_hex(12)}"
    sig = hmac.new(bytes.fromhex(auth["secret"]), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def valid_token(token, auth):
    try:
        exp, nonce, sig = token.split(".")
        good = hmac.new(bytes.fromhex(auth["secret"]), f"{exp}.{nonce}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except (ValueError, AttributeError, KeyError):
        return False


def throttled(client):
    """Allow 5 failed logins per 10 minutes per client."""
    now = time.time()
    FAILS[client] = [t for t in FAILS.get(client, []) if now - t < 600]
    return len(FAILS[client]) >= 5


# ---------- data ----------
def read_data():
    try:
        with open(p("data.json"), "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return None, None
    return raw, hashlib.sha256(raw).hexdigest()[:20]


def backup_today():
    """Snapshot data.json once per day. Returns True when a new snapshot was made."""
    if not os.path.exists(p("data.json")):
        return False
    bdir = p("backups")
    os.makedirs(bdir, exist_ok=True)
    target = os.path.join(bdir, f"data-{date.today().isoformat()}.json")
    if os.path.exists(target):
        return False
    shutil.copy2(p("data.json"), target)
    old = sorted(f for f in os.listdir(bdir) if f.startswith("data-") and f.endswith(".json"))
    for f in old[:-BACKUPS_KEPT]:
        os.remove(os.path.join(bdir, f))
    return True


def write_data(raw):
    if backup_today():  # snapshot of the previous state, once per day
        tidy_files()
    tmp = p(".data.json.tmp")
    with open(tmp, "wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p("data.json"))


# ---------- uploaded files ----------
def file_path(fid):
    return os.path.join(p("files"), fid + ".pdf")


def trash_file(fid):
    src = file_path(fid)
    if not os.path.exists(src):
        return False
    os.makedirs(p("trash"), exist_ok=True)
    dst = os.path.join(p("trash"), fid + ".pdf")
    os.replace(src, dst)
    os.utime(dst)  # mtime = deletion time, for the 30-day purge
    return True


def tidy_files():
    """Purge old trash, and move PDFs that no document references (e.g. an upload whose
    account was never saved) to the trash once they are a day old."""
    now = time.time()
    tdir = p("trash")
    if os.path.isdir(tdir):
        for f in os.listdir(tdir):
            fp = os.path.join(tdir, f)
            if now - os.path.getmtime(fp) > TRASH_DAYS * 86400:
                os.remove(fp)
    fdir = p("files")
    raw, _ = read_data()
    if not os.path.isdir(fdir) or raw is None:
        return
    try:
        refs = {d.get("id") for d in json.loads(raw).get("documents", [])}
    except (ValueError, AttributeError):
        return
    for f in os.listdir(fdir):
        fid = f[:-4]
        if f.endswith(".pdf") and FILE_ID.match(fid) and fid not in refs and now - os.path.getmtime(os.path.join(fdir, f)) > 86400:
            trash_file(fid)
        elif f.startswith(".upload-") and now - os.path.getmtime(os.path.join(fdir, f)) > 3600:
            os.remove(os.path.join(fdir, f))  # interrupted upload


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "Paydown"
    sys_version = ""

    def log_message(self, fmt, *args):
        if not (self.path.startswith("/api/version") or self.path == "/healthz"):
            sys.stderr.write("%s %s\n" % (self.client(), fmt % args))

    def client(self):
        return self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]

    def is_https(self):
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def send(self, status, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def redirect(self, to):
        self.send(302, b"", "text/plain", {"Location": to})

    def cookie(self, token, max_age):
        attrs = f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        return attrs + ("; Secure" if self.is_https() else "")

    def authed(self):
        auth = load_auth()
        if not auth:
            return False
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return COOKIE in c and valid_token(c[COOKIE].value, auth)

    def body_json(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ValueError("expected JSON")  # also forces a CORS preflight for cross-site requests
        n = int(self.headers.get("Content-Length", 0))
        if n > 20 * 1024 * 1024:
            raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def gate(self, path):
        """Return True if the request may proceed; otherwise respond and return False."""
        if path in PUBLIC or self.authed():
            return True
        if path.startswith("/api/"):
            self.send(401, {"error": "login required"})
        else:
            self.redirect("login")
        return False

    def do_HEAD(self):
        self.do_GET()

    def file_id(self, path):
        fid = path[len("/api/files/"):] if path.startswith("/api/files/") else ""
        return fid if FILE_ID.match(fid) else None

    def upload(self):
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/pdf":
            return self.send(415, {"error": "Only PDF files can be uploaded"})
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send(411, {"error": "Content-Length required"})
        if n <= 0 or n > FILE_MAX:
            self.close_connection = True  # don't read an oversized body
            return self.send(413, {"error": f"PDF must be {FILE_MAX // (1024 * 1024)} MB or smaller"})
        os.makedirs(p("files"), exist_ok=True)
        fid = secrets.token_hex(16)
        tmp = os.path.join(p("files"), f".upload-{fid}")
        head, left = b"", n
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                while left:
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    if len(head) < 1024:
                        head += chunk[:1024 - len(head)]
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                raise ValueError("Upload was interrupted")
            if b"%PDF-" not in head:
                raise ValueError("That file is not a PDF")
            os.replace(tmp, file_path(fid))
        except ValueError as e:
            os.path.exists(tmp) and os.remove(tmp)
            return self.send(400, {"error": str(e)})
        return self.send(201, {"id": fid, "size": n})

    def download(self, fid):
        try:
            with open(file_path(fid), "rb") as f:
                body = f.read()
        except OSError:
            return self.send(404, {"error": "file not found"})
        name = parse_qs(urlsplit(self.path).query).get("name", ["document.pdf"])[0]
        name = re.sub(r"[\x00-\x1f\\/\"]", "_", name)[:150] or "document.pdf"
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        self.send(200, body, "application/pdf", {"Content-Disposition": f"inline; filename*=UTF-8''{quote(name)}"})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        if not self.gate(path):
            return
        fid = self.file_id(path)
        if not fid:
            return self.send(404, {"error": "not found"})
        with LOCK:
            found = trash_file(fid)
        self.send(200 if found else 404, {"ok": found})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz":
            return self.send(200, "ok", "text/plain")
        if not self.gate(path):
            return
        if path == "/login" and self.authed():
            return self.redirect("./")
        if path == "/api/version":
            with LOCK:
                _, etag = read_data()
            return self.send(200, {"etag": etag})
        if path == "/api/data":
            with LOCK:
                raw, etag = read_data()
            try:
                data = json.loads(raw) if raw else None
            except ValueError:
                return self.send(500, {"error": "data.json is not valid JSON"})
            return self.send(200, {"exists": raw is not None, "data": data, "etag": etag})
        if self.file_id(path):
            return self.download(self.file_id(path))
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                with open(os.path.join(APP_DIR, name), "rb") as f:
                    return self.send(200, f.read(), ctype)
            except OSError:
                pass
        self.send(404, "Not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self.gate(path):
            return
        if path == "/api/files":
            return self.upload()
        try:
            body = self.body_json()
        except ValueError as e:
            return self.send(400, {"error": str(e)})

        if path == "/api/login":
            auth, who = load_auth(), self.client()
            if not auth:
                return self.send(503, {"error": "No password set. Run: paydown passwd"})
            if throttled(who):
                return self.send(429, {"error": "Too many attempts. Try again in a few minutes."})
            if not check_password(str(body.get("password", "")), auth):
                FAILS.setdefault(who, []).append(time.time())
                time.sleep(0.5)
                return self.send(401, {"error": "Incorrect password"})
            FAILS.pop(who, None)
            return self.send(200, {"ok": True}, headers={"Set-Cookie": self.cookie(make_token(auth), SESSION_DAYS * 86400)})

        if path == "/api/logout":
            return self.send(200, {"ok": True}, headers={"Set-Cookie": self.cookie("", 0)})

        if path == "/api/password":
            auth = load_auth()
            if not check_password(str(body.get("current", "")), auth):
                return self.send(401, {"error": "Current password is incorrect"})
            new = str(body.get("new", ""))
            if len(new) < 8:
                return self.send(400, {"error": "New password must be at least 8 characters"})
            with LOCK:
                auth = set_password(new)
            return self.send(200, {"ok": True}, headers={"Set-Cookie": self.cookie(make_token(auth), SESSION_DAYS * 86400)})

        self.send(404, {"error": "not found"})

    def do_PUT(self):
        path = self.path.split("?")[0]
        if not self.gate(path):
            return
        if path != "/api/data":
            return self.send(404, {"error": "not found"})
        try:
            body = self.body_json()
            data = body["data"]
            if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
                raise ValueError("bad data")
        except (ValueError, KeyError, TypeError) as e:
            return self.send(400, {"error": str(e)})
        with LOCK:
            raw, etag = read_data()
            if etag != body.get("ifMatch"):
                # Changed by another device since this client last loaded it: client merges and retries.
                return self.send(409, {"conflict": True, "data": json.loads(raw) if raw else None, "etag": etag})
            write_data(json.dumps(data, indent=1, ensure_ascii=False).encode())
            _, new_etag = read_data()
        self.send(200, {"etag": new_etag})


def main():
    global DATA_DIR
    ap = argparse.ArgumentParser(description="Paydown server")
    ap.add_argument("command", nargs="?", default="serve", choices=["serve", "passwd"],
                    help="serve (default) or passwd to set the login password")
    ap.add_argument("--host", default=os.environ.get("PAYDOWN_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PAYDOWN_PORT", "8787")))
    ap.add_argument("--data-dir", default=os.environ.get("PAYDOWN_DATA_DIR", os.path.join(APP_DIR, "data")))
    ap.add_argument("--stdin", action="store_true", help="passwd: read the password from stdin")
    args = ap.parse_args()
    DATA_DIR = os.path.realpath(args.data_dir)
    # Keep private data out of the git checkout: only the git-ignored ./data is allowed inside it.
    app = os.path.realpath(APP_DIR)
    if os.path.commonpath([DATA_DIR, app]) == app and DATA_DIR != os.path.join(app, "data"):
        sys.exit(f"Refusing to store data in {DATA_DIR}: it is inside the app folder and could be committed "
                 f"to git. Use a directory outside {app} (or {os.path.join(app, 'data')}).")
    os.makedirs(DATA_DIR, exist_ok=True)

    if args.command == "passwd":
        if args.stdin:
            pw = sys.stdin.readline().rstrip("\n")
        else:
            pw = getpass.getpass("New password: ")
            if pw != getpass.getpass("Repeat password: "):
                sys.exit("Passwords do not match.")
        if len(pw) < 8:
            sys.exit("Password must be at least 8 characters.")
        set_password(pw)
        print("Password set. Existing sessions have been logged out.")
        return

    if not load_auth():
        print("WARNING: no password set yet — run `python3 server.py passwd` (or `paydown passwd`).", file=sys.stderr)
    tidy_files()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"Paydown listening on http://{args.host}:{args.port}/  (data: {DATA_DIR})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
