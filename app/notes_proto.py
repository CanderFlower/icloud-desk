"""Hand-rolled protobuf codec for Apple Notes note bodies (``TextDataEncrypted``).

The body of a CloudKit ``Note`` record is::

    base64( zlib( versioned_document.Document {
        serializationVersion = 1;
        repeated Version version = 2 { serializationVersion = 1;
                                       minimumSupportedVersion = 2;
                                       bytes data = 3  -> topotext.String } } ) )

``topotext.String`` (see ``tests/fixtures/topotext.proto``) carries the visible
text, the CRDT substring graph, a vector clock and attribute runs.  Only the
fields we need are typed; everything else is kept as raw wire fields so a
decode -> encode round trip does not drop data.
"""

from __future__ import annotations

import base64
import zlib
from dataclasses import dataclass, field
from typing import Union

VARINT, I64, LEN, I32 = 0, 1, 2, 5

WireValue = Union[int, bytes]
RawField = tuple[int, int, WireValue]


class ProtoError(ValueError):
    """Malformed protobuf / note body."""


# --------------------------------------------------------------------- wire
def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        if pos >= len(buf):
            raise ProtoError("truncated varint")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7
        if shift > 70:
            raise ProtoError("varint too long")


def write_varint(value: int) -> bytes:
    if value < 0:
        value &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def parse(buf: bytes) -> list[RawField]:
    """Split a message into ``(field_number, wire_type, value)`` triples."""
    out: list[RawField] = []
    pos, n = 0, len(buf)
    while pos < n:
        key, pos = read_varint(buf, pos)
        num, wt = key >> 3, key & 7
        if num == 0:
            raise ProtoError("field number 0")
        val: WireValue
        if wt == VARINT:
            val, pos = read_varint(buf, pos)
        elif wt == LEN:
            ln, pos = read_varint(buf, pos)
            if pos + ln > n:
                raise ProtoError("truncated length-delimited field")
            val = bytes(buf[pos : pos + ln])
            pos += ln
        elif wt == I64:
            if pos + 8 > n:
                raise ProtoError("truncated fixed64")
            val = bytes(buf[pos : pos + 8])
            pos += 8
        elif wt == I32:
            if pos + 4 > n:
                raise ProtoError("truncated fixed32")
            val = bytes(buf[pos : pos + 4])
            pos += 4
        else:
            raise ProtoError(f"unsupported wire type {wt}")
        out.append((num, wt, val))
    return out


def enc(num: int, wt: int, val: WireValue) -> bytes:
    key = write_varint((num << 3) | wt)
    if wt == VARINT:
        return key + write_varint(int(val))  # type: ignore[arg-type]
    if wt == LEN:
        data = val if isinstance(val, bytes) else bytes(val)  # type: ignore[arg-type]
        return key + write_varint(len(data)) + data
    return key + bytes(val)  # type: ignore[arg-type]


def enc_varint(num: int, val: int) -> bytes:
    return enc(num, VARINT, val)


def enc_bytes(num: int, val: bytes) -> bytes:
    return enc(num, LEN, val)


def enc_str(num: int, val: str) -> bytes:
    return enc(num, LEN, val.encode("utf-8"))


def _int32(v: int) -> int:
    v &= (1 << 64) - 1
    return v - (1 << 64) if v >= 1 << 63 else v


def _repeated_varints(wt: int, val: WireValue) -> list[int]:
    """Repeated scalar values may arrive packed or unpacked."""
    if wt == VARINT:
        return [int(val)]  # type: ignore[arg-type]
    if wt == LEN:
        out, pos, buf = [], 0, val  # type: ignore[assignment]
        while pos < len(buf):  # type: ignore[arg-type]
            v, pos = read_varint(buf, pos)  # type: ignore[arg-type]
            out.append(v)
        return out
    raise ProtoError("bad repeated varint")


def _need_len(wt: int, what: str) -> None:
    if wt != LEN:
        raise ProtoError(f"{what}: expected length-delimited field")


def _encode_unknown(fields: list[RawField]) -> bytes:
    return b"".join(enc(n, w, v) for n, w, v in fields)


# ------------------------------------------------------------------- models
@dataclass
class CharID:
    replica: int = 0
    clock: int = 0

    @classmethod
    def parse(cls, buf: bytes) -> "CharID":
        c = cls()
        for num, wt, val in parse(buf):
            if num == 1 and wt == VARINT:
                c.replica = int(val)  # type: ignore[arg-type]
            elif num == 2 and wt == VARINT:
                c.clock = int(val)  # type: ignore[arg-type]
        return c

    def encode(self) -> bytes:
        # Both fields are always written: the web client treats a missing
        # component as a corrupt archive.
        return enc_varint(1, self.replica) + enc_varint(2, self.clock)


