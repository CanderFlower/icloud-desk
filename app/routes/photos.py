"""iCloud Photos (CloudKit) - albums, paged grid, thumbnails, upload, favorite, delete."""

from __future__ import annotations

import hashlib
import mimetypes
import os
import shutil
import tempfile
from typing import Any

import requests
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from ..config import DATA_DIR
from ..i18n import tr
from ..icloud import icloud
from .common import iso, run

router = APIRouter(prefix="/api/photos", tags=["photos"])

THUMB_DIR = DATA_DIR / "cache" / "photos"
THUMB_DIR.mkdir(parents=True, exist_ok=True)

_plain = requests.Session()


class FavBody(BaseModel):
    id: str
    value: bool = True


def _state() -> dict[str, Any]:
    return icloud.cache.setdefault("photos", {"albums": {}, "pages": {}, "assets": {}})


def _albums(api: Any) -> dict[str, Any]:
    st = _state()
    if not st["albums"]:
        albums = {"__all__": api.photos.all}
        for album in api.photos.albums:
            albums[album.id] = album
        st["albums"] = albums
    return st["albums"]


def _photo(asset: Any) -> dict[str, Any]:
    w, h = (None, None)
    try:
        w, h = asset.dimensions
    except Exception:  # noqa: BLE001
        pass
    return {
        "id": asset.id,
        "filename": asset.filename,
        "type": asset.item_type,
        "created": iso(getattr(asset, "asset_date", None) or asset.created),
        "size": asset.size,
        "width": w,
        "height": h,
        "live": bool(getattr(asset, "is_live_photo", False)),
        "favorite": _is_favorite(asset),
    }


def _is_favorite(asset: Any) -> bool:
    try:
        from pyicloud.services.photos_cloudkit.mappers import record_field_value

        return bool(int(record_field_value(asset._asset_record, "isFavorite") or 0))
    except Exception:  # noqa: BLE001
        return False


@router.get("/albums")
def albums():
    def _do(api: Any) -> list[dict[str, Any]]:
        out = []
        for key, album in _albums(api).items():
            out.append({
                "id": key,
                "name": tr("图库", "Library") if key == "__all__" else album.name,
                "kind": type(album).__name__,
            })
        return out

    return run(_do)


@router.get("/list")
def list_photos(album: str = "__all__", offset: int = 0, limit: int = 60):
    def _do(api: Any) -> dict[str, Any]:
        alb = _albums(api).get(album)
        if alb is None:
            raise HTTPException(404, tr("相簿不存在", "Album not found"))
        st = _state()
        page = st["pages"].get(album)
        if page is None or offset == 0:
            page = {"iter": iter(alb.photos), "items": [], "done": False}
            st["pages"][album] = page
        while not page["done"] and len(page["items"]) < offset + limit:
            try:
                asset = next(page["iter"])
            except StopIteration:
                page["done"] = True
                break
            page["items"].append(asset)
            st["assets"][asset.id] = asset
        chunk = page["items"][offset : offset + limit]
        return {
            "items": [_photo(a) for a in chunk],
            "has_more": not page["done"] or len(page["items"]) > offset + limit,
        }

    return run(_do)


def _asset(photo_id: str) -> Any:
    asset = _state()["assets"].get(photo_id)
    if asset is None:
        raise HTTPException(404, tr("照片未加载，请刷新相簿", "Photo not loaded; please refresh the album"))
    return asset


@router.get("/file")
def photo_file(id: str, version: str = "thumb", download: bool = False):
    photo_id = id
    if version not in {"thumb", "medium", "original"}:
        raise HTTPException(400, tr("version 只能是 thumb / medium / original", "version must be thumb, medium, or original"))
    asset = _asset(photo_id)
    key = hashlib.sha1(f"{photo_id}:{version}".encode()).hexdigest()
    cache_file = THUMB_DIR / key
    filename = asset.filename or f"{photo_id}.jpg"
    if version != "original":
        filename = os.path.splitext(filename)[0] + ".jpg"
    media = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    if version != "original" and cache_file.exists():
        return FileResponse(cache_file, media_type=media)

    def _do(api: Any) -> bytes | None:
        data = asset.download(version)
        if data is None and version == "thumb":
            data = asset.download("medium")
        return data

    # CloudKit asset URLs are pre-signed, so try fetching them in parallel
    # without the global pyicloud lock first; fall back to the session.
    data = None
    url = asset.download_url(version) or (asset.download_url("medium") if version == "thumb" else None)
    if url:
        try:
            r = _plain.get(url, timeout=60)
            if r.ok and r.content:
                data = r.content
        except requests.RequestException:
            data = None
    if data is None:
        data = run(_do)
    if data is None:
        raise HTTPException(404, tr("该版本不可用", "Requested version is unavailable"))
    if version != "original":
        cache_file.write_bytes(data)
    headers = {}
    if download:
        from urllib.parse import quote

        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(asset.filename or filename)}"
    return Response(content=data, media_type=media, headers=headers)


@router.post("/favorite")
def favorite(body: FavBody):
    asset = _asset(body.id)
    run(lambda api: asset.favorite() if body.value else asset.unfavorite())
    return {"ok": True}


@router.delete("/item")
def delete(id: str):
    photo_id = id
    asset = _asset(photo_id)
    run(lambda api: asset.delete())
    st = _state()
    st["assets"].pop(photo_id, None)
    for page in st["pages"].values():
        page["items"] = [a for a in page["items"] if a.id != photo_id]
    return {"ok": True}


@router.post("/upload")
def upload(album: str = Form(""), files: list[UploadFile] = File(...)):
    tmp = tempfile.mkdtemp(prefix="icloud-desk-")
    try:
        paths = []
        for f in files:
            p = os.path.join(tmp, os.path.basename(f.filename or "upload.jpg"))
            with open(p, "wb") as out:
                shutil.copyfileobj(f.file, out)
            paths.append(p)

        def _do(api: Any) -> int:
            target = None
            if album and album != "__all__":
                target = _albums(api).get(album)
            for p in paths:
                api.photos.upload(p, album=target)
            return len(paths)

        count = run(_do)
        _state()["pages"].clear()
        return {"ok": True, "count": count}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/refresh")
def refresh():
    icloud.cache.pop("photos", None)
    return {"ok": True}
