"""Owns the single PyiCloudService instance: login, 2FA, session restore and
transparent re-authentication.

All pyicloud calls must go through ``icloud.call(fn)`` so that
* they are serialized (pyicloud is not thread-safe), and
* an expired web session is silently renewed with the password stored in the
  Windows Credential Manager + the persisted trust token (no new 2FA).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, TypeVar

from pyicloud import PyiCloudService
from pyicloud.exceptions import (
    PyiCloud2FARequiredException,
    PyiCloudAPIResponseException,
    PyiCloudAuthRequiredException,
    PyiCloudFailedLoginException,
    PyiCloudNoStoredPasswordAvailableException,
)
from pyicloud.utils import (
    delete_password_in_keyring,
    get_password_from_keyring,
    store_password_in_keyring,
)

from .config import SESSION_DIR, load_settings, save_settings

log = logging.getLogger("icloud-desk")
T = TypeVar("T")

AUTH_ERROR_CODES = {401, 421, 450, "401", "421", "450"}


class NotLoggedIn(Exception):
    """Raised when an endpoint needs a session but none is available."""

    def __init__(self, state: str, message: str = "未登录") -> None:
        super().__init__(message)
        self.state = state
        self.message = message


class ICloudManager:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.api: PyiCloudService | None = None
        # logged_out | restoring | needs_2fa | ready
        self.state = "logged_out"
        self.message: str | None = None
        self.two_fa: dict[str, Any] = {}
        self.cache: dict[str, Any] = {}

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        settings = load_settings()
        apple_id = settings.get("apple_id")
        info: dict[str, Any] = {
            "state": self.state,
            "message": self.message,
            "apple_id": apple_id,
            "china_mainland": settings.get("china_mainland", False),
            "password_saved": bool(apple_id and _safe_get_password(apple_id)),
            "two_fa": self.two_fa if self.state == "needs_2fa" else None,
        }
        if self.state == "ready" and self.api is not None:
            ds = self.api.data.get("dsInfo", {}) if isinstance(self.api.data, dict) else {}
            info["user"] = {
                "full_name": ds.get("fullName"),
                "first_name": ds.get("firstName"),
                "last_name": ds.get("lastName"),
                "apple_id": ds.get("appleId") or apple_id,
                "locale": ds.get("locale"),
            }
            webservices = self.api.data.get("webservices", {}) if isinstance(self.api.data, dict) else {}
            info["services"] = sorted(webservices.keys())
        return info

    # ----------------------------------------------------------------- restore
    def restore(self) -> None:
        """Try to resume the previous session without user interaction."""
        settings = load_settings()
        apple_id = settings.get("apple_id")
        if not apple_id:
            self.state = "logged_out"
            return
        with self.lock:
            self.state = "restoring"
            try:
                password = _safe_get_password(apple_id)
                api = self._make_api(apple_id, password, settings.get("china_mainland", False), authenticate=False)
                status = api.get_auth_status()
                if status["authenticated"] and not status["requires_2fa"] and not status["requires_2sa"]:
                    self._set_ready(api)
                    return
                if not password:
                    self.state = "logged_out"
                    self.message = "会话已过期，请重新登录"
                    return
                api.authenticate()
                self._after_password_auth(api)
            except Exception as exc:  # noqa: BLE001
                log.exception("Session restore failed")
                self.state = "logged_out"
                self.message = f"自动登录失败：{exc}"

    # ------------------------------------------------------------------- login
    def login(self, apple_id: str, password: str, china_mainland: bool, remember: bool) -> dict[str, Any]:
        apple_id = apple_id.strip()
        with self.lock:
            self.message = None
            self.cache.clear()
            try:
                api = self._make_api(apple_id, password, china_mainland, authenticate=True)
            except PyiCloudFailedLoginException as exc:
                self.state = "logged_out"
                raise ValueError(f"登录失败：{exc}") from exc
            save_settings(apple_id=apple_id, china_mainland=china_mainland)
            if remember:
                try:
                    store_password_in_keyring(apple_id, password)
                except Exception:  # noqa: BLE001
                    log.warning("Could not store password in keyring", exc_info=True)
            self._after_password_auth(api)
            return self.status()

    def _after_password_auth(self, api: PyiCloudService) -> None:
        if api.requires_2fa:
            self.api = api
            self.state = "needs_2fa"
            self._request_2fa_locked()
        elif api.requires_2sa:
            self.api = api
            self.state = "needs_2fa"
            self.two_fa = {"method": "2sa", "devices": api.trusted_devices}
        else:
            self._set_ready(api)

    def _request_2fa_locked(self) -> None:
        assert self.api is not None
        api = self.api
        info: dict[str, Any] = {"method": "unknown", "notice": None}
        try:
            if getattr(api, "fido2_devices", None):
                info["method"] = "security_key"
                info["notice"] = "此账户使用安全密钥验证，本客户端暂不支持。"
            elif not api.request_2fa_code():
                info["method"] = "security_key"
                info["notice"] = "此账户需要安全密钥验证，本客户端暂不支持。"
            else:
                info["method"] = api.two_factor_delivery_method
                info["notice"] = api.two_factor_delivery_notice
        except PyiCloudAPIResponseException:
            api.use_existing_trusted_device_code()
            info["method"] = "trusted_device"
            info["notice"] = "如果你的设备上已经显示验证码，请直接输入。"
        except Exception as exc:  # noqa: BLE001
            info["notice"] = f"请求验证码失败：{exc}"
        self.two_fa = info

    def request_2fa(self) -> dict[str, Any]:
        with self.lock:
            if self.state != "needs_2fa" or self.api is None:
                raise ValueError("当前不需要双重认证")
            self._request_2fa_locked()
            return self.status()

    def verify_2fa(self, code: str) -> dict[str, Any]:
        with self.lock:
            if self.state != "needs_2fa" or self.api is None:
                raise ValueError("当前不需要双重认证")
            api = self.api
            code = code.strip()
            if self.two_fa.get("method") == "2sa":
                device = (self.two_fa.get("devices") or [{}])[0]
                ok = api.validate_verification_code(device, code)
            else:
                ok = api.validate_2fa_code(code)
            if not ok:
                raise ValueError("验证码错误，请重试")
            if not api.is_trusted_session:
                api.trust_session()
            self._set_ready(api)
            return self.status()

    def logout(self, forget_password: bool) -> dict[str, Any]:
        with self.lock:
            settings = load_settings()
            apple_id = settings.get("apple_id")
            if self.api is not None:
                try:
                    self.api.logout(keep_trusted=not forget_password, clear_local_session=True)
                except Exception:  # noqa: BLE001
                    log.warning("Logout request failed", exc_info=True)
            if forget_password and apple_id:
                try:
                    delete_password_in_keyring(apple_id)
                except Exception:  # noqa: BLE001
                    pass
            self.api = None
            self.state = "logged_out"
            self.message = None
            self.two_fa = {}
            self.cache.clear()
            return self.status()

    # -------------------------------------------------------------------- call
    def call(self, fn: Callable[[PyiCloudService], T]) -> T:
        """Run ``fn(api)`` with the lock held; re-auth once on session expiry."""
        with self.lock:
            api = self._require_api()
            try:
                return fn(api)
            except Exception as exc:  # noqa: BLE001
                if not _is_auth_error(exc):
                    raise
                log.info("Session expired (%s); re-authenticating", exc)
            self._reauthenticate()
            return fn(self._require_api())

    def _require_api(self) -> PyiCloudService:
        if self.state != "ready" or self.api is None:
            raise NotLoggedIn(self.state)
        return self.api

    def _reauthenticate(self) -> None:
        settings = load_settings()
        apple_id = settings.get("apple_id")
        password = _safe_get_password(apple_id) if apple_id else None
        if not apple_id or not password:
            self.state = "logged_out"
            self.message = "会话已过期，且未保存密码，请重新登录"
            raise NotLoggedIn(self.state, self.message)
        api = self._make_api(apple_id, password, settings.get("china_mainland", False), authenticate=False)
        api.authenticate(force_refresh=True)
        self.cache.clear()
        self._after_password_auth(api)
        if self.state != "ready":
            raise NotLoggedIn(self.state, "需要重新进行双重认证")

    # ---------------------------------------------------------------- helpers
    def _make_api(self, apple_id: str, password: str | None, china: bool, *, authenticate: bool) -> PyiCloudService:
        return PyiCloudService(
            apple_id,
            password,
            cookie_directory=str(SESSION_DIR),
            china_mainland=china,
            refresh_interval=None,
            authenticate=authenticate,
        )

    def _set_ready(self, api: PyiCloudService) -> None:
        self.api = api
        self.state = "ready"
        self.message = None
        self.two_fa = {}
        self.cache.clear()


def _safe_get_password(apple_id: str) -> str | None:
    try:
        return get_password_from_keyring(apple_id)
    except Exception:  # noqa: BLE001
        return None


def _is_auth_error(exc: BaseException) -> bool:
    if isinstance(exc, (PyiCloudAuthRequiredException, PyiCloud2FARequiredException, PyiCloudNoStoredPasswordAvailableException)):
        return True
    if isinstance(exc, PyiCloudAPIResponseException) and getattr(exc, "code", None) in AUTH_ERROR_CODES:
        return True
    return False


icloud = ICloudManager()
