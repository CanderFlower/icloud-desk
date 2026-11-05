"""Calendar (iCloud web calendar API: /ca/*)."""

from __future__ import annotations

import copy
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from pyicloud.services.calendar import CalendarObject, EventObject
from tzlocal import get_localzone_name

from .common import parse_dt, run

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


class EventBody(BaseModel):
    pguid: str
    title: str = "新建日程"
    start: str
    end: str
    all_day: bool = False
    location: str = ""
    description: str = ""
    alarm_minutes: int | None = None  # minutes before start; None = no alarm
    etag: str | None = None


class CalendarBody(BaseModel):
    title: str
    color: str = "#1BADF8"


# --------------------------------------------------------------- converters
def _apple_to_iso(value: Any, all_day: bool) -> str | None:
    if not isinstance(value, list) or len(value) < 6:
        return None
    _, year, month, day, hour, minute = value[:6]
    if all_day:
        return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    return f"{int(year):04d}-{int(month):02d}-{int(day):02d}T{int(hour):02d}:{int(minute):02d}"


def _to_apple(dt: datetime, start: bool) -> list[Any]:
    minutes = dt.hour * 60 + dt.minute
    if not start:
        minutes = (1440 - minutes) % 1440
    return [dt.strftime("%Y%m%d"), dt.year, dt.month, dt.day, dt.hour, dt.minute, minutes]


def normalize_event(ev: dict[str, Any]) -> dict[str, Any]:
    all_day = bool(ev.get("allDay"))
    start = ev.get("localStartDate") or ev.get("startDate")
    end = ev.get("localEndDate") or ev.get("endDate")
    guid = ev.get("guid", "")
    return {
        "guid": guid,
        "pguid": ev.get("pGuid"),
        "title": ev.get("title") or "",
        "location": ev.get("location") or "",
        "description": ev.get("description") or "",
        "url": ev.get("url") or "",
        "all_day": all_day,
        "start": _apple_to_iso(start, all_day),
        "end": _apple_to_iso(end, all_day),
        "tz": ev.get("tz"),
        "etag": ev.get("etag"),
        "recurring": bool(ev.get("recurrenceMaster") or ev.get("recurrenceException") or ev.get("recurrence") or "*" in guid),
        "read_only": bool(ev.get("readOnly")),
        "has_invitees": bool(ev.get("invitees")),
        "alarms": ev.get("alarms") or [],
    }


def normalize_calendar(cal: dict[str, Any]) -> dict[str, Any]:
    return {
        "guid": cal.get("guid"),
        "title": cal.get("title"),
        "color": cal.get("color") or "#1BADF8",
        "read_only": bool(cal.get("readOnly")),
        "share_type": cal.get("shareType"),
        "is_default": bool(cal.get("isDefault")),
        "is_family": bool(cal.get("isFamily")),
        "ctag": cal.get("ctag"),
        "order": cal.get("order") or 0,
    }


def _resolve_range(body: EventBody) -> tuple[datetime, datetime]:
    start = parse_dt(body.start)
    end = parse_dt(body.end)
    if start is None or end is None:
        raise HTTPException(400, "缺少开始或结束时间")
    start = start.replace(tzinfo=None)
    end = end.replace(tzinfo=None)
    if body.all_day:
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
        end = end.replace(hour=0, minute=0, second=0, microsecond=0)
        # UI sends the inclusive last day; Apple wants the exclusive next day.
        end = end + timedelta(days=1)
    if end <= start:
        raise HTTPException(400, "结束时间必须晚于开始时间")
    return start, end


def _detail_raw(cal: Any, pguid: str, guid: str) -> dict[str, Any]:
    params = dict(cal.params)
    params.update({
        "lang": "en-us",
        "usertz": get_localzone_name(),
        "dsid": cal.session.service.data["dsInfo"]["dsid"],
    })
    resp = cal.session.get(f"{cal._calendar_event_detail_url}/{pguid}/{guid}", params=params)
    return resp.json()


# ------------------------------------------------------------------- routes
@router.get("/calendars")
def calendars():
    cals = run(lambda api: api.calendar.get_calendars())
    out = [normalize_calendar(c) for c in cals or []]
    out.sort(key=lambda c: c["order"])
    return out


