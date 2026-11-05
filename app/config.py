"""Local paths and persisted settings."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

APP_NAME = "icloud-desk"

DATA_DIR = Path(os.environ.get("ICLOUD_DESK_HOME") or Path(os.environ.get("APPDATA", Path.home())) / APP_NAME)
SESSION_DIR = DATA_DIR / "session"
SETTINGS_FILE = DATA_DIR / "settings.json"

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

for _d in (DATA_DIR, SESSION_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS: dict[str, Any] = {
    "apple_id": None,
    "china_mainland": False,
}


def load_settings() -> dict[str, Any]:
    data = dict(DEFAULT_SETTINGS)
    if SETTINGS_FILE.exists():
        try:
            data.update(json.loads(SETTINGS_FILE.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return data


def save_settings(**changes: Any) -> dict[str, Any]:
    data = load_settings()
    data.update(changes)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    return data
