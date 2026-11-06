"""CRDT (topotext mergeable string) builders for Apple Notes bodies.

Archive rules (from the icloud.com ``TTMergeableString`` save/load code):

* ``CharID.replica`` 0 is the zero UUID; replica N is the N-th UUID of the
  vector timestamp in ascending byte order.
* the start sentinel is ``(0, 0)`` and the end sentinel ``(0, 0xFFFFFFFF)``,
  both of length 0; a sentinel's style timestamp equals its char ID.
* substrings are stored in document order; the non-tombstoned lengths
  (UTF-16 units) must add up to ``len(string)``.
* every substring carries ``charID``, ``length`` and ``timestamp``.
* the vector timestamp holds ``[text clock, style clock]`` per replica.
"""

from __future__ import annotations

import copy
import uuid as uuidlib

from .notes_proto import (
    AttributeRun,
    CharID,
    Clock,
    ProtoError,
    ReplicaClock,
    Substring,
    TTString,
)
from .notes_text import utf16_len

MAX_CLOCK = 0xFFFFFFFF
ZERO_UUID = b"\x00" * 16


class CRDTError(ProtoError):
    """The existing document cannot be edited safely."""


def _new_uuid(exclude: set[bytes]) -> bytes:
    while True:
        u = uuidlib.uuid4().bytes
        if u not in exclude and u != ZERO_UUID:
            return u


def _check_runs(text: str, runs: list[AttributeRun]) -> None:
    if sum(r.length for r in runs) != utf16_len(text):
        raise ValueError("attribute runs do not cover the text")


def new_document(text: str, runs: list[AttributeRun], *, replica_uuid: bytes | None = None) -> TTString:
    """A fresh single-replica document holding ``text`` (like a newly created note)."""
    _check_runs(text, runs)
    length = utf16_len(text)
    uid = replica_uuid or _new_uuid(set())
    start = Substring(CharID(0, 0), 0, CharID(0, 0), children=[1])
    end = Substring(CharID(0, MAX_CLOCK), 0, CharID(0, MAX_CLOCK))
    subs = [start]
    clocks: list[Clock] = []
    if length:
        subs.append(Substring(CharID(1, 0), length, CharID(1, 0), children=[2]))
        clocks.append(Clock(uid, [ReplicaClock(length), ReplicaClock(1)]))
    subs.append(end)
    return TTString(string=text, substrings=subs, clocks=clocks, has_timestamp=True, runs=list(runs))


def replace_document(
    old: TTString,
    text: str,
    runs: list[AttributeRun],
    *,
    replica_uuid: bytes | None = None,
) -> TTString:
    """Replace the visible text of ``old`` as a CRDT edit by a brand-new replica.

    Every visible substring is tombstoned and the new text is inserted right
    after the start sentinel, so other devices that already know the old
    characters merge the change instead of ignoring it.
    """
    _check_runs(text, runs)
    if not old.substrings:
        raise CRDTError("document has no substring graph")
    if not old.clocks:
        # Shared notes keep the vector clock outside the archive.
        raise CRDTError("document has no vector timestamp (shared note?)")

    doc = copy.deepcopy(old)
    old_sorted = sorted(c.uuid for c in doc.clocks)
    if len(set(old_sorted)) != len(old_sorted) or ZERO_UUID in old_sorted:
        raise CRDTError("invalid replica table")
    n_old = len(old_sorted)
    for sub in doc.substrings:
        if sub.char_id.replica > n_old or sub.timestamp.replica > n_old:
            raise CRDTError("substring references an unknown replica")

    new_uuid = replica_uuid or _new_uuid(set(old_sorted))
    if new_uuid in old_sorted:
        raise ValueError("replica uuid already present")
    new_sorted = sorted([*old_sorted, new_uuid])
    remap = {i + 1: new_sorted.index(u) + 1 for i, u in enumerate(old_sorted)}
    rid = new_sorted.index(new_uuid) + 1

    start_idx = None
    text_clock = 0
    style_base = 0
    for i, sub in enumerate(doc.substrings):
        if sub.char_id.replica:
            sub.char_id.replica = remap[sub.char_id.replica]
            text_clock = max(text_clock, sub.char_id.clock + sub.length)
        elif sub.char_id.clock == 0 and start_idx is None:
            start_idx = i
        if sub.timestamp.replica:
            sub.timestamp.replica = remap[sub.timestamp.replica]
            style_base = max(style_base, sub.timestamp.clock + 1)
    if start_idx is None:
        raise CRDTError("document has no start sentinel")
    text_clock = max([text_clock, *(c.get(0) for c in doc.clocks)])

    style_clock = style_base
    for sub in doc.substrings:
        if not sub.char_id.replica or sub.tombstone or sub.length == 0:
            continue
        d = max(sub.timestamp.clock + 8, style_base)  # as generateIdsForLocalChanges
        sub.tombstone = True
        sub.timestamp = CharID(rid, d)
        style_clock = max(style_clock, d + 1)

    length = utf16_len(text)
    if length:
        pos = start_idx + 1
        for sub in doc.substrings:
            sub.children = [c + 1 if c >= pos else c for c in sub.children]
        start = doc.substrings[start_idx]
        inserted = Substring(CharID(rid, text_clock), length, CharID(rid, 0), children=start.children)
        start.children = [pos]
        doc.substrings.insert(pos, inserted)
        style_clock = max(style_clock, 1)

    by_uuid = {c.uuid: c for c in doc.clocks}
    by_uuid[new_uuid] = Clock(new_uuid, [ReplicaClock(text_clock + length), ReplicaClock(style_clock)])
    doc.clocks = [by_uuid[u] for u in new_sorted]
    doc.string = text
    doc.runs = list(runs)
    doc.attachments = []
    return doc


def validate(doc: TTString) -> None:
    """Raise ``CRDTError`` if ``doc`` would be rejected by the web client's loader."""
    n = len(doc.clocks)
    if any(c.uuid == ZERO_UUID for c in doc.clocks):
        raise CRDTError("zero replica uuid")
    visible = 0
    total = len(doc.substrings)
    for sub in doc.substrings:
        if sub.char_id.replica > n or sub.timestamp.replica > n:
            raise CRDTError("replica index out of range")
        if (sub.char_id.replica == 0) != (sub.timestamp.replica == 0) and not sub.tombstone:
            raise CRDTError("zeroed uuid timestamp")
        if any(c >= total for c in sub.children):
            raise CRDTError("child index out of range")
        if not sub.tombstone:
            visible += sub.length
    if visible != utf16_len(doc.string):
        raise CRDTError("substring lengths do not match string")
    if sum(r.length for r in doc.runs) != utf16_len(doc.string):
        raise CRDTError("attribute runs do not cover string")
