"""Offline tests for iCloud Notes write support (no network, no credentials)."""

from __future__ import annotations

import base64
import gzip
import types
import zlib
from typing import Any

import pytest
from fastapi import HTTPException

from app import notes_write
from app.notes_crdt import CRDTError, MAX_CLOCK, new_document, replace_document, validate
from app.notes_proto import (
    AttachmentInfo,
    AttributeRun,
    CharID,
    Clock,
    ParagraphStyle,
    ReplicaClock,
    Substring,
    Todo,
    TTString,
    decode_text_data,
    encode_document,
    encode_text_data,
    parse,
    read_varint,
    write_varint,
)
from app.notes_text import (
    build_text_and_runs,
    check_editable,
    paragraphs_from_doc,
    parse_markdown,
    plain_text,
    render_markdown,
    title_and_snippet,
)
from app.notes_write import (
    DEFAULT_FOLDER,
    TRASH_FOLDER,
    NotesWriter,
    dec_string,
    note_state,
)

SAMPLE_MD = "\n".join([
    "# 购物清单",
    "## 周末",
    "普通 **粗体** 和 *斜体* 还有 ~~删除~~ 与 [链接](https://example.com)",
    "- 苹果",
    "  - 红富士",
    "* 破折号",
    "1. 第一",
    "2. 第二",
    "- [ ] 牛奶",
    "- [x] 面包",
    "> 引用",
    "### 小标题",
    "```",
    "code line",
    "```",
    "emoji 😀 结尾",
])


def doc_from_md(md: str) -> TTString:
    text, runs = build_text_and_runs(parse_markdown(md))
    return new_document(text, runs)


def body_b64(doc: TTString) -> str:
    return encode_text_data(doc)


# ------------------------------------------------------------------ proto
def test_varint_roundtrip():
    for v in (0, 1, 127, 128, 300, 2**32 - 1, 2**63):
        assert read_varint(write_varint(v), 0) == (v, len(write_varint(v)))


def test_document_roundtrip_and_unknown_fields():
    doc = doc_from_md(SAMPLE_MD)
    doc.unknown.append((99, 0, 7))
    doc.runs[0].unknown.append((10, 2, b"\x0d\x00\x00\x80\x3f"))  # color, kept verbatim
    again = decode_text_data(encode_text_data(doc))
    assert again.encode() == doc.encode()
    assert again.unknown == [(99, 0, 7)]
    assert again.runs[0].has_field(10)


@pytest.mark.parametrize("pack", [
    lambda b: zlib.compress(b),
    lambda b: gzip.compress(b),
    lambda b: zlib.compress(b)[2:-4],  # raw deflate
    lambda b: b,  # uncompressed
])
def test_unpack_variants(pack):
    doc = doc_from_md("标题\n正文")
    raw = pack(encode_document(doc))
    assert decode_text_data(base64.b64encode(raw).decode()).string == "标题\n正文"


def test_document_envelope_shape():
    doc = doc_from_md("t")
    fields = parse(encode_document(doc))
    assert [(n, w) for n, w, _ in fields] == [(1, 0), (2, 2)]
    version = parse(fields[1][2])
    assert [n for n, _, _ in version] == [1, 2, 3]


def test_readable_by_pyicloud_notestore_parser():
    """pyicloud's independent notestore.proto (apple_cloud_notes_parser) must read our output."""
    from pyicloud.services.notes.protobuf import notes_pb2

    doc = doc_from_md(SAMPLE_MD)
    raw = zlib.decompress(base64.b64decode(body_b64(doc)))
    msg = notes_pb2.NoteStoreProto()
    msg.ParseFromString(raw)
    note = msg.document.note
    assert note.note_text == doc.string
    assert sum(r.length for r in note.attribute_run) == len(doc.string.encode("utf-16-le")) // 2
    styles = [r.paragraph_style.style_type for r in note.attribute_run if r.HasField("paragraph_style")]
    assert 0 in styles and 100 in styles and 103 in styles and 4 in styles
    checks = [r.paragraph_style.checklist.done for r in note.attribute_run
              if r.HasField("paragraph_style") and r.paragraph_style.HasField("checklist")]
    assert sorted(checks) == [0, 1]
    assert any(r.link == "https://example.com" for r in note.attribute_run)


