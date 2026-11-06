"""Background daemon management.

One daemon per user (plus an optional separate demo daemon) owns the iCloud
session. The desktop shell and the ``icd`` CLI both talk to it over
``http://127.0.0.1:<port>`` using a per-user secret token, so the session is
shared and never logged in twice.

State files in DATA_DIR:
    token             secret shared by GUI/CLI (created once)
    daemon.json       {"pid", "port", "url", "demo", "version", "started"}
    daemon-demo.json  same for the demo daemon
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import __version__
from .config import DATA_DIR, LOG_DIR

DEFAULT_PORT = 48848
DEMO_PORT = 48858
DEFAULT_IDLE_MINUTES = 240

TOKEN_FILE = DATA_DIR / "token"


def state_file(demo: bool) -> Path:
    return DATA_DIR / ("daemon-demo.json" if demo else "daemon.json")


def get_token() -> str:
    try:
        tok = TOKEN_FILE.read_text("utf-8").strip()
        if len(tok) >= 32:
            return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(tok, "utf-8")
    return tok


def _read_state(demo: bool) -> dict[str, Any] | None:
    try:
        return json.loads(state_file(demo).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def ping(port: int, timeout: float = 1.5) -> dict[str, Any] | None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/ping",
        headers={"Authorization": f"Bearer {get_token()}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if data.get("app") == "icloud-desk" else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def describe(st: dict[str, Any]) -> dict[str, Any]:
    tok = get_token()
    url = f"http://127.0.0.1:{st['port']}/"
    return {
        "pid": st.get("pid"),
        "port": st["port"],
        "url": url,
        "ui_url": f"{url}?token={tok}",
        "token": tok,
        "demo": bool(st.get("demo")),
        "version": st.get("version"),
        "started": st.get("started"),
    }


def running(demo: bool = False) -> dict[str, Any] | None:
    st = _read_state(demo)
    if not st or not st.get("port"):
        return None
    info = ping(int(st["port"]))
    if not info or bool(info.get("demo")) != demo:
        return None
    return st


def _spawn_args(demo: bool) -> list[str]:
    if getattr(sys, "frozen", False):
        args = [sys.executable, "serve"]
    else:
        root = Path(__file__).resolve().parent.parent
        exe = Path(sys.executable)
        pyw = exe.with_name("pythonw.exe")
        args = [str(pyw if pyw.exists() else exe), str(root / "icd.py"), "serve"]
    if demo:
        args.append("--demo")
    return args


def _spawn(demo: bool) -> None:
    args = _spawn_args(demo)
    base = 0
    if os.name == "nt":
        base = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    kwargs: dict[str, Any] = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        cwd=str(DATA_DIR),
    )
    if os.name == "nt":
        try:
            subprocess.Popen(args, creationflags=base | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kwargs)
            return
        except OSError:
            pass
        subprocess.Popen(args, creationflags=base, **kwargs)
    else:
        subprocess.Popen(args, start_new_session=True, **kwargs)


def ensure(demo: bool = False, timeout: float = 45) -> dict[str, Any]:
    st = running(demo)
    if st:
        return describe(st)
    _spawn(demo)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.25)
        st = running(demo)
        if st:
            return describe(st)
    raise RuntimeError(f"后台服务启动超时，请查看日志：{LOG_DIR / 'daemon.log'}")


def stop(demo: bool = False, timeout: float = 10) -> bool:
    st = _read_state(demo)
    if not st or not st.get("port"):
        return False
    req = urllib.request.Request(
        f"http://127.0.0.1:{st['port']}/api/daemon/shutdown",
        method="POST",
        headers={"Authorization": f"Bearer {get_token()}"},
    )
    try:
        urllib.request.urlopen(req, timeout=3).close()
    except (OSError, urllib.error.URLError):
        pass
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not ping(int(st["port"]), timeout=0.5):
            break
        time.sleep(0.2)
    pid = st.get("pid")
    if pid and ping(int(st["port"]), timeout=0.5):
        try:
            os.kill(int(pid), 9)
        except OSError:
            pass
    try:
        state_file(demo).unlink()
    except OSError:
        pass
    return True


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int) -> int:
    if _port_free(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _setup_logging(demo: bool, debug: bool) -> None:
    handler = logging.handlers.RotatingFileHandler(
        LOG_DIR / ("daemon-demo.log" if demo else "daemon.log"), maxBytes=2_000_000, backupCount=2, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    if sys.stderr is not None and sys.stderr.isatty():
        root.addHandler(logging.StreamHandler())
    root.setLevel(logging.DEBUG if debug else logging.INFO)


def serve(port: int | None = None, demo: bool = False, idle_minutes: float | None = None, debug: bool = False) -> None:
    """Run the API server in the foreground (this *is* the daemon process)."""
    if demo:
        os.environ["ICLOUD_DESK_DEMO"] = "1"
    _setup_logging(demo, debug)
    log = logging.getLogger("icloud-desk.daemon")

    existing = running(demo)
    if existing:
        log.info("daemon already running on port %s", existing["port"])
        print(json.dumps(describe(existing)))
        return

    import uvicorn

    from .server import app, activity

    if idle_minutes is None:
        idle_minutes = float(os.environ.get("ICLOUD_DESK_IDLE_MINUTES", DEFAULT_IDLE_MINUTES))
    port = _pick_port(port or (DEMO_PORT if demo else DEFAULT_PORT))
    get_token()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="debug" if debug else "warning", log_config=None)
    server = uvicorn.Server(config)
    app.state.shutdown = lambda: setattr(server, "should_exit", True)

    st = {"pid": os.getpid(), "port": port, "demo": demo, "version": __version__, "started": time.time()}
    sf = state_file(demo)

    def _publish() -> None:
        for _ in range(200):
            if server.started:
                sf.write_text(json.dumps(st), "utf-8")
                log.info("daemon listening on http://127.0.0.1:%s (pid %s, demo=%s)", port, os.getpid(), demo)
                return
            time.sleep(0.05)

    def _idle_watch() -> None:
        while not server.should_exit:
            time.sleep(30)
            if idle_minutes and idle_minutes > 0 and activity.idle_seconds() > idle_minutes * 60:
                log.info("idle for %.0f min, exiting", idle_minutes)
                server.should_exit = True

    threading.Thread(target=_publish, daemon=True).start()
    threading.Thread(target=_idle_watch, daemon=True).start()
    try:
        server.run()
    finally:
        cur = _read_state(demo)
        if cur and cur.get("pid") == os.getpid():
            try:
                sf.unlink()
            except OSError:
                pass
        log.info("daemon stopped")
