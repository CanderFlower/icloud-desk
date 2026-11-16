"""``icd`` - command line interface for iCloud Desk.

Every command talks to the per-user background daemon (started on demand), so
the CLI shares the desktop app's iCloud session and never needs its own login.
Output is JSON on stdout; errors are JSON on stderr with a non-zero exit code.
"""

from __future__ import annotations

import argparse
import getpass
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from . import __version__, daemon
from .i18n import get_lang, normalize_lang, set_lang, system_lang, tr

EXIT_ERROR, EXIT_USAGE, EXIT_AUTH, EXIT_NOT_FOUND, EXIT_CONFLICT = 1, 2, 3, 4, 5

DRIVE_ROOT = "FOLDER::com.apple.CloudDocs::root"
PRIORITY = {"none": 0, "high": 1, "medium": 5, "low": 9}


class CliError(Exception):
    def __init__(self, message: str, code: int = EXIT_ERROR, status: int | None = None, data: Any = None) -> None:
        super().__init__(message)
        self.message, self.code, self.status, self.data = message, code, status, data


# --------------------------------------------------------------------- output
class Out:
    ascii = False
    pretty = True


def emit(data: Any) -> None:
    if data is None:
        return
    text = json.dumps(data, ensure_ascii=Out.ascii, indent=2 if Out.pretty else None, default=str)
    _write(sys.stdout, text + "\n")


def _write(stream: Any, text: str) -> None:
    try:
        stream.write(text)
    except UnicodeEncodeError:
        stream.buffer.write(text.encode(stream.encoding or "utf-8", errors="backslashreplace"))
    stream.flush()


