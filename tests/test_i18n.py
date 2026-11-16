"""Tests for backend, HTTP API, demo mode, and CLI multilingual (`zh-CN` / `en`) support."""

from __future__ import annotations

import asyncio
import json

from app import cli
from app.i18n import get_lang, normalize_lang, tr, use_lang
from app.notes_write import NotesWriter


def _asgi_get(app, path: str, headers: dict[str, str]) -> tuple[int, dict]:
    raw_headers = [(b"host", b"127.0.0.1:48858"), *[(k.lower().encode(), v.encode()) for k, v in headers.items()]]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": raw_headers,
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 48858),
    }
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        sent.append(msg)

    asyncio.run(app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(body.decode("utf-8"))


def test_normalize_and_context_lang():
    assert normalize_lang("en-US,en;q=0.9") == "en"
    assert normalize_lang("zh-Hans-CN,zh;q=0.9") == "zh-CN"
    assert get_lang() == "zh-CN"
    assert tr("中文", "English") == "中文"

    with use_lang("en-US"):
        assert get_lang() == "en"
        assert tr("中文", "English") == "English"

    assert get_lang() == "zh-CN"


def test_notes_writer_respects_active_locale():
    calls = []

    def fake_ck(path, payload):
        calls.append((path, payload))
        if path == "/records/lookup":
            return {"records": [{"recordName": r["recordName"], "serverErrorCode": "NOT_FOUND"} for r in payload["records"]]}
        return {"records": [{"recordName": op["record"]["recordName"], "recordChangeTag": "t1"} for op in payload["operations"]]}

    with use_lang("en"):
        created = NotesWriter(fake_ck).create_note(None, "")
        assert created["title"] == "New Note"
        assert created["snippet"] == "No additional text"

    with use_lang("zh-CN"):
        created_zh = NotesWriter(fake_ck).create_note(None, "")
        assert created_zh["title"] == "新备忘录"
        assert created_zh["snippet"] == "无附加文本"


def test_server_accept_language_localizes_errors_and_demo(monkeypatch):
    import app.server as server_mod
    from app import daemon

    monkeypatch.setattr(server_mod, "DEMO", True)
    token = daemon.get_token()
    app = server_mod.create_app()

    # Forbidden without token: localized error message
    status_en, body_en = _asgi_get(app, "/api/ping", {"Accept-Language": "en-US"})
    assert status_en == 403
    assert body_en["error"] == "Missing or invalid access token"

    status_zh, body_zh = _asgi_get(app, "/api/ping", {"Accept-Language": "zh-CN"})
    assert status_zh == 403
    assert body_zh["error"] == "缺少或错误的访问令牌"

    # Demo endpoints return English vs Chinese demo datasets based on Accept-Language
    auth = {"Authorization": f"Bearer {token}"}
    _, cals_en = _asgi_get(app, "/api/calendar/calendars", {**auth, "Accept-Language": "en"})
    _, cals_zh = _asgi_get(app, "/api/calendar/calendars", {**auth, "Accept-Language": "zh-CN"})
    assert cals_en[0]["title"] == "Home"
    assert cals_zh[0]["title"] == "家庭"

    _, acc_en = _asgi_get(app, "/api/account", {**auth, "Accept-Language": "en"})
    assert acc_en["storage"]["by_media"][0]["label"] == "Photos and Videos"


def test_cli_lang_flag_localizes_errors(capsys):
    code = cli.main(["--lang", "en", "calendar", "add", "--title", "Test", "--start", "not-a-date"])
    assert code == cli.EXIT_USAGE
    err = json.loads(capsys.readouterr().err)
    assert "Unrecognized date/time" in err["error"]

    code_zh = cli.main(["--lang", "zh", "calendar", "add", "--title", "测试", "--start", "not-a-date"])
    assert code_zh == cli.EXIT_USAGE
    err_zh = json.loads(capsys.readouterr().err)
    assert "无法识别的时间" in err_zh["error"]
