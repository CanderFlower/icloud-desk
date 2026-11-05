from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..icloud import icloud

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    apple_id: str
    password: str
    china_mainland: bool = False
    remember: bool = True


class CodeBody(BaseModel):
    code: str


class LogoutBody(BaseModel):
    forget_password: bool = False


@router.get("/status")
def status():
    return icloud.status()


@router.post("/login")
def login(body: LoginBody):
    return icloud.login(body.apple_id, body.password, body.china_mainland, body.remember)


@router.post("/2fa/request")
def request_code():
    return icloud.request_2fa()


@router.post("/2fa/verify")
def verify_code(body: CodeBody):
    return icloud.verify_2fa(body.code)


@router.post("/logout")
def logout(body: LogoutBody):
    return icloud.logout(body.forget_password)