def test_decode_note_written_by_notestore_schema():
    """A body produced with the notestore schema (as Apple devices do) decodes and is flagged."""
    from pyicloud.services.notes.protobuf import notes_pb2

    msg = notes_pb2.NoteStoreProto()
    note = msg.document.note
    msg.document.version = 0
    note.note_text = "标题\n图片\ufffc\n"
    r = note.attribute_run.add()
    r.length = 3
    r.paragraph_style.style_type = 0
    r = note.attribute_run.add()
    r.length = 2
    r = note.attribute_run.add()
    r.length = 1
    r.attachment_info.attachment_identifier = "ABC"
    r.attachment_info.type_uti = "public.jpeg"
    r = note.attribute_run.add()
    r.length = 1
    b64 = base64.b64encode(gzip.compress(msg.SerializeToString())).decode()
    doc = decode_text_data(b64)
    assert doc.string == "标题\n图片\ufffc\n"
    check = check_editable(doc)
    assert not check.editable and check.code == "attachments"
    assert "图片" in check.blocker
    assert "[图片]" in render_markdown(doc)


# ---------------------------------------------------------------- markdown
def test_markdown_roundtrip():
    doc = doc_from_md(SAMPLE_MD)
    md = render_markdown(doc)
    assert md == SAMPLE_MD
    # stable on a second pass
    assert render_markdown(doc_from_md(md)) == md


def test_markdown_styles():
    paras = paragraphs_from_doc(doc_from_md(SAMPLE_MD))
    by_text = {p.text: p for p in paras}
    assert by_text["购物清单"].style == 0
    assert by_text["周末"].style == 1
    assert by_text["小标题"].style == 2
    assert by_text["苹果"].style == 100 and by_text["红富士"].indent == 1
    assert by_text["破折号"].style == 101
    assert by_text["第一"].style == 102
    assert by_text["牛奶"].style == 103 and not by_text["牛奶"].done
    assert by_text["面包"].done and by_text["面包"].todo_uuid
    assert by_text["引用"].quote == 1
    assert by_text["code line"].style == 4


def test_first_line_is_title_and_plain_text():
    doc = doc_from_md("Hello\nworld")
    assert doc.string == "Hello\nworld"
    assert doc.runs[0].paragraph_style.style == 0
    assert plain_text(doc) == "Hello\nworld"
    assert render_markdown(doc) == "# Hello\nworld"


def test_numbered_list_start():
    md = "# t\n3. c\n4. d"
    assert render_markdown(doc_from_md(md)) == md


# --------------------------------------------------------------- title/snip
def test_title_and_snippet():
    # like icloud.com: title = first line, snippet = next non-empty line, whitespace collapsed
    assert title_and_snippet("购物清单\n\n苹果  香蕉\n梨") == ("购物清单", "苹果 香蕉")
    assert title_and_snippet("\n\n  标题  \n") == ("标题", "")
    title, _ = title_and_snippet("x" * 300)
    assert len(title) <= 101 and title.endswith("…")


# --------------------------------------------------------------------- crdt
def _visible(doc: TTString) -> int:
    return sum(s.length for s in doc.substrings if not s.tombstone)


def test_new_document_structure():
    doc = doc_from_md("标题\n😀")
    validate(doc)
    start, content, end = doc.substrings
    assert (start.char_id.replica, start.char_id.clock, start.children) == (0, 0, [1])
    assert (end.char_id.replica, end.char_id.clock) == (0, MAX_CLOCK)
    assert content.length == 5 and content.children == [2]  # 😀 is 2 UTF-16 units
    assert len(doc.clocks) == 1 and doc.clocks[0].get(0) == 5 and doc.clocks[0].get(1) == 1


def _two_replica_doc() -> TTString:
    """Simulates a note edited on two devices: 'AB' by replica 1, 'X' deleted, 'cd' by replica 2."""
    u1, u2 = b"\x10" * 16, b"\x80" * 16
    subs = [
        Substring(CharID(0, 0), 0, CharID(0, 0), children=[1]),
        Substring(CharID(1, 0), 2, CharID(1, 0), children=[2]),
        Substring(CharID(2, 0), 1, CharID(2, 3), tombstone=True, children=[3]),
        Substring(CharID(2, 1), 2, CharID(2, 1), children=[4]),
        Substring(CharID(0, MAX_CLOCK), 0, CharID(0, MAX_CLOCK)),
    ]
    clocks = [Clock(u1, [ReplicaClock(2), ReplicaClock(1)]), Clock(u2, [ReplicaClock(3), ReplicaClock(4)])]
    runs = [AttributeRun(4, ParagraphStyle(style=0))]
    return TTString("ABcd", subs, clocks, True, runs)