@router.post("/calendars")
def create_calendar(body: CalendarBody):
    obj = CalendarObject(title=body.title, color=body.color)
    run(lambda api: api.calendar.add_calendar(obj))
    return {"guid": obj.guid}


@router.delete("/calendars/{guid}")
def delete_calendar(guid: str):
    run(lambda api: api.calendar.remove_calendar(guid))
    return {"ok": True}


@router.get("/events")
def events(start: str, end: str):
    from_dt = parse_dt(start)
    to_dt = parse_dt(end)
    evs = run(lambda api: api.calendar.get_events(from_dt, to_dt, period="range"))
    return [normalize_event(e) for e in evs or []]


@router.get("/events/{pguid}/{guid}")
def event_detail(pguid: str, guid: str):
    raw = run(lambda api: _detail_raw(api.calendar, pguid, guid))
    events_ = raw.get("Event") or []
    if not events_:
        raise HTTPException(404, "日程不存在")
    out = normalize_event(events_[0])
    out["invitees"] = raw.get("Invitee") or []
    out["alarm_records"] = raw.get("Alarm") or []
    return out


@router.post("/events")
def create_event(body: EventBody):
    start, end = _resolve_range(body)
    ev = EventObject(
        body.pguid,
        title=body.title,
        start_date=start,
        end_date=end,
        all_day=body.all_day,
        location=body.location,
    )
    if body.alarm_minutes is not None and body.alarm_minutes >= 0:
        ev.add_alarm_before(minutes=body.alarm_minutes)

    def _do(api: Any) -> dict[str, Any]:
        cal = api.calendar
        data = ev.request_data
        data["Event"]["description"] = body.description
        data["ClientState"]["Collection"][0]["ctag"] = cal.get_ctag(ev.pguid)
        resp = cal.session.post(
            f"{cal._calendar_refresh_url}/{ev.pguid}/{ev.guid}",
            params=cal.default_params,
            json=data,
        )
        return resp.json()

    run(_do)
    return {"guid": ev.guid, "pguid": ev.pguid}


@router.put("/events/{pguid}/{guid}")
def update_event(pguid: str, guid: str, body: EventBody):
    start, end = _resolve_range(body)

    if body.pguid != pguid:
        # Moving to another calendar: create in the new one, then delete the old.
        created = create_event(body)
        delete_event(pguid, guid, body.etag)
        return created

    def _do(api: Any) -> dict[str, Any]:
        cal = api.calendar
        raw = _detail_raw(cal, pguid, guid)
        events_ = raw.get("Event") or []
        if not events_:
            raise HTTPException(404, "日程不存在")
        ev = copy.deepcopy(events_[0])
        tz = ev.get("tz") or get_localzone_name()
        ev.update({
            "title": body.title,
            "location": body.location,
            "description": body.description,
            "allDay": body.all_day,
            "startDate": _to_apple(start, True),
            "endDate": _to_apple(end, False),
            "localStartDate": _to_apple(start, True),
            "localEndDate": _to_apple(end, False),
            "duration": int((end - start).total_seconds() // 60),
            "tz": tz,
        })
        etag = body.etag or ev.get("etag")
        data = {
            "Event": ev,
            "Invitee": raw.get("Invitee") or [],
            "Alarm": raw.get("Alarm") or [],
            "ClientState": {"Collection": [{"guid": pguid, "ctag": cal.get_ctag(pguid)}]},
        }
        params = cal.default_params
        params["methodOverride"] = "PUT"
        if etag:
            params["ifMatch"] = etag
        resp = cal.session.post(f"{cal._calendar_refresh_url}/{pguid}/{guid}", params=params, json=data)
        return resp.json()

    run(_do)
    return {"guid": guid, "pguid": pguid}


@router.delete("/events/{pguid}/{guid}")
def delete_event(pguid: str, guid: str, etag: str | None = None):
    now = datetime.now()
    ev = EventObject(pguid, guid=guid, start_date=now, end_date=now + timedelta(hours=1), etag=etag or None)
    run(lambda api: api.calendar.remove_event(ev))
    return {"ok": True}