@dataclass
class Substring:
    char_id: CharID = field(default_factory=CharID)
    length: int = 0
    timestamp: CharID = field(default_factory=CharID)
    tombstone: bool = False
    children: list[int] = field(default_factory=list)
    unknown: list[RawField] = field(default_factory=list)

    @classmethod
    def parse(cls, buf: bytes) -> "Substring":
        s = cls()
        for num, wt, val in parse(buf):
            if num == 1:
                _need_len(wt, "Substring.charID")
                s.char_id = CharID.parse(val)  # type: ignore[arg-type]
            elif num == 2 and wt == VARINT:
                s.length = int(val)  # type: ignore[arg-type]
            elif num == 3:
                _need_len(wt, "Substring.timestamp")
                s.timestamp = CharID.parse(val)  # type: ignore[arg-type]
            elif num == 4 and wt == VARINT:
                s.tombstone = bool(val)
            elif num == 5:
                s.children.extend(_repeated_varints(wt, val))
            else:
                s.unknown.append((num, wt, val))
        return s

    def encode(self) -> bytes:
        out = enc_bytes(1, self.char_id.encode()) + enc_varint(2, self.length)
        out += enc_bytes(3, self.timestamp.encode())
        if self.tombstone:
            out += enc_varint(4, 1)
        for child in self.children:
            out += enc_varint(5, child)
        return out + _encode_unknown(self.unknown)


@dataclass
class ReplicaClock:
    clock: int = 0
    subclock: int | None = None

    def encode(self) -> bytes:
        out = enc_varint(1, self.clock)
        if self.subclock is not None:
            out += enc_varint(2, self.subclock)
        return out


@dataclass
class Clock:
    """One replica entry of the vector timestamp: [text clock, style clock]."""

    uuid: bytes = b""
    replica_clocks: list[ReplicaClock] = field(default_factory=list)

    @classmethod
    def parse(cls, buf: bytes) -> "Clock":
        c = cls()
        for num, wt, val in parse(buf):
            if num == 1 and wt == LEN:
                c.uuid = val  # type: ignore[assignment]
            elif num == 2 and wt == LEN:
                rc = ReplicaClock()
                for n2, w2, v2 in parse(val):  # type: ignore[arg-type]
                    if n2 == 1 and w2 == VARINT:
                        rc.clock = int(v2)  # type: ignore[arg-type]
                    elif n2 == 2 and w2 == VARINT:
                        rc.subclock = int(v2)  # type: ignore[arg-type]
                c.replica_clocks.append(rc)
        return c

    def encode(self) -> bytes:
        out = enc_bytes(1, self.uuid)
        for rc in self.replica_clocks:
            out += enc_bytes(2, rc.encode())
        return out

    def get(self, index: int) -> int:
        return self.replica_clocks[index].clock if index < len(self.replica_clocks) else 0


@dataclass
class Todo:
    uuid: bytes = b""
    done: bool = False

    @classmethod
    def parse(cls, buf: bytes) -> "Todo":
        t = cls()
        for num, wt, val in parse(buf):
            if num == 1 and wt == LEN:
                t.uuid = val  # type: ignore[assignment]
            elif num == 2 and wt == VARINT:
                t.done = bool(val)
        return t

    def encode(self) -> bytes:
        return enc_bytes(1, self.uuid) + enc_varint(2, 1 if self.done else 0)


# Paragraph style values (ParagraphStyle.style)
STYLE_TITLE = 0
STYLE_HEADING = 1
STYLE_SUBHEADING = 2
STYLE_BODY = 3
STYLE_MONOSPACED = 4
STYLE_BULLET = 100
STYLE_DASH = 101
STYLE_NUMBERED = 102
STYLE_CHECKLIST = 103


