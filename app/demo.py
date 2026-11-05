"""Demo mode: in-memory fake data with the same JSON shapes as the real API.

Run ``python main.py --demo`` to explore / develop the UI without an Apple ID.
"""

from __future__ import annotations

import itertools
import random
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

ROOT = "FOLDER::com.apple.CloudDocs::root"
TRASH = "FOLDER::com.apple.CloudDocs::TRASH_ROOT"
_ids = itertools.count(1)


def _id(prefix: str) -> str:
    return f"{prefix}{next(_ids)}"


def _seed() -> dict[str, Any]:
    today = date.today()
    now = datetime.now().replace(second=0, microsecond=0)

    def at(days: int, hour: int, minute: int = 0) -> str:
        d = today + timedelta(days=days)
        return f"{d.isoformat()}T{hour:02d}:{minute:02d}"

    cals = [
        {"guid": "home", "title": "家庭", "color": "#1BADF8", "read_only": False, "share_type": None, "is_default": True, "is_family": False, "ctag": "1", "order": 0},
        {"guid": "work", "title": "工作", "color": "#FF2968", "read_only": False, "share_type": None, "is_default": False, "is_family": False, "ctag": "1", "order": 1},
        {"guid": "holiday", "title": "中国节假日", "color": "#63DA38", "read_only": True, "share_type": "subscribed", "is_default": False, "is_family": False, "ctag": "1", "order": 2},
    ]
    events = []

    def ev(pguid: str, title: str, start: str, end: str, all_day: bool = False, location: str = "", recurring: bool = False) -> None:
        events.append({
            "guid": str(uuid.uuid4()).upper(), "pguid": pguid, "title": title, "location": location, "description": "", "url": "",
            "all_day": all_day, "start": start, "end": end, "tz": "Asia/Shanghai", "etag": "C=1@U=demo", "recurring": recurring,
            "read_only": pguid == "holiday", "has_invitees": False, "alarms": [],
        })

    ev("work", "周会", at(0, 10), at(0, 11), location="会议室 A", recurring=True)
    ev("work", "产品评审", at(1, 14), at(1, 15, 30))
    ev("work", "1:1", at(0, 10, 30), at(0, 11, 15))
    ev("home", "健身", at(0, 19), at(0, 20, 30), location="健身房")
    ev("home", "看牙医", at(3, 9), at(3, 10))
    ev("home", "旅行", (today + timedelta(days=5)).isoformat(), (today + timedelta(days=8)).isoformat(), all_day=True)
    ev("holiday", "周末", (today + timedelta(days=(5 - today.weekday()) % 7)).isoformat(), (today + timedelta(days=(5 - today.weekday()) % 7 + 2)).isoformat(), all_day=True)
    for i in range(-20, 30, 4):
        ev("work", f"项目同步 #{i + 21}", at(i, 16), at(i, 17))

    lists = [
        {"id": "List/inbox", "title": "提醒", "color": '{"daHexString":"#007AFF"}', "count": 4, "is_group": False, "deleted": False},
        {"id": "List/shop", "title": "购物", "color": '{"daHexString":"#FF9500"}', "count": 3, "is_group": False, "deleted": False},
    ]

    def rem(list_id: str, title: str, due: datetime | None = None, completed: bool = False, priority: int = 0, flagged: bool = False, parent: str | None = None) -> dict[str, Any]:
        r = {
            "id": _id("Reminder/"), "list_id": list_id, "title": title, "desc": "", "completed": completed, "completed_date": None,
            "due_date": due.isoformat() if due else None, "start_date": None, "priority": priority, "flagged": flagged, "all_day": False,
            "deleted": False, "time_zone": "Asia/Shanghai", "parent_reminder_id": parent, "created": now.isoformat(), "modified": now.isoformat(),
        }
        return r

    reminders = [
        rem("List/inbox", "交房租", now + timedelta(days=2), priority=1, flagged=True),
        rem("List/inbox", "回复邮件", now - timedelta(hours=3)),
        rem("List/inbox", "整理照片"),
        rem("List/inbox", "已完成的事情", completed=True),
        rem("List/shop", "牛奶"), rem("List/shop", "鸡蛋"), rem("List/shop", "咖啡豆", priority=5),
    ]
    reminders.append(rem("List/inbox", "整理 2024 年相册", parent=reminders[2]["id"]))

    folders = [
        {"id": "Folder/notes", "name": "备忘录", "has_subfolders": True, "count": 3, "parent_id": None},
        {"id": "Folder/work", "name": "工作", "has_subfolders": False, "count": 1, "parent_id": "Folder/notes"},
        {"id": "Folder/recipes", "name": "菜谱", "has_subfolders": False, "count": 1, "parent_id": None},
    ]
    notes = [
        {"id": "Note/1", "title": "欢迎使用 iCloud Desk", "snippet": "这是演示模式的备忘录", "folder_id": "Folder/notes", "folder_name": "备忘录",
         "html": "<h1>欢迎使用 iCloud Desk</h1><p>这是<b>演示模式</b>。登录真实账户后这里会显示你的 iCloud 备忘录。</p><ul><li>日历：读写</li><li>提醒事项：读写</li><li>备忘录：只读</li></ul>"},
        {"id": "Note/2", "title": "购物清单", "snippet": "苹果、香蕉", "folder_id": "Folder/notes", "folder_name": "备忘录", "html": "<h2>购物清单</h2><ul><li>苹果</li><li>香蕉</li></ul>"},
        {"id": "Note/3", "title": "会议记录", "snippet": "Q3 目标讨论", "folder_id": "Folder/work", "folder_name": "工作", "html": "<h2>会议记录</h2><p>Q3 目标讨论……</p>"},
        {"id": "Note/4", "title": "番茄炒蛋", "snippet": "鸡蛋 3 个、番茄 2 个", "folder_id": "Folder/recipes", "folder_name": "菜谱", "html": "<h2>番茄炒蛋</h2><ol><li>打蛋</li><li>炒番茄</li><li>混合</li></ol>"},
        {"id": "Note/5", "title": "密码提示", "snippet": "", "folder_id": "Folder/notes", "folder_name": "备忘录", "is_locked": True, "html": ""},
    ]
    for i, n in enumerate(notes):
        n.setdefault("is_locked", False)
        n.update({"is_deleted": False, "modified_at": (now - timedelta(days=i, hours=i * 3)).isoformat(), "text": n["snippet"], "attachments": []})
    notes[0]["attachments"] = [{"id": "att1", "filename": "说明.txt", "uti": "public.plain-text", "size": 42}]

    def node(name: str, parent: str, kind: str = "file", ext: str | None = None, size: int | None = None) -> dict[str, Any]:
        nid = f"{'FOLDER' if kind == 'folder' else 'FILE'}::com.apple.CloudDocs::{uuid.uuid4()}"
        return {"id": nid, "name": f"{name}.{ext}" if ext else name, "type": kind, "extension": ext, "size": size,
                "modified": (now - timedelta(days=random.randint(0, 90))).isoformat(), "created": None, "item_count": None,
                "shared": False, "in_trash": False, "restore_path": None, "parent": parent}

    docs = node("文稿", ROOT, "folder")
    desktop = node("桌面", ROOT, "folder")
    drive = [docs, desktop, node("简历", ROOT, ext="pdf", size=230_000), node("预算", ROOT, ext="xlsx", size=48_000),
             node("README", ROOT, ext="txt", size=1200), node("会议纪要", docs["id"], ext="docx", size=64_000),
             node("照片备份", docs["id"], "folder"), node("截图", desktop["id"], ext="png", size=380_000)]
    old = node("旧文件", TRASH, ext="txt", size=20)
    old.update({"in_trash": True, "restore_path": "iCloud Drive/文稿"})
    drive.append(old)

    albums = [{"id": "__all__", "name": "图库", "kind": "PhotoLibrary"}, {"id": "fav", "name": "个人收藏", "kind": "PhotoAlbum"}, {"id": "trip", "name": "旅行", "kind": "PhotoAlbum"}]
    photos = []
    for i in range(240):
        photos.append({"id": f"P{i}", "filename": f"IMG_{1000 + i}.HEIC", "type": "movie" if i % 17 == 0 else "image",
                       "created": (now - timedelta(hours=i * 7)).isoformat(), "size": 2_000_000 + i * 1000, "width": 4032, "height": 3024,
                       "live": i % 5 == 0, "favorite": i % 11 == 0, "albums": ["trip"] if i % 3 == 0 else []})

    contacts = [
        {"id": f"C{i}", "name": n, "first_name": n[1:], "last_name": n[0], "company": c, "job_title": None, "nickname": None, "birthday": b,
         "notes": None, "phones": [{"label": "MOBILE", "field": f"+86 138 0000 {1000 + i}"}], "emails": [{"label": "HOME", "field": f"user{i}@example.com"}],
         "addresses": [{"label": "HOME", "field": {"street": "长安街 1 号", "city": "北京", "country": "中国"}}] if i % 2 == 0 else [], "urls": [], "photo": None, "is_company": False}
        for i, (n, c, b) in enumerate([("张三", "Apple", "1990-01-01"), ("李四", None, None), ("王五", "示例公司", None), ("赵六", None, "1985-06-15"), ("Alice Wang", "Contoso", None)])
    ]

    devices = [
        {"id": "D1", "name": "我的 iPhone", "model": "iPhone 16 Pro", "device_class": "iPhone", "battery_level": 0.82, "battery_status": "NotCharging", "status": "200",
         "location": {"latitude": 39.9087, "longitude": 116.3975, "accuracy": 35, "timestamp": int(now.timestamp() * 1000), "type": "GPS"},
         "features": {"sound": True, "message": True, "lost": True}, "lost_mode": False},
        {"id": "D2", "name": "MacBook Air", "model": "MacBook Air M3", "device_class": "MacBookAir", "battery_level": 0.15, "battery_status": "Charging", "status": "200",
         "location": {"latitude": 31.2304, "longitude": 121.4737, "accuracy": 65, "timestamp": int((now - timedelta(hours=2)).timestamp() * 1000), "type": "Wifi"},
         "features": {"sound": True, "message": True, "lost": True}, "lost_mode": False},
        {"id": "D3", "name": "Apple Watch", "model": "Apple Watch Series 10", "device_class": "Watch", "battery_level": None, "battery_status": None, "status": "203",
         "location": None, "features": {"sound": True, "message": False, "lost": False}, "lost_mode": False},
    ]

    hme = [
        {"id": f"H{i}", "email": f"{w}_{i}x@icloud.com", "label": label, "note": "", "forward_to": "me@example.com", "active": active,
         "created": int((now - timedelta(days=i * 30)).timestamp() * 1000), "origin": "ON_DEMAND", "domain": ""}
        for i, (w, label, active) in enumerate([("quiet.fox", "淘宝", True), ("blue.sky", "GitHub", True), ("old.tree", "某网站", False)])
    ]
    return {"calendars": cals, "events": events, "lists": lists, "reminders": reminders, "folders": folders, "notes": notes,
            "drive": drive, "albums": albums, "photos": photos, "contacts": contacts, "devices": devices, "hme": hme}


