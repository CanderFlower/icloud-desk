"""Lightweight localization for the backend daemon and CLI (`zh-CN` / `en`).

* Inside FastAPI requests, ``server.py`` binds the request's ``Accept-Language``
  into a ``ContextVar``; when unbound (e.g. direct unit-test calls), it defaults
  to ``zh-CN`` so existing Chinese behaviour and tests remain deterministic.
* In the ``icd`` CLI, ``resolve_cli_lang`` checks ``--lang``, ``ICD_LANG``, and
  the OS UI language.
"""

from __future__ import annotations

import contextvars
import locale
import os
from typing import Iterator
from contextlib import contextmanager

SUPPORTED = ("zh-CN", "en")

_current_lang: contextvars.ContextVar[str] = contextvars.ContextVar("icd_lang", default="zh-CN")


def normalize_lang(raw: str | None, *, fallback: str = "zh-CN") -> str:
    if not raw:
        return fallback
    first = raw.split(",")[0].split(";")[0].strip().replace("_", "-").lower()
    if not first or first in ("auto", "system"):
        return system_lang()
    if first.startswith("zh"):
        return "zh-CN"
    if first.startswith("en"):
        return "en"
    return fallback


def system_lang() -> str:
    env = os.environ.get("ICD_LANG") or os.environ.get("LC_ALL") or os.environ.get("LANG")
    if env:
        norm = env.split(".")[0].replace("_", "-").lower()
        if norm.startswith("zh"):
            return "zh-CN"
        if norm.startswith("en"):
            return "en"
    if os.name == "nt":
        try:
            import ctypes

            lang_id = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            # Primary language ID 0x04 == LANG_CHINESE
            if (lang_id & 0x3FF) == 0x04:
                return "zh-CN"
            return "en"
        except Exception:  # noqa: BLE001
            pass
    try:
        loc = (locale.getlocale()[0] or "")
        if loc.lower().startswith("zh"):
            return "zh-CN"
        if loc.lower().startswith("en"):
            return "en"
    except Exception:  # noqa: BLE001
        pass
    return "zh-CN"


def get_lang() -> str:
    return _current_lang.get()


def is_en() -> bool:
    return _current_lang.get() == "en"


def set_lang(lang: str | None) -> str:
    resolved = normalize_lang(lang)
    _current_lang.set(resolved)
    return resolved


@contextmanager
def use_lang(lang: str | None) -> Iterator[str]:
    resolved = normalize_lang(lang)
    token = _current_lang.set(resolved)
    try:
        yield resolved
    finally:
        _current_lang.reset(token)


def tr(zh: str, en: str) -> str:
    """Return ``en`` when the active locale is English, otherwise ``zh``."""
    return en if _current_lang.get() == "en" else zh