def test_replace_document_crdt_edit():
    old = _two_replica_doc()
    validate(old)
    new_uuid = b"\x50" * 16  # sorts between the two existing replicas
    text, runs = build_text_and_runs(parse_markdown("新标题\n正文"))
    doc = replace_document(old, text, runs, replica_uuid=new_uuid)
    validate(doc)
    assert doc.string == "新标题\n正文"
    assert [c.uuid for c in doc.clocks] == [b"\x10" * 16, new_uuid, b"\x80" * 16]
    # old replica 2 is now index 3; the new replica is index 2
    assert doc.substrings[4].char_id.replica == 3
    inserted = doc.substrings[1]
    assert inserted.char_id.replica == 2 and inserted.char_id.clock == 3
    assert inserted.length == 6 and not inserted.tombstone
    assert doc.substrings[0].children == [1] and inserted.children == [2]
    olds = [s for s in doc.substrings[2:-1]]
    assert all(s.tombstone for s in olds)
    assert all(s.timestamp.replica == 2 for s in (olds[0], olds[2]))
    assert _visible(doc) == 6
    assert doc.clocks[1].get(0) == 3 + 6 and doc.clocks[1].get(1) >= 5
    # original untouched
    assert old.string == "ABcd" and not old.substrings[1].tombstone


def test_replace_document_requires_vector_clock():
    old = _two_replica_doc()
    old.clocks = []
    with pytest.raises(CRDTError):
        replace_document(old, "x", [AttributeRun(1)])


def test_replace_then_replace_again():
    doc = doc_from_md("a\nb")
    for i in range(3):
        text, runs = build_text_and_runs(parse_markdown(f"v{i}\nbody {i}"))
        doc = replace_document(doc, text, runs)
        validate(doc)
        doc = decode_text_data(encode_text_data(doc))
    assert doc.string == "v2\nbody 2"
    assert len(doc.clocks) == 4


# ------------------------------------------------------------------- writer
class FakeCloudKit:
    def __init__(self, records: dict[str, dict[str, Any]] | None = None):
        self.records = records or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.modify_errors: dict[str, str] = {}
        self.tag = 0

    def __call__(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((path, payload))
        assert payload["zoneID"] == {"zoneName": "Notes"}
        if path == "/records/lookup":
            out = []
            for r in payload["records"]:
                name = r["recordName"]
                out.append(self.records.get(name) or {"recordName": name, "serverErrorCode": "NOT_FOUND"})
            return {"records": out}
        assert path == "/records/modify"
        out = []
        for op in payload["operations"]:
            rec = op["record"]
            err = self.modify_errors.get(rec["recordName"])
            if err:
                out.append({"recordName": rec["recordName"], "serverErrorCode": err, "reason": "x"})
                continue
            self.tag += 1
            out.append({"recordName": rec["recordName"], "recordChangeTag": f"t{self.tag}"})
        return {"records": out}

    def modifies(self) -> list[dict[str, Any]]:
        return [op for path, p in self.calls if path == "/records/modify" for op in p["operations"]]


def note_record(name: str, doc: TTString | None, *, tag: str = "abc", rtype: str = "Note",
                folder: str = DEFAULT_FOLDER) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "TitleEncrypted": {"value": base64.b64encode(b"t").decode(), "type": "ENCRYPTED_BYTES"},
        "Folder": {"value": {"recordName": folder, "action": "VALIDATE"}, "type": "REFERENCE"},
    }
    if doc is not None:
        fields["TextDataEncrypted"] = {"value": body_b64(doc), "type": "ENCRYPTED_BYTES"}
    return {"recordName": name, "recordType": rtype, "recordChangeTag": tag, "fields": fields}


