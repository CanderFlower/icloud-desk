"""FastAPI application: JSON API under /api, static web UI under /.

Every /api request must carry the per-user secret token (``Authorization:
Bearer``, ``X-ICD-Token`` or the ``icd_token`` cookie set when the UI is
opened via ``/?token=...``), and the Host header must be loopback. This keeps
other websites (CSRF / DNS rebinding) away from the iCloud session.
"""

from __future__ import annotations

import hmac
import logging
import os
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pyicloud.exceptions import PyiCloudException

from . import __version__
from .config import WEB_DIR
from .i18n import normalize_lang, tr, use_lang
from .icloud import NotLoggedIn, icloud

log = logging.getLogger("icloud-desk")

DEMO = os.environ.get("ICLOUD_DESK_DEMO") == "1"
COOKIE = "icd_token"
_LOOPBACK = {"127.0.0.1", "localhost", "[::1]"}


class _Activity:
    def __init__(self) -> None:
        self.inflight = 0
        self.last = time.time()
        self._lock = threading.Lock()

    def begin(self) -> None:
        with self._lock:
            self.inflight += 1
            self.last = time.time()

    def end(self) -> None:
        with self._lock:
            self.inflight -= 1
            self.last = time.time()

    def idle_seconds(self) -> float:
        with self._lock:
            return 0.0 if self.inflight else time.time() - self.last


activity = _Activity()


def _token() -> str:
    from .daemon import get_token

    return get_token()


def _request_token(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.headers.get("x-icd-token") or request.cookies.get(COOKIE)


def _host_ok(request: Request) -> bool:
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
    return host in _LOOPBACK


def _no_token_page() -> str:
    title = tr("请从 iCloud Desk 应用打开", "Please open from the iCloud Desk app")
    body = tr(
        "浏览器访问需要授权链接，可在终端运行 <code>icd ui</code> 打开。",
        "Browser access requires an authorized link. Run <code>icd ui</code> in a terminal to open it.",
    )
    return (
        '<!doctype html><meta charset="utf-8"><title>iCloud Desk</title>\n'
        "<body style=\"font:15px -apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#555\">\n"
        f'<div style="text-align:center"><h2 style="color:#111">{title}</h2>\n'
        f"<p>{body}</p></div></body>"
    )


def create_app() -> FastAPI:
    app = FastAPI(title="iCloud Desk", version=__version__, docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    app.state.shutdown = None

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        lang = normalize_lang(request.headers.get("accept-language"), fallback="zh-CN")
        with use_lang(lang):
            if not _host_ok(request):
                return JSONResponse({"error": "forbidden host"}, status_code=403)
            path = request.url.path
            if path.startswith("/api/"):
                tok = _request_token(request)
                if not tok or not hmac.compare_digest(tok, _token()):
                    return JSONResponse(
                        {"error": tr("缺少或错误的访问令牌", "Missing or invalid access token"), "code": "bad_token"},
                        status_code=403,
                    )
                activity.begin()
                try:
                    return await call_next(request)
                finally:
                    activity.end()
            resp = await call_next(request)
            # Static UI: always revalidate (ETag) so upgrades never serve stale JS/CSS.
            resp.headers.setdefault("Cache-Control", "no-cache")
            return resp

    @app.exception_handler(NotLoggedIn)
    async def _not_logged_in(_: Request, exc: NotLoggedIn):
        return JSONResponse({"error": exc.localized_message(), "state": exc.state}, status_code=401)

    @app.exception_handler(ValueError)
    async def _value_error(_: Request, exc: ValueError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(PyiCloudException)
    async def _icloud_error(_: Request, exc: PyiCloudException):
        log.exception("iCloud error", exc_info=exc)
        return JSONResponse(
            {"error": tr(f"iCloud 返回错误：{exc}", f"iCloud returned an error: {exc}"), "type": type(exc).__name__},
            status_code=502,
        )

    @app.exception_handler(Exception)
    async def _any_error(_: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)

    @app.get("/api/ping")
    def ping():
        return {"app": "icloud-desk", "version": __version__, "demo": DEMO, "pid": os.getpid()}

    @app.get("/api/version")
    def version():
        return {"version": __version__, "demo": DEMO}

    @app.post("/api/daemon/shutdown")
    def shutdown():
        if app.state.shutdown:
            threading.Timer(0.2, app.state.shutdown).start()
        return {"ok": True}

    if DEMO:
        from .demo import install_demo

        install_demo(app)
    else:
        from .routes import auth, calendar, drive, misc, notes, photos, reminders

        for module in (auth, calendar, reminders, notes, drive, photos, misc):
            app.include_router(module.router)

        @app.on_event("startup")
        def _restore() -> None:
            threading.Thread(target=icloud.restore, name="icloud-restore", daemon=True).start()

    @app.get("/")
    def index(request: Request, token: str | None = None):
        if token:
            if not hmac.compare_digest(token, _token()):
                return HTMLResponse(_no_token_page(), status_code=403)
            resp = RedirectResponse("/", status_code=303)
            resp.set_cookie(COOKIE, token, max_age=10 * 365 * 86400, httponly=True, samesite="strict", path="/")
            return resp
        cookie = request.cookies.get(COOKIE)
        if not cookie or not hmac.compare_digest(cookie, _token()):
            return HTMLResponse(_no_token_page(), status_code=403)
        return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
    return app


app = create_app()
