"""iCloud Drive - browse, download, upload, mkdir, rename, move, trash."""

from __future__ import annotations

import mimetypes
import os
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pyicloud.services.drive import CLOUD_DOCS_ZONE_ID_ROOT, CLOUD_DOCS_ZONE_ID_TRASH, DriveNode

from ..i18n import tr
from ..icloud import icloud
from .common import run

router = APIRouter(prefix="/api/drive", tags=["drive"])


class NameBody(BaseModel):
    id: str
    name: str


class IdsBody(BaseModel):
    ids: list[str]


class MoveBody(BaseModel):
    ids: list[str]
    dest: str


# Remember the raw data of every node we've seen so later operations can find
# docwsid / zone / etag / shareID from just the drivewsid the UI sends back.
def _nodes() -> dict[str, dict[str, Any]]:
    return icloud.cache.setdefault("drive_nodes", {})


def _remember(data: dict[str, Any]) -> None:
    if data.get("drivewsid"):
        _nodes()[data["drivewsid"]] = {k: v for k, v in data.items() if k != "items"}


def _node_data(drivewsid: str) -> dict[str, Any]:
    data = _nodes().get(drivewsid)
    if data is None:
        # The UI can restore a cached directory before this daemon has seen it.
        def _load(api: Any) -> dict[str, Any]:
            node = api.drive.get_node_data(drivewsid)
            _remember(node)
            return node

        data = run(_load)
        if not data or data.get("drivewsid") != drivewsid:
            raise HTTPException(404, tr("找不到该文件，请刷新目录后重试", "File not found. Refresh the folder and try again."))
    return data


def _full_name(item: dict[str, Any]) -> str:
    name = item.get("name") or ""
    ext = item.get("extension")
    return f"{name}.{ext}" if ext else name


def _item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("drivewsid"),
        "name": _full_name(item),
        "type": (item.get("type") or "unknown").lower(),
        "extension": item.get("extension"),
        "size": int(item["size"]) if item.get("size") not in (None, "") else None,
        "modified": item.get("dateModified") or item.get("dateChanged"),
        "created": item.get("dateCreated"),
        "item_count": item.get("directChildrenCount") or item.get("numberOfItems"),
        "shared": bool(item.get("shareID") or item.get("share")),
        "in_trash": bool(item.get("restorePath")),
        "restore_path": item.get("restorePath"),
    }


def _list(api: Any, drivewsid: str) -> dict[str, Any]:
    known = _nodes().get(drivewsid) or {}
    data = api.drive.get_node_data(drivewsid, known.get("shareID"))
    _remember(data)
    items = data.get("items") or []
    for it in items:
        _remember(it)
    return {
        "folder": {
            "id": data.get("drivewsid"),
            "name": _full_name(data) or (tr("iCloud 云盘", "iCloud Drive") if drivewsid == CLOUD_DOCS_ZONE_ID_ROOT else ""),
            "parent": data.get("parentId"),
            "type": (data.get("type") or "folder").lower(),
        },
        "items": [_item(i) for i in items],
    }


@router.get("/list")
def list_folder(id: str = CLOUD_DOCS_ZONE_ID_ROOT):
    return run(lambda api: _list(api, id))


@router.get("/trash")
def trash():
    return run(lambda api: _list(api, CLOUD_DOCS_ZONE_ID_TRASH))


@router.get("/apps")
def app_libraries():
    def _do(api: Any) -> list[dict[str, Any]]:
        items = api.drive.get_app_data()
        for it in items:
            _remember(it)
        return [_item(i) for i in items]

    return run(_do)


@router.get("/download")
def download(id: str, inline: bool = False):
    data = _node_data(id)
    name = _full_name(data)

    def _do(api: Any):
        node = DriveNode(api.drive, data)
        return node.open(stream=True)

    resp = run(_do)
    media = mimetypes.guess_type(name)[0] or "application/octet-stream"
    kind = "inline" if inline else "attachment"
    headers = {"Content-Disposition": f"{kind}; filename*=UTF-8''{quote(name)}"}
    return StreamingResponse(resp.iter_content(chunk_size=256 * 1024), media_type=media, headers=headers)


class _NamedFile:
    """File wrapper exposing the original filename as ``.name`` (pyicloud uses it)."""

    def __init__(self, fileobj: Any, name: str) -> None:
        self._f = fileobj
        self.name = name

    def read(self, *args: Any) -> bytes:
        return self._f.read(*args)

    def seek(self, *args: Any) -> int:
        return self._f.seek(*args)

    def tell(self) -> int:
        return self._f.tell()

    def __iter__(self):
        return iter(self._f)


@router.post("/upload")
def upload(folder: str = Form(...), files: list[UploadFile] = File(...)):
    folder_data = _node_data(folder)

    def _do(api: Any) -> None:
        drive = api.drive
        saved = dict(drive.params)
        try:
            for f in files:
                f.file.seek(0)
                drive.send_file(
                    folder_data["docwsid"],
                    _NamedFile(f.file, os.path.basename(f.filename or "upload.bin")),
                    zone=folder_data.get("zone") or "com.apple.CloudDocs",
                )
        finally:
            # send_file mutates drive.params (adds an upload token); restore it.
            drive.params.clear()
            drive.params.update(saved)

    run(_do)
    return {"ok": True, "count": len(files)}


@router.post("/mkdir")
def mkdir(body: NameBody):
    run(lambda api: api.drive.create_folders(body.id, body.name))
    return {"ok": True}


@router.post("/rename")
def rename(body: NameBody):
    data = _node_data(body.id)
    run(lambda api: api.drive.rename_items(body.id, data["etag"], body.name))
    return {"ok": True}


@router.post("/move")
def move(body: MoveBody):
    nodes_data = [_node_data(i) for i in body.ids]
    dest = _node_data(body.dest) if body.dest in _nodes() else {"drivewsid": body.dest}

    def _do(api: Any) -> Any:
        nodes = [DriveNode(api.drive, d) for d in nodes_data]
        return api.drive.move_nodes_to_node(nodes, DriveNode(api.drive, dest))

    run(_do)
    return {"ok": True}


@router.post("/trash")
def move_to_trash(body: IdsBody):
    def _do(api: Any) -> None:
        for i in body.ids:
            d = _node_data(i)
            api.drive.move_items_to_trash(i, d["etag"])

    run(_do)
    return {"ok": True}


@router.post("/recover")
def recover(body: IdsBody):
    def _do(api: Any) -> None:
        for i in body.ids:
            d = _node_data(i)
            api.drive.recover_items_from_trash(i, d["etag"])

    run(_do)
    return {"ok": True}


@router.post("/delete-forever")
def delete_forever(body: IdsBody):
    def _do(api: Any) -> None:
        for i in body.ids:
            d = _node_data(i)
            api.drive.delete_forever_from_trash(i, d["etag"])

    run(_do)
    return {"ok": True}
