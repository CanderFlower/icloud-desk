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

from .i18n import get_lang, is_en, tr

ROOT = "FOLDER::com.apple.CloudDocs::root"
TRASH = "FOLDER::com.apple.CloudDocs::TRASH_ROOT"
_ids = itertools.count(1)


def _id(prefix: str) -> str:
    return f"{prefix}{next(_ids)}"


def _seed(en: bool = False) -> dict[str, Any]:
    L = (lambda zh, eng: eng) if en else (lambda zh, eng: zh)
    today = date.today()
    now = datetime.now().replace(second=0, microsecond=0)

    def at(days: int, hour: int, minute: int = 0) -> str:
        d = today + timedelta(days=days)
        return f"{d.isoformat()}T{hour:02d}:{minute:02d}"

    cals = [
        {"guid": "home", "title": L("家庭", "Home"), "color": "#1BADF8", "read_only": False, "share_type": None, "is_default": True, "is_family": False, "ctag": "1", "order": 0},
        {"guid": "work", "title": L("工作", "Work"), "color": "#FF2968", "read_only": False, "share_type": None, "is_default": False, "is_family": False, "ctag": "1", "order": 1},
        {"guid": "holiday", "title": L("中国节假日", "Holidays"), "color": "#63DA38", "read_only": True, "share_type": "subscribed", "is_default": False, "is_family": False, "ctag": "1", "order": 2},
    ]
    events = []

    def ev(pguid: str, title: str, start: str, end: str, all_day: bool = False, location: str = "", recurring: bool = False) -> None:
        events.append({
            "guid": str(uuid.uuid4()).upper(), "pguid": pguid, "title": title, "location": location, "description": "", "url": "",
            "all_day": all_day, "start": start, "end": end, "tz": "Asia/Shanghai", "etag": "C=1@U=demo", "recurring": recurring,
            "read_only": pguid == "holiday", "has_invitees": False, "alarms": [],
        })

    ev("work", L("周会", "Weekly Sync"), at(0, 10), at(0, 11), location=L("会议室 A", "Room A"), recurring=True)
    ev("work", L("产品评审", "Product Review"), at(1, 14), at(1, 15, 30))
    ev("work", "1:1", at(0, 10, 30), at(0, 11, 15))
    ev("home", L("健身", "Workout"), at(0, 19), at(0, 20, 30), location=L("健身房", "Gym"))
    ev("home", L("看牙医", "Dentist"), at(3, 9), at(3, 10))
    ev("home", L("旅行", "Trip"), (today + timedelta(days=5)).isoformat(), (today + timedelta(days=8)).isoformat(), all_day=True)
    ev("holiday", L("周末", "Weekend"), (today + timedelta(days=(5 - today.weekday()) % 7)).isoformat(), (today + timedelta(days=(5 - today.weekday()) % 7 + 2)).isoformat(), all_day=True)
    for i in range(-20, 30, 4):
        ev("work", L(f"项目同步 #{i + 21}", f"Project Sync #{i + 21}"), at(i, 16), at(i, 17))

    lists = [
        {"id": "List/inbox", "title": L("提醒", "Reminders"), "color": '{"daHexString":"#007AFF"}', "count": 4, "is_group": False, "deleted": False},
        {"id": "List/shop", "title": L("购物", "Groceries"), "color": '{"daHexString":"#FF9500"}', "count": 3, "is_group": False, "deleted": False},
    ]

    def rem(list_id: str, title: str, due: datetime | None = None, completed: bool = False, priority: int = 0, flagged: bool = False, parent: str | None = None) -> dict[str, Any]:
        return {
            "id": _id("Reminder/"), "list_id": list_id, "title": title, "desc": "", "completed": completed, "completed_date": None,
            "due_date": due.isoformat() if due else None, "start_date": None, "priority": priority, "flagged": flagged, "all_day": False,
            "deleted": False, "time_zone": "Asia/Shanghai", "parent_reminder_id": parent, "created": now.isoformat(), "modified": now.isoformat(),
        }

    reminders = [
        rem("List/inbox", L("交房租", "Pay rent"), now + timedelta(days=2), priority=1, flagged=True),
        rem("List/inbox", L("回复邮件", "Reply to emails"), now - timedelta(hours=3)),
        rem("List/inbox", L("整理照片", "Organize photos")),
        rem("List/inbox", L("已完成的事情", "Completed task"), completed=True),
        rem("List/shop", L("牛奶", "Milk")), rem("List/shop", L("鸡蛋", "Eggs")), rem("List/shop", L("咖啡豆", "Coffee beans"), priority=5),
    ]
    reminders.append(rem("List/inbox", L("整理 2024 年相册", "Sort 2024 album"), parent=reminders[2]["id"]))

    folders = [
        {"id": "Folder/notes", "name": L("备忘录", "Notes"), "has_subfolders": True, "count": 3, "parent_id": None},
        {"id": "Folder/work", "name": L("工作", "Work"), "has_subfolders": False, "count": 1, "parent_id": "Folder/notes"},
        {"id": "Folder/recipes", "name": L("菜谱", "Recipes"), "has_subfolders": False, "count": 1, "parent_id": None},
        {"id": "TrashFolder-CloudKit", "name": L("最近删除", "Recently Deleted"), "has_subfolders": False, "count": 0, "parent_id": None},
    ]
    notes = [
        {"id": "Note/1", "title": L("欢迎使用 iCloud Desk", "Welcome to iCloud Desk"),
         "snippet": L("这是演示模式的备忘录", "Sample note in demo mode"),
         "folder_id": "Folder/notes", "folder_name": L("备忘录", "Notes"),
         "html": L(
             "<h1>欢迎使用 iCloud Desk</h1><p>这是<b>演示模式</b>。登录真实账户后这里会显示你的 iCloud 备忘录。</p><ul><li>日历：读写</li><li>提醒事项：读写</li><li>备忘录：读写</li></ul>",
             "<h1>Welcome to iCloud Desk</h1><p>This is <b>Demo Mode</b>. Sign in with your Apple Account to view and edit your iCloud Notes.</p><ul><li>Calendar: Read/Write</li><li>Reminders: Read/Write</li><li>Notes: Read/Write</li></ul>",
         )},
        {"id": "Note/2", "title": L("购物清单", "Grocery List"), "snippet": L("苹果、香蕉", "Apples, bananas"), "folder_id": "Folder/notes", "folder_name": L("备忘录", "Notes"),
         "html": L("<h2>购物清单</h2><ul><li>苹果</li><li>香蕉</li></ul>", "<h2>Grocery List</h2><ul><li>Apples</li><li>Bananas</li></ul>")},
        {"id": "Note/3", "title": L("会议记录", "Meeting Notes"), "snippet": L("Q3 目标讨论", "Q3 roadmap discussion"), "folder_id": "Folder/work", "folder_name": L("工作", "Work"),
         "html": L("<h2>会议记录</h2><p>Q3 目标讨论……</p>", "<h2>Meeting Notes</h2><p>Q3 roadmap discussion…</p>")},
        {"id": "Note/4", "title": L("番茄炒蛋", "Scrambled Eggs & Tomatoes"), "snippet": L("鸡蛋 3 个、番茄 2 个", "3 eggs, 2 tomatoes"), "folder_id": "Folder/recipes", "folder_name": L("菜谱", "Recipes"),
         "html": L("<h2>番茄炒蛋</h2><ol><li>打蛋</li><li>炒番茄</li><li>混合</li></ol>", "<h2>Scrambled Eggs & Tomatoes</h2><ol><li>Beat eggs</li><li>Stir-fry tomatoes</li><li>Combine</li></ol>")},
        {"id": "Note/5", "title": L("密码提示", "Password Hints"), "snippet": "", "folder_id": "Folder/notes", "folder_name": L("备忘录", "Notes"), "is_locked": True, "html": ""},
    ]
    md = {
        "Note/1": L(
            "# 欢迎使用 iCloud Desk\n这是**演示模式**。登录真实账户后这里会显示你的 iCloud 备忘录。\n- 日历：读写\n- 提醒事项：读写\n- 备忘录：读写\n\uFFFC",
            "# Welcome to iCloud Desk\nThis is **Demo Mode**. Sign in with your Apple Account to view and edit your iCloud Notes.\n- Calendar: Read/Write\n- Reminders: Read/Write\n- Notes: Read/Write\n\uFFFC",
        ),
        "Note/2": L(
            "# 购物清单\n周末去超市\n- [x] 苹果\n- [ ] 香蕉\n- [ ] 牛奶\n- [ ] 咖啡豆",
            "# Grocery List\nWeekend market run\n- [x] Apples\n- [ ] Bananas\n- [ ] Milk\n- [ ] Coffee beans",
        ),
        "Note/3": L(
            "# 会议记录\n## Q3 目标讨论\n1. 完成 Windows 客户端\n2. 接入命令行\n  - 供 Agent 调用\n> 下次会议：周五 10:00",
            "# Meeting Notes\n## Q3 Roadmap\n1. Ship Windows desktop client\n2. Add JSON CLI\n  - Ready for AI agents\n> Next sync: Friday 10:00",
        ),
        "Note/4": L(
            "# 番茄炒蛋\n鸡蛋 3 个、番茄 2 个\n### 步骤\n1. 打蛋\n2. 炒番茄\n3. 混合出锅",
            "# Scrambled Eggs & Tomatoes\n3 eggs, 2 tomatoes\n### Steps\n1. Beat eggs\n2. Stir-fry tomatoes\n3. Combine and serve",
        ),
        "Note/5": "",
    }
    for i, n in enumerate(notes):
        n.setdefault("is_locked", False)
        n.update({"is_deleted": False, "modified_at": (now - timedelta(days=i, hours=i * 3)).isoformat(), "text": n["snippet"], "attachments": [],
                  "markdown": md[n["id"]], "editable": True, "edit_blocker": None, "edit_blocker_code": None, "edit_warnings": [], "change_tag": "t1"})
    notes[0]["attachments"] = [{"id": "att1", "filename": L("说明.txt", "readme.txt"), "uti": "public.plain-text", "size": 42}]
    notes[0].update(editable=False, edit_blocker_code="attachments", edit_blocker=L("这条备忘录包含附件，在此编辑会移除附件", "This note contains attachments that would be removed on save"))

    def node(name: str, parent: str, kind: str = "file", ext: str | None = None, size: int | None = None) -> dict[str, Any]:
        nid = f"{'FOLDER' if kind == 'folder' else 'FILE'}::com.apple.CloudDocs::{uuid.uuid4()}"
        return {"id": nid, "name": f"{name}.{ext}" if ext else name, "type": kind, "extension": ext, "size": size,
                "modified": (now - timedelta(days=random.randint(0, 90))).isoformat(), "created": None, "item_count": None,
                "shared": False, "in_trash": False, "restore_path": None, "parent": parent}

    docs = node(L("文稿", "Documents"), ROOT, "folder")
    desktop = node(L("桌面", "Desktop"), ROOT, "folder")
    drive = [docs, desktop, node(L("简历", "Resume"), ROOT, ext="pdf", size=230_000), node(L("预算", "Budget"), ROOT, ext="xlsx", size=48_000),
             node("README", ROOT, ext="txt", size=1200), node(L("会议纪要", "Minutes"), docs["id"], ext="docx", size=64_000),
             node(L("照片备份", "Photo Backup"), docs["id"], "folder"), node(L("截图", "Screenshot"), desktop["id"], ext="png", size=380_000)]
    old = node(L("旧文件", "old-notes"), TRASH, ext="txt", size=20)
    old.update({"in_trash": True, "restore_path": L("iCloud Drive/文稿", "iCloud Drive/Documents")})
    drive.append(old)

    albums = [{"id": "__all__", "name": L("图库", "Library"), "kind": "PhotoLibrary"}, {"id": "fav", "name": L("个人收藏", "Favorites"), "kind": "PhotoAlbum"}, {"id": "trip", "name": L("旅行", "Trips"), "kind": "PhotoAlbum"}]
    photos = []
    for i in range(240):
        photos.append({"id": f"P{i}", "filename": f"IMG_{1000 + i}.HEIC", "type": "movie" if i % 17 == 0 else "image",
                       "created": (now - timedelta(hours=i * 7)).isoformat(), "size": 2_000_000 + i * 1000, "width": 4032, "height": 3024,
                       "live": i % 5 == 0, "favorite": i % 11 == 0, "albums": ["trip"] if i % 3 == 0 else []})

    people = [("Alex Rivera", "Apple", "1990-01-01"), ("Jordan Lee", None, None), ("Taylor Morgan", "Contoso", None), ("Casey Chen", None, "1985-06-15"), ("Alice Wang", "Fabrikam", None)] if en else [("张三", "Apple", "1990-01-01"), ("李四", None, None), ("王五", "示例公司", None), ("赵六", None, "1985-06-15"), ("Alice Wang", "Contoso", None)]
    contacts = [
        {"id": f"C{i}", "name": n, "first_name": n.split()[0] if " " in n else n[1:], "last_name": n.split()[-1] if " " in n else n[0], "company": c, "job_title": None, "nickname": None, "birthday": b,
         "notes": None, "phones": [{"label": "MOBILE", "field": f"+86 138 0000 {1000 + i}"}], "emails": [{"label": "HOME", "field": f"user{i}@example.com"}],
         "addresses": [{"label": "HOME", "field": {"street": L("长安街 1 号", "1 Infinite Loop"), "city": L("北京", "Cupertino"), "country": L("中国", "United States")}}] if i % 2 == 0 else [], "urls": [], "photo": None, "is_company": False}
        for i, (n, c, b) in enumerate(people)
    ]

    devices = [
        {"id": "D1", "name": L("我的 iPhone", "My iPhone"), "model": "iPhone 16 Pro", "device_class": "iPhone", "battery_level": 0.82, "battery_status": "NotCharging", "status": "200",
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
        for i, (w, label, active) in enumerate([("quiet.fox", L("淘宝", "Shopping"), True), ("blue.sky", "GitHub", True), ("old.tree", L("某网站", "Newsletter"), False)])
    ]
    return {"calendars": cals, "events": events, "lists": lists, "reminders": reminders, "folders": folders, "notes": notes,
            "drive": drive, "albums": albums, "photos": photos, "contacts": contacts, "devices": devices, "hme": hme}


_DBS = {"zh-CN": _seed(False), "en": _seed(True)}


def _db() -> dict[str, Any]:
    return _DBS["en" if is_en() else "zh-CN"]


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
    raise HTTPException(404, tr("不存在", "Not found"))


def install_demo(app: FastAPI) -> None:  # noqa: C901 - flat list of fake endpoints
    r = APIRouter(prefix="/api")

    # -- auth
    status = {"state": "ready", "message": "", "apple_id": "demo@icloud.com", "china_mainland": False, "password_saved": True, "two_fa": None,
              "services": ["calendar", "reminders", "notes", "drivews", "ckdatabasews", "contacts", "findme", "premiummailsettings"]}

    def _status_out() -> dict[str, Any]:
        return {
            **status,
            "user": {
                "full_name": tr("演示 用户", "Demo User"),
                "first_name": tr("演示", "Demo"),
                "last_name": tr("用户", "User"),
                "apple_id": status.get("apple_id") or "demo@icloud.com",
                "locale": "en_US" if is_en() else "zh_CN",
            },
        }

    @r.get("/auth/status")
    def auth_status():
        return _status_out()

    @r.post("/auth/login")
    def login(body: dict):
        status.update(state="ready", apple_id=body.get("apple_id") or "demo@icloud.com")
        return _status_out()

    @r.post("/auth/2fa/request")
    def req2fa():
        return _status_out()

    @r.post("/auth/2fa/verify")
    def verify2fa(body: dict):
        status["state"] = "ready"
        return _status_out()

    @r.post("/auth/logout")
    def logout(body: dict):
        status["state"] = "logged_out"
        return _status_out()

    # -- calendar
    @r.get("/calendar/calendars")
    def calendars():
        return _db()["calendars"]

    @r.post("/calendar/calendars")
    def add_calendar(body: dict):
        guid = str(uuid.uuid4())
        _db()["calendars"].append({"guid": guid, "title": body["title"], "color": body.get("color", "#1BADF8"), "read_only": False, "share_type": None,
                                   "is_default": False, "is_family": False, "ctag": "1", "order": len(_db()["calendars"])})
        return {"guid": guid}

    @r.delete("/calendar/calendars/{guid}")
    def del_calendar(guid: str):
        db = _db()
        db["calendars"] = [c for c in db["calendars"] if c["guid"] != guid]
        db["events"] = [e for e in db["events"] if e["pguid"] != guid]
        return {"ok": True}

    @r.get("/calendar/events")
    def events(start: str, end: str):
        return [e for e in _db()["events"] if e["start"][:10] < end and (e["end"] or e["start"])[:10] >= start]

    @r.get("/calendar/events/{pguid}/{guid}")
    def event(pguid: str, guid: str):
        return {**_find(_db()["events"], "guid", guid), "invitees": [], "alarm_records": []}

    def _apply(e: dict[str, Any], body: dict[str, Any]) -> None:
        end = body["end"]
        if body.get("all_day"):
            end = (date.fromisoformat(end[:10]) + timedelta(days=1)).isoformat()
        e.update(pguid=body["pguid"], title=body.get("title") or tr("新建日程", "New Event"), start=body["start"], end=end, all_day=bool(body.get("all_day")),
                 location=body.get("location", ""), description=body.get("description", ""))

    @r.post("/calendar/events")
    def add_event(body: dict):
        e = {"guid": str(uuid.uuid4()).upper(), "tz": "Asia/Shanghai", "etag": "x", "recurring": False, "read_only": False, "has_invitees": False, "alarms": [], "url": ""}
        _apply(e, body)
        _db()["events"].append(e)
        return {"guid": e["guid"], "pguid": e["pguid"]}

    @r.put("/calendar/events/{pguid}/{guid}")
    def put_event(pguid: str, guid: str, body: dict):
        _apply(_find(_db()["events"], "guid", guid), body)
        return {"guid": guid, "pguid": body["pguid"]}

    @r.delete("/calendar/events/{pguid}/{guid}")
    def del_event(pguid: str, guid: str, etag: str | None = None):
        db = _db()
        db["events"] = [e for e in db["events"] if e["guid"] != guid]
        return {"ok": True}

    # -- reminders
    @r.get("/reminders/lists")
    def rlists():
        db = _db()
        for lst in db["lists"]:
            lst["count"] = sum(1 for x in db["reminders"] if x["list_id"] == lst["id"] and not x["completed"])
        return db["lists"]

    @r.get("/reminders")
    def rlist(list_id: str, include_completed: bool = False, limit: int = 500):
        return [x for x in _db()["reminders"] if x["list_id"] == list_id and (include_completed or not x["completed"])]

    @r.post("/reminders")
    def radd(body: dict):
        x = {"id": _id("Reminder/"), "list_id": body["list_id"], "title": body["title"], "desc": body.get("desc", ""), "completed": False,
             "due_date": body.get("due_date"), "priority": body.get("priority", 0), "flagged": body.get("flagged", False), "all_day": body.get("all_day", False),
             "parent_reminder_id": body.get("parent_reminder_id"), "created": datetime.now().isoformat(), "deleted": False}
        _db()["reminders"].append(x)
        return x

    @r.get("/reminders/item/{rid:path}")
    def rget(rid: str):
        return _find(_db()["reminders"], "id", rid)

    @r.patch("/reminders/item/{rid:path}")
    def rpatch(rid: str, body: dict):
        x = _find(_db()["reminders"], "id", rid)
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
        db = _db()
        db["reminders"] = [x for x in db["reminders"] if x["id"] != rid]
        return {"ok": True}

    # -- notes
    @r.get("/notes/folders")
    def nfolders():
        return _db()["folders"]

    @r.get("/notes")
    def nlist(folder_id: str | None = None, limit: int = 200):
        rows = [n for n in _db()["notes"] if (n["folder_id"] == folder_id if folder_id else n["folder_id"] != "TrashFolder-CloudKit")]
        return [{k: v for k, v in n.items() if k not in ("html", "text", "attachments", "markdown")} for n in rows][:limit]

    @r.get("/notes/item/{nid:path}")
    def nget(nid: str):
        n = _find(_db()["notes"], "id", nid)
        if n["is_locked"]:
            raise HTTPException(423, tr("这条备忘录已加锁，无法通过网页接口读取", "This note is locked and cannot be read via the web API"))
        return n

    @r.get("/notes/attachment/{nid:path}")
    def natt(nid: str, att_id: str):
        return Response("演示附件内容 / demo attachment content\n".encode(), media_type="application/octet-stream",
                        headers={"Content-Disposition": "attachment; filename*=UTF-8''demo.txt"})

    def _ntext(text: str) -> tuple[str, str]:
        import re as _re
        lines = [_re.sub(r"^(#{1,6}\s+|\s*(- \[[ x]\] |- |\* |\d+\. |> ))", "", ln).strip() for ln in (text or "").split("\n")]
        lines = [ln.replace("\uFFFC", "").replace("**", "") for ln in lines]
        title = next((ln for ln in lines if ln), "") or tr("新备忘录", "New Note")
        rest = [ln for ln in lines if ln]
        return title[:120], (" ".join(rest[1:])[:120] if len(rest) > 1 else tr("无附加文本", "No additional text"))

    def _fname(fid: str) -> str:
        return next((f["name"] for f in _db()["folders"] if f["id"] == fid), "")

    def _recount() -> None:
        db = _db()
        for f in db["folders"]:
            f["count"] = sum(1 for n in db["notes"] if n["folder_id"] == f["id"])
            f["has_subfolders"] = any(x.get("parent_id") == f["id"] for x in db["folders"])

    @r.post("/notes/notes")
    def ncreate(body: dict):
        fid = body.get("folder_id") or "Folder/notes"
        text = body.get("text") or ""
        title, snippet = _ntext(text)
        n = {"id": _id("Note/"), "title": title, "snippet": snippet, "folder_id": fid, "folder_name": _fname(fid), "is_locked": False,
             "is_deleted": False, "modified_at": datetime.now().astimezone().isoformat(), "text": text, "attachments": [], "html": None,
             "markdown": text, "editable": True, "edit_blocker": None, "edit_blocker_code": None, "edit_warnings": [], "change_tag": _id("t")}
        _db()["notes"].insert(0, n)
        _recount()
        return n

    @r.patch("/notes/item/{nid:path}")
    def nupdate(nid: str, body: dict):
        db = _db()
        n = _find(db["notes"], "id", nid)
        if n["is_locked"]:
            raise HTTPException(423, tr("这条备忘录已加锁，无法通过网页接口编辑", "This note is locked and cannot be edited via the web API"))
        tag = body.get("change_tag")
        if tag and tag != n["change_tag"]:
            raise HTTPException(409, tr("备忘录已在其他设备上被修改，请刷新后重试", "This note was modified on another device. Refresh and try again."))
        if not n["editable"] and not body.get("force"):
            raise HTTPException(409, f"{n['edit_blocker']}" + tr("；如确认要覆盖，请使用 force=true", "; pass force=true to overwrite"))
        text = body.get("text") or ""
        title, snippet = _ntext(text)
        n.update(title=title, snippet=snippet, text=text, markdown=text.replace("\uFFFC", ""), html=None, attachments=[], editable=True,
                 edit_blocker=None, edit_blocker_code=None, change_tag=_id("t"), modified_at=datetime.now().astimezone().isoformat())
        db["notes"].remove(n)
        db["notes"].insert(0, n)
        return n

    @r.delete("/notes/item/{nid:path}")
    def ndelete(nid: str, permanent: bool = False):
        db = _db()
        n = _find(db["notes"], "id", nid)
        if permanent or n["folder_id"] == "TrashFolder-CloudKit":
            db["notes"].remove(n)
        else:
            n.update(folder_id="TrashFolder-CloudKit", folder_name=tr("最近删除", "Recently Deleted"))
        _recount()
        return {"ok": True, "id": nid, "permanent": permanent}

    @r.post("/notes/move")
    def nmove(body: dict):
        n = _find(_db()["notes"], "id", body["id"])
        n.update(folder_id=body["folder_id"], folder_name=_fname(body["folder_id"]))
        _recount()
        return {"ok": True, "id": n["id"], "folder_id": n["folder_id"]}

    @r.post("/notes/folders")
    def nfcreate(body: dict):
        title = (body.get("title") or body.get("name") or "").strip()
        if not title:
            raise HTTPException(400, tr("文件夹名称不能为空", "Folder name cannot be empty"))
        f = {"id": _id("Folder/"), "name": title, "has_subfolders": False, "count": 0, "parent_id": body.get("parent_id")}
        _db()["folders"].append(f)
        _recount()
        return {**f, "title": title}

    @r.patch("/notes/folders/{fid:path}")
    def nfrename(fid: str, body: dict):
        if fid in ("Folder/notes", "TrashFolder-CloudKit"):
            raise HTTPException(400, tr("系统文件夹不能重命名", "System folders cannot be renamed"))
        db = _db()
        f = _find(db["folders"], "id", fid)
        f["name"] = (body.get("title") or body.get("name") or "").strip() or f["name"]
        for n in db["notes"]:
            if n["folder_id"] == fid:
                n["folder_name"] = f["name"]
        return {**f, "title": f["name"]}

    @r.delete("/notes/folders/{fid:path}")
    def nfdelete(fid: str):
        if fid in ("Folder/notes", "TrashFolder-CloudKit"):
            raise HTTPException(400, tr("系统文件夹不能删除", "System folders cannot be deleted"))
        db = _db()
        ids = {fid}
        while True:
            more = {f["id"] for f in db["folders"] if f.get("parent_id") in ids} - ids
            if not more:
                break
            ids |= more
        for n in db["notes"]:
            if n["folder_id"] in ids:
                n.update(folder_id="TrashFolder-CloudKit", folder_name=tr("最近删除", "Recently Deleted"))
        db["folders"] = [f for f in db["folders"] if f["id"] not in ids]
        _recount()
        return {"ok": True, "deleted_folders": sorted(ids)}

    # -- drive
    def _children(parent: str) -> list[dict[str, Any]]:
        db = _db()
        out = []
        for it in db["drive"]:
            if it["parent"] == parent:
                row = dict(it)
                if row["type"] == "folder":
                    row["item_count"] = sum(1 for x in db["drive"] if x["parent"] == it["id"])
                out.append(row)
        return out

    @r.get("/drive/list")
    def dlist(id: str = ROOT):
        folder = {"id": ROOT, "name": tr("iCloud 云盘", "iCloud Drive"), "parent": None, "type": "folder"} if id == ROOT else {**_find(_db()["drive"], "id", id)}
        return {"folder": folder, "items": _children(id)}

    @r.get("/drive/trash")
    def dtrash():
        return {"folder": {"id": TRASH, "name": tr("最近删除", "Recently Deleted"), "parent": None, "type": "trash"}, "items": _children(TRASH)}

    @r.get("/drive/apps")
    def dapps():
        return [{"id": "FOLDER::com.apple.Pages::documents", "name": tr("Pages 文稿", "Pages"), "type": "app_library", "extension": None, "size": None,
                 "modified": None, "created": None, "item_count": 0, "shared": False, "in_trash": False, "restore_path": None}]

    @r.get("/drive/download")
    def ddownload(id: str, inline: bool = False):
        it = _find(_db()["drive"], "id", id)
        from urllib.parse import quote

        kind = "inline" if inline else "attachment"
        return Response(tr(f"演示文件：{it['name']}\n", f"Demo file: {it['name']}\n").encode(), media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": f"{kind}; filename*=UTF-8''{quote(it['name'])}"})

    @r.post("/drive/upload")
    async def dupload(folder: str = Form(...), files: list[UploadFile] = File(...)):
        for f in files:
            data = await f.read()
            name, _, ext = (f.filename or "file").rpartition(".")
            _db()["drive"].append({"id": f"FILE::com.apple.CloudDocs::{uuid.uuid4()}", "name": f.filename, "type": "file", "extension": ext if name else None,
                                   "size": len(data), "modified": datetime.now().isoformat(), "created": None, "item_count": None, "shared": False,
                                   "in_trash": False, "restore_path": None, "parent": folder})
        return {"ok": True}

    @r.post("/drive/mkdir")
    def dmkdir(body: dict):
        _db()["drive"].append({"id": f"FOLDER::com.apple.CloudDocs::{uuid.uuid4()}", "name": body["name"], "type": "folder", "extension": None, "size": None,
                               "modified": datetime.now().isoformat(), "created": None, "item_count": 0, "shared": False, "in_trash": False,
                               "restore_path": None, "parent": body["id"]})
        return {"ok": True}

    @r.post("/drive/rename")
    def drename(body: dict):
        _find(_db()["drive"], "id", body["id"])["name"] = body["name"]
        return {"ok": True}

    @r.post("/drive/move")
    def dmove(body: dict):
        for i in body["ids"]:
            _find(_db()["drive"], "id", i)["parent"] = body["dest"]
        return {"ok": True}

    @r.post("/drive/trash")
    def dtrash_items(body: dict):
        for i in body["ids"]:
            it = _find(_db()["drive"], "id", i)
            it.update(parent=TRASH, in_trash=True, restore_path="iCloud Drive", _from=it["parent"])
        return {"ok": True}

    @r.post("/drive/recover")
    def drecover(body: dict):
        for i in body["ids"]:
            it = _find(_db()["drive"], "id", i)
            it.update(parent=it.pop("_from", ROOT), in_trash=False, restore_path=None)
        return {"ok": True}

    @r.post("/drive/delete-forever")
    def dforever(body: dict):
        db = _db()
        db["drive"] = [x for x in db["drive"] if x["id"] not in body["ids"]]
        return {"ok": True}

    # -- photos
    @r.get("/photos/albums")
    def palbums():
        return _db()["albums"]

    @r.get("/photos/list")
    def plist(album: str = "__all__", offset: int = 0, limit: int = 60):
        rows = [p for p in _db()["photos"] if album == "__all__" or (album == "fav" and p["favorite"]) or album in p["albums"]]
        return {"items": [{k: v for k, v in p.items() if k != "albums"} for p in rows[offset:offset + limit]], "has_more": len(rows) > offset + limit}

    @r.get("/photos/file")
    def pfile(id: str, version: str = "thumb", download: bool = False):
        p = _find(_db()["photos"], "id", id)
        headers = {"Content-Disposition": f"attachment; filename={id}.svg"} if download else {}
        return Response(_photo_svg(id, p["filename"]), media_type="image/svg+xml", headers=headers)

    @r.post("/photos/favorite")
    def pfav(body: dict):
        _find(_db()["photos"], "id", body["id"])["favorite"] = body.get("value", True)
        return {"ok": True}

    @r.delete("/photos/item")
    def pdel(id: str):
        db = _db()
        db["photos"] = [p for p in db["photos"] if p["id"] != id]
        return {"ok": True}

    @r.post("/photos/upload")
    async def pupload(album: str = Form(""), files: list[UploadFile] = File(...)):
        for f in files:
            _db()["photos"].insert(0, {"id": _id("P"), "filename": f.filename, "type": "image", "created": datetime.now().isoformat(), "size": 0,
                                       "width": None, "height": None, "live": False, "favorite": False, "albums": [album] if album else []})
        return {"ok": True, "count": len(files)}

    @r.post("/photos/refresh")
    def prefresh():
        return {"ok": True}

    # -- contacts
    @r.get("/contacts")
    def contacts():
        return _db()["contacts"]

    # -- find my
    @r.get("/findmy/devices")
    def devices(refresh: bool = False):
        return _db()["devices"]

    @r.post("/findmy/devices/{device_id}/sound")
    def sound(device_id: str):
        return {"ok": True}

    @r.post("/findmy/devices/{device_id}/message")
    def msg(device_id: str, body: dict):
        return {"ok": True}

    @r.post("/findmy/devices/{device_id}/lost")
    def lost(device_id: str, body: dict):
        _find(_db()["devices"], "id", device_id)["lost_mode"] = True
        return {"ok": True}

    # -- hide my email
    @r.get("/hme")
    def hme():
        return _db()["hme"]

    @r.post("/hme/generate")
    def hgen():
        return {"email": f"{random.choice(['calm', 'swift', 'bright'])}.{random.choice(['river', 'cloud', 'stone'])}_{random.randint(10, 99)}@icloud.com"}

    @r.post("/hme")
    def hadd(body: dict):
        a = {"id": _id("H"), "email": body["email"], "label": body["label"], "note": body.get("note", ""), "forward_to": "me@example.com",
             "active": True, "created": int(datetime.now().timestamp() * 1000), "origin": "ON_DEMAND", "domain": ""}
        _db()["hme"].insert(0, a)
        return a

    @r.patch("/hme/{anon_id}")
    def hpatch(anon_id: str, body: dict):
        _find(_db()["hme"], "id", anon_id).update(label=body.get("label"), note=body.get("note"))
        return {"ok": True}

    @r.post("/hme/{anon_id}/deactivate")
    def hdeact(anon_id: str):
        _find(_db()["hme"], "id", anon_id)["active"] = False
        return {"ok": True}

    @r.post("/hme/{anon_id}/reactivate")
    def hreact(anon_id: str):
        _find(_db()["hme"], "id", anon_id)["active"] = True
        return {"ok": True}

    @r.delete("/hme/{anon_id}")
    def hdel(anon_id: str):
        db = _db()
        db["hme"] = [a for a in db["hme"] if a["id"] != anon_id]
        return {"ok": True}

    # -- account
    @r.get("/account")
    def account():
        gb = 1024 ** 3
        return {
            "storage": {"used": 120 * gb, "available": 80 * gb, "total": 200 * gb, "percent": 60, "by_media": [
                {"key": "photos", "label": tr("照片和视频", "Photos and Videos"), "color": "ffcc00", "bytes": 80 * gb},
                {"key": "backup", "label": tr("备份", "Backups"), "color": "5856d6", "bytes": 25 * gb},
                {"key": "docs", "label": tr("文稿", "Documents"), "color": "ff9500", "bytes": 10 * gb},
                {"key": "mail", "label": tr("邮件", "Mail"), "color": "007aff", "bytes": 5 * gb}]},
            "devices": [{"name": d["name"], "model": d["model"], "serial": "XXXX", "image": None} for d in _db()["devices"]],
            "family": [{"name": tr("演示 家人", "Demo Family"), "apple_id": "family@icloud.com", "dsid": "1"}],
        }

    app.include_router(r)
