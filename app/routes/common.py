"""Shared helpers for route modules."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi.encoders import jsonable_encoder

from ..icloud import icloud

run = icloud.call


def dump(obj: Any, **kwargs: Any) -> Any:
    """Convert pydantic models / dataclasses / datetimes into JSON-able data."""
    if hasattr(obj, "model_dump"):
        return jsonable_encoder(obj.model_dump(mode="json", **kwargs))
    return jsonable_encoder(obj)


def iso(value: datetime | date | None) -> str | None:
    return value.isoformat() if value else None


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip().replace("Z", "+00:00")
    if len(value) == 10:
        return datetime.fromisoformat(value + "T00:00:00")
    return datetime.fromisoformat(value)
