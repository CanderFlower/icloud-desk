"""Reminders (CloudKit) - full CRUD."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .common import dump, parse_dt, run

router = APIRouter(prefix="/api/reminders", tags=["reminders"])

_HIDDEN = {"server_title", "server_desc", "early_reminder_account_id", "undecodable_text_fields"}


class ReminderCreate(BaseModel):
    list_id: str
    title: str
    desc: str = ""
    due_date: str | None = None
    all_day: bool = False
    priority: int = 0  # 0 none, 1 high, 5 medium, 9 low
    flagged: bool = False
    parent_reminder_id: str | None = None


class ReminderPatch(BaseModel):
    title: str | None = None
    desc: str | None = None
    completed: bool | None = None
    due_date: str | None = None
    clear_due_date: bool = False
    all_day: bool | None = None
    priority: int | None = None
    flagged: bool | None = None
    list_id: str | None = None


def _out(rem: Any) -> dict[str, Any]:
    return dump(rem, exclude=_HIDDEN)


@router.get("/lists")
def lists():
    def _do(api: Any) -> list[dict[str, Any]]:
        return [dump(lst, exclude={"reminder_ids"}) for lst in api.reminders.lists() if not lst.deleted]

    return run(_do)


@router.get("")
def reminders(list_id: str, include_completed: bool = False, limit: int = 500):
    def _do(api: Any) -> list[dict[str, Any]]:
        res = api.reminders.list_reminders(list_id, include_completed=include_completed, results_limit=limit)
        return [_out(r) for r in res.reminders if not r.deleted]

    return run(_do)


@router.post("")
def create(body: ReminderCreate):
    def _do(api: Any) -> dict[str, Any]:
        rem = api.reminders.create(
            list_id=body.list_id,
            title=body.title,
            desc=body.desc,
            due_date=parse_dt(body.due_date),
            priority=body.priority,
            flagged=body.flagged,
            all_day=body.all_day,
            parent_reminder_id=body.parent_reminder_id,
        )
        return _out(rem)

    return run(_do)


@router.get("/item/{rid:path}")
def get(rid: str):
    return run(lambda api: _out(api.reminders.get(rid)))


@router.patch("/item/{rid:path}")
def update(rid: str, body: ReminderPatch):
    def _do(api: Any) -> dict[str, Any]:
        svc = api.reminders
        rem = svc.get(rid)
        for field in ("title", "desc", "completed", "all_day", "priority", "flagged", "list_id"):
            value = getattr(body, field)
            if value is not None:
                setattr(rem, field, value)
        if body.clear_due_date:
            rem.due_date = None
        elif body.due_date:
            rem.due_date = parse_dt(body.due_date)
        svc.update(rem)
        return _out(rem)

    return run(_do)


@router.delete("/item/{rid:path}")
def delete(rid: str):
    def _do(api: Any) -> dict[str, bool]:
        svc = api.reminders
        svc.delete(svc.get(rid))
        return {"ok": True}

    return run(_do)
