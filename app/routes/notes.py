"""Notes (CloudKit): reading via pyicloud, writing via ``app.notes_write``
(the same ``records/modify`` calls icloud.com Notes makes)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..notes_write import NotesWriter
from .common import dump, run

router = APIRouter(prefix="/api/notes", tags=["notes"])


class NoteCreate(BaseModel):
    folder_id: str | None = None
    text: str = ""


class NoteUpdate(BaseModel):
    text: str
    force: bool = False
    change_tag: str | None = None


class NoteMove(BaseModel):
    id: str
    folder_id: str


class FolderCreate(BaseModel):
    title: str | None = None
    name: str | None = Field(default=None, description="alias of title")
    parent_id: str | None = None


class FolderRename(BaseModel):
    title: str | None = None
    name: str | None = Field(default=None, description="alias of title")


def _writer(api: Any) -> NotesWriter:
    return NotesWriter.for_api(api)


def _forget_folder(api: Any, *ids: str) -> None:
    cache = getattr(api.notes, "_folder_name_cache", None)
    if isinstance(cache, dict):
        for fid in ids:
            cache.pop(fid, None)


@router.get("/folders")
def folders():
    return run(lambda api: [dump(f) for f in api.notes.folders()])


@router.get("")
def notes(folder_id: str | None = None, limit: int = 200):
    def _do(api: Any) -> list[dict[str, Any]]:
        if folder_id:
            rows = api.notes.in_folder(folder_id, limit=limit)
        else:
            # recents() also yields deleted notes; over-fetch so we still return ~limit.
            rows = list(api.notes.recents(limit=min(limit * 2, 1000)))
        return [dump(n) for n in rows if not n.is_deleted][:limit]

    return run(_do)


@router.get("/item/{note_id:path}")
def note(note_id: str):
    def _do(api: Any) -> dict[str, Any]:
        try:
            n = api.notes.get(note_id, with_attachments=True)
        except Exception as exc:  # NoteLockedError / NoteNotFound
            name = type(exc).__name__
            if "Locked" in name:
                raise HTTPException(423, "这条备忘录已加锁，无法通过网页接口读取") from exc
            if "NotFound" in name:
                raise HTTPException(404, "备忘录不存在") from exc
            raise
        data = dump(n)
        try:
            data["html"] = api.notes.render_note(note_id)
        except Exception:  # noqa: BLE001 - fall back to plain text
            data["html"] = None
        try:
            data.update(_writer(api).get_state(note_id).extras())
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - reading must keep working
            data.update({
                "markdown": None,
                "editable": False,
                "edit_blocker": f"无法检查这条备忘录是否可编辑：{exc}",
                "edit_blocker_code": "unknown",
                "edit_warnings": [],
                "change_tag": None,
            })
        return data

    return run(_do)


@router.post("/notes")
def create_note(body: NoteCreate):
    return run(lambda api: _writer(api).create_note(body.folder_id, body.text))


@router.patch("/item/{note_id:path}")
def update_note(note_id: str, body: NoteUpdate):
    return run(
        lambda api: _writer(api).update_note(
            note_id, body.text, force=body.force, change_tag=body.change_tag
        )
    )


@router.delete("/item/{note_id:path}")
def delete_note(note_id: str, permanent: bool = False):
    return run(lambda api: _writer(api).delete_note(note_id, permanent=permanent))


@router.post("/move")
def move_note(body: NoteMove):
    return run(lambda api: _writer(api).move_note(body.id, body.folder_id))


@router.post("/folders")
def create_folder(body: FolderCreate):
    title = body.title if body.title is not None else body.name
    return run(lambda api: _writer(api).create_folder(title or "", body.parent_id))


@router.patch("/folders/{folder_id:path}")
def rename_folder(folder_id: str, body: FolderRename):
    title = body.title if body.title is not None else body.name

    def _do(api: Any) -> dict[str, Any]:
        out = _writer(api).rename_folder(folder_id, title or "")
        _forget_folder(api, folder_id)
        return out

    return run(_do)


@router.delete("/folders/{folder_id:path}")
def delete_folder(folder_id: str):
    def _do(api: Any) -> dict[str, Any]:
        out = _writer(api).delete_folder(folder_id)
        _forget_folder(api, *out.get("deleted_folders", []))
        return out

    return run(_do)


@router.get("/attachment/{note_id:path}")
def attachment(note_id: str, att_id: str):
    def _do(api: Any):
        n = api.notes.get(note_id, with_attachments=True)
        for att in n.attachments or []:
            if att.id == att_id:
                return att, api.notes.stream_attachment(att)
        raise HTTPException(404, "附件不存在")

    att, stream = run(_do)
    filename = att.filename or "attachment"
    return StreamingResponse(
        stream,
        media_type="application/octet-stream",
        headers={"Content-Disposition": _disposition(filename)},
    )


def _disposition(filename: str, inline: bool = False) -> str:
    from urllib.parse import quote

    kind = "inline" if inline else "attachment"
    return f"{kind}; filename*=UTF-8''{quote(filename)}"