DB = _seed()


def _photo_svg(pid: str, label: str) -> bytes:
    rnd = random.Random(pid)
    h1, h2 = rnd.randint(0, 360), rnd.randint(0, 360)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl({h1},70%,60%)"/>'
            f'<stop offset="1" stop-color="hsl({h2},70%,45%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/>'
            f'<text x="200" y="160" font-size="28" text-anchor="middle" fill="white" font-family="sans-serif">{label}</text></svg>').encode()


def _find(rows: list[dict[str, Any]], key: str, value: Any) -> dict[str, Any]:
    for r in rows:
        if r.get(key) == value:
            return r
    raise HTTPException(404, "不存在")


def install_demo(app: FastAPI) -> None:  # noqa: C901 - flat list of fake endpoints
    r = APIRouter(prefix="/api")

    # -- auth
    status = {"state": "ready", "message": "", "apple_id": "demo@icloud.com", "china_mainland": False, "password_saved": True, "two_fa": None,
              "user": {"full_name": "演示 用户", "first_name": "演示", "last_name": "用户", "apple_id": "demo@icloud.com", "locale": "zh_CN"},
              "services": ["calendar", "reminders", "notes", "drivews", "ckdatabasews", "contacts", "findme", "premiummailsettings"]}

    @r.get("/auth/status")
    def auth_status():
        return status

    @r.post("/auth/login")
    def login(body: dict):
        status.update(state="ready", apple_id=body.get("apple_id") or "demo@icloud.com")
        return status

    @r.post("/auth/2fa/request")
    def req2fa():
        return status

    @r.post("/auth/2fa/verify")
    def verify2fa(body: dict):
        status["state"] = "ready"
        return status

    @r.post("/auth/logout")
    def logout(body: dict):
        status["state"] = "logged_out"
        return status

    # -- calendar
    @r.get("/calendar/calendars")
    def calendars():
        return DB["calendars"]

    @r.post("/calendar/calendars")
    def add_calendar(body: dict):
        guid = str(uuid.uuid4())
        DB["calendars"].append({"guid": guid, "title": body["title"], "color": body.get("color", "#1BADF8"), "read_only": False, "share_type": None,
                                "is_default": False, "is_family": False, "ctag": "1", "order": len(DB["calendars"])})
        return {"guid": guid}

    @r.delete("/calendar/calendars/{guid}")
    def del_calendar(guid: str):
        DB["calendars"] = [c for c in DB["calendars"] if c["guid"] != guid]
        DB["events"] = [e for e in DB["events"] if e["pguid"] != guid]
        return {"ok": True}

    @r.get("/calendar/events")
    def events(start: str, end: str):
        return [e for e in DB["events"] if e["start"][:10] < end and (e["end"] or e["start"])[:10] >= start]

    @r.get("/calendar/events/{pguid}/{guid}")
    def event(pguid: str, guid: str):
        return {**_find(DB["events"], "guid", guid), "invitees": [], "alarm_records": []}

    def _apply(e: dict[str, Any], body: dict[str, Any]) -> None:
        end = body["end"]
        if body.get("all_day"):
            end = (date.fromisoformat(end[:10]) + timedelta(days=1)).isoformat()
        e.update(pguid=body["pguid"], title=body.get("title") or "新建日程", start=body["start"], end=end, all_day=bool(body.get("all_day")),
                 location=body.get("location", ""), description=body.get("description", ""))

    @r.post("/calendar/events")
    def add_event(body: dict):
        e = {"guid": str(uuid.uuid4()).upper(), "tz": "Asia/Shanghai", "etag": "x", "recurring": False, "read_only": False, "has_invitees": False, "alarms": [], "url": ""}
        _apply(e, body)
        DB["events"].append(e)
        return {"guid": e["guid"], "pguid": e["pguid"]}

    @r.put("/calendar/events/{pguid}/{guid}")
    def put_event(pguid: str, guid: str, body: dict):
        _apply(_find(DB["events"], "guid", guid), body)
        return {"guid": guid, "pguid": body["pguid"]}

    @r.delete("/calendar/events/{pguid}/{guid}")
    def del_event(pguid: str, guid: str, etag: str | None = None):
        DB["events"] = [e for e in DB["events"] if e["guid"] != guid]
        return {"ok": True}

    # -- reminders
    @r.get("/reminders/lists")
    def rlists():
        for lst in DB["lists"]:
            lst["count"] = sum(1 for x in DB["reminders"] if x["list_id"] == lst["id"] and not x["completed"])
        return DB["lists"]

    @r.get("/reminders")
    def rlist(list_id: str, include_completed: bool = False, limit: int = 500):
        return [x for x in DB["reminders"] if x["list_id"] == list_id and (include_completed or not x["completed"])]

    @r.post("/reminders")
    def radd(body: dict):
        x = {"id": _id("Reminder/"), "list_id": body["list_id"], "title": body["title"], "desc": body.get("desc", ""), "completed": False,
             "due_date": body.get("due_date"), "priority": body.get("priority", 0), "flagged": body.get("flagged", False), "all_day": body.get("all_day", False),
             "parent_reminder_id": body.get("parent_reminder_id"), "created": datetime.now().isoformat(), "deleted": False}
        DB["reminders"].append(x)
        return x

    @r.get("/reminders/item/{rid:path}")
    def rget(rid: str):
        return _find(DB["reminders"], "id", rid)

    @r.patch("/reminders/item/{rid:path}")
    def rpatch(rid: str, body: dict):
        x = _find(DB["reminders"], "id", rid)
        for k in ("title", "desc", "completed", "all_day", "priority", "flagged", "list_id"):
            if body.get(k) is not None:
                x[k] = body[k]
        if body.get("clear_due_date"):
            x["due_date"] = None
        elif body.get("due_date"):
            x["due_date"] = body["due_date"]
        return x

    @r.delete("/reminders/item/{rid:path}")
    def rdel(rid: str):
        DB["reminders"] = [x for x in DB["reminders"] if x["id"] != rid]
        return {"ok": True}

    # -- notes
    @r.get("/notes/folders")
    def nfolders():
        return DB["folders"]

    @r.get("/notes")
    def nlist(folder_id: str | None = None, limit: int = 200):
        rows = [n for n in DB["notes"] if not folder_id or n["folder_id"] == folder_id]
        return [{k: v for k, v in n.items() if k not in ("html", "text", "attachments")} for n in rows][:limit]

    @r.get("/notes/item/{nid:path}")
    def nget(nid: str):
        n = _find(DB["notes"], "id", nid)
        if n["is_locked"]:
            raise HTTPException(423, "这条备忘录已加锁，无法通过网页接口读取")
        return n

    @r.get("/notes/attachment/{nid:path}")
    def natt(nid: str, att_id: str):
        return Response("演示附件内容 / demo attachment content\n".encode(), media_type="application/octet-stream",
                        headers={"Content-Disposition": "attachment; filename*=UTF-8''demo.txt"})

    # -- drive
    def _children(parent: str) -> list[dict[str, Any]]:
        out = []
        for it in DB["drive"]:
            if it["parent"] == parent:
                row = dict(it)
                if row["type"] == "folder":
                    row["item_count"] = sum(1 for x in DB["drive"] if x["parent"] == it["id"])
                out.append(row)
        return out

    @r.get("/drive/list")
    def dlist(id: str = ROOT):
        folder = {"id": ROOT, "name": "iCloud 云盘", "parent": None, "type": "folder"} if id == ROOT else {**_find(DB["drive"], "id", id)}
        return {"folder": folder, "items": _children(id)}

    @r.get("/drive/trash")
    def dtrash():
        return {"folder": {"id": TRASH, "name": "最近删除", "parent": None, "type": "trash"}, "items": _children(TRASH)}

    @r.get("/drive/apps")
    def dapps():
        return [{"id": "FOLDER::com.apple.Pages::documents", "name": "Pages 文稿", "type": "app_library", "extension": None, "size": None,
                 "modified": None, "created": None, "item_count": 0, "shared": False, "in_trash": False, "restore_path": None}]

    @r.get("/drive/download")
    def ddownload(id: str, inline: bool = False):
        it = _find(DB["drive"], "id", id)
        from urllib.parse import quote

        kind = "inline" if inline else "attachment"
        return Response(f"演示文件：{it['name']}\n".encode(), media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": f"{kind}; filename*=UTF-8''{quote(it['name'])}"})

    @r.post("/drive/upload")
    async def dupload(folder: str = Form(...), files: list[UploadFile] = File(...)):
        for f in files:
            data = await f.read()
            name, _, ext = (f.filename or "file").rpartition(".")
            DB["drive"].append({"id": f"FILE::com.apple.CloudDocs::{uuid.uuid4()}", "name": f.filename, "type": "file", "extension": ext if name else None,
                                "size": len(data), "modified": datetime.now().isoformat(), "created": None, "item_count": None, "shared": False,
                                "in_trash": False, "restore_path": None, "parent": folder})
        return {"ok": True}

    @r.post("/drive/mkdir")
    def dmkdir(body: dict):
        DB["drive"].append({"id": f"FOLDER::com.apple.CloudDocs::{uuid.uuid4()}", "name": body["name"], "type": "folder", "extension": None, "size": None,
                            "modified": datetime.now().isoformat(), "created": None, "item_count": 0, "shared": False, "in_trash": False,
                            "restore_path": None, "parent": body["id"]})
        return {"ok": True}

    @r.post("/drive/rename")
    def drename(body: dict):
        _find(DB["drive"], "id", body["id"])["name"] = body["name"]
        return {"ok": True}

    @r.post("/drive/move")
    def dmove(body: dict):
        for i in body["ids"]:
            _find(DB["drive"], "id", i)["parent"] = body["dest"]
        return {"ok": True}

    @r.post("/drive/trash")
    def dtrash_items(body: dict):
        for i in body["ids"]:
            it = _find(DB["drive"], "id", i)
            it.update(parent=TRASH, in_trash=True, restore_path="iCloud Drive", _from=it["parent"])
        return {"ok": True}

    @r.post("/drive/recover")
    def drecover(body: dict):
        for i in body["ids"]:
            it = _find(DB["drive"], "id", i)
            it.update(parent=it.pop("_from", ROOT), in_trash=False, restore_path=None)
        return {"ok": True}

    @r.post("/drive/delete-forever")
    def dforever(body: dict):
        DB["drive"] = [x for x in DB["drive"] if x["id"] not in body["ids"]]
        return {"ok": True}

    # -- photos
    @r.get("/photos/albums")
    def palbums():
        return DB["albums"]

    @r.get("/photos/list")
    def plist(album: str = "__all__", offset: int = 0, limit: int = 60):
        rows = [p for p in DB["photos"] if album == "__all__" or (album == "fav" and p["favorite"]) or album in p["albums"]]
        return {"items": [{k: v for k, v in p.items() if k != "albums"} for p in rows[offset:offset + limit]], "has_more": len(rows) > offset + limit}

    @r.get("/photos/file")
    def pfile(id: str, version: str = "thumb", download: bool = False):
        p = _find(DB["photos"], "id", id)
        headers = {"Content-Disposition": f"attachment; filename={id}.svg"} if download else {}
        return Response(_photo_svg(id, p["filename"]), media_type="image/svg+xml", headers=headers)

    @r.post("/photos/favorite")
    def pfav(body: dict):
        _find(DB["photos"], "id", body["id"])["favorite"] = body.get("value", True)
        return {"ok": True}

    @r.delete("/photos/item")
    def pdel(id: str):
        DB["photos"] = [p for p in DB["photos"] if p["id"] != id]
        return {"ok": True}

    @r.post("/photos/upload")
    async def pupload(album: str = Form(""), files: list[UploadFile] = File(...)):
        for f in files:
            DB["photos"].insert(0, {"id": _id("P"), "filename": f.filename, "type": "image", "created": datetime.now().isoformat(), "size": 0,
                                    "width": None, "height": None, "live": False, "favorite": False, "albums": [album] if album else []})
        return {"ok": True, "count": len(files)}

    @r.post("/photos/refresh")
    def prefresh():
        return {"ok": True}

    # -- contacts
    @r.get("/contacts")
    def contacts():
        return DB["contacts"]

    # -- find my
    @r.get("/findmy/devices")
    def devices(refresh: bool = False):
        return DB["devices"]

    @r.post("/findmy/devices/{device_id}/sound")
    def sound(device_id: str):
        return {"ok": True}

    @r.post("/findmy/devices/{device_id}/message")
    def msg(device_id: str, body: dict):
        return {"ok": True}

    @r.post("/findmy/devices/{device_id}/lost")
    def lost(device_id: str, body: dict):
        _find(DB["devices"], "id", device_id)["lost_mode"] = True
        return {"ok": True}

    # -- hide my email
    @r.get("/hme")
    def hme():
        return DB["hme"]

    @r.post("/hme/generate")
    def hgen():
        return {"email": f"{random.choice(['calm', 'swift', 'bright'])}.{random.choice(['river', 'cloud', 'stone'])}_{random.randint(10, 99)}@icloud.com"}

    @r.post("/hme")
    def hadd(body: dict):
        a = {"id": _id("H"), "email": body["email"], "label": body["label"], "note": body.get("note", ""), "forward_to": "me@example.com",
             "active": True, "created": int(datetime.now().timestamp() * 1000), "origin": "ON_DEMAND", "domain": ""}
        DB["hme"].insert(0, a)
        return a

    @r.patch("/hme/{anon_id}")
    def hpatch(anon_id: str, body: dict):
        _find(DB["hme"], "id", anon_id).update(label=body.get("label"), note=body.get("note"))
        return {"ok": True}

    @r.post("/hme/{anon_id}/deactivate")
    def hdeact(anon_id: str):
        _find(DB["hme"], "id", anon_id)["active"] = False
        return {"ok": True}

    @r.post("/hme/{anon_id}/reactivate")
    def hreact(anon_id: str):
        _find(DB["hme"], "id", anon_id)["active"] = True
        return {"ok": True}

    @r.delete("/hme/{anon_id}")
    def hdel(anon_id: str):
        DB["hme"] = [a for a in DB["hme"] if a["id"] != anon_id]
        return {"ok": True}

    # -- account
    @r.get("/account")
    def account():
        gb = 1024 ** 3
        return {
            "storage": {"used": 120 * gb, "available": 80 * gb, "total": 200 * gb, "percent": 60, "by_media": [
                {"key": "photos", "label": "照片和视频", "color": "ffcc00", "bytes": 80 * gb},
                {"key": "backup", "label": "备份", "color": "5856d6", "bytes": 25 * gb},
                {"key": "docs", "label": "文稿", "color": "ff9500", "bytes": 10 * gb},
                {"key": "mail", "label": "邮件", "color": "007aff", "bytes": 5 * gb}]},
            "devices": [{"name": d["name"], "model": d["model"], "serial": "XXXX", "image": None} for d in DB["devices"]],
            "family": [{"name": "演示 家人", "apple_id": "family@icloud.com", "dsid": "1"}],
        }

    app.include_router(r)
