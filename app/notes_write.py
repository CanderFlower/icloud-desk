"""Write support for iCloud Notes through the CloudKit web services API.

Mirrors what icloud.com Notes does (``Note`` / ``Folder`` CKModels in the web
bundle): records live in the private database, zone ``Notes``; changes are
sent to ``/records/modify`` with the record's ``recordChangeTag`` so CloudKit
rejects writes based on a stale copy (``serverErrorCode: CONFLICT``).
"""

from __future__ import annotations

import base64
import time
import uuid as uuidlib
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from fastapi import HTTPException

from .notes_crdt import CRDTError, new_document, replace_document, validate
from .notes_proto import ProtoError, TTString, decode_text_data, encode_text_data
from .notes_text import (
    EditCheck,
    build_text_and_runs,
    check_editable,
    paragraphs_from_doc,
    parse_markdown,
    plain_text,
    render_markdown,
    reuse_todo_uuids,
    title_and_snippet,
)

ZONE = {"zoneName": "Notes"}
DEFAULT_FOLDER = "DefaultFolder-CloudKit"
TRASH_FOLDER = "TrashFolder-CloudKit"
SPECIAL_FOLDERS = {DEFAULT_FOLDER, TRASH_FOLDER}
LOCKED_TYPE = "PasswordProtectedNote"
EMPTY_TITLE = "新备忘录"  # web: loc("Note.Empty.Title")
EMPTY_SNIPPET = "无附加文本"  # web: loc("Note.Empty.Snippet")
MAX_OPS = 200

Post = Callable[[str, dict[str, Any]], dict[str, Any]]


# ------------------------------------------------------------------ helpers
def now_ms() -> int:
    return int(time.time() * 1000)


def enc_string(text: str) -> str:
    """``EncryptedString`` encoding used for ``*Encrypted`` text fields."""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def dec_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4)).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return str(value)


def ref(record_name: str, action: str = "VALIDATE") -> dict[str, Any]:
    return {"recordName": record_name, "action": action, "zoneID": dict(ZONE)}


def f_encrypted(text: str) -> dict[str, Any]:
    return {"type": "ENCRYPTED_BYTES", "value": enc_string(text)}


def f_bytes_b64(b64: str) -> dict[str, Any]:
    return {"type": "ENCRYPTED_BYTES", "value": b64}


def f_timestamp(ms: int) -> dict[str, Any]:
    return {"type": "TIMESTAMP", "value": ms}


def f_int(v: int) -> dict[str, Any]:
    return {"type": "INT64", "value": v}


def f_ref(record_name: str) -> dict[str, Any]:
    return {"type": "REFERENCE", "value": ref(record_name)}


def f_ref_list(record_name: str) -> dict[str, Any]:
    return {"type": "REFERENCE_LIST", "value": [ref(record_name)]}


def field_value(record: dict[str, Any], name: str) -> Any:
    f = (record.get("fields") or {}).get(name)
    return f.get("value") if isinstance(f, dict) else None


def ref_name(value: Any) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        name = value.get("recordName")
        return name if isinstance(name, str) else None
    return None


def folder_of(record: dict[str, Any]) -> str | None:
    return ref_name(field_value(record, "Folder")) or ref_name(field_value(record, "Folders"))


def _title_snippet(body: str) -> tuple[str, str]:
    """``regenerateTitleAndSnippet``: title = first line, snippet = next line, with fallbacks."""
    title, snippet = title_and_snippet(body)
    if not snippet:
        n = body.count("\ufffc")
        snippet = f"{n} 个附件" if n else EMPTY_SNIPPET
    return title or EMPTY_TITLE, snippet


def _iso(ms: Any) -> str | None:
    if not isinstance(ms, (int, float)):
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