@dataclass
class ParagraphStyle:
    style: int | None = None
    alignment: int | None = None
    writing_direction: int | None = None
    indent: int | None = None
    todo: Todo | None = None
    paragraph_hints: int | None = None
    starting_number: int | None = None
    block_quote_level: int | None = None
    uuid: bytes | None = None
    unknown: list[RawField] = field(default_factory=list)

    @classmethod
    def parse(cls, buf: bytes) -> "ParagraphStyle":
        p = cls()
        for num, wt, val in parse(buf):
            if wt == VARINT and num in (1, 2, 3, 4, 6, 7, 8):
                v = int(val)  # type: ignore[arg-type]
                if num == 1:
                    p.style = v
                elif num == 2:
                    p.alignment = v
                elif num == 3:
                    p.writing_direction = v
                elif num == 4:
                    p.indent = _int32(v)
                elif num == 6:
                    p.paragraph_hints = v
                elif num == 7:
                    p.starting_number = v
                else:
                    p.block_quote_level = v
            elif num == 5 and wt == LEN:
                p.todo = Todo.parse(val)  # type: ignore[arg-type]
            elif num == 9 and wt == LEN:
                p.uuid = val  # type: ignore[assignment]
            else:
                p.unknown.append((num, wt, val))
        return p

    def encode(self) -> bytes:
        out = b""
        if self.style is not None:
            out += enc_varint(1, self.style)
        if self.alignment is not None:
            out += enc_varint(2, self.alignment)
        if self.writing_direction is not None:
            out += enc_varint(3, self.writing_direction)
        if self.indent is not None:
            out += enc_varint(4, self.indent)
        if self.todo is not None:
            out += enc_bytes(5, self.todo.encode())
        if self.paragraph_hints is not None:
            out += enc_varint(6, self.paragraph_hints)
        if self.starting_number is not None:
            out += enc_varint(7, self.starting_number)
        if self.block_quote_level is not None:
            out += enc_varint(8, self.block_quote_level)
        if self.uuid is not None:
            out += enc_bytes(9, self.uuid)
        return out + _encode_unknown(self.unknown)


@dataclass
class AttachmentInfo:
    identifier: str | None = None
    type_uti: str | None = None
    unknown: list[RawField] = field(default_factory=list)

    @classmethod
    def parse(cls, buf: bytes) -> "AttachmentInfo":
        a = cls()
        for num, wt, val in parse(buf):
            if num == 1 and wt == LEN:
                a.identifier = val.decode("utf-8", "replace")  # type: ignore[union-attr]
            elif num == 2 and wt == LEN:
                a.type_uti = val.decode("utf-8", "replace")  # type: ignore[union-attr]
            else:
                a.unknown.append((num, wt, val))
        return a

    def encode(self) -> bytes:
        out = b""
        if self.identifier is not None:
            out += enc_str(1, self.identifier)
        if self.type_uti is not None:
            out += enc_str(2, self.type_uti)
        return out + _encode_unknown(self.unknown)


# AttributeRun.fontHints bits
FONT_BOLD = 1
FONT_ITALIC = 2


@dataclass
class AttributeRun:
    length: int = 0
    paragraph_style: ParagraphStyle | None = None
    font_hints: int | None = None
    underline: int | None = None
    strikethrough: int | None = None
    superscript: int | None = None
    link: str | None = None
    attachment_info: AttachmentInfo | None = None
    # font(3), color(10), writingDirection(11), timestamp(13), emphasis(14),
    # systemAttachmentInfo(15) and anything newer: preserved verbatim.
    unknown: list[RawField] = field(default_factory=list)

    @classmethod
    def parse(cls, buf: bytes) -> "AttributeRun":
        r = cls()
        for num, wt, val in parse(buf):
            if num == 1 and wt == VARINT:
                r.length = int(val)  # type: ignore[arg-type]
            elif num == 2 and wt == LEN:
                r.paragraph_style = ParagraphStyle.parse(val)  # type: ignore[arg-type]
            elif num == 5 and wt == VARINT:
                r.font_hints = int(val)  # type: ignore[arg-type]
            elif num == 6 and wt == VARINT:
                r.underline = int(val)  # type: ignore[arg-type]
            elif num == 7 and wt == VARINT:
                r.strikethrough = int(val)  # type: ignore[arg-type]
            elif num == 8 and wt == VARINT:
                r.superscript = _int32(int(val))  # type: ignore[arg-type]
            elif num == 9 and wt == LEN:
                r.link = val.decode("utf-8", "replace")  # type: ignore[union-attr]
            elif num == 12 and wt == LEN:
                r.attachment_info = AttachmentInfo.parse(val)  # type: ignore[arg-type]
            else:
                r.unknown.append((num, wt, val))
        return r

    def encode(self) -> bytes:
        parts: list[tuple[int, bytes]] = [(1, enc_varint(1, self.length))]
        if self.paragraph_style is not None:
            parts.append((2, enc_bytes(2, self.paragraph_style.encode())))
        if self.font_hints is not None:
            parts.append((5, enc_varint(5, self.font_hints)))
        if self.underline is not None:
            parts.append((6, enc_varint(6, self.underline)))
        if self.strikethrough is not None:
            parts.append((7, enc_varint(7, self.strikethrough)))
        if self.superscript is not None:
            parts.append((8, enc_varint(8, self.superscript)))
        if self.link is not None:
            parts.append((9, enc_str(9, self.link)))
        if self.attachment_info is not None:
            parts.append((12, enc_bytes(12, self.attachment_info.encode())))
        parts.extend((n, enc(n, w, v)) for n, w, v in self.unknown)
        parts.sort(key=lambda p: p[0])
        return b"".join(p[1] for p in parts)

    def has_field(self, num: int) -> bool:
        return any(n == num for n, _, _ in self.unknown)