def test_create_note_payload():
    ck = FakeCloudKit()
    out = NotesWriter(ck).create_note(None, "购物清单\n- 苹果\n- 香蕉")
    (op,) = ck.modifies()
    assert op["operationType"] == "create"
    rec = op["record"]
    assert rec["recordType"] == "Note" and rec["recordName"] == out["id"] and rec["recordName"].isupper()
    assert rec["parent"] == {"recordName": DEFAULT_FOLDER}
    f = rec["fields"]
    assert set(f) == {"TitleEncrypted", "SnippetEncrypted", "TextDataEncrypted", "CreationDate",
                      "ModificationDate", "Folder", "Folders"}
    assert f["TitleEncrypted"]["type"] == "ENCRYPTED_BYTES"
    assert dec_string(f["TitleEncrypted"]["value"]) == "购物清单"
    assert dec_string(f["SnippetEncrypted"]["value"]) == "苹果"
    assert f["ModificationDate"]["type"] == "TIMESTAMP" and isinstance(f["ModificationDate"]["value"], int)
    assert f["Folder"]["value"]["recordName"] == DEFAULT_FOLDER
    assert f["Folders"]["type"] == "REFERENCE_LIST" and f["Folders"]["value"][0]["recordName"] == DEFAULT_FOLDER
    doc = decode_text_data(f["TextDataEncrypted"]["value"])
    validate(doc)
    assert doc.string == "购物清单\n苹果\n香蕉"
    assert out["title"] == "购物清单" and out["change_tag"] == "t1" and out["editable"] is True
    assert out["markdown"] == "# 购物清单\n- 苹果\n- 香蕉"


def test_create_note_in_folder_checks_folder():
    ck = FakeCloudKit({"F1": {"recordName": "F1", "recordType": "Folder", "fields": {}}})
    NotesWriter(ck).create_note("F1", "x")
    assert ck.modifies()[0]["record"]["fields"]["Folder"]["value"]["recordName"] == "F1"
    with pytest.raises(HTTPException) as e:
        NotesWriter(FakeCloudKit()).create_note("missing", "x")
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        NotesWriter(FakeCloudKit()).create_note(TRASH_FOLDER, "x")
    assert e.value.status_code == 400


def test_empty_note_is_valid():
    ck = FakeCloudKit()
    out = NotesWriter(ck).create_note(None, "")
    fields = ck.modifies()[0]["record"]["fields"]
    doc = decode_text_data(fields["TextDataEncrypted"]["value"])
    validate(doc)
    assert doc.string == "\n"
    # localized versions of the web's "New Note" / "No additional text"
    assert dec_string(fields["TitleEncrypted"]["value"]) == out["title"] == "新备忘录"
    assert dec_string(fields["SnippetEncrypted"]["value"]) == "无附加文本"


def test_update_note_payload_and_change_tag():
    old = doc_from_md("旧标题\n- [ ] 牛奶")
    ck = FakeCloudKit({"N1": note_record("N1", old, tag="tagA")})
    out = NotesWriter(ck).update_note("N1", "新标题\n- [x] 牛奶\n更多")
    (op,) = ck.modifies()
    assert op["operationType"] == "update"
    rec = op["record"]
    assert rec["recordChangeTag"] == "tagA" and rec["recordType"] == "Note"
    assert set(rec["fields"]) == {"TitleEncrypted", "SnippetEncrypted", "TextDataEncrypted", "ModificationDate"}
    doc = decode_text_data(rec["fields"]["TextDataEncrypted"]["value"])
    validate(doc)
    assert doc.string == "新标题\n牛奶\n更多"
    assert len(doc.clocks) == 2  # old replica + ours
    # checklist item identity is kept
    old_uuid = paragraphs_from_doc(old)[1].todo_uuid
    assert paragraphs_from_doc(doc)[1].todo_uuid == old_uuid and paragraphs_from_doc(doc)[1].done
    assert out["change_tag"] == "t1" and out["title"] == "新标题"


def test_update_conflict_maps_to_409():
    ck = FakeCloudKit({"N1": note_record("N1", doc_from_md("a"))})
    ck.modify_errors["N1"] = "CONFLICT"
    with pytest.raises(HTTPException) as e:
        NotesWriter(ck).update_note("N1", "b")
    assert e.value.status_code == 409


def test_update_stale_client_change_tag_is_409():
    ck = FakeCloudKit({"N1": note_record("N1", doc_from_md("a"), tag="new")})
    with pytest.raises(HTTPException) as e:
        NotesWriter(ck).update_note("N1", "b", change_tag="old")
    assert e.value.status_code == 409
    assert not ck.modifies()