_ERRORS = {
    "CONFLICT": (409, "备忘录已在其他设备上被修改，请刷新后重试"),
    "ATOMIC_ERROR": (409, "同批次中的其他修改失败，本次修改未保存"),
    "NOT_FOUND": (404, "备忘录或文件夹不存在（可能已被删除）"),
    "UNKNOWN_ITEM": (404, "备忘录或文件夹不存在（可能已被删除）"),
    "ACCESS_DENIED": (403, "没有权限修改这条备忘录"),
    "PERMISSION_FAILURE": (403, "没有权限修改这条备忘录"),
    "AUTHENTICATION_FAILED": (401, "iCloud 会话已失效，请重新登录"),
    "AUTHENTICATION_REQUIRED": (401, "iCloud 会话已失效，请重新登录"),
    "QUOTA_EXCEEDED": (507, "iCloud 存储空间已满"),
    "THROTTLED": (429, "iCloud 请求过于频繁，请稍后再试"),
    "TRY_AGAIN_LATER": (503, "iCloud 暂时不可用，请稍后再试"),
    "VALIDATING_REFERENCE_ERROR": (404, "目标文件夹不存在"),
    "ZONE_NOT_FOUND": (404, "找不到备忘录数据区（Notes zone）"),
    "LIMIT_EXCEEDED": (413, "备忘录内容过大"),
}


def raise_for_server_error(entry: dict[str, Any]) -> None:
    code = entry.get("serverErrorCode")
    if not code:
        return
    status, detail = _ERRORS.get(code, (502, "iCloud 拒绝了这次修改"))
    reason = entry.get("reason")
    if status == 502 and reason:
        detail = f"{detail}：{code} {reason}"
    raise HTTPException(status, detail)


# ------------------------------------------------------------------- state
@dataclass
class NoteState:
    record: dict[str, Any]
    doc: TTString | None
    check: EditCheck
    locked: bool

    @property
    def change_tag(self) -> str | None:
        return self.record.get("recordChangeTag")

    def extras(self) -> dict[str, Any]:
        markdown = render_markdown(self.doc) if self.doc is not None else None
        if self.locked:
            code, blocker = "locked", "这条备忘录已加锁，无法通过网页接口编辑"
        elif not self.check.editable:
            code, blocker = self.check.code, self.check.blocker
        else:
            code, blocker = None, None
        return {
            "markdown": markdown,
            "editable": blocker is None,
            "edit_blocker": blocker,
            "edit_blocker_code": code,
            "edit_warnings": self.check.warnings,
            "change_tag": self.change_tag,
        }


def note_state(record: dict[str, Any]) -> NoteState:
    locked = record.get("recordType") == LOCKED_TYPE
    if locked:
        return NoteState(record, None, EditCheck(False, "locked", "已加锁"), True)
    body = field_value(record, "TextDataEncrypted")
    if not body:
        if field_value(record, "TextDataAsset"):
            check = EditCheck(False, "asset_body", "这条备忘录正文过大（以文件形式存储），暂不支持编辑")
        else:
            check = EditCheck(True)  # empty note
        return NoteState(record, None, check, False)
    try:
        doc = decode_text_data(body)
    except (ProtoError, UnicodeDecodeError, ValueError):
        return NoteState(record, None, EditCheck(False, "unsupported", "无法解析这条备忘录的正文格式"), False)
    return NoteState(record, doc, check_editable(doc), False)


