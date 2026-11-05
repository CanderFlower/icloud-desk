"""FastAPI application: JSON API under /api, static web UI under /."""

from __future__ import annotations

import logging
import os
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pyicloud.exceptions import PyiCloudException

from . import __version__
from .config import WEB_DIR
from .icloud import NotLoggedIn, icloud
from .routes import auth, calendar, drive, misc, notes, photos, reminders

log = logging.getLogger("icloud-desk")

DEMO = os.environ.get("ICLOUD_DESK_DEMO") == "1"


def create_app() -> FastAPI:
    app = FastAPI(title="iCloud Desk", version=__version__)

    @app.exception_handler(NotLoggedIn)
    async def _not_logged_in(_: Request, exc: NotLoggedIn):
        return JSONResponse({"error": exc.message, "state": exc.state}, status_code=401)

    @app.exception_handler(ValueError)
    async def _value_error(_: Request, exc: ValueError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(PyiCloudException)
    async def _icloud_error(_: Request, exc: PyiCloudException):
        log.exception("iCloud error", exc_info=exc)
        return JSONResponse({"error": f"iCloud 返回错误：{exc}", "type": type(exc).__name__}, status_code=502)

    @app.exception_handler(Exception)
    async def _any_error(_: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)

    if DEMO:
        from .demo import install_demo

        install_demo(app)
    else:
        for module in (auth, calendar, reminders, notes, drive, photos, misc):
            app.include_router(module.router)

        @app.on_event("startup")
        def _restore() -> None:
            threading.Thread(target=icloud.restore, name="icloud-restore", daemon=True).start()

    @app.get("/api/version")
    def version():
        return {"version": __version__, "demo": DEMO}

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
    return app


app = create_app()