def test_update_missing_note_is_404():
    with pytest.raises(HTTPException) as e:
        NotesWriter(FakeCloudKit()).update_note("nope", "b")
    assert e.value.status_code == 404


def test_locked_note_is_423():
    ck = FakeCloudKit({"N1": note_record("N1", None, rtype="PasswordProtectedNote")})
    with pytest.raises(HTTPException) as e:
        NotesWriter(ck).update_note("N1", "b")
    assert e.value.status_code == 423
    extras = NotesWriter(ck).get_state("N1").extras()
    assert extras["editable"] is False and extras["edit_blocker_code"] == "locked"


def _doc_with_attachment() -> TTString:
    text, runs = build_text_and_runs(parse_markdown("标题\n看图"))
    runs.append(AttributeRun(1, attachment_info=AttachmentInfo("IMG1", "com.apple.notes.table")))
    return new_document(text + "\ufffc", runs)


def test_attachments_block_edit_unless_forced():
    doc = _doc_with_attachment()
    extras = note_state(note_record("N1", doc)).extras()
    assert extras["editable"] is False and extras["edit_blocker_code"] == "attachments"
    assert "表格" in extras["edit_blocker"]
    assert "[表格]" in extras["markdown"]

    ck = FakeCloudKit({"N1": note_record("N1", doc)})
    with pytest.raises(HTTPException) as e:
        NotesWriter(ck).update_note("N1", "x")
    assert e.value.status_code == 409 and "force" in e.value.detail
    NotesWriter(ck).update_note("N1", "x\ny", force=True)
    new = decode_text_data(ck.modifies()[0]["record"]["fields"]["TextDataEncrypted"]["value"])
    validate(new)
    assert new.string == "x\ny" and check_editable(new).editable


def test_asset_body_not_editable():
    rec = note_record("N1", None)
    rec["fields"]["TextDataAsset"] = {"value": {"downloadURL": "x"}, "type": "ASSETID"}
    st = note_state(rec)
    assert st.extras()["edit_blocker_code"] == "asset_body"
    with pytest.raises(HTTPException) as e:
        NotesWriter(FakeCloudKit({"N1": rec})).update_note("N1", "x", force=True)
    assert e.value.status_code == 409


def test_editable_extras_for_plain_note():
    extras = note_state(note_record("N1", doc_from_md("a\n- b"))).extras()
    assert extras == {"markdown": "# a\n- b", "editable": True, "edit_blocker": None,
                      "edit_blocker_code": None, "edit_warnings": [], "change_tag": "abc"}


def test_trash_move_and_permanent_delete():
    ck = FakeCloudKit({
        "N1": note_record("N1", doc_from_md("a"), tag="t0"),
        "F2": {"recordName": "F2", "recordType": "Folder", "fields": {}},
    })
    w = NotesWriter(ck)
    w.delete_note("N1")
    w.move_note("N1", "F2")
    w.delete_note("N1", permanent=True)
    trash, move, perm = ck.modifies()
    assert trash["record"]["fields"]["Folder"]["value"]["recordName"] == TRASH_FOLDER
    assert trash["record"]["parent"] == {"recordName": TRASH_FOLDER}
    assert set(trash["record"]["fields"]) == {"Folder", "Folders", "FoldersModificationDate"}
    assert trash["record"]["recordChangeTag"] == "t0"
    assert move["record"]["fields"]["Folders"]["value"][0]["recordName"] == "F2"
    assert perm["record"]["fields"] == {"Deleted": {"type": "INT64", "value": 1}}


