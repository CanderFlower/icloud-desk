"""Contacts (read only), Find My, Hide My Email, Account."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .common import run

router = APIRouter(prefix="/api", tags=["misc"])


# ------------------------------------------------------------------ contacts
def _contact(c: dict[str, Any]) -> dict[str, Any]:
    name = " ".join(x for x in (c.get("lastName"), c.get("firstName")) if x) or c.get("companyName") or ""
    return {
        "id": c.get("contactId"),
        "name": name,
        "first_name": c.get("firstName"),
        "last_name": c.get("lastName"),
        "company": c.get("companyName"),
        "job_title": c.get("jobTitle"),
        "nickname": c.get("nickName"),
        "birthday": c.get("birthday"),
        "notes": c.get("notes"),
        "phones": c.get("phones") or [],
        "emails": c.get("emailAddresses") or c.get("emails") or [],
        "addresses": c.get("streetAddresses") or [],
        "urls": c.get("urls") or [],
        "photo": (c.get("photo") or {}).get("url"),
        "is_company": bool(c.get("isCompany")),
    }


@router.get("/contacts")
def contacts():
    def _do(api: Any) -> list[dict[str, Any]]:
        rows = api.contacts.all or []
        out = [_contact(c) for c in rows]
        out.sort(key=lambda c: (c["name"] or "~").lower())
        return out

    return run(_do)


@router.get("/contacts/photo")
def contact_photo(url: str):
    host = urlparse(url).hostname or ""
    if not (host.endswith(".icloud.com") or host.endswith(".icloud.com.cn") or host.endswith(".apple.com")):
        raise HTTPException(400, "不允许的地址")
    resp = run(lambda api: api.session.get(url))
    return Response(resp.content, media_type=resp.headers.get("Content-Type", "image/jpeg"))


# ------------------------------------------------------------------- find my
class MessageBody(BaseModel):
    subject: str = "iCloud Desk"
    message: str = ""
    sound: bool = False


class LostBody(BaseModel):
    number: str
    text: str = "这台设备已丢失，请联系我。"


def _device(dev: Any) -> dict[str, Any]:
    d = dev.data
    loc = d.get("location") or None
    return {
        "id": d.get("id"),
        "name": d.get("name"),
        "model": d.get("deviceDisplayName"),
        "device_class": d.get("deviceClass"),
        "battery_level": d.get("batteryLevel"),
        "battery_status": d.get("batteryStatus"),
        "status": d.get("deviceStatus"),
        "location": {
            "latitude": loc.get("latitude"),
            "longitude": loc.get("longitude"),
            "accuracy": loc.get("horizontalAccuracy"),
            "timestamp": loc.get("timeStamp"),
            "type": loc.get("positionType"),
        } if loc else None,
        "features": {
            "sound": bool((d.get("features") or {}).get("SND")),
            "message": bool((d.get("features") or {}).get("MSG")),
            "lost": bool(d.get("lostModeCapable")),
        },
        "lost_mode": bool(d.get("lostModeEnabled")),
    }


@router.get("/findmy/devices")
def devices(refresh: bool = False):
    def _do(api: Any) -> list[dict[str, Any]]:
        mgr = api.devices
        if refresh:
            mgr.refresh(locate=True)
        return [_device(dev) for dev in mgr]

    return run(_do)


def _find(api: Any, device_id: str) -> Any:
    for dev in api.devices:
        if dev.data.get("id") == device_id:
            return dev
    raise HTTPException(404, "设备不存在")


@router.post("/findmy/devices/{device_id}/sound")
def play_sound(device_id: str):
    run(lambda api: _find(api, device_id).play_sound(subject="iCloud Desk"))
    return {"ok": True}


@router.post("/findmy/devices/{device_id}/message")
def message(device_id: str, body: MessageBody):
    run(lambda api: _find(api, device_id).display_message(body.subject, body.message, body.sound))
    return {"ok": True}


@router.post("/findmy/devices/{device_id}/lost")
def lost(device_id: str, body: LostBody):
    run(lambda api: _find(api, device_id).lost_device(body.number, body.text))
    return {"ok": True}


# -------------------------------------------------------------- hide my email
class AliasBody(BaseModel):
    email: str | None = None
    label: str
    note: str = ""


class AliasMeta(BaseModel):
    label: str
    note: str | None = None


def _alias(a: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": a.get("anonymousId"),
        "email": a.get("hme"),
        "label": a.get("label"),
        "note": a.get("note"),
        "forward_to": a.get("forwardToEmail"),
        "active": a.get("isActive", True),
        "created": a.get("createTimestamp"),
        "origin": a.get("origin"),
        "domain": a.get("domain"),
    }


@router.get("/hme")
def aliases():
    return run(lambda api: [_alias(a) for a in api.hidemyemail])


@router.post("/hme/generate")
def generate():
    return {"email": run(lambda api: api.hidemyemail.generate())}


@router.post("/hme")
def reserve(body: AliasBody):
    def _do(api: Any) -> dict[str, Any]:
        email = body.email or api.hidemyemail.generate()
        if not email:
            raise HTTPException(502, "生成地址失败")
        return api.hidemyemail.reserve(email, body.label, body.note or "Generated")

    return run(_do)


@router.patch("/hme/{anon_id}")
def update_alias(anon_id: str, body: AliasMeta):
    return run(lambda api: api.hidemyemail.update_metadata(anon_id, body.label, body.note))


@router.post("/hme/{anon_id}/deactivate")
def deactivate(anon_id: str):
    return run(lambda api: api.hidemyemail.deactivate(anon_id))


@router.post("/hme/{anon_id}/reactivate")
def reactivate(anon_id: str):
    return run(lambda api: api.hidemyemail.reactivate(anon_id))


@router.delete("/hme/{anon_id}")
def delete_alias(anon_id: str):
    return run(lambda api: api.hidemyemail.delete(anon_id))


# -------------------------------------------------------------------- account
@router.get("/account")
def account():
    def _do(api: Any) -> dict[str, Any]:
        acc = api.account
        out: dict[str, Any] = {}
        try:
            st = acc.storage
            out["storage"] = {
                "used": st.usage.used_storage_in_bytes,
                "available": st.usage.available_storage_in_bytes,
                "total": st.usage.total_storage_in_bytes,
                "percent": st.usage.used_storage_in_percent,
                "by_media": [
                    {"key": k, "label": u.label, "color": u.color, "bytes": u.usage_in_bytes}
                    for k, u in st.usages_by_media.items()
                ],
            }
        except Exception as exc:  # noqa: BLE001
            out["storage_error"] = str(exc)
        try:
            out["devices"] = [
                {
                    "name": d.get("name"),
                    "model": d.get("modelDisplayName"),
                    "serial": d.get("serialNumber"),
                    "image": d.get("modelSmallPhotoURL2x") or d.get("modelSmallPhotoURL1x"),
                }
                for d in acc.devices
            ]
        except Exception as exc:  # noqa: BLE001
            out["devices_error"] = str(exc)
        try:
            out["family"] = [
                {"name": m.full_name, "apple_id": m.apple_id, "dsid": m.dsid} for m in acc.family
            ]
        except Exception as exc:  # noqa: BLE001
            out["family_error"] = str(exc)
        return out

    return run(_do)