# ----------------------------------------------------------------------- HTTP
class Client:
    def __init__(self, demo: bool = False) -> None:
        self.demo = demo
        self._base: str | None = None

    @property
    def base(self) -> str:
        if self._base is None:
            info = daemon.ensure(self.demo)
            self._base = info["url"].rstrip("/")
        return self._base

    def request(self, method: str, path: str, params: dict[str, Any] | None = None, body: Any = None,
                raw: bool = False, data: bytes | None = None, headers: dict[str, str] | None = None,
                timeout: float = 300) -> Any:
        url = self.base + path
        if params:
            q = {k: ("true" if v is True else "false" if v is False else v) for k, v in params.items() if v is not None}
            if q:
                url += "?" + urllib.parse.urlencode(q, doseq=True)
        hdrs = {
            "Authorization": f"Bearer {daemon.get_token()}",
            "Accept": "application/json",
            "Accept-Language": get_lang(),
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        hdrs.update(headers or {})
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8", "replace")
            try:
                err = json.loads(payload)
            except ValueError:
                err = {"error": payload or exc.reason}
            msg = err.get("error") or str(exc)
            code = {401: EXIT_AUTH, 404: EXIT_NOT_FOUND, 409: EXIT_CONFLICT, 423: EXIT_CONFLICT}.get(exc.code, EXIT_ERROR)
            if exc.code == 401:
                msg = tr(
                    f"{msg}（请先在 iCloud Desk 应用中登录，或运行 icd login）",
                    f"{msg} (please sign in via the iCloud Desk app or run `icd login`)",
                )
            raise CliError(msg, code, exc.code, err) from None
        except urllib.error.URLError as exc:
            raise CliError(tr(f"无法连接后台服务：{exc.reason}", f"Cannot connect to background daemon: {exc.reason}")) from None
        if raw:
            return resp
        with resp:
            text = resp.read().decode("utf-8")
        return json.loads(text) if text else None

    def get(self, path: str, **params: Any) -> Any:
        return self.request("GET", path, params=params)

    def post(self, path: str, body: Any = None, **params: Any) -> Any:
        return self.request("POST", path, params=params, body=body if body is not None else {})

    def put(self, path: str, body: Any) -> Any:
        return self.request("PUT", path, body=body)

    def patch(self, path: str, body: Any) -> Any:
        return self.request("PATCH", path, body=body)

    def delete(self, path: str, **params: Any) -> Any:
        return self.request("DELETE", path, params=params)

    def upload(self, path: str, fields: dict[str, str], files: list[Path]) -> Any:
        boundary = uuid.uuid4().hex
        parts: list[bytes] = []
        for k, v in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for f in files:
            mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            name = urllib.parse.quote(f.name)
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"; '
                f"filename*=UTF-8''{name}\r\nContent-Type: {mime}\r\n\r\n".encode()
            )
            parts.append(f.read_bytes() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return self.request("POST", path, data=b"".join(parts),
                            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def download(self, path: str, params: dict[str, Any], out: str | None, default_name: str) -> dict[str, Any]:
        resp = self.request("GET", path, params=params, raw=True)
        with resp:
            name = _filename_from(resp.headers.get("Content-Disposition")) or default_name
            target = Path(out) if out else Path.cwd() / name
            if target.is_dir():
                target = target / name
            if str(out) == "-":
                total = 0
                while chunk := resp.read(256 * 1024):
                    sys.stdout.buffer.write(chunk)
                    total += len(chunk)
                sys.stdout.buffer.flush()
                return {"bytes": total}
            target.parent.mkdir(parents=True, exist_ok=True)
            total = 0
            with open(target, "wb") as fh:
                while chunk := resp.read(256 * 1024):
                    fh.write(chunk)
                    total += len(chunk)
        return {"path": str(target.resolve()), "bytes": total}


def _filename_from(disposition: str | None) -> str | None:
    if not disposition:
        return None
    for part in disposition.split(";"):
        part = part.strip()
        if part.lower().startswith("filename*="):
            v = part.split("=", 1)[1]
            if "''" in v:
                v = v.split("''", 1)[1]
            return urllib.parse.unquote(v)
    for part in disposition.split(";"):
        part = part.strip()
        if part.lower().startswith("filename="):
            return part.split("=", 1)[1].strip('"')
    return None


# -------------------------------------------------------------------- helpers
def _read_text(args: argparse.Namespace) -> str:
    if getattr(args, "text", None) is not None:
        return args.text.replace("\\n", "\n")
    if getattr(args, "file", None):
        return Path(args.file).read_text("utf-8")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise CliError(tr("需要 --text、--file 或从标准输入传入内容", "Pass --text, --file, or pipe content on stdin"), EXIT_USAGE)


def _parse_when(value: str | None, default: datetime | None = None) -> datetime | None:
    if value is None:
        return default
    v = value.strip().lower()
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    rel = {"today": today, "今天": today, "tomorrow": today + timedelta(days=1), "明天": today + timedelta(days=1),
           "yesterday": today - timedelta(days=1), "昨天": today - timedelta(days=1)}
    if v in rel:
        return rel[v]
    if v.startswith(("+", "-")) and v[-1] in "dhm" and v[1:-1].isdigit():
        n = int(v[:-1])
        unit = {"d": "days", "h": "hours", "m": "minutes"}[v[-1]]
        base = today if unit == "days" else datetime.now().replace(second=0, microsecond=0)
        return base + timedelta(**{unit: n})
    try:
        return datetime.fromisoformat(value.strip().replace(" ", "T"))
    except ValueError:
        raise CliError(
            tr(
                f"无法识别的时间：{value}（用 2026-11-05、2026-11-05T14:30、today、tomorrow、+3d、+2h）",
                f"Unrecognized date/time: {value} (use 2026-11-05, 2026-11-05T14:30, today, tomorrow, +3d, +2h)",
            ),
            EXIT_USAGE,
        ) from None


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _pick(items: list[dict[str, Any]], ref: str, keys: tuple[str, ...], name_key: str, what: str) -> dict[str, Any]:
    for it in items:
        if any(it.get(k) == ref for k in keys):
            return it
    low = ref.casefold()
    hits = [it for it in items if str(it.get(name_key) or "").casefold() == low]
    if len(hits) == 1:
        return hits[0]
    hits = hits or [it for it in items if low in str(it.get(name_key) or "").casefold()]
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(str(it.get(name_key)) for it in (hits or items)[:20])
    msg = tr(
        f"{what}“{ref}”{'不唯一' if hits else '不存在'}。可选：{names}",
        f"{what} '{ref}' {'is ambiguous' if hits else 'was not found'}. Available: {names}",
    )
    raise CliError(msg, EXIT_NOT_FOUND)


# ===================================================================== commands
def cmd_daemon(c: Client, a: argparse.Namespace) -> Any:
    if a.action in ("ensure", "start"):
        return daemon.ensure(a.demo)
    if a.action == "stop":
        return {"stopped": daemon.stop(a.demo)}
    if a.action == "restart":
        daemon.stop(a.demo)
        return daemon.ensure(a.demo)
    st = daemon.running(a.demo)
    return {"running": bool(st), **(daemon.describe(st) if st else {})}


def cmd_ui(c: Client, a: argparse.Namespace) -> Any:
    shell = Path(sys.executable).with_name("iCloudDesk.exe")
    if getattr(sys, "frozen", False) and shell.exists() and not a.browser:
        import subprocess

        subprocess.Popen([str(shell)] + (["--demo"] if a.demo else []), close_fds=True)
        return {"opened": str(shell)}
    import webbrowser

    info = daemon.ensure(a.demo)
    webbrowser.open(info["ui_url"])
    return {"opened": info["url"]}


# ------------------------------------------------------------------ account
def cmd_status(c: Client, a: argparse.Namespace) -> Any:
    st = c.get("/api/auth/status")
    deadline = time.time() + 30
    while st.get("state") == "restoring" and time.time() < deadline:
        time.sleep(0.5)
        st = c.get("/api/auth/status")
    return st


def cmd_login(c: Client, a: argparse.Namespace) -> Any:
    apple_id = a.apple_id or input("Apple ID: ").strip()
    password = sys.stdin.readline().rstrip("\r\n") if a.password_stdin else getpass.getpass(tr("密码: ", "Password: "))
    st = c.post("/api/auth/login", {"apple_id": apple_id, "password": password,
                                     "china_mainland": a.china, "remember": not a.no_remember})
    if st.get("state") in ("needs_2fa", "2fa", "requires_2fa") and sys.stdin.isatty():
        code = input(tr("双重认证验证码: ", "2FA verification code: ")).strip()
        st = c.post("/api/auth/2fa/verify", {"code": code})
    return st


def cmd_2fa(c: Client, a: argparse.Namespace) -> Any:
    if a.action == "request":
        return c.post("/api/auth/2fa/request")
    return c.post("/api/auth/2fa/verify", {"code": a.code})


def cmd_logout(c: Client, a: argparse.Namespace) -> Any:
    return c.post("/api/auth/logout", {"forget_password": a.forget_password})


def cmd_account(c: Client, a: argparse.Namespace) -> Any:
    return c.get("/api/account")


# ----------------------------------------------------------------- calendar
def _calendar(c: Client, ref: str | None) -> dict[str, Any]:
    cals = c.get("/api/calendar/calendars")
    if ref is None:
        writable = [x for x in cals if not x.get("read_only")]
        return next((x for x in writable if x.get("is_default")), writable[0] if writable else cals[0])
    return _pick(cals, ref, ("guid",), "title", tr("日历", "Calendar"))


def cmd_cal(c: Client, a: argparse.Namespace) -> Any:
    act = a.action
    if act == "calendars":
        return c.get("/api/calendar/calendars")
    if act == "events":
        start = _parse_when(a.start, datetime.now().replace(hour=0, minute=0, second=0, microsecond=0))
        end = _parse_when(a.end) or start + timedelta(days=a.days)
        evs = c.get("/api/calendar/events", start=_iso(start), end=_iso(end))
        if a.calendar:
            guid = _calendar(c, a.calendar)["guid"]
            evs = [e for e in evs if e.get("pguid") == guid]
        if a.search:
            q = a.search.casefold()
            evs = [e for e in evs if q in (e.get("title", "") + e.get("location", "") + e.get("description", "")).casefold()]
        return sorted(evs, key=lambda e: e.get("start") or "")
    if act == "get":
        return c.get(f"/api/calendar/events/{a.pguid}/{a.guid}")
    if act == "add":
        cal = _calendar(c, a.calendar)
        start = _parse_when(a.start)
        if a.all_day:
            end = _parse_when(a.end) or start
        else:
            end = _parse_when(a.end) or start + timedelta(minutes=a.duration)
        return c.post("/api/calendar/events", {
            "pguid": cal["guid"], "title": a.title, "start": _iso(start), "end": _iso(end), "all_day": a.all_day,
            "location": a.location or "", "description": a.notes or "", "alarm_minutes": a.alarm,
        })
    if act == "update":
        ev = c.get(f"/api/calendar/events/{a.pguid}/{a.guid}")
        all_day = ev["all_day"] if a.all_day is None else a.all_day
        start = _parse_when(a.start) or datetime.fromisoformat(ev["start"])
        end = _parse_when(a.end) or datetime.fromisoformat(ev["end"])
        if ev["all_day"] and a.end is None:
            end -= timedelta(days=1)  # API takes the inclusive last day for all-day events
        pguid = _calendar(c, a.calendar)["guid"] if a.calendar else a.pguid
        return c.put(f"/api/calendar/events/{a.pguid}/{a.guid}", {
            "pguid": pguid, "title": a.title if a.title is not None else ev["title"],
            "start": _iso(start), "end": _iso(end), "all_day": all_day,
            "location": a.location if a.location is not None else ev.get("location", ""),
            "description": a.notes if a.notes is not None else ev.get("description", ""),
            "etag": ev.get("etag"),
        })
    if act == "delete":
        return c.delete(f"/api/calendar/events/{a.pguid}/{a.guid}")
    if act == "create-calendar":
        return c.post("/api/calendar/calendars", {"title": a.title, "color": a.color})
    if act == "delete-calendar":
        return c.delete(f"/api/calendar/calendars/{_calendar(c, a.calendar)['guid']}")
    raise CliError("unknown action", EXIT_USAGE)


# ---------------------------------------------------------------- reminders
def _rlist(c: Client, ref: str | None) -> dict[str, Any]:
    lists = [x for x in c.get("/api/reminders/lists") if not x.get("is_group")]
    if not lists:
        raise CliError(tr("没有提醒事项列表", "No reminder lists found"), EXIT_NOT_FOUND)
    return lists[0] if ref is None else _pick(lists, ref, ("id",), "title", tr("列表", "List"))


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def cmd_rem(c: Client, a: argparse.Namespace) -> Any:
    act = a.action
    if act == "lists":
        return c.get("/api/reminders/lists")
    if act == "list":
        lists = [_rlist(c, a.list)] if a.list or not a.all_lists else [x for x in c.get("/api/reminders/lists") if not x.get("is_group")]
        out = []
        for lst in lists:
            for r in c.get("/api/reminders", list_id=lst["id"], include_completed=a.completed):
                r.setdefault("list_title", lst["title"])
                out.append(r)
        return out
    if act == "get":
        return c.get(f"/api/reminders/item/{_q(a.id)}")
    if act == "add":
        due = _parse_when(a.due)
        return c.post("/api/reminders", {
            "list_id": _rlist(c, a.list)["id"], "title": a.title, "desc": a.notes or "",
            "due_date": _iso(due) if due else None, "all_day": a.all_day,
            "priority": PRIORITY[a.priority], "flagged": a.flag, "parent_reminder_id": a.parent,
        })
    if act in ("complete", "uncomplete"):
        return c.patch(f"/api/reminders/item/{_q(a.id)}", {"completed": act == "complete"})
    if act == "update":
        body: dict[str, Any] = {}
        if a.title is not None: body["title"] = a.title
        if a.notes is not None: body["desc"] = a.notes
        if a.due == "none": body["clear_due_date"] = True
        elif a.due is not None: body["due_date"] = _iso(_parse_when(a.due))
        if a.all_day is not None: body["all_day"] = a.all_day
        if a.priority is not None: body["priority"] = PRIORITY[a.priority]
        if a.flag is not None: body["flagged"] = a.flag
        if a.list is not None: body["list_id"] = _rlist(c, a.list)["id"]
        return c.patch(f"/api/reminders/item/{_q(a.id)}", body)
    if act == "delete":
        return c.delete(f"/api/reminders/item/{_q(a.id)}")
    raise CliError("unknown action", EXIT_USAGE)


# -------------------------------------------------------------------- notes
def _folder(c: Client, ref: str) -> dict[str, Any]:
    return _pick(c.get("/api/notes/folders"), ref, ("id",), "name", tr("文件夹", "Folder"))


def cmd_notes(c: Client, a: argparse.Namespace) -> Any:
    act = a.action
    if act == "folders":
        return c.get("/api/notes/folders")
    if act == "list":
        fid = _folder(c, a.folder)["id"] if a.folder else None
        rows = c.get("/api/notes", folder_id=fid, limit=a.limit)
        if a.search:
            q = a.search.casefold()
            rows = [n for n in rows if q in (str(n.get("title")) + str(n.get("snippet"))).casefold()]
        return rows
    if act == "get":
        n = c.get(f"/api/notes/item/{_q(a.id)}")
        if a.format == "markdown":
            _write(sys.stdout, (n.get("markdown") or n.get("text") or "") + "\n")
            return None
        if a.format == "html":
            _write(sys.stdout, (n.get("html") or "") + "\n")
            return None
        return n
    if act == "add":
        fid = _folder(c, a.folder)["id"] if a.folder else None
        return c.post("/api/notes/notes", {"folder_id": fid, "text": _read_text(a)})
    if act == "update":
        text = _read_text(a)
        body: dict[str, Any] = {"text": text, "force": a.force}
        if a.append:
            cur = c.get(f"/api/notes/item/{_q(a.id)}")
            body["text"] = (cur.get("markdown") or "").rstrip("\n") + "\n" + text
            body["change_tag"] = cur.get("change_tag")
        return c.patch(f"/api/notes/item/{_q(a.id)}", body)
    if act == "delete":
        return c.delete(f"/api/notes/item/{_q(a.id)}", permanent=a.permanent)
    if act == "move":
        return c.post("/api/notes/move", {"id": a.id, "folder_id": _folder(c, a.folder)["id"]})
    if act == "mkdir":
        parent = _folder(c, a.parent)["id"] if a.parent else None
        return c.post("/api/notes/folders", {"title": a.name, "parent_id": parent})
    if act == "rename-folder":
        return c.patch(f"/api/notes/folders/{_q(_folder(c, a.folder)['id'])}", {"title": a.name})
    if act == "rmdir":
        return c.delete(f"/api/notes/folders/{_q(_folder(c, a.folder)['id'])}")
    if act == "attachment":
        return c.download(f"/api/notes/attachment/{_q(a.id)}", {"att_id": a.att_id}, a.output, "attachment")
    raise CliError("unknown action", EXIT_USAGE)


# -------------------------------------------------------------------- drive
def _drive_resolve(c: Client, ref: str | None) -> dict[str, Any]:
    """Accept a drivewsid or a path like /Documents/report.pdf."""
    if not ref or ref in ("/", "\\"):
        return {"id": DRIVE_ROOT, "name": "iCloud Drive", "type": "folder"}
    if "::" in ref:
        return {"id": ref, "name": ref.rsplit("::", 1)[-1], "type": "folder" if ref.startswith("FOLDER") else "file"}
    node = {"id": DRIVE_ROOT, "name": "iCloud Drive", "type": "folder"}
    for part in [p for p in ref.replace("\\", "/").split("/") if p]:
        if node["type"] not in ("folder", "app_library"):
            raise CliError(tr(f"“{node['name']}”不是文件夹", f"'{node['name']}' is not a folder"), EXIT_NOT_FOUND)
        items = c.get("/api/drive/list", id=node["id"])["items"]
        node = next((i for i in items if i["name"] == part), None) or \
            next((i for i in items if i["name"].casefold() == part.casefold()), None)
        if node is None:
            raise CliError(tr(f"路径不存在：{ref}", f"Path not found: {ref}"), EXIT_NOT_FOUND)
    return node


def _drive_parent(c: Client, path: str) -> tuple[dict[str, Any], str]:
    p = path.replace("\\", "/").rstrip("/")
    parent, _, name = p.rpartition("/")
    return _drive_resolve(c, parent or "/"), name


def cmd_drive(c: Client, a: argparse.Namespace) -> Any:
    act = a.action
    if act == "ls":
        node = _drive_resolve(c, a.path)
        if node["type"] not in ("folder", "app_library"):
            return node
        return c.get("/api/drive/list", id=node["id"])
    if act == "apps":
        return c.get("/api/drive/apps")
    if act == "trash":
        return c.get("/api/drive/trash")
    if act == "download":
        node = _drive_resolve(c, a.path)
        return c.download("/api/drive/download", {"id": node["id"]}, a.output, node["name"])
    if act == "upload":
        node = _drive_resolve(c, a.to)
        files = [Path(f) for f in a.files]
        for f in files:
            if not f.is_file():
                raise CliError(tr(f"文件不存在：{f}", f"File not found: {f}"), EXIT_NOT_FOUND)
        return c.upload("/api/drive/upload", {"folder": node["id"]}, files)
    if act == "mkdir":
        parent, name = _drive_parent(c, a.path)
        return c.post("/api/drive/mkdir", {"id": parent["id"], "name": name})
    if act == "rename":
        return c.post("/api/drive/rename", {"id": _drive_resolve(c, a.path)["id"], "name": a.name})
    if act == "mv":
        ids = [_drive_resolve(c, p)["id"] for p in a.paths]
        return c.post("/api/drive/move", {"ids": ids, "dest": _drive_resolve(c, a.dest)["id"]})
    if act == "rm":
        ids = [_drive_resolve(c, p)["id"] for p in a.paths]
        return c.post("/api/drive/trash", {"ids": ids})
    if act == "restore":
        return c.post("/api/drive/recover", {"ids": a.ids})
    if act == "purge":
        return c.post("/api/drive/delete-forever", {"ids": a.ids})
    raise CliError("unknown action", EXIT_USAGE)


# ------------------------------------------------------------------- photos
def cmd_photos(c: Client, a: argparse.Namespace) -> Any:
    act = a.action
    if act == "albums":
        return c.get("/api/photos/albums")
    if act == "list":
        return c.get("/api/photos/list", album=a.album, offset=a.offset, limit=a.limit)
    if act == "download":
        return c.download("/api/photos/file", {"id": a.id, "version": a.version, "download": True}, a.output, f"{a.id}.jpg")
    if act == "upload":
        return c.upload("/api/photos/upload", {"album": a.album or ""}, [Path(f) for f in a.files])
    if act == "favorite":
        return c.post("/api/photos/favorite", {"id": a.id, "value": not a.off})
    if act == "delete":
        return c.delete("/api/photos/item", id=a.id)
    raise CliError("unknown action", EXIT_USAGE)


# -------------------------------------------------------------------- other
def cmd_contacts(c: Client, a: argparse.Namespace) -> Any:
    rows = c.get("/api/contacts")
    if a.search:
        q = a.search.casefold()
        rows = [r for r in rows if q in json.dumps(r, ensure_ascii=False).casefold()]
    return rows


def cmd_findmy(c: Client, a: argparse.Namespace) -> Any:
    if a.action == "devices":
        return c.get("/api/findmy/devices", refresh=a.refresh)
    dev = _pick(c.get("/api/findmy/devices"), a.device, ("id",), "name", tr("设备", "Device"))
    base = f"/api/findmy/devices/{_q(dev['id'])}"
    if a.action == "sound":
        return c.post(base + "/sound")
    if a.action == "message":
        return c.post(base + "/message", {"subject": a.subject, "message": a.text, "sound": a.sound})
    if a.action == "lost":
        return c.post(base + "/lost", {"number": a.number, "text": a.text or tr("这台设备已丢失，请联系我。", "This device has been lost. Please call me.")})
    raise CliError("unknown action", EXIT_USAGE)


def cmd_hme(c: Client, a: argparse.Namespace) -> Any:
    act = a.action
    if act == "list":
        return c.get("/api/hme")
    if act == "create":
        email = c.post("/api/hme/generate").get("email")
        return c.post("/api/hme", {"email": email, "label": a.label, "note": a.note or ""})
    aid = _pick(c.get("/api/hme"), a.id, ("id", "anonymous_id", "email"), "email", tr("地址", "Address"))
    aid = aid.get("id") or aid.get("anonymous_id")
    if act == "update":
        return c.patch(f"/api/hme/{_q(aid)}", {"label": a.label, "note": a.note})
    if act in ("deactivate", "reactivate"):
        return c.post(f"/api/hme/{_q(aid)}/{act}")
    if act == "delete":
        return c.delete(f"/api/hme/{_q(aid)}")
    raise CliError("unknown action", EXIT_USAGE)


def cmd_api(c: Client, a: argparse.Namespace) -> Any:
    path = a.path if a.path.startswith("/api/") else "/api/" + a.path.lstrip("/")
    body = json.loads(a.data) if a.data else None
    params = dict(p.split("=", 1) for p in a.query)
    return c.request(a.method.upper(), path, params=params, body=body)


GUIDE = """# icd — iCloud Desk command line (for humans and AI agents)

All commands print JSON to stdout. Errors print {"error": ...} to stderr.
Exit codes: 0 ok, 1 error, 2 usage, 3 not logged in, 4 not found, 5 conflict/locked.
The background daemon starts automatically and shares the desktop app's login.
If you get exit code 3, ask the user to sign in via the iCloud Desk app.
Use --ascii when your reader can't handle UTF-8 (non-ASCII becomes \\uXXXX).
Dates: 2026-11-05, 2026-11-05T14:30, today, tomorrow, +3d, -2d, +2h.
Names can be used instead of IDs for calendars, reminder lists, note folders,
devices; iCloud Drive accepts paths like /Documents/report.pdf.

icd status                                   login state
icd calendar calendars
icd calendar events [--start today] [--end +7d | --days 7] [--calendar NAME] [--search TEXT]
icd calendar add --title T --start 2026-11-06T10:00 [--end ... | --duration 60] [--all-day] [--calendar NAME] [--location L] [--notes N] [--alarm 15]
icd calendar update PGUID GUID [--title ...] [--start ...] [--end ...]
icd calendar delete PGUID GUID
icd reminders lists
icd reminders list [--list NAME | --all-lists] [--completed]
icd reminders add --title T [--list NAME] [--due tomorrow] [--priority high|medium|low] [--flag] [--notes N]
icd reminders complete ID | uncomplete ID | update ID ... | delete ID
icd notes folders
icd notes list [--folder NAME] [--search TEXT] [--limit 50]
icd notes get ID [--format json|markdown|html]
icd notes add [--folder NAME] (--text "Title\\nbody" | --file note.md | < stdin)
icd notes update ID (--text|--file|stdin) [--append] [--force]
icd notes delete ID [--permanent] | move ID --folder NAME | mkdir NAME | rename-folder NAME NEW | rmdir NAME
  Note text: first line = title; "# ", "## " headings; "- " bullets; "1. " numbers; "- [ ] " / "- [x] " checklist.
icd drive ls [/path]  | apps | trash
icd drive download /path/file [-o out] | upload FILE... [--to /path] | mkdir /path/new
icd drive rename /path NEWNAME | mv /a /b --to /dest | rm /path... | restore ID... | purge ID...
icd photos albums | list [--album ID] [--limit 50] | download ID [--version original|medium|thumb] [-o out]
icd photos upload FILE... [--album ID] | favorite ID [--off] | delete ID
icd contacts [--search TEXT]
icd findmy devices [--refresh] | sound DEVICE | message DEVICE --text T | lost DEVICE --number N --text T
icd hme list | create --label L [--note N] | update ID --label L | deactivate ID | reactivate ID | delete ID
icd account
icd api GET /api/... [-q key=value] [--data JSON]     raw access to every HTTP endpoint
icd daemon ensure|status|stop|restart
icd ui [--browser]                            open the app
"""


# ======================================================================= parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="icd",
        description=tr("iCloud Desk 命令行。运行 `icd guide` 查看完整用法。", "iCloud Desk CLI. Run `icd guide` for complete usage."),
    )
    p.add_argument("--version", action="version", version=f"icd {__version__}")
    p.add_argument("--lang", choices=["auto", "zh", "zh-CN", "en"], default=None, help=tr("界面与提示语言（auto / zh / en）", "Output message language (auto / zh / en)"))
    p.add_argument("--demo", action="store_true", help=tr("使用演示数据（不需要登录）", "Use demo data (no Apple ID required)"))
    p.add_argument("--ascii", action="store_true", help=tr("JSON 中非 ASCII 字符转义为 \\uXXXX", "Escape non-ASCII characters as \\uXXXX in JSON"))
    p.add_argument("--compact", action="store_true", help=tr("单行 JSON 输出", "Single-line compact JSON output"))
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND")

    def cmd(name: str, fn: Callable, help: str, aliases: list[str] | None = None) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help, aliases=aliases or [])
        sp.set_defaults(fn=fn)
        return sp

    def actions(parent: argparse.ArgumentParser) -> Any:
        s = parent.add_subparsers(dest="action", metavar="ACTION")
        s.required = True
        return s

    cmd("guide", None, tr("打印给人和 AI Agent 看的完整用法", "Print full guide for humans and AI agents")).set_defaults(fn="guide")
    sp = cmd("serve", None, tr("前台运行后台服务（一般无需手动运行）", "Run background daemon in foreground"))
    sp.set_defaults(fn="serve")
    sp.add_argument("--port", type=int)
    sp.add_argument("--idle-minutes", type=float, help=tr("空闲多少分钟后退出，0 = 永不", "Exit after N idle minutes (0 = never)"))
    sp.add_argument("--debug", action="store_true")

    sp = cmd("daemon", cmd_daemon, tr("后台服务：ensure / status / stop / restart", "Daemon control: ensure / status / stop / restart"))
    sp.add_argument("action", choices=["ensure", "start", "status", "stop", "restart"])
    sp = cmd("ui", cmd_ui, tr("打开 iCloud Desk 窗口", "Open the iCloud Desk window"))
    sp.add_argument("--browser", action="store_true", help=tr("在浏览器中打开", "Open in default browser"))

    cmd("status", cmd_status, tr("登录状态", "Sign-in status"))
    sp = cmd("login", cmd_login, tr("登录 Apple 账户（交互式）", "Sign in to Apple Account (interactive)"))
    sp.add_argument("--apple-id")
    sp.add_argument("--password-stdin", action="store_true", help=tr("从标准输入读取密码", "Read password from stdin"))
    sp.add_argument("--china", action="store_true", help=tr("中国大陆账户", "China mainland account (icloud.com.cn)"))
    sp.add_argument("--no-remember", action="store_true", help=tr("不在凭据管理器中保存密码", "Do not save password in Windows Credential Manager"))
    sp = cmd("2fa", cmd_2fa, tr("双重认证", "Two-factor authentication"))
    s = actions(sp)
    s.add_parser("request")
    s.add_parser("verify").add_argument("code")
    sp = cmd("logout", cmd_logout, tr("退出登录", "Sign out"))
    sp.add_argument("--forget-password", action="store_true")
    cmd("account", cmd_account, tr("账户、存储空间、设备", "Account, storage, and devices"))

    # calendar
    sp = cmd("calendar", cmd_cal, tr("日历", "Calendar"), ["cal"])
    s = actions(sp)
    s.add_parser("calendars", help=tr("日历列表", "List calendars"))
    e = s.add_parser("events", help=tr("列出日程", "List events"))
    e.add_argument("--start", help=tr("默认 today", "Default: today"))
    e.add_argument("--end")
    e.add_argument("--days", type=int, default=7)
    e.add_argument("--calendar")
    e.add_argument("--search")
    g = s.add_parser("get")
    g.add_argument("pguid"); g.add_argument("guid")
    for name in ("add", "update"):
        x = s.add_parser(name)
        if name == "update":
            x.add_argument("pguid"); x.add_argument("guid")
            x.add_argument("--title")
            x.add_argument("--start")
            x.add_argument("--all-day", action=argparse.BooleanOptionalAction, default=None)
        else:
            x.add_argument("--title", required=True)
            x.add_argument("--start", required=True)
            x.add_argument("--all-day", action="store_true")
            x.add_argument("--duration", type=int, default=60, help=tr("分钟，默认 60", "Duration in minutes (default: 60)"))
            x.add_argument("--alarm", type=int, help=tr("提前多少分钟提醒", "Reminder minutes before start"))
        x.add_argument("--end")
        x.add_argument("--calendar")
        x.add_argument("--location")
        x.add_argument("--notes")
    d = s.add_parser("delete")
    d.add_argument("pguid"); d.add_argument("guid")
    x = s.add_parser("create-calendar")
    x.add_argument("--title", required=True)
    x.add_argument("--color", default="#1BADF8")
    s.add_parser("delete-calendar").add_argument("calendar")

    # reminders
    sp = cmd("reminders", cmd_rem, tr("提醒事项", "Reminders"), ["rem"])
    s = actions(sp)
    s.add_parser("lists")
    x = s.add_parser("list")
    x.add_argument("--list")
    x.add_argument("--all-lists", action="store_true")
    x.add_argument("--completed", action="store_true", help=tr("包含已完成", "Include completed reminders"))
    s.add_parser("get").add_argument("id")
    x = s.add_parser("add")
    x.add_argument("--title", required=True)
    x.add_argument("--list")
    x.add_argument("--due")
    x.add_argument("--all-day", action="store_true")
    x.add_argument("--priority", choices=list(PRIORITY), default="none")
    x.add_argument("--flag", action="store_true")
    x.add_argument("--notes")
    x.add_argument("--parent", help=tr("父提醒 ID（子任务）", "Parent reminder ID (subtask)"))
    x = s.add_parser("update")
    x.add_argument("id")
    x.add_argument("--title"); x.add_argument("--notes"); x.add_argument("--list")
    x.add_argument("--due", help=tr("时间，或 none 清除", "Date/time, or 'none' to clear"))
    x.add_argument("--all-day", action=argparse.BooleanOptionalAction, default=None)
    x.add_argument("--priority", choices=list(PRIORITY))
    x.add_argument("--flag", action=argparse.BooleanOptionalAction, default=None)
    for name in ("complete", "uncomplete", "delete"):
        s.add_parser(name).add_argument("id")

    # notes
    sp = cmd("notes", cmd_notes, tr("备忘录", "Notes"))
    s = actions(sp)
    s.add_parser("folders")
    x = s.add_parser("list")
    x.add_argument("--folder"); x.add_argument("--search")
    x.add_argument("--limit", type=int, default=100)
    x = s.add_parser("get")
    x.add_argument("id")
    x.add_argument("--format", choices=["json", "markdown", "html"], default="json")
    for name in ("add", "update"):
        x = s.add_parser(name)
        if name == "update":
            x.add_argument("id")
            x.add_argument("--append", action="store_true", help=tr("追加到末尾", "Append to existing note"))
            x.add_argument("--force", action="store_true", help=tr("即使会丢失附件等内容也强制覆盖", "Overwrite even if attachments would be lost"))
        else:
            x.add_argument("--folder")
        x.add_argument("--text"); x.add_argument("--file")
    x = s.add_parser("delete")
    x.add_argument("id"); x.add_argument("--permanent", action="store_true")
    x = s.add_parser("move")
    x.add_argument("id"); x.add_argument("--folder", required=True)
    x = s.add_parser("mkdir")
    x.add_argument("name"); x.add_argument("--parent")
    x = s.add_parser("rename-folder")
    x.add_argument("folder"); x.add_argument("name")
    s.add_parser("rmdir").add_argument("folder")
    x = s.add_parser("attachment")
    x.add_argument("id"); x.add_argument("att_id"); x.add_argument("-o", "--output")

    # drive
    sp = cmd("drive", cmd_drive, tr("iCloud 云盘", "iCloud Drive"))
    s = actions(sp)
    s.add_parser("ls").add_argument("path", nargs="?", default="/")
    s.add_parser("apps")
    s.add_parser("trash")
    x = s.add_parser("download")
    x.add_argument("path"); x.add_argument("-o", "--output", help=tr("文件或目录，- 表示标准输出", "File or directory, or - for stdout"))
    x = s.add_parser("upload")
    x.add_argument("files", nargs="+"); x.add_argument("--to", default="/")
    s.add_parser("mkdir").add_argument("path")
    x = s.add_parser("rename")
    x.add_argument("path"); x.add_argument("name")
    x = s.add_parser("mv")
    x.add_argument("paths", nargs="+"); x.add_argument("--to", dest="dest", required=True)
    s.add_parser("rm").add_argument("paths", nargs="+")
    s.add_parser("restore").add_argument("ids", nargs="+")
    s.add_parser("purge").add_argument("ids", nargs="+")

    # photos
    sp = cmd("photos", cmd_photos, tr("照片", "Photos"))
    s = actions(sp)
    s.add_parser("albums")
    x = s.add_parser("list")
    x.add_argument("--album", default="__all__")
    x.add_argument("--offset", type=int, default=0)
    x.add_argument("--limit", type=int, default=50)
    x = s.add_parser("download")
    x.add_argument("id")
    x.add_argument("--version", choices=["original", "medium", "thumb"], default="original")
    x.add_argument("-o", "--output")
    x = s.add_parser("upload")
    x.add_argument("files", nargs="+"); x.add_argument("--album")
    x = s.add_parser("favorite")
    x.add_argument("id"); x.add_argument("--off", action="store_true")
    s.add_parser("delete").add_argument("id")

    sp = cmd("contacts", cmd_contacts, tr("通讯录（只读）", "Contacts (read-only)"))
    sp.add_argument("--search")

    sp = cmd("findmy", cmd_findmy, tr("查找设备", "Find My devices"))
    s = actions(sp)
    s.add_parser("devices").add_argument("--refresh", action="store_true")
    s.add_parser("sound").add_argument("device")
    x = s.add_parser("message")
    x.add_argument("device"); x.add_argument("--text", required=True)
    x.add_argument("--subject", default="iCloud Desk"); x.add_argument("--sound", action="store_true")
    x = s.add_parser("lost")
    x.add_argument("device"); x.add_argument("--number", required=True)
    x.add_argument("--text", default=None)

    sp = cmd("hme", cmd_hme, tr("隐藏邮件地址", "Hide My Email"))
    s = actions(sp)
    s.add_parser("list")
    x = s.add_parser("create")
    x.add_argument("--label", required=True); x.add_argument("--note")
    x = s.add_parser("update")
    x.add_argument("id"); x.add_argument("--label", required=True); x.add_argument("--note")
    for name in ("deactivate", "reactivate", "delete"):
        s.add_parser(name).add_argument("id")

    sp = cmd("api", cmd_api, tr("直接调用任意 HTTP 接口", "Call any HTTP API endpoint directly"))
    sp.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE", "get", "post", "put", "patch", "delete"])
    sp.add_argument("path")
    sp.add_argument("-q", "--query", action="append", default=[], help="key=value")
    sp.add_argument("--data", help=tr("JSON 请求体", "JSON request body"))
    _add_common(p)
    return p