def test_folder_ops():
    folder = {"recordName": "F1", "recordType": "Folder", "recordChangeTag": "f0", "fields": {}}
    sub = {"recordName": "F2", "recordType": "Folder", "recordChangeTag": "f1",
           "fields": {"ParentFolder": {"value": {"recordName": "F1"}}}}
    ck = FakeCloudKit({"F1": folder, "F2": sub,
                       "N1": note_record("N1", doc_from_md("a"), folder="F1"),
                       "N2": note_record("N2", doc_from_md("b"), folder="F2")})
    service = types.SimpleNamespace(
        folders=lambda: [types.SimpleNamespace(id="F1", parent_id=None),
                         types.SimpleNamespace(id="F2", parent_id="F1")],
        in_folder=lambda fid: [types.SimpleNamespace(id={"F1": "N1", "F2": "N2"}[fid])],
    )
    w = NotesWriter(ck, service)

    created = w.create_folder("工作", parent_id="F1")
    op = ck.modifies()[-1]
    assert op["operationType"] == "create" and op["record"]["recordType"] == "Folder"
    assert dec_string(op["record"]["fields"]["TitleEncrypted"]["value"]) == "工作"
    assert op["record"]["fields"]["ParentFolder"]["value"]["recordName"] == "F1"
    assert created["name"] == "工作" and created["parent_id"] == "F1"

    w.rename_folder("F1", "改名")
    op = ck.modifies()[-1]
    assert op["record"]["recordChangeTag"] == "f0"
    assert list(op["record"]["fields"]) == ["TitleEncrypted"]

    out = w.delete_folder("F1")
    ops = ck.modifies()[-4:]
    assert [o["operationType"] for o in ops] == ["update", "update", "forceDelete", "forceDelete"]
    assert {o["record"]["recordName"] for o in ops[:2]} == {"N1", "N2"}
    assert all(o["record"]["fields"]["Folder"]["value"]["recordName"] == TRASH_FOLDER for o in ops[:2])
    assert [o["record"]["recordName"] for o in ops[2:]] == ["F2", "F1"]
    assert out["trashed_notes"] == 2

    for bad in (lambda: w.delete_folder(DEFAULT_FOLDER), lambda: w.rename_folder(TRASH_FOLDER, "x"),
                lambda: w.create_folder("  ")):
        with pytest.raises(HTTPException) as e:
            bad()
        assert e.value.status_code == 400


def test_cloudkit_exceptions_are_mapped():
    from pyicloud.common.cloudkit.client import CloudKitApiError, CloudKitAuthError, CloudKitRateLimited

    def raiser(exc):
        def post(path, payload):
            raise exc
        return post

    cases = [
        (CloudKitRateLimited("slow"), 429),
        (CloudKitAuthError("auth"), 401),
        (CloudKitApiError("bad", payload={"serverErrorCode": "CONFLICT"}), 409),
        (CloudKitApiError("bad", payload={"records": [{"serverErrorCode": "NOT_FOUND"}]}), 404),
        (CloudKitApiError("boom"), 502),
    ]
    for exc, status in cases:
        with pytest.raises(HTTPException) as e:
            NotesWriter(raiser(exc)).lookup(["x"])
        assert e.value.status_code == status


def test_atomic_error_reports_real_cause():
    with pytest.raises(HTTPException) as e:
        notes_write.NotesWriter(lambda p, b: {"records": [
            {"recordName": "a", "serverErrorCode": "ATOMIC_ERROR"},
            {"recordName": "b", "serverErrorCode": "CONFLICT"},
        ]}).modify([{"operationType": "update", "record": {"recordName": "a"}}])
    assert e.value.status_code == 409 and "其他设备" in e.value.detail


# ------------------------------------------------------------------- routes
def test_routes_use_writer(monkeypatch):
    from app.routes import notes as routes

    ck = FakeCloudKit({"N1": note_record("N1", doc_from_md("a\nb"), tag="t0")})
    fake_api = types.SimpleNamespace(notes=types.SimpleNamespace(
        raw=types.SimpleNamespace(_client=types.SimpleNamespace(raw_post=ck)),
        _folder_name_cache={"F1": "old"},
    ))
    monkeypatch.setattr(routes, "run", lambda fn: fn(fake_api))

    created = routes.create_note(routes.NoteCreate(folder_id=None, text="新\n内容"))
    assert created["title"] == "新"
    updated = routes.update_note("N1", routes.NoteUpdate(text="c\nd", change_tag="t0"))
    assert updated["markdown"] == "# c\nd"
    with pytest.raises(HTTPException) as e:
        routes.update_note("N1", routes.NoteUpdate(text="c", change_tag="stale"))
    assert e.value.status_code == 409
    assert routes.delete_note("N1", permanent=False)["folder_id"] == TRASH_FOLDER
    folder = routes.create_folder(routes.FolderCreate(name="文件夹"))
    assert folder["title"] == "文件夹"
    ck.records["F1"] = {"recordName": "F1", "recordType": "Folder", "fields": {}}
    routes.rename_folder("F1", routes.FolderRename(title="新名字"))
    assert "F1" not in fake_api.notes._folder_name_cache