@dataclass
class TTString:
    """``topotext.String``."""

    string: str = ""
    substrings: list[Substring] = field(default_factory=list)
    clocks: list[Clock] = field(default_factory=list)
    has_timestamp: bool = False
    runs: list[AttributeRun] = field(default_factory=list)
    attachments: list[bytes] = field(default_factory=list)
    unknown: list[RawField] = field(default_factory=list)

    @classmethod
    def parse(cls, buf: bytes) -> "TTString":
        s = cls()
        for num, wt, val in parse(buf):
            if num == 2 and wt == LEN:
                s.string = val.decode("utf-8")  # type: ignore[union-attr]
            elif num == 3 and wt == LEN:
                s.substrings.append(Substring.parse(val))  # type: ignore[arg-type]
            elif num == 4 and wt == LEN:
                s.has_timestamp = True
                for n2, w2, v2 in parse(val):  # type: ignore[arg-type]
                    if n2 == 1 and w2 == LEN:
                        s.clocks.append(Clock.parse(v2))  # type: ignore[arg-type]
            elif num == 5 and wt == LEN:
                s.runs.append(AttributeRun.parse(val))  # type: ignore[arg-type]
            elif num == 6 and wt == LEN:
                s.attachments.append(val)  # type: ignore[arg-type]
            else:
                s.unknown.append((num, wt, val))
        return s

    def encode(self) -> bytes:
        out = enc_str(2, self.string)
        for sub in self.substrings:
            out += enc_bytes(3, sub.encode())
        if self.clocks or self.has_timestamp:
            out += enc_bytes(4, b"".join(enc_bytes(1, c.encode()) for c in self.clocks))
        for run in self.runs:
            out += enc_bytes(5, run.encode())
        for att in self.attachments:
            out += enc_bytes(6, att)
        return out + _encode_unknown(self.unknown)


# ----------------------------------------------------------- document level
def _decompress(data: bytes) -> bytes:
    try:
        return zlib.decompress(data, 47)  # zlib or gzip header, auto-detected
    except zlib.error:
        pass
    try:
        return zlib.decompress(data, -15)  # raw deflate
    except zlib.error:
        return data  # not compressed


def unpack_text_data(value: str | bytes) -> bytes:
    """``TextDataEncrypted`` value -> serialized ``versioned_document.Document``."""
    data: bytes
    if isinstance(value, str):
        try:
            data = base64.b64decode(value + "=" * (-len(value) % 4))
        except ValueError as exc:
            raise ProtoError("note body is not valid base64") from exc
    else:
        data = value
    return _decompress(data)


def decode_document(doc: bytes) -> TTString:
    """Parse a versioned document; the last version wins (as the web client does)."""
    versions: list[bytes] = []
    for num, wt, val in parse(doc):
        if num == 2 and wt == LEN:
            versions.append(val)  # type: ignore[arg-type]
    if not versions:
        raise ProtoError("note body has no document version")
    data = b""
    for num, wt, val in parse(versions[-1]):
        if num == 3 and wt == LEN:
            data = val  # type: ignore[assignment]
    return TTString.parse(data)


def decode_text_data(value: str | bytes) -> TTString:
    return decode_document(unpack_text_data(value))


def encode_document(s: TTString) -> bytes:
    version = enc_varint(1, 0) + enc_varint(2, 0) + enc_bytes(3, s.encode())
    return enc_varint(1, 0) + enc_bytes(2, version)


def encode_text_data(s: TTString) -> str:
    """``TTString`` -> base64(zlib(Document)), matching the web's pako.deflate."""
    return base64.b64encode(zlib.compress(encode_document(s))).decode("ascii")