# ------------------------------------------------------------------ writer
class NotesWriter:
    def __init__(self, post: Post, service: Any = None) -> None:
        self._post = post
        self._service = service

    @classmethod
    def for_api(cls, api: Any) -> "NotesWriter":
        notes = api.notes
        return cls(notes.raw._client.raw_post, notes)

    # ---------------------------------------------------------------- http
    def _call(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        from pyicloud.common.cloudkit.client import (
            CloudKitApiError,
            CloudKitAuthError,
            CloudKitRateLimited,
        )

        try:
            return self._post(path, payload) or {}
        except CloudKitRateLimited as exc:
            raise HTTPException(429, "iCloud 请求过于频繁，请稍后再试") from exc
        except CloudKitAuthError as exc:
            raise HTTPException(401, "iCloud 会话已失效，请重新登录") from exc
        except CloudKitApiError as exc:
            body = getattr(exc, "payload", None)
            if isinstance(body, dict):
                if body.get("serverErrorCode"):
                    raise_for_server_error(body)
                for entry in body.get("records") or []:
                    if isinstance(entry, dict):
                        raise_for_server_error(entry)
            raise HTTPException(502, f"iCloud 返回错误：{exc}") from exc

    def lookup(self, names: Iterable[str]) -> dict[str, dict[str, Any]]:
        names = list(names)
        if not names:
            return {}
        data = self._call(
            "/records/lookup",
            {"records": [{"recordName": n} for n in names], "zoneID": dict(ZONE)},
        )
        out: dict[str, dict[str, Any]] = {}
        for entry in data.get("records") or []:
            if isinstance(entry, dict) and entry.get("recordName") and not entry.get("serverErrorCode"):
                out[entry["recordName"]] = entry
        return out

    def lookup_one(self, name: str, what: str = "备忘录") -> dict[str, Any]:
        rec = self.lookup([name]).get(name)
        if rec is None or rec.get("deleted"):
            raise HTTPException(404, f"{what}不存在")
        return rec

    def modify(self, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        saved: list[dict[str, Any]] = []
        for i in range(0, len(operations), MAX_OPS):
            data = self._call(
                "/records/modify",
                {"operations": operations[i : i + MAX_OPS], "zoneID": dict(ZONE)},
            )
            records = [r for r in data.get("records") or [] if isinstance(r, dict)]
            # A rejected batch reports the real cause on one record and
            # ATOMIC_ERROR on the rest; surface the real cause.
            for entry in sorted(records, key=lambda r: r.get("serverErrorCode") == "ATOMIC_ERROR"):
                raise_for_server_error(entry)
            saved.extend(records)
        return saved

    @staticmethod
    def _update(record: dict[str, Any], fields: dict[str, Any], **extra: Any) -> dict[str, Any]:
        rec: dict[str, Any] = {
            "recordName": record["recordName"],
            "recordType": record.get("recordType", "Note"),
            "fields": fields,
        }
        if record.get("recordChangeTag"):
            rec["recordChangeTag"] = record["recordChangeTag"]
        rec.update(extra)
        return {"operationType": "update", "record": rec}

    # --------------------------------------------------------------- notes
    def get_state(self, note_id: str) -> NoteState:
        return note_state(self.lookup_one(note_id))

    def _check_folder(self, folder_id: str) -> None:
        if folder_id == TRASH_FOLDER:
            raise HTTPException(400, "不能在“最近删除”中新建备忘录")
        if folder_id != DEFAULT_FOLDER:
            rec = self.lookup_one(folder_id, "文件夹")
            if rec.get("recordType") != "Folder":
                raise HTTPException(400, "folder_id 不是文件夹")
            if field_value(rec, "Deleted"):
                raise HTTPException(404, "文件夹已被删除")

    def create_note(self, folder_id: str | None, text: str) -> dict[str, Any]:
        folder_id = folder_id or DEFAULT_FOLDER
        self._check_folder(folder_id)
        paras = parse_markdown(text or "")
        body, runs = build_text_and_runs(paras)
        if not body:
            from .notes_proto import AttributeRun, ParagraphStyle

            body, runs = "\n", [AttributeRun(1, ParagraphStyle(style=0))]
        doc = new_document(body, runs)
        validate(doc)
        title, snippet = _title_snippet(body)
        ts = now_ms()
        record_name = str(uuidlib.uuid4()).upper()
        fields = {
            "TitleEncrypted": f_encrypted(title),
            "SnippetEncrypted": f_encrypted(snippet),
            "TextDataEncrypted": f_bytes_b64(encode_text_data(doc)),
            "CreationDate": f_timestamp(ts),
            "ModificationDate": f_timestamp(ts),
            "Folder": f_ref(folder_id),
            "Folders": f_ref_list(folder_id),
        }
        op = {
            "operationType": "create",
            "record": {
                "recordName": record_name,
                "recordType": "Note",
                "fields": fields,
                "parent": {"recordName": folder_id},
            },
        }
        saved = self.modify([op])
        tag = next((r.get("recordChangeTag") for r in saved if r.get("recordName") == record_name), None)
        return self._result(record_name, title, snippet, folder_id, ts, doc, tag)

    def update_note(
        self, note_id: str, text: str, *, force: bool = False, change_tag: str | None = None
    ) -> dict[str, Any]:
        state = self.get_state(note_id)
        if state.locked:
            raise HTTPException(423, "这条备忘录已加锁，无法通过网页接口编辑")
        if change_tag and state.change_tag and change_tag != state.change_tag:
            raise HTTPException(409, "备忘录已在其他设备上被修改，请刷新后重试")
        if not state.check.editable:
            if state.check.code != "attachments" or not force:
                status = 409
                detail = state.check.blocker or "无法编辑这条备忘录"
                if state.check.code == "attachments":
                    detail += "；如确认要覆盖，请使用 force=true"
                raise HTTPException(status, detail)

        paras = parse_markdown(text or "")
        if state.doc is not None:
            reuse_todo_uuids(paras, paragraphs_from_doc(state.doc))
        body, runs = build_text_and_runs(paras)
        try:
            if state.doc is not None and state.doc.substrings:
                doc = replace_document(state.doc, body, runs)
            else:
                doc = new_document(body, runs)
            validate(doc)
        except CRDTError as exc:
            raise HTTPException(409, f"无法安全地修改这条备忘录的正文结构（{exc}）") from exc
        title, snippet = _title_snippet(body)
        ts = now_ms()
        fields = {
            "TitleEncrypted": f_encrypted(title),
            "SnippetEncrypted": f_encrypted(snippet),
            "TextDataEncrypted": f_bytes_b64(encode_text_data(doc)),
            "ModificationDate": f_timestamp(ts),
        }
        saved = self.modify([self._update(state.record, fields)])
        tag = next((r.get("recordChangeTag") for r in saved if r.get("recordName") == note_id), None)
        return self._result(note_id, title, snippet, folder_of(state.record), ts, doc, tag)

    @staticmethod
    def _result(
        note_id: str, title: str, snippet: str, folder_id: str | None, ts: int, doc: TTString, tag: str | None
    ) -> dict[str, Any]:
        return {
            "id": note_id,
            "title": title,
            "snippet": snippet,
            "folder_id": folder_id,
            "modified_at": _iso(ts),
            "is_deleted": False,
            "is_locked": False,
            "text": plain_text(doc),
            "markdown": render_markdown(doc),
            "editable": True,
            "edit_blocker": None,
            "change_tag": tag,
        }

    def _move_op(self, record: dict[str, Any], folder_id: str) -> dict[str, Any]:
        fields = {
            "Folder": f_ref(folder_id),
            "Folders": f_ref_list(folder_id),
            "FoldersModificationDate": f_timestamp(now_ms()),
        }
        return self._update(record, fields, parent={"recordName": folder_id})

    def move_note(self, note_id: str, folder_id: str) -> dict[str, Any]:
        if not folder_id:
            raise HTTPException(400, "缺少目标文件夹 folder_id")
        record = self.lookup_one(note_id)
        if folder_id != TRASH_FOLDER:
            self._check_folder(folder_id)
        self.modify([self._move_op(record, folder_id)])
        return {"ok": True, "id": note_id, "folder_id": folder_id}

    def delete_note(self, note_id: str, permanent: bool = False) -> dict[str, Any]:
        record = self.lookup_one(note_id)
        if permanent:
            # icloud.com's deletePermanently(): flag the record, devices purge it.
            op = self._update(record, {"Deleted": f_int(1)})
        else:
            op = self._move_op(record, TRASH_FOLDER)
        self.modify([op])
        return {"ok": True, "id": note_id, "permanent": permanent,
                "folder_id": folder_of(record) if permanent else TRASH_FOLDER}

    # ------------------------------------------------------------- folders
    def create_folder(self, title: str, parent_id: str | None = None) -> dict[str, Any]:
        title = (title or "").strip()
        if not title:
            raise HTTPException(400, "文件夹名称不能为空")
        if parent_id in SPECIAL_FOLDERS:
            raise HTTPException(400, "不能在系统文件夹下创建子文件夹")
        if parent_id:
            self._check_folder(parent_id)
        record_name = str(uuidlib.uuid4()).upper()
        fields: dict[str, Any] = {"TitleEncrypted": f_encrypted(title)}
        rec: dict[str, Any] = {"recordName": record_name, "recordType": "Folder", "fields": fields}
        if parent_id:
            fields["ParentFolder"] = f_ref(parent_id)
            rec["parent"] = {"recordName": parent_id}
        self.modify([{"operationType": "create", "record": rec}])
        return {"id": record_name, "name": title, "title": title, "parent_id": parent_id}

    def rename_folder(self, folder_id: str, title: str) -> dict[str, Any]:
        title = (title or "").strip()
        if not title:
            raise HTTPException(400, "文件夹名称不能为空")
        if folder_id in SPECIAL_FOLDERS:
            raise HTTPException(400, "系统文件夹不能重命名")
        record = self.lookup_one(folder_id, "文件夹")
        if record.get("recordType") != "Folder":
            raise HTTPException(400, "不是文件夹")
        self.modify([self._update(record, {"TitleEncrypted": f_encrypted(title)})])
        return {"id": folder_id, "name": title, "title": title,
                "parent_id": ref_name(field_value(record, "ParentFolder"))}

    def delete_folder(self, folder_id: str) -> dict[str, Any]:
        """icloud.com ``deleteFolder``: notes go to Recently Deleted, subfolders are
        deleted recursively, then the folder record itself is removed."""
        if folder_id in SPECIAL_FOLDERS:
            raise HTTPException(400, "系统文件夹不能删除")
        record = self.lookup_one(folder_id, "文件夹")
        if record.get("recordType") != "Folder":
            raise HTTPException(400, "不是文件夹")
        folder_ids = [folder_id, *self._descendant_folders(folder_id)]
        note_ids = self._notes_in(folder_ids)
        ops: list[dict[str, Any]] = []
        records = self.lookup(note_ids)
        for nid in note_ids:
            rec = records.get(nid)
            if rec is not None and folder_of(rec) in folder_ids:
                ops.append(self._move_op(rec, TRASH_FOLDER))
        if ops:
            self.modify(ops)
        folders = self.lookup(folder_ids)
        deletes = [
            {"operationType": "forceDelete", "record": {"recordName": fid}}
            for fid in reversed(folder_ids)
            if fid in folders
        ]
        self.modify(deletes)
        return {"ok": True, "id": folder_id, "deleted_folders": folder_ids, "trashed_notes": len(ops)}

    def _descendant_folders(self, folder_id: str) -> list[str]:
        if self._service is None:
            return []
        children: dict[str, list[str]] = {}
        for f in self._service.folders():
            pid = getattr(f, "parent_id", None)
            if pid:
                children.setdefault(pid, []).append(f.id)
        out: list[str] = []
        stack = list(children.get(folder_id, []))
        while stack:
            fid = stack.pop(0)
            if fid in out or fid == folder_id:
                continue
            out.append(fid)
            stack.extend(children.get(fid, []))
        return out

    def _notes_in(self, folder_ids: list[str]) -> list[str]:
        if self._service is None:
            return []
        ids: list[str] = []
        for fid in folder_ids:
            ids.extend(n.id for n in self._service.in_folder(fid))
        return list(dict.fromkeys(ids))