def _add_common(parser: argparse.ArgumentParser, top: bool = True) -> None:
    """Allow global flags after the sub-command too (``icd daemon ensure --demo``)."""
    if not top:
        parser.add_argument("--lang", choices=["auto", "zh", "zh-CN", "en"], default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        parser.add_argument("--demo", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        parser.add_argument("--ascii", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        parser.add_argument("--compact", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for child in set(action.choices.values()):
                _add_common(child, top=False)


def _peek_cli_lang(argv: list[str]) -> str:
    for i, tok in enumerate(argv):
        if tok == "--lang" and i + 1 < len(argv):
            return normalize_lang(argv[i + 1], fallback=system_lang())
        if tok.startswith("--lang="):
            return normalize_lang(tok.split("=", 1)[1], fallback=system_lang())
    return system_lang()


def _match_console_encoding() -> None:
    """When piped, encode like the parent console (e.g. UTF-8 in agent shells, GBK in a default cmd)."""
    if os.name != "nt" or os.environ.get("PYTHONIOENCODING"):
        return
    try:
        import ctypes
        cp = ctypes.windll.kernel32.GetConsoleOutputCP()
    except Exception:
        return
    if os.environ.get("ICD_UTF8") == "1":
        cp = 65001
    if not cp:
        return
    enc = "utf-8" if cp == 65001 else f"cp{cp}"
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream and not stream.isatty() and hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding=enc, errors="backslashreplace")
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    _match_console_encoding()
    raw_argv = sys.argv[1:] if argv is None else list(argv)
    set_lang(_peek_cli_lang(raw_argv))
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "lang", None):
        set_lang(normalize_lang(args.lang, fallback=system_lang()))
    Out.ascii = args.ascii or (not sys.stdout.isatty() and os.environ.get("ICD_UTF8") != "1" and
                               (sys.stdout.encoding or "").lower().replace("-", "") != "utf8")
    Out.pretty = not args.compact
    if not getattr(args, "fn", None):
        parser.print_help()
        return EXIT_USAGE
    if args.fn == "guide":
        _write(sys.stdout, GUIDE)
        return 0
    if args.fn == "serve":
        daemon.serve(port=args.port, demo=args.demo, idle_minutes=args.idle_minutes, debug=args.debug)
        return 0
    try:
        emit(args.fn(Client(args.demo), args))
        return 0
    except CliError as exc:
        err = {"error": exc.message}
        if exc.status:
            err["status"] = exc.status
        _write(sys.stderr, json.dumps(err, ensure_ascii=Out.ascii) + "\n")
        return exc.code
    except RuntimeError as exc:
        _write(sys.stderr, json.dumps({"error": str(exc)}, ensure_ascii=Out.ascii) + "\n")
        return EXIT_ERROR
    except KeyboardInterrupt:
        return 130
