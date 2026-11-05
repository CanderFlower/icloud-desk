"""Notes (CloudKit) - read only (Apple doesn't expose a write API for notes)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from .common import dump, run

router = APIRouter(prefix="/api/notes", tags=["notes"])


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
        return data

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
